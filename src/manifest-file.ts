import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the window manager looks, in the order it looks. */
export const MANIFEST_FILES = ['wm.config.json', 'wm.json'] as const;

/** What an app without a number counted as, back when apps had numbers. */
const LEGACY_DEFAULT_RANK = 10;

export function manifestPath(profileDir: string): string | undefined {
  return MANIFEST_FILES.map((file) => join(profileDir, file)).find((path) =>
    existsSync(path),
  );
}

/**
 * The apps in priority order: first listed, first on screen.
 *
 * The same rule the window manager reads the file by. A manifest from before
 * order was the priority carries a `rank` on its apps, and those are sorted on
 * so the file still means what it meant.
 */
export function inPriorityOrder<T>(apps: readonly T[]): T[] {
  const rankOf = (app: T): number | undefined =>
    isRecord(app) && typeof app['rank'] === 'number' ? app['rank'] : undefined;
  if (!apps.some((app) => rankOf(app) !== undefined)) {
    return [...apps];
  }

  return [...apps].sort(
    (left, right) =>
      (rankOf(right) ?? LEGACY_DEFAULT_RANK) - (rankOf(left) ?? LEGACY_DEFAULT_RANK),
  );
}

/**
 * Changes the manifest in place.
 *
 * Only `apps` is touched. Anything else a person wrote into the file — an
 * `env` block, an option on one app — is written back as it was read. Every
 * edit does one thing besides its own: a file still ordered by numbers is put
 * into that order and the numbers dropped, since the order is the priority.
 */
function edit(
  profileDir: string,
  change: (apps: unknown[]) => boolean,
  create = false,
): boolean {
  const existing = manifestPath(profileDir);
  if (!existing && !create) {
    return false;
  }
  const path = existing ?? join(profileDir, MANIFEST_FILES[0]);
  const raw = existing ? readJson(path) : { apps: [] };
  if (!isRecord(raw) || !Array.isArray(raw['apps'])) {
    throw new Error(`${path} is not a manifest this can change`);
  }

  const apps = inPriorityOrder(raw['apps'] as unknown[]);
  for (const app of apps) {
    if (isRecord(app)) {
      delete app['rank'];
    }
  }
  if (!change(apps)) {
    return false;
  }
  raw['apps'] = apps;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

  return true;
}

const named = (name: string) => (app: unknown) => isRecord(app) && app['name'] === name;

/** At the bottom of the list: a newcomer does not take the screen from anyone. */
export function addToManifest(profileDir: string, name: string): boolean {
  return edit(
    profileDir,
    (apps) => {
      if (apps.some(named(name))) {
        return false;
      }
      apps.push({ name });

      return true;
    },
    true,
  );
}

/** False when there was nothing to take out. */
export function removeFromManifest(profileDir: string, name: string): boolean {
  return edit(profileDir, (apps) => {
    const at = apps.findIndex(named(name));
    if (at === -1) {
      return false;
    }
    apps.splice(at, 1);

    return true;
  });
}

/**
 * Puts the apps in this order, top first. An app the order does not name keeps
 * its place relative to the others like it, after the ones it does.
 */
export function setManifestOrder(profileDir: string, order: readonly string[]): boolean {
  return edit(profileDir, (apps) => {
    const place = (app: unknown): number => {
      const at =
        isRecord(app) && typeof app['name'] === 'string'
          ? order.indexOf(app['name'])
          : -1;

      return at === -1 ? order.length : at;
    };
    const sorted = [...apps].sort((left, right) => place(left) - place(right));
    apps.splice(0, apps.length, ...sorted);

    return true;
  });
}

/**
 * The ranks the window manager works out for an order: top first, ten apart.
 * Never written to the file — only handed to a running daemon, so it does not
 * have to read the file again to know.
 */
export function ranksFor(order: readonly string[]): Record<string, number> {
  return Object.fromEntries(
    order.map((name, index) => [name, (order.length - index) * 10]),
  );
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

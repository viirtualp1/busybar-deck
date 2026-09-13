import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DeckError } from './live.js';

/** Runs npm in a directory, line by line. Injected by the tests. */
export type NpmRunner = (
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
) => Promise<void>;

export type CatalogEntry = {
  packageName: string;
  /** The name it would get in the manifest. */
  name: string;
  version: string;
  description: string;
  /** It describes its settings, so the deck can edit them. */
  configurable: boolean;
  installed: boolean;
  /** Already in the manifest — installing again would change nothing. */
  added: boolean;
};

export type InstallRequest = { packageName?: unknown; name?: unknown; rank?: unknown };

export type InstallJob = {
  id: string;
  packageName: string;
  name: string | null;
  state: 'running' | 'done' | 'failed';
  message: string;
  log: string[];
  startedAt: number;
};

export type InstallerOptions = {
  profileDir: string;
  runNpm?: NpmRunner;
  fetch?: typeof fetch;
  /** Names already in the manifest. */
  manifestNames: () => string[];
  /** Hands the new app to whoever can start it; true when it was taken. */
  onInstalled: (name: string) => Promise<boolean>;
};

/**
 * Validated before it gets anywhere near a shell: npm's own rules for a name,
 * with nothing that could end one command and begin another.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const APP_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** The deck's own family: installed alongside the apps, but not apps. */
const TOOLS = new Set(['busybar-wm', 'busybar-deck', 'busybar-config', 'busybar-kit']);

const REGISTRY = 'https://registry.npmjs.org';
const CATALOG_MS = 10 * 60 * 1000;
const LOG_LINES = 300;
const DEFAULT_RANK = 30;

/**
 * Puts an app into the profile: installs the package, writes it into the
 * manifest, gives it a folder for its `.env`, and hands it to the window
 * manager.
 *
 * Installing runs npm, which is the one place the deck executes anything, so
 * the name is checked before and install scripts are not run at all. BUSY Bar
 * apps have none to run, and a package that needs one is not one of them.
 */
export class Installer {
  private readonly jobs = new Map<string, InstallJob>();
  private active: InstallJob | null = null;
  private catalogCache: {
    at: number;
    entries: Omit<CatalogEntry, 'installed' | 'added'>[];
  } | null = null;

  constructor(private readonly options: InstallerOptions) {}

  async catalog(): Promise<CatalogEntry[]> {
    if (!this.catalogCache || Date.now() - this.catalogCache.at > CATALOG_MS) {
      this.catalogCache = { at: Date.now(), entries: await this.search() };
    }
    const added = new Set(this.options.manifestNames());

    return this.catalogCache.entries.map((entry) => ({
      ...entry,
      installed: existsSync(this.packageJson(entry.packageName)),
      added: added.has(entry.name),
    }));
  }

  start(request: InstallRequest): InstallJob {
    const packageName =
      typeof request.packageName === 'string' ? request.packageName.trim() : '';
    if (!PACKAGE_NAME.test(packageName)) {
      throw new DeckError('invalid', `"${packageName}" is not an npm package name`);
    }
    const name = typeof request.name === 'string' ? request.name.trim() : '';
    if (name && !APP_NAME.test(name)) {
      throw new DeckError(
        'invalid',
        'a name is letters, digits, dots, dashes and underscores',
      );
    }
    const rank =
      request.rank === undefined || request.rank === ''
        ? DEFAULT_RANK
        : Number(request.rank);
    if (!Number.isInteger(rank) || rank < 0 || rank > 1000) {
      throw new DeckError('invalid', 'priority is a whole number from 0 to 1000');
    }
    if (this.active) {
      throw new DeckError('invalid', `still installing ${this.active.packageName}`);
    }

    const job: InstallJob = {
      id: randomUUID(),
      packageName,
      name: name || null,
      state: 'running',
      message: `Installing ${packageName}`,
      log: [],
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.active = job;
    void this.run(job, name, rank).finally(() => {
      this.active = null;
    });

    return job;
  }

  job(id: string): InstallJob {
    const job = this.jobs.get(id);
    if (!job) {
      throw new DeckError('not-found', 'no such install');
    }

    return job;
  }

  private async run(job: InstallJob, wanted: string, rank: number): Promise<void> {
    const dir = this.options.profileDir;
    const say = (line: string) => {
      job.log.push(line);
      if (job.log.length > LOG_LINES) {
        job.log.shift();
      }
    };

    try {
      say(`npm install ${job.packageName}`);
      await (this.options.runNpm ?? runNpm)(
        [
          'install',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          `${job.packageName}@latest`,
        ],
        dir,
        say,
      );

      const pkg = readJson(this.packageJson(job.packageName));
      if (!isRecord(pkg) || !pkg['bin']) {
        throw new Error(
          `${job.packageName} installed, but it has no program to run — it is a library, not an app`,
        );
      }

      const name =
        wanted || specName(dir, job.packageName, pkg) || shortName(job.packageName);
      if (!APP_NAME.test(name)) {
        throw new Error(
          `${job.packageName} would be called "${name}", which is not a usable name`,
        );
      }
      job.name = name;

      const added = addToManifest(dir, name, rank);
      say(
        added
          ? `wm.config.json: added ${name} at priority ${rank}`
          : `wm.config.json: ${name} was already there`,
      );
      mkdirSync(join(dir, name), { recursive: true });

      const started = await this.options.onInstalled(name).catch((error: unknown) => {
        say(`the window manager did not take it: ${message(error)}`);

        return false;
      });

      job.state = 'done';
      job.message = started
        ? `${name} is installed and starting`
        : `${name} is installed — restart busybar-wm to start it`;
      // What is installed changed, so the catalog's badges are stale.
      this.catalogCache = null;
    } catch (error) {
      job.state = 'failed';
      job.message = message(error);
      say(job.message);
    }
  }

  private packageJson(packageName: string): string {
    return join(
      this.options.profileDir,
      'node_modules',
      ...packageName.split('/'),
      'package.json',
    );
  }

  /**
   * Every package tagged `busybar` that has a program to run. The tag alone
   * would bring in libraries; a bin is what makes one an app.
   */
  private async search(): Promise<Omit<CatalogEntry, 'installed' | 'added'>[]> {
    const get = this.options.fetch ?? fetch;
    const json = async (url: string): Promise<unknown> => {
      const response = await get(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        throw new Error(`npm answered ${response.status}`);
      }

      return response.json();
    };

    let found: unknown;
    try {
      found = await json(`${REGISTRY}/-/v1/search?text=keywords:busybar&size=100`);
    } catch (error) {
      throw new DeckError('unavailable', `could not ask npm: ${message(error)}`);
    }

    const names = (
      isRecord(found) && Array.isArray(found['objects']) ? found['objects'] : []
    )
      .map((item: unknown) =>
        isRecord(item) && isRecord(item['package']) ? item['package']['name'] : null,
      )
      .filter(
        (name): name is string => typeof name === 'string' && PACKAGE_NAME.test(name),
      )
      .filter((name) => !TOOLS.has(name));

    const entries = await Promise.all(
      names.map(async (packageName) => {
        const latest = await json(
          `${REGISTRY}/${packageName.replace('/', '%2f')}/latest`,
        ).catch(() => null);
        if (!isRecord(latest) || !latest['bin']) {
          return null;
        }

        return {
          packageName,
          name: shortName(packageName),
          version: typeof latest['version'] === 'string' ? latest['version'] : '',
          description:
            typeof latest['description'] === 'string' ? latest['description'] : '',
          configurable: isRecord(latest['busybar']),
        };
      }),
    );

    return entries
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => left.packageName.localeCompare(right.packageName));
  }
}

/**
 * On Windows npm is a `.cmd`, which only runs through a shell. The arguments
 * are fixed flags and a name that has already passed `PACKAGE_NAME`, so there
 * is nothing in them for a shell to misread.
 */
export const runNpm: NpmRunner = (args, cwd, onLine) =>
  new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = windows
      ? spawn(['npm', ...args].join(' '), { cwd, shell: true, windowsHide: true })
      : spawn('npm', args, { cwd });

    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => {
        if (line.trim()) {
          onLine(line);
        }
      });
    }
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `npm install failed (exit code ${code ?? '?'}) — the log above says why`,
          ),
        );
      }
    });
  });

/** `busybar-dota` → `dota`, which is what the manifest and the folder are called. */
export function shortName(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '').replace(/^busybar-/, '');
}

/** The name the app draws under, when its spec says so. */
function specName(
  dir: string,
  packageName: string,
  pkg: Record<string, unknown>,
): string {
  const busybar = pkg['busybar'];
  const file = isRecord(busybar) ? busybar['configJson'] : undefined;
  if (typeof file !== 'string') {
    return '';
  }
  const spec = readJson(join(dir, 'node_modules', ...packageName.split('/'), file));

  return isRecord(spec) && typeof spec['name'] === 'string' ? spec['name'] : '';
}

/** False when the app was already listed. Everything else in the file is left as it was. */
function addToManifest(dir: string, name: string, rank: number): boolean {
  const existing = ['wm.config.json', 'wm.json']
    .map((file) => join(dir, file))
    .find((path) => existsSync(path));
  const path = existing ?? join(dir, 'wm.config.json');
  const raw = existing ? readJson(path) : { apps: [] };
  if (!isRecord(raw) || !Array.isArray(raw['apps'])) {
    throw new Error(`${path} is not a manifest this can add to`);
  }

  const apps = raw['apps'] as unknown[];
  if (apps.some((app) => isRecord(app) && app['name'] === name)) {
    return false;
  }
  apps.push({ name, rank });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

  return true;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

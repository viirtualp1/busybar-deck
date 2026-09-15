import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigError,
  discover,
  readConfig,
  writeConfig,
  type ConfigSnapshot,
  type ConfigurableApp,
  type PutConfigBody,
  type PutResult,
} from 'busybar-config';
import type { AppConfigSpec } from 'busybar-kit/config-spec';
import { decodeScreenFrame } from 'busybar-kit/screen';
import {
  Installer,
  PACKAGE_NAME,
  runNpm,
  TOOLS,
  type CatalogEntry,
  type InstallJob,
  type InstallRequest,
  type NpmRunner,
} from './install.js';
import {
  inPriorityOrder,
  manifestPath,
  ranksFor,
  removeFromManifest,
  setManifestOrder,
} from './manifest-file.js';
import {
  DeckError,
  detachedLive,
  type AppHealth,
  type Live,
  type LiveStatus,
  type ScreenFrame,
} from './live.js';

export type ManifestApp = { name: string; rank?: number; autostart?: boolean };

export type DeckOptions = {
  profileDir: string;
  live?: Live;
  /**
   * Ranks and what is supervised. A function when the host's list can grow
   * while it runs; left out, `wm.config.json` is read instead.
   */
  manifestApps?: ManifestApp[] | (() => ManifestApp[]);
  /** How long a discovery scan is believed. */
  cacheMs?: number;
  /** Injected by the tests, which install nothing for real. */
  runNpm?: NpmRunner;
  fetch?: typeof fetch;
};

export type AppInfo = {
  name: string;
  packageName: string;
  rank: number;
  configurable: boolean;
  supervised: boolean;
  running: boolean;
  onScreen: boolean;
  pinned: boolean;
  /** Its package is in the profile's node_modules. */
  installed: boolean;
  /** Why it is running or not, when the window manager can say. */
  health: AppHealth | null;
  spec: AppConfigSpec;
};

export type DeckStatus = {
  profile: string;
  wm: LiveStatus;
  onScreen: string | null;
  pinned: string | null;
  problems: string[];
};

const DEFAULT_CACHE_MS = 2000;

/**
 * Everything the deck can answer, with no HTTP in it — so the whole surface is
 * testable without a socket, and the same object can be mounted inside the
 * window manager or run on its own.
 */
export class Deck {
  private apps = new Map<string, ConfigurableApp>();
  private problems: string[] = [];
  private scannedAt = 0;
  private scanning: Promise<void> | null = null;
  private manifestAt = 0;
  private manifest: ManifestApp[] = [];
  private readonly installer: Installer;

  constructor(private readonly options: DeckOptions) {
    this.installer = new Installer({
      profileDir: options.profileDir,
      ...(options.runNpm ? { runNpm: options.runNpm } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      manifestNames: () => this.manifestApps().map((app) => app.name),
      onInstalled: async (name) => {
        this.manifestAt = 0;
        await this.refresh(true);
        const add = this.options.live?.state.addApp;
        if (!add) {
          return false;
        }
        await add(name);

        return true;
      },
    });
  }

  private get live(): Live {
    return this.options.live ?? detachedLive();
  }

  /**
   * Rescans only when the answer could have changed. The old version scanned
   * `node_modules` and re-imported every spec on each request, which a polling
   * dashboard turns into a filesystem walk several times a second.
   */
  async refresh(force = false): Promise<void> {
    const fresh =
      Date.now() - this.scannedAt < (this.options.cacheMs ?? DEFAULT_CACHE_MS);
    if (!force && fresh) {
      return;
    }
    // Concurrent requests share one scan rather than racing several.
    this.scanning ??= this.scan();
    try {
      await this.scanning;
    } finally {
      this.scanning = null;
    }
  }

  private async scan(): Promise<void> {
    const { apps, problems } = await discover(this.options.profileDir);
    this.apps = new Map(apps.map((app) => [app.spec.name, app]));
    this.problems = problems;
    this.scannedAt = Date.now();
  }

  status(): DeckStatus {
    return {
      profile: this.options.profileDir,
      wm: this.live.status,
      onScreen: this.safely(() => this.live.state.onScreen()),
      pinned: this.safely(() => this.live.state.pin()),
      problems: this.problems,
    };
  }

  listApps(): AppInfo[] {
    const { state } = this.live;
    const onScreen = this.safely(() => state.onScreen());
    const pinned = this.safely(() => state.pin());
    const supervised = new Map(this.manifestApps().map((app) => [app.name, app]));
    const names = new Set([...this.apps.keys(), ...supervised.keys()]);

    return [...names]
      .map((name) => {
        const configured = this.apps.get(name);
        const entry = supervised.get(name);
        const packageName = configured?.packageName ?? `busybar-${name}`;

        return {
          name,
          packageName,
          installed: existsSync(this.packageJson(packageName)),
          // Installed but not in the manifest: below everything that is, which
          // is also where the window manager puts an app it has no entry for.
          rank: entry?.rank ?? 0,
          configurable: Boolean(configured),
          supervised: Boolean(entry),
          running: this.safely(() => state.running(name)) ?? false,
          onScreen: onScreen === name,
          pinned: pinned === name,
          health: this.safely(() => state.health?.(name) ?? null),
          spec: configured?.spec ?? { specVersion: 1, name, sections: [] },
        };
      })
      .sort(byPriority);
  }

  getConfig(name: string): ConfigSnapshot {
    return readConfig(this.configurable(name));
  }

  putConfig(name: string, body: PutConfigBody): PutResult {
    try {
      return writeConfig(this.configurable(name), body);
    } catch (error) {
      throw error instanceof ConfigError
        ? new DeckError(error.kind, error.message)
        : error;
    }
  }

  async restart(name: string): Promise<void> {
    this.known(name);
    await this.live.state.restart(name);
  }

  pin(name: string): void {
    this.known(name);
    this.live.state.setPin(name);
  }

  unpin(): void {
    this.live.state.clearPin();
  }

  /** BUSY Bar apps on npm, marked with what this profile already has. */
  catalog(): Promise<CatalogEntry[]> {
    return this.installer.catalog();
  }

  /** Starts an install; follow it with `installJob`. */
  install(request: InstallRequest): InstallJob {
    return this.installer.start(request);
  }

  installJob(id: string): InstallJob {
    return this.installer.job(id);
  }

  /** Stops an app by hand; it stays off until it is started again. */
  async stop(name: string): Promise<void> {
    this.known(name);
    const stop = this.live.state.stop;
    if (!stop) {
      throw new DeckError(
        'unavailable',
        'the window manager is not here, so there is nothing running to stop',
      );
    }
    await stop(name);
  }

  /**
   * A new order for the queue, top first — which is the whole of what priority
   * is. The manifest is written in this order, and a running window manager is
   * told the same thing at once.
   *
   * Every app in the manifest has to be named, once. A partial order says
   * nothing about where the rest belong, and a name the manifest does not have
   * is a stale page, not a request.
   */
  reorder(order: unknown): Record<string, number> {
    const names = this.manifestApps().map((app) => app.name);
    const valid =
      Array.isArray(order) &&
      order.length === names.length &&
      new Set(order).size === order.length &&
      names.every((name) => order.includes(name));
    if (!valid) {
      throw new DeckError(
        'invalid',
        `the order has to name every app in the manifest once: ${names.join(', ')}`,
      );
    }

    const ranks = ranksFor(order as string[]);
    setManifestOrder(this.options.profileDir, order as string[]);
    this.manifestAt = 0;
    this.options.live?.state.setRanks?.(ranks);

    return ranks;
  }

  /**
   * Takes an app out of the profile: out of the manifest, off the window
   * manager, and — if asked — out of node_modules.
   *
   * Its folder is left alone. That is where its `.env` lives, with keys that
   * took effort to get, and adding the app back should find them waiting.
   */
  async remove(
    name: string,
    options: { uninstall?: boolean } = {},
  ): Promise<{ removed: boolean; uninstalled: string | null; kept: string }> {
    this.known(name);
    if (options.uninstall && this.installer.busy) {
      throw new DeckError('invalid', 'an install is still running — try once it is done');
    }
    const packageName = this.apps.get(name)?.packageName ?? `busybar-${name}`;

    const removed = removeFromManifest(this.options.profileDir, name);
    this.manifestAt = 0;
    await this.options.live?.state.removeApp?.(name);

    let uninstalled: string | null = null;
    const uninstallable =
      options.uninstall &&
      PACKAGE_NAME.test(packageName) &&
      !TOOLS.has(packageName) &&
      existsSync(this.packageJson(packageName));
    if (uninstallable) {
      const log: string[] = [];
      try {
        await (this.options.runNpm ?? runNpm)(
          ['uninstall', '--no-audit', '--no-fund', packageName],
          this.options.profileDir,
          (line) => log.push(line),
        );
      } catch (error) {
        throw new DeckError(
          'unavailable',
          `${name} is out of the manifest, but ${packageName} is still installed: ${log.at(-1) ?? (error instanceof Error ? error.message : String(error))}`,
        );
      }
      uninstalled = packageName;
    }

    await this.refresh(true);

    return { removed, uninstalled, kept: join(this.options.profileDir, name) };
  }

  private packageJson(packageName: string): string {
    return join(
      this.options.profileDir,
      'node_modules',
      ...packageName.split('/'),
      'package.json',
    );
  }

  /** What the device is showing, straight from the device. */
  screen(display: 0 | 1): Promise<ScreenFrame> {
    const read = this.live.state.screen;
    if (!read) {
      throw new DeckError(
        'unavailable',
        'nothing here can reach the Bar, so there is no frame to show',
      );
    }

    return Promise.resolve(read(display));
  }

  /**
   * The same frame, as something a browser will actually display.
   *
   * The device answers `/screen` with base64 text that decodes to raw pixels —
   * RGB on the front, four-bit grey on the back — under a `image/bmp` header it
   * does not honour. An `<img>` makes nothing of that, so it is turned into a
   * real PNG here, once, rather than reimplemented in the page.
   */
  async screenPng(display: 0 | 1): Promise<Buffer> {
    const frame = await this.screen(display);

    try {
      return decodeScreenFrame(frame.body, display).toPng();
    } catch (error) {
      throw new DeckError(
        'unavailable',
        `the Bar sent a frame that could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private configurable(name: string): ConfigurableApp {
    const app = this.apps.get(name);
    if (!app) {
      throw new DeckError('not-found', `${name} does not describe any settings`);
    }

    return app;
  }

  private known(name: string): void {
    if (!this.apps.has(name) && !this.manifestApps().some((app) => app.name === name)) {
      throw new DeckError('not-found', `no app called ${name}`);
    }
  }

  /** A missing window manager is a state to report, not an exception to leak. */
  private safely<T>(read: () => T): T | null {
    try {
      return read();
    } catch {
      return null;
    }
  }

  /** Re-read when the file changes, so an edit by hand does not need a restart. */
  private manifestApps(): ManifestApp[] {
    const given = this.options.manifestApps;
    if (given) {
      return typeof given === 'function' ? given() : given;
    }

    const path = manifestPath(this.options.profileDir);
    if (!path) {
      return [];
    }
    const stamp = statSync(path).mtimeMs;
    if (stamp !== this.manifestAt) {
      this.manifest = readManifest(path);
      this.manifestAt = stamp;
    }

    return this.manifest;
  }
}

function readManifest(path: string): ManifestApp[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { apps?: ManifestApp[] };
    const apps = Array.isArray(raw.apps) ? inPriorityOrder(raw.apps) : [];

    // Ranked the way the window manager ranks them: by place in the list.
    return apps.map((app, index) => ({ ...app, rank: (apps.length - index) * 10 }));
  } catch {
    return [];
  }
}

/**
 * The order the window manager would pick them in, so the list reads as the
 * queue for the screen rather than as an alphabet. Only apps outside the
 * manifest can tie; those fall to the name, so they do not swap places between
 * refreshes.
 */
function byPriority(left: AppInfo, right: AppInfo): number {
  return right.rank - left.rank || left.name.localeCompare(right.name);
}

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
  DeckError,
  detachedLive,
  type Live,
  type LiveStatus,
  type ScreenFrame,
} from './live.js';

export type ManifestApp = { name: string; rank?: number; autostart?: boolean };

export type DeckOptions = {
  profileDir: string;
  live?: Live;
  /** Read from `wm.config.json`; ranks and what is supervised. */
  manifestApps?: ManifestApp[];
  /** How long a discovery scan is believed. */
  cacheMs?: number;
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

  constructor(private readonly options: DeckOptions) {}

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

        return {
          name,
          packageName: configured?.packageName ?? `busybar-${name}`,
          rank: entry?.rank ?? 10,
          configurable: Boolean(configured),
          supervised: Boolean(entry),
          running: this.safely(() => state.running(name)) ?? false,
          onScreen: onScreen === name,
          pinned: pinned === name,
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

  /** Re-read when the file changes, so a rank edit does not need a restart. */
  private manifestApps(): ManifestApp[] {
    if (this.options.manifestApps) {
      return this.options.manifestApps;
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

function manifestPath(profileDir: string): string | undefined {
  return ['wm.config.json', 'wm.json']
    .map((file) => join(profileDir, file))
    .find((path) => existsSync(path));
}

function readManifest(path: string): ManifestApp[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { apps?: ManifestApp[] };

    return Array.isArray(raw.apps) ? raw.apps : [];
  } catch {
    return [];
  }
}

/**
 * The order the window manager would pick them in, so the list reads as the
 * queue for the screen rather than as an alphabet. Ties fall to the name, so
 * two apps of equal rank do not swap places between refreshes.
 */
function byPriority(left: AppInfo, right: AppInfo): number {
  return right.rank - left.rank || left.name.localeCompare(right.name);
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PutConfigBody } from 'busybar-config';
import { Deck, type DeckOptions } from './api.js';
import type { InstallRequest } from './install.js';
import { DeckError } from './live.js';

export const MOUNT = '/deck';

/** A PUT is a handful of settings. Anything larger is a mistake or an attack. */
export const MAX_BODY_BYTES = 256 * 1024;

const UI_ROOT = resolve(fileURLToPath(new URL('../ui', import.meta.url)));

const require = createRequire(import.meta.url);

/**
 * Kit modules the browser loads directly. They are dependency-free ESM, so the
 * page runs the very interpreter the CLI and this server do, rather than a
 * second implementation that gets to disagree about whether a value is allowed.
 */
const SHARED: Record<string, string> = {
  [`${MOUNT}/kit/rules.js`]: require.resolve('busybar-kit/rules'),
  [`${MOUNT}/kit/summary.js`]: require.resolve('busybar-kit/summary'),
};

export type DeckServerOptions = DeckOptions & {
  host?: string;
  port?: number;
  /** Required to listen anywhere but loopback — these files hold API keys. */
  token?: string;
  uiDir?: string;
};

export type Mounted = {
  deck: Deck;
  /** True when the request was ours and has been answered. */
  handle: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;
};

/**
 * Mountable into the window manager's own proxy, which forwards everything it
 * does not recognise to the device — so this has to answer first, and has to
 * answer for the whole `/deck` prefix.
 */
export function mountDeck(options: DeckServerOptions): Mounted {
  const deck = new Deck(options);
  const files = new StaticFiles(options.uiDir ?? UI_ROOT);

  return {
    deck,
    handle: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://deck.invalid');
      if (url.pathname !== MOUNT && !url.pathname.startsWith(`${MOUNT}/`)) {
        return false;
      }

      try {
        if (!authorised(request, options.token)) {
          send(response, 401, { error: 'a token is needed' });

          return true;
        }
        await route(request, response, url, deck, files);
      } catch (error) {
        fail(response, error);
      }

      return true;
    },
  };
}

export async function startDeck(options: DeckServerOptions): Promise<{
  deck: Deck;
  server: Server;
  port: number;
  close: () => Promise<void>;
}> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host) && !options.token) {
    throw new Error(
      `refusing to listen on ${host} without a token: these files hold API keys and the Bar password`,
    );
  }

  const { deck, handle } = mountDeck(options);
  const server = createServer((request, response) => {
    void handle(request, response)
      .then((answered) => {
        if (answered) {
          return;
        }
        if ((request.url ?? '/') === '/') {
          response.writeHead(302, { location: `${MOUNT}/` });
          response.end();

          return;
        }
        // Everything else belongs to the Bar, reached through whatever proxy
        // sits in front. On its own, there is nothing else here.
        send(response, 404, { error: 'not found' });
      })
      .catch((error: unknown) => fail(response, error));
  });

  const port = await new Promise<number>((ready, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4112, host, () => {
      server.off('error', reject);
      const address = server.address();
      ready(typeof address === 'object' && address ? address.port : 0);
    });
  });

  return {
    deck,
    server,
    port,
    close: () =>
      new Promise((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}

// --- Routing -------------------------------------------------------------------

const API = `${MOUNT}/api`;
const CONFIG = new RegExp(`^${API}/apps/([^/]+)/config$`);
const RESTART = new RegExp(`^${API}/apps/([^/]+)/restart$`);
const PIN = new RegExp(`^${API}/pin/([^/]+)$`);
const INSTALL_JOB = new RegExp(`^${API}/install/([^/]+)$`);

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  deck: Deck,
  files: StaticFiles,
): Promise<void> {
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (path === MOUNT) {
    response.writeHead(302, { location: `${MOUNT}/` });
    response.end();

    return;
  }

  const shared = SHARED[path];
  if (shared) {
    files.serveNamed(request, response, shared);

    return;
  }

  if (!path.startsWith(`${API}/`)) {
    files.serve(request, response, path.slice(MOUNT.length));

    return;
  }

  if (path === `${API}/status` && method === 'GET') {
    await deck.refresh();
    send(response, 200, deck.status());

    return;
  }

  if (path === `${API}/apps` && method === 'GET') {
    await deck.refresh(url.searchParams.has('rescan'));
    send(response, 200, { apps: deck.listApps(), status: deck.status() });

    return;
  }

  const config = CONFIG.exec(path);
  if (config) {
    const name = decodeURIComponent(config[1] ?? '');
    await deck.refresh();
    if (method === 'GET') {
      send(response, 200, deck.getConfig(name));

      return;
    }
    if (method === 'PUT') {
      send(response, 200, deck.putConfig(name, await body<PutConfigBody>(request)));

      return;
    }
  }

  const restart = RESTART.exec(path);
  if (restart && method === 'POST') {
    await deck.refresh();
    await deck.restart(decodeURIComponent(restart[1] ?? ''));
    send(response, 200, { restarted: true });

    return;
  }

  const pin = PIN.exec(path);
  if (pin && method === 'POST') {
    const name = decodeURIComponent(pin[1] ?? '');
    await deck.refresh();
    deck.pin(name);
    send(response, 200, { pinned: name });

    return;
  }

  if (path === `${API}/pin` && method === 'DELETE') {
    deck.unpin();
    send(response, 200, { pinned: null });

    return;
  }

  if (path === `${API}/catalog` && method === 'GET') {
    send(response, 200, { packages: await deck.catalog() });

    return;
  }

  if (path === `${API}/install` && method === 'POST') {
    send(response, 202, deck.install(await body<InstallRequest>(request)));

    return;
  }

  const installJob = INSTALL_JOB.exec(path);
  if (installJob && method === 'GET') {
    send(response, 200, deck.installJob(decodeURIComponent(installJob[1] ?? '')));

    return;
  }

  if (path === `${API}/screen` && method === 'GET') {
    const display = url.searchParams.get('display') === '1' ? 1 : 0;
    const png = await deck.screenPng(display);

    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': png.length,
      // The panel changes several times a second and the browser asks for it
      // by the same URL each time; a cached frame is a frozen display.
      'cache-control': 'no-store',
    });
    response.end(png);

    return;
  }

  send(response, 404, { error: `no route ${method} ${path}` });
}

// --- Static files ----------------------------------------------------------------

type Cached = { body: Buffer; type: string; etag: string; mtimeMs: number };

/**
 * The UI is a handful of files that change only when the package is upgraded,
 * so they are read once and revalidated by mtime — rather than read off disk on
 * every request, which is what the first version did.
 */
class StaticFiles {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly root: string) {}

  /** A file we named ourselves, which the request never gets to choose. */
  serveNamed(request: IncomingMessage, response: ServerResponse, file: string): void {
    this.deliver(request, response, file);
  }

  serve(request: IncomingMessage, response: ServerResponse, requested: string): void {
    const file = this.resolve(requested);
    if (!file) {
      send(response, 404, { error: 'not found' });

      return;
    }
    this.deliver(request, response, file);
  }

  private deliver(
    request: IncomingMessage,
    response: ServerResponse,
    file: string,
  ): void {
    const entry = this.read(file);
    if (!entry) {
      send(response, 404, { error: 'not found' });

      return;
    }

    if (request.headers['if-none-match'] === entry.etag) {
      response.writeHead(304, { etag: entry.etag });
      response.end();

      return;
    }

    response.writeHead(200, {
      'content-type': entry.type,
      etag: entry.etag,
      'cache-control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : entry.body);
  }

  /**
   * Contained by construction. `startsWith` on the root string is not enough —
   * a sibling directory sharing the prefix would pass — so the relative path is
   * checked for climbing out instead.
   */
  private resolve(requested: string): string | undefined {
    const wanted = requested === '' || requested === '/' ? '/index.html' : requested;
    const candidate = resolve(this.root, `.${wanted}`);
    const inside = relative(this.root, candidate);
    if (inside.startsWith('..') || inside.split(sep).includes('..')) {
      return undefined;
    }

    return candidate;
  }

  private read(file: string): Cached | undefined {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      return undefined;
    }

    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    try {
      const body = readFileSync(file);
      const entry: Cached = {
        body,
        mtimeMs,
        type: contentType(extname(file)),
        etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
      };
      this.cache.set(file, entry);

      return entry;
    } catch {
      return undefined;
    }
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function contentType(extension: string): string {
  return TYPES[extension] ?? 'application/octet-stream';
}

// --- Plumbing --------------------------------------------------------------------

function authorised(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    return true;
  }
  const header =
    one(request.headers['authorization']) ?? one(request.headers['x-deck-token']);
  const offered = /^Bearer\s+(.*)$/i.exec(header ?? '')?.[1] ?? header ?? '';

  return sameSecret(offered, token);
}

/** Compared without leaking how much of it was right. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  return left.length === right.length && timingSafeEqual(left, right);
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function body<T>(request: IncomingMessage): Promise<T> {
  const text = await new Promise<string>((done, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new DeckError('invalid', 'that is far more than a config'));

        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DeckError('invalid', 'the body is not JSON');
  }
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.writableEnded) {
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function fail(response: ServerResponse, error: unknown): void {
  if (error instanceof DeckError) {
    send(response, error.status, { error: error.message });

    return;
  }
  send(response, 500, {
    error: error instanceof Error ? error.message : String(error),
  });
}

/**
 * `::` is deliberately absent: it is the IPv6 any-address, so treating it as
 * loopback would open the config — API keys and all — to the network with no
 * token at all.
 */
function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { defineConfigSpec, integerIn } from 'busybar-kit/config-spec';
import { SCREEN } from 'busybar-kit/screen';
import { Deck } from '../src/api.js';
import { DeckError, detachedLive, type Live } from '../src/live.js';
import { MAX_BODY_BYTES, MOUNT, startDeck } from '../src/server.js';

const SPEC = defineConfigSpec({
  name: 'demo',
  summary: 'a demo app',
  sections: [
    {
      kind: 'env',
      file: '.env',
      title: 'Settings',
      reloads: 'restart',
      fields: [
        { key: 'NAME', label: 'Name', type: 'text' },
        { key: 'KEY', label: 'Key', type: 'secret' },
        { key: 'PORT', label: 'Port', type: 'number', rules: [integerIn(1, 100)] },
      ],
    },
  ],
});

/** A profile on disk with one package that describes itself. */
function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'busybar-deck-'));
  const pkg = join(dir, 'node_modules', 'busybar-demo');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'busybar-demo', busybar: { configJson: './spec.json' } }),
  );
  writeFileSync(join(pkg, 'spec.json'), JSON.stringify(SPEC));
  writeFileSync(
    join(dir, 'wm.config.json'),
    JSON.stringify({
      apps: [
        { name: 'demo', rank: 42 },
        { name: 'ghost', rank: 5 },
      ],
    }),
  );

  return dir;
}

const dirs: string[] = [];

function scratch(): string {
  const dir = profile();
  dirs.push(dir);

  return dir;
}

after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function liveStub(): Live & { restarted: string[]; pinned: string | null } {
  const stub = {
    restarted: [] as string[],
    pinned: null as string | null,
    status: { connected: true as const },
    state: {
      running: (name: string) => name === 'demo',
      onScreen: () => 'demo',
      pin: () => stub.pinned,
      restart: (name: string) => {
        stub.restarted.push(name);
      },
      setPin: (name: string) => {
        stub.pinned = name;
      },
      clearPin: () => {
        stub.pinned = null;
      },
      // Base64 of a whole frame, which is what the device actually sends.
      screen: (display: 0 | 1) =>
        Promise.resolve({
          body: Buffer.alloc(SCREEN[display].bytes).toString('base64'),
          contentType: 'image/bmp',
        }),
    },
  };

  return stub;
}

// --- the deck itself -----------------------------------------------------------

test('an installed package that describes itself is listed with its spec', async () => {
  const deck = new Deck({ profileDir: scratch(), live: liveStub() });
  await deck.refresh();
  const apps = deck.listApps();

  const demo = apps.find((app) => app.name === 'demo');
  assert.equal(demo?.configurable, true);
  assert.equal(demo?.supervised, true);
  assert.equal(demo?.rank, 42, 'the rank comes from the manifest');
  assert.equal(demo?.spec.summary, 'a demo app');
  assert.equal(demo?.running, true);
  assert.equal(demo?.onScreen, true);
});

test('an app in the manifest but not installed is listed, and says so', async () => {
  const deck = new Deck({ profileDir: scratch(), live: liveStub() });
  await deck.refresh();

  const ghost = deck.listApps().find((app) => app.name === 'ghost');
  assert.equal(ghost?.configurable, false);
  assert.equal(ghost?.supervised, true);
  assert.deepEqual(ghost?.spec.sections, []);
});

test('with no window manager the deck says so rather than inventing state', async () => {
  const deck = new Deck({ profileDir: scratch() });
  await deck.refresh();

  const status = deck.status();
  assert.equal(status.wm.connected, false);
  assert.equal(status.onScreen, null, 'not "nobody" — we genuinely do not know');
  assert.equal(deck.listApps()[0]?.running, false);
});

test('an action that needs the window manager fails loudly without one', async () => {
  const deck = new Deck({ profileDir: scratch() });
  await deck.refresh();

  await assert.rejects(
    () => deck.restart('demo'),
    (error: unknown) => error instanceof DeckError && error.kind === 'unavailable',
  );
});

test('pinning goes through to the window manager', async () => {
  const live = liveStub();
  const deck = new Deck({ profileDir: scratch(), live });
  await deck.refresh();

  deck.pin('demo');
  assert.equal(live.pinned, 'demo');
  deck.unpin();
  assert.equal(live.pinned, null);
});

test('an app nobody has heard of is a not-found, not a crash', async () => {
  const deck = new Deck({ profileDir: scratch(), live: liveStub() });
  await deck.refresh();

  assert.throws(
    () => deck.getConfig('nope'),
    (error: unknown) => error instanceof DeckError && error.kind === 'not-found',
  );
});

test('a bad value is refused with the message the spec wrote', async () => {
  const deck = new Deck({ profileDir: scratch(), live: liveStub() });
  await deck.refresh();

  assert.throws(
    () => deck.putConfig('demo', { section: '.env', values: { PORT: '900' } }),
    (error: unknown) =>
      error instanceof DeckError &&
      error.kind === 'invalid' &&
      /Port: between 1 and 100/.test(error.message),
  );
});

test('the scan is cached, so a polling dashboard is not a filesystem walk', async () => {
  const dir = scratch();
  const deck = new Deck({ profileDir: dir, live: liveStub(), cacheMs: 60_000 });
  await deck.refresh();
  assert.equal(
    deck.listApps().find((app) => app.name === 'later'),
    undefined,
  );

  const pkg = join(dir, 'node_modules', 'busybar-later');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'busybar-later', busybar: { configJson: './spec.json' } }),
  );
  writeFileSync(join(pkg, 'spec.json'), JSON.stringify({ ...SPEC, name: 'later' }));

  await deck.refresh();
  assert.equal(
    deck.listApps().find((app) => app.name === 'later'),
    undefined,
    'still the cached answer',
  );

  await deck.refresh(true);
  assert.ok(
    deck.listApps().find((app) => app.name === 'later'),
    'until asked to rescan',
  );
});

// --- over HTTP -------------------------------------------------------------------

async function serve(options: { token?: string; live?: Live } = {}) {
  const running = await startDeck({
    profileDir: scratch(),
    live: liveStub(),
    host: '127.0.0.1',
    port: 0,
    ...options,
  });
  const base = `http://127.0.0.1:${running.port}${MOUNT}`;

  return { ...running, base };
}

test('the API answers with the apps and the status together', async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(`${base}/api/apps`);
    const payload = (await response.json()) as {
      apps: { name: string }[];
      status: { wm: { connected: boolean } };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.status.wm.connected, true);
    assert.ok(payload.apps.some((app) => app.name === 'demo'));
  } finally {
    await close();
  }
});

test('a secret is described over the wire, never sent', async () => {
  const { base, close, deck } = await serve();
  try {
    await deck.refresh();
    deck.putConfig('demo', { section: '.env', values: { KEY: 'super-secret' } });

    const body = await (await fetch(`${base}/api/apps/demo/config`)).text();
    assert.doesNotMatch(body, /super-secret/);
    assert.match(body, /"set":true/);
    assert.match(body, /"length":12/);
  } finally {
    await close();
  }
});

test('a refused value comes back as 400 with the reason', async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(`${base}/api/apps/demo/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ section: '.env', values: { PORT: '900' } }),
    });

    assert.equal(response.status, 400);
    assert.match(
      ((await response.json()) as { error: string }).error,
      /between 1 and 100/,
    );
  } finally {
    await close();
  }
});

test('a body that is not JSON is a 400, not a 500', async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(`${base}/api/apps/demo/config`, {
      method: 'PUT',
      body: 'not json at all',
    });

    assert.equal(response.status, 400);
  } finally {
    await close();
  }
});

test('a body far larger than a config is refused rather than buffered', async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(`${base}/api/apps/demo/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_BODY_BYTES + 1024),
    }).catch(() => null);

    // The socket is destroyed, so either a 400 or a broken connection is right.
    assert.ok(response === null || response.status === 400);
  } finally {
    await close();
  }
});

test('the UI and the shared rule interpreter are both served', async () => {
  const { base, close } = await serve();
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Deck/);

    const rules = await fetch(`${base}/kit/rules.js`);
    assert.equal(rules.status, 200, 'the browser gets the same interpreter');
    assert.match(await rules.text(), /validateValue/);
  } finally {
    await close();
  }
});

test('a second request for an unchanged file is answered with 304', async () => {
  const { base, close } = await serve();
  try {
    const first = await fetch(`${base}/styles.css`);
    const etag = first.headers.get('etag') ?? '';
    assert.ok(etag);

    const second = await fetch(`${base}/styles.css`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.status, 304);
  } finally {
    await close();
  }
});

test('a path that climbs out of the UI directory gets nothing', async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(`${base}/../package.json`, { redirect: 'manual' });
    assert.ok(response.status === 404 || response.status === 301);
  } finally {
    await close();
  }
});

test('with a token set, a request without one is turned away', async () => {
  const { base, close } = await serve({ token: 'hunter2' });
  try {
    assert.equal((await fetch(`${base}/api/apps`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/apps`, { headers: { authorization: 'Bearer wrong' } }))
        .status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/api/apps`, { headers: { authorization: 'Bearer hunter2' } }))
        .status,
      200,
    );
  } finally {
    await close();
  }
});

test('listening off loopback without a token is refused outright', async () => {
  await assert.rejects(
    () => startDeck({ profileDir: scratch(), host: '0.0.0.0', port: 0 }),
    /refusing to listen/,
  );
});

test('a detached deck names what is missing', () => {
  const live = detachedLive('no daemon here');
  assert.equal(live.status.connected, false);
  assert.throws(() => live.state.setPin('demo'), /no daemon here/);
});

test('apps come back in the order the screen would give them, not alphabetical', async () => {
  const deck = new Deck({ profileDir: scratch(), live: liveStub() });
  await deck.refresh();

  // demo is rank 42 and ghost is rank 5, so alphabetical order would put the
  // lower-ranked one first. The list is the queue for the screen.
  assert.deepEqual(
    deck.listApps().map((app) => app.name),
    ['demo', 'ghost'],
  );
});

test('equal ranks fall back to the name, so the list does not shuffle', async () => {
  const deck = new Deck({
    profileDir: scratch(),
    live: liveStub(),
    manifestApps: [
      { name: 'zulu', rank: 10 },
      { name: 'alpha', rank: 10 },
      { name: 'demo', rank: 90 },
    ],
  });
  await deck.refresh();

  assert.deepEqual(
    deck.listApps().map((app) => app.name),
    ['demo', 'alpha', 'zulu'],
  );
});

// --- why an app is down, and adding one -------------------------------------------

test('an app that is down carries the reason the window manager gave', async () => {
  const live = liveStub();
  live.state.health = (name) =>
    name === 'ghost'
      ? {
          state: 'exited',
          message: 'Crashed with exit code 3',
          exitCode: 3,
          output: ['no token'],
        }
      : null;
  const deck = new Deck({ profileDir: scratch(), live });
  await deck.refresh();

  const ghost = deck.listApps().find((app) => app.name === 'ghost');
  assert.equal(ghost?.health?.state, 'exited');
  assert.deepEqual(ghost?.health?.output, ['no token']);
  assert.equal(deck.listApps().find((app) => app.name === 'demo')?.health, null);
});

/** An npm that "installs" by writing the package straight into node_modules. */
function fakeNpm(
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, unknown> = {},
) {
  const calls: string[][] = [];
  const runNpm = (args: string[], _cwd: string, onLine: (line: string) => void) => {
    calls.push(args);
    const into = join(dir, 'node_modules', String(pkg['name']));
    mkdirSync(into, { recursive: true });
    writeFileSync(join(into, 'package.json'), JSON.stringify(pkg));
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(into, file), JSON.stringify(content));
    }
    onLine('added 1 package');

    return Promise.resolve();
  };

  return { runNpm, calls };
}

async function finished(deck: Deck, id: string) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const job = deck.installJob(id);
    if (job.state !== 'running' || Date.now() > deadline) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('installing an app writes it into the manifest and hands it to the window manager', async () => {
  const dir = scratch();
  const added: string[] = [];
  const live = liveStub();
  live.state.addApp = (name) => {
    added.push(name);
  };
  const npm = fakeNpm(
    dir,
    {
      name: 'busybar-fresh',
      bin: { 'busybar-fresh': 'dist/index.js' },
      busybar: { configJson: './spec.json' },
    },
    { 'spec.json': { ...SPEC, name: 'freshly' } },
  );
  const deck = new Deck({ profileDir: dir, live, runNpm: npm.runNpm });

  const job = await finished(
    deck,
    deck.install({ packageName: 'busybar-fresh', rank: 55 }).id,
  );

  assert.equal(job.state, 'done', job.message);
  assert.equal(job.name, 'freshly', 'named after what it draws as, from its spec');
  assert.ok(
    npm.calls[0]?.includes('--ignore-scripts'),
    'nothing in the package gets to run',
  );
  const manifest = JSON.parse(readFileSync(join(dir, 'wm.config.json'), 'utf8')) as {
    apps: { name: string; rank: number }[];
  };
  assert.deepEqual(manifest.apps.at(-1), { name: 'freshly', rank: 55 });
  assert.ok(existsSync(join(dir, 'freshly')), 'with a folder for its .env');
  assert.deepEqual(added, ['freshly']);
  assert.ok(deck.listApps().some((app) => app.name === 'freshly'));
});

test('a library is installed but not added, and the reason is the message', async () => {
  const dir = scratch();
  const npm = fakeNpm(dir, { name: 'busybar-lib' });
  const deck = new Deck({ profileDir: dir, live: liveStub(), runNpm: npm.runNpm });

  const job = await finished(deck, deck.install({ packageName: 'busybar-lib' }).id);

  assert.equal(job.state, 'failed');
  assert.match(job.message, /no program to run/);
  assert.doesNotMatch(readFileSync(join(dir, 'wm.config.json'), 'utf8'), /lib/);
});

test('a package name that is not one never reaches npm', () => {
  const npm = fakeNpm(scratch(), { name: 'x' });
  const deck = new Deck({ profileDir: scratch(), runNpm: npm.runNpm });

  for (const packageName of ['busybar-x && calc', '../evil', '', 'a b']) {
    assert.throws(
      () => deck.install({ packageName }),
      (error: unknown) => error instanceof DeckError && error.kind === 'invalid',
      packageName,
    );
  }
  assert.equal(npm.calls.length, 0);
});

test('the catalog lists apps from npm, not the libraries tagged the same way', async () => {
  const dir = scratch();
  let asked = 0;
  const answers: Record<string, unknown> = {
    search: {
      objects: [
        { package: { name: 'busybar-wm' } },
        { package: { name: 'busybar-demo' } },
        { package: { name: 'busybar-helper' } },
      ],
    },
    'busybar-demo': { version: '1.0.0', description: 'demo', bin: 'x.js', busybar: {} },
    'busybar-helper': { version: '2.0.0', description: 'a library' },
  };
  const fakeFetch = (url: string) => {
    asked += 1;
    const key = url.includes('/-/v1/search')
      ? 'search'
      : (/registry\.npmjs\.org\/([^/]+)\/latest/.exec(url)?.[1] ?? '');

    return Promise.resolve(new Response(JSON.stringify(answers[key] ?? {})));
  };
  const deck = new Deck({
    profileDir: dir,
    live: liveStub(),
    fetch: fakeFetch as typeof fetch,
  });

  const packages = await deck.catalog();

  assert.deepEqual(
    packages.map((entry) => entry.packageName),
    ['busybar-demo'],
    'the wm is a tool and the helper has nothing to run',
  );
  assert.equal(packages[0]?.installed, true, 'the scratch profile has it');
  assert.equal(packages[0]?.added, true, 'and its manifest lists it');

  const before = asked;
  await deck.catalog();
  assert.equal(asked, before, 'npm is not asked again every time the dialog opens');
});

test('the deck serves a frame of the panel, straight from the device', async () => {
  const { base, close } = await serve();
  try {
    const response = await fetch(`${base}/api/screen?display=1`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    // A cached frame is a frozen display.
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  } finally {
    await close();
  }
});

test('without a window manager there is no frame to serve, and it says so', async () => {
  const { base, close } = await serve({ live: detachedLive('no daemon here') });
  try {
    const response = await fetch(`${base}/api/screen?display=0`);

    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /nothing here can reach the Bar/);
  } finally {
    await close();
  }
});

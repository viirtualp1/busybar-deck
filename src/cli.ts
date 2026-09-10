#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { errorMessage } from 'busybar-kit/errors';
import { loadEnvFile } from 'busybar-kit/config';
import { MOUNT, startDeck } from './server.js';

loadEnvFile();

const args = parse(process.argv.slice(2));
const profileDir = resolve(
  expandHome(args.profile ?? process.env['WM_PROFILE'] ?? process.cwd()),
);

if (!existsSync(join(profileDir, 'node_modules'))) {
  console.error(`No profile at ${profileDir}`);
  console.error('Point it at one with --profile <dir>, or set WM_PROFILE.');
  process.exit(1);
}

const host = args.host ?? process.env['DECK_HOST'] ?? '127.0.0.1';
const token = args.token ?? process.env['DECK_TOKEN'] ?? '';

try {
  const { deck, port, close } = await startDeck({
    profileDir,
    host,
    port: Number(args.port ?? process.env['DECK_PORT'] ?? 4112),
    ...(token ? { token } : {}),
  });

  await deck.refresh();
  const apps = deck.listApps();
  console.log('busybar-deck');
  console.log(`Profile: ${profileDir}`);
  console.log(`Apps: ${apps.map((app) => app.name).join(', ') || 'none yet'}`);
  for (const problem of deck.status().problems) {
    console.warn(problem);
  }
  console.log(`Open http://${host === '::1' ? '[::1]' : host}:${port}${MOUNT}/`);
  if (!token && host !== '127.0.0.1' && host !== 'localhost') {
    console.warn('No DECK_TOKEN: anyone who can reach this port can read your keys');
  }

  const stop = () => void close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}

type Args = { profile?: string; host?: string; port?: string; token?: string };

/** `busybar-deck [profile] [--host h] [--port n] [--token t]` */
function parse(argv: string[]): Args {
  const args: Args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const [flag, inline] = arg.startsWith('--') ? split(arg) : [null, undefined];

    if (flag) {
      const value = inline ?? argv[++index];
      const known =
        flag === 'profile' || flag === 'host' || flag === 'port' || flag === 'token';
      if (known && value !== undefined) {
        args[flag] = value;
      } else if (known) {
        console.error(`--${flag} needs a value`);
        process.exit(1);
      }
      continue;
    }
    if (!arg.startsWith('-')) {
      args.profile ??= arg;
    }
  }

  return args;
}

function split(arg: string): [string, string | undefined] {
  const at = arg.indexOf('=');

  return at === -1 ? [arg.slice(2), undefined] : [arg.slice(2, at), arg.slice(at + 1)];
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\')
    ? join(homedir(), path.slice(1))
    : path;
}

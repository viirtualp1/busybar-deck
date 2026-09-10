# busybar-deck

> [!IMPORTANT]
> **Unofficial community project.** Built and maintained by [@viirtualp1](https://github.com/viirtualp1), **not** an official Flipper Devices / BUSY product, and not affiliated with, endorsed by, or supported by them. "BUSY Bar" remains their trademark. For the real hardware and official apps, visit **[busy.app](https://busy.app/)**.

A control deck for the [BUSY Bar](https://busy.bar), in a browser. What is on
screen right now, which app owns it, and every app's settings — from the desk or
from a phone on the way to the airport.

```bash
cd ~/.busybar && npx busybar-deck
```

## It knows nothing about your apps

Not one field in this UI is written here. Every app describes its own settings
in a spec, this reads the specs off the packages you have installed, and the
page is drawn from them. Install a new app and it appears, with its own fields,
its own hints and its own validation — without a line changing in the deck.

The rules and the summary templates are interpreted by
`busybar-kit/rules` and `busybar-kit/summary`, and the browser is served **those
very modules** rather than a copy. A value the page accepts is a value the CLI
and the daemon accept, because it is the same code deciding.

## What is on it

- **The Bar itself**, front and back, refreshed while you are looking at it and
  backing off when the device is not answering.
- **The apps**, with what is running, what is on screen, and what a pin is
  holding — or an honest "no window manager" when it is not mounted on one.
- **The settings**, one section per file, `advanced` folded away, checked as you
  type, and saved together from one bar rather than a button per form.

Sections say whether a change lands **live** or **needs a restart**, because the
app says so in its spec. Only dota's schedule re-reads itself; everything else
gets a restart button that means something.

## Two ways to run it

Mounted on [busybar-wm](https://github.com/viirtualp1/busybar-wm), which is what
gives it live state and the device's own API behind the same origin:

```ts
import { mountDeck } from 'busybar-deck';

const { handle } = mountDeck({ profileDir, live });
// answer /deck before anything is forwarded to the Bar
```

Or on its own, for editing settings with no daemon running:

```bash
busybar-deck --profile ~/.busybar
busybar-deck --profile ~/.busybar --host 0.0.0.0 --token "$(openssl rand -hex 16)"
```

Detached, it says so rather than inventing an answer: apps read as not running,
nothing is on screen, and pin or restart fail with "the window manager is not
here" instead of quietly pretending.

## About the keys in these files

`.env` files hold a Steam key, a Stratz token, the Bar's own password.

- **Loopback by default.** Binding anywhere else without a `--token` is refused
  outright, rather than warned about.
- **Secrets never travel.** A secret reads back as `{ set: true, length: 32 }`
  and never as its value; an empty box leaves the one you have, and `null`
  clears it.
- **Everything is validated again on write.** A client cannot be trusted, and a
  bad value in a config file is a crash at the app's next start.

## Your files stay yours

`.env` files keep every comment and every line; a change rewrites one line in
place. A JSON config keeps every key it had, including the `_comment` block that
explains its own format, and a number that was a number goes back as one.

## Scripts

```bash
npm run check   # lint + typecheck + test
npm run dev -- --profile ../busybar-profile
```

MIT.

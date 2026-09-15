// The very interpreter the CLI and the daemon use, served out of busybar-kit.
// Nothing about any app is known here; it all comes from the specs.
import { validateValue } from './kit/rules.js';
import { renderSummary } from './kit/summary.js';

const API = '/deck/api';

const el = (id) => document.getElementById(id);
const ui = {
  front: el('front'),
  back: el('back'),
  unpin: el('unpin'),
  appList: el('app-list'),
  empty: el('empty'),
  appView: el('app-view'),
  appName: el('app-name-text'),
  appDot: el('app-dot'),
  appSummary: el('app-summary'),
  sections: el('sections'),
  pin: el('pin'),
  restart: el('restart'),
  savebar: el('savebar'),
  savebarText: el('savebar-text'),
  save: el('save'),
  discard: el('discard'),
  palette: el('palette'),
  paletteInput: el('palette-input'),
  paletteList: el('palette-list'),
  toast: el('toast'),
  appAlert: el('app-alert'),
  stop: el('stop'),
  remove: el('remove'),
  removeZone: el('remove-zone'),
  remover: el('remover'),
  removerText: el('remover-text'),
  removerUninstall: el('remover-uninstall'),
  removerUninstallRow: el('remover-uninstall-row'),
  removerUninstallText: el('remover-uninstall-text'),
  removerNote: el('remover-note'),
  removerCancel: el('remover-cancel'),
  removerGo: el('remover-go'),
  addApp: el('add-app'),
  installer: el('installer'),
  installerClose: el('installer-close'),
  installerSearch: el('installer-search'),
  installerList: el('installer-list'),
  installerForm: el('installer-form'),
  installerPackage: el('installer-package'),
  installerName: el('installer-name'),
  installerGo: el('installer-go'),
  installerLog: el('installer-log'),
};

/** Everything the page knows. Rendering is a function of this and nothing else. */
const state = {
  apps: [],
  status: null,
  selected: null,
  /** The saved values, as the server last told us. */
  saved: null,
  /** Only what has actually been changed — the payload is built from this. */
  edits: new Map(),
  errors: new Map(),
};

// --- talking to the deck -------------------------------------------------------

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error ?? `${method} ${path} failed`);
  }

  return payload;
}

// --- the device ----------------------------------------------------------------

/**
 * Polls only while the tab is in front, and backs off when the Bar is not
 * answering — a dashboard left open overnight should not keep asking a device
 * that is switched off.
 */
const screens = {
  delay: 1500,
  timer: null,
  start() {
    this.stop();
    if (document.hidden) {
      return;
    }
    this.tick();
  },
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  },
  tick() {
    const stamp = Date.now();
    let pending = 2;
    let failed = false;

    const done = (ok) => {
      failed ||= !ok;
      if ((pending -= 1) > 0) {
        return;
      }
      this.delay = failed ? Math.min(this.delay * 2, 30_000) : 1500;
      this.timer = setTimeout(() => this.tick(), this.delay);
    };

    // Through the deck, not straight at the Bar: an `<img>` cannot carry the
    // credentials the device wants, and the daemon in front of us already has
    // them. The timestamp is what stops the browser reusing a frozen frame.
    load(ui.front, `${API}/screen?display=0&t=${stamp}`, done);
    load(ui.back, `${API}/screen?display=1&t=${stamp}`, done);
  },
};

function load(img, src, done) {
  const probe = new Image();
  probe.onload = () => {
    img.src = probe.src;
    done(true);
  };
  probe.onerror = () => done(false);
  probe.src = src;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    screens.stop();
  } else {
    screens.start();
  }
});

// --- rendering the rail --------------------------------------------------------

function renderStatus() {
  const { status } = state;
  if (!status) {
    return;
  }
  ui.unpin.hidden = !status.pinned;
}

function renderApps() {
  // A poll landing mid-drag would rebuild the list out from under the pointer.
  if (drag.active) {
    return;
  }
  const fragment = document.createDocumentFragment();

  for (const app of state.apps) {
    const li = document.createElement('li');
    li.dataset.name = app.name;
    const button = document.createElement('button');
    button.className = 'app-item';
    button.classList.toggle('running', app.running);
    button.classList.toggle('on-screen', app.onScreen);
    button.classList.toggle('sortable', app.supervised);
    button.setAttribute('aria-current', String(app.name === state.selected));
    if (app.supervised) {
      button.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      button.title = 'Drag, or Alt+↑ / Alt+↓, to move it — higher takes the screen first';
    }

    const grip = span('grip', '');
    grip.setAttribute('aria-hidden', 'true');
    button.append(
      grip,
      span('state', ''),
      span('name', app.name),
      app.pinned ? span('badge', 'held') : '',
    );
    button.addEventListener('click', () => {
      if (!drag.justDropped) {
        void select(app.name);
      }
    });
    if (app.supervised) {
      sortable(li, button, app);
    }
    li.append(button);
    fragment.append(li);
  }

  ui.appList.replaceChildren(fragment);
}

// --- reordering ---------------------------------------------------------------------

const drag = { active: false, justDropped: false };

/**
 * Press, move, let go.
 *
 * The row lifts only once the pointer has travelled a few pixels, so a click
 * is still a click, and the rows it passes slide out of its way — showing
 * where it will land before it lands. With a mouse the whole row is the
 * handle; on a touch screen only the grip is, or a finger could no longer
 * scroll the page by dragging along the list.
 */
function sortable(li, button, app) {
  button.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || drag.active) {
      return;
    }
    if (down.pointerType !== 'mouse' && !down.target.closest('.grip')) {
      return;
    }

    const rows = [...ui.appList.children];
    const from = rows.indexOf(li);
    const boxes = rows.map((row) => row.getBoundingClientRect());
    const step = boxes.length > 1 ? boxes[1].top - boxes[0].top : boxes[from].height;
    const reach = {
      up: boxes[0].top - boxes[from].top,
      down: boxes[boxes.length - 1].top - boxes[from].top,
    };
    let lifted = false;
    let to = from;

    const move = (event) => {
      const dy = event.clientY - down.clientY;
      if (!lifted) {
        if (Math.abs(dy) < 5) {
          return;
        }
        lifted = true;
        drag.active = true;
        button.setPointerCapture?.(down.pointerId);
        li.classList.add('dragging');
        ui.appList.classList.add('sorting');
      }
      event.preventDefault();

      const y = Math.max(reach.up, Math.min(reach.down, dy));
      li.style.transform = `translateY(${y}px)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(y / step)));

      rows.forEach((row, index) => {
        if (index === from) {
          return;
        }
        const shift =
          from < to && index > from && index <= to
            ? -step
            : to < from && index >= to && index < from
              ? step
              : 0;
        row.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!lifted) {
        return;
      }
      drag.active = false;
      // The click that follows a drop is the end of the drag, not a choice.
      drag.justDropped = true;
      setTimeout(() => {
        drag.justDropped = false;
      }, 0);
      ui.appList.classList.remove('sorting');
      li.classList.remove('dragging');

      if (to === from) {
        for (const row of rows) {
          row.style.transform = '';
        }

        return;
      }
      void reorder(app.name, to);
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // The same thing without a pointer.
  button.addEventListener('keydown', (event) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }
    event.preventDefault();
    const at = state.apps.findIndex((candidate) => candidate.name === app.name);
    const to = at + (event.key === 'ArrowUp' ? -1 : 1);
    if (to >= 0 && to < state.apps.length) {
      void reorder(app.name, to, { focus: true });
    }
  });
}

/**
 * Moves an app, shows it moved, then tells the deck.
 *
 * The list changes first because a drop that waits on the network feels like
 * a drop that did not take. If the deck refuses, it goes back and says why.
 */
async function reorder(name, to, { focus = false } = {}) {
  const before = state.apps;
  const next = [...before];
  const [moved] = next.splice(
    next.findIndex((app) => app.name === name),
    1,
  );
  next.splice(to, 0, moved);

  // Only apps in the manifest have a place to give. The ranks kept here match
  // the ones the deck works out, so nothing jumps when the next poll arrives.
  const order = next.filter((app) => app.supervised).map((app) => app.name);
  const ranks = new Map(order.map((app, index) => [app, (order.length - index) * 10]));
  state.apps = next.map((app) =>
    ranks.has(app.name) ? { ...app, rank: ranks.get(app.name) } : app,
  );
  renderApps();
  settle(name, focus);

  try {
    await api('PUT', '/order', { order });
  } catch (error) {
    state.apps = before;
    renderApps();
    settle(name, focus);
    flash(error.message, true);
  }
}

function settle(name, focus) {
  const row = [...ui.appList.children].find((item) => item.dataset.name === name);
  row?.classList.add('settled');
  if (focus) {
    row?.querySelector('button')?.focus();
  }
}

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;

  return node;
}

// --- the editor ----------------------------------------------------------------

async function select(name) {
  if (state.edits.size > 0 && !confirm('Discard the changes you have not saved?')) {
    return;
  }
  state.selected = name;
  state.edits.clear();
  state.errors.clear();
  renderApps();

  const app = current();
  ui.empty.hidden = true;
  ui.appView.hidden = false;
  ui.appName.textContent = app.name;
  ui.appSummary.textContent = app.spec.summary ?? app.packageName;
  renderActions();

  state.saved = await api('GET', `/apps/${encodeURIComponent(name)}/config`);
  renderSections();
  renderSaveBar();
}

function current() {
  return state.apps.find((app) => app.name === state.selected);
}

/**
 * The two buttons above the settings, kept in step with the rail.
 *
 * Offering the screen to an app that is not running would be offering nothing:
 * there is no frame behind it to put there. Since an app can start or stop
 * while you are looking at it, this is re-run on every poll rather than only
 * when you pick one.
 */
function renderActions() {
  const app = current();
  if (!app) {
    return;
  }
  const wm = state.status?.wm.connected ?? false;
  // Offering the screen to something already on it is an offer of nothing, and
  // to something that is not running there is no frame to offer. What is left
  // is the one case the button is for.
  ui.pin.hidden = app.onScreen || !app.running;
  ui.pin.disabled = !wm;
  // Restarting something that is not running is starting it, so it says that.
  ui.restart.textContent = app.running ? 'Restart' : 'Start';
  ui.restart.disabled = !wm || !app.supervised || app.health?.state === 'unmanaged';
  // The one button here that turns something off, so the one that looks it.
  ui.stop.hidden = !app.running;
  ui.stop.disabled = !wm || !app.supervised;
  ui.removeZone.hidden = !app.supervised && !app.installed;
  ui.appDot.hidden = !app.onScreen;
  renderAlert(app);
}

// --- why an app is down -------------------------------------------------------------

const ALERT = {
  waiting: { tone: 'info', title: 'Not started' },
  restarting: { tone: 'bad', title: 'Crashed, restarting' },
  exited: { tone: 'bad', title: 'Stopped' },
  stopped: { tone: 'info', title: 'Stopped' },
  broken: { tone: 'bad', title: 'Cannot start' },
  unmanaged: { tone: 'warn', title: 'Not installed' },
};

let alertKey = '';

/**
 * The red dot, explained, above the app's name.
 *
 * Rebuilt only when what it says changes — it is re-run on every poll, and a
 * rebuild would snap shut the output you had just opened to read.
 */
function renderAlert(app) {
  const view = alertView(app);
  const key = view ? JSON.stringify({ ...view, name: app.name }) : '';
  if (key === alertKey) {
    return;
  }
  alertKey = key;
  ui.appAlert.hidden = !view;
  if (!view) {
    ui.appAlert.replaceChildren();

    return;
  }

  const open = ui.appAlert.querySelector('details')?.open ?? false;
  ui.appAlert.className = `alert ${view.tone}`;

  const body = document.createElement('div');
  body.className = 'alert-body';
  body.append(span('alert-title', view.title), span('alert-text', view.text));
  if (view.when) {
    body.append(span('alert-when', view.when));
  }
  if (view.output?.length) {
    const details = document.createElement('details');
    details.open = open;
    details.append(
      Object.assign(document.createElement('summary'), {
        textContent: `Last ${view.output.length === 1 ? 'line' : `${view.output.length} lines`} it printed`,
      }),
      Object.assign(document.createElement('pre'), {
        textContent: view.output.join('\n'),
      }),
    );
    body.append(details);
  }

  ui.appAlert.replaceChildren(
    Object.assign(document.createElement('i'), {
      className: 'alert-icon',
      ariaHidden: 'true',
    }),
    body,
  );
}

function alertView(app) {
  const wm = state.status?.wm;
  if (wm && !wm.connected) {
    return {
      tone: 'info',
      title: 'Not connected to busybar-wm',
      text: `This deck is running on its own, so it cannot tell whether ${app.name} is running.`,
    };
  }
  if (app.running) {
    return null;
  }

  const health = app.health;
  if (!health) {
    return { tone: 'bad', title: 'Offline', text: 'The window manager did not say why.' };
  }

  const look = ALERT[health.state] ?? { tone: 'bad', title: 'Offline' };
  // Minutes, not seconds: this re-renders every poll, and a clock that ticks
  // in the key would rebuild it every time.
  const when = health.restartAt
    ? `Next try ${relative(health.restartAt, 'minute')}`
    : health.since
      ? `Since ${relative(health.since, 'minute')}`
      : '';

  return { ...look, text: sentence(health.message), when, output: health.output };
}

function sentence(text) {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "in 2 minutes", "5 minutes ago" — in the reader's own language. */
function relative(at, finest = 'second') {
  const seconds = Math.round((at - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60 && finest === 'second') {
    return format.format(seconds, 'second');
  }
  if (abs < 3600) {
    return abs < 60
      ? format.format(0, 'minute')
      : format.format(Math.round(seconds / 60), 'minute');
  }
  if (abs < 86_400) {
    return format.format(Math.round(seconds / 3600), 'hour');
  }

  return format.format(Math.round(seconds / 86_400), 'day');
}

function renderSections() {
  const app = current();
  const fragment = document.createDocumentFragment();

  if (app.spec.sections.length === 0) {
    fragment.append(
      note(
        `${app.packageName} does not describe any settings, so there is nothing to edit here.`,
      ),
    );
  }

  for (const section of app.spec.sections) {
    fragment.append(section.kind === 'env' ? envSection(section) : listSection(section));
  }

  ui.sections.replaceChildren(fragment);
}

function sectionShell(section) {
  const block = document.createElement('section');
  block.className = 'section';

  const head = document.createElement('div');
  head.className = 'section-head';
  const title = document.createElement('h2');
  title.textContent = section.title;

  const file = span('mono', section.file);
  head.append(title, file);

  // Only the good news is worth a badge. Needing a restart is the ordinary
  // case, and labelling every section with it says nothing.
  if ((section.reloads ?? 'restart') === 'live') {
    const tag = span('tag live', 'picked up live');
    head.insertBefore(tag, file);
  }

  block.append(head);

  return block;
}

function envSection(section) {
  const block = sectionShell(section);
  const values = state.saved.sections[section.file] ?? {};

  // Every field, in the order the app declared them. A setting behind a
  // disclosure is a setting you have to already know about to find, which is
  // the opposite of what this page is for — and `advanced` is the app's
  // opinion about importance, not a reason to hide anything.
  const fields = document.createElement('div');
  fields.className = 'fields';
  for (const field of section.fields) {
    fields.append(fieldRow(section, field, values[field.key]));
  }
  block.append(fields);

  return block;
}

function listSection(section) {
  const block = sectionShell(section);
  const raw = state.saved.sections[section.file];
  // What is on screen, not what is on disk. The section is rebuilt in place
  // after every add and remove, and reading the saved copy here meant a new
  // entry was recorded, enabled the save bar, and then vanished — the button
  // looked broken while working perfectly.
  const entries = listEdits(section);
  const header = Array.isArray(raw) ? {} : (raw?.header ?? {});

  if (section.header?.length) {
    const fields = document.createElement('div');
    fields.className = 'fields';
    for (const field of section.header) {
      fields.append(fieldRow(section, field, header[field.key], { header: true }));
    }
    block.append(fields);
  }

  const list = document.createElement('div');
  list.className = 'entries';
  entries.forEach((entry, index) => list.append(entryRow(section, entry, index)));
  if (entries.length === 0) {
    list.append(note(section.empty ?? 'Nothing here yet.'));
  }
  block.append(list);

  const add = document.createElement('button');
  add.className = 'add';
  add.textContent = '+ Add';
  add.addEventListener('click', () => {
    const next = [...listEdits(section), {}];
    setListEdit(section, next);
    // Only this section is rebuilt, so nothing else you had open collapses.
    block.replaceWith(listSection(section));
  });
  block.append(add);

  return block;
}

function entryRow(section, entry, index) {
  const details = document.createElement('details');
  details.className = 'entry';
  details.open = Object.keys(entry).length === 0;

  const summary = document.createElement('summary');
  summary.append(span('', renderSummary(section.summary, entry) || `entry ${index + 1}`));

  const drop = document.createElement('button');
  drop.className = 'ghost small drop';
  drop.type = 'button';
  drop.textContent = 'Remove';
  drop.addEventListener('click', (event) => {
    event.preventDefault();
    const next = listEdits(section).filter((_, at) => at !== index);
    setListEdit(section, next);
    details.closest('.section').replaceWith(listSection(section));
  });
  summary.append(drop);
  details.append(summary);

  const fields = document.createElement('div');
  fields.className = 'fields';
  for (const field of section.fields) {
    fields.append(fieldRow(section, field, entry[field.key] ?? '', { index, summary }));
  }
  details.append(fields);

  return details;
}

let uid = 0;

/**
 * One row. The id is minted per control rather than derived from the key,
 * because the same key appears in several sections and in every record — the
 * old build pointed half its labels at the wrong input.
 */
function fieldRow(section, field, raw, where = {}) {
  const id = `f${(uid += 1)}`;
  const row = document.createElement('div');
  row.className = 'field';

  const title = document.createElement('div');
  title.className = 'field-title';
  if (isOptional(field)) {
    title.append(span('optional', 'optional'));
  }
  const line = document.createElement('div');
  line.className = 'field-label';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = field.label;
  line.append(label);
  // The explanation waits behind a button rather than sitting under every
  // label: read once, it is noise on every visit after.
  if (field.hint || field.help) {
    line.append(infoButton(field));
  }
  title.append(line);
  row.append(title);

  const holder = document.createElement('div');
  holder.className = 'control';
  const error = document.createElement('p');
  error.className = 'error';
  error.hidden = true;

  const secretSet = raw && typeof raw === 'object' && raw.set;
  const value = typeof raw === 'string' ? raw : '';
  const control = makeControl(field, value, secretSet ? raw.length : 0, id);

  const onInput = (next) => {
    const problem = validateValue(field.rules, next, field, secretSet ? 'set' : '');
    row.classList.toggle('bad', Boolean(problem));
    error.hidden = !problem;
    error.textContent = problem ?? '';

    const key = editKey(section, field, where);
    if (problem) {
      state.errors.set(key, `${field.label}: ${problem}`);
    } else {
      state.errors.delete(key);
    }

    record(section, field, next, where);
    row.classList.toggle('changed', state.edits.has(key));
    if (where.summary) {
      refreshSummary(section, where);
    }
    renderSaveBar();
  };

  wire(control, onInput);
  holder.append(control);
  if (field.lookup && control.tagName === 'INPUT') {
    attachLookup(field, control, holder);
  }
  row.append(holder, error);

  return row;
}

/**
 * Whether leaving it empty is a perfectly good answer.
 *
 * A switch or a list always holds one of its values, so "optional" would say
 * nothing about them; it is a box you can type into and walk away from.
 */
function isOptional(field) {
  if (field.type === 'boolean' || field.type === 'select') {
    return false;
  }

  return !field.required && !(field.rules ?? []).some((rule) => rule.kind === 'required');
}

/** The "i" beside a label: what the setting is for, and where to get it. */
function infoButton(field) {
  const wrap = document.createElement('span');
  wrap.className = 'info';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-button';
  button.textContent = 'i';
  button.setAttribute('aria-label', `About ${field.label}`);

  const tip = document.createElement('div');
  tip.className = 'info-tip';
  tip.id = `t${(uid += 1)}`;
  tip.setAttribute('role', 'tooltip');
  button.setAttribute('aria-describedby', tip.id);

  if (field.hint) {
    tip.append(paragraph(field.hint, 'info-lead'));
  }
  for (const text of (field.help ?? '').split(/\n\s*\n/)) {
    if (text.trim()) {
      tip.append(paragraph(text.trim()));
    }
  }

  // Hover opens it; a click pins it for anyone reading on a touch screen or
  // following a link inside.
  button.addEventListener('click', () => wrap.classList.toggle('open'));
  document.addEventListener('click', (event) => {
    if (!wrap.contains(event.target)) {
      wrap.classList.remove('open');
    }
  });

  wrap.append(button, tip);

  return wrap;
}

/** A paragraph whose addresses are links, and whose `code` is code. */
function paragraph(text, className = '') {
  const p = document.createElement('p');
  p.className = className;
  for (const part of text.split(/(https?:\/\/[^\s,)]+[^\s,).]|`[^`]+`)/)) {
    if (!part) {
      continue;
    }
    if (part.startsWith('`')) {
      p.append(
        Object.assign(document.createElement('code'), { textContent: part.slice(1, -1) }),
      );
    } else if (/^https?:\/\//.test(part)) {
      p.append(
        Object.assign(document.createElement('a'), {
          href: part,
          textContent: part.replace(/^https?:\/\/(www\.)?/, ''),
          target: '_blank',
          rel: 'noopener noreferrer',
        }),
      );
    } else {
      p.append(part);
    }
  }

  return p;
}

// --- checking a value against the world ------------------------------------------

const LOOKUP_DEBOUNCE_MS = 450;

/** Answers already had, so focusing a field again does not ask again. */
const looked = new Map();

/**
 * A card above the field saying what the value turned out to be.
 *
 * Typing is debounced and a paste is not special — it is just input that
 * arrived all at once. Only the newest question's answer is shown, so a slow
 * reply to something you have since deleted cannot overwrite a fast one.
 */
function attachLookup(field, input, holder) {
  const spec = field.lookup;
  const card = document.createElement('div');
  card.className = 'lookup';
  card.hidden = true;
  card.setAttribute('role', 'status');
  holder.classList.add('has-lookup');
  holder.prepend(card);

  let timer = null;
  let asked = 0;

  const show = async () => {
    const value = input.value.trim();
    const ticket = (asked += 1);
    if (
      !value ||
      (spec.skip ?? []).includes(value) ||
      validateValue(field.rules, value, field)
    ) {
      card.hidden = true;

      return;
    }

    card.hidden = false;
    card.className = 'lookup pending';
    card.replaceChildren(span('lookup-title', 'Looking it up…'));

    try {
      const found = await lookupValue(spec, value);
      if (ticket !== asked) {
        return;
      }
      card.className = 'lookup found';
      card.replaceChildren(span('lookup-title', found.title));
      if (found.detail) {
        card.append(span('lookup-detail', found.detail));
      }
      if (found.dates) {
        card.append(span('lookup-dates', found.dates));
      }
    } catch (error) {
      if (ticket !== asked) {
        return;
      }
      card.className = `lookup ${error.missing ? 'missing' : 'failed'}`;
      card.replaceChildren(span('lookup-title', error.message));
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(show, LOOKUP_DEBOUNCE_MS);
  });
  input.addEventListener('focus', () => void show());
  input.addEventListener('blur', () => {
    clearTimeout(timer);
    asked += 1;
    card.hidden = true;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      card.hidden = true;
    }
  });
}

function lookupValue(spec, value) {
  const key = `${spec.url}\n${value}`;
  if (!looked.has(key)) {
    const pending = resolveLookup(spec, value);
    looked.set(key, pending);
    // A network hiccup should not be remembered as the answer.
    pending.catch((error) => {
      if (!error.missing) {
        looked.delete(key);
      }
    });
  }

  return looked.get(key);
}

async function resolveLookup(spec, value) {
  const fill = (url) => url.replaceAll('{value}', encodeURIComponent(value));
  const [answer, list] = await Promise.all([
    fetchJson(fill(spec.url)),
    // The dates are a nicety; failing to get them must not hide the name.
    spec.span ? fetchJson(fill(spec.span.url)).catch(() => null) : null,
  ]);

  const flat = flatten(answer);
  const title = flat ? renderSummary(spec.title, flat) : '';
  if (!title) {
    throw Object.assign(new Error(spec.missing ?? 'Nothing found for that'), {
      missing: true,
    });
  }

  return {
    title,
    detail: spec.detail ? renderSummary(spec.detail, flat) : '',
    dates: dateSpan(list, spec.span),
  };
}

async function fetchJson(url) {
  const host = /^https?:\/\/([^/:]+)/.exec(url)?.[1] ?? 'the server';
  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new Error(`Could not reach ${host} to check`);
  }
  if (!response.ok) {
    throw new Error(`${host} answered ${response.status}`);
  }
  const text = await response.text();

  // An empty body is how some APIs say "no such thing".
  try {
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The top level of an answer, as the strings a template reads. */
function flatten(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(answer)
      .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
      .map(([key, item]) => [key, String(item)]),
  );
}

/**
 * The first and last date in a list, in the reader's own format.
 *
 * `Intl` with no locale is whatever the system is set to, so this reads
 * `4–14 Sept 2025` for one person and `Sep 4 – 14, 2025` for another without
 * either of them being wrong.
 */
function dateSpan(list, spec) {
  if (!spec || !Array.isArray(list)) {
    return '';
  }
  const scale = spec.unit === 'seconds' ? 1000 : 1;
  const times = list
    .map((item) => Number(item?.[spec.field]) * scale)
    .filter((time) => Number.isFinite(time) && time > 0);
  if (times.length === 0) {
    return '';
  }

  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const from = Math.min(...times);
  const to = Math.max(...times);

  return `${spec.label}: ${format.formatRange(from, to)}`;
}

function makeControl(field, value, secretLength, id) {
  if (field.type === 'boolean') {
    const group = document.createElement('div');
    group.className = 'switch';
    const on = truthy(value || field.fallback || '');
    for (const [label, raw] of [
      ['On', '1'],
      ['Off', '0'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.dataset.value = raw;
      button.setAttribute('aria-pressed', String(on === (raw === '1')));
      group.append(button);
    }
    group.id = id;

    return group;
  }

  if (field.type === 'select') {
    const select = document.createElement('select');
    select.id = id;
    for (const option of field.options ?? []) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.hint ? `${option.label} — ${option.hint}` : option.label;
      node.selected = (value || field.fallback) === option.value;
      select.append(node);
    }

    return select;
  }

  const input = document.createElement('input');
  input.id = id;
  input.type =
    field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text';
  input.placeholder = secretLength
    ? `set, ${secretLength} characters — leave empty to keep`
    : (field.placeholder ?? field.fallback ?? '');
  if (field.type !== 'secret') {
    input.value = value;
  }

  return input;
}

function wire(control, onInput) {
  if (control.classList.contains('switch')) {
    control.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) {
        return;
      }
      for (const other of control.children) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      onInput(button.dataset.value);
    });

    return;
  }

  const event = control.tagName === 'SELECT' ? 'change' : 'input';
  control.addEventListener(event, () => onInput(control.value));
}

// --- what has changed ------------------------------------------------------------

function editKey(section, field, where) {
  return where.index === undefined
    ? `${section.file}|${where.header ? 'header:' : ''}${field.key}`
    : `${section.file}|entry`;
}

function record(section, field, value, where) {
  if (where.index !== undefined) {
    const entries = listEdits(section);
    entries[where.index] = { ...entries[where.index], [field.key]: value };
    setListEdit(section, entries);

    return;
  }

  const key = editKey(section, field, where);
  const before = savedValue(section, field, where);
  if (value === before) {
    state.edits.delete(key);

    return;
  }
  state.edits.set(key, { section, field, value, header: Boolean(where.header) });
}

function savedValue(section, field, where) {
  const raw = state.saved.sections[section.file];
  const bag = where.header && !Array.isArray(raw) ? (raw?.header ?? {}) : raw;
  const value = bag?.[field.key];
  if (typeof value === 'string') {
    return value;
  }

  // A secret reads back as a description, so "unchanged" is the empty box.
  return '';
}

function listEdits(section) {
  const key = `${section.file}|entry`;
  const held = state.edits.get(key);
  if (held) {
    return held.entries.map((entry) => ({ ...entry }));
  }
  const raw = state.saved.sections[section.file];

  return (Array.isArray(raw) ? raw : (raw?.entries ?? [])).map((entry) => ({ ...entry }));
}

function setListEdit(section, entries) {
  state.edits.set(`${section.file}|entry`, { section, entries, list: true });
  renderSaveBar();
}

function refreshSummary(section, where) {
  const entry = listEdits(section)[where.index] ?? {};
  where.summary.firstElementChild.textContent =
    renderSummary(section.summary, entry) || `entry ${where.index + 1}`;
}

function renderSaveBar() {
  const count = state.edits.size;
  const bad = state.errors.size;
  ui.savebar.hidden = count === 0 && bad === 0;
  ui.save.disabled = bad > 0 || count === 0;
  ui.savebarText.textContent = bad
    ? [...state.errors.values()][0]
    : `${count} ${count === 1 ? 'change' : 'changes'}`;
  ui.savebar.classList.toggle('bad', bad > 0);
}

// --- saving ---------------------------------------------------------------------

ui.save.addEventListener('click', async () => {
  const app = current();
  const bySection = new Map();

  for (const edit of state.edits.values()) {
    const file = edit.section.file;
    const bucket = bySection.get(file) ?? { section: edit.section };
    if (edit.list) {
      bucket.entries = edit.entries;
    } else if (edit.header) {
      bucket.header = { ...bucket.header, [edit.field.key]: edit.value };
    } else {
      bucket.values = { ...bucket.values, [edit.field.key]: edit.value };
    }
    bySection.set(file, bucket);
  }

  ui.save.disabled = true;
  try {
    let restart = false;
    for (const [file, bucket] of bySection) {
      const body =
        bucket.section.kind === 'env'
          ? { section: file, values: bucket.values ?? {} }
          : {
              section: file,
              entries: bucket.entries ?? listEdits(bucket.section),
              ...(bucket.header ? { header: bucket.header } : {}),
            };
      const result = await api(
        'PUT',
        `/apps/${encodeURIComponent(app.name)}/config`,
        body,
      );
      restart ||= result.restartRequired;
    }

    state.edits.clear();
    state.errors.clear();
    state.saved = await api('GET', `/apps/${encodeURIComponent(app.name)}/config`);
    renderSections();
    renderSaveBar();
    flash(restart && app.supervised ? 'Saved. Restart the app to pick it up.' : 'Saved.');
  } catch (error) {
    flash(error.message, true);
    ui.save.disabled = false;
  }
});

ui.discard.addEventListener('click', () => {
  state.edits.clear();
  state.errors.clear();
  renderSections();
  renderSaveBar();
});

ui.pin.addEventListener('click', () =>
  act(`/pin/${encodeURIComponent(state.selected)}`, 'POST', 'On screen'),
);
ui.restart.addEventListener('click', () =>
  act(`/apps/${encodeURIComponent(state.selected)}/restart`, 'POST', 'Restarted'),
);
ui.unpin.addEventListener('click', () => act('/pin', 'DELETE', 'Back to the policy'));

async function act(path, method, message) {
  try {
    await api(method, path);
    await poll();
    flash(message);
  } catch (error) {
    flash(error.message, true);
  }
}

// --- palette ---------------------------------------------------------------------

let paletteItems = [];
let paletteAt = 0;

function openPalette() {
  paletteItems = [];
  for (const app of state.apps) {
    paletteItems.push({ label: app.name, where: 'app', run: () => select(app.name) });
    for (const section of app.spec.sections) {
      for (const field of section.fields) {
        paletteItems.push({
          label: field.label,
          where: `${app.name} · ${section.file}`,
          run: () => select(app.name),
        });
      }
    }
  }
  ui.palette.hidden = false;
  ui.paletteInput.value = '';
  ui.paletteInput.focus();
  renderPalette('');
}

function renderPalette(query) {
  const needle = query.trim().toLowerCase();
  const hits = paletteItems
    .filter(
      (item) => !needle || `${item.label} ${item.where}`.toLowerCase().includes(needle),
    )
    .slice(0, 40);
  paletteAt = 0;

  ui.paletteList.replaceChildren(
    ...hits.map((item, index) => {
      const li = document.createElement('li');
      li.setAttribute('aria-selected', String(index === 0));
      li.append(span('', item.label), span('where', item.where));
      li.addEventListener('click', () => {
        closePalette();
        item.run();
      });
      return li;
    }),
  );
  ui.paletteList.hits = hits;
}

function closePalette() {
  ui.palette.hidden = true;
}

ui.paletteInput.addEventListener('input', () => renderPalette(ui.paletteInput.value));
ui.paletteInput.addEventListener('keydown', (event) => {
  const items = [...ui.paletteList.children];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    paletteAt = Math.max(
      0,
      Math.min(items.length - 1, paletteAt + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    items.forEach((li, index) =>
      li.setAttribute('aria-selected', String(index === paletteAt)),
    );
    items[paletteAt]?.scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'Enter') {
    items[paletteAt]?.click();
  }
  if (event.key === 'Escape') {
    closePalette();
  }
});

el('open-palette').addEventListener('click', openPalette);
ui.palette.addEventListener('click', (event) => {
  if (event.target === ui.palette) {
    closePalette();
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (ui.palette.hidden) {
      openPalette();
    } else {
      closePalette();
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!ui.save.disabled) {
      ui.save.click();
    }
  }
});

window.addEventListener('beforeunload', (event) => {
  if (state.edits.size > 0) {
    event.preventDefault();
  }
});

// --- odds and ends ---------------------------------------------------------------

/**
 * The tuning nobody changes on a normal day, folded away until asked for — and
 * built only then, so a section with nine settings still opens as three.
 */
function note(text) {
  const p = document.createElement('p');
  p.className = 'muted small';
  p.style.padding = '0.8rem 1.1rem';
  p.textContent = text;

  return p;
}

let toastTimer = null;

function flash(message, bad = false) {
  ui.toast.textContent = message;
  ui.toast.className = `toast ${bad ? 'bad' : ''}`;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      ui.toast.hidden = true;
    },
    bad ? 6000 : 2600,
  );
}

function truthy(value) {
  return value === '1' || /^(true|yes|on)$/i.test(value);
}

// --- stopping and removing an app ---------------------------------------------------

ui.stop.addEventListener('click', () =>
  act(`/apps/${encodeURIComponent(state.selected)}/stop`, 'POST', 'Stopped'),
);

function openRemover() {
  const app = current();
  if (!app) {
    return;
  }
  ui.removerText.textContent = `${app.name} will be stopped and taken out of wm.config.json.`;
  ui.removerUninstallRow.hidden = !app.installed;
  ui.removerUninstall.checked = app.installed;
  ui.removerUninstallText.textContent = `Also uninstall ${app.packageName}`;
  ui.removerNote.textContent = `Its settings in ${app.name}/ are kept, so adding it again picks them back up.`;
  ui.removerGo.disabled = false;
  ui.removerGo.textContent = `Remove ${app.name}`;
  ui.remover.hidden = false;
  // Cancel first: the destructive choice should take a deliberate move.
  ui.removerCancel.focus();
}

function closeRemover() {
  ui.remover.hidden = true;
}

ui.remove.addEventListener('click', openRemover);
ui.removerCancel.addEventListener('click', closeRemover);
ui.remover.addEventListener('click', (event) => {
  if (event.target === ui.remover) {
    closeRemover();
  }
});
ui.remover.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeRemover();
  }
});

ui.removerGo.addEventListener('click', async () => {
  const app = current();
  if (!app) {
    return;
  }
  ui.removerGo.disabled = true;
  ui.removerGo.textContent = 'Removing…';
  const uninstall = ui.removerUninstall.checked && app.installed;

  try {
    const result = await api(
      'DELETE',
      `/apps/${encodeURIComponent(app.name)}${uninstall ? '?uninstall=1' : ''}`,
    );
    closeRemover();
    flash(
      result.uninstalled
        ? `Removed ${app.name} and uninstalled ${result.uninstalled}`
        : `Removed ${app.name}`,
    );
    state.selected = null;
    state.edits.clear();
    state.errors.clear();
    renderSaveBar();
    ui.appView.hidden = true;
    ui.empty.hidden = false;
    await poll();
  } catch (error) {
    flash(error.message, true);
    ui.removerGo.disabled = false;
    ui.removerGo.textContent = `Remove ${app.name}`;
  }
});

// --- adding an app ------------------------------------------------------------------

const installer = {
  packages: [],
  loaded: false,
  loading: null,
  busy: false,
  nameTouched: false,
};

function openInstaller() {
  ui.installer.hidden = false;
  ui.installerSearch.value = '';
  ui.installerSearch.focus();
  renderCatalog();
  void loadCatalog();
}

function closeInstaller() {
  ui.installer.hidden = true;
}

async function loadCatalog() {
  if (installer.loaded || installer.loading) {
    return;
  }
  ui.installerList.replaceChildren(note('Asking npm what there is…'));
  installer.loading = api('GET', '/catalog')
    .then(({ packages }) => {
      installer.packages = packages;
      installer.loaded = true;
      renderCatalog();
    })
    .catch((error) => {
      ui.installerList.replaceChildren(
        note(`${error.message}. You can still install by package name below.`),
      );
    })
    .finally(() => {
      installer.loading = null;
    });
  await installer.loading;
}

function renderCatalog() {
  if (!installer.loaded) {
    return;
  }
  const needle = ui.installerSearch.value.trim().toLowerCase();
  const hits = installer.packages.filter(
    (entry) =>
      !needle ||
      `${entry.packageName} ${entry.description}`.toLowerCase().includes(needle),
  );

  if (hits.length === 0) {
    ui.installerList.replaceChildren(
      note(
        needle
          ? 'Nothing on npm matches. Type the package name below to install it anyway.'
          : 'npm has no BUSY Bar apps listed right now.',
      ),
    );

    return;
  }

  ui.installerList.replaceChildren(
    ...hits.map((entry) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'catalog-item';
      button.disabled = entry.added;
      button.setAttribute(
        'aria-pressed',
        String(ui.installerPackage.value === entry.packageName),
      );

      const head = document.createElement('span');
      head.className = 'catalog-head';
      head.append(
        span('catalog-name', entry.packageName),
        span('mono muted', entry.version),
      );
      if (entry.added) {
        head.append(span('badge', 'added'));
      } else if (entry.installed) {
        head.append(span('badge', 'installed'));
      }
      button.append(head, span('catalog-text', entry.description || 'No description'));
      button.addEventListener('click', () => {
        ui.installerPackage.value = entry.packageName;
        ui.installerName.value = entry.name;
        installer.nameTouched = false;
        renderCatalog();
        ui.installerGo.focus();
      });

      li.append(button);

      return li;
    }),
  );
}

/** The name follows the package until you type one of your own. */
function suggestName(packageName) {
  return packageName
    .trim()
    .replace(/^@[^/]+\//, '')
    .replace(/^busybar-/, '');
}

ui.addApp.addEventListener('click', openInstaller);
ui.installerClose.addEventListener('click', closeInstaller);
ui.installer.addEventListener('click', (event) => {
  if (event.target === ui.installer) {
    closeInstaller();
  }
});
ui.installer.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeInstaller();
  }
});
ui.installerSearch.addEventListener('input', renderCatalog);
ui.installerPackage.addEventListener('input', () => {
  if (!installer.nameTouched) {
    ui.installerName.value = suggestName(ui.installerPackage.value);
  }
  renderCatalog();
});
ui.installerName.addEventListener('input', () => {
  installer.nameTouched = ui.installerName.value.trim() !== '';
});

ui.installerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (installer.busy) {
    return;
  }
  installer.busy = true;
  setInstalling(true);
  ui.installerLog.hidden = false;
  ui.installerLog.textContent = '';

  try {
    const job = await api('POST', '/install', {
      packageName: ui.installerPackage.value.trim(),
      name: ui.installerName.value.trim(),
    });
    await follow(job.id);
  } catch (error) {
    ui.installerLog.textContent = error.message;
    flash(error.message, true);
  } finally {
    installer.busy = false;
    setInstalling(false);
  }
});

function setInstalling(on) {
  for (const control of ui.installerForm.elements) {
    control.disabled = on;
  }
  ui.installerGo.textContent = on ? 'Installing…' : 'Install';
}

/** Watches an install to the end, with npm's own words as it goes. */
async function follow(id) {
  for (;;) {
    const job = await api('GET', `/install/${encodeURIComponent(id)}`);
    ui.installerLog.textContent = job.log.slice(-60).join('\n');
    ui.installerLog.scrollTop = ui.installerLog.scrollHeight;

    if (job.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 700));
      continue;
    }

    flash(job.message, job.state === 'failed');
    if (job.state === 'done') {
      installer.loaded = false;
      closeInstaller();
      await poll();
      if (job.name && state.apps.some((app) => app.name === job.name)) {
        await select(job.name);
      }
    }

    return;
  }
}

// --- boot -------------------------------------------------------------------------

async function poll() {
  const { apps, status } = await api('GET', '/apps');
  state.apps = apps;
  state.status = status;
  renderStatus();
  renderApps();
  renderActions();
}

try {
  await poll();
  for (const problem of state.status.problems) {
    flash(problem, true);
  }
  screens.start();
  // The rail follows the Bar; the editor is left alone while you are typing.
  setInterval(() => {
    if (!document.hidden) {
      poll().catch(() => {});
    }
  }, 4000);
} catch (error) {
  ui.empty.innerHTML = '';
  ui.empty.append(
    Object.assign(document.createElement('h1'), { textContent: 'Cannot reach the deck' }),
    note(error.message),
  );
}

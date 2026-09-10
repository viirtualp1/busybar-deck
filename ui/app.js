// The very interpreter the CLI and the daemon use, served out of busybar-kit.
// Nothing about any app is known here; it all comes from the specs.
import { validateValue } from './kit/rules.js';
import { renderSummary } from './kit/summary.js';

const API = '/deck/api';

const el = (id) => document.getElementById(id);
const ui = {
  front: el('front'),
  back: el('back'),
  nowApp: el('now-app'),
  unpin: el('unpin'),
  appList: el('app-list'),
  empty: el('empty'),
  appView: el('app-view'),
  appName: el('app-name'),
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
  const on = status.wm.connected;
  ui.nowApp.textContent = status.onScreen ?? (on ? 'nobody' : 'unknown');
  ui.unpin.hidden = !status.pinned;
}

function renderApps() {
  const fragment = document.createDocumentFragment();

  for (const app of state.apps) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'app-item';
    button.classList.toggle('running', app.running);
    button.classList.toggle('on-screen', app.onScreen);
    button.setAttribute('aria-current', String(app.name === state.selected));

    button.append(
      span('state', ''),
      span('name', app.name),
      app.pinned ? span('badge', 'held') : span('rank', String(app.rank)),
    );
    button.addEventListener('click', () => select(app.name));
    li.append(button);
    fragment.append(li);
  }

  ui.appList.replaceChildren(fragment);
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
  ui.pin.hidden = !app.running;
  ui.pin.disabled = !wm;
  ui.restart.disabled = !wm || !app.supervised;
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
  const entries = Array.isArray(raw) ? raw : (raw?.entries ?? []);
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
  add.className = 'more';
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

  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = field.label;
  row.append(label);

  if (field.hint) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = field.hint;
    row.append(hint);
  }

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
  row.append(holder, error);

  return row;
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

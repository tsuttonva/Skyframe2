// Accounts, private saved scenarios and read-only share links.
// Talks to the atc-explorer Cloudflare Worker (atc/worker). The app works fully
// without it: if the API is unreachable you just can't save or open shares.
import { defaultSettings } from './core.js';

const PROD_API = 'https://atc-explorer-worker.tom-tsutton.workers.dev';
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const params = new URLSearchParams(location.search);
// Local development only: ?api=http://localhost:8787 points at `wrangler dev`.
const API = (isLocal && params.get('api')) || PROD_API;
const SHARE_TOKEN = params.get('s');

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

let app;                 // { getSettings, applySettings, snapshot, setOnChange }
let session = store.get('atc_session'); // { username, token }
let scenarios = [];
let currentId = null;    // scenario loaded in the editor, if any
let dirty = false;
let shared = null;       // payload when viewing a share link

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Authorization: 'Bearer ' + session.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('Could not reach the scenario service. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && session && path !== '/login' && path !== '/password') { signOut(); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  if (data.scenarios) scenarios = data.scenarios;
  return data;
}
const current = () => scenarios.find(s => s.id === currentId) || null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const persist = () => { if (!SHARE_TOKEN) store.set('atc_working', { settings: app.getSettings(), id: currentId, dirty }); };
function signOut() {
  session = null; scenarios = []; currentId = null; dirty = false;
  store.set('atc_session', null);
  persist(); renderBar();
}

// ---------- dialogs
const dlg = () => $('dlg');
function openDialog(build) {
  const d = dlg(); d.replaceChildren(); build(d);
  if (!d.open) d.showModal();
}
const closeDialog = () => dlg().close();
const cancelBtn = (label = 'Cancel') => el('button', { type: 'button', className: 'btn', textContent: label, onclick: closeDialog });

function authDialog(mode = 'in', after) {
  openDialog(d => {
    const err = el('div', { className: 'err' });
    const user = el('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 24 });
    const pass = el('input', { type: 'password', autocomplete: mode === 'in' ? 'current-password' : 'new-password', maxLength: 200 });
    const go = el('button', { type: 'submit', className: 'btn primary', textContent: mode === 'in' ? 'Sign in' : 'Create account' });
    const form = el('form', { method: 'dialog' },
      el('div', { className: 'tabs' },
        el('button', { type: 'button', className: 'btn' + (mode === 'in' ? ' on' : ''), textContent: 'Sign in', onclick: () => authDialog('in', after) }),
        el('button', { type: 'button', className: 'btn' + (mode === 'up' ? ' on' : ''), textContent: 'Create account', onclick: () => authDialog('up', after) })),
      el('label', { textContent: 'Username' }), user,
      el('label', { textContent: mode === 'in' ? 'Password' : 'Password (8+ characters)' }), pass,
      err,
      el('div', { className: 'msg', textContent: mode === 'up'
        ? 'No email needed. There is no password reset, so write it down. Your scenarios are private unless you create a share link.'
        : 'Sign in to save scenarios and create share links.' }),
      el('div', { className: 'row' }, cancelBtn(), go));
    form.onsubmit = async e => {
      e.preventDefault(); err.textContent = ''; go.disabled = true;
      try {
        const data = await api('POST', mode === 'in' ? '/login' : '/signup', { username: user.value, password: pass.value });
        session = { username: data.username, token: data.token };
        store.set('atc_session', session);
        closeDialog(); renderBar();
        toast(`Signed in as ${data.username}`);
        if (after) after();
      } catch (ex) { err.textContent = ex.message; go.disabled = false; }
    };
    d.append(el('h2', { textContent: mode === 'in' ? 'Sign in' : 'Create an account' }), form);
    setTimeout(() => user.focus(), 0);
  });
}

function nameDialog(title, initial, onSave) {
  openDialog(d => {
    const err = el('div', { className: 'err' });
    const name = el('input', { type: 'text', value: initial || '', maxLength: 80 });
    const go = el('button', { type: 'submit', className: 'btn primary', textContent: 'Save' });
    const form = el('form', { method: 'dialog' }, el('label', { textContent: 'Scenario name' }), name, err,
      el('div', { className: 'row' }, cancelBtn(), go));
    form.onsubmit = async e => {
      e.preventDefault(); err.textContent = '';
      if (!name.value.trim()) { err.textContent = 'Give the scenario a name.'; return; }
      go.disabled = true;
      try { await onSave(name.value.trim()); closeDialog(); } catch (ex) { err.textContent = ex.message; go.disabled = false; }
    };
    d.append(el('h2', { textContent: title }), form);
    setTimeout(() => { name.focus(); name.select(); }, 0);
  });
}

const shareUrl = token => `${location.origin}${location.pathname}?s=${token}`;
function shareDialog() {
  const s = current(); if (!s) return;
  openDialog(d => {
    const err = el('div', { className: 'err' });
    d.append(el('h2', { textContent: `Share “${s.name}”` }));
    if (s.share) {
      const link = el('input', { type: 'text', readOnly: true, value: shareUrl(s.share.token) });
      link.onfocus = () => link.select();
      d.append(el('label', { textContent: 'Anyone with this link can view this scenario (read-only)' }), link,
        el('div', { className: 'msg', textContent: `Created ${s.share.created.slice(0, 10)}${s.share.snapshot ? `, with data as of ${s.share.snapshot}` : ''}. The link never expires, and always shows the scenario as you last saved it, scored against the latest data. Revoke it to turn it off.` }),
        err,
        el('div', { className: 'row' },
          el('button', { type: 'button', className: 'btn danger', textContent: 'Revoke link', onclick: async e => {
            e.target.disabled = true;
            try { await api('DELETE', `/scenarios/${s.id}/share`); renderBar(); toast('Share link revoked'); closeDialog(); }
            catch (ex) { err.textContent = ex.message; e.target.disabled = false; }
          } }),
          el('button', { type: 'button', className: 'btn primary', textContent: 'Copy link', onclick: async () => {
            try { await navigator.clipboard.writeText(link.value); toast('Link copied'); } catch { link.focus(); link.select(); }
          } }),
          cancelBtn('Done')));
    } else {
      d.append(el('div', { className: 'msg', textContent: 'This scenario is private. Creating a link lets anyone who has the link see its weights, filters, table, map and scores, read-only. They cannot see your other scenarios or change this one. You can revoke the link at any time.' }),
        dirty ? el('div', { className: 'msg', textContent: 'You have unsaved changes. The link shows the last saved version.' }) : '',
        err,
        el('div', { className: 'row' }, cancelBtn(),
          el('button', { type: 'button', className: 'btn primary', textContent: 'Create share link', onclick: async e => {
            e.target.disabled = true;
            try { await api('POST', `/scenarios/${s.id}/share`, { snapshot: app.snapshot }); renderBar(); shareDialog(); }
            catch (ex) { err.textContent = ex.message; e.target.disabled = false; }
          } })));
    }
  });
}

function confirmDialog(text, okLabel, onOk) {
  openDialog(d => {
    const err = el('div', { className: 'err' });
    d.append(el('h2', { textContent: text }), err, el('div', { className: 'row' }, cancelBtn(),
      el('button', { type: 'button', className: 'btn danger', textContent: okLabel, onclick: async e => {
        e.target.disabled = true;
        try { await onOk(); closeDialog(); } catch (ex) { err.textContent = ex.message; e.target.disabled = false; }
      } })));
  });
}

// ---------- actions
async function saveAs(name) {
  const data = await api('POST', '/scenarios', { name, settings: app.getSettings() });
  currentId = data.id; dirty = false; persist(); renderBar(); toast(`Saved “${name}”`);
}
async function save() {
  const s = current();
  if (!s) return nameDialog('Save scenario as', '', saveAs);
  try {
    await api('PUT', `/scenarios/${s.id}`, { name: s.name, settings: app.getSettings() });
    dirty = false; persist(); renderBar(); toast(`Saved “${s.name}”`);
  } catch (ex) { toast(ex.message); }
}
function load(id) {
  currentId = id || null;
  const s = current();
  app.applySettings(s ? s.settings : defaultSettings());
  dirty = false; persist(); renderBar();
}

// ---------- header bar
function renderBar() {
  const bar = $('scnbar'); bar.replaceChildren();
  const btn = (label, onclick, cls = '') => el('button', { type: 'button', className: 'btn ' + cls, textContent: label, onclick });
  if (!session) {
    bar.append(btn(shared ? 'Sign in to save a copy' : 'Sign in to save scenarios', () => authDialog('in', shared ? null : refresh)));
    return;
  }
  if (shared) {
    bar.append(btn('Save a copy to my scenarios', () => nameDialog('Save a copy as', shared.name, async name => {
      await api('POST', '/scenarios', { name, settings: app.getSettings() }); toast(`Saved “${name}” to your scenarios`);
    }), 'primary'));
  } else {
    const sel = el('select', { title: 'Your saved scenarios', onchange: () => {
      const next = sel.value;
      if (dirty && current()) {
        sel.value = currentId;
        confirmDialog(`Discard unsaved changes to “${current().name}”?`, 'Discard', async () => load(next));
      } else load(next);
    } });
    sel.append(el('option', { value: '', textContent: scenarios.length ? '— not saved —' : '— no saved scenarios —' }));
    for (const s of scenarios) sel.append(el('option', { value: s.id, textContent: s.name + (s.share ? ' (shared)' : '') }));
    sel.value = currentId || '';
    const s = current();
    bar.append(sel);
    if (s && dirty) bar.append(el('span', { className: 'dirty', textContent: 'unsaved changes' }));
    bar.append(btn('Save', save, s && dirty ? 'primary' : ''), btn('Save as…', () => nameDialog('Save scenario as', s ? s.name + ' copy' : '', saveAs)));
    if (s) {
      bar.append(btn(s.share ? 'Share link…' : 'Share…', shareDialog),
        btn('Rename', () => nameDialog('Rename scenario', s.name, async name => { await api('PUT', `/scenarios/${s.id}`, { name, settings: s.settings }); renderBar(); })),
        btn('Delete', () => confirmDialog(`Delete “${s.name}”?${s.share ? ' Its share link will stop working.' : ''}`, 'Delete', async () => {
          await api('DELETE', `/scenarios/${s.id}`); currentId = null; dirty = false; persist(); renderBar(); toast('Scenario deleted');
        }), 'danger'));
    }
  }
  bar.append(el('span', { className: 'who', textContent: session.username }), btn('Sign out', signOut));
}

async function refresh() {
  if (!session) return;
  try { await api('GET', '/scenarios'); } catch (ex) { if (session) toast(ex.message); }
  renderBar();
}

function renderShareBar(note) {
  const bar = $('sharebar'); bar.style.display = 'flex'; bar.replaceChildren();
  if (!shared) { bar.append(el('span', { textContent: note }), el('a', { className: 'btn', href: location.pathname, textContent: 'Open the explorer' })); return; }
  const moved = shared.snapshot && shared.snapshot !== app.snapshot;
  bar.append(
    el('span', {}, 'Shared scenario ', el('b', { textContent: shared.name }), ` by ${shared.owner}`),
    el('span', { className: 'meta', textContent: `Read-only. Shared ${shared.shared.slice(0, 10)}${shared.snapshot ? ` with data as of ${shared.snapshot}` : ''}. ` +
      (moved ? `Scores below use the current data (${app.snapshot}), so they can differ from that day.` : `Scores use data as of ${app.snapshot}.`) +
      ' You can explore, but changes here are not saved to the original.' }),
    el('button', { type: 'button', className: 'btn', textContent: 'Reset to shared settings', onclick: () => app.applySettings(shared.settings) }),
    el('a', { className: 'btn', href: location.pathname, textContent: 'Open my own view' }));
}

export async function initCloud(a) {
  app = a;
  if (SHARE_TOKEN) {
    renderBar();
    try {
      shared = await api('GET', '/s/' + encodeURIComponent(SHARE_TOKEN));
      app.applySettings(shared.settings);
      document.title = `${shared.name} · ATC Landing Spots`;
      renderShareBar();
    } catch (ex) { renderShareBar(ex.message); }
    renderBar();
    return;
  }
  // Your own view: restore the working settings from this browser, then track edits.
  const working = store.get('atc_working');
  if (working) { app.applySettings(working.settings); currentId = working.id || null; dirty = !!working.dirty; }
  app.setOnChange(() => {
    const s = current();
    dirty = s ? !same(app.getSettings(), s.settings) : false;
    persist(); renderBar();
  });
  renderBar();
  await refresh();
  if (currentId && !current()) { currentId = null; dirty = false; renderBar(); }
}

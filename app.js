/* global Aether */
const A = Aether;

// ---------- storage: whole library as one IndexedDB record, localStorage fallback ----------
// ponytail: rewrites the whole library per save; fine for thousands of stories, split stores if it ever lags.
const DB_KEY = 'aetherstory';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_KEY, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
// Reads `key`, or writes it when a value is given.
async function kv(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const q = value === undefined ? t.objectStore('kv').get(key) : t.objectStore('kv').put(value, key);
    t.oncomplete = () => res(q.result);
    t.onerror = () => rej(t.error);
  });
}
const lsName = (key) => (key === 'state' ? DB_KEY : DB_KEY + '-key');
async function get(key) {
  try { return await kv(key); } catch (e) {
    const v = localStorage.getItem(lsName(key));
    try { return JSON.parse(v); } catch (e2) { return v; } // older fallback stored the device key unquoted
  }
}
// App lock: while it's on, every record is sealed with a key derived from the passcode. Only kept in memory, never stored.
let lockKey = null, lockSalt = null;
async function put(key, value) {
  const rec = lockKey ? await A.seal(value, lockKey, lockSalt) : value;
  try { await kv(key, rec); } catch (e) { localStorage.setItem(lsName(key), JSON.stringify(rec)); }
}
const unsealed = async (rec) => (A.isLocked(rec) ? A.unseal(rec, lockKey) : rec);
// This device's backup key, made on first use. Kept outside the library so it never ends up inside a backup.
let devKey = null;
const deviceKey = () => devKey || (devKey = (async () => {
  let k = await unsealed(await get('deviceKey'));
  if (!k) await put('deviceKey', k = A.newKey());
  return k;
})());
async function save() {
  try { await put('state', JSON.parse(JSON.stringify(state))); } catch (e) { alert('Could not save: ' + e.message + '\nExport your library from Settings.'); }
}
// Re-seal both records under the new lock (or none).
async function setLock(passcode) {
  const dk = await deviceKey();
  lockSalt = passcode ? A.newSalt() : null;
  lockKey = passcode ? await A.deriveKey(passcode, lockSalt) : null;
  await put('deviceKey', dk);
  await save();
}

// ---------- AI ----------
// Free models are often busy or rate limited: retry a couple of times before giving up, unless text already streamed in.
async function chat(messages, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    let got = false;
    try { return await chatOnce(messages, { ...opts, onToken: opts.onToken && ((t) => { got = true; opts.onToken(t); }) }); } catch (e) {
      if (!e.retry || got || attempt >= 2 || (opts.signal && opts.signal.aborted)) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
}
async function chatOnce(messages, { onToken, signal, stream = true } = {}) {
  // A world can use its own key and model, so its stories run on a separate account.
  const ai = state.world.ai || {};
  const s = { ...state.settings, ...(ai.apiKey ? { apiKey: ai.apiKey } : {}), ...(ai.model ? { model: ai.model } : {}) };
  if (!s.baseUrl || !s.model) throw new Error('Set an AI provider and model in Settings first.');
  const headers = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = 'Bearer ' + s.apiKey;
  const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', headers, signal,
    // Private mode: OpenRouter only routes to providers that don't store or train on prompts.
    body: JSON.stringify({ model: s.model, models: A.freeFallbacks(s.baseUrl, s.model) || undefined, messages, temperature: Number(s.temperature) || 0.9, stream,
      ...(s.privateOnly && s.baseUrl.includes('openrouter.ai') ? { provider: { data_collection: 'deny' } } : {}) }),
  });
  if (!res.ok) {
    const msg = `AI request failed (${res.status}): ${(await res.text()).slice(0, 300)}`;
    const err = new Error(s.privateOnly && res.status === 404 ? msg + '\nPrivate mode is on and no private provider serves this model. Pick a paid model in Advanced mode, or turn Private mode off.' : msg);
    err.retry = res.status === 429 || res.status >= 500;
    throw err;
  }
  if (!stream || !(res.headers.get('content-type') || '').includes('event-stream')) {
    const d = await res.json();
    const text = A.replyText(d);
    if (onToken) onToken(text);
    return text;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const out = A.parseSSE(buf + dec.decode(value, { stream: true }));
    buf = out.rest;
    if (out.error) throw out.error;
    for (const t of out.tokens) { full += t; onToken && onToken(t); }
    if (out.done) break;
  }
  return full;
}

async function chatJson(messages) {
  return A.parseJsonLoose(await chat(messages, { stream: false }));
}

// ---------- narration: the browser's own voices, free with no setup ----------
const canSpeak = 'speechSynthesis' in window;
// Private mode keeps to voices that run on the device; some browser voices (e.g. Edge "Online", Google) send the text to their maker.
const voices = () => (canSpeak ? speechSynthesis.getVoices() : []).filter((v) => v.localService || !state.settings.privateOnly);
const NATURAL = /natural|neural|premium|enhanced/i;
// Voices in the reader's language, most natural-sounding first.
function langVoices() {
  const all = voices(), lang = (navigator.language || 'en').slice(0, 2);
  const mine = all.filter((v) => v.lang.startsWith(lang));
  return (mine.length ? mine : all).sort((a, b) => NATURAL.test(b.name) - NATURAL.test(a.name));
}
function pickVoice() {
  const all = langVoices();
  return voices().find((v) => v.voiceURI === state.settings.voice) || all.find((v) => NATURAL.test(v.name)) || all.find((v) => v.default) || all[0];
}
// A character's own voice, or one picked to match them: same gender, not the narrator's, and different from the other characters' where there are enough voices.
function characterVoice(c) {
  const chosen = voices().find((v) => v.voiceURI === c.voice);
  if (chosen) return { voice: chosen, pitch: 1 };
  const narrator = pickVoice(), g = A.characterGender(c);
  const pool = langVoices().filter((v) => v !== narrator && (!g || A.voiceGender(v.name) === g));
  const peers = state.characters.filter((x) => !x.voice && A.characterGender(x) === g);
  if (pool.length) return { voice: pool[Math.max(0, peers.findIndex((x) => x.id === c.id)) % pool.length], pitch: 1 };
  // Only the narrator's voice fits: shift its pitch so the character still sounds different.
  return { voice: narrator, pitch: g === 'm' ? 0.8 : 1.2 };
}
// The story as spoken lines: narration by the narrator (or the point-of-view character, for first person), dialogue by each speaker.
function storyLines(story) {
  const cast = state.characters.filter((c) => (story.characterIds || []).includes(c.id));
  const byId = (id) => state.characters.find((c) => c.id === id);
  return [{ text: story.title + '.', id: null }, ...A.speechParts(story.text, cast.length ? cast : state.characters)]
    .map((p) => ({ text: p.text, who: byId(p.id || story.pov) }));
}
let speaking = null; // { id, stop } of what is being read aloud
const listenLabel = (id) => (speaking && speaking.id === id ? '⏹ Stop' : '🔊 Listen');
const refreshListen = (id) => { const b = document.getElementById('listen'); if (b) b.textContent = listenLabel(id); };
// Starts reading [{ text, who }] aloud, or stops if this same thing is already playing.
function speak(id, lines) {
  const prev = speaking;
  if (prev && prev.stop) prev.stop();
  if (canSpeak) speechSynthesis.cancel();
  const me = speaking = prev && prev.id === id ? null : { id };
  refreshListen(id);
  if (me) (state.settings.ttsKey ? narratePremium : narrate)(me, lines);
}
const done = (me) => { if (speaking !== me) return; speaking = null; refreshListen(me.id); };
// Free: the browser's own voices.
function narrate(me, lines) {
  const utts = lines.flatMap((l) => {
    const v = l.who ? characterVoice(l.who) : { voice: pickVoice(), pitch: 1 };
    return A.speechChunks(l.text).map((t) => {
      const u = new SpeechSynthesisUtterance(t);
      if (v.voice) { u.voice = v.voice; u.lang = v.voice.lang; }
      u.pitch = v.pitch;
      u.rate = Number(state.settings.rate) || 1;
      return u;
    });
  });
  // cancel() fires end/error on the old queue too, so only the current reading resets the button.
  const last = utts[utts.length - 1];
  if (last) last.onend = last.onerror = () => done(me);
  utts.forEach((u) => speechSynthesis.speak(u));
}

// Paid: Venice voices with the user's own key.
const premiumNarrator = () => { const v = A.premiumVoices(state.settings.ttsModel); return [...v.f, ...v.m].includes(state.settings.ttsNarrator) ? state.settings.ttsNarrator : v.f[0]; };
function premiumCharacterVoice(c) {
  const s = state.settings, v = A.premiumVoices(s.ttsModel);
  if ([...v.f, ...v.m].includes(c.ttsVoice)) return c.ttsVoice;
  const g = A.characterGender(c), peers = state.characters.filter((x) => A.characterGender(x) === g);
  return A.premiumVoice(s.ttsModel, g, peers.findIndex((x) => x.id === c.id), premiumNarrator());
}
// Audio already paid for is kept: in memory always, and on the device unless App lock is on (the cache isn't encrypted).
// ponytail: no eviction; Erase everything clears it. Add a size cap if phones run short on space.
const audioCache = new Map();
async function premiumAudio(model, voice, text) {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${model}|${voice}|${text}`))), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = 'tts:' + hash;
  let blob = audioCache.get(key) || (!lockKey && await kv(key).catch(() => null));
  if (!blob) {
    let res;
    try {
      res = await fetch('https://api.venice.ai/api/v1/audio/speech', { method: 'POST',
        headers: { Authorization: 'Bearer ' + state.settings.ttsKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }) });
    } catch (e) { throw new Error('Could not reach Venice for premium voices. Check your connection.'); }
    if (!res.ok) throw new Error(`Premium voice request failed (${res.status}): ${(await res.text()).slice(0, 200)}${res.status === 401 ? '\nCheck your Venice API key in Settings → Narration.' : ''}`);
    blob = await res.blob();
    if (!lockKey) kv(key, blob).catch(() => {});
  }
  audioCache.set(key, blob);
  return blob;
}
const player = new Audio();
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
async function narratePremium(me, lines) {
  // Phones only let audio start from a tap: play a silent clip now so the real audio may follow once it has downloaded.
  player.src = SILENT; player.play().catch(() => {});
  const model = state.settings.ttsModel;
  const runs = A.voiceRuns(lines.map((l) => ({ text: l.text, voice: l.who ? premiumCharacterVoice(l.who) : premiumNarrator() })));
  const pending = [];
  const fetchRun = (i) => pending[i] || (pending[i] = premiumAudio(model, runs[i].voice, runs[i].text));
  try {
    for (let i = 0; i < runs.length && speaking === me; i++) {
      const blob = await fetchRun(i);
      if (runs[i + 1]) fetchRun(i + 1).catch(() => {}); // download the next part while this one plays
      if (speaking !== me) break;
      const url = URL.createObjectURL(blob);
      player.src = url;
      player.playbackRate = Number(state.settings.rate) || 1;
      await new Promise((res, rej) => {
        me.stop = () => { player.pause(); res(); };
        player.onended = res;
        player.onerror = () => rej(new Error('This device could not play the premium audio.'));
        player.play().catch(rej);
      });
      URL.revokeObjectURL(url);
    }
  } catch (e) { if (speaking === me) alert(e.message); }
  done(me);
}
const listenBtn = (story) => (canSpeak || state.settings.ttsKey) && h('button', { class: 'btn ghost', id: 'listen', onclick: () => speak(story.id, storyLines(story)) }, listenLabel(story.id));
const voiceOptions = (selected) => voices().map((v) => h('option', { value: v.voiceURI, selected: v.voiceURI === selected }, `${v.name} (${v.lang})${v.localService ? '' : ' · online'}`));

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    if (k === 'value') el.value = v;
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const download = (text, name) => {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' })), download: name });
  document.body.append(a); a.click(); a.remove();
};
// Per-world keys never travel in a backup, in either direction.
const dropWorldKeys = (data) => { for (const w of [data.world, ...data.otherWorlds.map((x) => x.world)]) w.ai = { apiKey: '', model: w.ai ? w.ai.model || '' : '' }; };
const field = (label, input) => [h('label', {}, label), input];
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const charName = (id) => (state.characters.find((c) => c.id === id) || {}).name;

// ---------- app state & routing ----------
let state = A.emptyState();
const ui = { locked: null, advanced: false, pendingImport: null, view: 'write', param: null, selected: [], premise: '', length: 'medium', pov: '', busy: false, status: '', currentId: null, abort: null, reviseText: '', revision: null, reviseLog: [] };
const TABS = [['write', '✍️', 'Write'], ['stories', '📚', 'Stories'], ['characters', '🎭', 'Cast'], ['world', '🌍', 'World'], ['revise', '🪄', 'Revise'], ['settings', '⚙️', 'Settings']];

function go(view, param = null) { ui.view = view; ui.param = param; render(); window.scrollTo(0, 0); }

function render() {
  document.getElementById('worldName').textContent = state.world.name;
  const nav = document.getElementById('nav');
  const view = document.getElementById('view');
  nav.hidden = !!ui.locked || !state.settings.ageOk;
  if (ui.locked) return view.replaceChildren(...lockScreen());
  if (!state.settings.ageOk) return view.replaceChildren(...ageGate());
  nav.replaceChildren(...TABS.map(([v, icon, label]) => h('button', { class: ui.view === v ? 'on' : '', onclick: () => go(v) }, h('span', {}, icon), label)));
  view.replaceChildren(...[VIEWS[ui.view]()].flat(Infinity).filter((n) => n && n.nodeType));
}

function setStatus(msg) { ui.status = msg; const el = document.getElementById('status'); if (el) el.textContent = msg; }

// ---------- generation ----------
async function generate(continueId) {
  if (ui.busy) return;
  const existing = continueId && state.stories.find((s) => s.id === continueId);
  const cast = ui.selected.length ? [...ui.selected] : state.characters.map((c) => c.id);
  const story = existing || { id: A.uid(), title: 'Untitled story', summary: '', characterIds: cast, pov: cast.includes(ui.pov) ? ui.pov : '', premise: ui.premise, text: '', createdAt: Date.now() };
  const messages = A.buildStoryMessages(state, { characterIds: story.characterIds, premise: ui.premise, length: ui.length, continueStory: existing, pov: story.pov });
  if (!existing) state.stories.push(story);
  else story.text += '\n\n';
  ui.busy = true; ui.currentId = story.id; ui.abort = new AbortController();
  go('write');
  setStatus('Writing…');
  const out = document.getElementById('output');
  out.textContent = story.text;
  try {
    await chat(messages, { signal: ui.abort.signal, onToken: (t) => { story.text += t; out.textContent = story.text; } });
  } catch (e) {
    if (e.name !== 'AbortError') { setStatus(e.message); if (!story.text.trim()) state.stories = state.stories.filter((s) => s !== story); finish(); return; }
  }
  story.text = story.text.trim();
  story.updatedAt = Date.now();
  await save();
  setStatus('Updating your world from this story…');
  try {
    const changes = A.applyWorldUpdate(state, story, await chatJson(A.buildWorldUpdateMessages(state, story)));
    await save();
    setStatus(changes.length ? 'World updated: ' + changes.join(', ') : 'Saved. Nothing new for the world this time.');
  } catch (e) {
    setStatus('Story saved, but the world update failed: ' + e.message);
  }
  finish();
}
function finish() { ui.busy = false; ui.abort = null; const s = ui.status; render(); setStatus(s); }

async function quickstart(vibe) {
  ui.busy = true; render(); setStatus('Dreaming up a world…');
  try {
    const added = A.applyQuickstart(state, await chatJson(A.buildQuickstartMessages(vibe)));
    ui.selected = added.map((c) => c.id);
    await save();
    ui.status = `Created ${state.world.name} with ${added.map((c) => c.name).join(', ')}. Hit Generate.`;
  } catch (e) { ui.status = e.message; }
  finish();
}

// World revision: ask for the sheet changes, then exact-text edits for each story the change touches. Nothing is saved until Apply.
// Stories of characters named in the change start right away, alongside the sheet update, a few at a time. Every step shows in ui.reviseLog.
async function planRevision(revision) {
  if (!revision || ui.busy) return;
  ui.busy = true; ui.status = '';
  const log = ui.reviseLog = [];
  const note = (label, state = 'ok', text = '') => { const e = { label, state, note: text }; log.push(e); render(); return e; };
  const set = (e, state, text) => { e.state = state; e.note = text; render(); };
  const plan = { revision, characters: [], world: {}, affected: [], stories: [], failed: [] };
  const queue = [], queued = new Set();
  const enqueue = (stories) => { for (const s of stories) if (!queued.has(s.id)) { queued.add(s.id); queue.push({ s, e: note(`Story: ${s.title}`, 'wait') }); } };
  const check = async ({ s, e }) => {
    set(e, 'run', '');
    try {
      const r = await chatJson(A.buildReviseStoryMessages(s, revision));
      const { text, applied } = A.applyEdits(s.text, r.edits);
      const summary = typeof r.summary === 'string' && r.summary.trim() !== (s.summary || '') ? r.summary.trim() : '';
      const missed = (Array.isArray(r.edits) ? r.edits.length : 0) - applied.length;
      if (applied.length || summary) plan.stories.push({ id: s.id, text, summary, edits: applied });
      set(e, 'ok', [applied.length ? `${applied.length} passage${applied.length > 1 ? 's' : ''} to fix` : 'nothing contradicts the change',
        summary && 'summary updated', missed > 0 && `${missed} suggested edit${missed > 1 ? 's' : ''} didn't match the text, skipped`].filter(Boolean).join(', '));
    } catch (err) { plan.failed.push(s.title); set(e, 'fail', err.message); }
  };
  let sheetsDone = false;
  const worker = async () => {
    while (queue.length || !sheetsDone) {
      if (queue.length) await check(queue.shift());
      else await new Promise((r) => setTimeout(r, 200));
    }
  };
  const sheet = note('Character sheets and world notes', 'run');
  const named = A.charactersNamedIn(state, revision);
  if (named.length) {
    note(`The change names ${named.map((c) => c.name).join(', ')}, so their stories are checked while the sheets update`);
    enqueue(A.storiesForRevision(state, named.map((c) => c.name)));
  }
  // ponytail: 3 at a time keeps free models under their per-minute limit; raise it for paid models if it's still slow.
  const workers = [worker(), worker(), worker()];
  try {
    Object.assign(plan, A.sheetChanges(state, await chatJson(A.buildReviseSheetMessages(state, revision))));
    const changed = plan.characters.map((pc) => `${pc.name} (${Object.keys(pc.set).join(', ')})`).concat(Object.keys(plan.world).map((k) => `world ${k}`));
    set(sheet, 'ok', changed.length ? 'changing ' + changed.join('; ') : 'nothing to change');
    const who = A.charactersNamedIn(state, plan.affected.join(' ')).map((c) => c.name);
    const targets = A.storiesForRevision(state, plan.affected);
    note(who.length ? `Checking the ${targets.length} of ${state.stories.length} stories that feature or mention ${who.join(', ')}` : `The change isn't about one character, so all ${state.stories.length} stories are checked`);
    enqueue(targets);
  } catch (err) { set(sheet, 'fail', err.message); ui.status = err.message; queue.length = 0; }
  sheetsDone = true;
  await Promise.all(workers);
  if (sheet.state === 'ok') ui.revision = plan;
  finish();
}

// ---------- views ----------
const PRESETS = {
  'OpenRouter: Nemotron 3.5 Super VL (free, default)': ['https://openrouter.ai/api/v1', 'nvidia/nemotron-3.5-super-vl:free'],
  'OpenRouter: Gemma 4 31B (free)': ['https://openrouter.ai/api/v1', 'google/gemma-4-31b-it:free'],
  'OpenRouter: Venice Uncensored (paid, under 1¢ a story)': ['https://openrouter.ai/api/v1', 'cognitivecomputations/dolphin-mistral-24b-venice-edition'],
  'OpenRouter: Euryale 70B (paid, best)': ['https://openrouter.ai/api/v1', 'sao10k/l3.3-euryale-70b'],
  'Ollama (this PC)': ['http://localhost:11434/v1', 'llama3.1'], 'LM Studio (this PC)': ['http://localhost:1234/v1', 'local-model'],
};
// Guided setup for someone who has never made an API key: three steps, one paste, then straight to writing.
function keySetup() {
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste your key here' });
  const status = h('div', { class: 'status' });
  const start = async () => {
    const k = key.value.trim();
    if (!k) { status.textContent = 'Paste your key first.'; return; }
    const d = A.emptyState().settings;
    Object.assign(state.settings, { apiKey: k, baseUrl: d.baseUrl, model: d.model });
    await save();
    status.textContent = 'Checking your key…';
    try { await chat([{ role: 'user', content: 'Say hi.' }], { stream: false }); } catch (e) { status.textContent = 'That key did not work. Check you copied all of it. (' + e.message + ')'; return; }
    ui.status = 'You are all set!'; go('write');
  };
  return [h('ol', { class: 'steps' },
    h('li', {}, 'Open ', h('a', { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener' }, 'openrouter.ai/keys'), ' and sign in. Google sign-in works, and no card is needed.'),
    h('li', {}, 'Tap ', h('b', {}, 'Create API Key'), ', name it anything (like "stories"), and tap ', h('b', {}, 'Copy'), '.'),
    h('li', {}, 'Come back here, paste it below, and tap Start.')),
    key, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: start }, 'Start')), status];
}
function lockScreen() {
  const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passcode' });
  const msg = h('div', { class: 'status' });
  const unlock = async () => {
    msg.textContent = 'Unlocking…';
    const key = await A.deriveKey(pass.value, ui.locked.salt);
    let data;
    try { data = await A.unseal(ui.locked, key); } catch (e) { msg.textContent = 'Wrong passcode.'; pass.value = ''; return; }
    lockKey = key; lockSalt = ui.locked.salt; state = A.normalizeState(data); ui.locked = null; render();
  };
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
  setTimeout(() => pass.focus());
  return [h('h2', {}, '🔒 Aetherstory is locked'), pass,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: unlock }, 'Unlock')), msg,
    h('p', { class: 'muted' }, 'Forgot your passcode? Your stories can\'t be recovered without it. You can ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); eraseAll(); } }, 'erase everything'), ' and start over, then import a backup.')];
}
function ageGate() {
  return [h('h2', {}, 'Adults only (18+)'),
    h('p', {}, 'Aetherstory writes fiction that can include explicit sexual content, violence and other mature themes. You must be at least 18 years old, or the age of majority where you live, to use it.'),
    h('p', { class: 'muted' }, 'By entering, you confirm you meet this age requirement and choose to view this kind of content.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { state.settings.ageOk = true; save(); render(); } }, 'I am 18 or older'),
      h('button', { class: 'btn ghost', onclick: () => { location.href = 'https://www.google.com'; } }, 'Leave'))];
}
const VIEWS = {
  write() {
    const story = ui.currentId && state.stories.find((s) => s.id === ui.currentId);
    const nodes = [];
    if (!state.settings.apiKey && !/localhost|127\.0\.0\.1/.test(state.settings.baseUrl)) {
      nodes.push(h('div', { class: 'card setup' }, h('h3', {}, 'First, get your free AI key'),
        h('p', {}, 'It takes about two minutes and costs nothing. You only do this once.'), keySetup()));
    }
    if (!state.characters.length) {
      const vibe = h('input', { placeholder: 'Optional: a one-line vibe, e.g. "rival witches in a rainy port city"' });
      nodes.push(h('h2', {}, 'Quick start'),
        h('p', { class: 'muted' }, 'Let the AI build a world and a starting cast for you. You can edit everything later.'),
        vibe, h('div', { class: 'row' }, h('button', { class: 'btn', disabled: ui.busy, onclick: () => quickstart(vibe.value.trim()) }, '✨ Create my world')),
        h('p', { class: 'muted' }, 'Or add your own characters in the Cast tab.'));
    } else {
      nodes.push(h('h2', {}, 'Who is in this story?'), h('p', { class: 'muted' }, 'Pick some, or none to use the whole cast.'),
        h('div', { class: 'chips' }, state.characters.map((c) => h('button', {
          class: 'chip' + (ui.selected.includes(c.id) ? ' on' : ''),
          onclick: () => { ui.selected = ui.selected.includes(c.id) ? ui.selected.filter((x) => x !== c.id) : [...ui.selected, c.id]; render(); },
        }, c.name))));
      const premise = h('textarea', { placeholder: 'Optional. Leave blank and the AI picks something that fits your world.', oninput: (e) => { ui.premise = e.target.value; } });
      premise.value = ui.premise;
      const length = h('select', { onchange: (e) => { ui.length = e.target.value; } },
        Object.entries(A.LENGTHS).map(([k, w]) => h('option', { value: k, selected: ui.length === k }, `${k[0].toUpperCase() + k.slice(1)} (~${w} words)`)));
      const castIds = ui.selected.length ? ui.selected : state.characters.map((c) => c.id);
      const pov = h('select', { onchange: (e) => { ui.pov = e.target.value; } },
        h('option', { value: '' }, 'Narrator (third person)'),
        state.characters.filter((c) => castIds.includes(c.id)).map((c) => h('option', { value: c.id, selected: ui.pov === c.id }, `${c.name} (first person)`)));
      nodes.push(...field('Premise or direction', premise), ...field('Length', length), ...field("Whose point of view?", pov),
        h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: ui.busy, onclick: () => { ui.currentId = null; generate(); } }, '✨ Generate story'),
          ui.busy && h('button', { class: 'btn ghost', onclick: () => ui.abort && ui.abort.abort() }, 'Stop')));
    }
    nodes.push(h('div', { class: 'status', id: 'status' }, ui.status));
    if (story) {
      nodes.push(h('h2', {}, story.title), h('div', { class: 'prose', id: 'output' }, story.text));
      if (!ui.busy) nodes.push(h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => generate(story.id) }, 'Continue story'),
        listenBtn(story),
        h('button', { class: 'btn ghost', onclick: () => { ui.currentId = null; ui.premise = ''; ui.status = ''; render(); } }, 'New story')),
        h('p', { class: 'muted' }, 'Continue uses the Premise box above as direction for the next part, if you fill it in.'));
    } else if (ui.busy) nodes.push(h('div', { class: 'prose', id: 'output' }));
    return nodes;
  },

  stories() {
    if (ui.param) return storyReader(state.stories.find((s) => s.id === ui.param));
    const list = [...state.stories].sort((a, b) => b.createdAt - a.createdAt);
    if (!list.length) return [h('h2', {}, 'Stories'), h('div', { class: 'empty' }, 'No stories yet. Generate one from the Write tab.')];
    return [h('h2', {}, `Stories (${list.length})`), list.map((s) => h('div', { class: 'card', onclick: () => go('stories', s.id) },
      h('h3', {}, s.title),
      h('p', {}, [fmtDate(s.createdAt), (s.characterIds || []).map(charName).filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
      s.summary && h('p', {}, s.summary)))];
  },

  characters() {
    if (ui.param) return characterEditor(ui.param === 'new' ? null : state.characters.find((c) => c.id === ui.param));
    const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const added = A.importCharacters(state, JSON.parse(await f.text()));
        if (!added.length) throw new Error('no character in it');
        await save(); ui.status = `Imported ${added.map((c) => c.name).join(', ')}.`; render();
      } catch (err) { alert('Could not read that file: ' + err.message); }
    } });
    const lib = state.library;
    return [h('h2', {}, `Cast of ${state.world.name} (${state.characters.length})`),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => go('characters', 'new') }, '+ New character'),
        h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Import character'), file),
      h('div', { class: 'status', id: 'status' }, ui.status),
      state.characters.length ? state.characters.map((c) => h('div', { class: 'card', onclick: () => go('characters', c.id) },
        h('h3', {}, c.name), h('p', {}, c.personality || c.background || ''),
        (c.developments || []).length > 0 && h('p', {}, `${c.developments.length} story developments`)))
        : h('div', { class: 'empty' }, 'No characters yet. Create one, or use Quick start on the Write tab.'),
      lib.length > 0 && [h('h2', {}, `From your other worlds (${lib.length})`),
        h('p', { class: 'muted' }, 'Bring someone in and they keep who they are. What happens to them here stays in this world.'),
        lib.map((c) => h('div', { class: 'card setup' }, h('h3', {}, c.name),
          h('p', {}, [A.worldNames(c, state).join(', '), c.personality].filter(Boolean).join(' · ')),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: async () => { A.addToWorld(state, c.id); await save(); render(); } }, `+ Add to ${state.world.name}`))))]];
  },

  world() {
    const w = state.world;
    const persist = () => { save(); document.getElementById('worldName').textContent = w.name; };
    const name = h('input', { value: w.name, oninput: (e) => { w.name = e.target.value; }, onchange: persist });
    const overview = h('textarea', { oninput: (e) => { w.overview = e.target.value; }, onchange: persist });
    overview.value = w.overview;
    const listBox = (key, label) => {
      const t = h('textarea', { rows: Math.min(12, Math.max(3, w[key].length + 1)), onchange: (e) => { w[key] = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); persist(); } });
      t.value = w[key].join('\n');
      return field(`${label} (${w[key].length}, one per line)`, t);
    };
    const ai = w.ai = w.ai || { apiKey: '', model: '' };
    const aiBox = (key, attrs) => h('input', { ...attrs, value: ai[key], onchange: (e) => { ai[key] = e.target.value.trim(); save(); } });
    const open = (id) => { A.switchWorld(state, id); Object.assign(ui, { selected: [], pov: '', currentId: null, revision: null, reviseLog: [], status: '' }); save(); go('write'); };
    return [h('h2', {}, `Worlds (${state.otherWorlds.length + 1})`),
      h('p', { class: 'muted' }, 'Each world keeps its own stories and notes, and stories only ever see the world they are written in. Characters can join any world from the Cast tab.'),
      h('div', { class: 'card setup' }, h('h3', {}, `✓ ${w.name}`), h('p', {}, `${state.stories.length} stories, ${state.characters.length} characters · open now`)),
      state.otherWorlds.map((x) => h('div', { class: 'card', onclick: () => open(x.world.id) }, h('h3', {}, x.world.name),
        h('p', {}, `${x.stories.length} stories · tap to open`),
        h('div', { class: 'row' }, h('button', { class: 'btn danger', onclick: async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete the world "${x.world.name}" and its ${x.stories.length} stories? Its characters stay in your library.`)) return;
          A.deleteWorld(state, x.world.id); await save(); render();
        } }, 'Delete')))),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => {
        const n = prompt('Name the new world (or leave blank and Quick start names it):', '');
        if (n === null) return;
        A.newWorld(state, n.trim() || 'New World'); open(state.world.id);
      } }, '+ New world')),
      h('h2', {}, 'This world'),
      h('p', { class: 'muted' }, 'This is the series bible. It grows automatically after every story, and every new story reads it. Edit freely.'),
      ...field('Name', name), ...field('Overview', overview),
      ...listBox('lore', 'Lore'), ...listBox('places', 'Places'), ...listBox('relationships', 'Relationships'), ...listBox('timeline', 'Timeline'),
      h('details', {}, h('summary', {}, 'AI key for this world (optional)'),
        h('p', { class: 'muted' }, 'Leave blank to use the key and model from Settings. Stories never see other worlds either way; a separate key just keeps this world on its own account.'),
        ...field('API key', aiBox('apiKey', { type: 'password', autocomplete: 'off', placeholder: 'Same as Settings' })),
        ...field('Model', aiBox('model', { placeholder: state.settings.model })))];
  },

  revise() {
    const plan = ui.revision;
    const nodes = [h('h2', {}, 'World revision'),
      h('p', { class: 'muted' }, 'Change a fact in plain words. The AI updates every character, the world notes and every saved story to match, and future stories follow it. You see every change before anything is saved.')];
    if (!plan) {
      const box = h('textarea', { placeholder: 'e.g. "Ana has always had red hair, not black" or "The castle burned down last winter"', oninput: (e) => { ui.reviseText = e.target.value; } });
      box.value = ui.reviseText;
      nodes.push(box, h('div', { class: 'row' }, h('button', { class: 'btn', disabled: ui.busy, onclick: () => planRevision(ui.reviseText.trim()) }, ui.busy ? 'Checking…' : '🔍 Preview changes')));
      if (ui.busy || ui.reviseLog.length) nodes.push(reviseLog(true));
    } else {
      const diff = (label, from, to) => h('div', { class: 'card setup' }, h('h3', {}, label),
        h('p', { class: 'old' }, Array.isArray(from) ? from.join('\n') : from || '(empty)'), h('p', { class: 'new' }, Array.isArray(to) ? to.join('\n') : to));
      const char = (id) => state.characters.find((c) => c.id === id) || {};
      const story = (id) => state.stories.find((s) => s.id === id) || {};
      const count = plan.characters.length + Object.keys(plan.world).length + plan.stories.length;
      nodes.push(h('p', {}, h('b', {}, `“${plan.revision}”`)),
        count ? h('p', { class: 'muted' }, 'Red is what goes, green is what replaces it.') : h('div', { class: 'empty' }, 'Nothing in your library contradicts this. Try wording it differently.'),
        plan.characters.map((pc) => Object.entries(pc.set).map(([k, v]) => diff(`${pc.name}: ${k}`, char(pc.id)[k], v))),
        Object.entries(plan.world).map(([k, v]) => diff(`World: ${k}`, state.world[k], v)),
        plan.stories.map((ps) => [ps.edits.map((e) => diff(`Story: ${story(ps.id).title}`, e.find, e.replace)),
          ps.summary && diff(`Story: ${story(ps.id).title} (summary)`, story(ps.id).summary, ps.summary)]),
        reviseLog(false),
        plan.failed.length > 0 && h('p', { class: 'muted' }, `Could not check: ${plan.failed.join(', ')}. Those stories stay as they are.`),
        h('div', { class: 'row' },
          count > 0 && h('button', { class: 'btn', onclick: async () => { A.applyRevision(state, plan); ui.revision = null; ui.reviseText = ''; await save(); ui.status = 'Revision applied.'; render(); } }, `Apply ${count} change${count > 1 ? 's' : ''}`),
          h('button', { class: 'btn ghost', onclick: () => { ui.revision = null; ui.status = ''; render(); } }, 'Discard')));
    }
    nodes.push(h('div', { class: 'status', id: 'status' }, ui.status));
    if (state.revisions.length) {
      nodes.push(h('h2', {}, 'Past revisions'), state.revisions.map((r, i) => h('div', { class: 'card setup' }, h('h3', {}, r.text), h('p', {}, fmtDate(r.at)),
        i === 0 && !plan && h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: async () => {
          if (!confirm('Undo this revision? Characters, world notes and stories go back to how they were before it.')) return;
          A.undoRevision(state); await save(); ui.status = 'Revision undone.'; render();
        } }, 'Undo')))));
    }
    return nodes;
  },

  settings() {
    const s = state.settings;
    const bind = (key, el) => { el.value = s[key]; el.addEventListener('change', () => { s[key] = el.value.trim(); save(); }); return el; };
    const base = bind('baseUrl', h('input', { placeholder: 'https://openrouter.ai/api/v1' }));
    const model = bind('model', h('input', { placeholder: 'model id' }));
    const preset = h('select', { onchange: (e) => { const p = PRESETS[e.target.value]; if (!p) return; s.baseUrl = p[0]; s.model = p[1]; save(); render(); } },
      h('option', { value: '' }, 'Pick a preset…'), Object.keys(PRESETS).map((k) => h('option', { value: k }, k)));
    const status = h('div', { class: 'status', id: 'status' });
    const test = async () => {
      status.textContent = 'Testing…';
      try { status.textContent = 'Works! Reply: ' + (await chat([{ role: 'user', content: 'Say hello in five words.' }], { stream: false })); } catch (e) { status.textContent = e.message; }
    };
    const restore = async (raw) => {
      const data = A.normalizeState(raw);
      if (!confirm(`Replace your library with this backup (${data.otherWorlds.length + 1} worlds, ${data.stories.length + data.otherWorlds.reduce((n, x) => n + x.stories.length, 0)} stories)?`)) return;
      // AI settings always stay this device's own: a crafted backup must not redirect this device's key to another server.
      for (const k of ['baseUrl', 'apiKey', 'model', 'privateOnly', 'ttsKey']) data.settings[k] = s[k];
      data.settings.ageOk = true;
      dropWorldKeys(data);
      state = data; ui.pendingImport = null; await save(); render();
    };
    const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!A.isEncrypted(j)) return await restore(j); // older, unencrypted backups still load
        let plain;
        try { plain = await A.decryptBackup(j, await deviceKey()); } catch (err) { ui.pendingImport = j; render(); return; }
        await restore(plain);
      } catch (err) { alert('Could not read that file: ' + err.message); }
    } });
    const exportLib = async () => {
      const data = JSON.parse(JSON.stringify(state));
      data.settings.apiKey = ''; data.settings.ttsKey = ''; dropWorldKeys(data);
      download(JSON.stringify(await A.encryptBackup(data, await deviceKey())), `aetherstory-${new Date().toISOString().slice(0, 10)}.json`);
    };
    // A backup from another device: ask for that device's key file (or the pasted key).
    const unlockBox = () => {
      const msg = h('div', { class: 'status' });
      const unlock = async (key) => {
        let plain;
        try { plain = await A.decryptBackup(ui.pendingImport, key); } catch (err) { msg.textContent = 'That key does not open this backup. Use the key file from the device that made it.'; return; }
        await restore(plain);
      };
      const keyFile = h('input', { type: 'file', accept: '.txt,text/plain', onchange: async (e) => { const f = e.target.files[0]; if (f) unlock(await f.text()); } });
      const pasted = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Or paste the key' });
      return h('div', { class: 'card setup' }, h('h3', {}, 'This backup was made on another device'),
        h('p', {}, 'Choose the key file you downloaded on that device (aetherstory-key.txt) to unlock it.'),
        ...field('Key file', keyFile), pasted,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => unlock(pasted.value) }, 'Unlock'), h('button', { class: 'btn ghost', onclick: () => { ui.pendingImport = null; render(); } }, 'Cancel')), msg);
    };
    const style = h('textarea', { placeholder: 'e.g. slow-burn romance, second person, lots of banter, avoid gore' });
    bind('style', style);
    const isDefault = s.model === A.emptyState().settings.model;
    return [h('h2', {}, 'AI setup'),
      s.apiKey ? [h('p', { class: 'muted' }, '✓ Key saved. ' + (isDefault ? 'Stories are written by the free default AI (Nemotron).' : `Using ${s.model} (see Advanced mode).`)),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: test }, 'Test it'))]
        : keySetup(),
      h('details', { open: ui.advanced, ontoggle: (e) => { ui.advanced = e.target.open; } }, h('summary', {}, 'Advanced mode'),
        h('p', { class: 'muted' }, 'Pick another model or any OpenAI-compatible service. Your key is stored only on this device.'),
        ...field('Preset', preset), ...field('Base URL', base), ...field('API key', bind('apiKey', h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-…' }))),
        ...field('Model', model), ...field('Creativity (temperature 0–2)', bind('temperature', h('input', { type: 'number', min: 0, max: 2, step: 0.1 }))),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: test }, 'Test connection'))),
      status,
      h('h2', {}, 'Writing style'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!s.privateOnly, onchange: (e) => { s.privateOnly = e.target.checked; save(); }, style: 'width:auto' }), ' Private mode: only use AI providers that do not store or train on my stories'),
      h('p', { class: 'muted' }, 'Your stories are sent to the AI to be written. Free models are often run by providers that may keep prompts; Private mode blocks those, so free models may stop working.'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!s.mature, onchange: (e) => { s.mature = e.target.checked; save(); }, style: 'width:auto' }), ' Mature content (18+): explicit scenes allowed'),
      h('p', { class: 'muted' }, 'Free models may still soften some scenes. Venice and Euryale (paid, in Advanced mode) follow it most reliably.'),
      ...field('Instructions applied to every story', style),
      narrationSettings(),
      h('h2', {}, 'App lock'),
      lockKey ? [h('p', { class: 'muted' }, '✓ On. Your stories, characters, world and API key are encrypted on this device. The app locks itself after 5 minutes in the background.'),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => location.reload() }, 'Lock now'),
          h('button', { class: 'btn ghost', onclick: async () => { if (!confirm('Turn off the lock? Your library will be stored unencrypted on this device.')) return; await setLock(null); render(); } }, 'Turn off'))]
        : lockSetup(),
      h('h2', {}, 'Library'),
      h('p', { class: 'muted' }, `${state.otherWorlds.length + 1} worlds, ${state.stories.length + state.otherWorlds.reduce((n, x) => n + x.stories.length, 0)} stories, ${state.characters.length + state.library.length} characters. Everything lives on this device; export to back up or move it to your phone/PC.`),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: exportLib }, 'Export backup'), h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Import backup'),
        h('button', { class: 'btn ghost', onclick: async () => download(await deviceKey(), 'aetherstory-key.txt') }, 'Download key'), file,
        h('button', { class: 'btn danger', onclick: eraseAll }, 'Erase everything')),
      h('p', { class: 'muted' }, 'Backups are encrypted (AES-256) with a key unique to this device. To open one on another device, or after clearing this browser, you also need this device\'s key file: download it once and keep it somewhere separate from your backups.'),
      ui.pendingImport && unlockBox()];
  },
};

function narrationSettings() {
  const s = state.settings;
  const set = (k) => (e) => { s[k] = e.target.value.trim(); save(); render(); };
  const free = canSpeak && !s.ttsKey && [
    ...field('Narrator voice', h('select', { onchange: (e) => { s.voice = e.target.value; save(); } },
      h('option', { value: '' }, `Automatic${pickVoice() ? ` (${pickVoice().name})` : ''}`), voiceOptions(s.voice))),
    h('p', { class: 'muted' }, 'Voices marked "online" send the story text to your browser\'s maker to be spoken; Private mode hides them. For the most natural free voices: on iPhone go to Settings → Accessibility → Read & Speak → Voices → English and download a few "Premium" or "Enhanced" voices (e.g. Ava, Zoe, Evan, Nathan), then reopen this app. On a PC, open the app in Microsoft Edge for its "Natural" voices.')];
  const v = A.premiumVoices(s.ttsModel);
  const paid = s.ttsKey && [
    ...field('Voice engine', h('select', { onchange: set('ttsModel') }, Object.entries(A.PREMIUM_VOICES).map(([id, m]) => h('option', { value: id, selected: s.ttsModel === id }, m.label)))),
    ...field('Narrator voice', h('select', { onchange: set('ttsNarrator') }, [...v.f, ...v.m].map((x) => h('option', { value: x, selected: x === premiumNarrator() }, `${x} (${v.f.includes(x) ? 'female' : 'male'})`))))];
  return [h('h2', {}, 'Narration'),
    h('p', { class: 'muted' }, 'Tap 🔊 Listen on any story to hear it read aloud. Each character speaks their lines in their own voice, picked to match them; change it on their page in the Cast tab.'),
    free, paid,
    ...field('Speed', h('select', { onchange: (e) => { s.rate = Number(e.target.value); save(); } },
      [[0.8, 'Slow'], [1, 'Normal'], [1.2, 'Fast'], [1.5, 'Faster']].map(([r, l]) => h('option', { value: r, selected: Number(s.rate) === r }, l)))),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', id: 'listen', onclick: () => speak('preview', [{ text: 'Once upon a time, in a world of your own making, a story began.' }]) }, listenLabel('preview'))),
    h('h3', {}, 'Premium voices (optional, paid)'),
    h('p', { class: 'muted' }, s.ttsKey ? '✓ On. Stories are read by Venice voices. Replaying a story is free: its audio is saved on this device (except while App lock is on). Remove the key to go back to the free voices.'
      : 'Far more natural voices through Venice, which allows adult stories. Make an API key at venice.ai (Settings → API, add a few dollars of credit) and paste it here. A medium story costs about 11¢ (or 3¢ with the cheaper engine); replaying it is free.'),
    h('p', { class: 'muted' }, 'With premium voices on, the story text is sent to Venice to be spoken.'),
    ...field('Venice API key', h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste your Venice key', value: s.ttsKey, onchange: set('ttsKey') }))];
}

// What a revision checked: live while it runs, folded away under the preview afterwards.
function reviseLog(open) {
  const icon = { wait: '○', run: '⏳', ok: '✓', fail: '✗' };
  const n = ui.reviseLog.filter((e) => e.state === 'ok' || e.state === 'fail').length;
  return h('details', { open, class: 'log' }, h('summary', {}, ui.busy ? `Checking… (${n} of ${ui.reviseLog.length} done)` : 'What was checked'),
    h('ul', { class: 'dev' }, ui.reviseLog.map((e) => h('li', { class: e.state }, `${icon[e.state]} ${e.label}`, e.note && h('span', { class: 'muted' }, ` · ${e.note}`)))));
}

function storyReader(story) {
  if (!story) return VIEWS.stories();
  return [h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => go('stories') }, '← All stories')),
    h('h2', {}, story.title),
    h('p', { class: 'muted' }, [fmtDate(story.createdAt), (story.characterIds || []).map(charName).filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
    story.summary && h('p', { class: 'muted' }, story.summary),
    canSpeak && h('div', { class: 'row' }, listenBtn(story)),
    h('div', { class: 'prose' }, story.text),
    h('div', { class: 'row' },
      h('button', { class: 'btn', disabled: ui.busy, onclick: () => { ui.premise = ''; generate(story.id); } }, 'Continue story'),
      h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Delete this story? Its effects on the world stay.')) return; if (speaking && speaking.id === story.id) speak(story.id); state.stories = state.stories.filter((s) => s !== story); await save(); go('stories'); } }, 'Delete'))];
}

function characterEditor(c) {
  const draft = Object.assign({ name: '', appearance: '', personality: '', background: '', developments: [] }, c);
  const inputs = {};
  const mk = (key, label, area) => { inputs[key] = h(area ? 'textarea' : 'input', {}); inputs[key].value = draft[key]; return field(label, inputs[key]); };
  const dev = h('textarea', { rows: 4 });
  dev.value = (draft.developments || []).join('\n');
  const idea = h('input', { placeholder: 'Optional idea, e.g. "grumpy dragon-tamer with a soft spot for strays"' });
  const status = h('div', { class: 'status' });
  const aiFill = async (e) => {
    e.target.disabled = true; status.textContent = 'Imagining…';
    try {
      const r = await chatJson(A.buildCharacterMessages(state, idea.value.trim()));
      for (const k of ['name', 'appearance', 'personality', 'background']) if (r[k]) inputs[k].value = r[k];
      status.textContent = 'Review and Save.';
    } catch (err) { status.textContent = err.message; }
    e.target.disabled = false;
  };
  const saveChar = async () => {
    const vals = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
    if (!vals.name) { status.textContent = 'A name is required.'; return; }
    const target = c || { id: A.uid(), createdAt: Date.now() };
    Object.assign(target, vals, { developments: dev.value.split('\n').map((x) => x.trim()).filter(Boolean) });
    if (!c) state.characters.push(target);
    await save(); go('characters');
  };
  // The voice picker for whichever narration is on: premium (Venice) or the browser's own.
  const pv = A.premiumVoices(state.settings.ttsModel);
  const voice = state.settings.ttsKey ? h('select', {}, h('option', { value: '' }, 'Automatic, matched to the character'), [...pv.f, ...pv.m].map((x) => h('option', { value: x, selected: x === draft.ttsVoice }, `${x} (${pv.f.includes(x) ? 'female' : 'male'})`)))
    : canSpeak && h('select', {}, h('option', { value: '' }, 'Automatic, matched to the character'), voiceOptions(draft.voice));
  if (voice) inputs[state.settings.ttsKey ? 'ttsVoice' : 'voice'] = voice;
  const hear = () => speak('voice', [{ text: `Hi, I'm ${inputs.name.value.trim() || 'new here'}.`, who: { ...draft, ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) } }]);
  const appearsIn = c ? state.stories.filter((s) => (s.characterIds || []).includes(c.id)) : [];
  return [h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => go('characters') }, '← Cast')),
    h('h2', {}, c ? c.name : 'New character'),
    !c && [idea, h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: aiFill }, '✨ Fill in with AI'))],
    ...mk('name', 'Name'), ...mk('appearance', 'Appearance', true), ...mk('personality', 'Personality', true), ...mk('background', 'Background', true),
    ...field('Story developments (added automatically, one per line)', dev),
    voice && [...field('Voice when stories are read aloud', voice), h('div', { class: 'row' }, h('button', { class: 'btn ghost', id: 'listen', onclick: hear }, listenLabel('voice')))],
    status,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: saveChar }, 'Save'),
      c && h('button', { class: 'btn ghost', onclick: () => download(JSON.stringify(A.exportCharacter(c), null, 2), `${c.name.replace(/[^\w-]+/g, '-')}.json`) }, 'Export'),
      c && A.worldNames(c, state).length > 1 && h('button', { class: 'btn ghost', onclick: async () => { A.removeFromWorld(state, c.id); ui.selected = ui.selected.filter((x) => x !== c.id); await save(); go('characters'); } }, 'Remove from this world'),
      c && h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`Delete ${c.name}${A.worldNames(c, state).length > 1 ? ' from every world' : ''}?`)) return; state.characters = state.characters.filter((x) => x !== c); ui.selected = ui.selected.filter((x) => x !== c.id); await save(); go('characters'); } }, 'Delete')),
    appearsIn.length > 0 && [h('h2', {}, 'Appears in'), appearsIn.map((s) => h('div', { class: 'card', onclick: () => go('stories', s.id) }, h('h3', {}, s.title), h('p', {}, s.summary || '')))]];
}

function lockSetup() {
  const a = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New passcode (at least 6 characters)' });
  const b = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Type it again' });
  const msg = h('div', { class: 'status' });
  const turnOn = async () => {
    if (a.value.length < 6) { msg.textContent = 'Use at least 6 characters. Longer is safer.'; return; }
    if (a.value !== b.value) { msg.textContent = 'The two passcodes don\'t match.'; return; }
    if (!confirm('If you forget this passcode, your stories cannot be recovered. Keep a backup and your key file somewhere safe. Turn on the lock?')) return;
    msg.textContent = 'Encrypting…';
    await setLock(a.value); render();
  };
  return [h('p', { class: 'muted' }, 'Encrypt your stories, characters, world and API key on this device with a passcode. Anyone opening the app, or copying the browser\'s files, sees only scrambled data.'),
    a, b, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: turnOn }, 'Turn on lock')), msg];
}

// Wipes every trace on this device: library, device key, API key, offline cache. Nothing is kept anywhere else.
async function eraseAll() {
  if (!confirm('Erase all stories, characters, your world, your API key and this device\'s backup key? This cannot be undone. Backups made with this device\'s key can only be opened with a key file you downloaded.')) return;
  await new Promise((res) => { const r = indexedDB.deleteDatabase(DB_KEY); r.onsuccess = r.onerror = r.onblocked = res; });
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* private mode */ }
  if (self.caches) for (const k of await caches.keys()) await caches.delete(k);
  if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  location.replace(location.pathname);
}

// ---------- boot ----------
(async () => {
  const saved = await get('state');
  if (A.isLocked(saved)) ui.locked = saved; else state = A.normalizeState(saved);
  // Blur the screen when the app is hidden, so the app switcher preview doesn't show a story. Best effort: browsers decide when they snapshot.
  // With the lock on, coming back after 5 minutes reloads, which drops the key and the library from memory.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('hide', document.hidden);
    if (document.hidden) hiddenAt = Date.now();
    else if (lockKey && Date.now() - hiddenAt > 5 * 60e3) location.reload();
  });
  // Anything that slips past a try/catch still shows up instead of failing silently.
  addEventListener('unhandledrejection', (e) => setStatus('Error: ' + ((e.reason && e.reason.message) || e.reason)));
  render();
  if (canSpeak) speechSynthesis.addEventListener('voiceschanged', () => { if (ui.view === 'settings') render(); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

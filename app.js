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
  // Not secret: tells the lock screen to show the keypad (older locks used a typed passcode).
  ui.lockStyle = passcode ? 'pin' : null;
  await kv('lockStyle', ui.lockStyle).catch(() => {});
}

// ---------- AI ----------
// Free models are often busy or rate limited: retry a couple of times before giving up, unless text already streamed in.
// Leaving the app (an iPhone pauses it) cuts the connection: once the app is back, ask again, and if text already came in,
// have the AI carry on from where it stopped. `sofar` starts there directly (a story cut off when the app was closed).
async function chat(messages, opts = {}) {
  let sofar = opts.sofar || '';
  for (let attempt = 0, back = 0; ; attempt++) {
    const away = hides;
    let got = '';
    try {
      return sofar + await chatOnce(A.carryOn(messages, sofar), { ...opts, onToken: (t) => { got += t; if (opts.onToken) opts.onToken(t); } });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw e;
      if (isNetError(e) && (hides !== away || document.hidden) && back++ < 3) { sofar += got; await shown(); attempt--; continue; }
      if (!e.retry || got || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
}
function chatOnce(messages, { use, ...opts } = {}) {
  // A world can use its own key and model, so its stories run on a separate account. `use` swaps the provider entirely (the photo AI).
  const ai = state.world.ai || {};
  const away = hides;
  return A.ask({ ...state.settings, ...(ai.apiKey ? { apiKey: ai.apiKey } : {}), ...(ai.model ? { model: ai.model } : {}), ...use }, messages,
    { ...opts, cutOff: () => hides !== away });
}

async function chatJson(messages, opts) {
  // A broken reply gets one fresh try; models rarely make the same slip twice.
  try { return A.parseJsonLoose(await chat(messages, { stream: false, ...opts })); } catch (e) {
    if (e instanceof SyntaxError || /No JSON/.test(e.message)) return A.parseJsonLoose(await chat(messages, { stream: false, ...opts }));
    throw e;
  }
}
// Photos can go to a separate free vision AI (Google Gemini by default) when its key is set; otherwise the main AI reads them.
// Gemini's free tier may keep what it's sent, so Private mode keeps photos on the main AI.
const photoAi = () => { const s = state.settings; return s.photoKey && !s.privateOnly ? { apiKey: s.photoKey, baseUrl: s.photoBaseUrl, model: s.photoModel } : undefined; };

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
// ---------- backups: one tap, or written automatically to a file the user picked (PC browsers) ----------
async function backupText() {
  const data = JSON.parse(JSON.stringify(state));
  data.settings.apiKey = ''; data.settings.ttsKey = ''; data.settings.photoKey = ''; data.settings.hordeKey = ''; data.settings.comfyUrl = ''; data.settings.helperUrl = ''; data.settings.helperSecret = ''; data.settings.pushSub = null; dropWorldKeys(data);
  return JSON.stringify(await A.encryptBackup(data, await deviceKey()));
}
const backedUp = () => { state.settings.lastBackup = Date.now(); return save(); };
async function exportLib() {
  download(await backupText(), `aetherstory-${new Date().toISOString().slice(0, 10)}.json`);
  await backedUp(); render();
}
const canAutoBackup = 'showSaveFilePicker' in window;
const backupFile = () => kv('backupFile').catch(() => null); // a file handle, not library data, so it isn't sealed by App lock
async function pickBackupFile() {
  let fh;
  try { fh = await showSaveFilePicker({ suggestedName: 'aetherstory-backup.json', types: [{ description: 'Aetherstory backup', accept: { 'application/json': ['.json'] } }] }); } catch (e) { return; } // cancelled
  await kv('backupFile', fh); ui.backupName = fh.name;
  await autoBackup(fh); render();
}
// Rewrites the picked file. Skips quietly when there's no file or the browser wants permission again (that needs a tap: backupNow).
async function autoBackup(fh) {
  fh = fh || await backupFile();
  if (!fh || (await fh.queryPermission({ mode: 'readwrite' })) !== 'granted') return false;
  const w = await fh.createWritable();
  await w.write(await backupText()); await w.close();
  await backedUp();
  return true;
}
async function backupNow() {
  const fh = canAutoBackup && await backupFile();
  if (!(fh && (await fh.requestPermission({ mode: 'readwrite' })) === 'granted' && await autoBackup(fh))) await exportLib();
  render();
}
const totalStories = () => state.stories.length + state.otherWorlds.reduce((n, x) => n + x.stories.length, 0);
const backupAge = () => (state.settings.lastBackup ? Math.floor((Date.now() - state.settings.lastBackup) / 864e5) : null);
const backupDue = () => totalStories() > 0 && (backupAge() === null || backupAge() >= 7);
const backupLine = () => (state.settings.lastBackup ? `Last backed up ${fmtDate(state.settings.lastBackup)}.` : 'Never backed up.');

const field = (label, input) => [h('label', {}, label), input];
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const charName = (id) => (state.characters.find((c) => c.id === id) || {}).name;

// ---------- app state & routing ----------
let state = A.emptyState();
const ui = { draft: '', backupName: '', locked: null, advanced: false, pendingImport: null, view: 'write', param: null, selected: [], premise: '', length: 'medium', pov: '', busy: false, status: '', currentId: null, abort: null, reviseText: '', revision: null, reviseLog: [], drawing: null, comic: false };
const openStory = (s) => { ui.comic = false; go(s.chat ? 'chat' : 'stories', s.id); };
const TABS = [['write', '✍️', 'Write'], ['stories', '📚', 'Stories'], ['characters', '🎭', 'Cast'], ['world', '🌍', 'World'], ['settings', '⚙️', 'Settings']];
// Sub-pages light up the tab they live under.
const TAB_OF = { help: 'settings', revise: 'world', chat: 'characters' };
// A tappable row that opens a sub-page.
const menuCard = (icon, title, hint, onclick) => h('div', { class: 'card go', onclick }, h('span', { class: 'ico' }, icon), h('div', {}, h('h3', {}, title), hint && h('p', {}, hint)), h('span', { class: 'arrow' }, '›'));
const backChip = (label, onclick) => h('button', { class: 'chip back', onclick }, '‹ ' + label);
const box = (title, ...kids) => h('section', { class: 'box' }, title && h('h3', {}, title), kids);

function go(view, param = null) {
  state.stories = state.stories.filter((s) => !s.chat || s.messages.length || s.id === param); // a chat nobody wrote in isn't kept
  ui.view = view; ui.param = param; render(); window.scrollTo(0, 0); }

function render() {
  document.getElementById('worldName').textContent = state.world.name;
  const nav = document.getElementById('nav');
  const view = document.getElementById('view');
  nav.hidden = !!ui.locked || !state.settings.ageOk || !state.settings.setupDone;
  if (ui.locked) return view.replaceChildren(...lockScreen());
  if (!state.settings.ageOk) return view.replaceChildren(...ageGate());
  if (!state.settings.setupDone) return view.replaceChildren(...[setupWizard()].flat(Infinity).filter((n) => n && n.nodeType));
  nav.replaceChildren(...TABS.map(([v, icon, label]) => h('button', { class: (TAB_OF[ui.view] || ui.view) === v ? 'on' : '', 'aria-current': (TAB_OF[ui.view] || ui.view) === v ? 'page' : null, onclick: () => go(v) }, h('span', { 'aria-hidden': 'true' }, icon), label)));
  view.replaceChildren(...[VIEWS[ui.view]()].flat(Infinity).filter((n) => n && n.nodeType));
}

function setStatus(msg) { ui.status = msg; const el = document.getElementById('status'); if (el) el.textContent = msg; }

// ---------- generation ----------
// `cut` resumes a story the app was closed in the middle of (see resumeCut): same prompt, picking up the saved text.
// The laptop helper writes it when it can be reached, so leaving the app doesn't stop anything; otherwise this phone does.
async function generate(continueId, cut) {
  if (ui.busy) return;
  const existing = continueId && state.stories.find((s) => s.id === continueId);
  const cast = ui.selected.length ? [...ui.selected] : state.characters.map((c) => c.id);
  const story = existing || { id: A.uid(), title: 'Untitled story', summary: '', characterIds: cast, pov: cast.includes(ui.pov) ? ui.pov : '', premise: ui.premise, text: '', createdAt: Date.now() };
  cut = cut || { before: story.text, premise: ui.premise, length: ui.length, stage: 'write' };
  const j = startJob(cut.helper || story.cut ? 'Finishing your story' : existing ? 'Continuing your story' : 'Writing your story',
    ['Sending your prompt', 'Writing the story', 'Checking world lore, personality and traits', 'Checking physical descriptions', 'Updating your world']);
  if (!j) return;
  if (!existing) state.stories.push(story);
  story.cut = cut; // saved when the app is hidden, cleared when done
  ui.busy = true; ui.currentId = story.id; ui.abort = { abort: closeJob }; ui.status = '';
  go('write');
  const io = { signal: j.signal, step: j.step, note: j.note, save,
    text: (t) => { const out = document.getElementById('output'); if (out) out.textContent = t; },
    chat: (m, o) => chat(m, { ...o, signal: j.signal }), json: (m) => chatJson(m, { signal: j.signal }) };
  try {
    let status = cut.helper || await helperUp() ? await onHelper(story, cut, io) : null;
    if (status === null) status = await A.storyJob(state, story, cut, io); // no helper, or it lost the job: this phone carries on from what's saved
    ui.status = status;
  } catch (e) {
    if (!j.signal.aborted) { ui.status = e.message; j.end(e); }
    delete story.cut;
    if (!existing && !story.text.trim()) state.stories = state.stories.filter((s) => s !== story); // Cancel keeps what was written so far
    else { story.updatedAt = Date.now(); await save(); }
    return finish();
  }
  delete story.cut; await save();
  j.end();
  await condenseMemory();
  await autoBackup().catch(() => {});
  finish();
}

// ---------- laptop helper: helper.js on the user's PC writes stories while the phone is in the background ----------
// Reached at the ComfyUI Tailscale address + /helper unless Settings says otherwise. A random secret pairs this phone the
// first time; the helper keeps nothing on disk but that secret and its notification key.
const helperBase = () => {
  const s = state.settings;
  if (s.helperOff) return '';
  const u = (s.helperUrl || (/^https:/.test(s.comfyUrl || '') ? comfyBase() + '/helper' : '')).trim();
  return u.replace(/\/+$/, '');
};
const helperHeaders = () => {
  const s = state.settings;
  if (!s.helperSecret) { s.helperSecret = A.uid() + A.uid() + A.uid(); save(); }
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.helperSecret };
};
async function helperHello() {
  const res = await fetch(helperBase() + '/hello', { headers: helperHeaders(), signal: AbortSignal.timeout(4000) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.ok) throw new Error(d.error || `The helper answered ${res.status}. Check the address ends in /helper.`); // ComfyUI's own pages answer here too when no helper is set up
  return d;
}
const helperUp = (kind = 'story') => (helperBase() ? helperHello().then((d) => (d.kinds || ['story']).includes(kind), () => false) : false); // older helpers only write stories
// Sends the job, then mirrors the laptop's progress into the pop-up. Returns the status line, or null when the helper
// no longer has the job (restarted) so this phone carries on.
// Sends a job (kind 'story' or 'comic') and polls it, handing each progress report to `each`. Returns the finished report,
// or null when the helper no longer has the job (laptop gone or restarted) so this device carries on from what it collected.
async function helperJob(kind, story, cut, io, each, query = () => '') {
  const base = helperBase(), headers = helperHeaders();
  if (!cut.helper) {
    const res = await fetch(base + '/jobs', { method: 'POST', headers, signal: io.signal,
      body: JSON.stringify({ kind, state: A.helperState(state, story, { panels: kind === 'comic' }), storyId: story.id, cut, push: state.settings.pushSub || null }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.id) throw new Error(`The laptop helper refused the job (${d.error || res.status}).`);
    cut.helper = d.id; await save();
  }
  const drop = () => fetch(`${base}/jobs/${cut.helper}`, { method: 'DELETE', headers }).catch(() => {});
  io.signal.addEventListener('abort', drop, { once: true }); // Cancel stops the laptop too
  for (;;) {
    await pause(1500, io.signal);
    const res = await fetchBack(`${base}/jobs/${cut.helper}${query()}`, { headers, signal: io.signal }).catch((e) => { if (io.signal.aborted) throw e; });
    if (!res || res.status === 404) { delete cut.helper; return null; }
    const r = await res.json();
    if (r.cut) Object.assign(cut, r.cut, { helper: cut.helper }); else if (r.stage) cut.stage = r.stage; // older helpers only sent the stage
    await each(r);
    if (r.error) { drop(); throw new Error(r.error); }
    if (r.done) { A.applyHelperResult(state, story, r.result); drop(); return r; }
  }
}
const awayNote = (what) => `\nYour laptop is ${what}, so you can switch apps: you'll get a notification when it's done.`;
// Mirrors the pop-up's steps and percentage from the helper's reports.
const mirror = (io, away) => { let at = -1; return (r) => { if (r.step !== at) { at = r.step; io.step(r.step, r.detail + away); } else if (io.note) io.note(r.detail + away, r.frac); }; };
async function onHelper(story, cut, io) {
  const away = awayNote('writing this'), show = mirror(io, away);
  if (!cut.helper) io.step(0, 'Sending the story to your laptop.' + away);
  const r = await helperJob('story', story, cut, io, (x) => {
    if (x.text != null && x.text !== story.text) { story.text = x.text; io.text(x.text); }
    show(x);
  });
  return r && r.status;
}
// Comic panels arrive one by one as the laptop draws them; each is shrunk to the library's JPEG here and saved, so they show up as they land.
async function onHelperComic(story, io) {
  const cut = story.comicCut, away = awayNote('drawing this'), show = mirror(io, away);
  const kept = (story.panels || []).map((p) => p.img), got = [];
  let since = 0;
  if (!cut.helper) io.step(0, 'Sending the comic to your laptop.' + away);
  const r = await helperJob('comic', story, cut, io, async (x) => {
    for (const { i, img } of x.imgs || []) got[i] = await shrinkImage(dataBlob(img));
    since += (x.imgs || []).length;
    if (x.panels) {
      const grew = x.panels.length !== (story.panels || []).length;
      story.panels = x.panels.map((m, i) => ({ ...m, img: got[i] || (m.img ? kept[i] || '' : '') })); // 'kept' or 'drawn': this device has it already
      if ((x.imgs || []).length || grew) { await save(); io.landed(); }
    }
    show(x);
  }, () => `?since=${since}`);
  return r && r.status;
}
const dataBlob = (url) => { const [head, b64] = url.split(','); return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: head.slice(5).split(';')[0] }); };
// Notifications: the helper pings Apple's or Google's push service with an empty message (no story text in it),
// and sw.js shows a fixed "your story or comic has finished".
async function helperPair(msg) {
  const s = state.settings;
  msg.textContent = 'Connecting…';
  try {
    const hello = await helperHello();
    let note = '';
    if ('PushManager' in window && 'Notification' in window && hello.vapid) {
      if ((await Notification.requestPermission()) === 'granted') {
        const reg = await navigator.serviceWorker.ready;
        const key = Uint8Array.from(atob(hello.vapid.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        let sub = await reg.pushManager.getSubscription();
        if (sub && s.pushVapid !== hello.vapid) { await sub.unsubscribe(); sub = null; } // the helper made a new key
        sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        s.pushSub = sub.toJSON(); s.pushVapid = hello.vapid; await save();
      } else note = ' Notifications are off, so check back in the app (iPhone: Settings → Notifications → Aetherstory).';
    } else if (!('PushManager' in window)) note = ' This browser can\'t get notifications. On iPhone, open the app from its Home Screen icon.';
    msg.textContent = `✓ Connected to the helper on ${hello.name || 'your PC'}. Stories are written there now, even when you leave the app.${note}`;
  } catch (e) { msg.textContent = (e instanceof TypeError || e.name === 'TimeoutError' ? `Couldn't reach the helper at ${helperBase()}.` : e.message) + ' See Help & guides → Laptop helper.'; }
}

// ---------- chat with a character ----------
function startChat(id) {
  const talk = { id: A.uid(), chat: true, with: id, as: '', characterIds: [id], messages: [], title: `Chat with ${charName(id)}`, summary: '', text: '', createdAt: Date.now() };
  state.stories.push(talk);
  ui.draft = ''; ui.status = '';
  go('chat', talk.id);
}
async function sendChat(talk, text) {
  if (ui.busy || !text) return;
  talk.messages.push({ role: 'user', content: text });
  const messages = A.buildChatMessages(state, talk);
  const reply = { role: 'assistant', content: '' };
  talk.messages.push(reply);
  Object.assign(ui, { draft: '', busy: true, abort: new AbortController(), status: '' });
  render();
  try {
    await chat(messages, { signal: ui.abort.signal, onToken: (t) => { reply.content += t; const el = document.getElementById('reply'); if (el) el.textContent = reply.content; } });
  } catch (e) {
    if (e.name !== 'AbortError' || !reply.content) { talk.messages.splice(-2); ui.draft = text; if (e.name !== 'AbortError') ui.status = e.message; }
  }
  reply.content = reply.content.trim();
  talk.text = A.chatText(state, talk);
  talk.updatedAt = Date.now();
  await save();
  finish();
  const log = document.getElementById('box'); if (log) log.focus();
}
// Like after a story: the world, the characters' developments and the summary pick up what happened.
async function endChat(talk) {
  const j = startJob('Adding this chat to your world', ['Reading the chat for anything new', 'Updating characters and world notes']);
  if (!j) return;
  ui.busy = true; ui.status = ''; render();
  j.step(0, `Your AI is looking for new facts, places, relationships and character developments in ${talk.messages.length} messages.`);
  try {
    const changes = A.applyWorldUpdate(state, talk, await chatJson(A.buildWorldUpdateMessages(state, talk), { signal: j.signal }));
    j.step(1, changes.length ? 'Found: ' + changes.join(', ') : 'Nothing new this time.');
    talk.worldAt = talk.messages.length;
    await save();
    ui.status = changes.length ? 'World updated: ' + changes.join(', ') : 'Saved. Nothing new for the world this time.';
    j.end();
  } catch (e) { if (!j.signal.aborted) ui.status = 'The world update failed: ' + e.message; j.end(e); finish(); return; }
  await condenseMemory();
  await autoBackup().catch(() => {});
  finish();
}
const choiceRow = (story) => (story.choices || []).length > 0 && [h('h3', {}, 'What happens next?'),
  h('div', { class: 'chips' }, story.choices.map((c) => h('button', { class: 'chip', disabled: ui.busy, onclick: () => { ui.premise = c; generate(story.id); ui.premise = ''; } }, c)))];

// Long-term memory: condense the oldest world notes and developments once they outgrow what the prompts show. Best effort.
async function condenseMemory() {
  const plan = A.memoryPlan(state);
  if (!plan) return;
  const s = ui.status;
  setStatus(s + ' Tidying long-term memory…');
  try { if (A.applyMemory(state, plan, await chatJson(A.buildMemoryMessages(state, plan))).length) await save(); } catch (e) { /* tries again after the next story */ }
  setStatus(s);
}

// ---------- slow jobs: one pop-up showing each step, what is happening right now, and a Cancel that really stops the request ----------
// One job at a time. Its signal goes to every fetch, so Cancel aborts the AI call or picture mid-way. A failure stays on screen until closed.
let job = null, jobTimer = null;
// iPhone pauses a home-screen app's code while it's in the background, which drops its connections. `hides` counts trips
// to the background so a dropped connection can tell it was that, and `shown` waits until the app is open again.
let hides = 0;
const shown = () => (document.hidden ? new Promise((res) => document.addEventListener('visibilitychange', function back() {
  if (!document.hidden) { document.removeEventListener('visibilitychange', back); setTimeout(res, 1500); } // give the network a moment to wake
})) : Promise.resolve());
const isNetError = (e) => e instanceof TypeError || (e && e.name === 'NetworkError');
// For checking on a picture: a dropped connection waits for the app to be back and asks again, since the PC or Horde keeps drawing meanwhile.
async function fetchBack(url, opts = {}) {
  for (let tries = 0; ; tries++) {
    try { return await fetch(url, opts); } catch (e) {
      if ((opts.signal && opts.signal.aborted) || !isNetError(e) || tries >= 3) throw e;
      await shown(); await pause(2000, opts.signal);
    }
  }
}
// The app was closed (or the lock reloaded it) in the middle of a story or a comic: carry on by itself once the library is open.
function resumeCut() {
  const s = state.stories.find((x) => x.cut);
  if (s) return generate(s.id, s.cut); // a story the laptop was writing just picks up its progress
  const c = state.stories.find((x) => x.comicCut);
  if (c) makeComic(c, c.comicCut.replan);
}
function startJob(title, steps) {
  if (job) { job.hidden = false; drawJob(); return null; } // already busy: show what's running instead
  const ctl = new AbortController();
  const j = job = { title, steps: steps.map((label) => ({ label, state: 'wait' })), detail: '', error: '', started: Date.now(), hidden: false, signal: ctl.signal,
    cancel: () => ctl.abort(),
    // Step i is running, everything before it is done. `detail` says what's happening in plain words.
    step: (i, detail = '') => { if (job !== j || j.error) return; j.steps.forEach((x, k) => { x.state = k < i ? 'ok' : k === i ? 'run' : 'wait'; }); j.detail = detail; j.frac = 0; drawJob(); },
    // `frac` (0-1): how far the running step is, for the percentage.
    note: (detail, frac) => { if (job !== j || j.error) return; j.detail = detail; if (frac !== undefined) j.frac = frac; drawJob(); },
    end: (err) => {
      if (job !== j) return;
      if (!err || ctl.signal.aborted) { job = null; return drawJob(); }
      const at = j.steps.find((x) => x.state === 'run') || j.steps[0];
      if (at) at.state = 'fail';
      j.error = err.message; j.hidden = false; drawJob();
    } };
  drawJob();
  return j;
}
const closeJob = () => { if (job) job.cancel(); job = null; drawJob(); };
const fmtSecs = (s) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
function drawJob() {
  const el = document.getElementById('job'), pill = document.getElementById('jobPill');
  clearInterval(jobTimer);
  el.hidden = !job || job.hidden; pill.hidden = !job || !job.hidden;
  if (!job) return el.replaceChildren();
  const j = job, now = j.steps.find((x) => x.state === 'run');
  const pct = Math.round(100 * (j.steps.filter((x) => x.state === 'ok').length + (now ? j.frac || 0 : 0)) / j.steps.length) + '% · ';
  const time = h('span', { class: 'muted' }, pct + fmtSecs((Date.now() - j.started) / 1000));
  if (!j.error) jobTimer = setInterval(() => { time.textContent = pct + fmtSecs((Date.now() - j.started) / 1000); }, 1000);
  pill.replaceChildren(h('span', { class: 'spinner' }), `${j.title}${now ? ' · ' + now.label : ''}`);
  pill.onclick = () => { j.hidden = false; drawJob(); };
  const icon = { wait: '○', ok: '✓', fail: '✗' };
  el.replaceChildren(h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'jobTitle' },
    h('h2', { id: 'jobTitle' }, j.title), j.error ? h('span', { class: 'muted' }, 'Stopped') : time,
    h('ul', {}, j.steps.map((x) => h('li', { class: x.state }, x.state === 'run' && !j.error ? h('span', { class: 'spinner' }) : h('span', { class: 'ic' }, icon[x.state]), x.label))),
    (j.error || j.detail) && h('p', { class: 'detail' + (j.error ? ' fail' : ''), 'aria-live': 'polite' }, j.error || j.detail),
    h('div', { class: 'row' }, j.error ? h('button', { class: 'btn', onclick: closeJob }, 'Close')
      : [h('button', { class: 'btn ghost', onclick: () => { j.hidden = true; drawJob(); } }, 'Hide'), h('button', { class: 'btn danger', onclick: closeJob }, 'Cancel')])));
}
// A wait that Cancel cuts short, so the pop-up and the page settle the moment it's tapped.
const pause = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});
// ---------- pictures: lib.drawPicture does the drawing (ComfyUI on the user's PC first, AI Horde otherwise), so the laptop helper draws the same way ----------
const PRIVATE_PICTURES = A.PRIVATE_PICTURES;
const canDraw = () => !state.settings.privateOnly || !!state.settings.comfyUrl;
const waitText = A.waitText;
let comfyNote = ''; // why the last picture went to Horde instead of the PC, shown with the progress
const artist = () => A.artist(state.settings, comfyNote);
const PIC_ENV = { fetch: (...a) => fetch(...a), poll: fetchBack, pause, toImage: (blob) => shrinkImage(blob) };
async function drawImage(prompt, onWait, opts = {}) {
  return (await A.drawPicture(state.settings, prompt, onWait, { ...opts, onNote: (n) => { comfyNote = n; } }, PIC_ENV)).img;
}
const comfyError = (e) => A.comfyError(state.settings, e);
const comfyBase = () => A.comfyBase(state.settings);
const comfyModels = () => A.comfyModels(state.settings, PIC_ENV);

// Turns a story into manhwa panels (lib.comicJob). On the laptop helper when it answers, so leaving the app doesn't stop it;
// otherwise on this device, each panel saved as it lands (leaving midway loses nothing).
// ponytail: images live in the library as JPEG data URLs (~60 KB each); move them to their own store if saves or backups get slow.
async function makeComic(story, replan) {
  if (ui.drawing) return;
  if (!canDraw()) return setStatus(PRIVATE_PICTURES);
  const plan = replan || !(story.panels || []).length;
  const steps = ['Learning how each character looks', plan && 'Planning and fact-checking the panels', 'Drawing and checking the panels'].filter(Boolean);
  const j = startJob('Making your comic', steps);
  if (!j) return;
  const here = () => ui.view === 'stories' && ui.param === story.id;
  ui.drawing = story.id; ui.comic = true; ui.status = ''; render();
  story.comicCut = story.comicCut || { replan: plan }; // saved when the app is hidden, cleared when done
  const io = { signal: j.signal, step: j.step, save, json: (m) => chatJson(m, { signal: j.signal }),
    draw: (prompt, onWait, opts) => A.drawPicture(state.settings, prompt, onWait, opts, PIC_ENV), models: comfyModels, landed: () => { if (here()) render(); } };
  try {
    const left = story.comicCut.helper || await helperUp('comic') ? await onHelperComic(story, io) : null;
    ui.status = left === null ? await A.comicJob(state, story, story.comicCut, io) : left; // no helper, or it lost the job: draw here
    j.end();
  } catch (e) {
    ui.status = j.signal.aborted ? 'Comic stopped. Panels already drawn are kept: tap "Draw missing panels" to carry on.' : e.message + ' Tap "Draw missing panels" to try again.';
    j.end(e);
  }
  delete story.comicCut; await save();
  ui.drawing = null;
  if (here()) render();
  setStatus(ui.status);
}
// Developer view (Settings → Pictures): what each panel was planned as, the exact prompt sent, which model drew it, and its check.
const panelDev = (p) => state.settings.devPrompts && h('details', { class: 'dev' }, h('summary', {}, 'Prompt'),
  p.sent && p.sent.prompt ? h('p', {}, h('b', {}, `Sent to ${p.sent.by} (${p.sent.model}${p.sent.why ? ', picked for an ' + p.sent.why : ''}): `), p.sent.prompt) : h('p', {}, h('b', {}, 'Prompt: '), p.prompt),
  p.check && h('p', {}, h('b', {}, 'Picture check: '), p.check),
  p.scene && h('p', {}, h('b', {}, 'Plan: '), JSON.stringify({ quote: p.quote, setting: p.setting, characters: p.characters, clothes: p.clothes, explicit: p.explicit })));
const comicView = (story) => h('div', { class: 'comic' }, story.panels.map((p, i) => h('figure', {},
  p.img ? h('img', { src: p.img, alt: p.caption || `Panel ${i + 1}` }) : h('div', { class: 'ph' }, ui.drawing === story.id ? 'Drawing…' : 'Not drawn yet'),
  p.caption && h('figcaption', { class: 'cap' }, p.caption),
  p.dialogue.map((d) => h('p', { class: 'bubble' }, d.name && h('b', {}, d.name + ' '), d.line)),
  panelDev(p),
  p.img && ui.drawing !== story.id && h('button', { class: 'chip', onclick: () => { p.img = ''; p.redraws = (p.redraws || 0) + 1; makeComic(story); } }, '↻ Redraw'))));

// Photos go to the AI as a small JPEG: quicker, and redrawing drops the location and camera data photos carry.
async function shrinkImage(file, max = 768) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const cv = h('canvas', { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.85);
}
function finish() { ui.busy = false; ui.abort = null; const s = ui.status; render(); setStatus(s); }

async function quickstart(vibe) {
  const j = startJob('Creating your world', ['Dreaming up a world and its cast', 'Saving it to your library']);
  if (!j) return;
  ui.busy = true; ui.status = ''; render();
  j.step(0, vibe ? `Building a world around "${vibe}": a name, an overview, places, lore and three or four characters.` : 'No vibe given, so the AI picks one: a name, an overview, places, lore and three or four characters.');
  try {
    const added = A.applyQuickstart(state, await chatJson(A.buildQuickstartMessages(vibe), { signal: j.signal }));
    j.step(1, `Met ${added.map((c) => c.name).join(', ')}.`);
    ui.selected = added.map((c) => c.id);
    await save();
    ui.status = `Created ${state.world.name} with ${added.map((c) => c.name).join(', ')}. Hit Generate.`;
    j.end();
  } catch (e) { if (!j.signal.aborted) ui.status = e.message; j.end(e); }
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
function keySetup(onDone = () => { ui.status = 'You are all set!'; go('write'); }) {
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
    onDone();
  };
  return [h('ol', { class: 'steps' },
    h('li', {}, 'Open ', h('a', { href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener' }, 'openrouter.ai/keys'), ' and sign in. Google sign-in works, and no card is needed.'),
    h('li', {}, 'Tap ', h('b', {}, 'Create API Key'), ', name it anything (like "stories"), and tap ', h('b', {}, 'Copy'), '.'),
    h('li', {}, 'Come back here, paste it below, and tap Start.')),
    key, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: start }, 'Start')), status];
}
// A phone-style keypad for the lock PIN: dots fill as digits go in, and it submits itself at the 6th. A keyboard works too.
const PIN_LEN = 6;
const KEY_LETTERS = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ' };
const icon = (svg, cls) => { const el = h('span', { class: cls, 'aria-hidden': 'true' }); el.innerHTML = svg; return el; }; // fixed strings only, never user text
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>';
function pinPad(onFull) {
  let pin = '';
  const dots = h('div', { class: 'dots', role: 'status', 'aria-label': 'PIN digits entered' });
  const show = () => { dots.replaceChildren(...Array.from({ length: PIN_LEN }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' }))); dots.setAttribute('aria-valuenow', pin.length); };
  const press = (d) => {
    if (pin.length >= PIN_LEN) return;
    pin += d; show();
    if (pin.length === PIN_LEN) { const p = pin; setTimeout(() => { pin = ''; show(); onFull(p); }, 150); } // let the last dot fill first
  };
  const back = () => { pin = pin.slice(0, -1); show(); };
  const key = (d) => h('button', { class: 'key', type: 'button', 'aria-label': d, onclick: () => press(d) }, d, KEY_LETTERS[d] && h('small', { 'aria-hidden': 'true' }, KEY_LETTERS[d]));
  const pad = h('div', { class: 'keypad' }, '123456789'.split('').map(key), h('span'), key('0'), h('button', { class: 'key plain', type: 'button', onclick: back }, 'Delete'));
  const onKey = (e) => {
    if (!pad.isConnected) return removeEventListener('keydown', onKey);
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') back();
  };
  addEventListener('keydown', onKey);
  show();
  return { nodes: [dots, pad], bad: () => { dots.classList.remove('bad'); void dots.offsetWidth; dots.classList.add('bad'); if (navigator.vibrate) navigator.vibrate(120); } };
}
// iPhone-style: just a small link under the keypad, the full explanation only when tapped.
const forgotLink = (forgot) => { const a = h('button', { class: 'linkbtn', type: 'button', onclick: () => a.replaceWith(forgot) }, 'Forgot PIN?'); return a; };
function lockScreen() {
  const msg = h('div', { class: 'muted center', 'aria-live': 'polite' });
  let pad;
  const unlock = async (pass) => {
    msg.textContent = 'Unlocking…';
    const key = await A.deriveKey(pass, ui.locked.salt);
    let data;
    try { data = await A.unseal(ui.locked, key); } catch (e) { msg.textContent = ui.lockStyle === 'pin' ? 'Wrong PIN. Try again.' : 'Wrong passcode.'; if (pad) pad.bad(); return; }
    lockKey = key; lockSalt = ui.locked.salt; state = A.normalizeState(data); ui.locked = null; render(); resumeCut();
  };
  const forgot = h('p', { class: 'muted center' }, 'Forgot your PIN? Your stories can\'t be recovered without it. You can ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); eraseAll(); } }, 'erase everything'), ' and start over, then import a backup.');
  if (ui.lockStyle !== 'pin') { // locks made before the keypad: typed passcode
    const pass = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passcode' });
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(pass.value); });
    setTimeout(() => pass.focus());
    return [h('div', { class: 'lockwrap' }, icon(LOCK_SVG, 'lockicon'), h('h2', {}, 'Aetherstory is locked'), pass,
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => unlock(pass.value) }, 'Unlock')), msg,
      h('p', { class: 'muted center' }, 'Tip: after unlocking, Settings → App lock → Change to a PIN gives you a keypad.'), forgot)];
  }
  pad = pinPad(unlock);
  return [h('div', { class: 'lockwrap' }, icon(LOCK_SVG, 'lockicon'), h('h2', {}, 'Enter Aetherstory PIN'), ...pad.nodes, msg, forgotLink(forgot))];
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
    if (backupDue() && !ui.busy) {
      nodes.push(h('div', { class: 'card setup' }, h('h3', {}, '💾 Back up your stories'),
        h('p', {}, `${backupLine()} Your library only lives in this browser, and phones can clear it. A backup keeps it safe.`),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: backupNow }, 'Back up now'))));
    }
    if (!state.characters.length) {
      const vibe = h('input', { placeholder: 'Optional: a one-line vibe, e.g. "rival witches in a rainy port city"' });
      nodes.push(box('✨ Quick start',
        h('p', { class: 'muted' }, 'Let the AI build a world and a starting cast for you. You can edit everything later.'),
        vibe, h('div', { class: 'row' }, h('button', { class: 'btn', disabled: ui.busy, onclick: () => quickstart(vibe.value.trim()) }, '✨ Create my world')),
        h('p', { class: 'muted' }, 'Or add your own characters in the Cast tab.')));
    } else {
      nodes.push(box('Who is in this story?', h('p', { class: 'muted' }, 'Pick some, or none to use the whole cast.'),
        h('div', { class: 'chips' }, state.characters.map((c) => h('button', {
          class: 'chip' + (ui.selected.includes(c.id) ? ' on' : ''),
          onclick: () => { ui.selected = ui.selected.includes(c.id) ? ui.selected.filter((x) => x !== c.id) : [...ui.selected, c.id]; render(); },
        }, c.name)))));
      const premise = h('textarea', { placeholder: 'Optional. Leave blank and the AI picks something that fits your world.', oninput: (e) => { ui.premise = e.target.value; } });
      premise.value = ui.premise;
      const length = h('select', { onchange: (e) => { ui.length = e.target.value; } },
        Object.entries(A.LENGTHS).map(([k, w]) => h('option', { value: k, selected: ui.length === k }, `${k[0].toUpperCase() + k.slice(1)} (~${w} words)`)));
      const castIds = ui.selected.length ? ui.selected : state.characters.map((c) => c.id);
      const pov = h('select', { onchange: (e) => { ui.pov = e.target.value; } },
        h('option', { value: '' }, 'Narrator (third person)'),
        state.characters.filter((c) => castIds.includes(c.id)).map((c) => h('option', { value: c.id, selected: ui.pov === c.id }, `${c.name} (first person)`)));
      const spiceName = (A.SPICE[state.settings.spice] || A.SPICE.adult).label;
      nodes.push(box('', ...field('Premise or direction', premise),
        h('details', { open: ui.moreOpts, ontoggle: (e) => { ui.moreOpts = e.target.open; } },
          h('summary', {}, `Story options · ${ui.length}, ${ui.pov ? charName(ui.pov) + "'s view" : 'narrator'}, spice ${spiceName}`),
          ...field('Length', length), ...field('Whose point of view?', pov), spiceControl()),
        h('div', { class: 'row' },
          h('button', { class: 'btn', disabled: ui.busy, onclick: () => { ui.currentId = null; generate(); } }, '✨ Generate story'),
          ui.busy && h('button', { class: 'btn ghost', onclick: () => ui.abort && ui.abort.abort() }, 'Stop'))));
    }
    nodes.push(h('div', { class: 'status', id: 'status' }, ui.status));
    if (story) {
      nodes.push(h('h2', {}, story.title), h('div', { class: 'prose', id: 'output' }, story.text));
      if (!ui.busy) nodes.push(choiceRow(story), h('div', { class: 'row' },
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
    return [h('h2', {}, `Stories (${list.length})`), list.map((s) => h('div', { class: 'card', onclick: () => openStory(s) },
      h('h3', {}, (s.chat ? '💬 ' : '') + s.title),
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
        c.portrait && h('img', { class: 'face', src: c.portrait, alt: '' }), h('h3', {}, c.name), h('p', {}, c.personality || c.background || ''),
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
    if (ui.param === 'bible') {
      return [backChip('World', () => go('world')), h('h2', {}, `📖 ${w.name}`),
        h('p', { class: 'muted' }, 'This is the series bible. It grows automatically after every story, and every new story reads it. Edit freely.'),
        box('', ...field('Name', name), ...field('Overview', overview)),
        box('', ...listBox('lore', 'Lore'), ...listBox('places', 'Places')),
        box('', ...listBox('relationships', 'Relationships'), ...listBox('timeline', 'Timeline')),
        h('details', { class: 'box' }, h('summary', {}, 'AI key for this world (optional)'),
          h('p', { class: 'muted' }, 'Leave blank to use the key and model from Settings. Stories never see other worlds either way; a separate key just keeps this world on its own account.'),
          ...field('API key', aiBox('apiKey', { type: 'password', autocomplete: 'off', placeholder: 'Same as Settings' })),
          ...field('Model', aiBox('model', { placeholder: state.settings.model })))];
    }
    return [h('h2', {}, `🌍 ${w.name}`),
      menuCard('📖', 'Series bible', `Overview, lore, places, relationships and timeline (${w.lore.length + w.places.length + w.relationships.length + w.timeline.length} notes)`, () => go('world', 'bible')),
      menuCard('🪄', 'Revise a fact', 'Change something in plain words and every character and story follows', () => go('revise')),
      h('h2', {}, `Your worlds (${state.otherWorlds.length + 1})`),
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
      } }, '+ New world'))];
  },

  chat() {
    const talk = state.stories.find((s) => s.id === ui.param && s.chat);
    if (!talk) return VIEWS.characters();
    const name = (id, fallback) => charName(id) || fallback;
    const box = h('textarea', { id: 'box', rows: 2, placeholder: `Say something to ${name(talk.with, 'them')}…`, oninput: (e) => { ui.draft = e.target.value; } });
    box.value = ui.draft;
    const send = () => sendChat(talk, box.value.trim());
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    const as = h('select', { onchange: (e) => { talk.as = e.target.value; talk.characterIds = [talk.with, talk.as].filter(Boolean); save(); render(); } },
      h('option', { value: '' }, 'Myself'), state.characters.filter((c) => c.id !== talk.with).map((c) => h('option', { value: c.id, selected: talk.as === c.id }, c.name)));
    const last = talk.messages[talk.messages.length - 1];
    return [h('div', { class: 'row' }, backChip(name(talk.with, 'Cast'), () => go('characters', talk.with)),
      talk.messages.length > 0 && listenBtn(talk)),
      h('h2', {}, `💬 ${name(talk.with, 'Chat')}`),
      ...field('You are talking as', as),
      talk.messages.length ? talk.messages.map((m) => h('div', { class: 'bubble ' + m.role }, h('b', {}, (m.role === 'user' ? name(talk.as, 'You') : name(talk.with, 'Them')) + ': '),
        h('span', { id: ui.busy && m === last ? 'reply' : null }, m.content)))
        : h('div', { class: 'empty' }, `Say hi. ${name(talk.with, 'They')} knows your world and everything that happened in your stories.`),
      box,
      h('div', { class: 'row' }, h('button', { class: 'btn', disabled: ui.busy, onclick: send }, 'Send'),
        ui.busy && h('button', { class: 'btn ghost', onclick: () => ui.abort && ui.abort.abort() }, 'Stop'),
        !ui.busy && talk.messages.length > (talk.worldAt || 0) && h('button', { class: 'btn ghost', onclick: () => endChat(talk) }, '✓ Add this chat to my world')),
      h('div', { class: 'status', id: 'status' }, ui.status),
      h('p', { class: 'muted' }, 'Chats are saved with your stories. "Add this chat to my world" updates the world notes and the characters, like a story does.')];
  },

  revise() {
    const plan = ui.revision;
    const nodes = [backChip('World', () => go('world')), h('h2', {}, '🪄 Revise a fact'),
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
      for (const k of ['baseUrl', 'apiKey', 'model', 'privateOnly', 'ttsKey', 'photoKey', 'photoBaseUrl', 'photoModel', 'hordeKey', 'comfyUrl', 'comfyModel', 'comfyNsfwModel', 'helperUrl', 'helperOff', 'helperSecret', 'pushSub', 'pushVapid']) data.settings[k] = s[k];
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
    const sections = {
      ai: () => [
        s.apiKey ? [h('p', { class: 'muted' }, '✓ Key saved. ' + (isDefault ? 'Stories are written by the free default AI (Nemotron).' : `Using ${s.model} (see Advanced mode).`)),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: test }, 'Test it'))]
          : keySetup(),
        status,
        spiceControl(),
        ...field('Instructions applied to every story', style),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!s.privateOnly, onchange: (e) => { s.privateOnly = e.target.checked; save(); }, style: 'width:auto' }), ' Private mode: only use AI providers that do not store or train on my stories'),
        h('p', { class: 'muted' }, 'Your stories are sent to the AI to be written. Free models are often run by providers that may keep prompts; Private mode blocks those, so free models may stop working.'),
        h('details', { open: ui.advanced, ontoggle: (e) => { ui.advanced = e.target.open; } }, h('summary', {}, 'Advanced mode'),
          h('p', { class: 'muted' }, 'Pick another model or any OpenAI-compatible service. Your key is stored only on this device. Venice and Euryale (paid) follow the Spice level most reliably.'),
          ...field('Preset', preset), ...field('Base URL', base), ...field('API key', bind('apiKey', h('input', { type: 'password', autocomplete: 'off', placeholder: 'sk-…' }))),
          ...field('Model', model), ...field('Creativity (temperature 0–2)', bind('temperature', h('input', { type: 'number', min: 0, max: 2, step: 0.1 }))),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: test }, 'Test connection')))],
      narration: () => narrationSettings(),
      pictures: () => pictureSettings(bind),
      helper: () => helperSettings(bind),
      photo: () => [
        h('p', { class: 'muted' }, s.photoKey ? '✓ On. "Describe from a photo" uses Google Gemini, which reads photos better than story models.'
          : 'For the best results with "Describe from a photo" on the Cast tab, add a free Google Gemini key: open aistudio.google.com/apikey, sign in, tap Create API key, and paste it here. Without it, your main AI reads the photo.'),
        h('p', { class: 'muted' }, 'Google\'s free tier may use what it is sent to improve its products, so with Private mode on, photos go to your main AI instead. Only the photo goes to Gemini, never your stories.'),
        ...field('Gemini API key', bind('photoKey', h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste your Gemini key' }))),
        h('details', {}, h('summary', {}, 'Photo AI service and model'),
          h('p', { class: 'muted' }, 'Any OpenAI-compatible service with a vision model works here.'),
          ...field('Base URL', bind('photoBaseUrl', h('input', {}))), ...field('Model', bind('photoModel', h('input', {}))))],
      lock: () => !lockKey || ui.changingPin ? [lockSetup(!!lockKey), ui.changingPin && h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => { ui.changingPin = false; render(); } }, 'Cancel'))]
        : [h('p', { class: 'muted' }, `✓ On. Your stories, characters, world and keys are encrypted on this device.`),
          ...field('Lock again when I leave the app', h('select', { onchange: (e) => { s.lockAfter = Number(e.target.value); save(); } },
            LOCK_AFTER.map(([m, l]) => h('option', { value: m, selected: lockAfter() === m }, l)))),
          h('div', { class: 'status', id: 'status' }, ui.status),
          h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => location.reload() }, 'Lock now'),
            h('button', { class: 'btn ghost', onclick: () => { ui.changingPin = true; ui.status = ''; render(); } }, ui.lockStyle === 'pin' ? 'Change PIN' : 'Change to a PIN'),
            h('button', { class: 'btn danger', onclick: async () => { if (!confirm('Turn off the lock? Your library will be stored unencrypted on this device.')) return; await setLock(null); ui.status = ''; render(); } }, 'Turn off'))],
      library: () => [
        h('p', { class: 'muted' }, `${state.otherWorlds.length + 1} worlds, ${totalStories()} stories, ${state.characters.length + state.library.length} characters. Everything lives on this device; export to back up or move it to your phone/PC.`),
        h('p', {}, backupLine() + (ui.backupName ? ` Auto-backup is on: every story and chat is saved to ${ui.backupName}.` : '')),
        canAutoBackup && h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: pickBackupFile }, ui.backupName ? 'Change auto-backup file' : 'Turn on auto-backup to a file'),
          ui.backupName && h('button', { class: 'btn ghost', onclick: backupNow }, 'Back up now')),
        canAutoBackup && h('p', { class: 'muted' }, 'Pick a file once (a synced folder like OneDrive or Google Drive keeps a copy off this PC too). If the browser asks again after a restart, tap Back up now.'),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: exportLib }, 'Export backup'), h('button', { class: 'btn ghost', onclick: () => file.click() }, 'Import backup'),
          h('button', { class: 'btn ghost', onclick: async () => download(await deviceKey(), 'aetherstory-key.txt') }, 'Download key'), file),
        h('p', { class: 'muted' }, 'Backups are encrypted (AES-256) with a key unique to this device. To open one on another device, or after clearing this browser, you also need this device\'s key file: download it once and keep it somewhere separate from your backups.'),
        ui.pendingImport && unlockBox(),
        h('h3', {}, 'Start over'),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => { s.setupDone = false; save(); render(); } }, 'Run first-time setup again'),
          h('button', { class: 'btn danger', onclick: eraseAll }, 'Erase everything'))],
    };
    const section = SETTINGS.find(([id]) => id === ui.param);
    if (!section) {
      return [h('h2', {}, 'Settings'), SETTINGS.map(([id, icon, title, hint]) => menuCard(icon, title, hint, () => go(id === 'help' ? 'help' : 'settings', id === 'help' ? null : id)))];
    }
    return [backChip('Settings', () => go('settings')), h('h2', {}, `${section[1]} ${section[2]}`), box('', sections[section[0]]())];
  },

  // Guides and known problems from help.js, so nobody needs a support team to get set up.
  help() {
    const back = backChip(ui.param ? 'Help' : 'Settings', () => go(ui.param ? 'help' : 'settings'));
    const guide = HELP.guides.find((g) => g.id === ui.param);
    if (guide) return [back, h('h2', {}, guide.title), box('', helpBody(guide.body))];
    return [back, h('h2', {}, '❓ Help & guides'),
      h('h3', {}, 'Guides'), HELP.guides.map((g) => menuCard('📘', g.title, '', () => go('help', g.id))),
      h('h3', {}, 'Problems and fixes'),
      h('p', { class: 'muted' }, 'Errors people have run into before, and what fixes them.'),
      HELP.problems.map((x) => h('details', { class: 'help' }, h('summary', {}, x.q), helpBody(x.a)))];
  },
};

const SETTINGS = [['ai', '🤖', 'AI & writing', 'Your AI key, Spice, story instructions, Private mode'], ['narration', '🔊', 'Narration', 'Voices and reading speed'],
  ['pictures', '🖼️', 'Pictures', 'Free AI Horde, or ComfyUI on your own PC'], ['photo', '📷', 'Photo AI', 'Describe characters from a photo'],
  ['helper', '💻', 'Laptop helper', 'Keep writing on your PC when you leave the app'],
  ['lock', '🔒', 'App lock', 'A passcode for this device'], ['library', '💾', 'Library & backups', 'Export, import, move to another device, start over'],
  ['help', '❓', 'Help & guides', 'Step-by-step setup guides and fixes for common problems']];

// help.js text: `backticks` become copyable code, {ORIGIN} this app's origin (what ComfyUI must let in), {APP} its full address, arrays numbered steps.
const APP_URL = location.origin + location.pathname.replace(/[^/]*$/, '');
const richText = (t) => String(t).replaceAll('{ORIGIN}', location.origin).replaceAll('{APP}', APP_URL).split('`').map((part, i) => (i % 2 ? h('code', {}, part) : part));
const helpBody = (body) => body.map((b) => (Array.isArray(b) ? h('ol', { class: 'steps help' }, b.map((x) => h('li', {}, richText(x)))) : h('p', { class: 'help' }, richText(b))));

// Spice: lib's three levels. There's no Off any more; mature stays on.
const SPICE_STEPS = Object.entries(A.SPICE).map(([k, v]) => [k, v.label, v.hint]);
function spiceControl() {
  const s = state.settings;
  const at = Math.max(0, SPICE_STEPS.findIndex(([k]) => k === s.spice));
  const note = h('p', { class: 'muted' });
  const show = (i) => { note.textContent = `${SPICE_STEPS[i][1]}: ${SPICE_STEPS[i][2]}`; };
  show(at);
  return [h('label', {}, 'Spice (stories, chats and comic pictures)'),
    h('input', { type: 'range', class: 'spice', min: 0, max: SPICE_STEPS.length - 1, step: 1, value: at, 'aria-label': 'Spice level', oninput: (e) => show(+e.target.value),
      onchange: (e) => { s.mature = true; s.spice = SPICE_STEPS[+e.target.value][0]; save(); } }),
    h('div', { class: 'ticks' }, SPICE_STEPS.map(([, label]) => h('span', {}, label))), note];
}

function pictureSettings(bind) {
  const s = state.settings;
  const models = h('select', { onchange: (e) => { s.comfyModel = e.target.value; save(); } },
    h('option', { value: s.comfyModel }, s.comfyModel || 'Tap Test to list your models'));
  // Explicit comic panels can use a different checkpoint (tame models draw them PG-13); the fixed body tags keep the characters the same.
  const nsfwModels = h('select', { onchange: (e) => { s.comfyNsfwModel = e.target.value; save(); } },
    h('option', { value: s.comfyNsfwModel }, s.comfyNsfwModel || 'Automatic: picked from the scene'));
  const tick = (key, text) => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => { s[key] = e.target.checked; save(); }, style: 'width:auto' }), ' ' + text);
  const msg = h('div', { class: 'status' });
  const testComfy = async () => {
    if (!s.comfyUrl) { msg.textContent = 'Type your ComfyUI address first.'; return; }
    msg.textContent = 'Checking…';
    try {
      const list = await comfyModels();
      if (!list.length) throw new Error('ComfyUI has no model yet. Put an anime model in its models\\checkpoints folder and restart it.');
      if (!list.includes(s.comfyModel)) { s.comfyModel = list[0]; save(); }
      models.replaceChildren(...list.map((m) => h('option', { value: m, selected: m === s.comfyModel }, m)));
      if (s.comfyNsfwModel && !list.includes(s.comfyNsfwModel)) { s.comfyNsfwModel = ''; save(); }
      nsfwModels.replaceChildren(h('option', { value: '' }, 'Automatic: picked from the scene'), ...list.map((m) => h('option', { value: m, selected: m === s.comfyNsfwModel }, m)));
      msg.textContent = `✓ Connected. Pictures will be drawn on your PC with ${s.comfyModel}.`;
    } catch (e) { msg.textContent = comfyError(e) + ' See Help & guides → Problems and fixes.'; }
  };
  return [
    h('p', { class: 'muted' }, '"Make it a comic" on a story turns it into illustrated manhwa panels, and "Draw portrait" on a character draws them. Every picture is 2D anime art.'),
    h('h3', {}, 'AI Horde (free, works anywhere)'),
    h('p', { class: 'muted' }, 'Volunteer computers draw your pictures, so each one can take a minute or more. ' +
      (s.hordeKey ? '✓ Your Horde key is on, so your pictures skip ahead of anonymous ones.' : 'For shorter waits, register for free at aihorde.net/register and paste the API key it gives you here.')),
    h('p', { class: 'muted' }, 'Only each panel\'s scene description and the characters\' looks are sent, never the story itself. Volunteers\' computers see those descriptions, so AI Horde is off in Private mode.'),
    ...field('AI Horde API key (optional)', bind('hordeKey', h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste your Horde key' }))),
    h('h3', {}, 'ComfyUI on your PC (seconds per picture)'),
    h('p', { class: 'muted' }, s.comfyUrl ? 'Pictures are drawn on your PC first. When it can\'t be reached, AI Horde draws instead (except in Private mode). Nothing is sent anywhere else.'
      : 'A Windows PC with an NVIDIA graphics card can draw pictures in seconds, free and private. Leave this empty to use AI Horde only.'),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => go('help', 'comfy') }, 'Set-up guide'), h('button', { class: 'btn ghost', onclick: () => go('help', 'phone') }, 'Use it from your phone')),
    ...field('ComfyUI address', bind('comfyUrl', h('input', { type: 'url', autocomplete: 'off', placeholder: 'http://127.0.0.1:8189' }))),
    ...field('Model', models),
    ...field('Model for explicit comic panels', nsfwModels),
    h('p', { class: 'muted' }, 'Comics pick the model for each panel from its scene: explicit panels go to a model that can draw them (NoobAI, Pony, Illustrious, WAI or a name with NSFW in it) unless you pick one here, everything else to your Model above.'),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: testComfy }, 'Test')), msg,
    h('h3', {}, 'Comic accuracy'),
    tick('checkPictures', 'Check each comic panel: your story AI looks at it and redraws it once if it doesn\'t match the story (slower; needs an AI that can see pictures, like the default)'),
    tick('devPrompts', 'Developer: show each panel\'s prompt, the model that drew it and its check under the picture')];
}

function helperSettings(bind) {
  const s = state.settings, msg = h('div', { class: 'status', 'aria-live': 'polite' });
  const auto = /^https:/.test(s.comfyUrl || '') ? comfyBase() + '/helper' : 'https://your-pc.your-tailnet.ts.net/helper';
  return [h('p', { class: 'muted' }, 'A small free program on your PC writes your stories, so you can tap Generate and switch apps. You get a notification when it\'s done. ' +
      'It needs the PC on and Tailscale connected; when it can\'t be reached, this device writes the story instead.'),
    h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => go('help', 'helper') }, 'Set-up guide'), h('button', { class: 'btn ghost', onclick: () => go('help', 'full') }, 'Full setup')),
    ...field('Helper address (empty: your ComfyUI address + /helper)', bind('helperUrl', h('input', { type: 'url', autocomplete: 'off', placeholder: auto }))),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => helperPair(msg) }, 'Test and turn on notifications')), msg,
    h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: !!s.helperOff, onchange: (e) => { s.helperOff = e.target.checked; save(); }, style: 'width:auto' }), ' Don\'t use the helper: write on this device only')];
}

// First run, after the age gate: Quick start (key, spice, pictures, lock) or the Full setup, which adds Tailscale, ComfyUI
// and the laptop helper with their guides inline. Every step can be skipped and changed later in Settings.
function setupWizard() {
  const s = state.settings, step = ui.setupStep || 0;
  const next = () => { ui.setupStep = step + 1; render(); window.scrollTo(0, 0); };
  const finish = async () => { s.setupDone = true; ui.setupStep = 0; ui.setupMode = null; await save(); go('write'); };
  const bind = (key, el) => { el.value = s[key]; el.addEventListener('change', () => { s[key] = el.value.trim(); save(); }); return el; };
  if (!ui.setupMode) {
    const pick = (mode) => { ui.setupMode = mode; ui.setupStep = 0; render(); window.scrollTo(0, 0); };
    return [h('h2', {}, 'Welcome!'), h('p', {}, 'How do you want to start?'),
      menuCard('⚡', 'Quick start', 'A few quick choices, then you\'re writing. About 3 minutes, on this device only.', () => pick('quick')),
      menuCard('🧭', 'Walk me through the full setup', 'Also sets up your PC: pictures in seconds, and stories that keep writing when you leave the app. About 45 minutes, free.', () => pick('full')),
      h('p', { class: 'muted' }, 'You can do the full setup later too: Settings → Help & guides → Full setup.')];
  }
  const guide = (id) => helpBody(HELP.guides.find((g) => g.id === id).body);
  const comfyMsg = h('div', { class: 'status', 'aria-live': 'polite' });
  const steps = [
    ['your free AI key', () => s.apiKey ? h('p', {}, '✓ Your key is already saved.') : [h('p', {}, 'Stories are written by an AI using your own free key. It takes about two minutes and costs nothing.'), keySetup(next)]],
    ['how spicy?', () => [h('p', { class: 'muted' }, 'This sets how explicit stories, chats and comic pictures are. You can change it any time on the Write tab.'), spiceControl()]],
    ['pictures', () => [h('p', {}, 'Comics and portraits are drawn for free by AI Horde volunteers, which can take a minute or more per picture. For shorter waits, register free at aihorde.net/register and paste your key (optional).'),
      ...field('AI Horde API key (optional)', bind('hordeKey', h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste your Horde key' }))),
      ui.setupMode === 'quick' && h('p', { class: 'muted' }, 'Have a Windows PC with an NVIDIA graphics card? It can draw pictures in seconds. The guide is in Settings → Help & guides whenever you want it.')]],
    ui.setupMode === 'full' && ['install the app', () => guide('install')],
    ui.setupMode === 'full' && ['connect your phone and PC', () => guide('tailscale')],
    ui.setupMode === 'full' && ['ComfyUI on your PC', () => [guide('comfy'), h('p', { class: 'muted' }, 'Doing this on the phone? Do the next step first, then come back and test with the https address.'),
      ...field('ComfyUI address', bind('comfyUrl', h('input', { type: 'url', autocomplete: 'off', placeholder: 'http://127.0.0.1:8189' }))),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: async () => {
        if (!s.comfyUrl) { comfyMsg.textContent = 'Type your ComfyUI address first.'; return; }
        comfyMsg.textContent = 'Testing…';
        try { const list = await comfyModels(); if (!list.includes(s.comfyModel)) { s.comfyModel = list[0] || ''; save(); } comfyMsg.textContent = `✓ Connected. Pictures will be drawn on your PC with ${s.comfyModel || 'your model'}.`; } catch (e) { comfyMsg.textContent = comfyError(e); }
      } }, 'Test')), comfyMsg]],
    ui.setupMode === 'full' && ['use ComfyUI from your phone', () => [guide('phone'),
      ...field('ComfyUI address (your PC\'s https address)', bind('comfyUrl', h('input', { type: 'url', autocomplete: 'off', placeholder: 'https://your-pc.your-tailnet.ts.net' })))]],
    ui.setupMode === 'full' && ['the laptop helper', () => [guide('helper'), ...helperSettings(bind).slice(2, -1)]], // its address, Test button and result
    ['lock the app (optional)', () => lockKey ? [h('p', {}, '✓ App lock is on.'), h('div', { class: 'status', id: 'status' }, ui.status)] : lockSetup()],
  ].filter(Boolean);
  const last = step === steps.length - 1;
  return [h('p', { class: 'muted' }, ui.setupMode === 'full' ? 'Full setup. Do each step at your own pace; Skip moves on, and everything can be changed later in Settings.'
      : 'Welcome! A few quick choices, then you\'re writing. Everything here can be changed later in Settings.'),
    h('h2', {}, `Step ${step + 1} of ${steps.length}: ${steps[step][0]}`), steps[step][1](),
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: last ? finish : next }, last ? 'Start writing' : 'Next'),
      h('button', { class: 'btn ghost', onclick: () => { if (step > 0) ui.setupStep = step - 1; else ui.setupMode = null; render(); } }, 'Back'),
      !last && h('button', { class: 'btn ghost', onclick: finish }, 'Skip setup'))];
}

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
  return [
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
  return [backChip('All stories', () => go('stories')),
    h('h2', {}, story.title),
    h('p', { class: 'muted' }, [fmtDate(story.createdAt), (story.characterIds || []).map(charName).filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
    story.summary && h('p', { class: 'muted' }, story.summary),
    h('div', { class: 'row' }, listenBtn(story),
      (story.panels || []).length ? h('button', { class: 'btn ghost', onclick: () => { ui.comic = !ui.comic; render(); } }, ui.comic ? '📖 Read as text' : '🖼️ View comic')
        : h('button', { class: 'btn ghost', disabled: !!ui.drawing, onclick: () => makeComic(story) }, '🖼️ Make it a comic')),
    ui.comic && (story.panels || []).length ? [comicView(story),
      h('div', { class: 'row' },
        story.panels.some((p) => !p.img) && h('button', { class: 'btn', disabled: !!ui.drawing, onclick: () => makeComic(story) }, 'Draw missing panels'),
        h('button', { class: 'btn ghost', disabled: !!ui.drawing, onclick: () => { if (confirm('Plan and draw the whole comic again?')) makeComic(story, true); } }, 'Redo comic'))]
      : h('div', { class: 'prose' }, story.text),
    h('div', { class: 'status', id: 'status' }, ui.status),
    choiceRow(story),
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
  const aiFill = async () => {
    const j = startJob('Imagining a character', ['Writing their name, looks, personality and background']);
    if (!j) return;
    j.step(0, idea.value.trim() ? `Based on "${idea.value.trim()}", fitted to ${state.world.name}.` : `Someone who fits ${state.world.name}.`);
    try {
      const r = await chatJson(A.buildCharacterMessages(state, idea.value.trim()), { signal: j.signal });
      for (const k of ['name', 'appearance', 'personality', 'background']) if (r[k]) inputs[k].value = r[k];
      status.textContent = 'Review and Save.';
      j.end();
    } catch (err) { j.end(err); }
  };
  const saveChar = async () => {
    const vals = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
    if (!vals.name) { status.textContent = 'A name is required.'; return; }
    const target = c || { id: A.uid(), createdAt: Date.now() };
    Object.assign(target, vals, { portrait: draft.portrait || '', developments: dev.value.split('\n').map((x) => x.trim()).filter(Boolean) });
    if (!c) state.characters.push(target);
    await save(); go('characters');
  };
  // The voice picker for whichever narration is on: premium (Venice) or the browser's own.
  const pv = A.premiumVoices(state.settings.ttsModel);
  const voice = state.settings.ttsKey ? h('select', {}, h('option', { value: '' }, 'Automatic, matched to the character'), [...pv.f, ...pv.m].map((x) => h('option', { value: x, selected: x === draft.ttsVoice }, `${x} (${pv.f.includes(x) ? 'female' : 'male'})`)))
    : canSpeak && h('select', {}, h('option', { value: '' }, 'Automatic, matched to the character'), voiceOptions(draft.voice));
  if (voice) inputs[state.settings.ttsKey ? 'ttsVoice' : 'voice'] = voice;
  const hear = () => speak('voice', [{ text: `Hi, I'm ${inputs.name.value.trim() || 'new here'}.`, who: { ...draft, ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) } }]);
  const photo = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const who = photoAi() ? 'Google Gemini' : `your AI (${state.settings.model})`;
    const j = startJob('Describing from the photo', ['Shrinking the photo and removing its location data', `Asking ${who} how they look`, 'Filling in Appearance']);
    if (!j) return;
    try {
      j.step(0, 'The photo is made smaller on this device first, so it sends faster and carries no location or camera details.');
      const img = await shrinkImage(f);
      j.step(1, 'Only physical traits are described (hair, build, style), never who the person is. This usually takes 5 to 30 seconds.');
      const r = await chatJson(A.buildPhotoMessages(img), { use: photoAi(), signal: j.signal });
      if (!r.appearance) throw new Error('No description came back. Try another photo.');
      j.step(2);
      inputs.appearance.value = r.appearance;
      status.textContent = 'Appearance filled in. Review and Save. The photo itself is not kept.';
      j.end();
    } catch (err) { j.end(/image|vision|modalit/i.test(err.message) ? new Error(err.message + '\nThis model may not read photos. Add a free Gemini key under Settings → Photo AI.') : err); }
  } });
  // Portrait: drawn free by AI Horde from the Appearance box, or the user's own picture. Stored on the character (on this device only).
  const face = h('img', { class: 'portrait', alt: '', hidden: !draft.portrait, src: draft.portrait || null });
  const setFace = async (img) => {
    draft.portrait = face.src = img || ''; face.hidden = !img;
    if (c) { c.portrait = draft.portrait; await save(); }
  };
  const drawFace = async () => {
    if (!canDraw()) { status.textContent = PRIVATE_PICTURES; return; }
    const name = inputs.name.value.trim();
    const j = startJob(`Drawing ${name || 'the portrait'}`, [`Sending their look to ${artist()}`, 'Drawing the portrait']);
    if (!j) return;
    j.step(0, state.settings.comfyUrl ? 'Your PC usually takes a few seconds.' : 'AI Horde is free and run by volunteers, so this can take a minute or more. Only the Appearance box is sent, never their name or your stories.');
    try {
      await setFace(await drawImage(A.portraitPrompt({ ...draft, appearance: inputs.appearance.value.trim() }),
        (q) => j.step(1, [`Drawing on ${artist()}.`, waitText(q), comfyNote.trim()].filter(Boolean).join('\n')), { width: 512, height: 512, nsfw: false, signal: j.signal }));
      status.textContent = c ? 'Portrait saved.' : 'Portrait ready. Tap Save to keep it.';
      j.end();
    } catch (err) { j.end(err); }
  };
  const own = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { await setFace(await shrinkImage(f, 512)); status.textContent = c ? 'Portrait saved.' : 'Tap Save to keep it.'; } catch (err) { status.textContent = 'Could not read that picture.'; }
  } });
  const appearsIn = c ? state.stories.filter((s) => (s.characterIds || []).includes(c.id)) : [];
  return [backChip('Cast', () => go('characters')),
    h('h2', {}, c ? c.name : 'New character'),
    !c && box('✨ Let the AI fill it in', idea, h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: aiFill }, '✨ Fill in with AI'))),
    c && h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => startChat(c.id) }, `💬 Chat with ${c.name}`)),
    box('Portrait', face,
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: drawFace }, '🎨 Draw portrait'),
        h('button', { class: 'btn ghost', onclick: () => own.click() }, '🖼️ Use my own picture'), own,
        h('button', { class: 'btn ghost', onclick: () => { setFace(''); status.textContent = c ? 'Portrait removed.' : ''; } }, 'Remove picture'))),
    box('Who they are', ...mk('name', 'Name'), ...mk('appearance', 'Appearance', true),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => photo.click() }, '📷 Describe from a photo'), photo),
      h('p', { class: 'muted' }, 'Fills in how they look (hair, build, style). Only physical traits are described, never who the person is. The photo is sent to your AI provider and not saved.'), ...mk('personality', 'Personality', true), ...mk('background', 'Background', true)),
    h('details', { class: 'box' }, h('summary', {}, `Story developments (${(draft.developments || []).length})`),
      ...field('Added automatically after each story, one per line', dev)),
    voice && box('Voice', ...field('When stories are read aloud', voice), h('div', { class: 'row' }, h('button', { class: 'btn ghost', id: 'listen', onclick: hear }, listenLabel('voice')))),
    status,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: saveChar }, 'Save'),
      c && h('button', { class: 'btn ghost', onclick: () => download(JSON.stringify(A.exportCharacter(c), null, 2), `${c.name.replace(/[^\w-]+/g, '-')}.json`) }, 'Export'),
      c && A.worldNames(c, state).length > 1 && h('button', { class: 'btn ghost', onclick: async () => { A.removeFromWorld(state, c.id); ui.selected = ui.selected.filter((x) => x !== c.id); await save(); go('characters'); } }, 'Remove from this world'),
      c && h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`Delete ${c.name}${A.worldNames(c, state).length > 1 ? ' from every world' : ''}?`)) return; state.characters = state.characters.filter((x) => x !== c); ui.selected = ui.selected.filter((x) => x !== c.id); await save(); go('characters'); } }, 'Delete')),
    appearsIn.length > 0 && [h('h2', {}, 'Appears in'), appearsIn.map((s) => h('div', { class: 'card', onclick: () => openStory(s) }, h('h3', {}, (s.chat ? '💬 ' : '') + s.title), h('p', {}, s.summary || '')))]];
}

// Choose (or change) the 6-digit PIN: type it, type it again, done.
const easyPin = (p) => /^(\d)\1+$/.test(p) || '01234567890'.includes(p) || '09876543210'.includes(p);
function lockSetup(change) {
  let first = null;
  const title = h('h3', { class: 'center' }, change ? 'Choose a new 6-digit PIN' : 'Choose a 6-digit PIN');
  const msg = h('div', { class: 'muted center', 'aria-live': 'polite' });
  const pad = pinPad(async (pin) => {
    if (first === null) {
      if (easyPin(pin)) { msg.textContent = 'That one\'s easy to guess. Pick another.'; pad.bad(); return; }
      first = pin; title.textContent = 'Type it again'; msg.textContent = ''; return;
    }
    if (pin !== first) { first = null; title.textContent = change ? 'Choose a new 6-digit PIN' : 'Choose a 6-digit PIN'; msg.textContent = 'Those didn\'t match. Start again.'; pad.bad(); return; }
    msg.textContent = 'Encrypting your library…';
    await setLock(pin);
    ui.changingPin = false; ui.status = change ? 'PIN changed.' : ''; render();
  });
  return [!change && h('p', { class: 'muted' }, 'Encrypts your stories, characters, world and keys on this device. Anyone opening the app, or copying the browser\'s files, sees only scrambled data. If you forget the PIN, your stories can\'t be recovered, so keep a backup and your key file somewhere safe.'),
    title, ...pad.nodes, msg];
}
const LOCK_AFTER = [[0, 'Right away'], [1, 'After 1 minute'], [5, 'After 5 minutes'], [15, 'After 15 minutes'], [60, 'After 1 hour']];
const lockAfter = () => (Number.isFinite(state.settings.lockAfter) ? state.settings.lockAfter : 5);

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
  ui.lockStyle = await kv('lockStyle').catch(() => null);
  kv('faceId', null).catch(() => {}); // Face ID unlock was removed: drop the PIN it kept sealed
  if (A.isLocked(saved)) ui.locked = saved; else state = A.normalizeState(saved);
  // Blur the screen when the app is hidden, so the app switcher preview doesn't show a story. Best effort: browsers decide when they snapshot.
  // With the lock on, coming back after the chosen time (Settings → App lock, 5 minutes unless changed) reloads, which drops the key and the library from memory.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('hide', document.hidden);
    // Save what's running, so if iPhone closes the app while it's away, resumeCut picks it up next time.
    if (document.hidden) { hiddenAt = Date.now(); hides++; if (job || ui.busy) save(); }
    else if (lockKey && Date.now() - hiddenAt >= lockAfter() * 60e3) location.reload();
  });
  // Anything that slips past a try/catch still shows up instead of failing silently.
  addEventListener('unhandledrejection', (e) => setStatus('Error: ' + ((e.reason && e.reason.message) || e.reason)));
  // Ask the browser not to clear the library when space runs low or the app goes unused for a while.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (canAutoBackup) ui.backupName = ((await backupFile()) || {}).name || '';
  render();
  if (!ui.locked) resumeCut();
  if (canSpeak) speechSynthesis.addEventListener('voiceschanged', () => { if (ui.view === 'settings') render(); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

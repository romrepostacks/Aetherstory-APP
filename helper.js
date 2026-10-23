// Aetherstory laptop helper: writes stories and draws comics on your PC so the phone can leave the app midway.
// Start it with the app's address:  node helper.js https://romrepostacks.github.io/Aetherstory-APP/
// It listens on 127.0.0.1:8190 only; `tailscale serve --bg --set-path /helper 8190` makes it reachable from your own devices.
// No packages needed (Node 18 or newer). The story steps come from the app's own lib.js, fetched from the app's address,
// so the helper always writes exactly like the app. Jobs live in memory only and are gone once the phone picks them up.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP = (process.argv[2] || '').replace(/\/?$/, '/');
const PORT = Number(process.env.PORT) || 8190;
if (!/^https?:\/\//.test(APP)) { console.error('Start it with the app\'s address, like: node helper.js https://romrepostacks.github.io/Aetherstory-APP/'); process.exit(1); }
const ORIGIN = new URL(APP).origin;

// The paired devices' secrets and the notification key pair, kept next to this file.
const KEYS = path.join(__dirname, 'helper-keys.json');
const keys = fs.existsSync(KEYS) ? JSON.parse(fs.readFileSync(KEYS, 'utf8')) : {};
if (!keys.vapid) {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  keys.vapid = privateKey.export({ format: 'jwk' });
}
keys.secrets = keys.secrets || [];
const STARTED = Date.now();
const saveKeys = () => fs.writeFileSync(KEYS, JSON.stringify(keys, null, 2));
saveKeys();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const vapidPublic = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(keys.vapid.x, 'base64url'), Buffer.from(keys.vapid.y, 'base64url')]));
const vapidKey = crypto.createPrivateKey({ key: keys.vapid, format: 'jwk' });

// The app's lib.js, fetched fresh for each story so app updates reach the helper by themselves; the last good copy is kept.
let lib = null;
async function loadLib() {
  try {
    const res = await fetch(APP + 'lib.js?' + Date.now());
    if (!res.ok) throw new Error(res.status);
    const mod = { exports: {} };
    new Function('module', 'exports', await res.text())(mod, mod.exports);
    lib = mod.exports;
  } catch (e) { if (!lib) throw new Error(`The helper couldn't load the app from ${APP} (${e.message}).`); }
  return lib;
}

// A web push with no message: the phone's sw.js shows a fixed "story ready", so no story text goes to Apple or Google.
async function notify(sub) {
  if (!sub || !sub.endpoint) return;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://github.com/romrepostacks/Aetherstory-APP' }));
  const sig = b64u(crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: vapidKey, dsaEncoding: 'ieee-p1363' }));
  const res = await fetch(sub.endpoint, { method: 'POST', headers: { TTL: '3600', Urgency: 'high', Authorization: `vapid t=${head}.${body}.${sig}, k=${vapidPublic}` } }).catch((e) => ({ status: e.message }));
  if (res.status >= 300 || typeof res.status === 'string') console.log(`Notification not sent (${res.status}).`);
}

// Same retry rules as the app: free models get busy, so try again on 429/5xx unless text already streamed in.
async function chat(s, messages, { onToken, sofar = '', signal, stream = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    let got = '';
    try { return sofar + await lib.ask(s, lib.carryOn(messages, sofar), { signal, stream, onToken: (t) => { got += t; if (onToken) onToken(t); } }); } catch (e) {
      if (signal.aborted || !e.retry || got || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
}

// Pictures drawn here go back to the phone as they are (ComfyUI already sends them at 768px); the phone shrinks them to JPEG.
const PIC_ENV = { fetch: (...a) => fetch(...a), poll: (...a) => fetch(...a),
  pause: (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true }); }),
  toImage: async (blob) => `data:${blob.type || 'image/png'};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}` };

const jobs = new Map();
async function run(job, { kind = 'story', state, storyId, cut, push }) {
  const A = await loadLib();
  const story = state.stories.find((x) => x.id === storyId);
  if (!story) throw new Error('The story was missing from the job.');
  const signal = job.ctl.signal, s = state.settings;
  job.cut = cut;
  const io = { signal, save: async () => {},
    step: (i, detail = '') => Object.assign(job, { step: i, detail, frac: 0 }), note: (detail, frac) => Object.assign(job, { detail }, frac === undefined ? {} : { frac }),
    text: (t) => { job.text = t; },
    chat: (m, o) => chat(s, m, { ...o, signal }), json: async (m) => A.parseJsonLoose(await chat(s, m, { signal, stream: false })),
    draw: (prompt, onWait, opts) => A.drawPicture(s, prompt, onWait, opts, PIC_ENV), models: () => A.comfyModels(s, PIC_ENV),
    landed: (p) => { if (p) job.imgs.push({ i: story.panels.indexOf(p), img: p.img }); job.story = story; } };
  job.imgs = []; job.story = story;
  // The phone's ComfyUI address is usually this PC's own Tailscale https name, which a PC can't always reach from itself.
  // Then use ComfyUI on this PC directly (ComfyUI's usual port, then the guide's), instead of falling back to AI Horde's different models.
  if (kind === 'comic' && s.comfyUrl) {
    for (const url of [s.comfyUrl, 'http://127.0.0.1:8188', 'http://127.0.0.1:8189']) {
      try { await A.comfyModels({ ...s, comfyUrl: url }, PIC_ENV); if (url !== s.comfyUrl) console.log(`Drawing on ComfyUI at ${url}.`); s.comfyUrl = url; break; } catch (e) { /* try the next */ }
    }
  }
  try {
    job.status = kind === 'comic' ? await A.comicJob(state, story, cut, io) : await A.storyJob(state, story, cut, io);
    // A comic's panels and pictures already went over in the progress reports; only the seed and the characters' body tags are left.
    job.result = kind === 'comic' ? { story: { seed: story.seed }, world: {}, characters: state.characters } : { story, world: state.world, characters: state.characters };
    job.done = true;
    console.log(`${kind === 'comic' ? 'Comic' : 'Story'} "${story.title}" done.`);
  } catch (e) {
    if (signal.aborted) return;
    job.error = e.message;
    console.log(`${kind === 'comic' ? 'Comic' : 'Story'} failed: ${e.message}`);
  }
  job.ended = Date.now();
  await notify(push);
}
// Finished jobs the phone never collected are dropped after a day.
setInterval(() => { for (const [id, j] of jobs) if (j.ended && Date.now() - j.ended > 24 * 3600e3) jobs.delete(id); }, 3600e3).unref();

const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.end();
  if (req.headers.origin && req.headers.origin !== ORIGIN) return send(res, 403, { error: 'This helper only works for ' + ORIGIN });
  const route = new URL(req.url, 'http://x').pathname.replace(/^\/helper/, '') || '/';
  // Pairing: each device's app makes its own random secret. A new one is accepted only in the first 10 minutes after the
  // helper starts (or while nothing is paired yet); after that only paired devices get in.
  const secret = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (secret.length < 20) return send(res, 401, { error: 'Missing pairing secret.' });
  const known = keys.secrets.some((k) => k.length === secret.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(secret)));
  if (!known) {
    if (keys.secrets.length && Date.now() - STARTED > 10 * 60e3) return send(res, 401, { error: 'This device isn\'t paired with the helper yet. Close the helper window on your PC, start it again, then tap Test within 10 minutes.' });
    keys.secrets.push(secret); saveKeys(); console.log(`Paired a device (${keys.secrets.length} paired).`);
  }

  if (req.method === 'GET' && route === '/hello') return send(res, 200, { ok: true, name: require('os').hostname(), vapid: vapidPublic, kinds: ['story', 'comic'] });
  if (req.method === 'POST' && route === '/jobs') {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 20e6) return send(res, 413, { error: 'too big' }); }
    let body;
    try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'bad job' }); }
    const id = crypto.randomUUID();
    const job = { ctl: new AbortController(), step: 0, detail: 'Starting.', frac: 0, text: null, cut: body.cut, imgs: [] };
    jobs.set(id, job);
    run(job, body).catch((e) => { job.error = e.message; job.ended = Date.now(); });
    console.log(body.kind === 'comic' ? 'Drawing a comic for your phone.' : 'Writing a story for your phone.');
    return send(res, 200, { id });
  }
  const m = route.match(/^\/jobs\/([\w-]+)$/);
  const job = m && jobs.get(m[1]);
  if (m && !job) return send(res, 404, { error: 'No such job (the helper may have restarted).' });
  if (job && req.method === 'GET') {
    // A comic report carries its panel plan without pictures ('kept' = the phone had it, 'drawn' = sent in imgs), plus the pictures
    // drawn since the phone's last report (?since=N).
    const { step, detail, frac, text, cut, done, status, error, result } = job;
    const panels = job.story && job.story.panels && job.story.panels.map((p) => ({ ...p, img: p.img === 'kept' ? 'kept' : p.img ? 'drawn' : '' }));
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
    return send(res, 200, { step, detail, frac, text, cut, stage: cut && cut.stage, done: !!done, status, error, panels, imgs: job.imgs.slice(since), result: done ? result : undefined });
  }
  if (job && req.method === 'DELETE') { job.ctl.abort(); jobs.delete(m[1]); return send(res, 200, { ok: true }); }
  send(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`Aetherstory helper ready on port ${PORT} for ${APP}\nLeave this window open. Stories your phone sends show up here.`));

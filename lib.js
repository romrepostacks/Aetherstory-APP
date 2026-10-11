// Pure logic: prompt building, world merging, parsing. No DOM, so node can test it.
(function (root) {
  const LENGTHS = { short: 800, medium: 1500, long: 3000 };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function emptyState() {
    return {
      settings: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        temperature: 0.9,
        style: '',
        mature: true,
        privateOnly: false,
        ageOk: false,
        voice: '',
        rate: 1,
      },
      characters: [],
      stories: [],
      world: { name: 'My World', overview: '', lore: [], places: [], relationships: [], timeline: [] },
      revisions: [],
    };
  }

  // Models that stopped being offered under a saved id; swapped on load so old settings keep working.
  const RETIRED = { 'venice/uncensored:free': 'nvidia/nemotron-3-ultra-550b-a55b:free' };
  const BUILTIN = 'builtin'; // the removed on-device model; saved setups fall back to the default

  // Fill in anything missing so old exports / partial imports still load.
  function normalizeState(s) {
    const base = emptyState();
    s = s || {};
    return {
      settings: Object.assign(base.settings, s.settings,
        RETIRED[s.settings && s.settings.model] ? { model: RETIRED[s.settings.model] } : {},
        s.settings && s.settings.baseUrl === BUILTIN ? { baseUrl: base.settings.baseUrl, model: base.settings.model } : {}),
      characters: Array.isArray(s.characters) ? s.characters : [],
      stories: Array.isArray(s.stories) ? s.stories : [],
      world: Object.assign(base.world, s.world),
      revisions: Array.isArray(s.revisions) ? s.revisions : [],
    };
  }

  function describeCharacter(c) {
    const lines = [`### ${c.name}`];
    for (const k of ['appearance', 'personality', 'background']) if (c[k]) lines.push(`${k[0].toUpperCase() + k.slice(1)}: ${c[k]}`);
    if (c.developments && c.developments.length) lines.push('Story so far: ' + c.developments.slice(-12).join(' '));
    return lines.join('\n');
  }

  // "Mira & Kell: rivals" -> "kell&mira", so a newer entry for the same pair replaces the old one.
  function pairKey(r) {
    const i = r.indexOf(':');
    return i < 0 ? null : r.slice(0, i).toLowerCase().split(/\s*(?:&|\band\b|,|\/)\s*/).map((s) => s.trim()).filter(Boolean).sort().join('&');
  }
  // Latest entry per pair wins (older libraries stored every past state).
  function currentRelationships(list) {
    const out = [];
    for (const r of list || []) {
      const k = pairKey(r);
      const i = k ? out.findIndex((x) => pairKey(x) === k) : -1;
      if (i >= 0) out.splice(i, 1);
      out.push(r);
    }
    return out;
  }

  function describeWorld(w) {
    const out = [`World: ${w.name || 'Unnamed'}`];
    if (w.overview) out.push(w.overview);
    for (const k of ['lore', 'places', 'relationships', 'timeline']) {
      const items = (k === 'relationships' ? currentRelationships(w[k]) : w[k] || []).slice(-40);
      if (items.length) out.push(`${k[0].toUpperCase() + k.slice(1)}:\n- ` + items.join('\n- '));
    }
    return out.join('\n\n');
  }

  // Past stories that share a character with this one, newest last.
  function relatedStories(state, characterIds, excludeId, limit = 10) {
    const ids = new Set(characterIds);
    return state.stories
      .filter((s) => s.id !== excludeId && s.summary && (!ids.size || (s.characterIds || []).some((id) => ids.has(id))))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-limit);
  }

  function buildStoryMessages(state, { characterIds = [], premise = '', length = 'medium', continueStory = null, pov = '' }) {
    const chars = state.characters.filter((c) => characterIds.includes(c.id));
    const past = relatedStories(state, characterIds, continueStory && continueStory.id);
    const system = [
      'You are a skilled fiction author writing an ongoing series set in one shared world.',
      'Keep characters, places and past events consistent with the series bible below. Build on earlier stories naturally (callbacks, evolving relationships) without recapping them.',
      'Write vivid prose with dialogue. Output only the story text: no preface, no notes, no title line.',
      state.settings.mature ? 'This is private adult fiction for a consenting adult reader. Sexual content is wanted: when the story calls for it, write it explicitly and in vivid detail instead of fading to black or softening it into a sweet romance.' : '',
      state.settings.style ? `Author guidelines from the reader: ${state.settings.style}` : '',
      '\n## Series bible\n' + describeWorld(state.world),
      chars.length ? '\n## Characters in this story\n' + chars.map(describeCharacter).join('\n\n') : '',
      past.length ? '\n## Earlier stories (oldest first)\n' + past.map((s) => `- ${s.title}: ${s.summary}`).join('\n') : '',
    ].filter(Boolean).join('\n');

    const words = LENGTHS[length] || LENGTHS.medium;
    // Repeated in the user turn: small on-device models skim the long system prompt and invent their own cast.
    const cast = chars.length ? ` The main characters are ${chars.map((c) => c.personality ? `${c.name} (${c.personality.split(/[.\n]/)[0].trim()})` : c.name).join(', ')}, ` +
      'existing characters from the series bible. Use them by these exact names and stay true to their descriptions; do not replace them with new characters.' : '';
    // Same reason: their relationships as they stand now, so the story picks up where the last one left off.
    const mentions = (text, c) => new RegExp(`\\b${c.name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    const rels = currentRelationships(state.world.relationships).filter((r) => chars.some((c) => mentions(r.slice(0, Math.max(r.indexOf(':'), 0)), c)));
    // Ties people wrote into a profile ("Wife of Ben") count too: any sentence naming another character in this story.
    for (const c of chars) {
      for (const line of `${c.background || ''}\n${c.personality || ''}`.split(/(?<=[.!?])\s+|\n/)) {
        if (line.trim() && chars.some((o) => o !== c && mentions(line, o))) rels.push(`${c.name}: ${line.trim().replace(/[.!?]$/, '')}`);
      }
    }
    const bonds = rels.length ? ` Their relationships right now (keep these consistent and let them evolve naturally): ${rels.join('; ')}.` : '';
    const narrator = state.characters.find((c) => c.id === pov);
    const voice = narrator ? ` Write it in first person from ${narrator.name}'s point of view: only what ${narrator.name} sees, thinks and feels.` : '';
    const guide = cast + bonds + voice;
    let user;
    if (continueStory) {
      user = `Here is the end of the story so far:\n\n"""${continueStory.text.slice(-6000)}"""\n\nContinue the story directly from where it stops for about ${words} words.${guide}` +
        (premise ? ` Direction for this part: ${premise}` : '');
    } else {
      user = `Write a new story of about ${words} words` +
        (chars.length ? ` featuring ${chars.map((c) => c.name).join(', ')}` : '') + '. ' +
        (premise ? `Premise: ${premise}` : 'Choose a fresh premise that fits the world and moves these characters forward.') + guide;
    }
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildWorldUpdateMessages(state, story) {
    const names = state.characters.map((c) => c.name).join(', ') || '(none yet)';
    const system = 'You maintain the continuity bible for a fiction series. Reply with JSON only, no markdown.';
    const user = `Current bible:\n${describeWorld(state.world)}\n\nKnown characters: ${names}\n\nNew story:\n"""${story.text.slice(-24000)}"""\n\n` +
      'Return JSON with exactly these keys:\n' +
      '{"title": "short evocative title", "summary": "2-3 sentence summary of what happened",\n' +
      ' "characterUpdates": [{"name": "known character", "development": "one sentence on what changed for them or what we learned"}],\n' +
      ' "newCharacters": [{"name": "", "appearance": "", "personality": "", "background": ""}],\n' +
      ' "lore": ["new world facts"], "places": ["Name: description"], "relationships": ["A & B: state of their relationship"], "timeline": ["event in one line"]}\n' +
      'relationships: for every pair whose relationship changed or was revealed in this story, give its CURRENT state (it replaces the old entry), e.g. "Mira & Kell: wary allies after the storm, unspoken attraction".\n' +
      'Otherwise only include NEW information not already in the bible. newCharacters only for named recurring-worthy characters not in the known list. Use empty arrays when nothing is new.';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildCharacterMessages(state, idea) {
    const system = 'You create characters for a fiction series. Reply with JSON only, no markdown.';
    const user = `Series bible:\n${describeWorld(state.world)}\n\nExisting characters: ${state.characters.map((c) => c.name).join(', ') || '(none)'}\n\n` +
      `Create one new character${idea ? ` based on this idea: ${idea}` : ' who would fit this world and create interesting stories with the existing cast'}.\n` +
      'Return {"name": "", "appearance": "", "personality": "", "background": ""} with 1-3 sentences per field.';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildQuickstartMessages(vibe) {
    const system = 'You design settings for fiction series. Reply with JSON only, no markdown.';
    const user = `Invent a story world and a starting cast${vibe ? ` from this idea: ${vibe}` : ' with strong potential for character-driven, emotional stories'}.\n` +
      'Return {"name": "world name", "overview": "one paragraph", "lore": ["3-5 facts"], "places": ["Name: description" x3],\n' +
      ' "characters": [{"name": "", "appearance": "", "personality": "", "background": ""} x2-3], "relationships": ["A & B: how they relate"]}';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  // Mutates state with a freshly generated world + cast. Returns the new characters.
  function applyQuickstart(state, q) {
    const w = state.world;
    if (str(q.name)) w.name = str(q.name);
    if (str(q.overview)) w.overview = str(q.overview);
    for (const k of ['lore', 'places', 'relationships']) mergeList(w[k], strList(q[k]));
    const added = [];
    for (const c of Array.isArray(q.characters) ? q.characters : []) {
      if (!c || !str(c.name) || state.characters.some((x) => x.name.toLowerCase() === str(c.name).toLowerCase())) continue;
      const nc = { id: uid(), name: str(c.name), appearance: str(c.appearance), personality: str(c.personality), background: str(c.background), developments: [], createdAt: Date.now() };
      state.characters.push(nc);
      added.push(nc);
    }
    return added;
  }

  // Models sometimes wrap JSON in prose or ``` fences; grab the outermost object.
  function parseJsonLoose(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON object in model reply');
    return JSON.parse(text.slice(start, end + 1));
  }

  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  function mergeList(list, items) {
    const seen = new Set(list.map((x) => x.toLowerCase()));
    for (const it of items) if (!seen.has(it.toLowerCase())) { list.push(it); seen.add(it.toLowerCase()); }
  }
  // Like mergeList, but a pair's new state replaces its old one. Returns how many entries changed.
  function mergeRelationships(list, items) {
    let n = 0;
    for (const it of items) {
      if (list.some((x) => x.toLowerCase() === it.toLowerCase())) continue;
      const k = pairKey(it);
      for (let i = list.length - 1; i >= 0; i--) if (k && pairKey(list[i]) === k) list.splice(i, 1);
      list.push(it); n++;
    }
    return n;
  }

  // Mutates state. Returns a short human summary of what changed.
  function applyWorldUpdate(state, story, u) {
    const changes = [];
    if (str(u.title)) story.title = str(u.title);
    if (str(u.summary)) story.summary = str(u.summary);
    const byName = (n) => state.characters.find((c) => c.name.toLowerCase() === n.toLowerCase());

    for (const cu of Array.isArray(u.characterUpdates) ? u.characterUpdates : []) {
      const c = cu && byName(str(cu.name));
      if (c && str(cu.development)) {
        const before = (c.developments = c.developments || []).length;
        mergeList(c.developments, [str(cu.development)]);
        if (c.developments.length > before) changes.push(`${c.name} developed`);
      }
    }
    for (const nc of Array.isArray(u.newCharacters) ? u.newCharacters : []) {
      const name = nc && str(nc.name);
      if (!name || byName(name)) continue;
      const c = { id: uid(), name, appearance: str(nc.appearance), personality: str(nc.personality), background: str(nc.background), developments: [], createdAt: Date.now() };
      state.characters.push(c);
      if (!story.characterIds.includes(c.id)) story.characterIds.push(c.id);
      changes.push(`new character ${name}`);
    }
    for (const k of ['lore', 'places', 'timeline']) {
      const before = state.world[k].length;
      mergeList(state.world[k], strList(u[k]));
      if (state.world[k].length > before) changes.push(`${state.world[k].length - before} ${k}`);
    }
    const rel = mergeRelationships(state.world.relationships, strList(u.relationships));
    if (rel) changes.push(`${rel} relationships`);
    return changes;
  }

  // ---------- world revision: one plain-words change, applied to the cast, the bible and every saved story ----------
  const SHEET = ['appearance', 'personality', 'background'];
  const WORLD_LISTS = ['lore', 'places', 'relationships', 'timeline'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const copy = (v) => JSON.parse(JSON.stringify(v));

  function buildReviseSheetMessages(state, revision) {
    const system = 'You maintain the continuity bible for a fiction series. The author has changed a fact. Reply with JSON only, no markdown.';
    const chars = state.characters.map((c) => JSON.stringify({ name: c.name, appearance: c.appearance || '', personality: c.personality || '', background: c.background || '', developments: c.developments || [] })).join('\n');
    const w = state.world;
    const user = `Characters:\n${chars || '(none)'}\n\nWorld:\n${JSON.stringify({ overview: w.overview, lore: w.lore, places: w.places, relationships: w.relationships, timeline: w.timeline })}\n\n` +
      `The author's change, which is now true and always was: "${revision}"\n\n` +
      'Rewrite only what contradicts the change, and add the change where it belongs so future stories follow it. Return JSON:\n' +
      '{"characters": [{"name": "exact existing name", "appearance": "", "personality": "", "background": "", "developments": ["full list"]}],\n' +
      ' "world": {"overview": "", "lore": ["full list"], "places": ["full list"], "relationships": ["full list"], "timeline": ["full list"]},\n' +
      ' "affected": ["names of every character the change is about"]}\n' +
      'Include only the fields that change, each with its complete new value, and leave every other field out. A list you return replaces the old one, so keep its other items exactly as they were.';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildReviseStoryMessages(story, revision) {
    const system = 'You are a continuity editor for a fiction series. The author has changed a fact. Reply with JSON only, no markdown.';
    const user = `The author's change, which is now true and always was: "${revision}"\n\nStory "${story.title}":\n"""${story.text}"""\n\nSummary: ${story.summary || '(none)'}\n\n` +
      'Find every passage that contradicts the change and rewrite it so the story agrees, changing as little as possible and keeping the style. Return JSON:\n' +
      '{"edits": [{"find": "exact text copied from the story, long enough to be unique", "replace": "the corrected text"}], "summary": "corrected summary, or empty if it needs no change"}\n' +
      'Use an empty edits list if nothing in the story contradicts the change.';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  // Applies exact-text edits. An edit whose text isn't in the story is skipped, so a misquote can't garble it.
  function applyEdits(text, edits) {
    const applied = [];
    for (const e of Array.isArray(edits) ? edits : []) {
      const find = e && typeof e.find === 'string' ? e.find : '';
      if (!find.trim() || typeof e.replace !== 'string' || !text.includes(find)) continue;
      text = text.split(find).join(e.replace);
      applied.push({ find, replace: e.replace });
    }
    return { text, applied };
  }

  // The model's sheet reply as a plan: only real changes to existing characters and world fields.
  function sheetChanges(state, r) {
    r = r || {};
    const characters = [];
    for (const rc of Array.isArray(r.characters) ? r.characters : []) {
      const c = rc && state.characters.find((x) => x.name.toLowerCase() === str(rc.name).toLowerCase());
      if (!c) continue;
      const set = {};
      for (const k of SHEET) if (str(rc[k]) && str(rc[k]) !== (c[k] || '')) set[k] = str(rc[k]);
      if (Array.isArray(rc.developments) && !same(strList(rc.developments), c.developments || [])) set.developments = strList(rc.developments);
      if (Object.keys(set).length) characters.push({ id: c.id, name: c.name, set });
    }
    const world = {};
    const rw = r.world && typeof r.world === 'object' ? r.world : {};
    if (str(rw.overview) && str(rw.overview) !== state.world.overview) world.overview = str(rw.overview);
    for (const k of WORLD_LISTS) if (Array.isArray(rw[k]) && !same(strList(rw[k]), state.world[k])) world[k] = strList(rw[k]);
    return { characters, world, affected: strList(r.affected).concat(characters.map((c) => c.name)) };
  }

  // Stories to check: those featuring or naming an affected character, or every story when the change isn't about anyone.
  function storiesForRevision(state, affected) {
    const people = state.characters.filter((c) => affected.some((n) => n.toLowerCase() === c.name.toLowerCase()));
    if (!people.length) return state.stories.slice();
    const named = (s, c) => new RegExp(`\\b${c.name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s.text || '');
    return state.stories.filter((s) => people.some((c) => (s.characterIds || []).includes(c.id) || named(s, c)));
  }

  // Mutates state with a reviewed plan and keeps what it replaced, so undoRevision can put it back.
  function applyRevision(state, plan) {
    const before = { characters: {}, world: {}, stories: {} };
    for (const pc of plan.characters) {
      const c = state.characters.find((x) => x.id === pc.id);
      if (!c) continue;
      before.characters[c.id] = {};
      for (const k of Object.keys(pc.set)) before.characters[c.id][k] = c[k] === undefined ? (k === 'developments' ? [] : '') : copy(c[k]);
      Object.assign(c, copy(pc.set));
    }
    for (const k of Object.keys(plan.world)) { before.world[k] = copy(state.world[k]); state.world[k] = copy(plan.world[k]); }
    for (const ps of plan.stories) {
      const s = state.stories.find((x) => x.id === ps.id);
      if (!s) continue;
      before.stories[s.id] = { text: s.text, summary: s.summary || '' };
      s.text = ps.text;
      if (ps.summary) s.summary = ps.summary;
    }
    const rec = { id: uid(), text: plan.revision, at: Date.now(), before };
    // ponytail: undo keeps the old text of every edited story, so only the last 5 revisions are kept.
    state.revisions = [rec].concat(state.revisions || []).slice(0, 5);
    return rec;
  }

  // Puts back what the most recent revision changed.
  function undoRevision(state) {
    const rec = (state.revisions || [])[0];
    if (!rec) return null;
    for (const [id, fields] of Object.entries(rec.before.characters)) Object.assign(state.characters.find((c) => c.id === id) || {}, fields);
    Object.assign(state.world, rec.before.world);
    for (const [id, old] of Object.entries(rec.before.stories)) Object.assign(state.stories.find((s) => s.id === id) || {}, old);
    state.revisions = state.revisions.slice(1);
    return rec;
  }

  // Narration: browsers (Chrome especially) cut off long utterances, so speak sentence-sized pieces of at most `max` chars.
  function speechChunks(text, max = 200) {
    const out = [];
    let para = true; // a new paragraph always starts a new piece, so the voice pauses there
    for (const sentence of (text || '').match(/[^.!?\n]+[.!?]*["'”’)]*|\n+/g) || []) {
      let rest = sentence.trim();
      while (rest.length > max) {
        const cut = rest.lastIndexOf(' ', max) > 0 ? rest.lastIndexOf(' ', max) : max;
        out.push(rest.slice(0, cut)); rest = rest.slice(cut).trim();
      }
      if (!rest) { para = true; continue; }
      if (!para && out[out.length - 1].length + rest.length + 1 <= max) out[out.length - 1] += ' ' + rest;
      else out.push(rest);
      para = false;
    }
    return out;
  }

  // Splits a story into narration and quoted dialogue. Each quote's speaker is the character named closest to it in the same paragraph.
  // ponytail: name-proximity guess ("she said" lines with no name nearby go to the narrator); ask the AI to tag speakers if it misfires a lot.
  function speechParts(text, characters = []) {
    const names = characters.flatMap((c) => (c.name || '').split(/\s+/).filter((n) => n.length > 1)
      .map((n) => [new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), c.id]));
    const nearest = (str, fromEnd) => {
      let best = null, dist = Infinity;
      for (const [re, id] of names) for (const m of str.matchAll(re)) {
        const d = fromEnd ? str.length - m.index - m[0].length : m.index;
        if (d < dist) { dist = d; best = id; }
      }
      return [best, dist];
    };
    const parts = [];
    for (const para of (text || '').split(/\n\s*\n/)) {
      const pieces = para.split(/("[^"\n]+"|“[^”\n]+”)/); // odd indexes are the quotes
      pieces.forEach((p, i) => {
        if (!p.trim()) return;
        let id = null;
        if (i % 2) {
          const [after, da] = nearest(pieces[i + 1] || '', false), [before, db] = nearest(pieces[i - 1] || '', true);
          id = da <= db ? after : before;
        }
        parts.push({ text: p.trim(), id });
      });
    }
    return parts;
  }
  // Guesses from the pronouns in a character's sheet: 'f', 'm' or null.
  function characterGender(c) {
    const t = [c.appearance, c.personality, c.background, ...(c.developments || [])].join(' ').toLowerCase();
    const f = (t.match(/\b(she|her|hers|herself)\b/g) || []).length, m = (t.match(/\b(he|him|his|himself)\b/g) || []).length;
    return f > m ? 'f' : m > f ? 'm' : null;
  }
  // Browsers don't say a voice's gender, so go by the names the common Apple, Microsoft and Google voices use.
  const FEMALE_VOICE = /female|samantha|\bava\b|allison|susan|victoria|karen|moira|tessa|fiona|serena|kate|zoe|nicky|joelle|aria|jenny|michelle|emma|sonia|libby|natasha|clara|zira|hazel|heera|catherine|veena|amelie|anna|alice|ellen|sara|paulina|monica|luciana|kyoko|\bana\b|salli|joanna|kendra|ivy|ruth|elizabeth|ashley|cora|jane|nancy|maisie|isla|molly/i;
  const MALE_VOICE = /\bmale|alex|daniel|fred|\btom\b|aaron|arthur|oliver|gordon|rishi|evan|nathan|\bguy\b|ryan|christopher|eric|roger|steffan|brian|andrew|davis|david|mark|george|james|william|thomas|reed|rocko|eddy|jorge|diego|luca|matthew|joey|justin|kevin|liam|noah|tony|jason|ethan|elliot/i;
  const voiceGender = (name) => (FEMALE_VOICE.test(name) ? 'f' : MALE_VOICE.test(name) ? 'm' : null);

  // OpenRouter can answer 200 with {"error": ...} instead of choices when the model's provider fails or is busy.
  function providerError(d) {
    const e = d && d.error;
    if (!e) return null;
    const code = Number(e.code) || 0;
    const err = new Error(`The AI provider returned an error${code ? ` (${code})` : ''}: ${e.message || JSON.stringify(e).slice(0, 300)}`);
    err.retry = code === 429 || code >= 500;
    return err;
  }
  // The text of a non-streamed reply, or a readable error.
  function replyText(d) {
    const err = providerError(d);
    if (err) throw err;
    const m = d && d.choices && d.choices[0] && d.choices[0].message;
    if (!m || typeof m.content !== 'string') { const e = new Error('The AI sent back an empty reply. Try again.'); e.retry = true; throw e; }
    return m.content;
  }

  // Split an SSE buffer into complete `data:` payloads plus the unfinished tail.
  function parseSSE(buffer) {
    const lines = buffer.split('\n');
    const rest = lines.pop();
    const tokens = [];
    let done = false, error = null;
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') { done = true; continue; }
      try {
        const d = JSON.parse(data);
        error = error || providerError(d);
        const tok = d.choices && d.choices[0] && ((d.choices[0].delta && d.choices[0].delta.content) || (d.choices[0].message && d.choices[0].message.content));
        if (tok) tokens.push(tok);
      } catch (e) { /* keep-alive or partial junk */ }
    }
    return { tokens, rest, done, error };
  }

  // ---------- encryption: AES-256-GCM via WebCrypto, so browser and node both run it ----------
  // Backups use a random per-device key; the app lock uses a key derived from the user's passcode.
  function toB64(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const fromB64 = (s) => Uint8Array.from(atob(String(s).trim()), (c) => c.charCodeAt(0));
  const newKey = () => toB64(crypto.getRandomValues(new Uint8Array(32)));
  const newSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)));
  const cryptoKey = (key) => crypto.subtle.importKey('raw', fromB64(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  // OWASP 2023 guidance for PBKDF2-SHA256; about half a second on a phone, so guessing passcodes is slow.
  const PBKDF2_ITERATIONS = 600000;
  async function deriveKey(passcode, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: PBKDF2_ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptWith(obj, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
    return { iv: toB64(iv), data: toB64(data) };
  }
  // Throws on a wrong key: GCM authenticates, so a bad key never yields garbage.
  async function decryptWith(rec, key) {
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(rec.iv) }, key, fromB64(rec.data))));
  }
  const isEncrypted = (f) => !!f && f.aetherstory === 'encrypted-v1';
  const encryptBackup = async (obj, key) => ({ aetherstory: 'encrypted-v1', alg: 'AES-256-GCM', ...(await encryptWith(obj, await cryptoKey(key))) });
  const decryptBackup = async (file, key) => decryptWith(file, await cryptoKey(key));
  const isLocked = (r) => !!r && r.aetherstory === 'locked-v1';
  const seal = async (obj, key, salt) => ({ aetherstory: 'locked-v1', alg: 'AES-256-GCM, PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt, ...(await encryptWith(obj, key)) });
  const unseal = decryptWith;

  const api = { newKey, newSalt, deriveKey, seal, unseal, isLocked, isEncrypted, encryptBackup, decryptBackup, LENGTHS, uid, emptyState, normalizeState, buildStoryMessages, buildWorldUpdateMessages, buildCharacterMessages, buildQuickstartMessages, applyQuickstart, parseJsonLoose, applyWorldUpdate, parseSSE, replyText, describeWorld, currentRelationships,
    buildReviseSheetMessages, buildReviseStoryMessages, speechChunks, speechParts, characterGender, voiceGender, applyEdits, sheetChanges, storiesForRevision, applyRevision, undoRevision };
  root.Aether = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

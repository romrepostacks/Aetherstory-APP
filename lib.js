// Pure logic: prompt building, world merging, parsing. No DOM, so node can test it.
(function (root) {
  const LENGTHS = { short: 800, medium: 1500, long: 3000 };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function emptyState() {
    return {
      settings: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        temperature: 0.9,
        style: '',
        mature: true,
        privateOnly: false,
        ageOk: false,
        voice: '',
        rate: 1,
        ttsKey: '', // optional Venice key for paid, more natural voices
        ttsModel: 'tts-inworld-1-5-max',
        ttsNarrator: '',
        // Optional second key just for reading photos: Google's free Gemini tier, through its OpenAI-compatible endpoint.
        photoKey: '',
        photoBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        photoModel: 'gemini-flash-latest',
        hordeKey: '', // optional free AI Horde key: pictures come back sooner than anonymous ones
        spice: 'adult', // how explicit stories and pictures get while mature is on: adult | kinky | nympho (SPICE)
        comfyUrl: '', // the user's own ComfyUI (e.g. http://127.0.0.1:8189): pictures drawn on their PC, AI Horde as backup
        comfyModel: '', // checkpoint file in that ComfyUI; empty = the first one it lists
        setupDone: false, // first-run setup finished or skipped
      },
      characters: [],
      stories: [],
      world: emptyWorld('main', 'My World'),
      revisions: [],
      // Worlds not open right now, each { world, stories, revisions }, and characters not in the open world.
      otherWorlds: [],
      library: [],
    };
  }
  // ai: optional per-world key and model, used instead of the ones in Settings.
  const emptyWorld = (id, name) => ({ id, name, overview: '', lore: [], places: [], relationships: [], timeline: [], ai: { apiKey: '', model: '' } });

  // Models that stopped being offered under a saved id; swapped on load so old settings keep working.
  // Nemotron 3 Ultra's free provider started failing on 2026-10-16; it stays a fallback (see freeFallbacks).
  const RETIRED = { 'venice/uncensored:free': 'nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3-ultra-550b-a55b:free': 'nvidia/nemotron-3.5-super-vl:free' };
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
      otherWorlds: (Array.isArray(s.otherWorlds) ? s.otherWorlds : []).filter((x) => x && x.world && x.world.id).map((x) => ({
        world: Object.assign(emptyWorld(), x.world), stories: Array.isArray(x.stories) ? x.stories : [], revisions: Array.isArray(x.revisions) ? x.revisions : [] })),
      library: Array.isArray(s.library) ? s.library : [],
    };
  }

  // ---------- worlds: the open one lives in state.world/stories/revisions/characters, so prompts only ever see that world ----------
  // A character can be in several worlds: the sheet is shared, but what happened to them (developments) is kept per world.
  function shelveWorld(state) {
    const id = state.world.id;
    for (const c of state.characters) {
      c.worlds = [...new Set([...(c.worlds || []), id])];
      (c.devs = c.devs || {})[id] = c.developments || [];
    }
    state.otherWorlds.push({ world: state.world, stories: state.stories, revisions: state.revisions });
    state.library = state.library.concat(state.characters);
  }
  function openWorld(state, entry) {
    const id = entry.world.id, here = (c) => (c.worlds || []).includes(id), all = state.library;
    Object.assign(state, { world: entry.world, stories: entry.stories, revisions: entry.revisions });
    state.characters = all.filter(here);
    state.library = all.filter((c) => !here(c));
    for (const c of state.characters) c.developments = (c.devs || {})[id] || [];
  }
  function switchWorld(state, id) {
    const i = state.otherWorlds.findIndex((x) => x.world.id === id);
    if (i < 0) return false;
    const next = state.otherWorlds.splice(i, 1)[0];
    shelveWorld(state);
    openWorld(state, next);
    return true;
  }
  function newWorld(state, name) {
    shelveWorld(state);
    openWorld(state, { world: emptyWorld(uid(), name || 'New World'), stories: [], revisions: [] });
  }
  // Deletes a world that isn't open, with its stories. Its characters stay in the library.
  function deleteWorld(state, id) {
    state.otherWorlds = state.otherWorlds.filter((x) => x.world.id !== id);
    for (const c of state.library.concat(state.characters)) {
      if (c.worlds) c.worlds = c.worlds.filter((w) => w !== id);
      if (c.devs) delete c.devs[id];
    }
  }
  // Brings a library character into the open world, with whatever already happened to them here.
  function addToWorld(state, charId) {
    const c = state.library.find((x) => x.id === charId);
    if (!c) return;
    state.library = state.library.filter((x) => x !== c);
    c.worlds = [...new Set([...(c.worlds || []), state.world.id])];
    c.developments = (c.devs || {})[state.world.id] || [];
    state.characters.push(c);
  }
  function removeFromWorld(state, charId) {
    const c = state.characters.find((x) => x.id === charId);
    if (!c) return;
    (c.devs = c.devs || {})[state.world.id] = c.developments || [];
    c.worlds = (c.worlds || []).filter((w) => w !== state.world.id);
    state.characters = state.characters.filter((x) => x !== c);
    state.library.push(c);
  }
  const worldNames = (c, state) => (c.worlds || []).map((id) => (id === state.world.id ? state.world : (state.otherWorlds.find((x) => x.world.id === id) || {}).world)).filter(Boolean).map((w) => w.name);

  // ---------- character export / import: the sheet and voice, as plain JSON to share or move ----------
  const CHAR_FIELDS = ['name', 'appearance', 'personality', 'background', 'voice', 'ttsVoice'];
  function exportCharacter(c) {
    const out = { aetherstory: 'character-v1' };
    for (const k of CHAR_FIELDS) if (c[k]) out[k] = c[k];
    if (c.developments && c.developments.length) out.developments = c.developments;
    return out;
  }
  // Adds the file's character(s) to the open world as new characters. Returns them.
  function importCharacters(state, j) {
    const added = [];
    for (const x of [].concat(j && j.characters ? j.characters : j)) {
      if (!x || !str(x.name)) continue;
      const c = { id: uid(), developments: strList(x.developments), worlds: [state.world.id], createdAt: Date.now() };
      for (const k of CHAR_FIELDS) c[k] = str(x[k]);
      state.characters.push(c);
      added.push(c);
    }
    return added;
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

  // Spice: how explicit things get while Mature content is on. Adult is how stories were written before the levels existed.
  const ADULT_STORY = 'This is private adult fiction for a consenting adult reader. Sexual content is wanted: when the story calls for it, write it explicitly and in vivid detail instead of fading to black or softening it into a sweet romance.';
  const ADULT_CHAT = 'This is private adult fiction for a consenting adult. Sexual content is allowed when the conversation goes there; write it explicitly rather than deflecting.';
  // The image model sees only the scene text, so intimate panels must say plainly what is on show, in the tag words anime models know.
  const ADULT_PANELS = ' This is private adult fiction for a consenting adult reader; adapt intimate scenes faithfully. The scene text is all the illustrator sees: in intimate panels, state plainly who is nude or partly undressed and what sexual act is shown, with short tag words (nsfw, nude, topless, sex, oral, cum, etc.) instead of euphemisms. In an intimate panel, list both partners under characters and put the act and the positions of both partners first in tags (e.g. fellatio, kneeling, standing, from side), so both people are drawn.';
  const SPICE = {
    adult: { label: 'Adult', hint: 'Explicit when the story calls for it.', story: ADULT_STORY, chat: ADULT_CHAT, panels: ADULT_PANELS, image: '' },
    kinky: { label: 'Kinky', hint: 'More heat, more often, with kinks and dirty talk.',
      story: ADULT_STORY + ' Turn the heat up: build sexual tension from the first scene, include at least one explicit sex scene, and lean into kinks and dirty talk that fit the characters (dominance and submission, teasing, toys, roleplay, risky places). All characters are consenting adults.',
      chat: ADULT_CHAT + ' Be flirtatious and forward, and steer toward sex and kinks that fit you.',
      panels: ADULT_PANELS + ' Show the sexual tension and intimate scenes on the page instead of cutting away.', image: 'nsfw, sensual, erotic, lewd' },
    nympho: { label: 'Nympho', hint: 'Sex is the heart of every story.',
      story: ADULT_STORY + ' Make sex the heart of the story: the characters are insatiable and can barely keep their hands off each other, scenes turn sexual quickly and often, with several long, graphic encounters and filthy dialogue throughout. All characters are consenting adults.',
      chat: ADULT_CHAT + ' You are insatiable: be openly sexual, start things yourself and escalate eagerly.',
      panels: ADULT_PANELS + ' Draw the intimate scenes explicitly and give them several panels.', image: 'nsfw, explicit, erotic, nude, sex' },
  };
  const spiceText = (settings, kind) => (settings.mature ? (SPICE[settings.spice] || SPICE.adult)[kind] : '');

  function buildStoryMessages(state, { characterIds = [], premise = '', length = 'medium', continueStory = null, pov = '' }) {
    const chars = state.characters.filter((c) => characterIds.includes(c.id));
    const past = relatedStories(state, characterIds, continueStory && continueStory.id);
    const system = [
      'You are a skilled fiction author writing an ongoing series set in one shared world.',
      'Keep characters, places and past events consistent with the series bible below. Build on earlier stories naturally (callbacks, evolving relationships) without recapping them.',
      'Write vivid prose with dialogue. Output only the story text: no preface, no notes, no title line.',
      spiceText(state.settings, 'story'),
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
      ' "lore": ["new world facts"], "places": ["Name: description"], "relationships": ["A & B: state of their relationship"], "timeline": ["event in one line"],\n' +
      ' "choices": ["3 short, different options for what could happen next, each under 15 words"]}\n' +
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

  // ---------- chat: talk with one character; saved with the stories so it feeds the world like one ----------
  // ponytail: sends the last 40 messages; summarize older ones if long chats start losing the thread.
  function buildChatMessages(state, chat) {
    const c = state.characters.find((x) => x.id === chat.with) || { name: 'the character' };
    const me = state.characters.find((x) => x.id === chat.as);
    const system = [
      `You are ${c.name}, a character in an ongoing fiction series, chatting with ${me ? me.name : 'the reader'}. Stay in character at all times and never mention being an AI.`,
      'Reply as ' + c.name + ' only: speech, with actions in *asterisks*. Keep replies to a few short paragraphs and let the other person lead.',
      spiceText(state.settings, 'chat'),
      state.settings.style ? `Guidelines from the reader: ${state.settings.style}` : '',
      '\n## Series bible\n' + describeWorld(state.world),
      '\n## You\n' + describeCharacter(c),
      me ? '\n## Who you are talking to\n' + describeCharacter(me) : '',
    ].filter(Boolean).join('\n');
    return [{ role: 'system', content: system }, ...chat.messages.slice(-40).map((m) => ({ role: m.role, content: m.content }))];
  }
  // The chat as plain text, for the stories list, narration and the world update.
  function chatText(state, chat) {
    const name = (id, fallback) => (state.characters.find((x) => x.id === id) || {}).name || fallback;
    return chat.messages.map((m) => `${m.role === 'user' ? name(chat.as, 'You') : name(chat.with, 'Them')}: ${m.content}`).join('\n\n');
  }

  // ---------- photo: physical description only, never who the person is ----------
  function buildPhotoMessages(imageUrl) {
    const text = 'Describe the physical appearance of the person in this photo for a fiction character sheet: apparent age range, build, skin tone, hair, eyes, face, and clothing style. ' +
      'Do not identify the person, guess their name, or say anything about who they are, their background, health or private life; physical descriptors only. ' +
      'Write 2-3 sentences in third person, using she/he/they as fits. Reply with JSON only: {"appearance": ""}';
    return [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: imageUrl } }] }];
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
    if (!story.chat) story.choices = strList(u.choices).slice(0, 3);
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

  // ---------- long-term memory: when a list outgrows what prompts show, its oldest entries are condensed so nothing silently drops out ----------
  // Prompts show the newest 40 world entries and 12 developments. Past that, the oldest get merged into a few dense entries.
  // The originals go to world.archive, which is never sent to the AI, so nothing is lost.
  const MEMORY = { world: 40, worldKeep: 15, dev: 12, devKeep: 6 };
  function memoryPlan(state) {
    const w = state.world, plan = { world: {}, chars: [] };
    for (const k of WORLD_LISTS) {
      const list = k === 'relationships' ? currentRelationships(w[k]) : w[k] || [];
      if (list.length > MEMORY.world) plan.world[k] = (w[k] || []).slice(0, w[k].length - MEMORY.worldKeep);
    }
    for (const c of state.characters) {
      const d = c.developments || [];
      if (d.length > MEMORY.dev) plan.chars.push({ id: c.id, name: c.name, old: d.slice(0, d.length - MEMORY.devKeep) });
    }
    return Object.keys(plan.world).length || plan.chars.length ? plan : null;
  }
  function buildMemoryMessages(state, plan) {
    const system = 'You maintain the long-term memory of a fiction series. Reply with JSON only, no markdown.';
    const user = `World: ${state.world.name}\n\nThese are the OLDEST entries of the series bible. Condense them so the important facts survive in far fewer words.\n\n` +
      Object.entries(plan.world).map(([k, items]) => `${k}:\n- ${items.join('\n- ')}`).join('\n\n') +
      (plan.chars.length ? '\n\nOldest developments per character:\n' + plan.chars.map((c) => `${c.name}:\n- ${c.old.join('\n- ')}`).join('\n') : '') +
      '\n\nReturn JSON: {"world": {"<list name>": ["at most 10 dense entries"]}, "characters": {"<name>": "2-3 sentences covering everything important"}}\n' +
      'Only include the lists and characters given above. Keep names, places, promises, secrets and turning points; drop repetition. Relationships keep the "A & B: state" form; timeline keeps events in order.';
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }
  // Replaces each condensed span, but only if it's still the start of its list (a Revise may have changed it meanwhile).
  function applyMemory(state, plan, r) {
    const w = state.world, arch = (w.archive = w.archive || {}), out = [];
    const startsWith = (list, old) => old.every((x, i) => list[i] === x);
    for (const [k, old] of Object.entries(plan.world)) {
      const items = strList(r && r.world && r.world[k]).slice(0, 10);
      if (!items.length || !startsWith(w[k], old)) continue;
      w[k].splice(0, old.length, ...items);
      (arch[k] = arch[k] || []).push(...old);
      out.push(k);
    }
    for (const p of plan.chars) {
      const c = state.characters.find((x) => x.id === p.id), sum = str(((r && r.characters) || {})[p.name]);
      if (!c || !sum || !startsWith(c.developments || [], p.old)) continue;
      c.developments.splice(0, p.old.length, 'Earlier: ' + sum);
      (arch.developments = arch.developments || []).push(...p.old.map((d) => `${c.name}: ${d}`));
      out.push(c.name);
    }
    return out;
  }

  // ---------- comic: a story as manhwa-style panels, each drawn from a scene description plus how its characters look ----------
  function buildPanelMessages(state, story) {
    const chars = state.characters.filter((c) => (story.characterIds || []).includes(c.id));
    const system = 'You adapt prose into a vertical-scroll manhwa (webtoon). Reply with JSON only, no markdown.';
    const n = panelCount(story.text);
    const user = `Characters:\n${chars.map((c) => `- ${c.name}${c.appearance ? ': ' + c.appearance.slice(0, 300) : ''}`).join('\n') || '(none named)'}\n\nStory "${story.title}":\n"""${story.text.slice(0, 60000)}"""\n\n` +
      `Split it into about ${n} panels that follow the whole story in order, start to finish, without skipping scenes. Return JSON:\n` +
      '{"looks": {"<character name>": "10-15 comma-separated anime tags fixing how this character always looks, from the description above: hair color and style, eye color, face, skin, body, age, usual outfit"},\n' +
      ' "panels": [{"scene": "what the illustrator draws: setting, action, poses, expressions, lighting, camera angle. Describe it visually, under 60 words",\n' +
      '  "tags": "8-15 comma-separated anime image tags for what is shown, most important first: the action, who does what to whom, poses, camera angle, then the setting; looks come from \"looks\", so leave them out (e.g. kissing, hug, from side, sitting, cafe)",\n' +
      '  "characters": ["names of every character in this panel, including anyone only partly in frame"], "caption": "short narration box, or empty", "dialogue": [{"name": "speaker", "line": "under 20 words"}]}]}\n' +
      'Use the exact character names above. Keep the text short; the pictures carry the story.' +
      spiceText(state.settings, 'panels');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }
  // About one panel per 150 words, like a webtoon episode: a 3000-word story gets 20.
  const panelCount = (text) => Math.min(40, Math.max(8, Math.round(String(text || '').split(/\s+/).length / 150)));
  const COMIC_STYLE = 'anime manhwa webtoon panel, 2d illustration, full color, clean line art, flat cel shading, anime eyes, detailed drawn background';
  // The image model knows nothing about the cast, so each visible character's name becomes their written appearance.
  // Image models weigh the start of a prompt most, so the head count and action tags come first, then the scene, short looks and the art style.
  const panelCast = (state, panel) => strList(panel && panel.characters).map((n) => state.characters.find((c) => c.name.toLowerCase() === n.toLowerCase())).filter(Boolean);
  // `tags` holds each character's fixed look tags for the whole comic, so hair and faces don't drift from panel to panel.
  function panelPrompt(state, panel, tags = {}) {
    const who = panelCast(state, panel);
    const lookOf = (c) => str(tags[Object.keys(tags).find((k) => k.toLowerCase() === c.name.toLowerCase())]);
    const looks = who.map((c) => `${c.name}: ` + (lookOf(c) || (c.appearance ? c.appearance.slice(0, 100) : 'a ' + (characterGender(c) === 'f' ? 'woman' : characterGender(c) === 'm' ? 'man' : 'person')))).join('. ');
    // Anime models are trained on head-count tags (1girl, 2boys), so without them a two-person act often comes out as one person.
    const count = (g, word) => { const n = who.filter((c) => characterGender(c) === g).length; return n ? `${n}${word}${n > 1 ? 's' : ''}` : ''; };
    const heads = [count('f', 'girl'), count('m', 'boy')].filter(Boolean).join(', ');
    return [[heads, str(panel && panel.tags)].filter(Boolean).join(', '), str(panel && panel.scene), looks, COMIC_STYLE].filter(Boolean).join('. ').slice(0, 1500);
  }
  // A head-and-shoulders picture from the written appearance only; the name means nothing to the image model.
  const PORTRAIT_STYLE = 'anime portrait, head and shoulders, looking at viewer, manhwa webtoon style, 2d illustration, full color, clean line art, flat cel shading, anime eyes, simple soft background';
  function portraitPrompt(c) {
    const g = characterGender(c);
    return [PORTRAIT_STYLE, str(c && c.appearance) || `a ${g === 'f' ? 'woman' : g === 'm' ? 'man' : 'person'}`, 'fully clothed'].join('. ').slice(0, 1500);
  }
  function toPanels(state, r) {
    return (Array.isArray(r && r.panels) ? r.panels : []).filter((p) => p && str(p.scene)).slice(0, 50).map((p) => ({
      prompt: panelPrompt(state, p, r.looks && typeof r.looks === 'object' ? r.looks : {}), who: panelCast(state, p).map((c) => c.id), caption: str(p.caption),
      dialogue: (Array.isArray(p.dialogue) ? p.dialogue : []).filter((d) => d && str(d.line)).map((d) => ({ name: str(d.name), line: str(d.line) })),
    }));
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

  // Characters whose first name appears in a piece of text.
  function charactersNamedIn(state, text) {
    return state.characters.filter((c) => c.name && new RegExp(`\\b${c.name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text || ''));
  }

  // Stories to check: those featuring or naming an affected character, or every story when the change isn't about anyone.
  function storiesForRevision(state, affected) {
    const people = state.characters.filter((c) => affected.some((n) => n.toLowerCase() === c.name.toLowerCase()));
    // Chats are kept as their messages, so a text edit wouldn't stick; they're left as they were.
    const stories = state.stories.filter((s) => !s.chat);
    if (!people.length) return stories;
    const named = (s, c) => charactersNamedIn({ characters: [c] }, s.text).length > 0;
    return stories.filter((s) => people.some((c) => (s.characterIds || []).includes(c.id) || named(s, c)));
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

  // Paid narration through Venice: one key, several voice engines. Voices are split by gender so characters get a fitting one.
  const PREMIUM_VOICES = {
    'tts-inworld-1-5-max': { label: 'Inworld (most natural, about 11¢ a story)', f: ['Olivia', 'Sarah', 'Ashley', 'Elizabeth', 'Luna', 'Priya', 'Pixie'], m: ['Theodore', 'Edward', 'Craig', 'Mark', 'Ronald', 'Alex', 'Hades'] },
    'tts-kokoro': { label: 'Kokoro (cheapest, about 3¢ a story)', f: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'af_nova', 'bf_emma', 'bf_alice', 'bf_lily', 'af_sky', 'af_jessica', 'af_river', 'af_kore'], m: ['am_michael', 'am_adam', 'am_liam', 'am_eric', 'bm_george', 'bm_daniel', 'bm_lewis', 'bm_fable', 'am_onyx', 'am_echo', 'am_fenrir', 'am_puck'] },
  };
  const premiumVoices = (model) => PREMIUM_VOICES[model] || PREMIUM_VOICES['tts-inworld-1-5-max'];
  // The voice for the `index`th character of this gender: never the narrator's, cycling when there are more characters than voices.
  function premiumVoice(model, gender, index, narrator) {
    const v = premiumVoices(model);
    const list = (gender ? v[gender] : [...v.f, ...v.m]).filter((x) => x !== narrator);
    return list[Math.max(0, index) % list.length];
  }
  // Joins neighbouring lines that share a voice, then cuts them to the API's size limit, so a story takes few requests.
  function voiceRuns(lines, max = 3000) {
    const runs = [];
    for (const l of lines) {
      const last = runs[runs.length - 1];
      if (last && last.voice === l.voice) last.text += ' ' + l.text; else runs.push({ voice: l.voice, text: l.text });
    }
    return runs.flatMap((r) => speechChunks(r.text, max).map((text) => ({ voice: r.voice, text })));
  }

  // Free models come and go on OpenRouter (a provider can drop one overnight), so a free pick falls back to
  // another free Nemotron and then to OpenRouter's free router, which takes whichever free model is up.
  // ponytail: three entries, OpenRouter has capped this list at 3 before.
  const FREE_NEMOTRONS = ['nvidia/nemotron-3.5-super-vl:free', 'nvidia/nemotron-3-ultra-550b-a55b:free'];
  function freeFallbacks(baseUrl, model) {
    if (!String(baseUrl).includes('openrouter.ai') || !/:free$/.test(model)) return null;
    return [model, FREE_NEMOTRONS.find((m) => m !== model), 'openrouter/free'];
  }

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

  const api = { switchWorld, newWorld, deleteWorld, addToWorld, removeFromWorld, worldNames, exportCharacter, importCharacters, newKey, newSalt, deriveKey, seal, unseal, isLocked, isEncrypted, encryptBackup, decryptBackup, LENGTHS, uid, emptyState, normalizeState, buildStoryMessages, buildWorldUpdateMessages, buildCharacterMessages, buildQuickstartMessages, applyQuickstart, parseJsonLoose, applyWorldUpdate, parseSSE, replyText, freeFallbacks, describeWorld, currentRelationships,
    SPICE, spiceText, memoryPlan, buildMemoryMessages, applyMemory, buildPanelMessages, panelCount, panelPrompt, portraitPrompt, toPanels,
    buildReviseSheetMessages, buildReviseStoryMessages, buildChatMessages, chatText, buildPhotoMessages, speechChunks, speechParts, PREMIUM_VOICES, premiumVoices, premiumVoice, voiceRuns, characterGender, voiceGender, applyEdits, sheetChanges, charactersNamedIn, storiesForRevision, applyRevision, undoRevision };
  root.Aether = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

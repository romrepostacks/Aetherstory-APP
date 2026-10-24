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
        helperUrl: '', // the laptop helper (helper.js); empty = the https ComfyUI address + /helper
        comfyModel: '', // checkpoint file in that ComfyUI; empty = the first one it lists
        comfyNsfwModel: '', // checkpoint for explicit comic panels; empty = comfyModel
        checkPictures: true, // the story AI looks at each comic panel and redraws one that doesn't match
        devPrompts: false, // show each comic panel's prompt and checks under it
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
        s.settings && s.settings.baseUrl === BUILTIN ? { baseUrl: base.settings.baseUrl, model: base.settings.model } : {},
        { mature: true }), // Spice has no Off any more, so an old "Off" library starts at Adult
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
  const ADULT_PANELS = ' This is private adult fiction for a consenting adult reader; adapt intimate scenes faithfully. The scene text is all the illustrator sees: in intimate panels, state plainly who is nude or partly undressed and what sexual act is shown, with short tag words (nsfw, nude, topless, sex, oral, cum, etc.) instead of euphemisms. In an intimate panel, list both partners under characters, put the act first in tags (e.g. fellatio, from side), and give each partner their own position in poses (e.g. kneeling; standing), so both people are drawn.';
  const SPICE = {
    adult: { label: 'Adult', hint: 'Explicit when the story calls for it.', story: ADULT_STORY, chat: ADULT_CHAT, panels: ADULT_PANELS, image: '' },
    kinky: { label: 'Kinky (experimental)', hint: 'More heat, more often, with kinks and dirty talk.',
      story: ADULT_STORY + ' Turn the heat up: build sexual tension from the first scene, include at least one explicit sex scene, and lean into kinks and dirty talk that fit the characters (dominance and submission, teasing, toys, roleplay, risky places). All characters are consenting adults.',
      chat: ADULT_CHAT + ' Be flirtatious and forward, and steer toward sex and kinks that fit you.',
      panels: ADULT_PANELS + ' Show the sexual tension and intimate scenes on the page instead of cutting away.', image: 'nsfw, sensual' },
    nympho: { label: 'Nympho (experimental)', hint: 'Sex is the heart of every story.',
      story: ADULT_STORY + ' Make sex the heart of the story: the characters are insatiable and can barely keep their hands off each other, scenes turn sexual quickly and often, with several long, graphic encounters and filthy dialogue throughout. All characters are consenting adults.',
      chat: ADULT_CHAT + ' You are insatiable: be openly sexual, start things yourself and escalate eagerly.',
      panels: ADULT_PANELS + ' Draw the intimate scenes explicitly and give them several panels.', image: 'nsfw, explicit' },
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

  // Models sometimes lose their place and start the story over (or, when continuing, retype the story so far).
  // Cuts the new text where its opening comes back, and drops a retyped copy of the story so far from its start.
  function trimRepeat(text, before = '') {
    const flat = (t) => t.replace(/\s+/g, ' ').trim();
    const head = flat(text).slice(0, 60);
    if (head.length < 60) return text;
    const prior = flat(before);
    const at = prior.indexOf(head);
    if (at >= 0) { // retyped the story so far: skip everything it already had
      const old = prior.slice(at);
      let i = 0, k = 0; // walk both texts, ignoring how whitespace differs
      while (i < text.length && k < old.length) {
        if (/\s/.test(text[i])) { i++; if (old[k] === ' ') k++; continue; }
        if (text[i] !== old[k]) break;
        i++; k++;
      }
      text = text.slice(i).replace(/^\s+/, '');
      return trimRepeat(text);
    }
    // Restarted itself: the opening shows up again later.
    const words = head.split(' ').slice(0, 12).join(' ');
    const re = new RegExp(words.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
    const first = re.exec(text); // the opening itself
    if (!first) return text;
    re.lastIndex = first.index + 1;
    const again = re.exec(text);
    return again ? text.slice(0, again.index).trim() : text;
  }

  // The second pass after a story: a continuity editor compares the new text with the sheets and the bible and fixes slips
  // with exact find/replace edits (applyEdits), so nothing else in the story moves.
  const CHECKS = {
    lore: 'world lore, places, past events, relationships, and each character\'s personality and traits (how they talk and act, what they want, what they know)',
    looks: 'physical descriptions: hair, eyes, skin, height, build, body type, age, scars, tattoos and usual style of each character. A character\'s body stays the same from scene to scene',
  };
  function buildCheckMessages(state, story, part, kind) {
    const chars = state.characters.filter((c) => (story.characterIds || []).includes(c.id));
    const system = 'You are a continuity editor for a fiction series. Reply with JSON only, no markdown.';
    const user = `Series bible:\n${describeWorld(state.world)}\n\nCharacters:\n${chars.map(describeCharacter).join('\n\n') || '(none)'}\n\n` +
      `New text:\n\"\"\"${part}\"\"\"\n\n` +
      `Check the new text only against the ${CHECKS[kind]}. Find every passage that contradicts the bible or the character sheets and rewrite it so it agrees, changing as little as possible and keeping the style and explicitness. ` +
      'Do not fix anything else, and leave new facts that don\'t contradict anything alone. Return JSON:\n' +
      '{"edits": [{"find": "exact text copied from the new text, long enough to be unique", "replace": "the corrected text"}]}\n' +
      'Use an empty edits list if nothing contradicts them.';
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
    const raw = text.slice(start, end + 1);
    try { return JSON.parse(raw); } catch (e) {
      try { return JSON.parse(repairJson(raw)); } catch (e2) {
        // Show the bit of the reply that broke, so the next report says what the AI actually wrote.
        const at = Number((/position (\d+)/.exec(e.message) || [])[1]);
        throw new SyntaxError(isNaN(at) ? e.message : `${e.message}. The AI wrote: …${raw.slice(Math.max(0, at - 80), at + 40)}…`);
      }
    }
  }
  // The usual slips in long replies: "quotes" inside dialogue left unescaped, raw line breaks in strings, trailing commas.
  // A quote counts as closing a string only when what follows could come after a JSON value.
  function repairJson(raw) {
    let out = '', inStr = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inStr && c === '\\') { out += c + (raw[++i] || ''); continue; }
      const key = !inStr && /[{,]\s*$/.test(out) && /^([A-Za-z_]\w*)\s*:/.exec(raw.slice(i, i + 40)); // {name: "x"} → {"name": "x"}
      if (key) { out += `"${key[1]}"`; i += key[1].length - 1; continue; }
      if (c === '"') {
        if (!inStr) inStr = true;
        else if (/^\s*([,:}\]]|$)/.test(raw.slice(i + 1, i + 20))) inStr = false;
        else { out += '\\"'; continue; }
      } else if (inStr && c === '\n') { out += '\\n'; continue; }
      out += c;
    }
    return out.replace(/,(\s*[}\]])/g, '$1');
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
  // Free models lose the thread on a whole long story, so it is planned a part at a time (about 1500 words, cut at paragraphs), in order.
  function comicParts(text, size = 1500) {
    const parts = [];
    let cur = [], words = 0;
    for (const para of String(text || '').split(/\n\s*\n/).filter((p) => p.trim())) {
      cur.push(para); words += para.split(/\s+/).length;
      if (words >= size) { parts.push(cur.join('\n\n')); cur = []; words = 0; }
    }
    if (cur.length) parts.push(cur.join('\n\n'));
    return parts;
  }
  const wordCount = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
  // Each character's sheet as the planner and checker see it: fixed body tags first, so every panel gets the same build.
  const castSheet = (chars) => chars.map((c) => `- ${c.name}: ${[c.lookTags && 'body (never changes): ' + c.lookTags, c.appearance && c.appearance.slice(0, 400), c.personality && 'personality: ' + c.personality.slice(0, 200)].filter(Boolean).join('. ')}`).join('\n') || '(none named)';
  const PANEL_FIELDS = '{"panels": [{"quote": "6-12 words copied exactly from the story text this panel shows",\n' +
    '  "scene": "what the illustrator draws: action, poses, expressions, lighting, camera angle. Describe it visually, under 60 words",\n' +
    '  "setting": "where this happens, the same words every panel in that place (e.g. office, desk, window, night)",\n' +
    '  "tags": "4-8 comma-separated anime image tags for the camera angle, framing, lighting and any act the people share (e.g. from side, medium shot, night, hug). No hair, eyes or body tags: those come from the cast list",\n' +
    '  "poses": {"name": "this person\'s own pose, action and expression as 3-6 tags (e.g. sitting up, looking down, worried; or lying on side, asleep), so each person is drawn doing their own thing"},\n' +
    '  "characters": ["names of every character in this panel, including anyone only partly in frame"],\n' +
    '  "clothes": {"name": "only the clothing they wear in this panel as tags (e.g. red dress, bare feet), or nude; the same outfit until the story changes it. No body parts or hair"},\n' +
    '  "explicit": false, "caption": "short narration box, or empty", "dialogue": [{"name": "speaker", "line": "under 20 words"}]}]}\n';
  // part: one piece of comicParts(story.text); n: panels for it; prev: the panel before it, so places and outfits carry over.
  function buildPanelMessages(state, story, part = story.text, n = panelCount(story.text), prev = null, where = '') {
    const chars = state.characters.filter((c) => (story.characterIds || []).includes(c.id));
    const system = 'You adapt prose into a vertical-scroll manhwa (webtoon). Reply with JSON only, no markdown.';
    const user = `Characters:\n${castSheet(chars)}\n\n` + (prev ? `The panel just before this part: ${prev.setting ? prev.setting + '. ' : ''}${prev.scene} (${(prev.characters || []).join(', ')})\n\n` : '') +
      `Story "${story.title}"${where}:\n"""${String(part).slice(0, 20000)}"""\n\n` +
      `Split this text into about ${n} panels that follow it in order, start to finish, without skipping or repeating scenes. Return JSON:\n` + PANEL_FIELDS +
      'Use the exact character names above and only characters who are actually in the scene. Keep the text short; the pictures carry the story. ' +
      'Set "explicit" true only for a panel that shows nudity or sex. Everything else (working, talking, walking, eating, even flirting) is explicit false and everyone in it is clothed.' +
      spiceText(state.settings, 'panels');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }
  // Second pass over one part's plan: wrong order, scenes not in the text, missing or extra people, nudity where nobody is undressed.
  function buildPanelCheckMessages(state, story, part, panels) {
    const chars = state.characters.filter((c) => (story.characterIds || []).includes(c.id));
    const list = panels.map((p, i) => JSON.stringify({ panel: i + 1, quote: p.quote, scene: p.scene, setting: p.setting, characters: p.characters, poses: p.poses, clothes: p.clothes, explicit: p.explicit })).join('\n');
    const user = `Characters:\n${castSheet(chars)}\n\nStory text:\n"""${String(part).slice(0, 20000)}"""\n\nComic panels planned for this text:\n${list}\n\n` +
      'Fact-check the panels against the story text and the characters. Fix any panel that is out of story order, shows something that does not happen in the text, has the wrong people in it, ' +
      'has someone wearing or doing something that contradicts the text, or is marked explicit when nobody in it is undressed (or not explicit when they are). ' +
      'Return JSON: {"order": [panel numbers in correct story order], "fixes": [{"panel": 1, plus only the fields that change: "scene", "setting", "tags", "characters", "poses", "clothes", "explicit"}]}. ' +
      'Return {"order": [], "fixes": []} when everything is right.';
    return [{ role: 'system', content: 'You are a careful comic editor. Reply with JSON only, no markdown.' }, { role: 'user', content: user }];
  }
  function applyPanelCheck(panels, r) {
    for (const f of Array.isArray(r && r.fixes) ? r.fixes : []) {
      const p = panels[Number(f && f.panel) - 1];
      if (!p) continue;
      for (const k of ['scene', 'setting', 'tags']) if (str(f[k])) p[k] = str(f[k]);
      if (strList(f.characters).length) p.characters = strList(f.characters);
      if (f.clothes && typeof f.clothes === 'object') p.clothes = { ...p.clothes, ...f.clothes };
      if (f.poses && typeof f.poses === 'object') p.poses = { ...p.poses, ...f.poses };
      if (typeof f.explicit === 'boolean') p.explicit = f.explicit;
    }
    const order = (Array.isArray(r && r.order) ? r.order : []).map((x) => panels[Number(x) - 1]);
    // Only a full reordering is trusted; a partial list would drop panels.
    return order.length === panels.length && new Set(order).size === panels.length && order.every(Boolean) ? order : panels;
  }
  // About one panel per 150 words, like a webtoon episode: a 3000-word story gets 20.
  const panelCount = (text) => Math.min(40, Math.max(8, Math.round(wordCount(text) / 150)));
  const COMIC_STYLE = 'manhwa, webtoon, anime coloring, cel shading, clean lineart, detailed background';
  const gendered = (c, f, m, x) => ({ f, m }[characterGender(c)] || x);
  // Fixed body tags per character, written once from their sheet and reused in every panel so build, size and face don't drift.
  // lookFrom remembers the appearance they came from, so editing the character makes new ones.
  const needsLook = (c) => !!c.appearance && (!c.lookTags || c.lookFrom !== c.appearance);
  function buildLookMessages(chars) {
    const user = `Characters:\n${chars.map((c) => `- ${c.name}: ${c.appearance}`).join('\n')}\n\n` +
      'For each character write 12-20 comma-separated anime image tags for how their body and face look, so an illustrator draws them the same in every picture: ' +
      'gender tag (1girl or 1boy), age (e.g. adult, mature male), body build and size first and specific (e.g. muscular, broad shoulders, tall, chubby, slim, petite, curvy, large breasts), ' +
      'skin tone, hair colour, length and style, eye colour, facial hair, and lasting features (tattoos, scars, glasses, piercings). No clothes, no pose, no names. ' +
      'Return JSON: {"looks": {"exact name": "tags"}}';
    return [{ role: 'system', content: 'You write consistent character tags for anime image models. Reply with JSON only, no markdown.' }, { role: 'user', content: user }];
  }
  function applyLooks(chars, r) {
    const looks = (r && r.looks) || {};
    for (const c of chars) {
      const k = Object.keys(looks).find((n) => n.toLowerCase() === c.name.toLowerCase()) || Object.keys(looks).find((n) => n.toLowerCase().trim().split(/\s+/)[0] === c.name.toLowerCase().trim().split(/\s+/)[0]);
      if (k && str(looks[k])) { c.lookTags = str(looks[k]); c.lookFrom = c.appearance; }
    }
  }
  // The image model knows nothing about the cast, so each visible character's name becomes their fixed body tags plus this panel's clothes.
  // The prompt comes in chunks joined by BREAK: the image model reads about 75 words at a time, and ComfyUI gives each chunk its own full
  // weight (drawComfy encodes them one by one), so nothing slides into a weak tail. Chunks: who and what they do, each person, the scene, the style.
  const BODY_TAG = /\b(tall|short stature|petite|slim|skinny|chubby|plump|curvy|muscular|athletic|broad|build|legs|thighs|hips|waist|height|toned|abs|shoulders|stocky|lanky)\b/i;
  const CLOSE_SHOT = /close-up|closeup|portrait|face focus|upper body|head shot/i;
  const tagList = (t) => String(t || '').split(',').map((x) => x.trim()).filter(Boolean);
  // The planner often shortens names in later parts ("Ana" for "Ana Reyes"). A panel that loses its people that way has nobody's looks in it,
  // so the model invents one blended person. Exact names win; otherwise a matching first name counts.
  const firstName = (n) => String(n).toLowerCase().trim().split(/\s+/)[0];
  const sameName = (a, b) => String(a).toLowerCase().trim() === String(b).toLowerCase().trim();
  const castMember = (state, n) => state.characters.find((c) => sameName(c.name, n)) || state.characters.find((c) => firstName(c.name) === firstName(n));
  const panelCast = (state, panel) => [...new Set(strList(panel && panel.characters).map((n) => castMember(state, n)).filter(Boolean))];
  function panelPrompt(state, panel) {
    const who = panelCast(state, panel);
    const mine = (o, c) => { const ks = Object.keys(o || {}); return str((o || {})[ks.find((n) => sameName(n, c.name)) || ks.find((n) => firstName(n) === firstName(c.name))]); };
    const clothes = (c) => mine(panel.clothes, c);
    const tags = str(panel && panel.tags), close = CLOSE_SHOT.test(tags);
    // Each person's own chunk starts with their own head tag, so two people's hair, build and clothes stay apart instead of blending.
    // Only what the camera sees: a close-up drops build and size tags. About 12 body tags and 4 clothes tags each.
    const own = (c) => ({ f: '1girl', m: '1boy' })[characterGender(c)] || '';
    const person = (c) => {
      let look = c.lookTags ? tagList(c.lookTags) : [c.appearance ? c.appearance.slice(0, 160) : gendered(c, 'a woman', 'a man', 'a person')];
      if (close) look = look.filter((t) => !BODY_TAG.test(t) || /hair|eyes|breasts/i.test(t));
      const head = /^\d(girl|boy)/.test(look[0] || '') ? look.shift() : who.length > 1 ? own(c) : '';
      // Each person's own pose sits right by their head tag, so "sitting up" and "asleep" go to the right one instead of fusing into one figure.
      return [head, ...tagList(mine(panel.poses, c)).slice(0, 6), ...look.slice(0, 12), ...tagList(clothes(c)).slice(0, 4)].filter(Boolean).join(', ');
    };
    // Names mean nothing to an image model, so in the scene each one becomes a short look ("red hair girl"), which ties the action to the right person.
    const short = (c) => `${tagList(c.lookTags).filter((t) => /hair|braid|ponytail|twintail|\bbob\b|\bbun\b/.test(t))[0] || ''} ${gendered(c, 'girl', 'man', 'person')}`.trim();
    let scene = str(panel && panel.scene);
    for (const c of who) for (const n of new Set([c.name, c.name.split(' ')[0]])) scene = scene.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}('s)?\\b`, 'gi'), (m, poss) => `the ${short(c)}${poss || ''}`);
    scene = scene.split(/\s+/).slice(0, 35).join(' '); // the scene is backup for what the action tags miss, so it stays short
    // Anime models are trained on head-count tags (1girl, 2boys), so without them a two-person act often comes out as one person.
    const count = (g, word) => { const n = who.filter((c) => characterGender(c) === g).length; return n ? `${n}${word}${n > 1 ? 's' : ''}` : ''; };
    const heads = [count('f', 'girl'), count('m', 'boy')].filter(Boolean).join(', ') || (who.length ? '' : 'no humans');
    return [[heads, tags, panel && panel.explicit === false ? 'clothed' : ''].filter(Boolean).join(', '),
      ...who.map(person), [scene, str(panel && panel.setting)].filter(Boolean).join(', '), COMIC_STYLE].filter(Boolean).join(' BREAK ').slice(0, 1500);
  }
  // A head-and-shoulders picture from the written appearance only; the name means nothing to the image model.
  const PORTRAIT_STYLE = 'anime portrait, head and shoulders, looking at viewer, manhwa webtoon style, 2d illustration, full color, clean line art, flat cel shading, anime eyes, simple soft background';
  function portraitPrompt(c) {
    return [PORTRAIT_STYLE, str(c && c.appearance) || gendered(c, 'a woman', 'a man', 'a person'), 'fully clothed'].join('. ').slice(0, 1500);
  }
  // Planned panels keep their parts (scene, characters, clothes...) so the prompt is rebuilt at draw time from the latest looks.
  // part: the text they were planned from; panels are sorted by where their quote sits in it, so they can't come out of story order.
  const byName = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => str(v)).map(([k, v]) => [k, str(v)])) : {});
  function toPanels(state, r, part = '') {
    const at = (q) => { const i = q ? String(part).toLowerCase().indexOf(q.toLowerCase()) : -1; return i; };
    let last = 0;
    const panels = (Array.isArray(r && r.panels) ? r.panels : []).filter((p) => p && str(p.scene)).slice(0, 50).map((p) => {
      const panel = { quote: str(p.quote), scene: str(p.scene), setting: str(p.setting), tags: str(p.tags), characters: strList(p.characters),
        clothes: byName(p.clothes), poses: byName(p.poses),
        explicit: p.explicit === true, caption: str(p.caption),
        dialogue: (Array.isArray(p.dialogue) ? p.dialogue : []).filter((d) => d && str(d.line)).map((d) => ({ name: str(d.name), line: str(d.line) })) };
      const i = at(panel.quote);
      panel.pos = (last = i >= 0 ? i : last); // no exact quote: stays right after the panel before it
      return panel;
    });
    panels.sort((a, b) => a.pos - b.pos); // stable: equal positions keep the AI's order
    for (const p of panels) { delete p.pos; p.prompt = panelPrompt(state, p); }
    return panels;
  }
  // The picture check: a vision model compares the drawn panel with what it should show.
  function buildPictureCheckMessages(state, panel, img) {
    const who = panelCast(state, panel);
    const text = `This is a drawn comic panel. It should show: ${panel.scene}${panel.setting ? ' Setting: ' + panel.setting + '.' : ''}\n` +
      `People in it (${who.length || 'none'}): ${who.map((c) => `${c.name}: ${c.lookTags || c.appearance || ''}`).join('; ') || 'none'}.\n` +
      (panel.explicit ? 'It is an intimate adult scene, so nudity is expected.\n' : 'Nobody in it should be nude or sexual.\n') +
      'Does the picture match? Check the number of people, each person\'s body build, hair and features, the action, and whether nudity matches. Small style differences are fine. ' +
      'Reply with JSON only: {"ok": true} or {"ok": false, "problem": "what is wrong, in under 20 words"}';
    return [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: img } }] }];
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
  // One call to an OpenAI-compatible AI, streamed when it can be. Runs in the app and on the laptop helper.
  // `cutOff()` says whether a stream that ended without [DONE] was cut (the app went to the background) rather than finished.
  async function ask(s, messages, { onToken, signal, stream = true, cutOff } = {}) {
    if (!s.baseUrl || !s.model) throw new Error('Set an AI provider and model in Settings first.');
    const headers = { 'Content-Type': 'application/json' };
    if (s.apiKey) headers.Authorization = 'Bearer ' + s.apiKey;
    const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers, signal,
      // Private mode: OpenRouter only routes to providers that don't store or train on prompts.
      body: JSON.stringify({ model: s.model, models: freeFallbacks(s.baseUrl, s.model) || undefined, messages, stream,
        // Unstreamed calls want JSON back, and a hot temperature is what makes models slip on quotes and commas.
        temperature: stream ? Number(s.temperature) || 0.9 : Math.min(Number(s.temperature) || 0.9, 0.5),
        ...(s.privateOnly && s.baseUrl.includes('openrouter.ai') ? { provider: { data_collection: 'deny' } } : {}) }),
    });
    if (!res.ok) {
      const msg = `AI request failed (${res.status}): ${(await res.text()).slice(0, 300)}`;
      const err = new Error(s.privateOnly && res.status === 404 ? msg + '\nPrivate mode is on and no private provider serves this model. Pick a paid model in Advanced mode, or turn Private mode off.' : msg);
      err.retry = res.status === 429 || res.status >= 500;
      throw err;
    }
    if (!stream || !(res.headers.get('content-type') || '').includes('event-stream')) {
      const text = replyText(await res.json());
      if (onToken) onToken(text);
      return text;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { if (cutOff && cutOff()) throw new TypeError('The connection closed while the app was in the background.'); break; } // no [DONE]: cut off, not finished
      const out = parseSSE(buf + dec.decode(value, { stream: true }));
      buf = out.rest;
      if (out.error) throw out.error;
      for (const t of out.tokens) { full += t; if (onToken) onToken(t); }
      if (out.whole && !full) { full = out.whole; if (onToken) onToken(full); } // only for providers that never streamed deltas
      if (out.done) break;
    }
    return full;
  }

  // A story from prompt to world update: write, check it twice against the sheets and the bible, then update the world.
  // Runs in the app and on the laptop helper, so both write stories the same way. `cut` = { before, premise, length, stage }:
  // the text before this part, and 'write' or 'check' (a resume after the writing was done). `io` does the outside world:
  // chat(messages, { onToken, sofar }), json(messages), step(i, detail), note(detail, frac), text(storyText), save(), signal.
  // Throws only when writing fails or is cancelled; the checks and the world update are best effort. Returns the status line.
  async function storyJob(state, story, cut, io) {
    const { before } = cut;
    const messages = buildStoryMessages(state, { characterIds: story.characterIds, premise: cut.premise, length: cut.length, continueStory: before ? { ...story, text: before } : null, pov: story.pov });
    const target = LENGTHS[cut.length] || LENGTHS.medium;
    let part = story.text.slice(before.length).replace(/^\n\n/, ''), words = 0;
    const keep = () => { story.text = (before ? before + '\n\n' : '') + part; io.text(story.text); };
    const quiet = (e) => { if (io.signal && io.signal.aborted) throw e; };
    io.step(0, `Sending ${story.characterIds.length ? `${story.characterIds.length} character sheets, ` : ''}your world notes and the premise to your AI.`);
    if (cut.stage === 'write') {
      if (part) io.step(1, 'Picking up where the story stopped.');
      await io.chat(messages, { sofar: part, onToken: (t) => {
        if (!part) io.step(1, 'The AI is writing.');
        part += t; keep();
        const n = part.split(/\s+/).length;
        if (n - words >= 10) { words = n; io.note(`${n} of about ${target} words written.`, Math.min(n / target, 0.95)); }
      } });
      part = trimRepeat(part.trim(), before);
      keep();
      story.updatedAt = Date.now();
      cut.stage = 'check';
      await io.save();
    }
    // Second pass: two focused checks against the sheets and the bible, fixed in place with exact edits.
    let fixed = 0;
    for (const [i, kind, what] of [[2, 'lore', 'world lore, personalities and traits'], [3, 'looks', 'how everyone looks']]) {
      io.step(i, `Comparing the story with ${what}.`);
      try {
        const { text, applied } = applyEdits(part, (await io.json(buildCheckMessages(state, story, part, kind))).edits);
        part = text; fixed += applied.length; keep();
        io.note(applied.length ? `Fixed ${applied.length} ${applied.length === 1 ? 'slip' : 'slips'}.` : 'Everything matches.');
      } catch (e) { quiet(e); /* the story stays as written */ }
    }
    await io.save();
    io.step(4, 'Looking for new facts, places, relationships and character developments.');
    const checked = fixed ? ` Fixed ${fixed} continuity ${fixed === 1 ? 'slip' : 'slips'}.` : '';
    try {
      const changes = applyWorldUpdate(state, story, await io.json(buildWorldUpdateMessages(state, story)));
      return (changes.length ? 'World updated: ' + changes.join(', ') + '.' : 'Saved. Nothing new for the world this time.') + checked;
    } catch (e) { quiet(e); return 'Story saved, but the world update failed: ' + e.message + checked; }
  }

  // What the laptop helper needs for one story: the open world without pictures, other worlds, revisions or device keys,
  // and only the story being written in full (the rest by title and summary, which is all the prompts use).
  const HELPER_SETTINGS = ['baseUrl', 'apiKey', 'model', 'temperature', 'style', 'mature', 'spice', 'privateOnly'];
  const noPictures = (k, v) => (typeof v === 'string' && v.startsWith('data:') ? undefined : v);
  // A comic job keeps the story's panel plan, with drawn pictures marked 'kept' (the phone has them; the helper draws only the rest).
  const HELPER_PICTURES = ['comfyUrl', 'comfyModel', 'comfyNsfwModel', 'hordeKey', 'checkPictures'];
  function helperState(state, story, { panels = false } = {}) {
    const ai = state.world.ai || {};
    const settings = Object.fromEntries([...HELPER_SETTINGS, ...(panels ? HELPER_PICTURES : [])].map((k) => [k, state.settings[k]]));
    if (ai.apiKey) settings.apiKey = ai.apiKey;
    if (ai.model) settings.model = ai.model;
    const stories = state.stories.map((x) => (x === story ? { ...x, panels: panels && x.panels ? x.panels.map((p) => ({ ...p, img: p.img ? 'kept' : '' })) : undefined } : { id: x.id, title: x.title, summary: x.summary, characterIds: x.characterIds, createdAt: x.createdAt, chat: x.chat }));
    return JSON.parse(JSON.stringify({ settings, characters: state.characters, world: { ...state.world, ai: undefined }, stories }, noPictures));
  }
  // Puts the helper's finished story, world and characters back. Fields the helper never had (pictures, keys) stay as they are.
  // ponytail: last write wins; a character edited on the phone while the laptop was writing gets the laptop's copy of the fields it returned.
  function applyHelperResult(state, story, result) {
    const { cut, ...back } = result.story;
    Object.assign(story, back);
    Object.assign(state.world, result.world);
    for (const c of result.characters) {
      const mine = state.characters.find((x) => x.id === c.id);
      if (mine) Object.assign(mine, c); else state.characters.push(c);
    }
  }

  // ---------- pictures: the user's own ComfyUI first, AI Horde (free, volunteer-run) otherwise and as its backup outside Private mode ----------
  // Runs in the app and on the laptop helper. `env` is what differs: { fetch, poll (a fetch that rides out dropped connections),
  // pause(ms, signal), toImage(blob) → data URL }.
  const HORDE = 'https://aihorde.net/api/v2';
  // Every picture is 2D anime/manhwa art, never realistic or 3D: anime-trained models only, plus the style in the prompt and its opposite in the negative.
  // ponytail: fixed list from the Horde model reference; if pictures start failing with "no artist free", add whichever anime models have workers now.
  const ANIME_MODELS = ['Animagine XL', 'Hassaku XL', 'Nova Anime XL', 'AAM XL', 'Anything Diffusion', 'Anything v5', 'Counterfeit', 'Pastel Mix', 'Cetus-Mix', 'AnyLoRA'];
  const NEGATIVE = 'photorealistic, realistic, photo, photography, 3d, 3d render, cgi, octane render, unreal engine, doll, plastic skin, ' +
    'text, speech bubble, watermark, signature, lowres, blurry, deformed, extra fingers, bad anatomy';
  const PRIVATE_PICTURES = 'Pictures are off in Private mode: AI Horde\'s volunteer computers would see the descriptions. Draw them on your own PC with ComfyUI instead (Settings → Help & guides).';
  const fmtSecs = (s) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
  // AI Horde's queue check, in words: place in line, its own time estimate, or that someone is drawing it now.
  const waitText = (c = {}) => [c.processing ? 'An artist is drawing it now' : c.queue_position ? `#${c.queue_position} in line` : '',
    c.wait_time ? `about ${fmtSecs(c.wait_time)} left` : ''].filter(Boolean).join(', ');
  // Who draws the pictures, in words for the pop-up. `note` says why the last one went to Horde instead of the PC.
  const artist = (s, note) => (s.comfyUrl && !note ? 'your PC (ComfyUI)' : 'AI Horde\'s volunteer computers');
  const comfyBase = (s) => s.comfyUrl.trim().replace(/\/+$/, '');
  // fetch throws TypeError only when nothing answered (ComfyUI closed, wrong address, blocked by the browser).
  const comfyError = (s, e) => (e instanceof TypeError || e.name === 'TimeoutError' ? `Couldn't reach ComfyUI at ${s.comfyUrl}.` : e.message);
  async function comfyModels(s, env) {
    const res = await env.fetch(comfyBase(s) + '/object_info/CheckpointLoaderSimple', { signal: AbortSignal.timeout(15e3) });
    if (!res.ok) throw new Error(`ComfyUI answered ${res.status}. Check the start file has --enable-cors-header (Help → ComfyUI answers 403).`);
    const opt = (await res.json()).CheckpointLoaderSimple.input.required.ckpt_name;
    return Array.isArray(opt[0]) ? opt[0] : (opt[1] && opt[1].options) || []; // older and newer ComfyUI list choices differently
  }
  // Returns { img, sent: { by, model, prompt } }. Explicit pictures carry the Spice level's tags; portraits (nsfw: false) never do.
  // model: a ComfyUI checkpoint for this picture (default: the one in Settings); seed: the same one across a comic keeps its look steadier.
  // onNote(text) hears why a picture went to Horde instead of the PC ('' when the PC drew it).
  async function drawPicture(s, prompt, onWait, { width = 512, height = 768, nsfw = !!s.mature, signal, model, seed, onNote } = {}, env) {
    prompt = [nsfw && spiceText(s, 'image'), prompt].filter(Boolean).join(', '); // Spice tags first: image models weigh the start most
    const opts = { width, height, nsfw, signal, model, seed };
    if (s.comfyUrl) {
      try { const r = await drawComfy(s, prompt, onWait, opts, env); if (onNote) onNote(''); return r; } catch (e) {
        if (signal && signal.aborted) throw e; // cancelled, not broken: don't hand it to Horde
        const why = comfyError(s, e);
        if (s.privateOnly) throw new Error(why + ' Private mode is on, so AI Horde isn\'t used instead. See Settings → Help & guides.');
        if (onNote) onNote(` ${why} AI Horde is drawing instead.`);
      }
    } else if (s.privateOnly) throw new Error(PRIVATE_PICTURES);
    return drawHorde(s, prompt, onWait, opts, env);
  }
  async function drawComfy(s, prompt, onWait, { width, height, nsfw, signal, model, seed }, env) {
    model = model || s.comfyModel || (await comfyModels(s, env))[0];
    if (!model) throw new Error('ComfyUI has no model yet. Put an anime model in ComfyUI\'s models\\checkpoints folder and restart it.');
    const k = Math.sqrt(1024 * 1024 / (width * height)), px = (x) => Math.round((x * k) / 64) * 64; // SDXL models draw best near one megapixel
    const small = 768 / Math.max(width, height); // sent back at 768px: what the library keeps anyway, and a lighter upload to the picture check
    const workflow = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
      3: { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text: NEGATIVE + (nsfw ? '' : ', nsfw, nude') } },
      4: { class_type: 'EmptyLatentImage', inputs: { width: px(width), height: px(height), batch_size: 1 } },
      // Animagine XL 4 and NoobAI both suggest CFG about 5 and 28 steps with Euler a.
      5: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: null, negative: ['3', 0], latent_image: ['4', 0],
        seed: seed ?? Math.floor(Math.random() * 2 ** 32), steps: 28, cfg: 5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1 } },
      6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
      7: { class_type: 'ImageScale', inputs: { image: ['6', 0], upscale_method: 'area', width: Math.round(width * small), height: Math.round(height * small), crop: 'disabled' } },
      8: { class_type: 'PreviewImage', inputs: { images: ['7', 0] } }, // ComfyUI's temp folder: nothing piles up in its output folder
    };
    // Each BREAK chunk is encoded on its own (nodes 100+) and joined in order (nodes 200+), so every chunk gets the model's full attention.
    prompt = `masterpiece, best quality, absurdres, ${prompt}`;
    let positive;
    prompt.split(/\s*\bBREAK\b\s*/).filter(Boolean).forEach((text, i) => {
      workflow[100 + i] = { class_type: 'CLIPTextEncode', inputs: { clip: ['1', 1], text } };
      positive = i ? (workflow[200 + i] = { class_type: 'ConditioningConcat', inputs: { conditioning_to: positive, conditioning_from: [String(100 + i), 0] } }, [String(200 + i), 0]) : ['100', 0];
    });
    workflow[5].inputs.positive = positive;
    const res = await env.fetch(comfyBase(s) + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow }), signal });
    const job = await res.json().catch(() => ({}));
    if (!res.ok || !job.prompt_id) throw new Error(`ComfyUI refused the picture (${(job.error && job.error.message) || res.status}).`);
    const sent = { by: 'ComfyUI', model, prompt };
    const started = Date.now();
    // ponytail: Cancel stops waiting but lets ComfyUI finish the one picture it's on (seconds); POST /interrupt if that ever matters.
    for (;;) {
      await env.pause(1500, signal);
      const run = (await (await env.poll(`${comfyBase(s)}/history/${job.prompt_id}`, { signal })).json())[job.prompt_id];
      const img = run && Object.values(run.outputs || {}).flatMap((o) => o.images || [])[0];
      if (img) return { img: await env.toImage(await (await env.poll(`${comfyBase(s)}/view?${new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type })}`, { signal })).blob()), sent };
      if (run && run.status && run.status.status_str === 'error') throw new Error('ComfyUI hit an error drawing this picture; its window shows why.');
      // The PC's ComfyUI may be busy with other jobs first (it runs one queue), so allow a long wait.
      if (Date.now() - started > 30 * 60e3) throw new Error('ComfyUI took more than 30 minutes for one picture. Is something else filling its queue?');
      if (onWait) onWait({ processing: true });
    }
  }
  async function drawHorde(s, prompt, onWait, { width, height, nsfw, signal, seed }, env) {
    const headers = { 'Content-Type': 'application/json', apikey: s.hordeKey || '0000000000', 'Client-Agent': 'Aetherstory:1:github.com/romrepostacks/Aetherstory-APP' };
    prompt = `anime style, 2d illustration, ${prompt.replace(/\s*\bBREAK\b\s*/g, ', ')} ### ${NEGATIVE}${nsfw ? '' : ', nsfw, nude'}`; // Horde has no chunks
    const res = await env.fetch(HORDE + '/generate/async', { method: 'POST', headers, body: JSON.stringify({ prompt,
      params: { width, height, steps: 25, n: 1, sampler_name: 'k_euler_a', cfg_scale: 7, ...(seed != null ? { seed: String(seed) } : {}) }, nsfw, censor_nsfw: false, r2: false, models: ANIME_MODELS }), signal });
    const job = await res.json().catch(() => ({}));
    if (!res.ok || !job.id) throw new Error(`The picture request failed (${res.status}). ${job.message || ''}`);
    const sent = { by: 'AI Horde', model: 'an anime model', prompt };
    const started = Date.now();
    const drop = () => env.fetch(`${HORDE}/generate/status/${job.id}`, { method: 'DELETE', headers }).catch(() => {}); // frees the volunteers for someone else
    try {
      for (;;) {
        await env.pause(6000, signal);
        const c = await (await env.poll(`${HORDE}/generate/check/${job.id}`, { headers, signal })).json().catch(() => ({}));
        if (c.done) break;
        if (c.faulted || c.is_possible === false || Date.now() - started > 15 * 60e3) { drop(); throw new Error('No artist was free for this picture right now.'); }
        if (onWait) onWait(c);
      }
    } catch (e) { if (signal && signal.aborted) drop(); throw e; }
    const g = ((await (await env.poll(`${HORDE}/generate/status/${job.id}`, { headers, signal })).json()).generations || [])[0];
    if (!g || !g.img || g.censored) throw new Error(g && g.censored ? 'The artist\'s filter blocked this picture.' : 'No picture came back.');
    const blob = g.img.startsWith('http') ? await (await env.poll(g.img)).blob() : new Blob([Uint8Array.from(atob(g.img), (ch) => ch.charCodeAt(0))], { type: 'image/webp' });
    return { img: await env.toImage(blob), sent };
  }

  // Which ComfyUI model draws a panel, from what the plan says the scene is: explicit panels go to a model that can draw them
  // (the one picked in Settings, else one whose name says it: NoobAI, Pony, Illustrious, WAI, NSFW...), everything else to the
  // everyday model (Settings, else the first that isn't one of those). Returns { model, why } or null to let ComfyUI's default draw.
  // ponytail: two kinds of scene, judged by model names; map more scene kinds (action, scenery) when models with clear strengths get added.
  const SPICY_MODEL = /nsfw|noob|pony|illustrious|\bwai|hentai|lewd|r18/i;
  function pickModel(s, models, explicit) {
    const spicy = models.find((m) => SPICY_MODEL.test(m)), tame = models.find((m) => !SPICY_MODEL.test(m));
    const model = explicit ? s.comfyNsfwModel || spicy || s.comfyModel : s.comfyModel || tame || models[0];
    return model ? { model, why: explicit ? 'explicit scene' : 'everyday scene' } : null;
  }

  // Turns a story into manhwa panels. Slower on purpose, for accuracy: the story AI plans it a part at a time and fact-checks each part's plan,
  // then panels are drawn one at a time in story order, each saved as it lands and, when the AI can see pictures, checked against the story
  // and redrawn once if it's wrong. Runs in the app and on the laptop helper. `cut.replan` plans again from scratch.
  // io: step(i, detail), json(messages), draw(prompt, onWait, opts) → { img, sent }, save(), landed(panel), signal. Returns the status line.
  async function comicJob(state, story, cut, io) {
    const s = state.settings, plan = cut.replan || !(story.panels || []).length;
    const signal = io.signal, quiet = (e) => { if (signal && signal.aborted) throw e; }; // an AI check that fails is skipped, a Cancel isn't
    const cast = state.characters.filter((c) => (story.characterIds || []).includes(c.id)).filter(needsLook);
    io.step(0, 'Your story AI writes fixed body tags (build, size, hair, face) for each character, so they look the same in every panel.');
    if (cast.length) try { applyLooks(cast, await io.json(buildLookMessages(cast))); await io.save(); } catch (e) { quiet(e); } // without them, the written appearance is used
    if (plan) {
      const parts = comicParts(story.text), total = panelCount(story.text), words = (t) => t.split(/\s+/).length, all = words(story.text);
      const panels = [];
      for (const [i, part] of parts.entries()) {
        const where = parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : '';
        io.step(1, `Part ${i + 1} of ${parts.length}: splitting it into scenes, with a caption and speech bubbles for each.`);
        let mine = toPanels(state, await io.json(buildPanelMessages(state, story, part, Math.max(1, Math.round(total * words(part) / all)), panels[panels.length - 1], where)), part);
        io.step(1, `Part ${i + 1} of ${parts.length}: fact-checking the panels against the story and character sheets (order, who is there, clothes, what is explicit).`);
        try { mine = applyPanelCheck(mine, await io.json(buildPanelCheckMessages(state, story, part, mine))); } catch (e) { quiet(e); } // unreadable check: keep the plan
        panels.push(...mine);
      }
      if (!panels.length) throw new Error('No panels came back.');
      story.panels = panels; cut.replan = false;
      await io.save(); io.landed();
    }
    const step = plan ? 2 : 1, todo = story.panels.filter((p) => !p.img), total = todo.length;
    story.seed = story.seed ?? Math.floor(Math.random() * 2 ** 31); // one seed per comic keeps the look steadier; a redraw shifts it
    let done = 0, canCheck = s.checkPictures !== false, doing = '', checkNote = '', note = '';
    const models = s.comfyUrl && io.models ? await io.models().catch(() => []) : [];
    let model = '';
    const progress = (c) => io.step(step, [`${done} of ${total} panels done${doing ? ', ' + doing : ''}. Drawing on ${artist(s, note)}${!note && model ? ` with ${model}` : ''}.`, waitText(c), note.trim(), checkNote,
      'Finished panels appear on the page as they land, so Hide lets you watch.'].filter(Boolean).join('\n'));
    // One at a time, in story order: the PC's ComfyUI and Horde work through them in turn anyway.
    for (const p of todo) {
      const explicit = !!(s.mature && p.explicit !== false && (p.explicit || !p.scene)); // older comics have no explicit flag: drawn as before
      const pick = pickModel(s, models, explicit);
      model = pick && pick.model;
      const draw = async () => {
        doing = 'drawing the next'; progress();
        const r = await io.draw(p.scene ? panelPrompt(state, p) : p.prompt, progress,
          { signal, nsfw: explicit, model: pick ? pick.model : (explicit && s.comfyNsfwModel) || undefined, seed: story.seed + (p.redraws || 0) * 7919, onNote: (n) => { note = n; } });
        p.img = r.img; p.sent = { ...r.sent, ...(pick && r.sent.by === 'ComfyUI' ? { why: pick.why } : {}) }; p.check = '';
        await io.save(); io.landed(p);
      };
      await draw();
      if (canCheck && p.scene) {
        doing = 'checking it matches the story'; progress();
        try {
          const r = await io.json(buildPictureCheckMessages(state, p, p.img));
          if (r && r.ok === false) {
            const why = String(r.problem || 'it didn\'t match').trim();
            p.redraws = (p.redraws || 0) + 1; await draw();
            p.check = `First picture was redrawn: ${why}`;
          } else p.check = 'Checked: matches the story.';
        } catch (e) { quiet(e); canCheck = false; checkNote = 'Your story AI can\'t look at pictures, so the rest aren\'t checked.'; }
        await io.save();
      }
      done++; doing = '';
    }
    return 'Comic ready.';
  }

  // A reply cut off midway (the app went to the background): send what came so far and ask for the rest.
  function carryOn(messages, sofar) {
    if (!sofar) return messages;
    return [...messages, { role: 'assistant', content: sofar },
      { role: 'user', content: 'You were cut off. Continue exactly where your reply stops, even mid-sentence or mid-word. Do not repeat anything already written and add no preface.' }];
  }

  function parseSSE(buffer) {
    const lines = buffer.split('\n');
    const rest = lines.pop();
    const tokens = [];
    let done = false, error = null, whole = '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') { done = true; continue; }
      try {
        const d = JSON.parse(data);
        error = error || providerError(d);
        const c = d.choices && d.choices[0];
        if (c && c.delta && c.delta.content) tokens.push(c.delta.content);
        // Some providers end the stream with the whole reply again under `message`; adding it to the deltas wrote the story twice.
        else if (c && c.message && c.message.content) whole = c.message.content;
      } catch (e) { /* keep-alive or partial junk */ }
    }
    return { tokens, rest, done, error, whole };
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

  const api = { switchWorld, newWorld, deleteWorld, addToWorld, removeFromWorld, worldNames, exportCharacter, importCharacters, newKey, newSalt, deriveKey, seal, unseal, isLocked, isEncrypted, encryptBackup, decryptBackup, LENGTHS, uid, emptyState, normalizeState, buildStoryMessages, trimRepeat, buildCheckMessages, buildWorldUpdateMessages, buildCharacterMessages, buildQuickstartMessages, applyQuickstart, parseJsonLoose, applyWorldUpdate, parseSSE, carryOn, ask, storyJob, helperState, applyHelperResult,
    PRIVATE_PICTURES, fmtSecs, waitText, artist, comfyBase, comfyError, comfyModels, drawPicture, comicJob, pickModel, replyText, freeFallbacks, describeWorld, currentRelationships,
    SPICE, spiceText, memoryPlan, buildMemoryMessages, applyMemory, buildPanelMessages, panelCount, panelPrompt, portraitPrompt, toPanels,
    comicParts, buildPanelCheckMessages, applyPanelCheck, needsLook, buildLookMessages, applyLooks, buildPictureCheckMessages,
    buildReviseSheetMessages, buildReviseStoryMessages, buildChatMessages, chatText, buildPhotoMessages, speechChunks, speechParts, PREMIUM_VOICES, premiumVoices, premiumVoice, voiceRuns, characterGender, voiceGender, applyEdits, sheetChanges, charactersNamedIn, storiesForRevision, applyRevision, undoRevision };
  root.Aether = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

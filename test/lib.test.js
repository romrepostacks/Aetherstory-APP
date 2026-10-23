const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib.js');

function seeded() {
  const s = A.emptyState();
  s.characters.push({ id: 'a', name: 'Mira', personality: 'bold', developments: ['Lost her ship.'] });
  s.characters.push({ id: 'b', name: 'Toren', personality: 'wry', developments: [] });
  s.world.lore.push('Magic is fading.');
  s.stories.push({ id: 's1', title: 'The Wreck', summary: 'Mira loses her ship.', characterIds: ['a'], text: 'Old text.', createdAt: 1 });
  s.stories.push({ id: 's2', title: 'Unrelated', summary: 'Someone else.', characterIds: ['zz'], text: 'x', createdAt: 2 });
  return s;
}

test('story prompt carries world, characters and related past stories only', () => {
  const [sys, user] = A.buildStoryMessages(seeded(), { characterIds: ['a'], premise: 'a storm' });
  assert.match(sys.content, /Magic is fading/);
  assert.match(sys.content, /Mira/);
  assert.match(sys.content, /Lost her ship/);
  assert.match(sys.content, /The Wreck: Mira loses her ship/);
  assert.doesNotMatch(sys.content, /Unrelated/);
  assert.match(user.content, /Premise: a storm/);
  assert.match(user.content, /main characters are Mira/);
});

test('continuation sends the story tail and excludes itself from history', () => {
  const s = seeded();
  const [sys, user] = A.buildStoryMessages(s, { characterIds: ['a'], continueStory: s.stories[0] });
  assert.match(user.content, /Old text/);
  assert.doesNotMatch(sys.content, /The Wreck:/);
});

test('world update merges without duplicates and adds characters', () => {
  const s = seeded();
  const story = { id: 'n', title: 'Untitled story', characterIds: ['a'], text: 't' };
  const changes = A.applyWorldUpdate(s, story, {
    title: 'Storm Song', summary: 'Mira meets Kell.',
    characterUpdates: [{ name: 'mira', development: 'Found a new crew.' }, { name: 'Nobody', development: 'x' }],
    newCharacters: [{ name: 'Kell', personality: 'quiet' }, { name: 'Toren' }],
    lore: ['magic is fading.', 'Storms sing.'], places: 'not a list', timeline: ['Mira meets Kell'],
  });
  assert.equal(story.title, 'Storm Song');
  assert.deepEqual(s.characters[0].developments, ['Lost her ship.', 'Found a new crew.']);
  assert.equal(s.characters.length, 3);
  assert.equal(s.characters[2].name, 'Kell');
  assert.ok(story.characterIds.includes(s.characters[2].id));
  assert.deepEqual(s.world.lore, ['Magic is fading.', 'Storms sing.']);
  assert.deepEqual(s.world.places, []);
  assert.ok(changes.length >= 3);
  A.applyWorldUpdate(s, story, { characterUpdates: [{ name: 'Mira', development: 'found a new crew.' }] });
  assert.equal(s.characters[0].developments.length, 2);
});

test('quickstart builds world and cast', () => {
  const s = A.emptyState();
  const added = A.applyQuickstart(s, { name: 'Vel', overview: 'o', lore: ['l'], characters: [{ name: 'A' }, { name: 'a' }, {}] });
  assert.equal(s.world.name, 'Vel');
  assert.equal(added.length, 1);
});

test('parseJsonLoose handles fenced replies', () => {
  assert.deepEqual(A.parseJsonLoose('Sure!\n```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } });
  assert.throws(() => A.parseJsonLoose('nope'));
});

test('parseSSE splits tokens and keeps partial lines', () => {
  const chunk = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\ndata: {"choi';
  const r = A.parseSSE(chunk);
  assert.deepEqual(r.tokens, ['He', 'llo']);
  assert.equal(r.rest, 'data: {"choi');
  assert.equal(A.parseSSE('data: [DONE]\n').done, true);
});

test('normalizeState fills gaps from partial imports', () => {
  const s = A.normalizeState({ stories: [{ id: 1 }], world: { name: 'X' } });
  assert.equal(s.stories.length, 1);
  assert.deepEqual(s.world.lore, []);
  assert.equal(s.settings.temperature, 0.9);
});

test('relationships: newest state per pair replaces the old one and reaches the story prompt', () => {
  const s = seeded();
  s.world.relationships = ['Mira & Kell: strangers', 'Kell & Toren: brothers'];
  const story = { id: 'n', title: 'x', characterIds: ['a'], text: 't' };
  const changes = A.applyWorldUpdate(s, story, { relationships: ['Kell and Mira: secretly in love', 'Kell & Toren: brothers'] });
  assert.deepEqual(s.world.relationships, ['Kell & Toren: brothers', 'Kell and Mira: secretly in love']);
  assert.ok(changes.includes('1 relationships'));
  // older libraries kept every past state; only the latest is sent
  s.world.relationships = ['Mira & Kell: strangers', 'Mira & Kell: lovers'];
  const [sys, user] = A.buildStoryMessages(s, { characterIds: ['a'] });
  assert.match(user.content, /relationships right now.*Mira & Kell: lovers/);
  assert.doesNotMatch(sys.content + user.content, /strangers/);
});

test('point of view: first person for the chosen character', () => {
  const [, user] = A.buildStoryMessages(seeded(), { characterIds: ['a'], pov: 'a' });
  assert.match(user.content, /first person from Mira's point of view/);
  const [, plain] = A.buildStoryMessages(seeded(), { characterIds: ['a'] });
  assert.doesNotMatch(plain.content, /first person/);
});

test('relationships written in a character profile reach the story prompt', () => {
  const s = A.emptyState();
  s.characters.push({ id: 'a', name: 'Ana', background: 'Runs a bakery. Wife of Ben' }, { id: 'b', name: 'Ben', background: 'Ship captain. Husband of Ana.' });
  const [, user] = A.buildStoryMessages(s, { characterIds: ['a', 'b'] });
  assert.match(user.content, /Ana: Wife of Ben; Ben: Husband of Ana/);
  assert.doesNotMatch(user.content, /bakery\./);
});

test('mature setting is on by default and adds the explicit-content instruction only when on', () => {
  const s = seeded();
  assert.match(A.buildStoryMessages(s, { characterIds: ['a'] })[0].content, /adult fiction/);
  s.settings.mature = false;
  assert.doesNotMatch(A.buildStoryMessages(s, { characterIds: ['a'] })[0].content, /adult fiction/);
});

test('a retired model id saved in settings is swapped for its replacement', () => {
  assert.equal(A.normalizeState({ settings: { model: 'venice/uncensored:free' } }).settings.model, A.emptyState().settings.model);
  assert.equal(A.normalizeState({ settings: { model: 'my/model' } }).settings.model, 'my/model');
});

test('a saved setup using the removed built-in model falls back to the free default', () => {
  const s = A.normalizeState({ settings: { baseUrl: 'builtin', model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' } }).settings;
  assert.equal(s.baseUrl, A.emptyState().settings.baseUrl);
  assert.equal(s.model, A.emptyState().settings.model);
});

test('backups round-trip with the device key and refuse any other key', async () => {
  const key = A.newKey(), other = A.newKey();
  const lib = seeded();
  const file = await A.encryptBackup(lib, key);
  assert.ok(A.isEncrypted(file));
  assert.ok(!JSON.stringify(file).includes('Mira'));
  assert.deepEqual(await A.decryptBackup(JSON.parse(JSON.stringify(file)), key + '\n'), lib);
  await assert.rejects(A.decryptBackup(file, other));
  assert.ok(!A.isEncrypted(lib));
});

test('the app lock seals the library under a passcode and refuses a wrong one', async () => {
  const salt = A.newSalt();
  const lib = seeded();
  const rec = await A.seal(lib, await A.deriveKey('correct horse', salt), salt);
  assert.ok(A.isLocked(rec) && !A.isLocked(lib));
  assert.ok(!JSON.stringify(rec).includes('Mira'));
  assert.deepEqual(await A.unseal(rec, await A.deriveKey('correct horse', rec.salt)), lib);
  await assert.rejects(A.unseal(rec, await A.deriveKey('wrong horse', rec.salt)));
});

test('world revision: previewed changes apply to sheets, world and stories, and undo restores them', () => {
  const s = seeded();
  s.characters[0].appearance = 'Black hair.';
  s.stories[0].text = 'Mira tied back her black hair. The storm came.';
  const sheets = A.sheetChanges(s, {
    characters: [{ name: 'mira', appearance: 'Red hair.' }, { name: 'Toren', personality: 'wry' }, { name: 'Nobody', appearance: 'x' }],
    world: { lore: ['Magic is fading.', 'Mira was born with red hair.'], places: [] },
    affected: ['Mira'],
  });
  assert.deepEqual(sheets.characters, [{ id: 'a', name: 'Mira', set: { appearance: 'Red hair.' } }]);
  assert.deepEqual(Object.keys(sheets.world), ['lore']);
  assert.deepEqual(A.storiesForRevision(s, sheets.affected).map((x) => x.id), ['s1']);
  assert.equal(A.storiesForRevision(s, []).length, 2);

  const { text, applied } = A.applyEdits(s.stories[0].text, [{ find: 'her black hair', replace: 'her red hair' }, { find: 'not in the story', replace: 'x' }, { find: '', replace: 'x' }]);
  assert.equal(text, 'Mira tied back her red hair. The storm came.');
  assert.equal(applied.length, 1);

  const plan = Object.assign(sheets, { revision: 'Mira has red hair', stories: [{ id: 's1', text, summary: '', edits: applied }] });
  A.applyRevision(s, plan);
  assert.equal(s.characters[0].appearance, 'Red hair.');
  assert.equal(s.world.lore.length, 2);
  assert.match(s.stories[0].text, /red hair/);
  assert.equal(s.stories[0].summary, 'Mira loses her ship.');
  assert.equal(s.revisions[0].text, 'Mira has red hair');

  A.undoRevision(s);
  assert.equal(s.characters[0].appearance, 'Black hair.');
  assert.deepEqual(s.world.lore, ['Magic is fading.']);
  assert.match(s.stories[0].text, /black hair/);
  assert.equal(s.revisions.length, 0);
  assert.equal(A.undoRevision(s), null);
});

test('revision prompts carry the change and the story text', () => {
  const s = seeded();
  assert.match(A.buildReviseSheetMessages(s, 'Mira is left-handed')[1].content, /Lost her ship[\s\S]*Mira is left-handed/);
  assert.match(A.buildReviseStoryMessages(s.stories[0], 'Mira is left-handed')[1].content, /Old text/);
});

test('provider errors sent instead of a reply become readable, retryable errors', () => {
  assert.equal(A.replyText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.throws(() => A.replyText({ error: { code: 429, message: 'Rate limit exceeded' } }), (e) => /Rate limit exceeded/.test(e.message) && e.retry);
  assert.throws(() => A.replyText({ error: { code: 400, message: 'bad' } }), (e) => !e.retry);
  assert.throws(() => A.replyText({}), /empty reply/);
  assert.match(A.parseSSE('data: {"error":{"code":502,"message":"Provider down"}}\n').error.message, /Provider down/);
});

test('narration splits text into short, complete pieces that keep every word', () => {
  const text = 'She ran. "Wait!" he called?\n\nThe rain ' + 'fell and fell '.repeat(30) + 'until dawn.';
  const parts = A.speechChunks(text, 60);
  assert.ok(parts.every((p) => p.length <= 60 && p.trim() === p && p));
  assert.strictEqual(parts.join(' ').split(/\s+/).join(' '), text.split(/\s+/).join(' '));
  assert.strictEqual(parts[0], 'She ran. "Wait!" he called?');
  assert.match(parts[1], /^The rain/);
  assert.deepStrictEqual(A.speechChunks(''), []);
});

test('dialogue is voiced by the character named nearest the quote', () => {
  const cast = [{ id: 'a', name: 'Mira Vale' }, { id: 'b', name: 'Toren' }];
  const parts = A.speechParts('The rain fell.\n\n"Run," Mira said. "Now!"\n\nToren froze. “Why?”\n\n"Because," she whispered.', cast);
  assert.deepStrictEqual(parts.map((p) => [p.text, p.id]), [
    ['The rain fell.', null], ['"Run,"', 'a'], ['Mira said.', null], ['"Now!"', 'a'],
    ['Toren froze.', null], ['“Why?”', 'b'], ['"Because,"', null], ['she whispered.', null]]);
  assert.strictEqual(A.characterGender({ personality: 'She is bold; her ship is her life.' }), 'f');
  assert.strictEqual(A.characterGender({ background: 'He lost his brother.' }), 'm');
  assert.strictEqual(A.voiceGender('Microsoft Aria Online (Natural)'), 'f');
  assert.strictEqual(A.voiceGender('Google UK English Male'), 'm');
  assert.strictEqual(A.voiceGender('Samantha'), 'f');
  assert.strictEqual(A.voiceGender('Evan (Enhanced)'), 'm');
});

test('premium narration picks fitting voices and batches lines by voice', () => {
  assert.strictEqual(A.premiumVoice('tts-inworld-1-5-max', 'f', 0, 'Olivia'), 'Sarah');
  assert.strictEqual(A.premiumVoice('tts-inworld-1-5-max', 'm', 7, ''), 'Theodore');
  assert.ok(A.premiumVoices('gone-model').f.length);
  const runs = A.voiceRuns([{ voice: 'n', text: 'A.' }, { voice: 'n', text: 'B.' }, { voice: 'x', text: '"Hi."' }, { voice: 'n', text: 'C.' }]);
  assert.deepStrictEqual(runs, [{ voice: 'n', text: 'A. B.' }, { voice: 'x', text: '"Hi."' }, { voice: 'n', text: 'C.' }]);
  assert.ok(A.voiceRuns([{ voice: 'n', text: 'Word. '.repeat(1000) }], 3000).every((r) => r.text.length <= 3000));
});

test('charactersNamedIn finds characters by first name, ignoring partial words', () => {
  const s = seeded();
  assert.deepEqual(A.charactersNamedIn(s, 'mira is left-handed').map((c) => c.id), ['a']);
  assert.deepEqual(A.charactersNamedIn(s, 'Miranda and Torent'), []);
});

test('worlds keep their own stories, notes and character developments; shared characters keep their sheet', () => {
  const s = A.normalizeState(JSON.parse(JSON.stringify(seeded())));
  A.newWorld(s, 'Second');
  assert.equal(s.stories.length, 0);
  assert.equal(s.characters.length, 0);
  assert.equal(s.library.length, 2);
  A.addToWorld(s, 'a');
  assert.deepEqual(s.characters[0].developments, []); // nothing from the first world bleeds in
  s.characters[0].developments.push('Found a map.');
  s.characters[0].appearance = 'scarred';
  const [sys] = A.buildStoryMessages(s, { characterIds: ['a'] });
  assert.doesNotMatch(sys.content, /Magic is fading|Lost her ship|The Wreck/);
  const second = s.world.id;
  assert.ok(A.switchWorld(s, 'main'));
  assert.equal(s.stories.length, 2);
  assert.deepEqual(s.characters.find((c) => c.id === 'a').developments, ['Lost her ship.']);
  assert.equal(s.characters.find((c) => c.id === 'a').appearance, 'scarred');
  assert.deepEqual(A.worldNames(s.characters.find((c) => c.id === 'a'), s).sort(), ['My World', 'Second']);
  // A round trip through save/load keeps it all.
  const t = A.normalizeState(JSON.parse(JSON.stringify(s)));
  A.switchWorld(t, second);
  assert.deepEqual(t.characters.map((c) => [c.id, c.developments]), [['a', ['Found a map.']]]);
  A.deleteWorld(t, 'main');
  assert.equal(t.otherWorlds.length, 0);
  assert.ok(t.library.every((c) => !c.worlds.includes('main')));
});

test('remove from world keeps what happened there for when they return', () => {
  const s = seeded();
  A.removeFromWorld(s, 'a');
  assert.equal(s.characters.length, 1);
  A.addToWorld(s, 'a');
  assert.deepEqual(s.characters.find((c) => c.id === 'a').developments, ['Lost her ship.']);
});

test('character export/import round trip makes a new character in the open world', () => {
  const s = seeded();
  const file = JSON.parse(JSON.stringify(A.exportCharacter(s.characters[0])));
  assert.equal(file.id, undefined);
  const [c] = A.importCharacters(s, file);
  assert.equal(c.name, 'Mira');
  assert.notEqual(c.id, 'a');
  assert.deepEqual(c.developments, ['Lost her ship.']);
  assert.equal(A.importCharacters(s, { name: '' }).length, 0);
});

test('free OpenRouter models fall back to another free Nemotron, then the free router; paid and other services do not', () => {
  const or = 'https://openrouter.ai/api/v1';
  const V = 'nvidia/nemotron-3.5-super-vl:free', U = 'nvidia/nemotron-3-ultra-550b-a55b:free';
  assert.equal(A.emptyState().settings.model, V);
  assert.equal(A.normalizeState({ settings: { model: U } }).settings.model, V);
  assert.deepEqual(A.freeFallbacks(or, V), [V, U, 'openrouter/free']);
  assert.deepEqual(A.freeFallbacks(or, 'google/gemma-4-31b-it:free'), ['google/gemma-4-31b-it:free', V, 'openrouter/free']);
  assert.equal(A.freeFallbacks(or, 'sao10k/l3.3-euryale-70b'), null);
  assert.equal(A.freeFallbacks('http://localhost:11434/v1', 'x:free'), null);
});

test('chat prompt plays the character, knows who is talking, and the transcript names both', () => {
  const s = seeded();
  const talk = { id: 'c1', chat: true, with: 'a', as: 'b', messages: [{ role: 'user', content: 'Hi.' }, { role: 'assistant', content: '*waves* Hey.' }] };
  const [sys, ...rest] = A.buildChatMessages(s, talk);
  assert.match(sys.content, /You are Mira/);
  assert.match(sys.content, /Who you are talking to\n### Toren/);
  assert.match(sys.content, /Magic is fading/);
  assert.deepStrictEqual(rest.map((m) => m.role), ['user', 'assistant']);
  assert.strictEqual(A.chatText(s, talk), 'Toren: Hi.\n\nMira: *waves* Hey.');
  assert.strictEqual(A.chatText(s, { ...talk, as: '' }).split('\n')[0], 'You: Hi.');
});

test('world update keeps up to 3 next-step choices for stories, none for chats', () => {
  const s = seeded();
  const u = { choices: ['A storm hits', 'Toren returns', 'She sells the map', 'extra'] };
  A.applyWorldUpdate(s, s.stories[0], u);
  assert.deepStrictEqual(s.stories[0].choices, ['A storm hits', 'Toren returns', 'She sells the map']);
  const talk = { id: 'c', chat: true, characterIds: ['a'], text: 'x' };
  A.applyWorldUpdate(s, talk, u);
  assert.strictEqual(talk.choices, undefined);
  assert.match(A.buildWorldUpdateMessages(s, s.stories[0])[1].content, /"choices"/);
});

test('revisions skip chats', () => {
  const s = seeded();
  s.stories.push({ id: 'c', chat: true, characterIds: ['a'], text: 'Mira: hi', messages: [] });
  assert.ok(!A.storiesForRevision(s, ['Mira']).some((x) => x.chat));
  assert.ok(!A.storiesForRevision(s, []).some((x) => x.chat));
});

test('photo prompt sends the image and asks for physical traits only', () => {
  const [m] = A.buildPhotoMessages('data:image/jpeg;base64,xx');
  assert.strictEqual(m.content[1].image_url.url, 'data:image/jpeg;base64,xx');
  assert.match(m.content[0].text, /Do not identify the person/);
});

test('long-term memory condenses only what outgrew the prompt, and archives the originals', () => {
  const s = A.emptyState();
  s.world.lore = Array.from({ length: 45 }, (_, i) => `fact ${i}`);
  s.world.places = ['Port: a harbor'];
  s.characters.push({ id: 'a', name: 'Ana', developments: Array.from({ length: 14 }, (_, i) => `dev ${i}`) });
  const plan = A.memoryPlan(s);
  assert.deepStrictEqual(Object.keys(plan.world), ['lore']);
  assert.strictEqual(plan.world.lore.length, 30);
  assert.strictEqual(plan.chars[0].old.length, 8);
  assert.match(A.buildMemoryMessages(s, plan)[1].content, /fact 0/);
  const done = A.applyMemory(s, plan, { world: { lore: ['old facts, condensed'] }, characters: { Ana: 'Her early years.' } });
  assert.deepStrictEqual(done, ['lore', 'Ana']);
  assert.strictEqual(s.world.lore.length, 16);
  assert.strictEqual(s.world.lore[0], 'old facts, condensed');
  assert.strictEqual(s.world.lore[1], 'fact 30');
  assert.strictEqual(s.characters[0].developments.length, 7);
  assert.strictEqual(s.characters[0].developments[0], 'Earlier: Her early years.');
  assert.strictEqual(s.world.archive.lore.length, 30);
  assert.strictEqual(s.world.archive.developments[0], 'Ana: dev 0');
  assert.strictEqual(A.memoryPlan(s), null);
});

test('long-term memory leaves a list alone if it changed while the AI was condensing', () => {
  const s = A.emptyState();
  s.world.lore = Array.from({ length: 45 }, (_, i) => `fact ${i}`);
  const plan = A.memoryPlan(s);
  s.world.lore[0] = 'revised fact';
  assert.deepStrictEqual(A.applyMemory(s, plan, { world: { lore: ['x'] } }), []);
  assert.strictEqual(s.world.lore.length, 45);
});

test('comic panels swap names for written appearance in the image prompt', () => {
  const s = A.emptyState();
  s.characters.push({ id: 'a', name: 'Ana', appearance: 'tall, red braid, green coat', personality: 'she is calm' }, { id: 'b', name: 'Ben', personality: 'he is loud' });
  const panels = A.toPanels(s, { panels: [
    { scene: 'Ana on a rainy pier at night', tags: 'hug, from side', characters: ['ana', 'Ben', 'Nobody'], caption: 'Later.', dialogue: [{ name: 'Ana', line: 'Wait.' }, { name: 'x', line: '' }] },
    { scene: '' },
  ] });
  assert.strictEqual(panels.length, 1);
  assert.match(panels[0].prompt, /anime manhwa/);
  assert.match(panels[0].prompt, /^1girl, 1boy, hug, from side, clothed\. Ana on a rainy pier/);
  assert.match(panels[0].prompt, /\(tall, red braid, green coat\) and \(a man\)/);
  assert.doesNotMatch(panels[0].prompt, /Ana:/);
  assert.deepStrictEqual(panels[0].dialogue, [{ name: 'Ana', line: 'Wait.' }]);
  assert.match(A.buildPanelMessages(s, { title: 'T', text: 'Once.', characterIds: ['a'] })[1].content, /- Ana: tall, red braid/);
});

test('comic panels keep story order, fixed body tags, scene clothes, and are explicit only when marked', () => {
  const s = A.emptyState();
  s.characters.push({ id: 'a', name: 'Ana', appearance: 'tall, red braid', lookTags: '1girl, adult, muscular, tall, red braid', lookFrom: 'tall, red braid', personality: 'she' });
  const part = 'Ana sat alone at her desk typing a report. Later she kissed him on the pier under the rain.';
  const panels = A.toPanels(s, { panels: [
    { quote: 'she kissed him on the pier', scene: 'kiss on pier', characters: ['Ana'], explicit: true },
    { quote: 'sat alone at her desk typing', scene: 'Ana at her desk', setting: 'office', tags: 'sitting, typing', characters: ['Ana'], clothes: { ana: 'white blouse' } },
    { quote: 'Under the RAIN', scene: 'rain close-up', characters: [] },
  ] }, part);
  assert.deepStrictEqual(panels.map((p) => p.scene), ['Ana at her desk', 'kiss on pier', 'rain close-up']);
  assert.match(panels[0].prompt, /^1girl, sitting, typing, clothed\. Ana at her desk\. office\. \(1girl, adult, muscular, tall, red braid, wearing white blouse\)/);
  assert.strictEqual(panels[1].explicit, true);
  assert.doesNotMatch(panels[1].prompt, /clothed/);
  assert.match(panels[2].prompt, /^no humans/);
  // the check pass can fix fields and reorder, but a partial order is ignored
  const fixed = A.applyPanelCheck(panels.slice(), { order: [2, 1, 3], fixes: [{ panel: 2, explicit: false, scene: 'a hug on the pier' }, { panel: 9, scene: 'x' }] });
  assert.deepStrictEqual(fixed.map((p) => p.scene), ['a hug on the pier', 'Ana at her desk', 'rain close-up']);
  assert.strictEqual(fixed[0].explicit, false);
  assert.strictEqual(A.applyPanelCheck(panels, { order: [1, 1, 2] }), panels);
  // looks are remade when the appearance changes
  assert.strictEqual(A.needsLook(s.characters[0]), false);
  s.characters[0].appearance = 'short, black bob';
  assert.strictEqual(A.needsLook(s.characters[0]), true);
  A.applyLooks(s.characters, { looks: { ANA: '1girl, petite, black bob' } });
  assert.strictEqual(s.characters[0].lookTags, '1girl, petite, black bob');
  assert.strictEqual(A.needsLook(s.characters[0]), false);
});

test('long stories are planned in paragraph-aligned parts', () => {
  const para = Array(500).fill('word').join(' ');
  const parts = A.comicParts([para, para, para, para, para].join('\n\n'));
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(parts.join('\n\n').split(/\s+/).length, 2500);
  assert.deepStrictEqual(A.comicParts('short'), ['short']);
});

test('comic panel count follows story length', () => {
  const words = (n) => Array(n).fill('word').join(' ');
  assert.strictEqual(A.panelCount(words(800)), 8);
  assert.strictEqual(A.panelCount(words(3000)), 20);
  assert.strictEqual(A.panelCount(words(20000)), 40);
  assert.match(A.buildPanelMessages(A.emptyState(), { title: 'T', text: words(3000) })[1].content, /about 20 panels/);
});

test('portraitPrompt draws from appearance, never the name', () => {
  const p = A.portraitPrompt({ name: 'Ana', appearance: 'short silver hair, green eyes' });
  assert.match(p, /silver hair/);
  assert.match(p, /anime/);
  assert.doesNotMatch(p, /Ana/);
  assert.match(A.portraitPrompt({ name: 'Ben', personality: 'he is calm' }), /portrait/);
});

test('spice levels raise the heat in stories, chats and comic pictures, and do nothing with mature off', () => {
  const s = A.emptyState();
  s.characters = [{ id: 'a', name: 'Ana', appearance: '', personality: '', backstory: '', relationships: '', developments: [] }];
  const sys = () => A.buildStoryMessages(s, { characterIds: ['a'] })[0].content;
  assert.equal(s.settings.spice, 'adult');
  const adult = sys();
  assert.match(adult, /explicitly/);
  assert.equal(A.spiceText(s.settings, 'image'), '');
  s.settings.spice = 'nympho';
  assert.ok(sys().length > adult.length && sys().includes(adult.match(/This is private[^\n]*?romance\./)[0]));
  assert.match(A.spiceText(s.settings, 'image'), /nsfw/);
  s.settings.spice = 'bogus';
  assert.equal(sys(), adult);
  s.settings.mature = false;
  assert.equal(A.spiceText(s.settings, 'story'), '');
  assert.equal(A.spiceText(s.settings, 'image'), '');
});

test('parseSSE keeps a closing full-message chunk apart from the deltas', () => {
  const r = A.parseSSE('data: {"choices":[{"delta":{"content":"Hi"}}]}\ndata: {"choices":[{"delta":{},"message":{"content":"Hi"}}]}\n');
  assert.deepEqual(r.tokens, ['Hi']);
  assert.equal(r.whole, 'Hi');
});

test('trimRepeat cuts a story that starts over and a retyped story so far', () => {
  const open = 'Rain hammered the harbor as Ana pulled her coat tighter and watched the last ferry slip away into the fog.';
  const story = `${open} She turned to Ben. "We missed it."\n\n${open.replace('harbor as', 'harbor  as')} She turned`;
  assert.equal(A.trimRepeat(story), `${open} She turned to Ben. "We missed it."`);
  const before = `Morning came slowly. ${open} Ben laughed.`;
  assert.equal(A.trimRepeat(`${open}\nBen laughed.\n\nBy noon the sun was out.`, before), 'By noon the sun was out.');
  assert.equal(A.trimRepeat('By noon the sun was out and the gulls had come back to the pier, loud and hungry.', before), 'By noon the sun was out and the gulls had come back to the pier, loud and hungry.');
});

test('Spice has no Off: old Off libraries open at a level', () => {
  assert.equal(A.normalizeState({ settings: { mature: false } }).settings.mature, true);
  assert.match(A.SPICE.kinky.label, /experimental/);
});

test('carryOn asks for the rest of a cut-off reply', () => {
  const m = [{ role: 'user', content: 'Write.' }];
  assert.equal(A.carryOn(m, ''), m);
  const out = A.carryOn(m, 'Mira ran to the');
  assert.deepEqual(out.slice(0, 2), [m[0], { role: 'assistant', content: 'Mira ran to the' }]);
  assert.match(out[2].content, /Continue exactly where/);
});

test('storyJob writes, checks and updates the world through io, and helperState leaves pictures and keys behind', async () => {
  const s = seeded();
  s.characters[0].portrait = 'data:image/jpeg;base64,xx';
  s.world.ai = { apiKey: 'world-key', model: 'm' };
  const story = { id: 'n', title: 'Untitled story', summary: '', characterIds: ['a'], text: '', createdAt: 3 };
  s.stories.push(story);
  const slim = A.helperState(s, story);
  assert.equal(slim.characters[0].portrait, undefined);
  assert.equal(slim.settings.apiKey, 'world-key');
  assert.equal(slim.world.ai, undefined);
  assert.equal(slim.stories.find((x) => x.id === 's1').text, undefined);
  const steps = [];
  const io = { step: (i) => steps.push(i), note: () => {}, text: () => {}, save: async () => {},
    chat: async (m, { onToken }) => { onToken('Mira sailed into the storm.'); return ''; },
    json: async (m) => (/continuity/.test(m[0].content) ? { edits: [] } : { title: 'Storm', summary: 'Mira sails.', lore: ['Storms bite.'] }) };
  const cut = { before: '', premise: 'storm', length: 'short', stage: 'write' };
  const st = slim.stories.find((x) => x.id === 'n');
  const status = await A.storyJob(slim, st, cut, io);
  assert.equal(st.text, 'Mira sailed into the storm.');
  assert.equal(cut.stage, 'check');
  assert.deepEqual(steps, [0, 1, 2, 3, 4]);
  assert.match(status, /World updated|Saved/);
  A.applyHelperResult(s, story, { story: { ...st, cut }, world: slim.world, characters: slim.characters });
  assert.equal(story.text, 'Mira sailed into the storm.');
  assert.equal(story.cut, undefined);
  assert.equal(s.characters[0].portrait, 'data:image/jpeg;base64,xx'); // pictures the helper never saw stay
  assert.equal(s.world.ai.apiKey, 'world-key');
});

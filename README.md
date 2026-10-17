# Aetherstory

A personal AI story generator that remembers. Characters keep their history, every story is saved, and a shared "world bible" (lore, places, relationships, timeline) grows automatically after each story, so recurring characters build real continuity.

Everything runs in your browser and is stored on your device. There is no server and no app account; the AI runs through a free OpenRouter key you paste in once.

## Open it

**Phone or PC (recommended):** open the GitHub Pages link for this repo, then use your browser's *Install app* / *Add to Home Screen*. It then launches like a normal app.

**PC without hosting:** download the repo and double-click `index.html`.

Data is per device and per browser. To move your library between PC and phone, use **Settings → Export backup** on one and **Import backup** on the other. Backups are encrypted with AES-256-GCM using a random key unique to the device that made them (the API key is never included). To open a backup on a different device, also tap **Download key** on the original device and choose that `aetherstory-key.txt` when the new device asks for it. Keep the key file apart from your backups; without it, a backup can't be opened if the original browser's data is cleared.

## First run

1. **First launch:** confirm you are 18+, then follow the three on-screen steps to make a free OpenRouter key and paste it. That sets up the free Nemotron 3.5 Super VL model, falling back to other free models when it is down (about 25 stories a day; may soften some explicit scenes). Mature content is on by default. *Settings → Advanced mode* keeps the presets, base URL, model and temperature: Gemma 4 (free), Venice Uncensored (under 1 cent a story) and Euryale 70B (paid, reliably uncensored), or a local Ollama/LM Studio. You may need to allow free-model providers in OpenRouter's privacy settings.
2. **Write:** tap *Create my world* (optionally type a one-line vibe). The AI invents a world and a starting cast.
3. Pick characters, tap *Generate story*. Leave the premise blank and the AI chooses one that fits your world.

After each story the app asks the AI what changed and updates the world, the characters' "story developments", and adds any new recurring characters. The next story reads all of that.

**Worlds** (World tab) lets you run several separate series. Each world has its own stories, world notes and revisions, and a story only ever sees the world it is written in. Characters live in one library: add someone from another world on the Cast tab and they keep their sheet, while what happens to them in each world stays in that world. A world can optionally use its own API key and model. **Export** on a character's page saves them as a JSON file; **Import character** on the Cast tab brings one in.

**Revise** fixes a detail everywhere at once. Type the change in plain words ("Ana has red hair, not black"); the AI updates the character sheets, the world notes and every saved story that contradicts it, shows each change for review, and applies them on one tap. The last five revisions can be undone. Future stories follow the change because they read the updated sheets.

**What happens next?** After each story, tap one of three suggested directions to continue it, or ignore them.

**Chat** with any character from their Cast page. They know the world and everything that happened in your stories. Pick who you're talking as (yourself or another character). Chats are saved with your stories; tap *Add this chat to my world* and it updates the world notes and characters like a story does.

**Describe from a photo** on a character's page fills in their appearance (hair, build, style) from a picture. Only physical traits are described, never who the person is, and the photo isn't kept. For the best results, paste a free Google Gemini key under *Settings → Photo AI* (from aistudio.google.com/apikey); otherwise the default free model reads it.

**Backups:** the app asks the browser to keep its data permanently, and reminds you on the Write tab when your last backup is a week old. On a PC, *Settings → Turn on auto-backup to a file* writes a fresh backup after every story and chat; pick a file in a synced folder (OneDrive, Google Drive) to keep a copy off the device.

**Make it a comic** on any story turns it into manhwa-style panels: the AI splits the whole story into panels (about one per 150 words, so a long story gets around 20) with narration boxes and speech, and each panel is illustrated for free by [AI Horde](https://aihorde.net), a network of volunteer computers. Characters are drawn from their written appearance so they stay recognizable. A picture can take a minute or more; panels appear as they finish and are saved, so you can leave and come back. A free Horde key (*Settings → Pictures*) gets shorter waits. Pictures are off in Private mode.

**Long-term memory:** once a world outgrows what fits in a prompt (40 notes per list, 12 developments per character), the app quietly condenses the oldest entries into a few dense ones after a story, so early lore keeps shaping new stories. The originals are kept on the device.

**Listen** reads any story aloud with the voices built into your phone or browser, free and with no setup. Each character speaks their dialogue in their own voice, matched to them automatically (change it on their Cast page). Pick the narrator voice and speed under *Settings → Narration*; downloading "Premium" voices on iPhone or using Edge on PC makes it sound far more natural. For the best voices, paste a Venice API key there (paid, about 3–11¢ a story; replays are free because the audio is saved on the device).

## AI providers

Any OpenAI-compatible `/chat/completions` endpoint works: OpenRouter, OpenAI, or a local model through Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`). For Ollama, start it with `OLLAMA_ORIGINS=*` so the browser may call it.

## Development

No build step. `node --test` runs the logic tests in `test/`. Bump `VERSION` in `sw.js` when shipping changes so installed copies update.

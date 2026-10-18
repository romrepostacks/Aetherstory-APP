// Help & guides shown in the app (Settings → Help & guides). Plain data: app.js draws it.
// A string is a paragraph, an array of strings is numbered steps, `backticks` mark something to type or copy,
// and {ORIGIN} becomes this app's own web address. Add a problem here whenever a new error gets fixed.
(function (root) {
  const guides = [
    { id: 'key', title: 'Get your free AI key', body: [
      'Stories are written by an AI service using your own free key. It takes about two minutes and needs no card.',
      ['Open openrouter.ai/keys and sign in (Google sign-in works).',
        'Tap Create API Key, name it anything (like "stories"), and tap Copy.',
        'In Aetherstory open Settings → AI & writing, paste the key, and tap Start.'],
      'The key is stored only on this device. It is never put in backups, so each device needs it pasted once.'] },
    { id: 'install', title: 'Install the app on your phone or PC', body: [
      'Installing keeps your library safer (phones may clear websites you don\'t install) and opens Aetherstory full screen.',
      ['iPhone: open the app in Safari, tap Share, then Add to Home Screen.',
        'Android: open it in Chrome, tap the ⋮ menu, then Install app (or Add to Home screen).',
        'PC: in Chrome or Edge, click the install icon at the right end of the address bar.'] ] },
    { id: 'move', title: 'Move your library between phone and PC', body: [
      'Everything lives on the device you made it on. To copy it to another device:',
      ['On the old device: Settings → Library & backups → Export backup, then Download key. Keep both files.',
        'Send both files to the new device (email to yourself, a cloud drive, or a cable).',
        'On the new device: Settings → Library & backups → Import backup and pick the backup file. When it asks, pick the key file (aetherstory-key.txt).',
        'Paste your AI key on the new device too (Settings → AI & writing). Keys never travel in backups.'] ] },
    { id: 'spice', title: 'Spice: how explicit stories get', body: [
      'The Spice slider (on the Write tab and in Settings → AI & writing) sets how sexual stories, character chats and comic pictures are.',
      ['Off: no explicit scenes.', 'Adult: explicit when the story calls for it. This is how stories have always been written.',
        'Kinky: more heat and more often, with kinks and dirty talk that fit the characters.', 'Nympho: sex is the heart of every story, with several graphic scenes.'],
      'Free story AIs sometimes soften scenes anyway. Venice and Euryale (paid, under Settings → AI & writing → Advanced mode) follow it most closely. Portraits are always drawn clothed.'] },
    { id: 'horde', title: 'Shorter waits for pictures with AI Horde', body: [
      'Comic panels and portraits are drawn for free by AI Horde, a network of volunteer computers, so a picture can take a minute or more. A free account puts you ahead of anonymous users.',
      ['Open aihorde.net/register, pick a username, and copy the API key it shows. Save it somewhere: it is shown only once.',
        'In Aetherstory open Settings → Pictures and paste it into AI Horde API key.'],
      'For pictures in seconds, draw them on your own PC instead: see "Draw pictures on your PC with ComfyUI".'] },
    { id: 'comfy', title: 'Draw pictures on your PC with ComfyUI', body: [
      'If you have a Windows PC or laptop with an NVIDIA graphics card (6 GB or more), it can draw pictures in seconds instead of minutes, for free, with no limits and no filter. Nothing leaves your PC. AI Horde takes over whenever the PC isn\'t reachable (except in Private mode).',
      'Already use ComfyUI for something else? Read "Keep Aetherstory\'s ComfyUI separate" first: it uses its own copy so the two never mix.',
      ['Download ComfyUI for Windows: open github.com/Comfy-Org/ComfyUI/releases, and under the latest release download "ComfyUI_windows_portable_nvidia.7z".',
        'Unzip it with 7-Zip (7-zip.org) to a folder of its own, for example `C:\\AI\\ComfyUI-Aetherstory`.',
        'Get an anime picture model: download "Animagine XL 4.0" (huggingface.co/cagliostrolab/animagine-xl-4.0, the .safetensors file under Files) or, for spicier pictures, "WAI-NSFW-illustrious-SDXL" from civitai.com (free account needed). Put the file in `ComfyUI_windows_portable\\ComfyUI\\models\\checkpoints`.',
        'In the `ComfyUI_windows_portable` folder, make a text file called `start-aetherstory.bat` (turn on File name extensions in Explorer\'s View menu so it doesn\'t end in .txt) containing this one line:\n`.\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build --port 8189 --enable-cors-header {ORIGIN}`',
        'Double-click start-aetherstory.bat. A black window opens; wait until it says "To see the GUI go to: http://127.0.0.1:8189". Leave it open while you draw.',
        'On the same PC, open Aetherstory → Settings → Pictures, type `http://127.0.0.1:8189` into ComfyUI address, and tap Test. If the browser asks to let the app reach devices on your network, tap Allow. Pick your model from the list.',
        'Draw a portrait on the Cast tab to try it. The first picture takes longer while the model loads; after that each one takes seconds.'],
      'To use it from your phone too, see "Use your PC\'s ComfyUI from your phone".',
      'If the black window shows "out of memory", close games and other ComfyUI windows, or add ` --lowvram` to the end of the line in start-aetherstory.bat.'] },
    { id: 'separate', title: 'Keep Aetherstory\'s ComfyUI separate from other ComfyUI projects', body: [
      'If ComfyUI already does other work on your PC (game sprites, for example), give Aetherstory its own copy so models, settings, add-ons and pictures never mix:',
      ['Own folder: unzip a fresh copy of ComfyUI portable just for Aetherstory (step 2 of the ComfyUI guide). Don\'t reuse your other project\'s folder.',
        'Own port: Aetherstory\'s copy runs on port 8189. Your other project keeps ComfyUI\'s usual 8188, so the two addresses never clash.',
        'Own start file: only start-aetherstory.bat has the `--enable-cors-header` part that lets the app in. Leave your other project\'s start file as it is.',
        'One at a time: both share the same graphics card, and a laptop card can\'t hold two models at once. Close the other ComfyUI window before drawing in Aetherstory, and the other way round.',
        'No clutter: Aetherstory\'s pictures go to ComfyUI\'s temp folder, which empties itself, and are saved inside the app. Your other project\'s output folder stays untouched.'],
      'Short on disk space? The model files are the big part. You can delete the one you don\'t need in either copy\'s models\\checkpoints folder.'] },
    { id: 'faces', title: 'Same faces in every picture', body: [
      'With ComfyUI, a character\'s drawn portrait can guide every comic panel they appear in alone, so their face and hair stay the same. It uses the free IP-Adapter add-on.',
      ['In ComfyUI open Manager → Custom Nodes Manager, search `ComfyUI_IPAdapter_plus`, and install it.',
        'Download `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` into ComfyUI\'s models\\clip_vision folder and `ip-adapter-plus_sdxl_vit-h.safetensors` into models\\ipadapter (both free on huggingface.co/h94/IP-Adapter).',
        'Restart ComfyUI.',
        'In Aetherstory open each character and tap Draw portrait. Then tap Redo comic on a story.'],
      'Only portraits drawn by the app are used, never a picture you added yourself. Panels with two or more people use the look words only, because two references blend the faces together.'] },
    { id: 'phone', title: 'Use your PC\'s ComfyUI from your phone', body: [
      'Your phone can use the PC\'s ComfyUI from anywhere through Tailscale, a free private network between your own devices. Nothing is opened to the internet.',
      ['Install Tailscale (tailscale.com/download) on the PC and on the phone, and sign in to the same account on both. Both should show Connected.',
        'Turn on secure addresses once: open login.tailscale.com/admin/dns on any device, and turn on MagicDNS and HTTPS Certificates.',
        'On the PC, start ComfyUI with start-aetherstory.bat, then open Command Prompt and type `tailscale serve --bg 8189`. It shows an address like https://your-pc.your-tailnet.ts.net. It keeps working after you close the window and after restarts.',
        'On the phone, make sure Tailscale is connected, then open Aetherstory → Settings → Pictures, paste that https address into ComfyUI address, and tap Test.'],
      'The PC has to be on, awake and running ComfyUI while you draw. In Windows power settings, set sleep to Never while plugged in if pictures stop when the screen turns off. When the PC can\'t be reached, AI Horde draws instead.',
      'The https address works on the PC too, so you can use the same one everywhere. To turn the phone access off: `tailscale serve reset`.'] },
    { id: 'private', title: 'Private mode and App lock', body: [
      'Private mode (Settings → AI & writing) only uses AI providers that don\'t keep or train on your stories. Free models may stop working with it on. Pictures then only come from your own PC\'s ComfyUI, never from AI Horde.',
      'App lock (Settings → App lock) encrypts everything on this device with a passcode and locks after 5 minutes in the background. There is no way to recover a forgotten passcode, so keep a backup and your key file.'] },
  ];

  const problems = [
    { q: '"That key did not work"', a: ['Copy the key again, all of it, with no spaces. Or make a new key at openrouter.ai/keys and paste that.'] },
    { q: 'Errors mentioning "rate limit" or 429', a: ['Free models are shared and get busy. The app retries on its own; if it still fails, wait a minute. OpenRouter allows about 50 free stories a day; adding $10 of credit once raises that to about 1,000 a day and the free models stay free.'] },
    { q: '"function id not found" or a 404 from the free model', a: ['The free model\'s provider went down. The app automatically tries two backup free models, so just tap Generate again. If it keeps happening, pick another model in Settings → AI & writing → Advanced mode.'] },
    { q: '"Private mode is on and no private provider serves this model"', a: ['Free models are usually run by providers that keep prompts, so Private mode blocks them. Turn Private mode off, or pick a paid model in Advanced mode.'] },
    { q: 'Stories come out tamer than the Spice setting', a: ['Free models sometimes soften scenes. Raise Spice, or use Venice or Euryale (paid, in Advanced mode), which follow it most closely.'] },
    { q: 'The app crashed reading a reply, or showed a blank error', a: ['Fixed: some providers send an error in a normal-looking reply. The app now shows it as a message. Make sure the app is up to date (see "New features don\'t show up").'] },
    { q: 'New features don\'t show up', a: ['Close the app completely (swipe it away) and open it again. On a PC, refresh the page twice.'] },
    { q: 'My stories disappeared on my phone', a: ['Phones can clear websites that aren\'t installed or haven\'t been opened in a while. Install the app (see "Install the app on your phone or PC") and keep backups. Import your latest backup to get everything back.'] },
    { q: '"This backup was made on another device"', a: ['Backups are locked with the key of the device that made them. Pick that device\'s key file (aetherstory-key.txt), or paste the key. See "Move your library between phone and PC".'] },
    { q: 'Forgot the App lock passcode', a: ['It can\'t be recovered. Tap "erase everything" on the lock screen, then import your latest backup.'] },
    { q: '"No artist was free for this picture right now"', a: ['AI Horde had no volunteer free for that picture. Tap "Draw missing panels" to try again later, add a free Horde key, or draw on your own PC with ComfyUI.'] },
    { q: '"The artist\'s filter blocked this picture"', a: ['A volunteer\'s safety filter refused it. Tap Redraw to try another volunteer. ComfyUI on your own PC has no filter.'] },
    { q: 'Pictures take minutes', a: ['That\'s AI Horde\'s volunteer queue. A free Horde key shortens it; ComfyUI on your PC draws in seconds.'] },
    { q: 'Pictures look realistic or 3D', a: ['The app always asks for 2D anime art. With ComfyUI, the model decides the look: use an anime model such as Animagine XL or an Illustrious model.'] },
    { q: '"Couldn\'t reach ComfyUI"', a: [['Is the black ComfyUI window open, showing port 8189?', 'Is the address in Settings → Pictures right? Tap Test.',
      'On the PC, did the browser ask to reach devices on your network? Allow it in the site settings (the icon left of the address).',
      'On the phone: is Tailscale connected, and did you run `tailscale serve --bg 8189` on the PC? Use the https address, not http.']] },
    { q: 'ComfyUI answers 403, or Test fails right away', a: ['The start file is missing the part that lets the app in. Check the line in start-aetherstory.bat ends with `--enable-cors-header {ORIGIN}`, then close ComfyUI and start it again.'] },
    { q: '"ComfyUI has no model yet"', a: ['Put an anime model file in ComfyUI\\models\\checkpoints (step 3 of the ComfyUI guide), restart ComfyUI, and tap Test.'] },
    { q: 'ComfyUI says "out of memory"', a: ['Close games and any other ComfyUI window, then try again. If it keeps happening, add ` --lowvram` to the end of the line in start-aetherstory.bat.'] },
    { q: 'Pictures come out tamer than the Spice setting', a: ['Comics drawn before an app update keep their old picture plans, so tap Redo comic to replan them. The free AI Horde often blocks explicit pictures, and some models (like Animagine) stay tame however they are asked. For explicit pictures, use ComfyUI with an NSFW-capable anime model such as NoobAI-XL, picked in Settings → Pictures. Character portraits are always drawn clothed.'] },
    { q: '"This model may not read photos"', a: ['"Describe from a photo" needs a model that can see pictures. Add a free Gemini key under Settings → Photo AI.'] },
    { q: 'Face ID doesn\'t show up for App lock, or says this device can\'t use it', a: ['Face ID unlock needs iOS 18 or newer (or a recent Chrome or Edge with Windows Hello on a PC) and a lock that uses a PIN. If Settings → App lock shows "Change to a PIN", tap it first. If it still says this device can\'t use it, update your phone, or keep using the PIN: it works the same.'] },
    { q: 'I changed my PIN and Face ID stopped working', a: ['Changing the PIN asks for Face ID once to re-save it. If that was cancelled, Face ID is turned off: open Settings → App lock and tap Unlock with Face ID again.'] },
  ];

  root.HELP = { guides, problems };
})(typeof window !== 'undefined' ? window : globalThis);

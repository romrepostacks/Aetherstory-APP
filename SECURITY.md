# Security and privacy

Aetherstory holds some of the most private things a person can write. The goal: **nothing a user writes ever leaves their control without them knowing exactly where it goes.**

This file is the living record of how the app protects its users. **Every change that touches stored data, network requests, backups or hosting must update this file in the same pull request.**

## Where data lives

| Data | Where | Protection |
|---|---|---|
| Stories, characters, world | IndexedDB in the user's browser (localStorage if IndexedDB is unavailable) | Browser same-origin isolation. With **App lock** on, sealed with AES-256-GCM under a passcode-derived key. |
| AI API key | Same record as the library | Never written into backups. Sealed with the library when App lock is on. |
| Device backup key (AES-256) | Its own IndexedDB record, outside the library | Never written into backups. Downloaded only when the user taps *Download key*. Sealed under the passcode when App lock is on. |
| App lock passcode and derived key | Nowhere. The key lives only in memory while the app is unlocked. | Only a random salt is stored. |
| Backup files | Wherever the user saves them | AES-256-GCM with the device key. Tampering or a wrong key is detected and refused. |
| World revision undo history | In the library record, so it is sealed by App lock and included in backups like everything else | Keeps the replaced text of edited stories and sheets for the last 5 revisions, so the user can undo. Erase everything removes it. |
| Age confirmation | In the library settings | Not sensitive. |
| Premium narration audio (Venice) | IndexedDB, one record per spoken passage | Plain audio of story text, so only written while App lock is off. Erase everything deletes it. |

There is no server, account system, analytics, telemetry, crash reporting or third-party script. The app is static files on GitHub Pages.

## What leaves the device

1. **Story requests to the AI provider the user picks** (OpenRouter by default). The prompt contains the selected characters' profiles, the world notes and the story so far. This is the one unavoidable flow: the AI cannot write without reading. Who can see it:
   - **OpenRouter** relays it. Users should keep prompt logging off in their OpenRouter privacy settings.
   - **The model's provider** runs it. Free models are often served by providers that may keep or train on prompts, which is why OpenRouter makes free models a separate opt-in in its privacy settings. **Private mode** (Settings) adds `provider.data_collection = "deny"`, so OpenRouter only routes to providers that don't store or train on prompts. Some free models stop working when it's on. When a free model fails, the app asks OpenRouter to fall back to Gemma 4 and then to OpenRouter's free router (`openrouter/free`), so a story can be written by a different free model than the one picked; the same provider rules and Private mode still apply.
2. **World revisions** (Revise tab) send the revision text, every character sheet and the world notes, then each story that mentions an affected character, in full, to the same AI provider. A story already goes there when it is written or continued, so no new party sees it, but one revision can resend many stories at once. The app shows every change before saving and applies nothing the user hasn't confirmed; edits that don't match the story's exact text are dropped.
3. **Narration (🔊 Listen)** uses the browser's built-in speech voices. Most run on the device and send nothing. Some are cloud voices (for example Edge's "Online (Natural)" voices or Chrome's "Google" voices): those send the story text to Microsoft or Google to be spoken. The voice picker marks them "online", and **Private mode** hides them and never uses them. No new code or network address was added to the app for this; it is the browser's own speech feature.
4. **Premium voices (opt-in)**: when the user pastes a Venice API key under Settings → Narration, each story they tap Listen on is sent, in full, to `api.venice.ai` to be turned into speech. Venice says it does not store prompts. The key is stored like the AI key (sealed by App lock, never written into backups, never taken from an imported backup). The returned audio is cached in IndexedDB so replays are free; that cache is **not encrypted**, so while App lock is on it is kept in memory only. Erase everything deletes it.
5. **Loading the app** from GitHub Pages. GitHub sees the visitor's IP address like any web host. No story data is involved.
6. Nothing else. The Content Security Policy blocks scripts from anywhere but the app itself.

## Protections in place

- **App lock (encryption at rest):** an optional passcode (minimum 6 characters) derives an AES-256-GCM key with PBKDF2-SHA256 (600,000 iterations, random 128-bit salt). While the lock is on, the library, API key and device backup key are stored only in sealed form, with a fresh IV on every save. Someone who opens the app, or copies the browser's files, gets ciphertext. The app locks after 5 minutes in the background or on *Lock now*, which reloads the page and drops the key and library from memory. A forgotten passcode can't be recovered, so the lock screen offers *erase everything* and restoring from a backup.
- **Encrypted backups:** AES-256-GCM through WebCrypto, with a random 256-bit key per device and a fresh 96-bit IV per export. A backup from another device needs that device's key file (`aetherstory-key.txt`). The API key is never exported.
- **Imports can't hijack the AI key:** importing a backup never changes this device's AI address, key, model or Private mode. A crafted backup therefore can't send this device's key to a server the attacker controls.
- **Content Security Policy:** scripts run only from the app's own origin. No inline scripts, no `eval`, no plugins, no forms.
- **Safe rendering:** all story and character text is inserted as text nodes. No `innerHTML` anywhere, so model output and imported data can't inject code.
- **Erase everything** (Settings): deletes the library, the API key, the device key, every offline cache and the service worker on this device.
- **No referrer** is sent to linked sites, and search engines are told not to index the app.
- **App switcher blur:** the screen blurs when the app is hidden. This is best effort, because some browsers take the preview snapshot first.
- **18+ gate** on first launch, and mature content clearly labelled.
- **No third-party runtime code.** The on-device model loader from a CDN was removed on 2026-10-10.

## Audit log

### 2026-10-10: full audit before the guided-setup release (PR #9)

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Story text goes to the AI provider, and free providers may keep or train on it. | **Mitigated:** Private mode added as an opt-in switch. The owner chose on 2026-10-10 to keep it off by default so the free model keeps working. |
| 2 | High | The library and API key are stored unencrypted on the device. Anyone who can open the browser, or copy its profile, can read every story. | **Fixed** on 2026-10-10 with App lock (opt-in). Without the lock, data is still plain at rest. |
| 3 | High | The repository is public. An earlier PR description once contained real character details. It was redacted, but GitHub keeps description edit history, and commits that were overwritten stay reachable by their ID. | **Owner action needed:** see the owner checklist below. A check of the current files, every commit on every branch, and all PR descriptions and comments found no personal details today. |
| 4 | High | Supply chain: anyone who can push to `main` ships code to every user's device on the next load, and that code could read the library. | **Owner action needed:** 2FA and branch protection. Workflow actions are pinned to major tags rather than commit SHAs. |
| 5 | Medium | Importing a crafted backup could change the AI address while keeping this device's key, sending the key to an attacker's server. | **Fixed** |
| 6 | Medium | No Content Security Policy. | **Fixed** |
| 7 | Medium | No way to wipe all data from a device. | **Fixed:** Erase everything. |
| 8 | Medium | The app switcher preview could show a story. | **Mitigated:** blur when hidden. |
| 9 | Low | Plain-text backups were the only format. | **Fixed:** exports are always encrypted. Old plain backups can still be imported. |
| 10 | Low | Referrer header and search indexing. | **Fixed** |
| 11 | Info | XSS review: rendering uses `createElement`/text nodes only, and there is no `innerHTML`, `eval` or dynamic script loading. | OK |
| 12 | Info | The device backup key sits in the same browser storage as the library. It protects backup files, not the device itself. | **Fixed:** sealed under the passcode when App lock is on. |
| 13 | Info | A short passcode can be guessed offline by someone who copies the sealed data: PBKDF2 slows each guess but can't save a 6-digit PIN. | Documented. The app asks for 6+ characters and suggests longer. |

## Roadmap (next protections, in priority order)

1. **Turn App lock on by default** during first-run setup, once it has been used for a while.
2. **Change passcode** without turning the lock off and on.
3. **Pin GitHub Actions to commit SHAs** and enable branch protection on `main`.
4. **Self-host or reconsider public hosting.** A private repository removes all public history, but Pages on a private repo needs a paid GitHub plan.

## Owner checklist (things only the repo owner can do)

- [ ] On PR #5, open the "edited" menu on the description and **delete every older revision**.
- [ ] Turn on **two-factor authentication** for the GitHub account.
- [ ] Add a **branch protection rule** on `main` that requires a pull request.
- [ ] In OpenRouter **Settings → Privacy**, keep prompt logging off.
- [ ] Never commit real names, profiles or story text. Tests and docs use made-up names.

## User guidance (shown in the app where it matters)

- Turn on App lock with a long passcode, a short sentence if possible.
- Download your device key once and keep it apart from your backups.
- Use a device passcode, because anyone holding an unlocked phone can open the app.
- Turn on Private mode if you'd rather a story fail than reach a provider that might keep it.

## Reporting a problem

Open a private security advisory on this repository (Security → Advisories → Report a vulnerability). Please don't open a public issue for security problems.

*This document describes technical safeguards. It is not legal advice and doesn't by itself establish compliance with any specific law.*

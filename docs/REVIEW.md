# Review

Checked while fixing missed speech, lost saves, and the lock. Static files only. No third-party script, font, or request.

## What changed

- **Speech.** iPhone no longer opens the microphone for `MediaRecorder` in the same take as `webkitSpeechRecognition`. That pairing was the miss: the recognizer reports `audio-capture` (microphone busy) and, on current iOS, a capture track is muted within a second or two of recognition starting ([WebKit 321436](https://bugs.webkit.org/show_bug.cgi?id=321436)). Audio is off by default on iPhone. If it is on and recognition reports the conflict, the recorder is dropped and listening continues. Each session is a new recognizer. It restarts on end, recycles if iOS goes quiet, and stops itself around 40 seconds so iOS does not have to.
- **Saves.** A draft is written as words arrive, including the latest interim line. Stop always writes a row, even with no audio and even when recognition never started. Hiding the page, leaving it, or a call finishes the take before the screen locks. A draft left behind by a killed page is kept on the next unlock. Older plaintext rows from the first version are encrypted on that unlock and not shown before then.
- **Lock.** A 6-digit PIN wraps an AES-GCM key with PBKDF2-SHA-256, 200,000 iterations. Face ID is a platform passkey. The key is wrapped with the passkey’s PRF secret only when the browser actually returns one. The raw key is held in memory and cleared on lock, after a minute idle, and when the page is hidden. A Face ID sheet does not count as leaving. Wrong PINs pause after five tries.

## Security

- Content-Security-Policy is a meta tag because GitHub Pages cannot set headers. `default-src 'self'`, scripts and styles from this origin only, no inline script, no object/embed, no form posts, no foreign connections. Meta CSP cannot set `frame-ancestors`.
- `referrer` is `no-referrer`.
- Transcripts are inserted with `textContent`. A recognition string that looks like HTML is shown as text.
- Nothing in the repo is a credential. The PIN is not stored. IndexedDB holds ciphertext, a salt, and a wrapped key.
- The key is extractable while unlocked so the PIN and the passkey can rewrap it. A script that ran in the unlocked page could read it. The CSP and the lack of third parties are what make that hard. This is not a defense against a modified copy of the site.

## Privacy

Speech-to-text is Apple’s service in Safari. It needs the network. Audio and text otherwise stay in this browser. No analytics. The service worker caches the shell only.

## What the lock does not do

Anyone can open the public Pages URL. The lock protects notes on this phone from someone holding it. It does not stop a visitor, and a short PIN is not a strong secret if the database is copied off the phone: 200,000 iterations keeps unlock responsive, and a GPU can still walk a million PINs. OWASP’s 600,000 figure is for real passwords. The PRF passkey wrap is the strong one, on browsers that implement it. There is no secret we could have committed that would have changed this.

## A hosting gate, if you want one

GitHub Pages on a public repo cannot sit behind a login. Cloudflare Access can, on a domain you control. Nothing here signs up for that. To add it later:

1. A domain you own, pointed at Cloudflare.
2. A Cloudflare account we can be invited to, or you create the project yourself.
3. A Pages project with this folder as the static output (no build).
4. An Access application on that hostname, Allow policy for your email, one-time PIN. No identity provider account for anyone else.

Access still would not encrypt the notes. The in-app lock stays either way. `github.io` itself cannot be put behind Access.

## Reliability

- `start()` runs inside the tap, before any `await`.
- iOS ends recognition on a pause and about once a minute, and sometimes never fires `onend`. The watchdog recycles a quiet session. `no-speech` is shown as “Not hearing anything” and does not abort the take.
- Home Screen web apps may still lack the API ([bug 225298](https://bugs.webkit.org/show_bug.cgi?id=225298)). The take is saved and the screen links out to Safari.
- Wake Lock is requested only while listening, and again if you come back.
- `navigator.storage.persist()` is requested after unlock. If the phone is out of room, the words are kept and the audio is skipped.
- The service worker is `tap-transcribe-v2`, network-first, so a phone on the old shell picks this up. It reloads on an update only when a take is not in progress.

## Usability and accessibility

- One tap starts. The label under the button says Tap, Stop, or Saving. Stop is not painted in white on the red disc.
- “Listening” and “Not hearing anything” are a live status, in sentence case, with a red or amber control.
- Targets used for PIN, Lock, Copy, Share, and Delete are at least 44px. The record control is larger.
- Text meets 4.5:1 against `#0b0b0d` (`#f5f5f7` body, `#9b9ba4` secondary). The stop icon is white on `#ff3b30` (about 3.5:1, above the 3:1 non-text bar).
- PIN dots announce “N of 6 digits” and never the PIN. Alerts use `role="alert"` or `aria-live`.
- `prefers-reduced-motion` removes the pulse and the meter. Focus is a visible ring.

## Offline

The shell, styles, scripts, manifest, and icons are precached. Recognition cannot run offline. Saved notes open after unlock without a network.

## Tests

`npm test` runs the text helpers and Playwright. Chromium is launched with a fake microphone and an iPhone 13 viewport and user agent, plus a separate WebKit project using the same device profile. Playwright’s WebKit is not iOS Safari. A fake `webkitSpeechRecognition` covers restarts, silence, a blocked recognizer, a thrown recorder, a busy microphone, reload, hiding the page, the PIN, and ciphertext at rest.

A real iPhone still has to confirm: Dictation permission, Home Screen recognition, the actual microphone fight, Face ID PRF, the silent-switch and a phone call, storage eviction, and the installed icon.

# Tap Transcribe

One tap listens and writes a live transcript on your iPhone. Tap again to stop. Notes stay on that phone, locked with a PIN.

**Live:** https://dmlehinger-web.github.io/tap-transcribe/

## Install on iPhone

1. Open the link above in Safari.
2. Tap the Share button.
3. Tap Add to Home Screen, then Add.

Dictation has to be on for live text: Settings → General → Keyboard → Enable Dictation.

The first launch asks for a 6-digit PIN. That PIN encrypts saved notes on this phone. Face ID is offered when the phone can store the key in a passkey. The screen locks again after a minute, and when you leave the app.

## What you get

- One button. Tap to listen, tap to stop.
- Live speech-to-text that starts again when iOS ends a recognition session.
- On iPhone, audio recording stays off unless you turn it on. Recording and transcription share one microphone, and on current iOS the recording wins and the transcript goes silent. The words are the point.
- Notes are written while you talk, not only when you stop. A take with no audio is still saved. Leaving the app or an incoming call finishes the take and locks it.
- Sessions stay in this browser, encrypted. Play audio when you have it, copy the text, share it, or delete it.
- An installable app. After the first visit, the shell still opens with no network. Transcription itself needs Apple’s speech service, which needs a connection.

## iPhone: Safari and the Home Screen

Live text uses `webkitSpeechRecognition`. It works in iOS Safari when Dictation is enabled. WebKit has said the same API is not available in Home Screen web apps or Safari View Controller ([bug 225298](https://bugs.webkit.org/show_bug.cgi?id=225298)). On newer iOS versions a Home Screen session sometimes starts anyway. It is not something to count on.

What this app does instead:

- Speech recognition starts in the same tap, before any microphone request. iOS forgets the tap if `start()` runs later and returns `not-allowed`.
- If recognition is missing or blocked, the take is still saved and the screen says so. From the Home Screen, **Open in Safari** leaves the installed app. The link uses `target="_blank"`, which is what makes iOS switch out of standalone.
- iOS ends recognition on a pause and about once a minute. Each ending starts a new recognizer. A repeated last phrase is dropped. If a session goes quiet with no events, it is recycled.
- If you turn audio on and the recognizer reports that the microphone is busy, audio is switched off and listening continues.
- Playing a saved clip can leave the next recognition hung ([bug 321436](https://bugs.webkit.org/show_bug.cgi?id=321436)). Each new tap pauses playback and builds a new recognizer.

## Privacy on a public site

The repository is public and GitHub Pages on the free plan cannot be private. There is no account and no secret in the repo. The PIN and the optional Face ID passkey never leave the phone; they only unwrap a key that stays in memory. See `docs/REVIEW.md` for what that does and does not protect, and for the steps to put the site behind a real login.

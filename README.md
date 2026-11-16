# Tap Transcribe

One tap starts the iPhone microphone and a live transcript. Tap again to stop. Each take keeps the audio and the words on the phone.

**Live:** https://dmlehinger-web.github.io/tap-transcribe/

## Install on iPhone

1. Open the link above in Safari.
2. Tap the Share button.
3. Tap Add to Home Screen, then Add.

Dictation has to be on for live text: Settings → General → Keyboard → Enable Dictation.

## What you get

- One button. It records and transcribes together, then stops.
- Live speech-to-text that starts again when iOS ends a recognition session, so a long take keeps going.
- Audio saved with the transcript (`audio/mp4` on iPhone). Play it, copy the text, share it, or delete it.
- Sessions stored on the device. The screen stays awake while you record, when the phone allows it.
- An installable app. After the first visit, the shell still opens with no network.

## iPhone: Safari and the Home Screen

Live text uses the browser speech API (`webkitSpeechRecognition`). It works in iOS Safari when Dictation is enabled. WebKit has said the same API is not available in Home Screen web apps or Safari View Controller ([bug 225298](https://bugs.webkit.org/show_bug.cgi?id=225298)); Can I use still says that. On newer iOS versions a Home Screen session sometimes starts anyway. It is not something to count on.

What this app does instead:

- The icon is a standalone app, and every tap still records. That part works from the Home Screen.
- Speech recognition starts in the same tap, before the microphone request is awaited. iOS forgets the tap if `start()` runs later, and returns `not-allowed`.
- If recognition is missing, blocked, or ends immediately, recording continues and the screen says transcription isn’t available. From the Home Screen, **Open in Safari** leaves the installed app and opens the real browser, where dictation works. The link uses `target="_blank"`, which is what makes iOS switch out of standalone.
- iOS ends recognition on a pause and about once a minute, even with `continuous` set. While the button is still recording, each ending starts a new recognizer. Final text is kept. A repeated last phrase is dropped.
- Some iOS versions mute a `MediaRecorder` stream shortly after speech recognition takes the microphone (seen on iOS 27; earlier versions could do both). If the recording track stays muted while words are coming in, the take saves the transcript and says the audio couldn’t be kept. If transcription is the part that failed, the audio file is what gets saved.
- Playing a saved clip can leave the next recognition hung ([bug 321436](https://bugs.webkit.org/show_bug.cgi?id=321436)). Each new tap pauses playback, builds a new recognizer, and opens the microphone again.

Saved files stay in this browser. Apple’s speech service is what turns speech into text, and it needs a network connection.

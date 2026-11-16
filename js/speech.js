/* Live speech on iOS Safari.

   webkitSpeechRecognition is the only transcriber a static page can use,
   and iOS does not keep a session open through silence:

   - A few seconds with no words fires `no-speech`, then `onend`.
   - After words, a pause fires `onend`, often with no error.
   - `aborted` means this session was cancelled or a restart collided.
     It is not a reason to give up.
   - Around a minute the session ends again. Sometimes `onend` never
     comes, so a watchdog starts a fresh recognizer.
   - `start()` has to run inside the original tap. Calling it on the
     same instance, or synchronously inside `onend`, is ignored or
     comes straight back as `aborted`. Each restart is a new instance
     on a 100ms timer. That is as immediate as iOS will accept.

   Silence used to count as a failure after a few quick endings, which
   is what made listening stop while the user was still quiet. Silence,
   `no-speech`, and `aborted` now restart immediately and the screen
   stays on Listening. Only a missing API gives up. Network, permission,
   and other hard errors wait longer between tries and keep going.

   Final phrases are kept across those restarts. A repeated tail is
   dropped so iOS does not print the last line twice. */

import { appendPiece, joinText } from './text.js';

export function createSpeech(options) {
  var onUpdate = options.onUpdate || function () {};
  var onHear = options.onHear || function () {};
  var onFatal = options.onFatal || function () {};
  var onNotice = options.onNotice || function () {};
  var onConflict = options.onConflict || function () {};
  var aggressive = !!options.aggressive;

  var want = false;
  var fatal = false;
  var recognizer = null;
  var restartTimer = 0;
  var capTimer = 0;
  var backupTimer = 0;
  var watchTimer = 0;
  var generation = 0;
  var lastEvent = 0;
  var lastHearing = 0;
  var born = 0;
  var hardRetries = 0;
  var networkFails = 0;
  var triedEn = false;
  var forceLang = '';
  var heard = false;
  var told = '';
  var committed = '';
  var sessionFinal = '';
  var interim = '';

  function snapshot() {
    return {
      finalText: joinText(committed, sessionFinal),
      interimText: String(interim || '').replace(/\s+/g, ' ').trim()
    };
  }

  function emit() {
    onUpdate(snapshot());
  }

  function fold() {
    var extra = joinText(sessionFinal, interim);
    sessionFinal = '';
    interim = '';
    if (extra) committed = joinText(committed, extra);
  }

  function touch(kind) {
    lastEvent = Date.now();
    if (kind === 'hearing') {
      heard = true;
      lastHearing = lastEvent;
      onHear('hearing');
    }
  }

  function clearRunTimers() {
    window.clearTimeout(restartTimer);
    window.clearTimeout(capTimer);
    window.clearTimeout(backupTimer);
  }

  function delayFor(kind) {
    if (kind === 'soft') {
      hardRetries = 0;
      return 100;
    }
    hardRetries += 1;
    var step = Math.min(hardRetries, 5);
    return Math.min(8000, 400 * Math.pow(2, step - 1));
  }

  function scheduleRestart(delay) {
    window.clearTimeout(restartTimer);
    var gen = generation;
    restartTimer = window.setTimeout(function () {
      if (!want || fatal || gen !== generation) return;
      spin();
    }, delay);
  }

  /* iOS sometimes emits no-speech or aborted and never follows with onend.
     The backup starts the next session if that happens. onend cancels it. */
  function armEndBackup(r, kind) {
    var gen = generation;
    window.clearTimeout(backupTimer);
    backupTimer = window.setTimeout(function () {
      if (!want || fatal || gen !== generation || recognizer !== r) return;
      fold();
      emit();
      retire(r);
      scheduleRestart(delayFor(kind));
    }, kind === 'soft' ? 250 : 500);
  }

  function detach(r) {
    r.onstart = null;
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    r.onspeechstart = null;
    r.onspeechend = null;
    r.onsoundstart = null;
    r.onsoundend = null;
  }

  function retire(r) {
    if (!r) return;
    if (recognizer === r) recognizer = null;
    detach(r);
    try { r.abort(); } catch (err) { /* already stopped */ }
  }

  function recycle() {
    var current = recognizer;
    fold();
    emit();
    retire(current);
    scheduleRestart(100);
  }

  function watchdog() {
    if (!want || fatal || !lastEvent) return;
    var stall = aggressive ? 8000 : 12000;
    if (Date.now() - lastEvent > stall) {
      lastEvent = Date.now();
      recycle();
    }
  }

  function report(reason) {
    if (told === reason) return;
    told = reason;
    if (reason === 'network') onNotice(reason);
    else onFatal(reason);
  }

  function spin() {
    if (!want || fatal) return;
    if (recognizer) {
      fold();
      emit();
      retire(recognizer);
    }
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      fatal = true;
      want = false;
      report('missing');
      return;
    }
    var r = new Ctor();
    recognizer = r;
    r.continuous = true;
    r.interimResults = true;
    try {
      var lang = forceLang || navigator.language || 'en-US';
      r.lang = lang === 'en' ? 'en-US' : lang;
    } catch (err) { /* lang is optional */ }
    try { r.maxAlternatives = 1; } catch (err2) { /* Safari */ }
    born = Date.now();

    r.onstart = function () {
      if (recognizer !== r) return;
      touch('listening');
      onHear(lastHearing && Date.now() - lastHearing < 2500 ? 'hearing' : 'listening');
      window.clearTimeout(capTimer);
      window.clearTimeout(backupTimer);
      capTimer = window.setTimeout(function () {
        if (recognizer !== r || !want || fatal) return;
        try { r.stop(); } catch (err) { /* onend may not follow */ }
        var gen = generation;
        backupTimer = window.setTimeout(function () {
          if (!want || fatal || gen !== generation || recognizer !== r) return;
          fold();
          emit();
          retire(r);
          scheduleRestart(100);
        }, 500);
      }, aggressive ? 45000 : 55000);
    };
    r.onspeechstart = function () { if (recognizer === r) touch('hearing'); };
    r.onsoundstart = function () { if (recognizer === r) touch('hearing'); };
    r.onspeechend = function () { if (recognizer === r) touch('listening'); };
    r.onresult = function (event) {
      if (recognizer !== r || !event || !event.results) return;
      var fin = '';
      var mid = '';
      var i;
      for (i = 0; i < event.results.length; i += 1) {
        var alt = event.results[i][0];
        var piece = alt ? alt.transcript : '';
        if (!piece) continue;
        if (event.results[i].isFinal) fin = appendPiece(fin, piece);
        else mid = appendPiece(mid, piece);
      }
      sessionFinal = fin;
      interim = mid;
      if ((fin && fin.trim()) || (mid && mid.trim())) touch('hearing');
      networkFails = 0;
      hardRetries = 0;
      emit();
    };
    r.onerror = function (event) {
      if (recognizer !== r) return;
      var code = event && event.error ? event.error : '';
      touch('listening');
      if (code === 'aborted' || code === 'no-speech') {
        armEndBackup(r, 'soft');
        return;
      }
      if (code === 'audio-capture') {
        onConflict();
        armEndBackup(r, 'soft');
        return;
      }
      if (code === 'language-not-supported' && !triedEn) {
        triedEn = true;
        forceLang = 'en-US';
        armEndBackup(r, 'soft');
        return;
      }
      if (code === 'network') {
        networkFails += 1;
        if (networkFails >= 2) report('network');
        armEndBackup(r, 'hard');
        return;
      }
      if (code === 'not-allowed') {
        if (!heard) report('not-allowed');
        armEndBackup(r, 'hard');
        return;
      }
      if (code === 'service-not-allowed') {
        report('service-not-allowed');
        armEndBackup(r, 'hard');
        return;
      }
      report('retry');
      armEndBackup(r, 'hard');
    };
    r.onend = function () {
      if (recognizer !== r) return;
      recognizer = null;
      window.clearTimeout(capTimer);
      window.clearTimeout(backupTimer);
      fold();
      emit();
      if (!want || fatal) return;
      var kind = 'soft';
      if (networkFails >= 2 || (told && told !== 'network' && !heard)) kind = 'hard';
      scheduleRestart(delayFor(kind));
    };

    try {
      var started = r.start();
      if (started && typeof started.then === 'function') started.catch(function () {});
      lastEvent = Date.now();
    } catch (err) {
      if (recognizer === r) recognizer = null;
      retire(r);
      scheduleRestart(delayFor('hard'));
    }
  }

  function start() {
    generation += 1;
    want = true;
    fatal = false;
    hardRetries = 0;
    networkFails = 0;
    triedEn = false;
    forceLang = '';
    heard = false;
    told = '';
    lastHearing = 0;
    committed = '';
    sessionFinal = '';
    interim = '';
    lastEvent = Date.now();
    born = lastEvent;
    onHear('listening');
    emit();
    spin();
    window.clearInterval(watchTimer);
    watchTimer = window.setInterval(watchdog, 800);
  }

  function stop() {
    want = false;
    generation += 1;
    window.clearInterval(watchTimer);
    clearRunTimers();
    var current = recognizer;
    recognizer = null;
    if (current) {
      detach(current);
      try { current.abort(); } catch (err) { /* already stopped */ }
    }
    fold();
    return joinText(committed, '').trim();
  }

  function reset() {
    committed = '';
    sessionFinal = '';
    interim = '';
  }

  function fullText() {
    return joinText(joinText(committed, sessionFinal), interim).trim();
  }

  return {
    start: start,
    stop: stop,
    reset: reset,
    text: fullText,
    isFatal: function () { return fatal; }
  };
}

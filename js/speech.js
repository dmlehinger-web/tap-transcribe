/* Live speech on iOS Safari.

   webkitSpeechRecognition is the only on-device transcriber we can use
   from a static page. It is unreliable in three ways this controller
   is built around:

   1. It loses the microphone if MediaRecorder or getUserMedia holds it.
      The app keeps audio off on iPhone unless you opt in, and if the
      recognizer reports audio-capture we drop the recorder and keep
      listening. Transcript wins.
   2. iOS ends a session on a pause and again after roughly a minute,
      often with no error. Sometimes it never fires onend at all.
      Each session is a new recognizer. onend starts another. A watchdog
      recycles a session that has gone quiet.
   3. start() has to run inside the tap. Callers must not await anything
      before start().

   Final phrases are kept across those restarts. A repeated tail is
   dropped so iOS doesn't print the last line twice. */

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
  var watchTimer = 0;
  var generation = 0;
  var lastEvent = 0;
  var lastHearing = 0;
  var born = 0;
  var fastFails = 0;
  var networkFails = 0;
  var triedEn = false;
  var forceLang = '';
  var noSpeech = false;
  var heard = false;
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
  }

  function scheduleRestart(delay) {
    window.clearTimeout(restartTimer);
    var gen = generation;
    restartTimer = window.setTimeout(function () {
      if (!want || fatal || gen !== generation) return;
      spin();
    }, delay);
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

  function recycle() {
    var current = recognizer;
    recognizer = null;
    window.clearTimeout(capTimer);
    if (current) {
      detach(current);
      try { current.abort(); } catch (err) { /* already stopped */ }
    }
    fold();
    emit();
    scheduleRestart(220);
  }

  function watchdog() {
    if (!want || fatal) return;
    var idleFor = Date.now() - lastEvent;
    var quietFor = Date.now() - (lastHearing || born || lastEvent);
    if (quietFor > 3200) onHear('silent');
    var stall = aggressive ? 9000 : 20000;
    if (lastEvent && idleFor > stall) {
      lastEvent = Date.now();
      recycle();
    }
  }

  function spin() {
    if (!want || fatal) return;
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      fatal = true;
      want = false;
      onFatal('missing');
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
    noSpeech = false;

    r.onstart = function () {
      if (recognizer !== r) return;
      touch('listening');
      onHear(lastHearing && Date.now() - lastHearing < 2500 ? 'hearing' : 'listening');
      window.clearTimeout(capTimer);
      capTimer = window.setTimeout(function () {
        if (recognizer !== r || !want) return;
        try { r.stop(); } catch (err) { scheduleRestart(200); }
      }, aggressive ? 40000 : 120000);
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
      fastFails = 0;
      emit();
    };
    r.onerror = function (event) {
      if (recognizer !== r) return;
      var code = event && event.error ? event.error : '';
      touch('listening');
      if (code === 'aborted') return;
      if (code === 'no-speech') {
        noSpeech = true;
        onHear('silent');
        return;
      }
      if (code === 'audio-capture') {
        onConflict();
        return;
      }
      if (code === 'language-not-supported' && !triedEn) {
        triedEn = true;
        forceLang = 'en-US';
        return;
      }
      if (code === 'network') {
        networkFails += 1;
        if (networkFails >= 2) onNotice('network');
        return;
      }
      if (code === 'not-allowed') {
        if (heard) return;
        fatal = true;
        want = false;
        onFatal('not-allowed');
        return;
      }
      if (code === 'service-not-allowed') {
        fatal = true;
        want = false;
        onFatal('service-not-allowed');
        return;
      }
      fatal = true;
      want = false;
      onFatal('unavailable');
    };
    r.onend = function () {
      if (recognizer !== r) return;
      var lived = Date.now() - born;
      recognizer = null;
      window.clearTimeout(capTimer);
      fold();
      emit();
      if (!want || fatal) return;
      if (!noSpeech && lived < 500 && !heard) {
        fastFails += 1;
        if (fastFails >= 4) {
          fatal = true;
          want = false;
          onFatal('unavailable');
          return;
        }
      } else if (lived >= 500) {
        fastFails = 0;
      }
      noSpeech = false;
      scheduleRestart(networkFails >= 2 ? 1500 : 260);
    };

    try {
      var started = r.start();
      if (started && typeof started.then === 'function') started.catch(function () {});
      lastEvent = Date.now();
    } catch (err) {
      if (recognizer === r) recognizer = null;
      fastFails += 1;
      if (fastFails >= 4) {
        fatal = true;
        want = false;
        onFatal('unavailable');
        return;
      }
      scheduleRestart(300);
    }
  }

  function start() {
    generation += 1;
    want = true;
    fatal = false;
    fastFails = 0;
    networkFails = 0;
    triedEn = false;
    forceLang = '';
    heard = false;
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

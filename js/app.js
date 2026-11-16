/* Tap Transcribe UI.

   On iPhone, getUserMedia and webkitSpeechRecognition fight over the
   mic, and the recognizer usually loses — that was the missed speech.
   Audio capture stays off there unless you turn it on. If it still
   collides, the recorder is dropped and listening continues.

   Sessions are written while you talk, not only when you tap stop.
   Stopping, hiding, or a phone call still flushes whatever we have,
   including a take with no audio. */

import { formatDuration, formatWhen, joinText, preview } from './text.js';
import { createSpeech } from './speech.js';
import * as vault from './vault.js';

var phase = 'idle';
var hear = 'idle';
var startedAt = 0;
var sessionId = '';
var sessionCreated = 0;
var notice = '';
var speechFailed = false;
var wantedAudio = false;
var audioBlocked = false;
var audioGen = 0;
var recorder = null;
var activeStream = null;
var chunks = [];
var mimeType = '';
var sessions = [];
var audioUrls = new Map();
var flushTimer = 0;
var lastFlush = '';
var finishPromise = null;
var wakeSentinel = null;
var lastInput = Date.now();
var hideTimer = 0;
var locking = false;
var lockMode = 'choose';
var digits = '';
var firstPin = '';
var lockError = '';
var lockBusy = false;
var lockouts = 0;
var lockoutUntil = 0;
var faceOffered = false;
var faceReady = false;
var ceremony = false;

var appEl = document.getElementById('app');
var lockEl = document.getElementById('lock');
var lockTitle = document.getElementById('lock-title');
var lockHelp = document.getElementById('lock-help');
var lockErrorEl = document.getElementById('lock-error');
var faceBtn = document.getElementById('face');
var skipFaceBtn = document.getElementById('skip-face');
var padEl = document.getElementById('pad');
var dotsEl = document.getElementById('dots');
var tapBtn = document.getElementById('tap');
var tapLabel = document.getElementById('tap-label');
var timerEl = document.getElementById('timer');
var statusText = document.getElementById('status-text');
var placeholder = document.getElementById('live-placeholder');
var liveText = document.getElementById('live-text');
var finalEl = document.getElementById('live-final');
var interimEl = document.getElementById('live-interim');
var announcer = document.getElementById('live-announce');
var bannerEl = document.getElementById('banner');
var listEl = document.getElementById('session-list');
var countEl = document.getElementById('session-count');
var hintEl = document.getElementById('hint');
var audioToggle = document.getElementById('audio-toggle');
var saveState = document.getElementById('save-state');
var hearChip = document.getElementById('hear');

var speech = createSpeech({
  aggressive: isIOS(),
  onUpdate: function (snap) {
    renderLive(snap.finalText, snap.interimText);
    scheduleFlush(joinText(snap.finalText, snap.interimText), snap.finalText !== lastFlush);
  },
  onHear: function (state) {
    if (phase !== 'recording' && phase !== 'starting') return;
    hear = state;
    renderChrome();
  },
  onFatal: function (reason) {
    speechFailed = true;
    explainSpeech(reason);
    renderChrome();
  },
  onNotice: function (reason) {
    explainSpeech(reason);
  },
  onConflict: function () {
    dropAudio('This phone can’t transcribe and record at the same time. Audio is off so it can hear you.');
  }
});

function isStandalone() {
  return window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches;
}

function isIOS() {
  var ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function readAudioPref() {
  var stored = null;
  try { stored = localStorage.getItem('tap-transcribe-audio'); } catch (err) { stored = null; }
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return !isIOS();
}

function writeAudioPref(on) {
  try { localStorage.setItem('tap-transcribe-audio', on ? 'on' : 'off'); } catch (err) { /* private mode */ }
}

function setBanner(tone, text, link) {
  if (!text) {
    bannerEl.hidden = true;
    bannerEl.replaceChildren();
    return;
  }
  bannerEl.hidden = false;
  bannerEl.dataset.tone = tone || 'info';
  bannerEl.replaceChildren(document.createTextNode(text));
  if (link) {
    bannerEl.append(document.createTextNode(' '));
    var a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.label;
    bannerEl.append(a);
  }
}

function explainSpeech(reason) {
  var safari = isStandalone() ? { href: './', label: 'Open in Safari' } : null;
  if (reason === 'missing') {
    setBanner('info', 'Live transcription isn’t available in this browser. This take will still be saved.');
    return;
  }
  if (reason === 'not-allowed') {
    setBanner('info', 'Speech recognition was blocked. Turn on Dictation in Settings → General → Keyboard, and allow the microphone.', safari);
    return;
  }
  if (reason === 'service-not-allowed') {
    if (isStandalone()) {
      setBanner('info', 'Live transcription isn’t available from the Home Screen on this iPhone. What you say is still saved.', safari);
    } else {
      setBanner('info', 'Live transcription isn’t available. Turn on Dictation in Settings → General → Keyboard. This take will still be saved.');
    }
    return;
  }
  if (reason === 'network' || reason === 'retry') {
    setBanner('info', 'Live transcription needs a network connection. Still listening.');
    return;
  }
  if (isStandalone()) setBanner('info', 'Live transcription stopped. What you already said is saved.', safari);
  else setBanner('info', 'Live transcription stopped. What you already said is saved.');
}

function renderChrome() {
  var live = phase === 'recording' || phase === 'starting';
  document.body.dataset.phase = phase;
  document.body.dataset.hear = live ? hear : 'idle';
  tapBtn.disabled = phase === 'stopping' || !vault.isUnlocked();
  tapBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
  tapBtn.setAttribute('aria-label', live ? 'Stop transcription' : 'Start transcription');
  tapLabel.textContent = phase === 'stopping' ? 'Saving' : live ? 'Stop' : 'Tap';
  var label = 'Ready';
  if (phase === 'stopping') label = 'Saving';
  else if (live) label = 'Listening';
  statusText.textContent = label;
  hearChip.classList.toggle('is-silent', false);
  hearChip.classList.toggle('is-live', live);
  if (!live) timerEl.textContent = '00:00';
  document.title = live ? 'Listening · Tap Transcribe' : 'Tap Transcribe';
  var theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute('content', live ? '#160806' : '#0b0b0d');
  var on = readAudioPref() && !audioBlocked;
  audioToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  audioToggle.textContent = on ? 'Saving audio' : (isIOS() ? 'Audio off — keeps live text reliable' : 'Audio off');
  audioToggle.disabled = phase === 'stopping';
}

function renderLive(finalText, interimText) {
  var mid = interimText || '';
  finalEl.textContent = finalText || '';
  interimEl.textContent = mid ? ((finalText ? ' ' : '') + mid) : '';
  var empty = !finalText && !mid;
  placeholder.hidden = !empty;
  liveText.hidden = empty;
  if (empty) {
    placeholder.textContent = phase === 'recording' ? 'Listening…' : 'Your words show up here.';
  }
  if (finalText && announcer.textContent !== finalText && (phase === 'recording' || phase === 'stopping')) {
    announcer.textContent = finalText;
  }
}

function currentText() {
  return speech.text();
}

function durationNow() {
  if (!startedAt) return 0;
  return Math.max(0, Date.now() - startedAt);
}

function scheduleFlush(text, soon) {
  if (phase !== 'recording' && phase !== 'starting') return;
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(function () { flushTranscript(text); }, soon ? 40 : 180);
}

function flushTranscript(text) {
  if (!sessionId || !vault.isUnlocked()) return Promise.resolve();
  var body = text == null ? currentText() : text;
  lastFlush = body;
  if (saveState.textContent !== 'Saved on this phone') saveState.textContent = 'Saving…';
  return vault.saveTranscript({
    id: sessionId,
    createdAt: sessionCreated,
    transcript: body,
    notice: notice,
    mimeType: mimeType,
    durationMs: durationNow(),
    status: 'draft'
  }).then(function () {
    if (phase === 'recording' || phase === 'starting') saveState.textContent = 'Saved on this phone';
  }).catch(function () {
    saveState.textContent = 'Not saved yet';
  });
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  var types = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac'];
  var i;
  for (i = 0; i < types.length; i += 1) {
    try { if (MediaRecorder.isTypeSupported(types[i])) return types[i]; } catch (err) { /* keep looking */ }
  }
  return '';
}

function releaseStream() {
  var rec = recorder;
  var stream = activeStream;
  recorder = null;
  activeStream = null;
  if (rec && rec.state !== 'inactive') {
    try { rec.stop(); } catch (err) { /* already stopped */ }
  }
  if (stream) stream.getTracks().forEach(function (track) { try { track.stop(); } catch (err) { /* gone */ } });
}

function dropAudio(message) {
  audioBlocked = true;
  audioGen += 1;
  wantedAudio = false;
  notice = 'text-only';
  writeAudioPref(false);
  chunks = [];
  releaseStream();
  setBanner('info', message);
  renderChrome();
}

function beginAudio(gen) {
  if (!wantedAudio || audioBlocked || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
    if (gen !== audioGen || audioBlocked || phase !== 'recording') {
      stream.getTracks().forEach(function (track) { try { track.stop(); } catch (err) {} });
      return;
    }
    var mime = pickMime();
    var rec;
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (err) {
      stream.getTracks().forEach(function (track) { try { track.stop(); } catch (err2) {} });
      dropAudio('Audio couldn’t start. The words will still be saved.');
      return;
    }
    mimeType = (rec.mimeType || mime || '').split(';')[0];
    chunks = [];
    rec.ondataavailable = function (event) {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    try { rec.start(); } catch (err) {
      stream.getTracks().forEach(function (track) { try { track.stop(); } catch (err2) {} });
      dropAudio('Audio couldn’t start. The words will still be saved.');
      return;
    }
    recorder = rec;
    activeStream = stream;
    var track = stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', function () {
        if (phase === 'recording') requestFinish();
      });
    }
  }).catch(function (err) {
    if (gen !== audioGen || phase !== 'recording') return;
    audioBlocked = true;
    var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    setBanner('info', denied
      ? 'Audio wasn’t allowed. Live text will still be saved.'
      : 'Audio didn’t start. Live text will still be saved.');
    renderChrome();
  });
}

function stopAudio() {
  var rec = recorder;
  var stream = activeStream;
  return new Promise(function (resolve) {
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      if (stream) stream.getTracks().forEach(function (track) { try { track.stop(); } catch (err) {} });
      if (recorder === rec) recorder = null;
      if (activeStream === stream) activeStream = null;
      if (!chunks.length || audioBlocked) {
        resolve(null);
        return;
      }
      var type = mimeType || (rec && rec.mimeType) || 'application/octet-stream';
      type = String(type).split(';')[0];
      var blob = new Blob(chunks, { type: type });
      chunks = [];
      resolve(blob.size ? blob : null);
    };
    if (!rec || rec.state === 'inactive') {
      finish();
      return;
    }
    var killer = window.setTimeout(finish, 2500);
    rec.onstop = function () {
      window.clearTimeout(killer);
      finish();
    };
    try { rec.stop(); } catch (err) {
      window.clearTimeout(killer);
      finish();
    }
  });
}

function sessionNotice(text, audio) {
  if (speechFailed && !text) return 'unavailable';
  if (!text && !audio) return 'empty';
  if (notice === 'text-only' && text) return 'text-only';
  if (wantedAudio && !audio && text) return 'text-only';
  return '';
}

function noteCopy(code, transcript) {
  if (code === 'unavailable' || (!transcript && code === 'empty' && speechFailed)) return 'Live transcription wasn’t available.';
  if (code === 'empty') return 'Nothing was captured.';
  if (code === 'text-only') return 'Audio wasn’t saved.';
  return '';
}

async function refreshSessions() {
  sessions = await vault.listSessions();
  renderSessions();
}

async function finishTake() {
  phase = 'stopping';
  hear = 'idle';
  window.clearTimeout(flushTimer);
  renderChrome();
  var text = speech.stop();
  releaseWake();
  var audio = null;
  try { audio = await stopAudio(); } catch (err) { audio = null; }
  var code = sessionNotice(text, audio);
  var saved = false;
  if (sessionId && vault.isUnlocked()) {
    try {
      await vault.saveTranscript({
        id: sessionId,
        createdAt: sessionCreated,
        transcript: text,
        notice: code,
        mimeType: audio ? (audio.type || mimeType) : '',
        durationMs: durationNow(),
        status: 'saved'
      });
      saved = true;
      if (audio) {
        try {
          await vault.saveAudio(sessionId, audio, audio.type || mimeType);
        } catch (err) {
          setBanner('info', 'Not enough room for the audio. The words were saved.');
        }
      }
    } catch (err) {
      var quota = err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      setBanner('danger', quota
        ? 'This phone is out of room for saved notes.'
        : 'Couldn’t save this take. The words are still on screen.');
    }
  }
  speech.reset();
  sessionId = '';
  vault.setActiveId('');
  phase = 'idle';
  hear = 'idle';
  startedAt = 0;
  audioBlocked = false;
  chunks = [];
  saveState.textContent = saved ? 'Saved on this phone' : saveState.textContent;
  renderChrome();
  renderLive('', '');
  announcer.textContent = '';
  if (saved && vault.isUnlocked()) {
    try { await refreshSessions(); } catch (err) { /* list still shows the previous set */ }
  }
}

function requestFinish() {
  if (phase !== 'recording' && phase !== 'starting') return finishPromise || Promise.resolve();
  if (finishPromise) return finishPromise;
  finishPromise = finishTake().finally(function () { finishPromise = null; });
  return finishPromise;
}

var wakePending = false;

function acquireWake() {
  if (phase !== 'recording' && phase !== 'starting') return;
  if (!navigator.wakeLock || !navigator.wakeLock.request) return;
  if (wakeSentinel || wakePending) return;
  wakePending = true;
  navigator.wakeLock.request('screen').then(function (sentinel) {
    wakePending = false;
    if (phase !== 'recording' && phase !== 'starting') {
      sentinel.release().catch(function () {});
      return;
    }
    wakeSentinel = sentinel;
    if (sentinel.addEventListener) {
      sentinel.addEventListener('release', function () {
        if (wakeSentinel === sentinel) wakeSentinel = null;
        if (phase === 'recording' || phase === 'starting') acquireWake();
      });
    }
  }).catch(function () {
    wakePending = false;
    wakeSentinel = null;
  });
}

function releaseWake() {
  var sentinel = wakeSentinel;
  wakeSentinel = null;
  wakePending = false;
  if (!sentinel) return;
  sentinel.release().catch(function () {});
}

function startTake() {
  if (!vault.isUnlocked() || phase !== 'idle') return;
  document.querySelectorAll('audio').forEach(function (audio) { try { audio.pause(); } catch (err) {} });
  phase = 'recording';
  hear = 'listening';
  startedAt = Date.now();
  sessionCreated = startedAt;
  sessionId = uid();
  vault.setActiveId(sessionId);
  notice = '';
  speechFailed = false;
  audioBlocked = false;
  chunks = [];
  mimeType = '';
  wantedAudio = readAudioPref();
  lastFlush = '';
  setBanner(null);
  saveState.textContent = 'Saving…';
  renderChrome();
  renderLive('', '');
  speech.start();
  audioGen += 1;
  var gen = audioGen;
  flushTranscript('');
  if (wantedAudio) beginAudio(gen);
  acquireWake();
}

function revokeUrl(id) {
  var url = audioUrls.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  audioUrls.delete(id);
}

function renderSessions() {
  var ids = new Set(sessions.map(function (item) { return item.id; }));
  Array.from(audioUrls.keys()).forEach(function (id) { if (!ids.has(id)) revokeUrl(id); });
  listEl.replaceChildren();
  countEl.hidden = sessions.length === 0;
  countEl.textContent = sessions.length ? String(sessions.length) : '';
  if (!sessions.length) {
    listEl.append(el('p', 'empty', 'No sessions yet.'));
    return;
  }
  var group = el('div', 'group');
  sessions.forEach(function (session) {
    var item = el('article', 'session');
    item.dataset.id = session.id;
    var row = el('button', 'row');
    row.type = 'button';
    row.setAttribute('aria-expanded', 'false');
    var when = el('span', 'when', formatWhen(session.createdAt));
    var dur = el('span', 'dur', formatDuration(session.durationMs || 0));
    var line = session.transcript ? preview(session.transcript) : noteCopy(session.notice, session.transcript);
    if (!line) line = 'Saved take';
    var prev = el('span', 'preview', line);
    row.append(when, dur, prev);
    var detail = el('div', 'detail');
    detail.hidden = true;
    if (session.transcript) detail.append(el('p', 'full', session.transcript));
    var extra = noteCopy(session.notice, session.transcript);
    if (extra && extra !== line) detail.append(el('p', 'note', extra));
    else if (!session.transcript && extra) detail.append(el('p', 'note', extra));
    if (session.audio) {
      var url = audioUrls.get(session.id);
      if (!url) {
        url = URL.createObjectURL(session.audio);
        audioUrls.set(session.id, url);
      }
      var audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = url;
      audio.setAttribute('aria-label', 'Play recording');
      detail.append(audio);
    }
    var actions = el('div', 'actions');
    var copyBtn = el('button', '', 'Copy');
    copyBtn.type = 'button';
    copyBtn.dataset.action = 'copy';
    copyBtn.disabled = !session.transcript;
    var shareBtn = el('button', '', 'Share');
    shareBtn.type = 'button';
    shareBtn.dataset.action = 'share';
    shareBtn.disabled = !session.transcript && !session.audio;
    var deleteBtn = el('button', '', 'Delete');
    deleteBtn.type = 'button';
    deleteBtn.dataset.action = 'delete';
    actions.append(copyBtn, shareBtn, deleteBtn);
    detail.append(actions);
    item.append(row, detail);
    group.append(item);
  });
  listEl.append(group);
}

function extFor(mime) {
  var m = String(mime || '').split(';')[0];
  if (m === 'audio/mp4' || m === 'audio/aac' || m === 'audio/m4a') return 'm4a';
  if (m === 'audio/webm') return 'webm';
  if (m === 'audio/ogg') return 'ogg';
  if (m === 'audio/wav' || m === 'audio/wave') return 'wav';
  if (m === 'audio/mpeg') return 'mp3';
  return 'audio';
}

function fileName(session) {
  var d = new Date(session.createdAt);
  var p = function (n) { return String(n).padStart(2, '0'); };
  return 'tap-transcribe-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.' + extFor(session.mimeType);
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return copyFallback(text); });
  }
  return Promise.resolve(copyFallback(text));
}

function copyFallback(text) {
  var area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  area.remove();
  return ok;
}

function flash(btn, text) {
  var old = btn.textContent;
  btn.textContent = text;
  window.setTimeout(function () { if (btn.isConnected) btn.textContent = old; }, 1400);
}

function downloadBlob(blob, name) {
  var a = document.createElement('a');
  var url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

function canShareFiles(file) {
  if (!navigator.canShare) return false;
  try { return navigator.canShare({ files: [file] }); } catch (err) { return false; }
}

function findSession(id) {
  var i;
  for (i = 0; i < sessions.length; i += 1) if (sessions[i].id === id) return sessions[i];
  return null;
}

function wipeDom() {
  sessions = [];
  audioUrls.forEach(function (url) { URL.revokeObjectURL(url); });
  audioUrls.clear();
  renderSessions();
  renderLive('', '');
  saveState.textContent = '';
  setBanner(null);
  announcer.textContent = '';
}

async function lockNow() {
  if (locking) return;
  locking = true;
  try {
    if (phase === 'recording' || phase === 'starting' || phase === 'stopping') await requestFinish();
    await vault.whenIdle();
    vault.clearKey();
    wipeDom();
    phase = 'idle';
    showLock(faceReady ? 'unlock' : 'unlock');
  } finally {
    locking = false;
  }
}

function showLock(mode) {
  lockMode = mode;
  digits = '';
  lockError = '';
  appEl.hidden = true;
  appEl.setAttribute('inert', '');
  lockEl.hidden = false;
  renderLock();
}

async function showApp() {
  lockEl.hidden = true;
  appEl.hidden = false;
  appEl.removeAttribute('inert');
  lastInput = Date.now();
  renderChrome();
  renderLive('', '');
  maybeHint();
  try { await navigator.storage.persist(); } catch (err) { /* optional */ }
  try {
    await vault.migrateLegacy();
    await refreshSessions();
  } catch (err) {
    listEl.replaceChildren(el('p', 'empty', 'Saved notes couldn’t be opened on this phone.'));
  }
}

function renderDots() {
  dotsEl.replaceChildren();
  var i;
  for (i = 0; i < 6; i += 1) {
    var dot = el('span', i < digits.length ? 'pip on' : 'pip');
    dotsEl.append(dot);
  }
  dotsEl.setAttribute('aria-label', digits.length + ' of 6 digits');
}

function renderLock() {
  var titles = {
    choose: 'Choose a PIN',
    confirm: 'Confirm the PIN',
    face: 'Add Face ID',
    unlock: 'Locked',
    'change-new': 'Choose a new PIN',
    'change-confirm': 'Confirm the new PIN'
  };
  var help = {
    choose: 'Six digits. They encrypt notes on this phone.',
    confirm: 'Enter the same six digits again.',
    face: 'Face ID can unlock the notes when this phone supports it. The PIN still works either way.',
    unlock: 'Enter your PIN.',
    'change-new': 'Six digits. Old notes stay readable.',
    'change-confirm': 'Enter the new PIN again.'
  };
  lockTitle.textContent = titles[lockMode] || 'Locked';
  lockHelp.textContent = lockBusy ? 'Checking…' : (help[lockMode] || '');
  lockErrorEl.textContent = lockError;
  lockErrorEl.hidden = !lockError;
  var showPad = lockMode !== 'face';
  padEl.hidden = !showPad;
  dotsEl.hidden = !showPad;
  faceBtn.hidden = !(faceOffered && (lockMode === 'face' || (lockMode === 'unlock' && faceReady)));
  faceBtn.textContent = lockMode === 'face' ? 'Use Face ID' : 'Unlock with Face ID';
  skipFaceBtn.hidden = lockMode !== 'face';
  renderDots();
  padEl.querySelectorAll('button').forEach(function (btn) { btn.disabled = lockBusy; });
  faceBtn.disabled = lockBusy;
  skipFaceBtn.disabled = lockBusy;
}

async function submitPin(pin) {
  if (lockBusy) return;
  if (lockoutUntil && Date.now() < lockoutUntil) {
    lockError = 'Too many tries. Wait a moment.';
    digits = '';
    renderLock();
    return;
  }
  lockBusy = true;
  lockError = '';
  renderLock();
  try {
    if (lockMode === 'choose' || lockMode === 'change-new') {
      firstPin = pin;
      lockMode = lockMode === 'choose' ? 'confirm' : 'change-confirm';
    } else if (lockMode === 'confirm') {
      if (pin !== firstPin) {
        firstPin = '';
        lockMode = 'choose';
        lockError = 'Those PINs don’t match. Start again.';
      } else {
        await vault.setupPin(pin);
        firstPin = '';
        faceOffered = await vault.platformAvailable();
        lockMode = 'face';
      }
    } else if (lockMode === 'change-confirm') {
      if (pin !== firstPin) {
        lockMode = 'change-new';
        lockError = 'Those PINs don’t match. Try again.';
      } else {
        await vault.rewrapPin(pin);
        firstPin = '';
        lockBusy = false;
        await showApp();
        return;
      }
    } else if (lockMode === 'unlock') {
      var ok = await vault.unlockPin(pin);
      if (!ok) {
        lockouts += 1;
        lockError = lockouts >= 5 ? 'Too many tries. Wait 30 seconds.' : 'Wrong PIN.';
        if (lockouts >= 5) lockoutUntil = Date.now() + 30000;
      } else {
        lockouts = 0;
        lockBusy = false;
        await showApp();
        return;
      }
    }
  } catch (err) {
    lockError = 'Couldn’t finish that on this phone.';
  } finally {
    digits = '';
    lockBusy = false;
    if (!lockEl.hidden) renderLock();
  }
}

function pressDigit(d) {
  if (lockBusy || lockMode === 'face') return;
  if (lockoutUntil && Date.now() < lockoutUntil) {
    lockError = 'Too many tries. Wait a moment.';
    renderLock();
    return;
  }
  if (digits.length >= 6) return;
  digits += d;
  renderDots();
  if (digits.length === 6) {
    var pin = digits;
    digits = '';
    submitPin(pin);
  }
}

async function onFace() {
  if (lockBusy) return;
  lockBusy = true;
  ceremony = true;
  lockError = '';
  renderLock();
  try {
    if (lockMode === 'face') {
      var enrolled = await vault.enrollPasskey();
      faceReady = !!enrolled.prf;
      if (!enrolled.prf && enrolled.error) lockError = enrolled.error;
      lockBusy = false;
      await showApp();
      if (lockError) setBanner('info', lockError);
      return;
    }
    var unlocked = await vault.unlockPasskey();
    if (unlocked.ok) {
      lockouts = 0;
      lockBusy = false;
      await showApp();
      return;
    }
    lockError = unlocked.cancelled ? 'Face ID was cancelled.' : 'Face ID didn’t unlock. Use the PIN.';
  } catch (err) {
    lockError = 'Face ID didn’t unlock. Use the PIN.';
  } finally {
    ceremony = false;
    lockBusy = false;
    if (!lockEl.hidden) renderLock();
  }
}

function buildPad() {
  var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  keys.forEach(function (key) {
    if (!key) {
      padEl.append(el('span', 'gap'));
      return;
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    if (key === 'del') {
      btn.dataset.key = 'delete';
      btn.setAttribute('aria-label', 'Delete');
      btn.className = 'del';
      btn.textContent = 'Delete';
    } else {
      btn.dataset.digit = key;
      btn.textContent = key;
      btn.setAttribute('aria-label', key);
    }
    padEl.append(btn);
  });
  padEl.addEventListener('click', function (event) {
    var btn = event.target.closest('button');
    if (!btn) return;
    if (btn.dataset.digit) pressDigit(btn.dataset.digit);
    else if (btn.dataset.key === 'delete') {
      digits = digits.slice(0, -1);
      renderDots();
    }
  });
}

function maybeHint() {
  var dismissed = false;
  try { dismissed = localStorage.getItem('tap-transcribe-hint') === 'off'; } catch (err) { dismissed = false; }
  if (!isIOS() || isStandalone() || dismissed) {
    hintEl.hidden = true;
    return;
  }
  hintEl.hidden = false;
}

function onHide() {
  if (document.visibilityState !== 'hidden') return;
  if (ceremony || lockBusy) return;
  if (!vault.isUnlocked() && lockMode !== 'change-new' && lockMode !== 'change-confirm') return;
  var finish = (phase === 'recording' || phase === 'starting') ? requestFinish() : Promise.resolve();
  finish.then(function () { return vault.whenIdle(); }).then(function () {
    if (document.visibilityState !== 'hidden') return;
    if (!vault.isUnlocked()) return;
    vault.clearKey();
    wipeDom();
    phase = 'idle';
    showLock('unlock');
  }).catch(function () {
    if (document.visibilityState === 'hidden' && vault.isUnlocked()) {
      vault.clearKey();
      wipeDom();
      showLock('unlock');
    }
  });
}

tapBtn.addEventListener('click', function () {
  lastInput = Date.now();
  if (phase === 'stopping') return;
  if (phase === 'recording' || phase === 'starting') {
    requestFinish();
    return;
  }
  startTake();
});

audioToggle.addEventListener('click', function () {
  lastInput = Date.now();
  var next = !readAudioPref();
  if (phase === 'recording' && next) return;
  if (phase === 'recording' && !next) {
    dropAudio('Audio is off. Listening continues.');
    return;
  }
  writeAudioPref(next);
  renderChrome();
});

document.getElementById('lock-now').addEventListener('click', function () {
  lockNow();
});

document.getElementById('change-pin').addEventListener('click', function () {
  if (!vault.isUnlocked()) return;
  firstPin = '';
  showLock('change-new');
});

faceBtn.addEventListener('click', function () { onFace(); });
skipFaceBtn.addEventListener('click', function () {
  if (lockBusy) return;
  showApp();
});

document.getElementById('hint-dismiss').addEventListener('click', function () {
  hintEl.hidden = true;
  try { localStorage.setItem('tap-transcribe-hint', 'off'); } catch (err) {}
});

listEl.addEventListener('click', function (event) {
  lastInput = Date.now();
  var actionBtn = event.target.closest('button[data-action]');
  var row = event.target.closest('.row');
  var card = event.target.closest('.session');
  if (!card) return;
  if (row && !actionBtn) {
    var open = card.classList.toggle('is-open');
    var detail = card.querySelector('.detail');
    detail.hidden = !open;
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    return;
  }
  if (!actionBtn) return;
  var session = findSession(card.dataset.id);
  if (!session && actionBtn.dataset.action !== 'delete') return;
  var action = actionBtn.dataset.action;
  if (action === 'copy') {
    copyText(session.transcript || '').then(function (ok) { flash(actionBtn, ok ? 'Copied' : 'Copy failed'); });
  } else if (action === 'share') {
    shareSession(session, actionBtn);
  } else if (action === 'delete') {
    if (actionBtn.dataset.armed !== '1') {
      actionBtn.dataset.armed = '1';
      actionBtn.textContent = 'Confirm';
      window.setTimeout(function () {
        if (actionBtn.isConnected && actionBtn.dataset.armed === '1') {
          actionBtn.dataset.armed = '0';
          actionBtn.textContent = 'Delete';
        }
      }, 2800);
      return;
    }
    vault.deleteSession(card.dataset.id).then(function () {
      revokeUrl(card.dataset.id);
      sessions = sessions.filter(function (item) { return item.id !== card.dataset.id; });
      renderSessions();
    }).catch(function () { flash(actionBtn, 'Try again'); });
  }
});

function shareSession(session, btn) {
  var text = session.transcript || '';
  btn.disabled = true;
  var done = function () { btn.disabled = false; };
  var file = null;
  if (session.audio && typeof File === 'function') {
    try { file = new File([session.audio], fileName(session), { type: session.audio.type || 'audio/mp4' }); } catch (err) { file = null; }
  }
  if (file && canShareFiles(file)) {
    navigator.share({ title: 'Tap Transcribe', text: text, files: [file] }).catch(function (err) {
      if (!err || err.name !== 'AbortError') flash(btn, 'Try again');
    }).then(done, done);
    return;
  }
  if (navigator.share && text) {
    navigator.share({ title: 'Tap Transcribe', text: text }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      if (session.audio) {
        downloadBlob(session.audio, fileName(session));
        flash(btn, 'Saved');
        return;
      }
      flash(btn, 'Try again');
    }).then(done, done);
    return;
  }
  if (session.audio) {
    downloadBlob(session.audio, fileName(session));
    var after = text ? copyText(text) : Promise.resolve(false);
    after.then(function () { flash(btn, 'Saved'); }).then(done, done);
    return;
  }
  if (text) copyText(text).then(function (ok) { flash(btn, ok ? 'Copied' : 'Unavailable'); }).then(done, done);
  else done();
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') {
    window.clearTimeout(hideTimer);
    if (phase === 'recording' && vault.isUnlocked()) acquireWake();
    return;
  }
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(onHide, 400);
});

window.addEventListener('pagehide', function () {
  if (phase === 'recording' || phase === 'starting') requestFinish();
});

['pointerdown', 'keydown', 'touchstart'].forEach(function (type) {
  document.addEventListener(type, function () { lastInput = Date.now(); }, { passive: true });
});

document.addEventListener('keydown', function (event) {
  if (lockEl.hidden) return;
  if (/^[0-9]$/.test(event.key)) pressDigit(event.key);
  else if (event.key === 'Backspace') {
    digits = digits.slice(0, -1);
    renderDots();
  }
});

window.setInterval(function () {
  if (phase === 'recording' && startedAt) timerEl.textContent = formatDuration(Date.now() - startedAt);
  if (!vault.isUnlocked()) return;
  if (ceremony || lockBusy) return;
  if (phase === 'recording' || phase === 'starting' || phase === 'stopping') {
    lastInput = Date.now();
    if (phase !== 'stopping' && !wakeSentinel) acquireWake();
    return;
  }
  if (Date.now() - lastInput > 60000) lockNow();
}, 500);

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  var had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!had) return;
    if (phase === 'recording' || phase === 'starting' || phase === 'stopping') return;
    window.location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {});
}

buildPad();
renderChrome();

vault.loadMeta().then(async function (meta) {
  faceOffered = await vault.platformAvailable();
  faceReady = !!(meta && meta.prfWrapped && meta.credId);
  if (!meta || !meta.pinWrapped) showLock('choose');
  else showLock('unlock');
  registerSW();
}).catch(function () {
  lockHelp.textContent = 'Saved notes couldn’t be opened on this phone.';
  showLock('choose');
});

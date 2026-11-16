/* Tap Transcribe
   One tap records the mic and transcribes with webkitSpeechRecognition.
   Relative URLs only — served from /tap-transcribe/ on GitHub Pages.
   iOS behavior is documented in README.md. */
(function () {
  'use strict';

  var phase = 'idle';
  var runId = 0;
  var startedAt = 0;
  var stoppedAt = 0;

  var wantSpeech = false;
  var fatalSpeech = false;
  var speechAlive = false;
  var speechEverWorked = false;
  var fastFails = 0;
  var networkFails = 0;
  var retriedLang = false;
  var forceLang = '';
  var recognizer = null;
  var restartTimer = 0;

  var committed = '';
  var sessionFinal = '';
  var interim = '';
  var lastAnnounced = '';

  var recorder = null;
  var activeStream = null;
  var chunks = [];
  var mimeType = '';
  var textOnly = false;
  var recoveryTried = false;
  var muteTimer = 0;

  var bannerReason = '';
  var wakeSentinel = null;
  var sessions = [];
  var audioUrls = new Map();
  var dbPromise = null;
  var stopPromise = null;

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

  function speechLang() {
    if (forceLang) return forceLang;
    var lang = navigator.language || 'en-US';
    if (lang === 'en') return 'en-US';
    return lang;
  }

  function uid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function formatDuration(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
    return pad(m) + ':' + pad(s);
  }

  function formatWhen(ts) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).format(new Date(ts));
    } catch (err) {
      return new Date(ts).toLocaleString();
    }
  }

  function joinText(a, b) {
    var left = String(a || '').replace(/\s+/g, ' ').trim();
    var right = String(b || '').replace(/\s+/g, ' ').trim();
    if (!right) return left;
    if (!left) return right;
    if (left.endsWith(right)) return left;
    var max = Math.min(left.length, right.length);
    var n;
    for (n = max; n >= 8; n -= 1) {
      if (left.slice(-n) === right.slice(0, n)) {
        return (left + right.slice(n)).replace(/\s+/g, ' ').trim();
      }
    }
    return (left + ' ' + right).replace(/\s+/g, ' ').trim();
  }

  function spokenText() {
    return joinText(joinText(committed, sessionFinal), interim);
  }

  function foldSession() {
    var extra = joinText(sessionFinal, interim);
    sessionFinal = '';
    interim = '';
    if (extra) committed = joinText(committed, extra);
  }

  function baseMime(mime) {
    return String(mime || '').split(';')[0].trim();
  }

  function extFor(mime) {
    var m = baseMime(mime);
    if (m === 'audio/mp4' || m === 'audio/aac' || m === 'audio/m4a' || m === 'audio/x-m4a') return 'm4a';
    if (m === 'audio/webm') return 'webm';
    if (m === 'audio/ogg') return 'ogg';
    if (m === 'audio/wav' || m === 'audio/wave' || m === 'audio/x-wav') return 'wav';
    if (m === 'audio/mpeg') return 'mp3';
    return 'audio';
  }

  function fileName(session) {
    var d = new Date(session.createdAt);
    var p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
      + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    return 'tap-transcribe-' + stamp + '.' + extFor(session.mimeType);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function setBanner(tone, text, link) {
    if (!text) {
      bannerReason = '';
      bannerEl.hidden = true;
      bannerEl.replaceChildren();
      bannerEl.removeAttribute('data-tone');
      return;
    }
    bannerEl.hidden = false;
    bannerEl.dataset.tone = tone || 'info';
    bannerEl.setAttribute('aria-live', tone === 'danger' ? 'assertive' : 'polite');
    bannerEl.replaceChildren();
    bannerEl.append(document.createTextNode(text));
    if (link && link.href) {
      bannerEl.append(document.createTextNode(' '));
      var a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.label || 'Open';
      bannerEl.append(a);
    }
  }

  function safariLink() {
    return isStandalone() ? { href: './', label: 'Open in Safari' } : null;
  }

  function explainSpeech(reason) {
    bannerReason = reason;
    var link = safariLink();
    if (reason === 'missing') {
      setBanner('info', 'Live transcription isn’t available in this browser. Audio will still be saved on this phone.');
      bannerReason = reason;
      return;
    }
    if (reason === 'not-allowed') {
      setBanner('info', 'Speech recognition was blocked. Turn on Dictation in Settings → General → Keyboard. Audio keeps recording if the microphone is allowed.', link);
      bannerReason = reason;
      return;
    }
    if (reason === 'network') {
      setBanner('info', 'Live transcription needs a network connection. Audio is still recording.');
      bannerReason = reason;
      return;
    }
    if (reason === 'capture') {
      setBanner('info', 'The microphone is busy, so there’s no live transcript. Audio is still recording.');
      bannerReason = reason;
      return;
    }
    if (reason === 'dropped') {
      setBanner('info', 'Live transcription paused. Audio is still recording.');
      bannerReason = reason;
      return;
    }
    if (reason === 'text-only') {
      setBanner('info', 'This iPhone can’t record audio and transcribe at the same time. This take will keep the words, not the audio.');
      bannerReason = reason;
      return;
    }
    if (isStandalone()) {
      setBanner('info', 'Live transcription isn’t available from the Home Screen on this iPhone. Audio is still recording.', link);
    } else {
      setBanner('info', 'Live transcription isn’t available in this mode. Turn on Dictation in Settings → General → Keyboard. Audio is still recording.');
    }
    bannerReason = reason;
  }

  function explainMic(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      var where = isStandalone()
        ? 'Settings → Transcribe → Microphone'
        : 'Safari’s site settings (the AA menu → Website Settings)';
      setBanner('danger', 'Microphone access is blocked. Allow it under ' + where + ', then tap again.');
      return;
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      setBanner('danger', 'No microphone was found on this device.');
      return;
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      setBanner('danger', 'The microphone is in use by another app. Close it and tap again.');
      return;
    }
    setBanner('danger', 'The microphone didn’t start. Tap again to retry.');
  }

  function renderChrome() {
    var live = phase === 'starting' || phase === 'recording';
    document.body.dataset.phase = phase;
    tapBtn.disabled = phase === 'stopping';
    tapBtn.setAttribute('aria-pressed', live ? 'true' : 'false');
    tapBtn.setAttribute('aria-label', live ? 'Stop recording' : 'Start recording and transcription');
    tapLabel.textContent = phase === 'stopping' ? 'Saving' : live ? 'Stop' : 'Tap';
    statusText.textContent = phase === 'starting'
      ? 'Starting'
      : phase === 'recording'
        ? 'Recording'
        : phase === 'stopping'
          ? 'Saving'
          : 'Ready';
    if (phase === 'idle') timerEl.textContent = '00:00';
    else if (phase === 'stopping' && startedAt) {
      timerEl.textContent = formatDuration((stoppedAt || Date.now()) - startedAt);
    }
    document.title = live ? 'Recording · Tap Transcribe' : 'Tap Transcribe';
    var theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.setAttribute('content', live ? '#1a0e0c' : '#110e0b');
  }

  function renderLive() {
    var finalText = joinText(committed, sessionFinal);
    var mid = String(interim || '').replace(/\s+/g, ' ').trim();
    finalEl.textContent = finalText;
    interimEl.textContent = mid ? (finalText ? ' ' + mid : mid) : '';
    var empty = !finalText && !mid;
    placeholder.hidden = !empty;
    liveText.hidden = empty;
    if (empty) {
      placeholder.textContent = (phase === 'recording' || phase === 'starting')
        ? 'Listening…'
        : 'Words show up here while you talk.';
    }
    var speaking = phase === 'recording' || phase === 'starting' || phase === 'stopping';
    if (finalText && finalText !== lastAnnounced && speaking) {
      lastAnnounced = finalText;
      announcer.textContent = finalText;
    }
    if (phase === 'idle') {
      lastAnnounced = '';
      announcer.textContent = '';
    }
  }

  function resetSpeechText() {
    committed = '';
    sessionFinal = '';
    interim = '';
    lastAnnounced = '';
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open('tap-transcribe', 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function allSessions() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessions', 'readonly');
        var req = tx.objectStore('sessions').getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function putSession(session) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(session);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('aborted')); };
      });
    });
  }

  function deleteSession(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('aborted')); };
      });
    });
  }

  function revokeSession(id) {
    var url = audioUrls.get(id);
    if (!url) return;
    URL.revokeObjectURL(url);
    audioUrls.delete(id);
  }

  function audioUrl(session) {
    if (!session.audio) return '';
    var url = audioUrls.get(session.id);
    if (!url) {
      url = URL.createObjectURL(session.audio);
      audioUrls.set(session.id, url);
    }
    return url;
  }

  function renderSessions() {
    var ids = new Set(sessions.map(function (s) { return s.id; }));
    Array.from(audioUrls.keys()).forEach(function (id) {
      if (!ids.has(id)) revokeSession(id);
    });
    sessions.sort(function (a, b) { return b.createdAt - a.createdAt; });
    listEl.replaceChildren();
    if (!sessions.length) {
      listEl.append(el('p', 'empty', 'Nothing saved yet.'));
      countEl.hidden = true;
      return;
    }
    countEl.hidden = false;
    countEl.textContent = String(sessions.length);
    sessions.forEach(function (session) {
      var card = el('article', 'card');
      card.dataset.id = session.id;

      var top = el('div', 'card-top');
      var time = el('time', 'when', formatWhen(session.createdAt));
      time.dateTime = new Date(session.createdAt).toISOString();
      top.append(time, el('span', 'dur', formatDuration(session.durationMs || 0)));
      card.append(top);

      if (session.transcript) {
        card.append(el('p', 'transcript', session.transcript));
      } else if (session.notice === 'audio-only') {
        card.append(el('p', 'notice', 'Live transcription wasn’t available.'));
      } else {
        card.append(el('p', 'notice', 'No speech detected.'));
      }
      if (session.notice === 'text-only') {
        card.append(el('p', 'notice', 'No audio for this take.'));
      }

      if (session.audio) {
        var audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = audioUrl(session);
        audio.setAttribute('aria-label', 'Play recording');
        card.append(audio);
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
      if (session.transcript && session.transcript.length > 180) {
        var moreBtn = el('button', '', 'More');
        moreBtn.type = 'button';
        moreBtn.dataset.action = 'more';
        moreBtn.setAttribute('aria-expanded', 'false');
        actions.append(moreBtn);
      }
      card.append(actions);
      listEl.append(card);
    });
  }

  function loadSessions() {
    return allSessions().then(function (rows) {
      sessions = rows || [];
      renderSessions();
    }).catch(function () {
      listEl.replaceChildren(el('p', 'empty', 'Saved sessions couldn’t be opened on this device.'));
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
        return copyFallback(text);
      });
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
    setTimeout(function () {
      if (btn.isConnected) btn.textContent = old;
    }, 1600);
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2500);
  }

  function canShareFiles(file) {
    if (!navigator.canShare) return false;
    try { return navigator.canShare({ files: [file] }); } catch (err) { return false; }
  }

  function onCopy(session, btn) {
    copyText(session.transcript || '').then(function (ok) {
      flash(btn, ok ? 'Copied' : 'Copy failed');
    });
  }

  function onShare(session, btn) {
    var text = session.transcript || '';
    var title = 'Tap Transcribe';
    btn.disabled = true;
    var done = function () { btn.disabled = false; };
    var chain = Promise.resolve();
    if (session.audio && typeof File === 'function') {
      var file = new File([session.audio], fileName(session), { type: session.audio.type || 'audio/mp4' });
      if (canShareFiles(file)) {
        chain = navigator.share({ title: title, text: text, files: [file] });
        return chain.catch(function (err) {
          if (err && err.name === 'AbortError') return;
          flash(btn, 'Try again');
        }).then(done, done);
      }
    }
    if (navigator.share && text) {
      return navigator.share({ title: title, text: text }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (session.audio) {
          downloadBlob(session.audio, fileName(session));
          flash(btn, 'Saved');
          return;
        }
        flash(btn, 'Try again');
      }).then(done, done);
    }
    if (session.audio) {
      downloadBlob(session.audio, fileName(session));
      var after = text ? copyText(text) : Promise.resolve(false);
      return after.then(function () { flash(btn, 'Saved'); }).then(done, done);
    }
    if (text) {
      return copyText(text).then(function (ok) {
        flash(btn, ok ? 'Copied' : 'Unavailable');
      }).then(done, done);
    }
    done();
    return Promise.resolve();
  }

  function onDelete(id, btn) {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Confirm';
      setTimeout(function () {
        if (btn.isConnected && btn.dataset.armed === '1') {
          btn.dataset.armed = '0';
          btn.textContent = 'Delete';
        }
      }, 2800);
      return;
    }
    deleteSession(id).then(function () {
      revokeSession(id);
      sessions = sessions.filter(function (s) { return s.id !== id; });
      renderSessions();
    }).catch(function () {
      flash(btn, 'Try again');
    });
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    var types = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac'];
    var i;
    for (i = 0; i < types.length; i += 1) {
      try {
        if (MediaRecorder.isTypeSupported(types[i])) return types[i];
      } catch (err) { /* keep looking */ }
    }
    return '';
  }

  function makeRecorder(stream) {
    var mime = pickMime();
    if (mime) {
      try {
        return { rec: new MediaRecorder(stream, { mimeType: mime }), mime: mime };
      } catch (err) { /* fall through */ }
    }
    return { rec: new MediaRecorder(stream), mime: '' };
  }

  function trackUnmuted() {
    if (!activeStream) return false;
    var tracks = activeStream.getAudioTracks();
    if (!tracks.length) return false;
    return !tracks[0].muted;
  }

  function watchMute(track) {
    if (!track) return;
    var arm = function () {
      window.clearTimeout(muteTimer);
      muteTimer = window.setTimeout(onMuted, 2500);
    };
    var disarm = function () {
      window.clearTimeout(muteTimer);
      if (textOnly && speechAlive && !fatalSpeech && bannerReason === 'text-only') {
        textOnly = false;
        setBanner(null);
      }
    };
    track.addEventListener('mute', arm);
    track.addEventListener('unmute', disarm);
    if (track.muted) arm();
  }

  function onMuted() {
    if (phase !== 'recording' && phase !== 'starting') return;
    if (trackUnmuted()) return;
    if (speechAlive && !fatalSpeech) {
      textOnly = true;
      explainSpeech('text-only');
      return;
    }
    if (recoveryTried || fatalSpeech) return;
    recoveryTried = true;
    reopenForAudio();
  }

  function attachRecorder(stream, skipMuteWatch) {
    var made = makeRecorder(stream);
    var rec = made.rec;
    mimeType = baseMime(made.mime || rec.mimeType || '');
    chunks = [];
    rec.ondataavailable = function (event) {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    rec.onerror = function () {
      if (phase === 'recording' || phase === 'starting') requestStop();
    };
    rec.start();
    recorder = rec;
    activeStream = stream;
    var track = stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', function () {
        if (phase === 'recording' || phase === 'starting') requestStop();
      });
      if (!skipMuteWatch) watchMute(track);
    }
    if (phase === 'starting') {
      phase = 'recording';
      acquireWake();
      renderChrome();
    }
  }

  function beginAudio(my) {
    var attempts = [
      { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } },
      { audio: true }
    ];
    var tryAt = function (index) {
      return navigator.mediaDevices.getUserMedia(attempts[index]).then(function (stream) {
        if (my !== runId) {
          stream.getTracks().forEach(function (t) { try { t.stop(); } catch (err) {} });
          return;
        }
        attachRecorder(stream, false);
      }).catch(function (err) {
        if (my !== runId) return;
        if (index === 0 && err && (err.name === 'OverconstrainedError' || err.name === 'NotSupportedError')) {
          return tryAt(1);
        }
        throw err;
      });
    };
    return tryAt(0);
  }

  function reopenForAudio() {
    var my = runId;
    wantSpeech = false;
    fatalSpeech = true;
    haltRecognizer();
    explainSpeech(isStandalone() ? 'standalone' : 'capture');
    var oldRec = recorder;
    var oldStream = activeStream;
    recorder = null;
    activeStream = null;
    chunks = [];
    if (oldRec && oldRec.state !== 'inactive') {
      try { oldRec.stop(); } catch (err) {}
    }
    if (oldStream) {
      oldStream.getTracks().forEach(function (t) { try { t.stop(); } catch (err) {} });
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (my !== runId || (phase !== 'recording' && phase !== 'starting')) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      textOnly = false;
      attachRecorder(stream, true);
    }).catch(function (err) {
      if (my !== runId) return;
      explainMic(err);
    });
  }

  function haltRecognizer() {
    wantSpeech = false;
    window.clearTimeout(restartTimer);
    var current = recognizer;
    recognizer = null;
    if (current) {
      current.onstart = null;
      current.onresult = null;
      current.onerror = null;
      current.onend = null;
      try { current.abort(); } catch (err) {
        try { current.stop(); } catch (err2) {}
      }
    }
    foldSession();
  }

  function spinRecognizer(Ctor, my) {
    if (!wantSpeech || fatalSpeech || my !== runId) return;
    var r = new Ctor();
    recognizer = r;
    r.continuous = true;
    r.interimResults = true;
    r.lang = speechLang();
    if ('maxAlternatives' in r) r.maxAlternatives = 1;
    var born = Date.now();
    r.onstart = function () {
      if (recognizer !== r) return;
      speechAlive = true;
    };
    r.onresult = function (event) {
      if (recognizer !== r) return;
      var fin = '';
      var mid = '';
      var i;
      for (i = 0; i < event.results.length; i += 1) {
        var piece = event.results[i][0] ? event.results[i][0].transcript : '';
        if (!piece) continue;
        if (event.results[i].isFinal) fin = joinPiece(fin, piece);
        else mid = joinPiece(mid, piece);
      }
      sessionFinal = fin;
      interim = mid;
      if ((fin && fin.trim()) || (mid && mid.trim())) {
        speechEverWorked = true;
        if (bannerReason === 'network') setBanner(null);
      }
      renderLive();
    };
    r.onerror = function (event) {
      if (recognizer !== r) return;
      var code = event.error || '';
      if (code === 'aborted' || code === 'no-speech') return;
      if (code === 'language-not-supported' && !retriedLang) {
        retriedLang = true;
        forceLang = 'en-US';
        return;
      }
      if (code === 'network') {
        networkFails += 1;
        if (networkFails < 2) return;
        fatalSpeech = true;
        wantSpeech = false;
        explainSpeech('network');
        return;
      }
      if (code === 'not-allowed') {
        if (speechEverWorked) {
          fastFails += 1;
          if (fastFails < 2) return;
          fatalSpeech = true;
          wantSpeech = false;
          explainSpeech('dropped');
          return;
        }
        fatalSpeech = true;
        wantSpeech = false;
        explainSpeech('not-allowed');
        return;
      }
      if (code === 'service-not-allowed') {
        fatalSpeech = true;
        wantSpeech = false;
        explainSpeech(isStandalone() ? 'standalone' : 'service-not-allowed');
        return;
      }
      if (code === 'audio-capture') {
        fatalSpeech = true;
        wantSpeech = false;
        explainSpeech('capture');
        return;
      }
      fatalSpeech = true;
      wantSpeech = false;
      explainSpeech(isStandalone() ? 'standalone' : 'unavailable');
    };
    r.onend = function () {
      if (recognizer !== r) return;
      var lived = Date.now() - born;
      recognizer = null;
      foldSession();
      renderLive();
      if (!wantSpeech || fatalSpeech || my !== runId) return;
      if (lived < 450) {
        fastFails += 1;
        if (fastFails >= 3) {
          wantSpeech = false;
          fatalSpeech = true;
          explainSpeech(isStandalone() ? 'standalone' : 'unavailable');
          return;
        }
      } else {
        fastFails = 0;
      }
      restartTimer = window.setTimeout(function () { spinRecognizer(Ctor, my); }, 280);
    };
    try {
      var started = r.start();
      if (started && typeof started.then === 'function') {
        started.catch(function () {});
      }
    } catch (err) {
      recognizer = null;
      wantSpeech = false;
      fatalSpeech = true;
      explainSpeech(isStandalone() ? 'standalone' : 'unavailable');
    }
  }

  function joinPiece(buf, piece) {
    if (!piece) return buf;
    if (!buf) return piece;
    if (/\s$/.test(buf) || /^\s/.test(piece)) return buf + piece;
    return buf + ' ' + piece;
  }

  function beginSpeech(my) {
    fatalSpeech = false;
    speechAlive = false;
    speechEverWorked = false;
    fastFails = 0;
    networkFails = 0;
    wantSpeech = true;
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      wantSpeech = false;
      fatalSpeech = true;
      explainSpeech('missing');
      return;
    }
    try {
      spinRecognizer(Ctor, my);
    } catch (err) {
      wantSpeech = false;
      fatalSpeech = true;
      explainSpeech(isStandalone() ? 'standalone' : 'unavailable');
    }
  }

  function acquireWake() {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return Promise.resolve();
    return navigator.wakeLock.request('screen').then(function (sentinel) {
      if (phase !== 'recording' && phase !== 'starting') {
        sentinel.release().catch(function () {});
        return;
      }
      wakeSentinel = sentinel;
    }).catch(function () {
      wakeSentinel = null;
    });
  }

  function releaseWake() {
    var sentinel = wakeSentinel;
    wakeSentinel = null;
    if (!sentinel) return Promise.resolve();
    return sentinel.release().catch(function () {});
  }

  function stopRecorder() {
    var rec = recorder;
    var stream = activeStream;
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
        if (stream) {
          stream.getTracks().forEach(function (t) { try { t.stop(); } catch (err) {} });
        }
        if (activeStream === stream) activeStream = null;
        if (recorder === rec) recorder = null;
        resolve();
      };
      if (!rec || rec.state === 'inactive') {
        finish();
        return;
      }
      var killer = window.setTimeout(finish, 4000);
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

  function persistTake() {
    var transcript = spokenText().trim();
    var audio = null;
    if (!textOnly && chunks.length) {
      var type = mimeType || 'application/octet-stream';
      audio = new Blob(chunks, { type: type });
      if (!audio.size) audio = null;
    }
    chunks = [];
    if (!transcript && !audio) {
      bannerReason = 'empty';
      setBanner('info', 'Nothing was captured. Tap and try again.');
      return Promise.resolve();
    }
    var session = {
      id: uid(),
      createdAt: Date.now(),
      durationMs: startedAt ? Math.max(0, (stoppedAt || Date.now()) - startedAt) : 0,
      transcript: transcript,
      mimeType: audio ? audio.type : '',
      audio: audio,
      notice: textOnly ? 'text-only' : (fatalSpeech && !transcript ? 'audio-only' : '')
    };
    return putSession(session).then(function () {
      resetSpeechText();
      return allSessions();
    }).then(function (rows) {
      sessions = rows || [];
      renderSessions();
    });
  }

  function finishStop() {
    wantSpeech = false;
    window.clearTimeout(restartTimer);
    window.clearTimeout(muteTimer);
    haltRecognizer();
    var waking = releaseWake();
    return stopRecorder().then(function () {
      return waking;
    }).then(function () {
      return persistTake();
    }).catch(function (err) {
      var quota = err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
      setBanner('danger', quota
        ? 'This phone is out of room for saved recordings. Delete an older one and try again. Your text is still on screen.'
        : 'Couldn’t save this take on the device. Your text is still on screen.');
    }).then(function () {
      if (bannerReason !== 'empty' && bannerEl.dataset.tone !== 'danger') setBanner(null);
      phase = 'idle';
      startedAt = 0;
      stoppedAt = 0;
      textOnly = false;
      renderChrome();
      renderLive();
    });
  }

  function requestStop() {
    if (phase === 'idle') return Promise.resolve();
    if (phase === 'stopping') return stopPromise || Promise.resolve();
    runId += 1;
    phase = 'stopping';
    stoppedAt = Date.now();
    renderChrome();
    renderLive();
    stopPromise = finishStop().finally(function () { stopPromise = null; });
    return stopPromise;
  }

  function canRecord() {
    return window.isSecureContext
      && navigator.mediaDevices
      && typeof navigator.mediaDevices.getUserMedia === 'function'
      && typeof MediaRecorder !== 'undefined';
  }

  function start() {
    if (!canRecord()) {
      setBanner('danger', 'Recording needs a secure page (HTTPS) and a browser that can use the microphone.');
      return;
    }
    runId += 1;
    var my = runId;
    phase = 'starting';
    startedAt = Date.now();
    stoppedAt = 0;
    recoveryTried = false;
    textOnly = false;
    fatalSpeech = false;
    retriedLang = false;
    forceLang = '';
    bannerReason = '';
    mimeType = '';
    chunks = [];
    resetSpeechText();
    setBanner(null);
    document.querySelectorAll('audio').forEach(function (audio) {
      try { audio.pause(); } catch (err) {}
    });
    renderChrome();
    renderLive();
    // Speech start() has to run inside this tap. iOS drops the gesture if it waits on getUserMedia.
    beginSpeech(my);
    beginAudio(my).catch(function (err) {
      if (my !== runId) return;
      haltRecognizer();
      phase = 'idle';
      startedAt = 0;
      explainMic(err);
      renderChrome();
      renderLive();
    });
  }

  tapBtn.addEventListener('click', function () {
    if (phase === 'stopping') return;
    if (phase === 'recording' || phase === 'starting') {
      requestStop();
      return;
    }
    start();
  });

  listEl.addEventListener('click', function (event) {
    var btn = event.target.closest('button');
    if (!btn || !listEl.contains(btn)) return;
    var card = btn.closest('[data-id]');
    if (!card) return;
    var session = null;
    var i;
    for (i = 0; i < sessions.length; i += 1) {
      if (sessions[i].id === card.dataset.id) session = sessions[i];
    }
    if (!session && btn.dataset.action !== 'delete') return;
    var action = btn.dataset.action;
    if (action === 'copy') onCopy(session, btn);
    else if (action === 'share') onShare(session, btn);
    else if (action === 'delete') onDelete(card.dataset.id, btn);
    else if (action === 'more') {
      card.classList.toggle('is-open');
      var open = card.classList.contains('is-open');
      btn.textContent = open ? 'Less' : 'More';
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && phase === 'recording') acquireWake();
  });

  window.addEventListener('pageshow', function (event) {
    if (event.persisted && (phase === 'recording' || phase === 'starting')) requestStop();
  });

  window.setInterval(function () {
    if ((phase === 'recording' || phase === 'starting') && startedAt) {
      timerEl.textContent = formatDuration(Date.now() - startedAt);
    }
  }, 200);

  function maybeHint() {
    var dismissed = false;
    try { dismissed = localStorage.getItem('tap-transcribe-hint') === 'off'; } catch (err) { dismissed = false; }
    if (!isIOS() || isStandalone() || dismissed) {
      hintEl.hidden = true;
      return;
    }
    hintEl.hidden = false;
    document.getElementById('hint-dismiss').addEventListener('click', function () {
      hintEl.hidden = true;
      try { localStorage.setItem('tap-transcribe-hint', 'off'); } catch (err) {}
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {});
  }

  renderChrome();
  renderLive();
  maybeHint();
  loadSessions();

  if (!canRecord()) {
    setBanner('danger', 'Recording needs a secure page (HTTPS) and a browser that can use the microphone.');
  }
})();

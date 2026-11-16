import { test, expect } from '@playwright/test';

const PAGE = 'http://localhost:8765/tap-transcribe/';

async function arm(page, mode) {
  await page.addInitScript((mode) => {
    window.__speechMode = mode;
    window.__gum = 0;
    window.__speech = { starts: 0 };
    window.__xss = 0;
    window.__wakes = 0;
    if (mode === 'minutes') {
      var wakeMock = {
        request: function () {
          window.__wakes += 1;
          var listeners = [];
          var sentinel = {
            release: function () { return Promise.resolve(); },
            addEventListener: function (type, fn) { if (type === 'release') listeners.push(fn); }
          };
          if (window.__wakes === 1) {
            window.setTimeout(function () {
              listeners.forEach(function (fn) { fn(); });
            }, 30000);
          }
          return Promise.resolve(sentinel);
        }
      };
      try {
        Object.defineProperty(Navigator.prototype, 'wakeLock', {
          configurable: true,
          get: function () { return wakeMock; }
        });
      } catch (err) {
        window.__wakeMockFailed = String(err);
      }
    }
    var devices = navigator.mediaDevices;
    var real = devices && devices.getUserMedia ? devices.getUserMedia.bind(devices) : null;
    if (devices) {
      devices.getUserMedia = function () {
        window.__gum += 1;
        if (real) return real.apply(devices, arguments);
        return Promise.reject(new DOMException('denied', 'NotAllowedError'));
      };
    }

    function deliver(self, lines) {
      if (typeof self.onresult !== 'function') return;
      var results = { length: lines.length };
      var i;
      for (i = 0; i < lines.length; i += 1) {
        results[i] = { isFinal: true, 0: { transcript: lines[i] }, length: 1 };
      }
      self.onresult({ resultIndex: lines.length - 1, results: results });
    }

    function Fake() {
      this.continuous = true;
      this.interimResults = true;
      this.lang = 'en-US';
      this.maxAlternatives = 1;
    }

    Fake.prototype.start = function () {
      window.__speech.starts += 1;
      var n = window.__speech.starts;
      var self = this;
      var modeNow = window.__speechMode;
      if (modeNow === 'minutes') {
        window.setTimeout(function () {
          if (typeof self.onstart === 'function') self.onstart();
          var slot = n % 5;
          if (slot === 0) {
            deliver(self, ['word ' + n]);
            if (self.onend) self.onend();
          } else if (slot === 1 && n > 1) {
            deliver(self, ['word ' + (n - 1)]);
            if (self.onend) self.onend();
          } else if (slot === 2) {
            if (self.onerror) self.onerror({ error: 'aborted' });
            if (self.onend) self.onend();
          } else {
            if (self.onerror) self.onerror({ error: 'no-speech' });
            if (self.onend) self.onend();
          }
        }, 5000);
        return;
      }
      window.setTimeout(function () {
        if (typeof self.onstart === 'function') self.onstart();
        if (modeNow === 'hold') return;
        if (modeNow === 'silent') {
          if (self.onerror) self.onerror({ error: 'no-speech' });
          if (self.onend) self.onend();
          return;
        }
        if (modeNow === 'blocked') {
          if (self.onerror) self.onerror({ error: 'service-not-allowed' });
          if (self.onend) self.onend();
          return;
        }
        if (modeNow === 'conflict') {
          if (n === 1) {
            if (self.onerror) self.onerror({ error: 'audio-capture' });
            if (self.onend) self.onend();
          } else {
            deliver(self, ['heard you']);
          }
          return;
        }
        if (modeNow === 'restart') {
          if (n === 1) {
            deliver(self, ['alpha phrase']);
            if (self.onend) self.onend();
          } else {
            deliver(self, ['beta phrase']);
          }
          return;
        }
        if (modeNow === 'chain') {
          deliver(self, ['word' + n]);
          if (n < 4 && self.onend) self.onend();
          return;
        }
        if (modeNow === 'long') {
          var lines = [];
          var i = 0;
          var tick = function () {
            i += 1;
            lines.push('line ' + i);
            deliver(self, lines.slice());
            if (i < 8) window.setTimeout(tick, 30);
          };
          tick();
          return;
        }
        if (modeNow === 'xss') {
          deliver(self, ['<img src=x onerror="window.__xss=1">']);
          return;
        }
        if (self.onresult) {
          self.onresult({
            resultIndex: 0,
            results: { length: 1, 0: { isFinal: false, 0: { transcript: 'phrase ' + n }, length: 1 } }
          });
        }
        window.setTimeout(function () {
          deliver(self, ['phrase ' + n]);
        }, 20);
      }, 15);
    };
    Fake.prototype.stop = function () {};
    Fake.prototype.abort = function () {};
    window.SpeechRecognition = Fake;
    window.webkitSpeechRecognition = Fake;
  }, mode);
}

function watchErrors(page) {
  var errors = [];
  page.on('pageerror', function (err) { errors.push(String(err)); });
  page.on('console', function (msg) {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

async function enterPin(page, pin) {
  var i;
  for (i = 0; i < pin.length; i += 1) {
    await page.locator('#pad button[data-digit="' + pin[i] + '"]').click();
  }
}

async function unlockFresh(page) {
  await expect(page.getByRole('heading', { name: 'Choose a PIN' })).toBeVisible();
  await enterPin(page, '142536');
  await expect(page.getByRole('heading', { name: 'Confirm the PIN' })).toBeVisible();
  await enterPin(page, '000000');
  await expect(page.locator('#lock-error')).toHaveText('Those PINs don’t match. Start again.');
  await enterPin(page, '142536');
  await enterPin(page, '142536');
  await expect(page.getByRole('heading', { name: 'Add Face ID' })).toBeVisible();
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('#tap')).toBeVisible();
}

async function rawSessions(page) {
  return page.evaluate(async function () {
    var db = await new Promise(function (resolve, reject) {
      var req = indexedDB.open('tap-transcribe');
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    var tx = db.transaction('sessions', 'readonly');
    var rows = await new Promise(function (resolve, reject) {
      var req = tx.objectStore('sessions').getAll();
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return JSON.stringify(rows);
  });
}

test('pins the phone, transcribes without taking the mic, and saves', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'words');
  await page.goto(PAGE);
  await unlockFresh(page);
  await expect(page.locator('#audio-toggle')).toContainText('Audio off');
  var i;
  for (i = 1; i <= 5; i += 1) {
    await page.locator('#tap').click();
    await expect(page.locator('#status-text')).toHaveText('Listening');
    await expect(page.locator('#live-final')).toHaveText('phrase ' + i);
    await expect(page.locator('#save-state')).toHaveText('Saved on this phone');
    await page.locator('#tap').click();
    await expect(page.locator('#status-text')).toHaveText('Ready');
    await expect(page.locator('.session')).toHaveCount(i);
  }
  expect(await page.evaluate(function () { return window.__gum; })).toBe(0);
  var dump = await rawSessions(page);
  expect(dump).not.toContain('phrase');
  expect(dump).not.toContain('"transcript"');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(function () {});
  await page.locator('.session').first().locator('.row').click();
  await page.getByRole('button', { name: 'Copy' }).first().click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  var before = await page.locator('.session').count();
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('.session')).toHaveCount(before - 1);
  expect(errors).toEqual([]);
});

test('keeps text when recognition ends and starts again', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'restart');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#live-final')).toContainText('alpha phrase');
  await expect(page.locator('#live-final')).toContainText('beta phrase');
  expect(await page.evaluate(function () { return window.__speech.starts; })).toBeGreaterThan(1);
  await page.locator('#tap').click();
  await expect(page.locator('.preview').first()).toContainText('alpha phrase');
  await expect(page.locator('.preview').first()).toContainText('beta phrase');
  expect(errors).toEqual([]);
});

test('a chain of short recognizer sessions stays one take', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'chain');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#live-final')).toContainText('word4');
  await page.locator('#tap').click();
  await expect(page.locator('.session')).toHaveCount(1);
  await expect(page.locator('.preview')).toContainText('word1');
  await expect(page.locator('.preview')).toContainText('word4');
  expect(errors).toEqual([]);
});

test('a longer take keeps every line', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'long');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#live-final')).toContainText('line 8');
  await expect(page.locator('#timer')).not.toHaveText('00:00');
  await page.locator('#tap').click();
  await expect(page.locator('.preview')).toContainText('line 1');
  await expect(page.locator('.preview')).toContainText('line 8');
  expect(errors).toEqual([]);
});

test('silence restarts recognition and the screen stays on Listening', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'silent');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#status-text')).toHaveText('Listening');
  await expect.poll(function () {
    return page.evaluate(function () { return window.__speech.starts; });
  }).toBeGreaterThan(1);
  await expect(page.locator('#status-text')).toHaveText('Listening');
  await page.locator('#tap').click();
  await expect(page.locator('.preview')).toContainText('Nothing was captured');
  expect(errors).toEqual([]);
});

test('keeps listening through minutes of silence and keeps the words', async ({ page }) => {
  var errors = watchErrors(page);
  await page.clock.install();
  await arm(page, 'minutes');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#status-text')).toHaveText('Listening');
  await page.evaluate(function () {
    window.__labels = [];
    window.__hears = [];
    var status = document.getElementById('status-text');
    window.__labels.push(status.textContent);
    new MutationObserver(function () {
      window.__labels.push(status.textContent);
    }).observe(status, { childList: true, characterData: true, subtree: true });
    window.__hears.push(document.body.dataset.hear);
    new MutationObserver(function () {
      window.__hears.push(document.body.dataset.hear);
    }).observe(document.body, { attributes: true, attributeFilter: ['data-hear'] });
  });
  await page.clock.runFor(180000);
  var info = await page.evaluate(function () {
    return {
      starts: window.__speech.starts,
      labels: window.__labels,
      hears: window.__hears,
      text: document.getElementById('live-final').textContent,
      wakes: window.__wakes,
      timer: document.getElementById('timer').textContent,
      pressed: document.getElementById('tap').getAttribute('aria-pressed')
    };
  });
  expect(info.pressed).toBe('true');
  expect(info.starts).toBeGreaterThan(25);
  expect(info.labels.every(function (label) { return label === 'Listening'; })).toBe(true);
  expect(info.hears.indexOf('silent')).toBe(-1);
  expect(info.text).toContain('word 5');
  expect(info.text).toContain('word 30');
  expect((info.text.match(/word 5/g) || []).length).toBe(1);
  expect(info.wakes).toBeGreaterThan(1);
  expect(info.timer).not.toBe('00:00');
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeHidden();
  await page.clock.resume();
  await expect(page.locator('#save-state')).toHaveText('Saved on this phone');
  await page.locator('#tap').click();
  await expect(page.locator('.session')).toHaveCount(1);
  await expect(page.locator('.preview')).toContainText('word 5');
  await expect(page.locator('.preview')).toContainText('word 30');
  expect((await page.locator('.preview').innerText()).match(/word 5/g).length).toBe(1);
  expect(errors).toEqual([]);
});

test('still saves when speech is blocked', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'blocked');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#banner')).toContainText('isn’t available');
  await page.locator('#tap').click();
  await expect(page.locator('.session')).toHaveCount(1);
  await expect(page.locator('.preview')).toContainText('wasn’t available');
  expect(errors).toEqual([]);
});

test('home screen explains that transcription needs Safari', async ({ page }) => {
  var errors = watchErrors(page);
  await page.addInitScript(function () {
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: function () { return true; } });
  });
  await arm(page, 'blocked');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#banner')).toContainText('Home Screen');
  await expect(page.locator('#banner a')).toHaveText('Open in Safari');
  expect(errors).toEqual([]);
});

test('reloads mid-take onto the lock, then shows the saved words', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'words');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#live-final')).toHaveText('phrase 1');
  await expect(page.locator('#save-state')).toHaveText('Saved on this phone');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await enterPin(page, '142536');
  await expect(page.locator('#tap')).toBeVisible();
  await expect(page.locator('.preview')).toContainText('phrase 1');
  var dump = await rawSessions(page);
  expect(dump).not.toContain('phrase');
  expect(errors).toEqual([]);
});

test('locks when the page is hidden during a take', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'words');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#live-final')).toHaveText('phrase 1');
  await page.evaluate(function () {
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: function () { return 'hidden'; }
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await page.evaluate(function () {
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get: function () { return 'visible'; }
    });
  });
  await enterPin(page, '142536');
  await expect(page.locator('.preview')).toContainText('phrase 1');
  expect(errors).toEqual([]);
});

test('encrypts a leftover plaintext session from the previous version', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'words');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.evaluate(async function () {
    var db = await new Promise(function (resolve, reject) {
      var req = indexedDB.open('tap-transcribe', 2);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    await new Promise(function (resolve, reject) {
      var tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({
        id: 'legacy-1',
        createdAt: Date.now() - 5000,
        durationMs: 1200,
        transcript: 'legacy words',
        mimeType: '',
        audio: null,
        notice: ''
      });
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
  await page.reload();
  await enterPin(page, '142536');
  await expect(page.locator('.preview')).toContainText('legacy words');
  var dump = await rawSessions(page);
  expect(dump).not.toContain('legacy words');
  expect(dump).toContain('payloadCipher');
  expect(errors).toEqual([]);
});

test('rejects a wrong PIN and locks from the button', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'hold');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#lock-now').click();
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  await expect(page.locator('#tap')).toBeHidden();
  await enterPin(page, '000000');
  await expect(page.locator('#lock-error')).toHaveText('Wrong PIN.');
  await enterPin(page, '142536');
  await expect(page.locator('#tap')).toBeVisible();
  expect(errors).toEqual([]);
});

test('locks after a minute with nothing touched', async ({ page }) => {
  test.skip(test.info().project.name !== 'iphone', 'clock is exercised once');
  var errors = watchErrors(page);
  await page.clock.install();
  await arm(page, 'hold');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.clock.fastForward(65000);
  await expect(page.getByRole('heading', { name: 'Locked' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('renders transcript text instead of HTML', async ({ page }) => {
  var errors = watchErrors(page);
  await arm(page, 'xss');
  await page.goto(PAGE);
  await unlockFresh(page);
  await page.locator('#tap').click();
  await expect(page.locator('#live-final')).toContainText('<img');
  expect(await page.evaluate(function () { return window.__xss; })).toBe(0);
  await page.locator('#tap').click();
  await expect(page.locator('.preview')).toContainText('<img');
  expect(await page.locator('.preview img').count()).toBe(0);
  expect(errors).toEqual([]);
});

test('drops a recorder that throws and still saves the words', async ({ page, browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'fake microphone is Chromium-only');
  var context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1100, height: 800 }
  });
  var desktop = await context.newPage();
  var errors = watchErrors(desktop);
  await arm(desktop, 'words');
  await desktop.addInitScript(function () {
    function Boom() { throw new Error('recorder unavailable'); }
    Boom.isTypeSupported = function () { return false; };
    window.MediaRecorder = Boom;
  });
  await desktop.goto(PAGE);
  await unlockFresh(desktop);
  await expect(desktop.locator('#audio-toggle')).toHaveText('Saving audio');
  await desktop.locator('#tap').click();
  await expect(desktop.locator('#live-final')).toHaveText('phrase 1');
  await expect(desktop.locator('#banner')).toContainText('words will still be saved');
  await desktop.locator('#tap').click();
  await expect(desktop.locator('.preview')).toContainText('phrase 1');
  expect(errors).toEqual([]);
  await context.close();
});

test('turns audio off when recognition says the microphone is busy', async ({ page, browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'fake microphone is Chromium-only');
  var context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1100, height: 800 }
  });
  var desktop = await context.newPage();
  var errors = watchErrors(desktop);
  await arm(desktop, 'conflict');
  await desktop.goto(PAGE);
  await unlockFresh(desktop);
  await desktop.locator('#tap').click();
  await expect(desktop.locator('#banner')).toContainText('Audio is off');
  await expect(desktop.locator('#live-final')).toContainText('heard you');
  expect(await desktop.evaluate(function () { return window.__gum; })).toBeGreaterThan(0);
  await desktop.locator('#tap').click();
  await expect(desktop.locator('.preview')).toContainText('heard you');
  expect(await desktop.evaluate(function () { return localStorage.getItem('tap-transcribe-audio'); })).toBe('off');
  expect(errors).toEqual([]);
  await context.close();
});

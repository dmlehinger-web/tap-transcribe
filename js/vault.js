/* IndexedDB plus the key that locks it.

   Notes and audio are AES-GCM ciphertext. The raw key lives only in
   memory after a PIN or a passkey PRF unwrap. Nothing in the repo is
   a secret. A short PIN stops someone who picks up an unlocked phone;
   it is not a strong offline password if the database is copied off
   the device. Face ID is stronger when this browser can return a PRF
   secret from the platform authenticator. */

var DB_NAME = 'tap-transcribe';
var DB_VERSION = 2;
var PIN_ITERATIONS = 200000;

var dbPromise = null;
var currentKey = null;
var writeQueue = Promise.resolve();
var activeId = '';

function bytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return null;
}

function wipe(view) {
  if (view && view.fill) view.fill(0);
}

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
  dbPromise.catch(function () { dbPromise = null; });
  return dbPromise;
}

function requestToPromise(req) {
  return new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function txDone(tx) {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
    tx.onabort = function () { reject(tx.error || new Error('aborted')); };
  });
}

async function metaGet() {
  var db = await openDb();
  var tx = db.transaction('meta', 'readonly');
  var result = await requestToPromise(tx.objectStore('meta').get('lock'));
  await txDone(tx);
  return result || null;
}

async function metaPut(record) {
  var db = await openDb();
  var tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(record);
  await txDone(tx);
}

function enqueue(fn) {
  var run = writeQueue.then(fn, fn);
  writeQueue = run.then(function () {}, function () {});
  return run;
}

export function whenIdle() {
  return writeQueue;
}

export function setActiveId(id) {
  activeId = id || '';
}

export function getKey() {
  return currentKey;
}

export function isUnlocked() {
  return !!currentKey;
}

export function clearKey() {
  currentKey = null;
}

async function derivePinKey(pin, salt, iterations) {
  var base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(pin)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bytes(salt), iterations: iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function adoptRaw(raw) {
  var copy = bytes(raw);
  currentKey = await crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  wipe(copy);
  return currentKey;
}

async function wrapRaw(raw, key) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, raw));
  return { iv: iv, cipher: cipher };
}

export async function loadMeta() {
  return metaGet();
}

export async function platformAvailable() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (err) {
    return false;
  }
}

export async function setupPin(pin) {
  var raw = crypto.getRandomValues(new Uint8Array(32));
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var wrapping = await derivePinKey(pin, salt, PIN_ITERATIONS);
  var wrapped = await wrapRaw(raw, wrapping);
  await metaPut({
    id: 'lock',
    iterations: PIN_ITERATIONS,
    pinSalt: salt,
    pinIv: wrapped.iv,
    pinWrapped: wrapped.cipher,
    credId: null,
    prfSalt: null,
    prfIv: null,
    prfWrapped: null
  });
  await adoptRaw(raw);
  wipe(raw);
}

export async function unlockPin(pin) {
  var meta = await metaGet();
  if (!meta || !meta.pinWrapped) return false;
  try {
    var wrapping = await derivePinKey(pin, meta.pinSalt, meta.iterations || PIN_ITERATIONS);
    var raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(meta.pinIv) },
      wrapping,
      bytes(meta.pinWrapped)
    ));
    await adoptRaw(raw);
    wipe(raw);
    return true;
  } catch (err) {
    currentKey = null;
    return false;
  }
}

export async function rewrapPin(pin) {
  if (!currentKey) throw new Error('locked');
  var meta = await metaGet();
  var raw = new Uint8Array(await crypto.subtle.exportKey('raw', currentKey));
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var wrapping = await derivePinKey(pin, salt, PIN_ITERATIONS);
  var wrapped = await wrapRaw(raw, wrapping);
  wipe(raw);
  meta.pinSalt = salt;
  meta.pinIv = wrapped.iv;
  meta.pinWrapped = wrapped.cipher;
  meta.iterations = PIN_ITERATIONS;
  await metaPut(meta);
}

function randomId() {
  return crypto.getRandomValues(new Uint8Array(16));
}

function prfSecret(assertion) {
  var ext = assertion.getClientExtensionResults && assertion.getClientExtensionResults();
  var first = ext && ext.prf && ext.prf.results && ext.prf.results.first;
  return first ? new Uint8Array(first) : null;
}

async function importPrf(secret) {
  return crypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function enrollPasskey() {
  if (!currentKey || !navigator.credentials || !navigator.credentials.create) {
    return { prf: false, error: 'Passkeys aren’t available in this browser.' };
  }
  var meta = await metaGet();
  var challenge = crypto.getRandomValues(new Uint8Array(32));
  var cred;
  try {
    cred = await navigator.credentials.create({
      publicKey: {
        challenge: challenge,
        rp: { name: 'Tap Transcribe', id: location.hostname },
        user: {
          id: randomId(),
          name: 'owner',
          displayName: 'Owner'
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        timeout: 60000,
        attestation: 'none',
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required'
        },
        extensions: { prf: {} }
      }
    });
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return { prf: false, error: 'Face ID was cancelled.' };
    return { prf: false, error: 'Face ID couldn’t be set up on this phone. The PIN still locks notes.' };
  }
  if (!cred) return { prf: false, error: 'Face ID didn’t return a passkey.' };
  var ext = cred.getClientExtensionResults && cred.getClientExtensionResults();
  var enabled = !!(ext && ext.prf && ext.prf.enabled);
  var credId = new Uint8Array(cred.rawId);
  meta.credId = credId;
  if (!enabled) {
    meta.prfSalt = null;
    meta.prfIv = null;
    meta.prfWrapped = null;
    await metaPut(meta);
    return { prf: false, error: 'This phone’s passkey can’t hold the encryption key. The PIN still locks notes.' };
  }
  var salt = crypto.getRandomValues(new Uint8Array(32));
  var secret = null;
  try {
    secret = await evalPrf(credId, salt);
  } catch (err) {
    secret = null;
  }
  if (!secret) {
    meta.prfSalt = null;
    meta.prfIv = null;
    meta.prfWrapped = null;
    await metaPut(meta);
    return { prf: false, error: 'Face ID ran, but it didn’t return a key. The PIN still locks notes.' };
  }
  var raw = new Uint8Array(await crypto.subtle.exportKey('raw', currentKey));
  var wrapping = await importPrf(secret);
  var wrapped = await wrapRaw(raw, wrapping);
  wipe(raw);
  wipe(secret);
  meta.prfSalt = salt;
  meta.prfIv = wrapped.iv;
  meta.prfWrapped = wrapped.cipher;
  await metaPut(meta);
  return { prf: true };
}

async function evalPrf(credId, salt) {
  var assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      timeout: 60000,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: bytes(credId) }],
      extensions: { prf: { eval: { first: bytes(salt) } } }
    }
  });
  return prfSecret(assertion);
}

export async function unlockPasskey() {
  var meta = await metaGet();
  if (!meta || !meta.credId || !meta.prfWrapped || !meta.prfSalt) return { ok: false };
  try {
    var secret = await evalPrf(meta.credId, meta.prfSalt);
    if (!secret) return { ok: false };
    var wrapping = await importPrf(secret);
    var raw = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(meta.prfIv) },
      wrapping,
      bytes(meta.prfWrapped)
    ));
    wipe(secret);
    await adoptRaw(raw);
    wipe(raw);
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'NotAllowedError') return { ok: false, cancelled: true };
    currentKey = null;
    return { ok: false };
  }
}

export async function encryptJson(key, value) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var plain = new TextEncoder().encode(JSON.stringify(value));
  var cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plain));
  return { iv: iv, cipher: cipher };
}

export async function decryptJson(key, iv, cipher) {
  var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv) }, key, bytes(cipher));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function encryptBuffer(key, buffer) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, buffer));
  return { iv: iv, cipher: cipher };
}

async function getAllRaw() {
  var db = await openDb();
  var tx = db.transaction('sessions', 'readonly');
  var rows = await requestToPromise(tx.objectStore('sessions').getAll());
  await txDone(tx);
  return rows || [];
}

async function putRow(row) {
  var db = await openDb();
  var tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(row);
  await txDone(tx);
}

async function getRow(id) {
  var db = await openDb();
  var tx = db.transaction('sessions', 'readonly');
  var row = await requestToPromise(tx.objectStore('sessions').get(id));
  await txDone(tx);
  return row || null;
}

function isLegacy(row) {
  return !!(row && typeof row.transcript === 'string' && !row.payloadCipher);
}

export function migrateLegacy() {
  return enqueue(async function () {
    var key = currentKey;
    if (!key) return;
    var rows = await getAllRaw();
    var i;
    for (i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!isLegacy(row)) continue;
      var audioEnc = null;
      if (row.audio && typeof row.audio.arrayBuffer === 'function' && row.audio.size) {
        audioEnc = await encryptBuffer(key, await row.audio.arrayBuffer());
      }
      var payload = await encryptJson(key, {
        transcript: row.transcript || '',
        notice: row.notice || '',
        mimeType: row.mimeType || '',
        durationMs: row.durationMs || 0
      });
      await putRow({
        id: row.id,
        status: 'saved',
        createdAt: row.createdAt || Date.now(),
        payloadIv: payload.iv,
        payloadCipher: payload.cipher,
        audioIv: audioEnc ? audioEnc.iv : null,
        audioCipher: audioEnc ? audioEnc.cipher : null
      });
    }
  });
}

export function saveTranscript(fields) {
  return enqueue(async function () {
    var key = currentKey;
    if (!key) throw new Error('locked');
    var existing = await getRow(fields.id);
    var payload = await encryptJson(key, {
      transcript: fields.transcript || '',
      notice: fields.notice || '',
      mimeType: fields.mimeType || (existing && existing.mimeHint) || '',
      durationMs: fields.durationMs || 0
    });
    await putRow({
      id: fields.id,
      status: fields.status || 'draft',
      createdAt: fields.createdAt || (existing && existing.createdAt) || Date.now(),
      payloadIv: payload.iv,
      payloadCipher: payload.cipher,
      audioIv: existing ? existing.audioIv : null,
      audioCipher: existing ? existing.audioCipher : null,
      mimeHint: fields.mimeType || (existing && existing.mimeHint) || ''
    });
  });
}

export function saveAudio(id, blob, mimeType) {
  return enqueue(async function () {
    var key = currentKey;
    if (!key) throw new Error('locked');
    var existing = await getRow(id);
    if (!existing) return;
    var enc = await encryptBuffer(key, await blob.arrayBuffer());
    existing.audioIv = enc.iv;
    existing.audioCipher = enc.cipher;
    existing.mimeHint = mimeType || existing.mimeHint || '';
    await putRow(existing);
  });
}

export function markSaved(id) {
  return enqueue(async function () {
    var existing = await getRow(id);
    if (!existing || existing.status === 'saved') return;
    existing.status = 'saved';
    await putRow(existing);
  });
}

async function decryptRow(row) {
  var key = currentKey;
  if (!key || !row || !row.payloadCipher) return null;
  var payload = await decryptJson(key, row.payloadIv, row.payloadCipher);
  var audio = null;
  if (row.audioCipher) {
    var raw = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(row.audioIv) },
      key,
      bytes(row.audioCipher)
    );
    audio = new Blob([raw], { type: payload.mimeType || row.mimeHint || 'application/octet-stream' });
  }
  return {
    id: row.id,
    status: row.status || 'saved',
    createdAt: row.createdAt,
    transcript: payload.transcript || '',
    notice: payload.notice || '',
    mimeType: payload.mimeType || row.mimeHint || '',
    durationMs: payload.durationMs || 0,
    audio: audio
  };
}

export function listSessions() {
  return enqueue(async function () {
    var rows = await getAllRaw();
    var out = [];
    var i;
    for (i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (isLegacy(row)) continue;
      if (row.status === 'draft' && row.id !== activeId) {
        row.status = 'saved';
        await putRow(row);
      }
      try {
        var item = await decryptRow(row);
        if (item) out.push(item);
      } catch (err) {
        /* skip a record we can't decrypt */
      }
    }
    out.sort(function (a, b) { return b.createdAt - a.createdAt; });
    return out;
  });
}

export function deleteSession(id) {
  return enqueue(async function () {
    var db = await openDb();
    var tx = db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').delete(id);
    await txDone(tx);
  });
}

export function hasPasskey() {
  return metaGet().then(function (meta) {
    return !!(meta && meta.prfWrapped && meta.credId);
  });
}

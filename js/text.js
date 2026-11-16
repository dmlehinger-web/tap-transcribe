/* Plain text helpers. No DOM, so node can test them. */

export function joinText(a, b) {
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

export function appendPiece(buf, piece) {
  if (!piece) return buf || '';
  if (!buf) return piece;
  if (/\s$/.test(buf) || /^\s/.test(piece)) return buf + piece;
  return buf + ' ' + piece;
}

export function formatDuration(ms) {
  var total = Math.max(0, Math.floor(Number(ms) || 0));
  total = Math.floor(total / 1000);
  var h = Math.floor(total / 3600);
  var m = Math.floor((total % 3600) / 60);
  var s = total % 60;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  if (h > 0) return h + ':' + pad(m) + ':' + pad(s);
  return pad(m) + ':' + pad(s);
}

export function formatWhen(ts) {
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

export function preview(text, max) {
  var clean = String(text || '').replace(/\s+/g, ' ').trim();
  var limit = max || 88;
  if (clean.length <= limit) return clean;
  return clean.slice(0, limit - 1).trim() + '…';
}

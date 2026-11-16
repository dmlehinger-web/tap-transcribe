import test from 'node:test';
import assert from 'node:assert/strict';
import { appendPiece, formatDuration, joinText } from '../js/text.js';

test('joins two phrases with a space', () => {
  assert.equal(joinText('hello', 'there'), 'hello there');
});

test('drops a suffix the recognizer repeated', () => {
  assert.equal(joinText('alpha phrase', 'phrase'), 'alpha phrase');
});

test('merges an overlap of at least 8 characters', () => {
  assert.equal(joinText('hello there friend', 'there friend again'), 'hello there friend again');
});

test('does not merge a short overlap', () => {
  assert.equal(joinText('the quick brown', 'brown fox'), 'the quick brown brown fox');
});

test('keeps an empty side', () => {
  assert.equal(joinText('', 'hi'), 'hi');
  assert.equal(joinText('hi', ''), 'hi');
  assert.equal(joinText('  hi   there ', 'there'), 'hi there');
});

test('spaces pieces that need it', () => {
  assert.equal(appendPiece('hello', 'there'), 'hello there');
  assert.equal(appendPiece('hello ', 'there'), 'hello there');
  assert.equal(appendPiece('', 'there'), 'there');
});

test('formats a duration', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(61000), '01:01');
  assert.equal(formatDuration(3661000), '1:01:01');
});

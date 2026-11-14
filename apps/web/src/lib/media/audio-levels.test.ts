import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelFromSamples } from './audio-analysis.js';
import { TEST_TONE, toneLength } from './speaker-test.js';

test('level meter: silence is 0, loud is 1, speech sits in between', () => {
  assert.equal(levelFromSamples(new Float32Array(512)), 0);
  assert.equal(levelFromSamples([]), 0);
  assert.equal(levelFromSamples(new Float32Array(512).fill(1)), 1);
  // A sine wave at amplitude 0.05 has an RMS of about -29 dBFS.
  const speech = Float32Array.from({ length: 1024 }, (_, i) => 0.05 * Math.sin(i / 5));
  const level = levelFromSamples(speech);
  assert.ok(level > 0.5 && level < 0.75, `level ${level}`);
  // Below -60 dBFS reads as silence.
  assert.equal(levelFromSamples(new Float32Array(512).fill(0.0005)), 0);
  assert.equal(levelFromSamples([NaN, NaN]), 0);
});

test('test tone is short and its notes do not overlap', () => {
  assert.ok(toneLength() > 0.5 && toneLength() < 1.5);
  for (let i = 1; i < TEST_TONE.length; i++) {
    assert.ok(TEST_TONE[i].start >= TEST_TONE[i - 1].start + TEST_TONE[i - 1].duration);
  }
});

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

test('speaking detection: hysteresis, so it does not flicker between syllables', async () => {
  const { nextSpeaking, SPEAKING_ON_CHECKS, SPEAKING_OFF_CHECKS } = await import('./audio-analysis.js');
  const state = { on: false, above: 0, below: 0 };
  // A single loud check (a click) doesn't count as speaking.
  assert.equal(nextSpeaking(state, true), false);
  assert.equal(nextSpeaking(state, false), false);
  for (let i = 0; i < SPEAKING_ON_CHECKS - 1; i++) nextSpeaking(state, true);
  assert.equal(nextSpeaking(state, true), true);
  // Short pauses between words keep it on.
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < SPEAKING_OFF_CHECKS - 1; i++) assert.equal(nextSpeaking(state, false), true);
    assert.equal(nextSpeaking(state, true), true);
  }
  // A real pause turns it off.
  for (let i = 0; i < SPEAKING_OFF_CHECKS - 1; i++) nextSpeaking(state, false);
  assert.equal(nextSpeaking(state, false), false);
  // Counters stay bounded however long someone talks or stays quiet.
  for (let i = 0; i < 10_000; i++) nextSpeaking(state, false);
  assert.ok(state.below <= SPEAKING_OFF_CHECKS && state.above === 0);
});

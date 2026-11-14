import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMediaError, describeProblem, fallbackText, permissionSteps, insecureContextError } from './media-errors.js';
import { mediaError } from './fake-media.test-helpers.js';

test('browser errors map to what the person can do about them', () => {
  assert.equal(classifyMediaError(mediaError('NotAllowedError')), 'denied');
  assert.equal(classifyMediaError(mediaError('SecurityError')), 'denied');
  assert.equal(classifyMediaError(mediaError('NotFoundError')), 'notfound');
  assert.equal(classifyMediaError(mediaError('OverconstrainedError')), 'notfound');
  assert.equal(classifyMediaError(mediaError('NotReadableError')), 'busy');
  assert.equal(classifyMediaError(insecureContextError()), 'insecure');
  assert.equal(classifyMediaError(new Error('?')), 'other');
  assert.equal(classifyMediaError('nonsense'), 'other');
  assert.equal(classifyMediaError(null), 'other');
});

test('messages name the right devices and the fallback', () => {
  assert.equal(describeProblem({ kind: 'denied', devices: 'both' }).title, 'Your camera and microphone are blocked');
  assert.equal(describeProblem({ kind: 'busy', devices: 'camera' }).title, 'Your camera is busy');
  assert.equal(describeProblem({ kind: 'notfound', devices: 'microphone' }).title, 'No microphone found');
  assert.match(fallbackText({ kind: 'denied', devices: 'camera' }), /heard but not seen/);
  assert.match(fallbackText({ kind: 'denied', devices: 'both' }), /chat only/);
});

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

test('permission steps fit the browser and system', () => {
  const chrome = permissionSteps(UA.chromeMac);
  assert.match(chrome[0], /left of the address bar/);
  assert.match(chrome.at(-1)!, /System Settings/);
  assert.match(permissionSteps(UA.edgeWin).at(-1)!, /Windows/);
  assert.match(permissionSteps(UA.firefoxLinux)[0], /crossed-out camera/);
  assert.equal(permissionSteps(UA.firefoxLinux).length, 2);
  assert.match(permissionSteps(UA.safariMac)[0], /Safari → Settings for This Website/);
  assert.match(permissionSteps(UA.iphone)[0], /aA/);
  assert.match(permissionSteps(UA.android).join(' '), /Android Settings/);
  // An iPad reports itself as a Mac; touch support tells them apart.
  assert.match(permissionSteps(UA.safariMac, true)[0], /aA/);
});

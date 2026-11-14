import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanDeviceId, parseDevicePrefs, loadDevicePrefs, rememberDevice } from './device-prefs.js';

class MemoryStore {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

test('only plausible device ids are accepted', () => {
  assert.equal(cleanDeviceId('default'), 'default');
  assert.equal(cleanDeviceId('a1b2c3/+='), 'a1b2c3/+=');
  assert.equal(cleanDeviceId(''), '');
  assert.equal(cleanDeviceId('has space'), '');
  assert.equal(cleanDeviceId('<script>'.padEnd(300, 'x')), '');
  assert.equal(cleanDeviceId(42), '');
});

test('broken or hostile stored values are ignored', () => {
  assert.deepEqual(parseDevicePrefs(null), { audioInput: '', videoInput: '', audioOutput: '' });
  assert.deepEqual(parseDevicePrefs('not json'), { audioInput: '', videoInput: '', audioOutput: '' });
  assert.deepEqual(parseDevicePrefs('[1,2]').audioInput, '');
  assert.deepEqual(parseDevicePrefs('{"audioInput":"mic","videoInput":{"x":1},"extra":"y"}'), {
    audioInput: 'mic',
    videoInput: '',
    audioOutput: '',
  });
});

test('remember and forget devices', () => {
  const store = new MemoryStore();
  rememberDevice('audioInput', 'mic-1', store);
  rememberDevice('audioOutput', 'spk-2', store);
  assert.deepEqual(loadDevicePrefs(store), { audioInput: 'mic-1', videoInput: '', audioOutput: 'spk-2' });
  assert.deepEqual(Object.keys(JSON.parse(store.getItem('vchat_devices')!)).sort(), ['audioInput', 'audioOutput', 'videoInput']);
  rememberDevice('audioInput', '', store);
  rememberDevice('audioOutput', '', store);
  assert.equal(store.getItem('vchat_devices'), null); // nothing left: the key is removed
  assert.deepEqual(loadDevicePrefs(null), { audioInput: '', videoInput: '', audioOutput: '' });
});

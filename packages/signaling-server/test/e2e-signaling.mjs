// End-to-end signaling smoke test against a running backend.
// Usage: node test/e2e-signaling.mjs http://localhost:8787   (or http://localhost:3001)
import WebSocket from 'ws';

const base = process.argv[2] ?? 'http://localhost:3001';
const origin = new URL(base).origin;
const wsBase = base.replace(/^http/, 'ws');
const room = 'e2e' + Math.random().toString(36).slice(2, 8);

function client(name) {
  const ws = new WebSocket(`${wsBase}/ws?room=${room}`, { headers: { Origin: origin } });
  const inbox = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    inbox.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  const opened = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return {
    name, ws, inbox, opened,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (type, ms = 5000) => {
      const found = inbox.find((m) => m.type === type);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const w = { pred: (m) => m.type === type, resolve: (m) => { inbox.splice(inbox.indexOf(m), 1); resolve(m); } };
        waiters.push(w);
        setTimeout(() => reject(new Error(`${name}: timed out waiting for ${type}`)), ms);
      });
    },
  };
}

const ok = (label) => console.log(`  ✔ ${label}`);

const ice = await fetch(`${base}/api/ice-servers`).then((r) => r.json());
if (!Array.isArray(ice.iceServers) || ice.iceServers.length === 0) throw new Error('no ICE servers');
ok(`GET /api/ice-servers -> ${JSON.stringify(ice.iceServers[0].urls)}`);

const host = client('host');
await host.opened;
host.send({ type: 'ping' });
await host.wait('pong');
ok('ping/pong keepalive');

host.send({ type: 'create-room', roomId: room, peerId: 'hostpeer', displayName: 'Host', secret: 'hs', password: 'pw' });
await host.wait('room-created');
await host.wait('host-changed');
ok('host created room');

const guest = client('guest');
await guest.opened;
guest.send({ type: 'join', roomId: room, peerId: 'guestpeer', displayName: 'Guest', secret: 'gs' });
const pr = await guest.wait('password-required');
if (pr.invalid) throw new Error('expected invalid=false');
guest.send({ type: 'join', roomId: room, peerId: 'guestpeer', displayName: 'Guest', secret: 'gs', password: 'pw' });
await guest.wait('waiting-for-admission');
const req = await host.wait('admission-request');
ok(`password accepted, host got admission request from ${req.displayName}`);

host.send({ type: 'admit-peer', peerId: 'guestpeer' });
await guest.wait('admission-granted');
const peers = await guest.wait('room-peers');
await host.wait('peer-joined');
if (peers.peers[0]?.id !== 'hostpeer') throw new Error('guest did not see host');
ok('guest admitted, both sides notified');

guest.send({ type: 'signal', targetPeerId: 'hostpeer', signal: { sid: 's1', data: { type: 'offer', sdp: 'x' } } });
const sig = await host.wait('signal');
if (sig.fromPeerId !== 'guestpeer' || sig.signal.sid !== 's1') throw new Error('bad signal relay');
ok('signal relayed');

// Simulate a network blip: guest reconnects with the same secret and skips the waiting room.
const guest2 = client('guest2');
await guest2.opened;
guest2.send({ type: 'join', roomId: room, peerId: 'guestpeer', displayName: 'Guest', secret: 'gs' });
await guest2.wait('room-peers');
await host.wait('peer-left');
await host.wait('peer-joined');
ok('reconnect with secret skipped admission and replaced old socket');

guest2.ws.close();
await host.wait('peer-left');
ok('disconnect broadcast peer-left');

host.ws.close();
guest.ws.close();
console.log(`All signaling checks passed against ${base}`);
process.exit(0);

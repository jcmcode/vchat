# vchat: Technical Documentation

1. [How a call works](#how-a-call-works)
2. [Architecture](#architecture)
3. [Signaling protocol](#signaling-protocol)
4. [Reconnection](#reconnection)
5. [Security and privacy model](#security-and-privacy-model)
6. [Known limitations](#known-limitations)
7. [Desktop app](#desktop-app)

---

## How a call works

```
1. CREATE    Alice clicks "Create Room" → random 8-char code, e.g. /room/7kq2mxdp
             Browser fetches /api/ice-servers (STUN + short-lived TURN credentials)
             Browser opens a WebSocket to /ws?room=7kq2mxdp and sends create-room
             Alice becomes host.

2. JOIN      Bob opens the link → join. If the room has a password he's asked for it.
             He then waits until the host approves him (admission control).

3. HANDSHAKE The newcomer (Bob) starts a WebRTC connection to every existing peer.
             SDP offers/answers and ICE candidates are relayed through signaling,
             wrapped in a session id ({ sid, data }) so stale signals are ignored.

4. P2P       ICE finds a path (direct, via STUN, or relayed via TURN).
             Audio/video flow over DTLS-SRTP. Chat, reactions and files go over an
             encrypted WebRTC data channel. The server is no longer involved.

5. MESH      With N people each browser holds N-1 connections (max 6 people → 15 links).

6. LEAVE     Socket closes → server broadcasts peer-left → peers tear down that link.
             When the last person leaves, the room (and its password) is gone.
```

### What the server sees

| Sees | Never sees |
|---|---|
| Room codes, display names, who is in which room | Audio, video, screen shares |
| SDP and ICE candidates (network addresses) | Chat messages, reactions, files |
| A SHA-256 hash of the room password | Anything after the call ends: no logs or storage beyond the live room |

TURN servers only relay already-encrypted packets.

---

## Architecture

```
┌──────────────┐  WebRTC (DTLS-SRTP, data channel)  ┌──────────────┐
│   Browser A  │◄──────────────────────────────────►│   Browser B  │
└──────┬───────┘                                    └──────┬───────┘
       │ GET /api/ice-servers, WS /ws?room=…               │
       └───────────────────────┬───────────────────────────┘
                               ▼
            ┌───────────────────────────────────────┐
            │ Signaling backend (one of):            │
            │  • Node.js server  (dev / Docker)      │
            │  • Cloudflare Worker + Durable Object  │
            └───────────────────────────────────────┘
                     TURN (optional relay):
                     coturn (Docker) or Cloudflare Realtime TURN
```

### Shared core

All room logic lives in `packages/signaling-server/src/core/` and is transport-agnostic:

| File | Purpose |
|---|---|
| `protocol.ts` | Message types, validation, limits (6 peers, 10 waiting, 2-min admission timeout) |
| `room.ts` | `Room<C>`: create/join/admit/deny/leave/signal, host hand-off, rejoin secrets |
| `ice.ts` | Builds ICE server lists: Cloudflare TURN API, coturn REST credentials, or static |
| `rate-limit.ts` | Per-connection token bucket |

The Node server (`src/index.ts`) keeps a `Map<roomId, Room>`. The Cloudflare backend (`apps/cloudflare/src/room.ts`) runs one `Room` per Durable Object, using the WebSocket Hibernation API: per-connection state is stored in socket attachments, room metadata in Durable Object storage, and keepalive pings are answered by the runtime without waking the object.

### Frontend (`apps/web`)

| File | Purpose |
|---|---|
| `lib/signaling/client.ts` | WebSocket client: keepalive pings, exponential-backoff reconnect, automatic re-entry |
| `lib/webrtc/mesh.ts` | Peer connections, session ids, glare handling, ICE recovery, data-channel messages |
| `lib/webrtc/file-transfer.ts` | Chunked, acknowledged, per-recipient file transfer (50MB max) |
| `lib/media/manager.ts` | Camera/mic/screen capture, device switching, audio-only fallback |
| `lib/stores/room.ts` | Endpoints, ICE fetch, per-tab identity, preferences |

The app is a static SPA (SvelteKit + adapter-static). Its Content-Security-Policy is emitted as a `<meta>` tag with a hash for SvelteKit's boot script (`svelte.config.js`), so it works on any host.

---

## Signaling protocol

JSON over WebSocket. The client connects to `/ws?room=<roomId>` (the Node server ignores the query; Cloudflare uses it to pick the Durable Object).

**Client → server**

| Message | Fields |
|---|---|
| `create-room` | `roomId`, `peerId`, `displayName`, `secret`, `password?` |
| `join` | `roomId`, `peerId`, `displayName`, `secret`, `password?` |
| `admit-peer` / `deny-peer` | `peerId` (host only) |
| `signal` | `targetPeerId`, `signal` (opaque; the client sends `{ sid, data }`) |
| `leave` | — |
| `ping` | — (answered with `pong`) |

**Server → client**

| Message | Fields |
|---|---|
| `room-created` | `roomId` |
| `room-peers` | `peers[{ id, displayName }]`, `roomId`: you're in |
| `peer-joined` / `peer-left` | `peerId`, `displayName` |
| `host-changed` | `hostPeerId` |
| `password-required` | `roomId`, `invalid` (true if a wrong password was sent) |
| `waiting-for-admission` | `roomId` |
| `admission-request` / `admission-cancelled` | `peerId`, `displayName?` (to host) |
| `admission-granted` / `admission-denied` | `roomId`, `reason?` |
| `signal` | `fromPeerId`, `signal` |
| `error` | `message` |

**HTTP:** `GET /api/ice-servers` → `{ iceServers: RTCIceServer[], ttl? }`. `GET /healthz` → `ok`.

---

## Reconnection

- **Signaling drops.** The client pings every 25s and reconnects with backoff when a pong is missed or the socket closes. Each tab has a random `secret` (sessionStorage). On rejoin, a peer whose `peerId` + `secret` were already admitted skips the password and waiting room, and replaces its stale socket if the server hasn't noticed it's dead. If the room emptied in the meantime, the client re-creates it.
- **Page refresh.** `peerId`, `secret`, the room password and "I created this room" are kept in sessionStorage for the tab, so a refresh rejoins seamlessly. Closing the tab forgets everything.
- **P2P drops.** ICE `failed` (or `disconnected` for 5s) triggers a new connection with a fresh session id. If both sides restart at once ("glare"), the peer with the smaller id wins. Retries are capped at 5 per minute per peer.

---

## Security and privacy model

- **Site access.** Docker: Caddy basic auth. Cloudflare: `SITE_PASSWORD` secret. Either one protects the app and the TURN-credential endpoint, so strangers can't use your relay.
- **Rooms.** Unguessable 8-char codes, optional password (SHA-256 hashed server-side), and host approval for every newcomer.
- **TURN credentials.** Short-lived (12h by default): coturn uses a shared-secret HMAC (`use-auth-secret`), and Cloudflare credentials come from its API. No TURN password is baked into the frontend.
- **Input validation.** All signaling messages are validated and size-limited (64KB) and rate-limited per connection. WebSocket origins are checked.
- **Peer data.** Names shown in chat come from the server's validated list, not from what a peer claims over the data channel. SVG files aren't previewed inline.
- **Storage.** Chat history lives in sessionStorage (gone when the tab closes). localStorage only holds your display name and optional custom server settings.

---

## Known limitations

- Mesh topology: upload bandwidth grows with each participant, so 6 is the practical cap.
- Screen sharing replaces your camera feed. In audio-only mode there's no video track to swap, so remote peers won't see your screen.
- Switching microphones while sharing screen audio drops the screen audio until you re-share.
- Firefox doesn't support choosing the speaker output on all platforms (`setSinkId`).

---

## Desktop app

`apps/desktop` is an experimental [Tauri v2](https://tauri.app) shell around the web app. It needs Rust and app icons:

```bash
pnpm --filter @vchat/desktop exec tauri icon path/to/icon.png   # generates src-tauri/icons
pnpm desktop:dev
```

In the desktop app, set the signaling server URL under **Settings** (e.g. `wss://your-domain.com/ws`).

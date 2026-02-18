# vchat — Technical Documentation

## Table of Contents

1. [How It Works](#how-it-works)
2. [Architecture Deep Dive](#architecture-deep-dive)
3. [Setup Guide](#setup-guide)
4. [Port Reference](#port-reference)
5. [Current Status & Known Issues](#current-status--known-issues)
6. [Development Roadmap](#development-roadmap)

---

## How It Works

vchat is a peer-to-peer video chat app. Unlike Zoom or Discord, your audio and video never pass through a central server. The server's only job is to help peers find each other — after that, everything flows directly between browsers.

### The Call Lifecycle

```
1. CREATE ROOM
   User A opens the app → clicks "Create Room"
   → generates a 6-character room code (e.g. "x7km2a")
   → navigates to /room/x7km2a

2. JOIN SIGNALING
   Browser opens a WebSocket to the signaling server (port 3001)
   → sends: { type: "join", roomId: "x7km2a", peerId: "abc123", displayName: "Alice" }
   → server responds: { type: "room-peers", peers: [] }
   (empty room, Alice is first)

3. SECOND USER JOINS
   User B opens the room link → connects to signaling server
   → server tells B about existing peers: { type: "room-peers", peers: [{ id: "abc123", displayName: "Alice" }] }
   → server tells A about new peer: { type: "peer-joined", peerId: "def456", displayName: "Bob" }

4. WEBRTC HANDSHAKE
   B is the newcomer, so B initiates the WebRTC connection to A:

   B creates a SimplePeer(initiator: true)
   → SimplePeer generates an SDP offer (description of B's media capabilities)
   → B sends offer to A via signaling server:
     { type: "signal", targetPeerId: "abc123", signal: { type: "offer", sdp: "..." } }

   A receives the offer → creates SimplePeer(initiator: false)
   → SimplePeer generates an SDP answer
   → A sends answer back to B via signaling server

   Both sides also exchange ICE candidates (network path options):
   → Each peer sends multiple candidates as they're discovered
   → STUN servers (stun.l.google.com:19302) help peers discover their public IP

5. P2P CONNECTION ESTABLISHED
   Once ICE negotiation completes, a direct DTLS-SRTP connection is established.
   Audio and video streams flow directly between browsers.
   The signaling server is no longer involved in media.

6. MESH TOPOLOGY (3+ PEOPLE)
   When Person C joins:
   → C initiates connections to BOTH A and B
   → A and B each accept C's connection
   → Result: A↔B, A↔C, B↔C (full mesh)

   At 6 people: each person maintains 5 connections = 15 total connections
   This is the practical limit for mesh networking.

7. TEXT CHAT
   Chat messages are sent through the signaling server (not WebRTC data channels).
   This keeps chat working even when video connections are still establishing.

8. LEAVING
   When a user closes the tab or clicks "Leave":
   → WebSocket disconnects → server detects and removes peer from room
   → Server broadcasts { type: "peer-left", peerId: "..." } to remaining peers
   → Each peer destroys the SimplePeer connection to the departed user
   → Empty rooms are automatically cleaned up
```

### What the Server Sees vs. What It Doesn't

**Server sees:**
- Room IDs and who's in them
- Display names
- ICE candidates (network addresses, but not media content)
- Chat messages (routed through server)

**Server never sees:**
- Audio or video content (encrypted P2P via DTLS-SRTP)
- Screen share content
- Any media data whatsoever

### Why TURN?

~85% of the time, peers can connect directly using STUN (which just tells each peer its public IP). But when both peers are behind strict/symmetric NATs (corporate networks, mobile carriers), direct connection is impossible. In these cases, a TURN server relays the encrypted media. The TURN server sees encrypted packets but cannot decrypt them.

---

## Architecture Deep Dive

### Project Structure

```
vchat/
├── apps/
│   ├── web/                          # SvelteKit SPA
│   │   ├── src/
│   │   │   ├── lib/
│   │   │   │   ├── signaling/
│   │   │   │   │   └── client.ts     # WebSocket client with reconnect
│   │   │   │   ├── webrtc/
│   │   │   │   │   └── mesh.ts       # P2P mesh manager (simple-peer)
│   │   │   │   ├── media/
│   │   │   │   │   └── manager.ts    # Camera, mic, screen share
│   │   │   │   └── stores/
│   │   │   │       └── room.ts       # Room state, display name, config
│   │   │   └── routes/
│   │   │       ├── +page.svelte      # Landing page (create/join room)
│   │   │       └── room/[id]/
│   │   │           ├── +page.svelte  # Main call view
│   │   │           ├── VideoTile.svelte
│   │   │           └── ChatPanel.svelte
│   │   └── svelte.config.js
│   │
│   └── desktop/                      # Tauri v2 wrapper (incomplete)
│       └── src-tauri/
│           ├── tauri.conf.json
│           ├── Cargo.toml
│           └── src/
│               ├── main.rs
│               └── lib.rs
│
├── packages/
│   └── signaling-server/
│       └── src/
│           ├── index.ts              # WebSocket server entry (port 3001)
│           ├── rooms.ts              # Room CRUD, peer tracking, broadcast
│           └── handlers.ts           # Message routing (join/leave/signal/chat)
│
├── docker-compose.yml                # Signaling + Coturn
├── turnserver.conf                   # Coturn configuration
└── pnpm-workspace.yaml               # Monorepo config
```

### Data Flow

```
┌──────────────┐          ┌──────────────┐
│   Browser A  │          │   Browser B  │
│              │          │              │
│  SvelteKit   │          │  SvelteKit   │
│  + simple-   │◄────────►│  + simple-   │
│    peer      │  WebRTC  │    peer      │
│              │  (P2P)   │              │
└──────┬───────┘          └──────┬───────┘
       │ WebSocket               │ WebSocket
       │ (signaling only)        │ (signaling only)
       └──────────┬──────────────┘
                  │
          ┌───────▼────────┐
          │ Signaling Server│  Port 3001
          │  (Node.js + ws) │  In-memory rooms
          └────────────────┘

          ┌────────────────┐
          │   Coturn TURN   │  Port 3478/5349
          │   (if needed)   │  Relay only
          └────────────────┘
```

### Signaling Protocol

All messages are JSON over WebSocket.

**Client → Server:**

| Message | Fields | Purpose |
|---------|--------|---------|
| `join` | `roomId`, `peerId`, `displayName` | Enter a room |
| `leave` | — | Exit current room |
| `signal` | `targetPeerId`, `signal` | Forward WebRTC signal to specific peer |
| `chat` | `text` | Send chat message to room |

**Server → Client:**

| Message | Fields | Purpose |
|---------|--------|---------|
| `room-peers` | `peers[]`, `roomId` | List of peers already in room (sent on join) |
| `peer-joined` | `peerId`, `displayName` | New peer entered the room |
| `peer-left` | `peerId`, `displayName` | Peer left the room |
| `signal` | `fromPeerId`, `signal` | Forwarded WebRTC signal from another peer |
| `chat` | `fromPeerId`, `displayName`, `text`, `timestamp` | Chat message from peer |
| `error` | `message` | Error notification |

### Key Libraries

| Library | Role | Notes |
|---------|------|-------|
| `ws` (npm) | WebSocket server | Lightweight, no HTTP overhead |
| `simple-peer` | WebRTC abstraction | Wraps RTCPeerConnection into ~10 lines |
| `nanoid` | ID generation | Room codes + peer IDs |
| `svelte` | UI framework | Reactive, compiled, small bundle |
| `@sveltejs/kit` | App framework | Routing, SSR (disabled), static build |

---

## Setup Guide

### Prerequisites

- **Node.js 18+** — `node --version`
- **pnpm** — `npm install -g pnpm`
- **Rust** (for desktop app only) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **Docker** (for self-hosting) — optional

### Local Development

```bash
cd vchat

# Install all dependencies
pnpm install

# Start everything (signaling server + web app)
pnpm dev

# Or start individually:
pnpm dev:signal    # signaling server on ws://localhost:3001
pnpm dev:web       # web app on http://localhost:5173
```

**Testing locally:**
1. Open http://localhost:5173 in one browser tab
2. Enter a name, click "Create Room"
3. Copy the room URL
4. Open it in another tab (or incognito window)
5. Enter a different name
6. Both tabs should connect and show video

**Testing with multiple devices on same network:**
1. Find your local IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`
2. On other devices, open `http://<your-ip>:5173`
3. Join the same room code

### Production Deployment

**1. Build the web app:**
```bash
pnpm build:web
# Output: apps/web/build/ (static files)
```

**2. Serve static files with any web server:**
```nginx
# Example nginx config
server {
    listen 443 ssl;
    server_name chat.yourdomain.com;

    root /path/to/vchat/apps/web/build;
    index index.html;

    # SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**3. Run signaling server + TURN:**
```bash
# Edit turnserver.conf first — change credentials and realm
docker compose up -d
```

**4. Configure the web app to point to your server:**

Users set this in their browser console (or you hardcode it in `room.ts`):
```js
localStorage.setItem('vchat_signal_url', 'wss://chat.yourdomain.com:3001')
```

### Desktop App (requires Rust)

```bash
# Install Rust if not already
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Build desktop app
cd apps/desktop
pnpm install
pnpm build
# Output: src-tauri/target/release/bundle/
```

---

## Port Reference

| Port | Service | Protocol | Required? | Notes |
|------|---------|----------|-----------|-------|
| **5173** | Vite dev server | HTTP | Dev only | Auto-assigned, not used in production |
| **3001** | Signaling server | WebSocket (ws/wss) | Yes | Must be reachable by all clients |
| **3478** | Coturn TURN | TCP + UDP | Production | Only needed for NAT-restricted peers |
| **5349** | Coturn TURN (TLS) | TCP + UDP | Optional | Encrypted TURN relay |
| **49152-49200** | Coturn relay range | UDP | Production | Media relay ports (configurable range) |
| ephemeral | WebRTC P2P | UDP | Automatic | OS-assigned, used for direct peer connections |

### Firewall Rules (production server)

```bash
# Minimum required
ufw allow 3001/tcp    # signaling WebSocket
ufw allow 3478/tcp    # TURN TCP
ufw allow 3478/udp    # TURN UDP
ufw allow 49152:49200/udp  # TURN relay range
```

---

## Current Status & Known Issues

### What Works (v0.1)

- [x] Signaling server — room management, SDP/ICE relay, chat
- [x] 1-on-1 video/audio calls in browser
- [x] Group calls (2-6 people) via mesh
- [x] Mute/unmute audio and video
- [x] Text chat through signaling server
- [x] Create room / join via code or link
- [x] Auto-reconnect for signaling WebSocket
- [x] Docker deployment for signaling + TURN
- [x] Static build for web app

### Known Bugs

1. **Screen sharing track management is broken**
   `mesh.ts` adds screen share tracks but never removes camera tracks. Peers receive both streams simultaneously. The `replaceStream()` function also accumulates tracks without removing old ones.

2. **No WebRTC connection recovery**
   If a peer's network drops and reconnects, the WebRTC connection dies but the UI doesn't detect it. No `iceconnectionstatechange` monitoring. Users must manually leave and rejoin.

3. **TURN not wired to frontend**
   `ICE_SERVERS` in `mesh.ts` only contains Google STUN servers. The `setTurnServer()` helper exists but is never called from the UI. Peers behind strict NAT will fail to connect.

4. **No input validation on signaling messages**
   The server accepts any string for roomId/peerId without length or character validation.

5. **No WebSocket ping/pong heartbeat**
   Stale connections from crashed clients linger until the TCP timeout (minutes).

### What's Incomplete

- Desktop app is a Tauri shell with no desktop-specific features
- Push-to-talk hotkey plugin loaded but not wired up
- No settings UI for signaling server URL or TURN config
- No connection quality indicators
- No user feedback when media permissions are denied

---

## Development Roadmap

### Phase 2: Fix Core Issues (Priority)

These bugs need fixing before the app is usable day-to-day.

**2.1 — Fix screen sharing track management**
- When starting screen share: remove camera video track, add screen track
- When stopping screen share: remove screen track, re-add camera track
- Use `peer._pc.getSenders()` to find and replace tracks via `sender.replaceTrack()`
- This avoids full renegotiation and is smoother than addTrack/removeTrack

**2.2 — Add WebRTC connection monitoring**
- Listen to `iceconnectionstatechange` on each peer connection
- States to handle: `disconnected` (temporary), `failed` (permanent)
- On `failed`: destroy peer, attempt re-initiation through signaling
- On `disconnected`: show visual indicator, wait for recovery
- Add connection quality display (using `peer._pc.getStats()`)

**2.3 — Wire TURN server to frontend**
- Add a settings modal for signaling URL and TURN credentials
- Store TURN config in localStorage alongside signaling URL
- Pass TURN credentials to `ICE_SERVERS` array before creating peers
- For self-hosted deployments: allow setting TURN via environment variable baked into the build

**2.4 — Add WebSocket heartbeat**
- Server sends ping every 30s
- Client responds with pong
- Server drops clients that miss 2 consecutive pings
- Prevents ghost peers in rooms

### Phase 3: Desktop App

**3.1 — Complete Tauri integration**
- Verify WebRTC works through macOS WebKit WebView
- Test camera/mic permissions in Tauri context
- Add proper Content Security Policy

**3.2 — Push-to-talk**
- Register global keyboard shortcut (e.g., backtick key) via `tauri-plugin-global-shortcut`
- Send IPC message to frontend to toggle mute
- Visual indicator when push-to-talk is active
- Settings to change the keybinding

**3.3 — System tray**
- Minimize to tray instead of closing
- Tray icon shows active call status
- Quick actions: mute, leave call, open window

**3.4 — Auto-update**
- Use Tauri's built-in updater
- Host update manifest on GitHub Releases or own server

### Phase 4: Polish & Features

**4.1 — Data channel chat (move off signaling server)**
- Replace signaling-server chat relay with WebRTC data channels
- Chat works even if signaling server goes down mid-call
- Enables file sharing through data channels later

**4.2 — UI improvements**
- Speaker detection (highlight active speaker's video tile)
- Bandwidth-adaptive video quality (lower resolution on poor connections)
- Full-screen mode for single video
- Picture-in-picture mode
- Dark/light theme toggle

**4.3 — Room features**
- Room passwords / access control
- Persistent rooms (SQLite on signaling server)
- Room capacity limits
- Lobby / waiting room before joining

**4.4 — Audio processing**
- Background noise suppression (Web Audio API or RNNoise WASM)
- Echo cancellation improvements
- Audio level meters in UI

### Phase 5: Production Hardening

**5.1 — Security**
- Rate limiting on signaling server (per-IP connection limits)
- Input validation on all signaling messages
- CORS configuration for signaling WebSocket
- TLS for signaling (wss://)
- Proper CSP headers in Tauri and web builds

**5.2 — Monitoring**
- Prometheus metrics endpoint on signaling server
- Track: active rooms, connected peers, connection durations, failure rates
- Health check endpoint for Docker

**5.3 — Scalability (if needed)**
- Redis pub/sub for multi-instance signaling servers
- Horizontal scaling behind a load balancer
- Optional SFU mode (mediasoup/LiveKit) for 7+ person calls

**5.4 — Mobile**
- Responsive web UI (works now, but not optimized)
- PWA manifest + service worker for installability
- Test on iOS Safari and Android Chrome

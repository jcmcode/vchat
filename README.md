# vchat

Self-hosted P2P encrypted video chat. No accounts, no tracking, no media servers.

## Quick Start

### Prerequisites
- Node.js 18+
- pnpm (`npm install -g pnpm`)

### Development

```bash
# Install dependencies
pnpm install

# Start signaling server + web app
pnpm dev
```

- Web app: http://localhost:5173
- Signaling server: ws://localhost:3001

### How it works

1. Open the web app
2. Enter your name and click "Create Room"
3. Share the room link with others
4. Everyone connects P2P — video, audio, and chat never touch the server

The signaling server only brokers the initial WebRTC handshake. All media flows directly between peers.

## Self-Hosting

### Docker Compose

```bash
# Start signaling server + TURN relay
docker compose up -d

# Build the web app
pnpm build:web
# Serve apps/web/build/ with any static file server (nginx, caddy, etc.)
```

Edit `turnserver.conf` to set your TURN credentials and realm.

### TURN Server

A TURN server is only needed when peers can't connect directly (~15% of cases, strict NATs). The included Coturn configuration handles this.

Update the TURN server URL in the web app by setting it in localStorage:
```js
localStorage.setItem('vchat_signal_url', 'wss://your-server.com:3001')
```

## Desktop App

Requires [Rust](https://rustup.rs/) to build.

```bash
cd apps/desktop
pnpm dev    # development
pnpm build  # production build
```

## Architecture

```
Peers ←→ WebRTC (P2P mesh) ←→ Peers
              ↕
    Signaling Server (WebSocket)
         ~500 LOC, stateless
```

- **2-6 person calls** via P2P mesh — each peer connects to every other peer
- **End-to-end encrypted** by default (DTLS-SRTP, built into WebRTC)
- **Signaling server** only relays SDP offers/answers and ICE candidates
- **TURN relay** as fallback for restrictive NATs

## Project Structure

```
vchat/
├── apps/
│   ├── web/                  # SvelteKit web app
│   └── desktop/              # Tauri v2 desktop wrapper
├── packages/
│   └── signaling-server/     # Node.js WebSocket signaling
├── docker-compose.yml
└── turnserver.conf
```

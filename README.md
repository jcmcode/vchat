# vchat

Self-hosted P2P encrypted video chat. No accounts, no tracking, no media servers. Spin up a server, share the link, talk, tear it down when you're done.

## What this is

- **Peer-to-peer** — video, audio, and chat flow directly between browsers, never through the server
- **End-to-end encrypted** — WebRTC's built-in DTLS-SRTP encryption, always on
- **Ephemeral** — no databases, no message history, nothing persists after you close the tab
- **2-6 people** per room, mesh topology
- **Features** — screen sharing, file transfer, text chat, reactions, room passwords, host admission control

The server only exists to help peers find each other (signaling). Once connected, it's out of the loop.

## Deploy

You need a VPS (any $5-6/mo provider works) and a domain name.

**1. Get a server**

Any Linux VPS with 1GB RAM: [DigitalOcean](https://digitalocean.com), [Hetzner](https://hetzner.com), [Vultr](https://vultr.com), etc. Ubuntu 22.04+ recommended.

**2. Point your domain**

Add a DNS `A` record pointing your domain to the server's IP address.

**3. Install Docker**

```bash
curl -fsSL https://get.docker.com | sh
```

**4. Clone and deploy**

```bash
git clone https://github.com/jcmcode/vchat.git
cd vchat
bash deploy.sh
```

The script will prompt you for your domain, email (for TLS certs), and a password to protect the site. It handles everything else — generates TURN credentials, configures the firewall, obtains HTTPS certificates, and starts the containers.

**5. Done**

Share `https://your-domain.com` and the password with whoever you want to talk to.

## Tear down

```bash
docker compose down -v
```

The server retains nothing. Destroy the VPS whenever you're done.

## Ports

If your provider has an external firewall (e.g. DigitalOcean Cloud Firewall), open these:

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP | SSH |
| 80 | TCP | HTTP (cert issuance) |
| 443 | TCP | HTTPS |
| 3478 | TCP/UDP | TURN |
| 5349 | TCP/UDP | TURNS (TLS) |
| 49152-65535 | UDP | TURN relay |

The deploy script configures `ufw` automatically if it's available.

## Architecture

```
Browsers <---> WebRTC P2P mesh <---> Browsers
                    |
          Signaling Server (WebSocket)
              only relays handshakes

          TURN Server (Coturn)
              fallback relay for ~15% of
              connections behind strict NATs
```

All three services run in Docker containers behind Caddy (reverse proxy + auto HTTPS):

- **web** — Caddy serving the static SvelteKit app + reverse proxying `/ws` to signaling
- **signaling** — ~500 LOC Node.js WebSocket server
- **coturn** — TURN/TURNS relay using Caddy's TLS certificates

## Local development

```bash
# Prerequisites: Node.js 18+, pnpm
pnpm install
pnpm dev
```

Web app runs at `http://localhost:5173`, signaling server at `ws://localhost:3001`.

## Project structure

```
vchat/
├── apps/web/                  SvelteKit frontend
├── packages/signaling-server/ Node.js WebSocket signaling
├── deploy.sh                  Interactive deployment script
├── docker-compose.yml         Production container orchestration
├── Caddyfile                  Reverse proxy + TLS config
├── turnserver.conf.template   TURN server config template
├── Dockerfile.web             Web + Caddy container
└── .env.example               Environment variable reference
```

## License

MIT

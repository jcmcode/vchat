# vchat

Self-hosted P2P encrypted video chat. No accounts, no tracking, no media servers. Spin it up, share the link, talk, tear it down when you're done.

- **Peer-to-peer**: video, audio, chat and files flow directly between browsers, never through the server
- **End-to-end encrypted**: WebRTC's built-in DTLS-SRTP encryption, always on
- **Ephemeral**: no database, no message history; chat lives only in your browser tab
- **2–6 people** per room (mesh topology)
- **Features**: screen sharing (with audio), file transfer, text chat, reactions, room passwords, host admission control, automatic reconnection

The server only helps peers find each other (signaling) and hands out TURN relay credentials. Once connected, it's out of the loop.

## Choose how to run it

| | Cost | Needs | Best for |
|---|---|---|---|
| [**Cloudflare**](#deploy-on-cloudflare) | Free tier is plenty for personal use | Cloudflare account | Easiest, nothing to maintain |
| [**Docker on a VPS**](#deploy-with-docker-on-a-vps) | ~$5/mo | Linux server + domain | Full control, your own TURN server |
| [**Local**](#local-development) | Free | Node.js 20+ | Development |

---

## Deploy on Cloudflare

Runs entirely on Cloudflare: the web app is served as static assets, and signaling runs in a [Durable Object](https://developers.cloudflare.com/durable-objects/) per room (it sleeps between messages, so idle calls cost nothing). Optional TURN relay comes from [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/).

Nothing account-specific is stored in this repo. Your account comes from `wrangler login`, secrets live in Cloudflare, and your domain is attached in the dashboard.

**1. Install and log in**

```bash
git clone https://github.com/jcmcode/vchat.git
cd vchat
corepack enable    # or: npm install -g pnpm
pnpm install
pnpm --filter @vchat/cloudflare exec wrangler login
```

**2. Set a site password** (recommended: otherwise anyone who finds the URL can use your TURN quota)

```bash
pnpm --filter @vchat/cloudflare exec wrangler secret put SITE_PASSWORD
```

Visitors will be asked to log in with username `vchat` and this password.

**3. (Optional) Enable TURN relay**

Without TURN, calls connect for most home networks but can fail on strict corporate or mobile networks. To enable it, go to Cloudflare dashboard → **Realtime** → **TURN Server** → **Create**, then:

```bash
pnpm --filter @vchat/cloudflare exec wrangler secret put CF_TURN_KEY_ID
pnpm --filter @vchat/cloudflare exec wrangler secret put CF_TURN_API_TOKEN
```

**4. Deploy**

```bash
pnpm cf:deploy
```

Your app is live at `https://vchat.<your-subdomain>.workers.dev`.

**5. (Optional) Use your own domain**

Dashboard → **Workers & Pages** → **vchat** → **Settings** → **Domains & Routes** → **Add** → **Custom domain**. If you serve the app from more than one hostname, list them in `ALLOWED_ORIGIN` (see `apps/cloudflare/wrangler.jsonc`).

To test locally with the real Workers runtime: `pnpm cf:dev` (opens on http://localhost:8787). Put local-only secrets in `apps/cloudflare/.dev.vars` (see `.dev.vars.example`; this file is gitignored).

To remove everything: `pnpm --filter @vchat/cloudflare exec wrangler delete`.

---

## Deploy with Docker on a VPS

You need a Linux VPS (1GB RAM is enough; Ubuntu 22.04+ recommended) and a domain name.

1. **Point your domain**: add a DNS `A` record for your domain pointing at the server's IP.
2. **Install Docker**: `curl -fsSL https://get.docker.com | sh`
3. **Clone and deploy**:

   ```bash
   git clone https://github.com/jcmcode/vchat.git
   cd vchat
   bash deploy.sh
   ```

   The script asks for your domain, an email for TLS certificates and a site password. It then generates a TURN secret, configures the firewall, gets HTTPS certificates and starts everything. Re-running it is safe.

4. Share `https://your-domain.com` and the password (username `vchat`) with whoever you want to talk to.

**Tear down:** `docker compose down -v`. The server retains nothing, so you can destroy the VPS whenever you're done.

**Ports.** If your provider has an external firewall (e.g. DigitalOcean Cloud Firewall), open these:

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP | SSH |
| 80 | TCP | HTTP (certificate issuance) |
| 443 | TCP | HTTPS |
| 3478 | TCP/UDP | TURN |
| 5349 | TCP/UDP | TURNS (TLS) |
| 49152–65535 | UDP | TURN relay |

What runs:

- **web**: Caddy serving the static app, reverse-proxying `/ws` and `/api` to signaling, automatic HTTPS
- **signaling**: Node.js WebSocket server that also mints short-lived TURN credentials
- **coturn**: TURN/TURNS relay using Caddy's certificates and a shared secret (no static TURN passwords)

---

## Local development

Prerequisites: Node.js 20+ and pnpm (`corepack enable`, or `brew install pnpm`).

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173. Vite proxies `/ws` and `/api` to the signaling server on port 3001, the same way production does. To try a call, open the room link in a second browser window.

| Command | What it does |
|---|---|
| `pnpm dev` | Web app + Node signaling server with hot reload |
| `pnpm test` | Signaling logic unit tests |
| `pnpm check` | Type-check everything |
| `pnpm build` | Production build of web app and Node server |
| `pnpm cf:dev` | Run the Cloudflare version locally (port 8787) |

### Configuration reference

The signaling server (Node or Cloudflare) reads these environment variables / secrets:

| Variable | Purpose |
|---|---|
| `ALLOWED_ORIGIN` | Comma-separated allowed origins for WebSocket connections. Node: any origin if unset. Cloudflare: same-origin if unset |
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Use Cloudflare Realtime TURN |
| `TURN_URLS` + `TURN_SECRET` | Use coturn with `use-auth-secret` (short-lived credentials) |
| `TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL` | Use a TURN server with static credentials |
| `STUN_URLS` | Override the default STUN servers |
| `SITE_PASSWORD` | Cloudflare only: password-protect the whole site (Docker uses Caddy basic auth instead) |
| `PORT` | Node only: listen port (default 3001) |

Users can also point the app at a different signaling server or TURN server under **Settings** on the home page.

## Project structure

```
vchat/
├── apps/web/                    SvelteKit frontend (static SPA)
├── apps/cloudflare/             Cloudflare Worker + Durable Object (signaling + static hosting)
├── apps/desktop/                Experimental Tauri desktop shell
├── packages/signaling-server/
│   ├── src/core/                Shared room logic, protocol, TURN credentials (used by both backends)
│   └── src/index.ts             Node.js server (local dev + Docker)
├── deploy.sh                    Interactive VPS deployment
├── docker-compose.yml           Production containers (Caddy, signaling, coturn)
├── Caddyfile                    Reverse proxy + TLS
└── turnserver.conf.template     coturn config template
```

See [DOCS.md](DOCS.md) for how it works under the hood.

## License

[MIT](LICENSE)

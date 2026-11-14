# vchat

Your own private, end-to-end encrypted video calls. Deploy it on your domain, sign in as the owner, and send invite links to whoever you want to talk to. Guests don't need accounts. Nothing is stored and nothing is logged.

- **Peer-to-peer**: video, audio, screen sharing, chat and files flow directly between browsers, never through the server
- **End-to-end encrypted and verified**: WebRTC's DTLS-SRTP encryption, plus a secret room key that lives only in the invite link (after `#`, which browsers never send to a server; the one exception is an emailed invite you choose to include the key in, which passes through your server and the email service). Every connection proves it knows the key over its own encryption fingerprints before any audio, video or chat flows, so a compromised signaling server can't sit in the middle unnoticed. Optional 12-digit safety codes let you double-check out loud (see [DOCS.md](DOCS.md#end-to-end-verification) for what this does and doesn't cover)
- **Invite-only**: only the owner can create rooms; guests get in with an invite link (plus an optional password and your approval)
- **No data, no logs**: no database, no accounts, no message history, and no server or container logs. Invite links are self-contained signed tokens
- **2–6 people** per room
- **Features**:
  - Video, audio-only, or **chat-only** participation
  - **Screen sharing** (with audio), plus a **laser pointer and drawing** over the shared screen that everyone sees
  - A **shared whiteboard** (pen, highlighter, text, eraser) you can export as **PDF** or PNG
  - Group chat, **private direct messages** and **files sent straight to one person** (tap them), and reactions
  - **Calendar and email invites**: download an `.ics` event or draft an email in your own mail app. Nothing is sent by vchat
  - Named rooms (the host can rename during a call), host approval, and automatic reconnection
  - **Host controls**: lock the call so nobody new can join (even with an invite), end it for everyone, and get a chime, a flashing tab title and, if you turn it on, a system notification when someone is waiting to join (it never shows who)

## How it works for you

1. **You sign in** at `https://your-domain/admin`, with Cloudflare Access, a code emailed to you, or an owner password.
2. **Create a room**: give it a name, optionally a password, choose whether guests wait for your approval, and pick how long the invite lasts.
3. **Send the invite link** (or the ready-made invite message). Send the password separately if you set one. With [email set up](#email-sign-in-and-invites-resend), the server can also email each guest their own link and a 6-digit code.
4. **Guests open the link**, type their name, and join. No sign-up, no app.

Anyone visiting your site without an invite link sees a "private server" page and can't create rooms, join calls or use your relay server.

## Choose where to run it

| | Cost | Needs | Owner sign-in |
|---|---|---|---|
| [**Cloudflare**](#deploy-on-cloudflare) | Free for personal use | Cloudflare account + a domain | Cloudflare Access (recommended), emailed code, or password |
| [**Docker on any server**](#deploy-with-docker) | ~$5/mo VPS | Linux server + a domain | Password or emailed code (or Cloudflare Access via Tunnel) |
| [**Local**](#local-development) | Free | Node.js 20+ | None (open mode) |

---

## Deploy on Cloudflare

Runs entirely on Cloudflare: static files are served for free, signaling runs in a [Durable Object](https://developers.cloudflare.com/durable-objects/) per room (it sleeps between messages, so idle calls cost nothing, and writes nothing to Durable Object storage), and optional relay comes from [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/). Nothing account-specific is stored in this repo.

Cloudflare terminates TLS for your site, so it can see what passes through the Worker: signaling messages (room ids, display names, network addresses in ICE candidates, room passwords as they're checked) and visitors' IP addresses. It never sees call content, which is encrypted between browsers. If that's not acceptable, use the Docker deployment on a server you control.

### 1. Deploy

```bash
git clone https://github.com/jcmcode/vchat.git
cd vchat
corepack enable          # or: npm install -g pnpm
pnpm install
pnpm --filter @vchat/cloudflare exec wrangler login

# The key that signs invite links (paste the output of `openssl rand -hex 32` when asked)
pnpm --filter @vchat/cloudflare exec wrangler secret put SECRET_KEY

pnpm cf:deploy
```

### 2. Put it on your domain

The domain must already be on your Cloudflare account. Write it in `apps/cloudflare/.deploy.local` (git ignores this file, so your domain never ends up in the repo) and deploy again:

```bash
echo "DOMAIN=call.yourdomain.com" > apps/cloudflare/.deploy.local
pnpm cf:deploy
```

This attaches the domain to the Worker and switches off the `*.workers.dev` address, so the app is only reachable on your domain.

### 3. Set up owner sign-in with Cloudflare Access (recommended)

Access means there's no owner password to leak: you sign in with your email (a one-time code) or Google/GitHub. It's free for up to 50 users.

1. Dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Add **two** public hostnames, both on `call.yourdomain.com`: one with path `admin`, one with path `api/admin`. Everything under those paths is covered too. Only these are protected; guests reach invite links without signing in.
3. Add a policy: **Action: Allow**, **Include → Emails →** your email address.
4. Save. Then open the application's overview and copy its **Application Audience (AUD) Tag**. Your team domain is shown in **Zero Trust → Settings** and looks like `yourteam.cloudflareaccess.com`.
5. Give both to the Worker, then redeploy:

   ```bash
   pnpm --filter @vchat/cloudflare exec wrangler secret put CF_ACCESS_TEAM_DOMAIN
   pnpm --filter @vchat/cloudflare exec wrangler secret put CF_ACCESS_AUD
   pnpm cf:deploy
   ```

Open `https://call.yourdomain.com/admin`. Cloudflare asks you to sign in, then you're on your dashboard. To check that it's protected, open `https://call.yourdomain.com/api/admin/session` in a private window: you should see Cloudflare's sign-in page, not data. The Worker also verifies Access's signed token itself, so `/api/admin` stays locked even when reached another way (e.g. the `workers.dev` address).

**Simpler alternatives:** skip Access and sign in with a code emailed to you (see [Email sign-in and invites](#email-sign-in-and-invites-resend)), or set an owner password with `wrangler secret put ADMIN_PASSWORD`.

### 4. (Optional) Enable TURN relay

Without a relay, calls connect on most home networks but can fail on strict corporate or mobile networks. Go to Dashboard → **Realtime** → **TURN Server** → **Create**, then:

```bash
pnpm --filter @vchat/cloudflare exec wrangler secret put CF_TURN_KEY_ID
pnpm --filter @vchat/cloudflare exec wrangler secret put CF_TURN_API_TOKEN
```

Only invited guests and you can get relay credentials, so strangers can't run up your bill. The first 1,000 GB per month is free, then $0.05/GB.

To test locally with the real Workers runtime: `pnpm cf:dev` (http://localhost:8787). Put local-only secrets in `apps/cloudflare/.dev.vars` (see `.dev.vars.example`; it's gitignored). To remove everything: `pnpm --filter @vchat/cloudflare exec wrangler delete`.

---

## Email sign-in and invites (Resend)

Optional, on either deployment. With [Resend](https://resend.com) set up:

- **Owner sign-in by email** (when `OWNER_EMAIL` is set): at `/admin` you enter your address and get a 6-digit code by email, valid for 10 minutes. There's no password to leak. Anyone can ask for a code, but only your address ever receives one, and the page answers the same way for every address.
- **Emailed invites** (whenever Resend is configured in private mode): from the dashboard, enter a guest's email address. They get a "Join the call" link and a 6-digit code that is theirs alone, and they need both to get in. You then admit them as usual, and you see which address the invite was sent to. A forwarded link is useless without the code, and you can still deny or remove anyone.

Nothing about this is stored: the sign-in code lives only inside a signed, 10-minute challenge, and each emailed invite is a signed token like any other.

**Set up Resend:**

1. Create a Resend account and **add your sending domain** (e.g. `example.com`, or a subdomain like `mail.example.com`). Resend shows DNS records (SPF, DKIM and so on); add them in Cloudflare DNS (or wherever your DNS is) and wait until the domain shows as verified.
2. Create an **API key with "Sending access" only**, restricted to that domain if you like.
3. In the domain's settings, **turn off open and click tracking**, so the emails contain no tracking pixel and links aren't rewritten through Resend.

**Set the secrets.** On Cloudflare:

```bash
pnpm --filter @vchat/cloudflare exec wrangler secret put RESEND_API_KEY
pnpm --filter @vchat/cloudflare exec wrangler secret put EMAIL_FROM      # e.g. vchat <invites@example.com>
pnpm --filter @vchat/cloudflare exec wrangler secret put OWNER_EMAIL     # optional: sign in by email
pnpm cf:deploy
```

With Docker, add the same three lines to `.env` (docker-compose passes them on), e.g. `EMAIL_FROM='vchat <invites@example.com>'`, then `docker compose up -d`. If `OWNER_EMAIL` is set, it takes over from `ADMIN_PASSWORD`. Cloudflare Access, if configured, still wins over both.

**The trade-off.** An invite email carries everything a guest needs to join: the link (with the room key) and their code. It passes through your server, Resend, and both mail providers. Approval still protects you: nobody gets in without you letting them in. But for sensitive calls, compare the [safety codes](DOCS.md#end-to-end-verification) out loud once you're connected; they reveal anyone in the middle, even someone who read the email.

---

## Deploy with Docker

Works on any Linux server with Docker (1GB RAM is plenty; Ubuntu 22.04+ recommended) and a domain pointing at it.

```bash
curl -fsSL https://get.docker.com | sh      # if Docker isn't installed
git clone https://github.com/jcmcode/vchat.git
cd vchat
sudo bash deploy.sh
```

The script asks for your domain, an email for HTTPS certificates, the server's public IP (it suggests the one your domain points at) and an **owner password**. It then generates the signing and relay secrets, configures the firewall (it shows the SSH port(s) it will keep open and asks you to confirm), builds and starts everything, and checks that `https://your-domain/api/config` answers. Re-running it is safe, and existing invite links keep working.

Then sign in at `https://your-domain/admin`.

**What runs:**

- **web**: Caddy serving the app with automatic HTTPS, with all logging discarded
- **signaling**: a small Node.js server for room signaling, owner sign-in, invites and short-lived relay credentials
- **coturn**: your own STUN and TURN relay, with logging off. Browsers use it for STUN too, so a Docker deployment contacts no third-party servers. It refuses to relay to private or internal addresses or to the server itself, and has bandwidth quotas. It doesn't use TLS itself: the media it relays is already end-to-end encrypted

Docker keeps no container logs (`logging: driver: none`). To debug, see [DOCS.md → Debugging with logs](DOCS.md#debugging-with-logs).

**Tear down:** `docker compose down -v`.

**Ports** (if your provider has an external firewall): your SSH port, 80/tcp + 443/tcp (HTTPS), 3478 tcp/udp (STUN/TURN), 61000–65535/udp (relay). The script must run as root (`sudo bash deploy.sh`).

**Prefer Cloudflare Access?** Run the containers behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/), add `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` to `.env` (docker-compose passes them to the signaling service), and protect `/admin` and `/api/admin` exactly as described above.

---

## Local development

Prerequisites: Node.js 20+ and pnpm (`corepack enable`, or `brew install pnpm`).

```bash
pnpm install
pnpm dev
```

Open http://localhost:5173. With nothing configured, the app runs in **open mode**: anyone can create rooms from the home page. To try private mode locally:

```bash
SECRET_KEY=$(openssl rand -hex 32) ADMIN_PASSWORD=devpassword pnpm dev
```

| Command | What it does |
|---|---|
| `pnpm dev` | Web app + Node signaling server with hot reload |
| `pnpm test` | Unit tests (rooms, invites, sign-in, relay credentials) |
| `pnpm check` | Type-check everything |
| `pnpm build` | Production build of web app and Node server |
| `pnpm cf:dev` | Run the Cloudflare version locally (port 8787) |

### Configuration reference

The same settings work on every backend (Node environment variables or Cloudflare secrets):

| Setting | Purpose |
|---|---|
| `SECRET_KEY` | Signs invite links and owner sessions. 32+ random characters; keep it stable. **Required for private mode** (and setting it means you want private mode) |
| `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` | Owner signs in with Cloudflare Access |
| `OWNER_EMAIL` | Owner signs in with a 6-digit code emailed to this address. Needs `RESEND_API_KEY` + `EMAIL_FROM`. Used instead of `ADMIN_PASSWORD` if both are set |
| `ADMIN_PASSWORD` | Owner signs in with a password (used if neither Access nor `OWNER_EMAIL` is configured) |
| `RESEND_API_KEY` + `EMAIL_FROM` | Send email through Resend: sign-in codes and per-guest invites. `EMAIL_FROM` is `you@example.com` or `Name <you@example.com>` on a domain verified in Resend |
| `CF_TURN_KEY_ID` + `CF_TURN_API_TOKEN` | Relay via Cloudflare Realtime TURN |
| `TURN_URLS` + `TURN_SECRET` | Relay via your own coturn (`use-auth-secret`) |
| `TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL` | Relay with static credentials |
| `TURN_TTL_SECONDS` | Lifetime of TURN credentials (default 4 hours, never longer than the invite they were issued for) |
| `STUN_URLS` | STUN servers for browsers. Default: `stun:stun.cloudflare.com:3478` only. The Docker setup uses your own coturn instead |
| `OPEN_MODE` | Set to `1` to run an open server on purpose (anyone can create rooms) even though other settings are present |
| `OPEN_MODE_TURN` | Open mode only: set to `1` to give TURN relay credentials to anyone. Off by default, so a public open-mode server can't be used as a free relay |
| `ALLOWED_ORIGIN` | Comma-separated origins allowed to connect and call the API cross-origin (default: same origin only, on every backend) |
| `DEBUG_LOGS` | Set to `1` to log room activity. Off by default |
| `PORT` | Node only: listen port (default 3001) |

Open mode needs either **nothing** configured (no `SECRET_KEY`, `ADMIN_PASSWORD`, `OWNER_EMAIL` or `CF_ACCESS_*`, as in local development) or an explicit `OPEN_MODE=1`. Owner sign-in precedence is Cloudflare Access, then `OWNER_EMAIL`, then `ADMIN_PASSWORD`. Anything in between, such as `SECRET_KEY` without an owner sign-in, an empty or short (<10 characters) password, only one Access value, `OWNER_EMAIL` without both Resend settings, only one of `RESEND_API_KEY`/`EMAIL_FROM`, or a malformed `OWNER_EMAIL`/`EMAIL_FROM`, is a configuration error: the server refuses to run open, logs the problem at startup, and only tells browsers `misconfigured: true`. A typo can't make a private server public. Empty values count as unset.

## Privacy and security

- Call content (audio, video, screen, chat, files) is encrypted between browsers. Servers and relays only ever see encrypted packets.
- Nothing is stored: rooms live in memory only while someone's in them (on Cloudflare, in the open WebSockets' attachments, not in Durable Object storage), and invite links are self-contained signed tokens with an expiry.
- No logs by default: the app doesn't log room codes, names or IP addresses, Workers Logs are off, coturn logging is off, Caddy discards all its logs, and Docker keeps no container logs.
- The signaling server does see some things while a call is set up: room ids, display names, IP addresses and network candidates, and the **room password in plain text** (over TLS) when a guest types it, because that's how it checks it. It keeps none of this after the room empties.
- Whoever runs the server (you, and Cloudflare if you use it, since it terminates TLS) can see that connection metadata, but never call content.
- With email set up, invite emails (link, room key and code) and sign-in codes pass through your server, Resend and the mail providers on both ends. The server never logs addresses, codes or tokens.
- Browsers contact a STUN server to learn their public address: `stun.cloudflare.com` by default, your own coturn with Docker, or whatever `STUN_URLS` says.

See [DOCS.md](DOCS.md) for the full security model and how it works under the hood.

## Project structure

```
vchat/
├── apps/web/                    SvelteKit frontend (static SPA; owner dashboard at /admin)
├── apps/cloudflare/             Cloudflare Worker + Durable Object
├── apps/desktop/                Experimental Tauri desktop shell
├── packages/signaling-server/
│   ├── src/core/                Shared logic: rooms, invites, sign-in, relay credentials, HTTP API
│   └── src/index.ts             Node.js server (local dev + Docker)
├── deploy.sh                    Interactive server deployment
├── docker-compose.yml           Containers (Caddy, signaling, coturn)
├── Caddyfile                    Reverse proxy + TLS
└── turnserver.conf.template     coturn config template
```

## License

[MIT](LICENSE)

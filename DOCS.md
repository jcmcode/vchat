# vchat: Technical Documentation

1. [How a call works](#how-a-call-works)
2. [Access model: owner, invites, open mode](#access-model)
3. [Architecture](#architecture)
4. [Signaling protocol](#signaling-protocol)
5. [Reconnection](#reconnection)
6. [Security and privacy model](#security-and-privacy-model)
7. [Debugging with logs](#debugging-with-logs)
8. [Known limitations](#known-limitations)
9. [Desktop app](#desktop-app)

---

## How a call works

```
1. CREATE    The owner signs in at /admin and creates a room. The server returns two signed
             tokens: a host link (kept by the owner) and an invite link (sent to guests).

2. JOIN      Bob opens the invite link /room/<id>#invite=<token>&k=<room key>. The fragment is
             moved into the tab's storage and stripped from the address bar before any network
             request (it never reaches a server or the history). The browser fetches
             /api/ice-servers (the token unlocks TURN credentials), opens /ws?room=<id> and
             sends join with the token. If the room has a password he's asked for it. If the
             invite requires approval he waits until the owner lets him in. If the owner hasn't
             arrived yet, he's told so and admitted when they do.

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

## Access model

vchat runs in one of two modes, decided by configuration:

| | Private mode | Open mode |
|---|---|---|
| Enabled by | `SECRET_KEY` + (`CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`, `OWNER_EMAIL` + Resend, or `ADMIN_PASSWORD`) | Nothing configured at all, or `OPEN_MODE=1` |
| Who creates rooms | Only the signed-in owner (`/admin`) | Anyone, from the home page |
| Who can join | Holders of a valid invite link (plus password / approval if set) | Anyone with the room code (plus password / approval) |
| TURN credentials | Only with a valid invite/host token or owner session | Nobody, unless `OPEN_MODE_TURN=1` |

Any other combination (for example `SECRET_KEY` without an owner sign-in, or an empty `ADMIN_PASSWORD`) is a configuration error: the server stays closed, logs the reason at startup, and `/api/config` only says `misconfigured: true`.

**Owner sign-in.** With Cloudflare Access, Access protects `/admin` and `/api/admin` at the edge, and the server independently verifies the `Cf-Access-Jwt-Assertion` JWT (RS256, team certs, audience, issuer, expiry). With `ADMIN_PASSWORD`, `/api/admin/login` sets an `HttpOnly; Secure; SameSite=Strict` session cookie (a signed token, valid 7 days). Logins are throttled: 10 attempts per IP address (IPv6: per /64) per 15 minutes, and above 100 attempts per window across all clients, checks are queued 2 seconds apart. That slows a distributed guesser to a crawl without locking the owner out for the whole window. State-changing requests must come from the same origin. The session cookie is tied to the current password with `HMAC(SECRET_KEY, password)`, so changing `ADMIN_PASSWORD` signs everyone out.

**Email sign-in** (`OWNER_EMAIL`, sent through Resend; precedence is Access > email > password). `POST /api/admin/login/code {email}` always answers `200 {challenge}` for any well-formed address. Only if it is the owner's (trimmed, case-insensitive) is a code emailed, in the background so the response time is the same. The challenge is a signed token (`role: 'login'`, 10-minute expiry) holding a random nonce and `HMAC(SECRET_KEY, nonce + owner address + code)`. For any other address that MAC is random, so the challenge can never verify. The code is 6 crypto-random digits (rejection sampling, no bias). `POST /api/admin/login/verify {challenge, code}` compares in constant time and sets the same session cookie as password sign-in, tied to `HMAC(SECRET_KEY, owner address)` so changing `OWNER_EMAIL` signs sessions out. Limits, in memory and best effort: the login throttle above applies to both endpoints; at most 5 tries per challenge, and a challenge works once; 5 code requests per address per 15 minutes, and 5 codes sent in total per 15 minutes. These caps answer the same way for every address, so the endpoint doesn't reveal which one is the owner's. A `login` token is accepted nowhere else (not as a session, invite, host or ICE token).

**Emailed invites** (private mode with `RESEND_API_KEY` + `EMAIL_FROM`, whatever the sign-in method; `/api/config` shows `emailInvites: true`). The owner posts a room's guest token, a guest address and optionally the room key. The server checks the token, then mints a new guest token with the same room, expiry, approval and label, plus `to: <address>` and a fresh 6-digit code as that token's password (replacing any room password). It emails the guest the link (`/room/<id>#invite=<token>&k=<key>`) and the code, and returns neither. The guest needs both. Code guesses fall under the room-password limits below. When the guest waits for approval, the host's `admission-request` includes `email`, taken from the signed token. Invite emails are capped at 30 per hour per process/isolate.

**Invites are stateless.** A token is `base64url(payload).HMAC-SHA256(SECRET_KEY)`, decoded strictly (canonical unpadded base64url only, so a token has exactly one valid spelling). The payload holds the role (`host`/`guest`), room id, expiry, whether approval is needed, an optional label, an optional room-password hash keyed with `SECRET_KEY` (so the password can't be brute-forced offline from a link), and for emailed invites the address it was sent to (`to`, readable by whoever holds the link). The server stores nothing about rooms or invites. Rotating `SECRET_KEY` revokes every link at once.

**Host powers.** Only a host-role peer (the owner) can approve, deny or remove guests. A denied guest can't ask again for 5 minutes; a removed participant is disconnected and their peer id and tab secret (and, for an emailed invite, that invite's address) are refused for the rest of the room's life. Because a removed person still holds the invite link, every new guest after a removal has to be approved by the host, even on an invite that doesn't normally ask for approval. If the owner leaves, guests keep talking but nobody can admit newcomers until the owner returns. Invited guests are never promoted to host, and can never take over an identity (peer id) already admitted to the room, even one that's offline. The owner can always get in: one seat over the 6-person limit if guests filled the room.

### What the server sees

| Sees | Never sees |
|---|---|
| Room codes, display names, who is in which room, IP addresses | Audio, video, screen shares |
| SDP and ICE candidates (network addresses) | Chat messages, reactions, files |
| The room password in plain text (over TLS) when a guest enters it, to check it. Private mode compares it with the keyed hash in the invite; open mode keeps a per-room salted SHA-256 hash in memory | The room key in the invite link's `#fragment` |
| With email set up: the owner's address, guests' addresses (only while sending the invite and, from the signed token, while they wait), and the codes as they're generated and checked. None of it is stored or logged | |
| | Anything after the room empties: no logs, and no storage beyond the live room |

On Cloudflare, Cloudflare terminates TLS, so it sees the same signaling traffic and IP addresses as the Worker does. TURN servers only relay already-encrypted packets. Browsers also contact a STUN server to learn their public address: `stun:stun.cloudflare.com:3478` by default, your own coturn in the Docker setup (`STUN_URLS=stun:<domain>:3478`), or whatever `STUN_URLS` lists. The web app has no third-party fallback.

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
| `protocol.ts` | Message types, validation, limits (6 peers, 10 waiting, 10-min admission timeout, 64KB messages, 32KB signals), name cleaning |
| `room.ts` | `Room<C>`: create/join/admit/deny/remove/leave/signal, host hand-off, rejoin secrets, deny-lists |
| `ice.ts` | Builds ICE server lists: Cloudflare TURN API, coturn REST credentials, or static |
| `throttle.ts` | Sign-in and room-password throttles (in memory, entries dropped after their window) |
| `rate-limit.ts` | Per-connection token bucket |

The Node server (`src/index.ts`) keeps a `Map<roomId, Room>` in memory. The Cloudflare backend (`apps/cloudflare/src/room.ts`) runs one `Room` per Durable Object, using the WebSocket Hibernation API. It writes **nothing** to Durable Object storage (SQLite-backed storage keeps 30 days of point-in-time recovery): per-connection state and a copy of the room metadata (with a version counter) live in every open socket's attachment, so they survive hibernation and disappear with the last socket. Leftover storage from older versions is deleted on wake. Only alarms are used, for waiting-room timeouts and closing idle sockets. Keepalive pings are answered by the runtime without waking the object.

### Frontend (`apps/web`)

| File | Purpose |
|---|---|
| `lib/signaling/client.ts` | WebSocket client: keepalive pings, exponential-backoff reconnect, automatic re-entry |
| `lib/webrtc/mesh.ts` | Peer connections, session ids, glare handling, ICE recovery, data-channel messages |
| `lib/webrtc/file-transfer.ts` | Chunked, acknowledged, per-recipient file transfer (50MB max) |
| `lib/media/manager.ts` | Camera/mic/screen capture, device switching, audio-only fallback |
| `lib/stores/room.ts` | Endpoints, ICE fetch, per-tab identity, preferences |
| `lib/webrtc/conn-stats.ts`, `conn-quality.ts` | Connection quality: polls `getStats()`, classifies each link as good / fair / poor |
| `lib/ui/pip.ts`, `PipView.svelte`, `pip-target.ts` | Picture-in-picture: a Document Picture-in-Picture window, or standard video picture-in-picture |

The app is a static SPA (SvelteKit + adapter-static). Its Content-Security-Policy is emitted as a `<meta>` tag with a hash for SvelteKit's boot script (`svelte.config.js`), so it works on any host.

---

## Collaboration features

Everything below travels over the WebRTC **data channels** between browsers. It's end-to-end encrypted like the media, and the signaling server never sees it. Each feature registers its own message type with `registerDataHandler()` in `lib/webrtc/mesh.ts`, and can react to `onPeerConnected` / `onPeerLeft` / `onRoomLeft`.

| Feature | Module | Message types |
|---|---|---|
| Chat and private messages | `mesh.ts`, `ChatPanel.svelte` | `chat` (a private message is sent only to its recipient's channel, with `private: true`), `typing` (private: recipient only) |
| Mic/camera state | `mesh.ts` | `media-state { audio, video }`, sent on change and to newcomers |
| Screen-share state | `mesh.ts` | `screen-state { sharing }`, which puts the presenter's screen on the stage |
| Screen annotations | `lib/collab/annotations.ts`, `AnnotationLayer.svelte` | `annot` with `pointer` / `pointer-off` / `stroke` / `remove` / `clear`, scoped by `screen` (the presenter's peer id) |
| Whiteboard | `lib/collab/whiteboard.ts`, `Whiteboard.svelte`, `whiteboard/TextEditor.svelte` | `wb` with `stroke` / `update` / `remove` / `clear` / `opened` / `sync-req` / `sync` |
| Room name | `lib/collab/room-meta.ts` | `room-name`, accepted only from the current host |

**Drawing model** (`lib/collab/strokes.ts`, pure and unit-tested). A stroke is a flat list of integer points. The model supports two coordinate spaces, and every message is validated by `sanitizeStroke(raw, author, space)` for the space it belongs to:

- `NORMALIZED` (screen annotations): points are normalized to the shared video's content (0..1, sent as integers 0..10000, letterboxing ignored), and widths are fractions of the surface width. Annotations never accept text items.
- `WORLD` (whiteboard): an unbounded canvas in integer world units (1 unit = 1 CSS pixel at 100% zoom), clamped to ±1,000,000. Widths are in world units.

A stroke streams while it's drawn: new points are flushed every 40ms by `StrokeSender`. Only the author can extend a stroke, and a sync can't rewrite someone else's. Erased or cleared ids are remembered ("tombstones") so a late sync or edit can't bring them back. Each board is capped at 3,000 items, 600,000 points (10,000 per stroke) and 400,000 characters of text, and anything beyond that is ignored.

**Infinite canvas.** Each participant pans and zooms their own view (10%–400%), and views are never synced. Pan with the scroll wheel or two-finger scroll, the Hand tool (H), Space+drag, the middle mouse button, or two fingers on touch. Zoom with Ctrl/Cmd+scroll, trackpad or touch pinch, the zoom buttons, `+`/`-`, `0` (100%) and `1` (fit to content). On touch, one finger uses the current tool. Only one pointer draws at a time, so a resting palm or a second finger never takes over a stroke. A second finger within 250ms turns the touch into a pinch (and drops the just-started stroke). The pen's width is set in screen pixels when you draw, so it feels the same at any zoom. Other shortcuts: P pen, M highlighter, T text, E eraser, Ctrl/Cmd+Z undo your last item.

**Text boxes** (`lib/collab/richtext.ts`). Text is stored and sent as plain text with markdown-like markers: `**bold**`, `_italic_`, `__underline__`, lines starting with `- ` (bullet) or `1. ` (numbered), and `\` to escape a marker. It's edited in a textarea with a small format bar (B/I/U, lists, sizes S/M/L/XL, color, a move handle and a width handle). Enter adds a line and continues lists. Escape or clicking outside finishes. Double-click or double-tap any box to edit it. The canvas renders the formatted, word-wrapped result. Peer text is never put into HTML. `cleanText` strips control, bidi and zero-width characters and lone surrogates, and caps the text at 4,000 characters.

Anyone in the call may edit any text box (strokes stay author-only). A box is created with a `stroke` message (`text`, `boxWidth`, font size in `width`, version 0). Edits send `update { item: { id, v, text, color, size, boxWidth, x, y } }` with the whole box state. Receivers apply it with last-writer-wins: a higher `v` wins, and equal versions are broken by the editor's peer id, which is always the sender and never taken from the message. Updates can't create boxes, can't touch erased ids, can't jump more than 10,000 versions, are rate-limited per peer (15/s, burst 30), and count toward the text budget. The editor saves at most every 150ms. While you edit, a newer remote version replaces your text only if you have no unsent changes. Otherwise your next save wins.

**Late joiners.** When a peer's data channel opens, everyone with board content sends it a `sync` in batches under about 48KB. Synced text boxes merge by version. Opening the board also sends a `sync-req`, which each peer answers at most once every 5s per requester.

**Export** (`lib/collab/export.ts`, nothing is uploaded). The board is rendered on a white background, cropped to the content bounds plus 48 units of padding, at up to 2 pixels per unit and at most 4096px on the longest side.

- **PNG** saves that image.
- **PDF** is a single page with the image (a small built-in PDF writer).
- **DOCX** (`docx.ts` + `zip.ts`, no libraries) contains a title ("Whiteboard — date"), the board image inline, then every text box as editable paragraphs in reading order (top-to-bottom, then left-to-right). Bold, italic and underline runs, colors, bullets and numbered lists (`word/numbering.xml`, each list restarting at its own first number) are kept. The ZIP is written uncompressed with real CRC-32s.

## Picture-in-picture

The **Pop out** button (`lib/ui/pip.ts`) keeps the call in view while you're in another tab or app, for example while presenting.

- **Chromium on desktop** (Document Picture-in-Picture API): a small always-on-top window shows everyone (video, or their initial when the camera is off, with name, muted and speaking indicators) and mic, camera and leave buttons that call the same handlers as the main controls. `PipView.svelte` is mounted into that window's document by the main page and reads the same stores, so it follows people joining and leaving and tracks changing. Its videos are muted: the sound keeps playing from the main window.
- **Safari and Chromium on Android** (standard picture-in-picture): one video, chosen by `pip-target.ts`: a shared screen, else the active speaker, else whoever is shown already, else the first person with video. It plays in a hidden, muted video element of the app's own, so the picture can follow the conversation (at most one switch every 3 seconds) without another click. That element only exists, and only plays, from the click until picture-in-picture closes.
- **Firefox** has neither API, so the button is hidden.

The window closes when you leave the call or are removed or replaced. Closing it leaves the call as it was.

The pop-out window stays on top of other apps, so it shows up in anything that captures your whole screen, such as sharing your entire screen in vchat or another app: whoever watches that share sees the participants' faces and names. Close it first, or share a single window or tab instead.

The PiP window is a blank same-origin document (opened like a blank popup, which in Chromium inherits the page's CSP). No script is loaded into it or runs in it, and nothing is fetched into it: the main page builds its DOM through Svelte with DOM APIs, so peer names are only ever text. The app's own CSS is copied in as a constructed stylesheet (`adoptedStyleSheets`), which CSP doesn't restrict, so the Content-Security-Policy stays as it is. Both modes only show streams from connections that passed the trust gate (`stream` is set only once a connection is verified or allowed), so an unverified person appears as their initial.

## Connection quality

Every 2.5 seconds `lib/webrtc/conn-stats.ts` reads `getStats()` for each open connection that passed the trust gate (verified, or allowed by you). One timer serves all of them; it stops when there are none and skips while the tab is hidden. A `getStats()` that hasn't answered within 2 seconds is skipped for that round. `conn-quality.ts` (pure, unit-tested) turns each report into:

| Metric | Source |
|---|---|
| Round trip | The selected candidate pair's `currentRoundTripTime` (Firefox: the RTCP round trip of outgoing streams) |
| Packet loss in | `inbound-rtp`: lost / (received + lost), from the change since the previous sample |
| Packet loss out | `remote-inbound-rtp` `packetsLost` (what they report) against our `outbound-rtp` `packetsSent`, both as changes |
| Jitter | Audio `jitter` in both directions (`inbound-rtp`, `remote-inbound-rtp`), the worse one |
| Route | Relayed if either end of the selected pair is a `relay` (TURN) candidate, otherwise direct |
| Upload estimate | The pair's `availableOutgoingBitrate` (Chromium only) |
| Receiving | The largest incoming video's size and frame rate |

Loss needs at least 20 packets in the interval. Counters that go backwards (a new connection or SSRC after a restart) or samples more than 10 seconds apart start a fresh baseline instead of producing a figure (after such a gap the smoothing history starts over too). Some figures come from the other side's RTCP receiver reports, so a participant can make their own link look bad: jitter above 1 second and round trips above 10 seconds are ignored, and reported loss is capped at what we actually sent. A sample is graded by its worst metric: round trip up to 250 ms is good and up to 500 ms fair; loss (the worse direction) up to 2% good and up to 8% fair; jitter up to 30 ms good and up to 80 ms fair; anything above is poor. While you send video, an upload estimate under 150 kbit/s makes it at best fair. What's shown is the median of the last three samples, so one odd sample doesn't flip it.

Remote tiles show signal bars and tapping a person shows the details. For a connection that's allowed but not verified, the details are marked "not verified" and the route isn't shown (with someone in the middle, "direct" would mean direct to them). A one-line hint says "Your connection is poor" only when at least two connections were measured and more than half of them are poor; with a single measured connection, a poor one is shown as "Connection to *name* is poor", so one participant's bad network (or reports) never tells you that yours is the problem.

## Signaling protocol

JSON over WebSocket. The client connects to `/ws?room=<roomId>` (the Node server ignores the query; Cloudflare uses it to pick the Durable Object).

**Client → server**

| Message | Fields |
|---|---|
| `create-room` | `roomId`, `peerId`, `displayName`, `secret`, `password?` (open mode only) |
| `join` | `roomId`, `peerId`, `displayName`, `secret`, `password?`, `token?` (required in private mode) |
| `admit-peer` / `deny-peer` | `peerId` (host only). A denied guest can't ask again for 5 minutes |
| `remove-peer` | `peerId` (host only): removes a participant or waiting guest for the rest of the room's life |
| `signal` | `targetPeerId`, `signal` (opaque, at most 32KB serialized; the client sends `{ sid, data }`) |
| `leave` | — |
| `ping` | — (answered with `pong`) |

**Server → client**

| Message | Fields |
|---|---|
| `room-created` | `roomId` |
| `room-peers` | `peers[{ id, displayName }]`, `roomId`: you're in |
| `peer-joined` / `peer-left` | `peerId`, `displayName` |
| `host-changed` | `hostPeerId` (null when the owner is away in private mode) |
| `password-required` | `roomId`, `invalid` (true if a wrong password was sent) |
| `waiting-for-admission` | `roomId`, `hostPresent` |
| `admission-request` / `admission-cancelled` | `peerId`, `displayName?`, `email?` (to host; `email` only for emailed invites, from the signed token) |
| `admission-granted` / `admission-denied` | `roomId`, `reason?` |
| `removed` | `roomId`, `reason`: the host removed you; the socket is then closed with `4002` |
| `signal` | `fromPeerId`, `signal` |
| `error` | `message` |

**HTTP** (`packages/signaling-server/src/core/api.ts`, shared by both backends):

| Endpoint | Purpose |
|---|---|
| `GET /api/config` | `{ mode, auth, misconfigured, emailInvites }`: open or private, how the owner signs in (`access`, `email`, `password` or null), whether the server is misconfigured (details are only in the server's startup log), and whether the owner can email invites |
| `GET /api/ice-servers` | `{ iceServers, ttl? }`. Private mode needs an `X-Vchat-Token` header (invite or host token) or owner session. `ttl` is in seconds: 4h by default, never past the token's expiry |
| `GET /api/admin/session` | `{ mode, auth, misconfigured, authenticated, email }` |
| `POST /api/admin/login` / `logout` | Password sign-in (only when `ADMIN_PASSWORD` is the method) |
| `POST /api/admin/login/code` | Email sign-in: `{ email }` → `200 { challenge }` for every well-formed address (400 if malformed, 429 + `Retry-After` over a cap, 404 unless email sign-in is the method) |
| `POST /api/admin/login/verify` | Email sign-in: `{ challenge, code }` → `200 { ok: true }` + session cookie, or `401 { error: 'Wrong or expired code' }` |
| `POST /api/admin/rooms` | Owner only: `{ label, password, approval, expiresInHours }` → `{ roomId, inviteToken, hostToken, expiresAt }` |
| `POST /api/admin/rooms/email-invite` | Owner only: `{ roomId, inviteToken, email, key? }` → `200 { ok: true, expiresAt }`. Never returns the token or code. 400 bad input or invite, 401 not signed in, 503 email not configured, 429 over the cap, 502 if sending failed |
| `GET /healthz` | `ok` |

Close codes (clients must not reconnect automatically after 4000, 4002 or 4003):

| Code | Meaning |
|---|---|
| `4000` | Replaced: the same identity connected again elsewhere |
| `4001` | Idle: the socket wasn't in a room for too long (60s) |
| `4002` | Removed by the host |
| `4003` | The invite is invalid or expired (sent after the `error` message) |

A socket is bound to the room it was authorized for at the upgrade (`/ws?room=`); joining another room on it is refused. In private mode the gate accepts an expired-but-genuine invite only within 24 hours of expiry, so the person can be told it expired. Cloudflare refuses more than 40 sockets per room.

---

## Reconnection

- **Signaling drops.** The client pings every 25s and reconnects with backoff when a pong is missed or the socket closes. Each tab has a random `secret` and a separate random peer identity per room (sessionStorage), so the server can't link one person's rooms. On rejoin, a peer whose `peerId` + `secret` were already admitted skips the password and waiting room, and replaces its stale socket if the server hasn't noticed it's dead. If the room emptied in the meantime, the client re-creates it.
- **Page refresh.** `peerId`, `secret`, the room password and "I created this room" are kept in sessionStorage for the tab, so a refresh rejoins seamlessly. Closing the tab forgets everything.
- **P2P drops.** ICE `failed` (or `disconnected` for 5s) triggers a new connection with a fresh session id. If both sides restart at once ("glare"), the peer with the smaller id wins. Retries are capped at 5 per minute per peer.

---

## Security and privacy model

- **Access.** Private mode: only the owner can create rooms. Guests need a signed, expiring invite, plus an optional password and owner approval. TURN credentials are only issued to invite/host holders, so strangers can't use your relay.
- **Rooms.** Unguessable 10-char codes (private) or 8-char codes (open). Room passwords are verified against a keyed hash in the invite (private) or a SHA-256 hash in memory (open).
- **TURN credentials.** Short-lived (4h by default, never past the invite's expiry): coturn uses a shared-secret HMAC (`use-auth-secret`) with a unique `<expiry>:<random>` username per response, and Cloudflare credentials come from its API (cached briefly per role and room). No TURN password is baked into the frontend. coturn has per-user and total quotas, a per-session and total bandwidth cap, and refuses to relay to private, special-purpose, NAT64/Teredo and cloud-metadata addresses or any address of the host itself.
- **Input validation.** All signaling messages are validated, size-limited (64KB; 32KB for a signal payload) and rate-limited per connection. WebSocket origins are checked. The Node server drops clients that stop reading (over 1MB queued).
- **Peer data.** Names shown in chat come from the server's validated list, not from what a peer claims over the data channel. SVG files aren't previewed inline.
- **Storage.** Chat is kept in memory only and never written to storage: it is gone when you leave, are removed, refresh or close the tab. The invite token, room key and per-room identity live in sessionStorage so a refresh can rejoin; they are cleared when you leave the call or are removed from it (if the tab is closed without leaving, the browser may keep them for its own "reopen closed tab" feature until the session ends). localStorage holds your display name, TURN preferences and, on the owner's own browser, the rooms they created (including their host links and room keys, which grant host access until they expire). Expired rooms are pruned and the list is cleared on sign-out. Don't use the owner dashboard on a shared computer.
- **Untrusted peers.** Everything received over data channels is size- and rate-limited per participant. Files are capped (3 at a time, 150MB total per sender, 50 files / 300MB per peer per call) and checked chunk by chunk, with a 60s stall timeout. Received images are previewed only after a header check (at most 16 megapixels). Whiteboard and annotation data is capped (3,000 strokes / 600k points). Nobody can rewrite someone else's strokes or file entries. Names are made unique (compared after folding case, accents, compatibility forms and common look-alike letters) and stripped of invisible/bidi characters.
- **Connection statistics.** Connection quality is computed in the browser from `getStats()`, for trusted connections only, and only shown there: it's never sent to the server or to other participants, never stored, and dropped when someone leaves or the call ends. Candidate statistics include IP addresses; only the candidate type (relay or not) is read.
- **Hide my IP address.** An optional pre-join setting makes the browser use only the TURN relay (`iceTransportPolicy: relay`), so other participants see the relay's address instead of yours. It needs TURN to be configured.
- **Server hardening.** In private mode a WebSocket is only accepted with a valid invite or host token, sent as a subprotocol so it never appears in URLs. Invite links carry the token after `#`, which browsers never send to servers. Owner logins are throttled (see above). Room-password guesses are limited to 10 per room and client per 10 minutes, with a backstop of 200 per room; on Cloudflare the client is identified by an HMAC of its IP keyed with `SECRET_KEY`, never the raw address. These throttles live in memory (per process, or per Durable Object/isolate on Cloudflare) and forget clients once their window passes. Configuration fails closed.
- **No logs.** Room activity is only logged with `DEBUG_LOGS=1`. Workers Logs are disabled in `wrangler.jsonc`. In the Docker setup, Caddy discards all logs (its error log would otherwise include IPs and the token header), coturn's logging is off, and every container uses Docker's `none` logging driver.

### End-to-end verification

WebRTC encrypts everything between browsers (DTLS-SRTP), but the DTLS fingerprints that anchor that encryption are exchanged through the signaling server, so a compromised server could in principle sit in the middle. vchat closes that gap with a room key the server never sees (`lib/webrtc/e2e-proof.ts`, `e2e.ts`, `mesh.ts`):

- **Room key.** 256 random bits generated in the creator's browser. It only ever travels in the link's `#fragment` (`#invite=<token>&k=<key>`, or `#k=<key>` in open mode), which is stripped from the address bar before any network request. A pasted invite is kept in tab storage and opened without the fragment, so the key never lands in browser history. Old `?invite=` links are no longer accepted.
- **One pinned transport per connection.** Every connection uses max-bundle + rtcp-mux, so there's exactly one DTLS transport. Session descriptions are parsed strictly: exactly one SHA-256 fingerprint, every active m-section bundled, one ICE username fragment. Fingerprint and ufrag are pinned, and any change on renegotiation blocks the connection. Fingerprints are also cross-checked against the certificates reported by `getStats()`.
- **Trust gate.** Nothing flows until a connection is verified: your camera and microphone senders are held empty, received media isn't shown, and only verification messages cross the data channel.
- **Proof.** Each side sends an HMAC (key derived from the room key with HKDF) over the protocol version, room id, session id, both peer ids, both fingerprints and the sender's display name, as *it* sees them. An interceptor shows each side a different fingerprint and doesn't know the key, so the proofs can't match. A valid proof marks the connection **verified**, and the name shown for that person is authenticated. A wrong proof or mismatched details **blocks** the connection, with a warning. No proof (the peer doesn't have the key, e.g. typed the room code) or no answer within 20 seconds marks it **unverified**: it stays blocked unless you click "Allow anyway".
- **Safety codes.** Tap a person to see a 12-digit code for your connection with them. Comparing it out loud detects even someone in the middle who has the room key.

Covered by `apps/web/src/lib/webrtc/e2e.test.ts`, including a simulated man-in-the-middle.

What this doesn't cover: the server serves the web app's JavaScript, so a malicious server operator could serve modified code, as with any web app. Code you build and bundle yourself (the desktop app, once it can target a server) is the strongest option. Joining without the room key still gives you encryption, but no verification.

---

## Debugging with logs

Logging is off everywhere by default. To investigate a problem on a Docker deployment, turn it on temporarily and turn it off again afterwards:

1. In `docker-compose.yml`, remove the `logging: driver: none` lines from the service you're debugging (or set `driver: json-file`). For room activity from the signaling server, also add `- DEBUG_LOGS=1` to its `environment`.
2. For Caddy's error log, remove the global `log default { output discard }` block at the top of `Caddyfile`.
3. `docker compose up -d --build`, reproduce the problem, and read `docker compose logs <service>`.
4. Restore the files and run `docker compose up -d --build` again. `docker compose down && docker compose up -d` (or `sudo bash deploy.sh`) recreates the containers, which deletes the logs Docker kept.

These logs can contain IP addresses, room ids, names and (in Caddy's error log) invite tokens, so keep the window short. On Cloudflare, `npx wrangler tail` shows live output without storing it (set `DEBUG_LOGS=1` as a variable for room activity).

---

## Known limitations

- Mesh topology: upload bandwidth grows with each participant, so 6 is the practical cap.
- Screen sharing replaces your camera feed. In audio-only mode there's no video track to swap, so remote peers won't see your screen.
- Switching microphones while sharing screen audio drops the screen audio until you re-share.
- Firefox doesn't support choosing the speaker output on all platforms (`setSinkId`).
- The pop-out window with everyone in it needs Chromium on desktop (Document Picture-in-Picture). Safari and Chromium on Android pop out a single video, and Firefox has no web API for picture-in-picture, so the button is hidden there.

---

## Desktop app

`apps/desktop` is an experimental [Tauri v2](https://tauri.app) shell around the web app. It needs Rust and app icons:

```bash
pnpm --filter @vchat/desktop exec tauri icon path/to/icon.png   # generates src-tauri/icons
pnpm desktop:dev
```

The web app always talks to the server it was loaded from; there's no custom-server setting in the UI. So for now the desktop shell is only useful in development (`pnpm desktop:dev` loads the dev server). A packaged build can't yet be pointed at your own server.

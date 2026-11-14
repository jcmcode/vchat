# vchat: Technical Documentation

1. [How a call works](#how-a-call-works)
2. [Access model: owner, invites, open mode](#access-model)
3. [Architecture](#architecture)
4. [Signaling protocol](#signaling-protocol)
5. [Reconnection](#reconnection)
6. [Security and privacy model](#security-and-privacy-model)
7. [TURN over TLS on port 443 (Docker)](#turn-over-tls-on-port-443-docker)
8. [Debugging with logs](#debugging-with-logs)
9. [Updating pinned images](#updating-pinned-images)
10. [Known limitations](#known-limitations)
11. [Desktop app](#desktop-app)

---

## How a call works

```
1. CREATE    The owner signs in at /admin and creates a room. The server returns two signed
             tokens: a host link (kept by the owner) and an invite link (sent to guests).

2. JOIN      Bob opens the invite link /room/<id>#invite=<token>&k=<room key>. The fragment is
             moved into the tab's storage and stripped from the address bar before any network
             request (it never reaches a server or the history). On the pre-join screen he
             types his name, picks camera & mic, audio only or chat only, and can check his
             camera, microphone and speaker. Then the browser fetches
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
             The host can also end the call for everyone at once.
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

**Emailed invites** (private mode with `RESEND_API_KEY` + `EMAIL_FROM`, whatever the sign-in method; `/api/config` shows `emailInvites: true`). The owner posts a room's guest token, 1 to 20 guest addresses (trimmed, lowercased, deduplicated) and optionally the room key. The server checks the token, then for each address mints a new guest token with the same room, expiry and label, plus `to: <address>`, and emails it in a separate message, so recipients never see each other's addresses. It returns which addresses were sent, which failed and why, and never a token or code.

- **With a passcode** (the default), each guest also gets their own fresh 6-digit code as that token's password (replacing any room password), and the token keeps the room's approval setting. The guest needs both the link and the code. Code guesses fall under the room-password limits below.
- **Without a passcode** (`passcode: false`), the token has no password at all, and approval is forced on: the guest enters their name and waits in the lobby until the owner admits them, even if the owner hasn't arrived yet.

**Message.** An optional `message` (a short note about the call) is cleaned like names (control, bidi and zero-width characters removed), keeps its line breaks (at most one blank line in a row), is trimmed and cut to 500 code points (longer is truncated, not refused). The email shows it under the "You're invited to …" line as "Message from the host:", HTML-escaped with line breaks as `<br>`; the calendar description shows it above the join line, RFC 5545-escaped. It is never logged or stored.

The link is `/room/<id>#invite=<token>&k=<key>`. When the guest waits for approval, the host's `admission-request` includes `email`, taken from the signed token. Invite emails are capped at 30 per hour per process/isolate, counting each recipient; a request that hits the cap stops there and reports the rest as `rate-limited`.

**Calendar invites.** With a `schedule` (`startsAt` in ms, from a day ago to 400 days ahead; `durationMinutes` a whole number from 5 to 1440), each email shows the time in UTC and carries `invite.ics`: an RFC 5545 `METHOD:REQUEST` event for that one attendee (CRLF line endings, escaped text, lines folded at 75 octets), with the join link as the URL and location, the sender from `EMAIL_FROM` as organizer, and a reminder 10 minutes before. The description holds the host's message (if any), then `Join: <link>`, then `Passcode: <code>` for invites with a passcode. The calendar file therefore **contains the join link, including the room key if one was sent, and the guest's passcode**, and calendar apps sync it to their providers (Google, Apple, Microsoft and so on), where it can stay long after the call. This is a deliberate choice, so the guest finds everything in the event; invites with `passcode: false` have no code anywhere. An invalid schedule is dropped (the invite still goes out, with the warning `schedule-ignored`); a meeting that ends after the invite expires is sent anyway, with the warning `meeting-ends-after-invite-expires`.

**Checking a code before joining.** `POST /api/invite/check {roomId, token, code}` lets the join page ask for the passcode (or a room password) first, then the name. It verifies the guest token, answers `required: false` if the token has no password, and otherwise compares the code with the same keyed hash as joining, under the same room-password throttle (same room + client key, and a correct answer is refunded the same way). Checking therefore gives no extra guesses, and it grants nothing: joining checks the code again. On Cloudflare the comparison runs inside the room's Durable Object, where joins for that room are throttled; the Worker forwards the request there with the HMAC'd client id it also gives WebSocket connections.

**Invites are stateless.** A token is `base64url(payload).HMAC-SHA256(SECRET_KEY)`, decoded strictly (canonical unpadded base64url only, so a token has exactly one valid spelling). The payload holds the role (`host`/`guest`), room id, expiry, whether approval is needed, an optional label, an optional room-password hash keyed with `SECRET_KEY` (so the password can't be brute-forced offline from a link), and for emailed invites the address it was sent to (`to`, readable by whoever holds the link). The server stores nothing about rooms or invites. Rotating `SECRET_KEY` revokes every link at once.

**Host powers.** Only a host-role peer (the owner) can approve, deny or remove guests, lock the room and end the call (the server enforces this). In open mode the host is whoever created the room. If they drop out, the next participant holds the role (and these powers) until the creator comes back with the same peer id and tab secret (a reconnect or a refresh), which gives it straight back; the stand-in can't remove the creator. The creator's identity is part of the room's in-memory metadata, so it survives Cloudflare hibernation. Open mode has no owner, though: while the creator is away, the stand-in can end the call, and then create the same room code again under its own password. A denied guest can't ask again for 5 minutes; a removed participant is disconnected and their peer id and tab secret (and, for an emailed invite, that invite's address, kept as a keyed hash) are refused for the rest of the room's life. Because a removed person still holds the invite link, every new guest after a removal has to be approved by the host, even on an invite that doesn't normally ask for approval. If the owner leaves, guests keep talking but nobody can admit newcomers until the owner returns. Invited guests are never promoted to host, and can never take over an identity (peer id) already admitted to the room, even one that's offline. The owner can always get in: one seat over the 6-person limit if guests filled the room.

**Locking the call.** The host can lock the room during a call. While it's locked the server refuses every new join attempt, even with a valid invite and the right password or code: the person is told "This call is locked by the host" (`error` `Room is locked`, then close code `4005`), and isn't queued, so the host isn't asked. Their tab doesn't retry: it releases the camera and forgets the invite, and they open the link again once the host unlocks. Still let in: anyone already admitted reconnecting with their peer id and tab secret (a network drop or a refresh), the owner (host token) at any time, and guests who were already in the waiting room when the host locked. They stay queued and the host can still admit or deny them; one who re-enters (even on another invite that doesn't ask for approval) goes back to waiting, never straight in. A waiting guest whose connection drops completely counts as new and is refused. In open mode the room password is checked first, so only people who know it learn that the room is locked. The lock is part of the room's in-memory metadata (on Cloudflare, copied to every socket's attachment like the rest), so it survives hibernation. It stays on if the host leaves (fail closed; in private mode only the owner can unlock it). If the room empties while locked (an owner alone whose connection blips or who refreshes), the server remembers for 60 seconds, in memory, who was in it (peer id + hash of the tab secret): meanwhile the room stays locked to everyone else, those people and the owner get back in, the returning host is told it's locked, and in open mode only they can create the room again. After that, or after a server restart or deploy (nothing is stored, by design), the room comes back unlocked; the host's app notices on rejoining and locks it again. Unlocking or ending the call forgets it. Everyone in the call sees a "Locked" indicator.

**Ending the call.** The host can end the call for everyone (after a confirm step). Every participant and waiting guest receives `room-ended` and is disconnected with close code `4004`; clients don't reconnect, tear down their connections, forget the tab's rejoin data (as when leaving) and show "The host ended the call". The server drops the room's state and closes the room's other connections too (people at the password prompt, denied guests, someone mid-join), with close code `4006` and the generic "This call is no longer available"; they don't retry. For the next 60 seconds it remembers only the identities that were in the call (peer id + hash of the tab secret, for everyone present or admitted), so a tab that was offline at that moment and reconnects on its own is answered with `room-ended` instead of silently re-opening the call. A call that only ever had one identity (the host who ended it) leaves nothing to remember, and ending the same room again within the minute adds to what's remembered instead of replacing it. In open mode, creating rooms is limited to 30 per client (keyed hash of the address) per 10 minutes, so one client can't churn through rooms to push real calls out of this memory. That includes the owner's own devices: re-opening the room on purpose is a fresh join, and the app uses a new identity for it because it forgot the old one when the call ended. Anyone else is treated as if the room never existed, so a stranger learns nothing. This is memory only and best effort: at most 5,000 ended calls (50,000 identities) are remembered per process, or per isolate on Cloudflare, oldest dropped first. Otherwise the room is simply gone: opening the invite again starts a fresh room, exactly as if nobody had been in it (in private mode, guests on an approval invite wait for the owner; in open mode anyone with the code can create it again).

**Waiting-room alerts.** When someone new is waiting, the host's tab plays a short chime (synthesized with WebAudio, nothing fetched; at most one every 5 seconds) and, while the tab is hidden or unfocused, flashes its title with the count ("(1) Waiting to join · …") until the tab is back in front or the queue is empty. The host can also turn on system notifications in the host menu. The browser's permission prompt is only shown from that click, never on its own. The notification always says only "Someone is waiting to join your call" (operating systems keep notification history and show it on lock screens, so it never includes a guest's name or email, or the room's name). Clicking it focuses the tab. The on/off choice is kept in localStorage (`vchat_waiting_alerts`).

### What the server sees

| Sees | Never sees |
|---|---|
| Room codes, display names, who is in which room, IP addresses | Audio, video, screen shares |
| SDP and ICE candidates (network addresses) | Chat messages, reactions, files |
| The room password in plain text (over TLS) when a guest enters it, to check it. Private mode compares it with the keyed hash in the invite; open mode keeps a per-room salted SHA-256 hash in memory | The room key in the invite link's `#fragment` |
| With email set up: the owner's address, guests' addresses (only while sending the invite and, from the signed token, while they wait), and the codes and invite messages as they're generated, sent and checked. None of it is stored or logged. Calendar invites hold the link (and the key, if sent), the message, and the passcode for invites that have one; calendar apps sync them to their providers | |
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

In the Docker setup, browsers reach coturn on port 3478 (UDP and TCP) and, if the optional add-on is on, as TURN over TLS on port 443 through Caddy (see [TURN over TLS on port 443](#turn-over-tls-on-port-443-docker)).

### Shared core

All room logic lives in `packages/signaling-server/src/core/` and is transport-agnostic:

| File | Purpose |
|---|---|
| `protocol.ts` | Message types, validation, limits (6 peers, 10 waiting, 10-min admission timeout, 64KB messages, 32KB signals), name cleaning |
| `room.ts` | `Room<C>`: create/join/admit/deny/remove/leave/signal, lock/unlock, end for everyone, host hand-off, rejoin secrets, deny-lists |
| `ended.ts` | Who was in a room, for 60s after the room's state is gone (capped, oldest dropped): calls the host just ended (their reconnecting tabs are told it's over) and rooms that emptied while locked (they come back locked) |
| `ice.ts` | Builds ICE server lists: Cloudflare TURN API, coturn REST credentials, or static |
| `throttle.ts` | Sign-in and room-password throttles (in memory, entries dropped after their window) |
| `rate-limit.ts` | Per-connection token bucket |

The Node server (`src/index.ts`) keeps a `Map<roomId, Room>` in memory. The Cloudflare backend (`apps/cloudflare/src/room.ts`) runs one `Room` per Durable Object, using the WebSocket Hibernation API. It writes **nothing** to Durable Object storage (SQLite-backed storage keeps 30 days of point-in-time recovery): per-connection state and a copy of the room metadata (with a version counter) live in every open socket's attachment, so they survive hibernation and disappear with the last socket. Leftover storage from older versions is deleted on wake. Only alarms are used, for waiting-room timeouts and closing idle sockets. Keepalive pings are answered by the runtime without waking the object.

### Frontend (`apps/web`)

| File | Purpose |
|---|---|
| `lib/signaling/client.ts` | WebSocket client: keepalive pings, exponential-backoff reconnect, automatic re-entry |
| `lib/webrtc/mesh.ts` | Peer connections, session ids, glare handling, ICE recovery, data-channel messages |
| `lib/webrtc/media-slots.ts` | Which transceiver carries the microphone, camera and shared screen; whose screen takes the stage (pure, unit-tested) |
| `lib/webrtc/early-state.ts` | Screen/media state that arrives just before a connection is trusted (pure, unit-tested) |
| `lib/webrtc/file-transfer.ts` | Chunked, acknowledged, per-recipient file transfer (50MB max) |
| `lib/media/manager.ts` | Camera/mic/screen capture, camera on/off, device switching, audio-only fallback, adopting the pre-join stream (`adoptMedia`) |
| `lib/media/quality.ts` | Upload caps for camera and screen by call size (pure policy, unit-tested) |
| `lib/media/preview.ts`, `routes/room/[id]/PreJoin.svelte` | Pre-join check: camera preview, mic level, device pickers, test sound, join muted or camera off |
| `lib/media/camera.ts`, `lib/media/call-camera.ts` | Constraints, front/back camera flip (through the camera queue) |
| `lib/media/media-errors.ts` | Friendly camera/mic errors and per-browser steps to allow access |
| `lib/media/device-prefs.ts` | The microphone, camera and speaker you last picked (localStorage) |
| `lib/media/wake-lock.ts` | Keeps the screen on during a call (Screen Wake Lock API) |
| `lib/stores/room.ts` | Endpoints, ICE fetch, per-tab identity, preferences |
| `lib/webrtc/conn-stats.ts`, `conn-quality.ts` | Connection quality: polls `getStats()`, classifies each link as good / fair / poor |
| `lib/ui/pip.ts`, `PipView.svelte`, `pip-target.ts` | Picture-in-picture: a Document Picture-in-Picture window, or standard video picture-in-picture |
| `lib/ui/attention.ts` | Waiting-room alerts for the host: chime, flashing tab title, opt-in generic notification |

The app is a static SPA (SvelteKit + adapter-static). Its Content-Security-Policy is emitted as a `<meta>` tag with a hash for SvelteKit's boot script (`svelte.config.js`), so it works on any host.

**Installable app.** `static/manifest.webmanifest` (`start_url` and `scope` `/`, `display: standalone`, the dark theme's colors) and local PNG icons (192 and 512 pixels, a maskable 512, and an `apple-touch-icon` for iOS) let browsers install vchat as an app; on iOS, use Share → Add to Home Screen. The icons are drawn by `scripts/generate-icons.mjs`, which has no dependencies. The CSP allows the manifest with `manifest-src 'self'` (the icons fall under `img-src 'self'`), and both Caddy and `_headers` serve it as `application/manifest+json`. There is deliberately **no service worker**. A service worker sits between the page and the network and can keep serving cached app code, so a broken or malicious version, once served, could keep running after the server is fixed. vchat's end-to-end verification is only as trustworthy as the JavaScript the browser runs, so the app always loads fresh from your server (pages are `no-store`). A service worker could also get between invite links and the page that reads and strips their `#fragment`. Chromium-based browsers install apps without one. The installed app needs a connection, as a call does anyway.

### Media: camera, screen and quality

**Transceiver layout** (`lib/webrtc/media-slots.ts`). Every connection has the same three media transceivers, created by the side that sends the offer: audio (the microphone, mixed with the shared screen's sound while presenting), then a video transceiver for the camera, then one for a shared screen. All three can send and receive from the start, also for someone who joined audio-only, chat-only or with the camera off. The answerer adds its microphone and camera first (the offer adopts them) and gets the rest from the offer; it lets them send while the offer is applied, and if its browser fires those events too late it asks the offerer for one more round (at most twice per connection). After that, turning the camera off or on and starting or stopping a share only changes the track a sender carries (`replaceTrack`), and every change goes through the trust gate: nothing, including the screen, is sent before the connection is verified. Microphone and camera share a stream id so the receiver keeps them lip-synced (an answerer whose camera was off when it connected needs `RTCRtpSender.setStreams` for that).

**Which video is the screen.** It's never guessed. When sharing, the presenter tells each verified peer, in `screen-state { sharing: true, mid }`, the mid of its own screen transceiver on that connection. The receiver accepts a mid only in the form browsers write them (`[A-Za-z0-9_.{}-]`, at most 32 characters) and looks it up only among the transceivers of the connection it came over, as a live video transceiver, so a peer can only ever label its own video. Its camera is the first other video transceiver. The receiver builds its own streams from the transceivers (microphone + camera for the person's tile, the screen alone for the stage) and ignores stream ids in the session description. Viewers see the screen on the stage and the presenter's camera (or initial) in their tile; the stage never plays sound, because the shared audio is mixed into the presenter's microphone. The stage shows the most recent presenter whose screen is actually arriving (`pickPresenter`), so someone who only claims to share can't blank it or hide a real presenter; any other screen being shared appears in the strip.

**State sent before trust.** Each side opens its gate when it has checked the other's proof, so one side can be a moment ahead and send its `screen-state` and `media-state` while the other is still checking. Nothing is acted on before trust, but the latest of each of those two (a validated copy, one per type, `lib/webrtc/early-state.ts`) is kept with that connection and applied through the normal handlers once it's trusted. Anything else sent early is dropped, and a new session or a block discards what was kept.

**Camera off** stops the camera track, so the camera (and its light) is released, and points every peer's camera sender at nothing. Camera on asks for the selected camera again, or the default one if it's gone. If the camera is busy, unplugged or blocked, it stays off and the reason is shown. Choosing another camera while it's off only remembers the choice. Turning the camera on or off and switching cameras run one at a time, and whichever finishes leaves exactly one camera open (or none). A camera that stops by itself (unplugged) is treated as turned off. Peers are told through `media-state` either way.

**Quality** (`lib/media/quality.ts`). In a mesh you upload a copy of your camera to each other person, so outgoing video is capped by the number of verified peers, to about 3.5 Mbps in total: 2.5 Mbps at 720p for one peer, down to 700 kbps at 480p each for five. While presenting, the screen gets 75% of that (all of it if the camera is off), a higher priority than the camera, `contentHint = 'detail'` and `degradationPreference = 'maintain-resolution'` where supported (text stays sharp and the frame rate gives way), and it's sent at up to 1080 lines. The caps are applied with `getParameters`/`setParameters` when peers are verified or leave, when a share starts or stops, when a track changes, and when the shared surface changes size on the same track (checked every 2 seconds while presenting). Changes to one sender run one at a time and errors never escape. If a browser refuses the parameters, the bitrate and scale are set on their own and the other fields are added back one at a time, so only the refused field is dropped (and not tried again on that sender). A browser that reports no encodings is offered one.

---

## Collaboration features

Everything below travels over the WebRTC **data channels** between browsers. It's end-to-end encrypted like the media, and the signaling server never sees it. Each feature registers its own message type with `registerDataHandler()` in `lib/webrtc/mesh.ts`, and can react to `onPeerConnected` / `onPeerLeft` / `onRoomLeft`.

| Feature | Module | Message types |
|---|---|---|
| Chat and private messages | `mesh.ts`, `ChatPanel.svelte`, `lib/chat/linkify.ts`, `lib/chat/transcript.ts` | `chat` (a private message is sent only to its recipient's channel, with `private: true`), `typing` (private: recipient only) |
| Mic/camera state | `mesh.ts` | `media-state { audio, video }`, sent on change (at most every 500ms, always the latest state) and to newcomers |
| Screen-share state | `mesh.ts`, `media-slots.ts` | `screen-state { sharing, mid }`, which puts the presenter's screen on the stage (`mid`: their screen transceiver, see [Media](#media-camera-screen-and-quality)) |
| Screen annotations | `lib/collab/annotations.ts`, `AnnotationLayer.svelte` | `annot` with `pointer` / `pointer-off` / `stroke` / `remove` / `clear`, scoped by `screen` (the presenter's peer id) |
| Whiteboard | `lib/collab/whiteboard.ts`, `Whiteboard.svelte`, `whiteboard/TextEditor.svelte` | `wb` with `stroke` / `update` / `remove` / `clear` / `opened` / `sync-req` / `sync` |
| Room name | `lib/collab/room-meta.ts` | `room-name`, accepted only from the current host |
| Raised hands | `lib/collab/hands.ts`, `hand-model.ts` | `hand { raised }`, sent on change and to newcomers |

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

**Links in chat** (`lib/chat/linkify.ts`, pure and unit-tested). Only absolute `http://` and `https://` URLs become links. Nothing else can (no `javascript:`, `data:`, `blob:`, `file:` or `mailto:`), and a bare `example.com` stays text. Trailing sentence punctuation and unbalanced closing brackets are left out of the link (a trailing `_`, `*` or `~` is kept). A URL stays text if it's longer than 2,048 characters, its hostname is longer than 253, or it contains a username or password (`https://yourbank.com@evil.example` goes to `evil.example`). Each URL is parsed with the browser's URL parser, and the link shows the normalized address it really opens: printable ASCII only, with internationalized hostnames as punycode (so a look-alike domain can't pass as the real one) and non-ASCII, invisible or bidi characters in the path percent-encoded. Only the end of the hostname that identifies the site is in bold: the last two labels, or three under a suffix like `co.uk` or `com.au` (so `https://paypal.com.evil.example` shows `evil.example` in bold). Links are real `<a>` elements with text content (never HTML), open in a new tab with `rel="noopener noreferrer nofollow"` and `referrerpolicy="no-referrer"`, have no long-press preview on iOS and macOS (`-webkit-touch-callout: none`), and are never previewed or fetched by vchat.

**Saving the chat** (`lib/chat/transcript.ts`, pure and unit-tested). The download button in the chat header saves the chat as a plain `.txt` file. The file is built in the browser from the chat in memory (a `Blob` behind an object URL, revoked afterwards), and nothing is uploaded. It starts with the room name ("Unnamed room" if it has none; the room code is never included) and the date and time (with the UTC offset), then has one line per message with its time and sender. Your own name is marked `[you]`, and private messages are marked `[private]` with who they were from and to. Files are listed at the end by name, size, sender or recipient and status, never their contents. Because the text comes from other people: control, bidi, zero-width and other invisible characters are removed (ESC too, so the file is safe to print in a terminal); every line that continues a message is indented, so a line starting with `[` is always a real entry; runs of spaces and tabs become one space, so padding can't push fake entry text to the start of a line in a viewer that wraps long lines; square brackets in names become parentheses, so the markers can't be faked; and colons, `>` and arrows are removed from names, so a name like `Carol -> Alice` can't make a public message look private. The file is named `vchat-chat-<room>-<date>-<time>.txt`, where the room part keeps only letters, digits and combining marks (no dots, slashes or other path characters), is at most 40 characters long, and is left out when the room has no name. The button is disabled while the chat is empty. Only what's in memory is saved: messages since you joined, up to the last 500.

**Raised hands** (`lib/collab/hand-model.ts`, pure and unit-tested). Each person raises or lowers only their own hand: the message names nobody, and whose hand it is comes from the connection it arrived on. A message must be exactly `{ type: 'hand', raised: <boolean> }` (with any other field it's ignored), is only accepted from a verified connection, and is rate-limited per participant (5/s, burst 10, malformed messages included). The sender coalesces rapid toggles into at most one update per 300ms, always the latest state. Every new or rebuilt connection is sent the current state. A hand comes down when its owner leaves or their connection is rebuilt (until the new verified channel sends it again). The brief notice ("Alex raised their hand") uses the name the app shows for that person, never text from the message. It's skipped for the state a new connection catches up on, and shown at most once per person per 5 seconds.

## Participant controls

These change only your own view and controls. Nothing about them is sent to anyone.

**Volume and pin** (`lib/ui/participants.ts`, pure and unit-tested; `lib/ui/participant-prefs.ts`). Tap a person to set how loud they play for you (0–100%), mute them for yourself, or pin them. Volume sets `volume`/`muted` on the media element of their tile, which plays all their sound (a shared screen's audio is mixed into their microphone, and screen tiles never play sound). It's kept in memory until you leave the call (also when their connection drops and comes back). It's tied to the participant's peer id for this call, so someone who rejoins from a new tab (a new id) is heard at full volume again. `selectStage()` decides what's on the stage, in this order: the whiteboard (if you opened it), your own screen share, the person you pinned (their screen, once it's arriving), then the most recent remote screen that's actually arriving (`pickPresenter`). Your pin outranks other people's shares, so nobody can take your stage by announcing one; while someone else shares, a "<name> is sharing · View" button unpins, and their screen is also in the strip. A presenter keeps their tile in the strip; a pinned person's tile moves to the stage. Tapping whoever is on the stage (or the Options button on a shared screen) opens their person card (volume, Mute for me, and Remove for the host). A pin is dropped when that person leaves.

**Keyboard shortcuts** (`lib/ui/shortcuts.ts`, pure and unit-tested; `KeyboardShortcuts.svelte`). Press `?` in a call, or open Settings → Keyboard shortcuts, to see them.

| Keys | Action |
|---|---|
| Ctrl+D (Mac: Cmd+D) | Microphone on/off |
| Ctrl+E (Mac: Cmd+E) | Camera on/off |
| Space, held | Talk while muted |
| Ctrl+Alt+H (Mac: Ctrl+Cmd+H) | Raise or lower your hand |
| Ctrl+Alt+C (Mac: Ctrl+Cmd+C) | Open or close the chat |
| `?` | Show the list |

Toggles use modifier combinations, so they can't collide with typing or with the whiteboard's single-key tools, which ignore keys pressed with Ctrl, Cmd or Alt. A letter is read from the keyboard layout, falling back to the physical key on non-Latin layouts (and for Option on a Mac). No shortcut fires while focus is in an input of any type, a textarea, select, contenteditable element or ARIA text widget, during IME composition, for a character typed with AltGr, or outside the call itself (pre-join, password and waiting screens). A shortcut with nothing to do (the mic and camera keys for chat-only participants, the camera key without a camera) is left to the browser.

Hold-to-talk (`HoldToTalk` and `routeKeydown()` in `shortcuts.ts`) only unmutes if you're muted, never takes Space from a focused button, link, tile or form control, and is off while the whiteboard is open (Space pans it). Letting go of Space mutes again. So does anything that could hide the release, and that event does nothing else: any other key, a click or tap (the click is swallowed), or focus moving into a text field. After that, every key press is ignored until Space is let go, so Space then Ctrl+D can't leave the mic open. If the mic is switched some other way during a hold (the Mic button), the hold is dropped and letting go of Space leaves the mic as you set it. The window losing focus, the tab being hidden, a context menu, page hide, the screen-share picker opening, the whiteboard opening and leaving the call all mute and start over.

## Picture-in-picture

The **Pop out** button (`lib/ui/pip.ts`) keeps the call in view while you're in another tab or app, for example while presenting.

- **Chromium on desktop** (Document Picture-in-Picture API): a small always-on-top window shows everyone (video, or their initial when the camera is off, with name, muted and speaking indicators) and mic, camera and leave buttons that call the same handlers as the main controls. `PipView.svelte` is mounted into that window's document by the main page and reads the same stores, so it follows people joining and leaving and tracks changing. Someone who is sharing shows their screen there instead of their camera. Its videos are muted: the sound keeps playing from the main window.
- **Safari and Chromium on Android** (standard picture-in-picture): one video, chosen by `pip-target.ts`: a shared screen (only one that's actually arriving, shown instead of that person's camera), else the active speaker, else whoever is shown already, else the first person with video. It uses a hidden, muted video element of the app's own, so the picture can follow the conversation (at most one switch every 3 seconds) without another click. While picture-in-picture is closed, that element stays on the current pick but paused, so it draws no frames: Safari only opens picture-in-picture when it's requested synchronously in the click, on a video whose metadata has already loaded. It plays only while picture-in-picture is open, and its stream is released when the call ends.
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
| `lock-room` / `unlock-room` | — (host only): refuse every new join attempt / allow them again (see [Locking the call](#access-model)) |
| `end-room` | — (host only): end the call for everyone, participants and waiting guests |
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
| `lock-changed` | `locked`: sent to everyone in the call when the host locks or unlocks, and right after `room-peers` when you enter a locked room |
| `room-ended` | `roomId`, `reason`: the host ended the call (also the answer, for 60s, to anyone from that call coming back); the socket is then closed with `4004` |
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
| `POST /api/admin/rooms/email-invite` | Owner only: `{ roomId, inviteToken, emails: string[], key?, passcode?: boolean, schedule?: { startsAt, durationMinutes }, message?: string }` (`message`: up to 500 characters, longer is cut) (the older `{ email }` still works) → `200 { ok: true, sent: string[], failed: { email, reason: 'invalid' \| 'rate-limited' \| 'send-failed' }[], expiresAt, warnings: string[] }`, even if some or all recipients failed (`Retry-After` is set when the cap was hit). `warnings` may hold `schedule-ignored` and `meeting-ends-after-invite-expires`. Never returns tokens or codes. 400 no valid address, more than 20, or a bad invite; 401 not signed in; 403 bad origin; 503 email not configured |
| `POST /api/invite/check` | Public, same origin: `{ roomId, token, code }` → `200 { ok: true, required: false }` (no code needed), `200 { ok: true, required: true }` (right code), `401 { error: 'Wrong code' }` (also for an empty code, which isn't counted), `429 { error: 'Too many attempts' }` + `Retry-After` (shared with joining), `400 { error: 'Invalid invite' \| 'Invite expired' }`. Grants nothing: joining checks the code again |
| `GET /healthz` | `ok` |

Close codes (clients must not reconnect automatically after 4000, 4002, 4003, 4004, 4005 or 4006):

| Code | Meaning |
|---|---|
| `4000` | Replaced: the same identity connected again elsewhere |
| `4001` | Idle: the socket wasn't in a room for too long (60s) |
| `4002` | Removed by the host |
| `4003` | The invite is invalid or expired (sent after the `error` message) |
| `4004` | The host ended the call (sent after `room-ended`). Clients stop as soon as `room-ended` arrives, whatever close code follows |
| `4005` | The room is locked: a new join attempt was refused (sent after the `error` message `Room is locked`) |
| `4006` | This call is no longer available: the host ended it while this connection wasn't in it (password prompt, denied, joining) |

A socket is bound to the room it was authorized for at the upgrade (`/ws?room=`); joining another room on it is refused. In private mode the gate accepts an expired-but-genuine invite only within 24 hours of expiry, so the person can be told it expired. Cloudflare refuses more than 40 sockets per room.

---

## Reconnection

- **Signaling drops.** The client pings every 25s and reconnects with backoff when a pong is missed or the socket closes. Each tab has a random `secret` and a separate random peer identity per room (sessionStorage), so the server can't link one person's rooms. On rejoin, a peer whose `peerId` + `secret` were already admitted skips the password and waiting room (and a lock), and replaces its stale socket if the server hasn't noticed it's dead. If the room emptied in the meantime, the client re-creates it (open mode). If the host ended the call, the client stops for good on `room-ended` (or close code `4004`) and never reconnects or re-creates the room; a client that was in the call but offline at that moment is answered with `room-ended` for the next 60 seconds. A client that hasn't heard from the server for over a minute (a sleeping laptop, a long outage) doesn't go back in on its own, since the call may have ended or changed and its camera and mic are live: it shows "Reconnect" / "Leave" instead. Shorter drops rejoin automatically. Once in the call, a fatal answer on reconnecting (the invite expired meanwhile, the room is full…) ends the call as a removal does, rather than leaving connections up under the error.
- **Page refresh.** `peerId`, `secret`, the room password and "I created this room" are kept in sessionStorage for the tab, so a refresh rejoins seamlessly. Closing the tab forgets everything.
- **P2P drops.** ICE `failed` (or `disconnected` for 5s) triggers a new connection with a fresh session id. If both sides restart at once ("glare"), the peer with the smaller id wins. Retries are capped at 5 per minute per peer.

---

## Security and privacy model

- **Access.** Private mode: only the owner can create rooms. Guests need a signed, expiring invite, plus an optional password and owner approval. TURN credentials are only issued to invite/host holders, so strangers can't use your relay.
- **Rooms.** Unguessable 10-char codes (private) or 8-char codes (open). Room passwords are verified against a keyed hash in the invite (private) or a SHA-256 hash in memory (open).
- **TURN credentials.** Short-lived (4h by default, never past the invite's expiry): coturn uses a shared-secret HMAC (`use-auth-secret`) with a unique `<expiry>:<random>` username per response, and Cloudflare credentials come from its API (cached briefly per role and room). No TURN password is baked into the frontend. coturn has per-user and total quotas, a per-session and total bandwidth cap, and refuses to relay to private, special-purpose, NAT64/Teredo and cloud-metadata addresses or any address of the host itself.
- **TURN over TLS on port 443 (Docker, optional).** Off by default. When on, Caddy routes one hostname to coturn's TCP listener and nothing else, coturn's credentials, quotas and peer rules apply unchanged, and coturn itself still has no TLS listener. Details in [TURN over TLS on port 443](#turn-over-tls-on-port-443-docker).
- **Input validation.** All signaling messages are validated, size-limited (64KB; 32KB for a signal payload) and rate-limited per connection. WebSocket origins are checked. The Node server drops clients that stop reading (over 1MB queued).
- **Peer data.** Names shown in chat come from the server's validated list, not from what a peer claims over the data channel. SVG files aren't previewed inline. Links in chat are only `http(s)`, show the normalized address they open (punycode hostnames), and are never previewed or fetched.
- **Storage.** Chat is kept in memory only and never written to storage: it is gone when you leave, are removed, refresh or close the tab. Saving it yourself with Save chat is the only time chat is written anywhere: the text file is made in your browser and downloaded, and nothing is uploaded. The invite token, room key and per-room identity live in sessionStorage so a refresh can rejoin; they are cleared when you leave the call or are removed from it (if the tab is closed without leaving, the browser may keep them for its own "reopen closed tab" feature until the session ends). localStorage holds your display name, TURN preferences, whether you turned on waiting-room notifications, the microphone, camera and speaker you last picked (`vchat_devices`: browser device ids, opaque strings that are specific to this site and that the browser already remembers for it; cleared with the site's data) and, on the owner's own browser, the rooms they created (including their host links and room keys, which grant host access until they expire). Expired rooms are pruned and the list is cleared on sign-out. Don't use the owner dashboard on a shared computer.
- **Untrusted peers.** Everything received over data channels is size- and rate-limited per participant. Files are capped (3 at a time, 150MB total per sender, 50 files / 300MB per peer per call) and checked chunk by chunk, with a 60s stall timeout. Received images are previewed only after a header check (at most 16 megapixels). Whiteboard and annotation data is capped (3,000 strokes / 600k points). Raised-hand messages must have their exact shape and are rate-limited per participant. Nobody can rewrite someone else's strokes or file entries. Names are made unique (compared after folding case, accents, compatibility forms and common look-alike letters) and stripped of invisible/bidi characters.
- **Connection statistics.** Connection quality is computed in the browser from `getStats()`, for trusted connections only, and only shown there: it's never sent to the server or to other participants, never stored, and dropped when someone leaves or the call ends. Candidate statistics include IP addresses; only the candidate type (relay or not) is read.
- **Host controls.** Locking, unlocking and ending the call are checked by the server against the host role, like approving and removing; the hidden buttons are only UI. The lock and the 60-second lists of identities (ended calls, rooms that emptied while locked) live in memory only. Room metadata keeps an emailed invite's address only as a keyed hash (HMAC with `SECRET_KEY`); the address itself is held only while that guest waits, to show the host. That also keeps Cloudflare's socket attachments under their 16 KiB limit at the caps; a failure to save one is logged only with `DEBUG_LOGS=1`. With `DEBUG_LOGS=1` the server logs that the host locked, unlocked or ended the call (room id only, no names); otherwise nothing is logged. Lock state shown in the app comes from the server, never from other participants. The host's buttons stay disabled until the app is back in the room after a reconnect, and say so if the server refuses or doesn't confirm.
- **Camera and microphone.** Nothing is opened until you choose a mode that needs it: the pre-join screen starts with everything off, and opens the camera and microphone only when you press "Check camera & mic", pick "Camera & mic" or "Audio only", or join. It only asks for what the mode needs (audio only never asks for the camera), and if the camera can't be used it carries on with the microphone, but never by triggering a second permission prompt (it checks the Permissions API first). Devices are released as soon as they aren't needed: switching to audio only (camera) or chat only (both), turning the camera off, cancelling, leaving the page, an error, or the tab being hidden (your choices are kept, and nothing reopens until you press "Check camera & mic" again or join). In the call, a fatal room error (room full, invite expired, too many password attempts…) or being denied releases them at once, not only when you click "Back to home". Every request is tagged, and a result that arrives after you changed your mind (a slow permission prompt, say) is stopped the moment it arrives. On join, the open tracks are handed to the call instead of being opened again, so they go through the same trust gate as always. Joining with the camera off doesn't hold the camera: the call starts with no camera track, exactly as turning the camera off leaves it, and "camera on" opens it then. Camera changes in the call (on, off, switch, front/back flip) run one at a time through one queue, and whichever finishes leaves exactly one camera running, so a flip can't race a switch and leave a second camera sending. Muting keeps the microphone open but silent, as muting in the call does, so the browser's microphone indicator stays on.
- **Screen wake lock.** During a call (and while waiting to be admitted) the page asks the browser to keep the screen on, where supported. It's asked for again when the page becomes visible, and released when you leave, are removed, or the call ends with an error.
- **Hide my IP address.** An optional pre-join setting makes the browser use only the TURN relay (`iceTransportPolicy: relay`), so other participants see the relay's address instead of yours. It needs TURN to be configured.
- **Server hardening.** In private mode a WebSocket is only accepted with a valid invite or host token, sent as a subprotocol so it never appears in URLs. Invite links carry the token after `#`, which browsers never send to servers. Owner logins are throttled (see above). Room-password guesses are limited to 10 per room and client per 10 minutes, with a backstop of 200 per room, and in open mode a client can create at most 30 rooms per 10 minutes; on Cloudflare the client is identified by an HMAC of its IP keyed with `SECRET_KEY`, never the raw address. These throttles live in memory (per process, or per Durable Object/isolate on Cloudflare) and forget clients once their window passes. Configuration fails closed.
- **No logs.** Room activity is only logged with `DEBUG_LOGS=1`. Workers Logs are disabled in `wrangler.jsonc`. In the Docker setup, Caddy discards all logs, including the layer4 module's (its error log would otherwise include IPs and the token header), coturn's logging is off, and every container uses Docker's `none` logging driver.

### End-to-end verification

WebRTC encrypts everything between browsers (DTLS-SRTP), but the DTLS fingerprints that anchor that encryption are exchanged through the signaling server, so a compromised server could in principle sit in the middle. vchat closes that gap with a room key the server never sees (`lib/webrtc/e2e-proof.ts`, `e2e.ts`, `mesh.ts`):

- **Room key.** 256 random bits generated in the creator's browser. It only ever travels in the link's `#fragment` (`#invite=<token>&k=<key>`, or `#k=<key>` in open mode), which is stripped from the address bar before any network request. A pasted invite is kept in tab storage and opened without the fragment, so the key never lands in browser history. Old `?invite=` links are no longer accepted.
- **One pinned transport per connection.** Every connection uses max-bundle + rtcp-mux, so there's exactly one DTLS transport. Session descriptions are parsed strictly: exactly one SHA-256 fingerprint, every active m-section bundled, one ICE username fragment. Fingerprint and ufrag are pinned, and any change on renegotiation blocks the connection. Fingerprints are also cross-checked against the certificates reported by `getStats()`.
- **Trust gate.** Nothing flows until a connection is verified: your camera, microphone and screen senders are held empty, received media isn't shown, and only verification messages cross the data channel.
- **Proof.** Each side sends an HMAC (key derived from the room key with HKDF) over the protocol version, room id, session id, both peer ids, both fingerprints and the sender's display name, as *it* sees them. An interceptor shows each side a different fingerprint and doesn't know the key, so the proofs can't match. A valid proof marks the connection **verified**, and the name shown for that person is authenticated. A wrong proof or mismatched details **blocks** the connection, with a warning. No proof (the peer doesn't have the key, e.g. typed the room code) or no answer within 20 seconds marks it **unverified**: it stays blocked unless you click "Allow anyway".
- **Safety codes.** Tap a person to see a 12-digit code for your connection with them. Comparing it out loud detects even someone in the middle who has the room key.

Covered by `apps/web/src/lib/webrtc/e2e.test.ts`, including a simulated man-in-the-middle.

What this doesn't cover: the server serves the web app's JavaScript, so a malicious server operator could serve modified code, as with any web app. Code you build and bundle yourself (the desktop app, once it can target a server) is the strongest option. Joining without the room key still gives you encryption, but no verification.

---

## TURN over TLS on port 443 (Docker)

> **New and optional.** So far this has only been verified by reviewing the configuration, not on a real server. It's off unless you turn it on in `deploy.sh`; see the [checks after enabling](#checks-after-enabling).

For networks that only let traffic out to port 443, the relay can also answer as `turns:<TURN_TLS_DOMAIN>:443?transport=tcp`, next to the website on the same port.

**How it's switched on.** `deploy.sh` keeps your answer in `.env` (`TURN_TLS=on`/`off`) with the hostname (`TURN_TLS_DOMAIN`). Only while it's on and every check passes does it add `docker-compose.turn-tls.yml` to `COMPOSE_FILE` in `.env`. That add-on builds the `web-turn-tls` target of `Dockerfile.web` (the stock Caddy image plus a Caddy binary compiled with the [layer4](https://github.com/mholt/caddy-l4) plugin: Caddy 2.11.9, caddy-l4 v0.1.3), sets `TURN_TLS=on` for Caddy so the Caddyfile imports `caddy/turn-tls-on/`, and adds the `turns:` URL to the relay URLs browsers get. Without it, the web image is the stock Caddy image, nothing is compiled, and the Caddyfile imports nothing extra. If the DNS check, the build, the configuration check (`caddy validate`, before the running containers are replaced) or the site check after starting fails, `deploy.sh` deploys without it and says why, keeping your answer and the hostname for the next run.

**How a connection is routed.** A layer4 listener wrapper sits in front of Caddy's HTTPS server on port 443. It reads each new connection's TLS ClientHello (waiting up to 10 seconds for it) and, if the server name (SNI) is the relay hostname and it isn't an ACME TLS-ALPN challenge, takes the connection over: Caddy completes the TLS handshake with its own certificate for the name (obtained through the site block in `caddy/turn-tls-on/site.caddy`; ALPN `stun.turn` is offered, handshakes time out after 10 seconds) and passes the decrypted TURN stream to coturn's plain TCP listener. Every other connection goes to the website unchanged. The rule routes one name to one fixed address, so it can't be used as an open proxy, and its logs go to Caddy's discarded log like everything else.

**What coturn sees.** coturn keeps `no-tls`, so it gets no TLS listener or certificate copy, and the relay still only works with valid short-lived credentials. Between Caddy and coturn, TURN runs over plain TCP, as it does for `turn:` clients on port 3478 (the media inside is end-to-end encrypted). coturn sees these clients with Caddy's address instead of their own. None of its protections depend on client addresses: quotas count per credential and in total, bandwidth caps apply per session and in total, and `denied-peer-ip` rules are about relay targets. The PROXY protocol, which would pass the real address on, isn't used: coturn only accepts it on a separate listener (`tcp-proxy-port`) that replaces its plain TCP listener, which would break `turn:` over TCP on port 3478.

**The upstream address (`TURN_TLS_UPSTREAM`).** coturn relays from the local address a client connected to. So Caddy has to connect to coturn on the address where outside traffic to port 3478 arrives. If it uses another one, `turns:` connections and allocations still work, but relayed media never arrives: the relay is bound to an address outside traffic doesn't reach. `deploy.sh` guesses the address once (the public IP if it's on an interface, otherwise the default route's source address, otherwise the domain), prints it, and from then on keeps whatever is in `.env`. The guess is wrong for a DigitalOcean Reserved IP (traffic arrives at the droplet's anchor IP), a host with several public IPs, or a VPN or exit node as the default route. In those cases set `TURN_TLS_UPSTREAM` in `.env` to the right `address:3478` and run `deploy.sh` again.

**What `deploy.sh` checks after starting.** It sends a STUN Binding request over TLS to `TURN_TLS_DOMAIN:443`, verifying the certificate. An answer proves the DNS record, the SNI routing, the certificate and Caddy's TCP path to coturn. It doesn't prove relaying: it doesn't allocate, and relaying can't be tested from the server itself because coturn refuses to relay to the server's own addresses. A wrong `TURN_TLS_UPSTREAM` isn't detected; only a real call is.

**Resources.** Compiling Caddy runs Go one package at a time with a soft 512MiB memory limit, before the other images are built. On a 1GB server without swap it may still run out of memory; `deploy.sh` then deploys without the relay on port 443. At runtime each relayed connection costs the web container roughly 100KB (two 32KB copy buffers plus TLS state). At coturn's limit of 300 allocations in total that's about 30MB, well within the container's 256MB limit, which stays as it is. Connections that never set up an allocation are dropped by coturn after `max-allocate-timeout` (60 seconds by default).

### Checks after enabling

- The image builds on your server's architecture (amd64 or arm64), and on a 1GB server if that's what you use (`deploy.sh` warns if it fell back).
- `openssl s_client -connect turn.your-domain:443 -servername turn.your-domain` shows a valid certificate for that name, and the website and `https://your-domain/api/config` still answer.
- A call works from a network that only allows port 443 (or a test machine with outgoing UDP and TCP 3478 blocked) in Chrome, Firefox and Safari. In `chrome://webrtc-internals`, the selected candidate pair should be a relay candidate over `tls`.
- Behind 1:1 NAT or a Reserved IP, that media actually flows over that connection, not just that it connects. If calls through `turns:` connect but stay black and silent, `TURN_TLS_UPSTREAM` is wrong.
- With a firewall other than ufw, Caddy's container can reach `TURN_TLS_UPSTREAM` on TCP (container to host).

To turn it off, run `deploy.sh` and answer no (or remove the `COMPOSE_FILE` line from `.env` and run `docker compose up -d --build`).

---

## Debugging with logs

Logging is off everywhere by default. To investigate a problem on a Docker deployment, turn it on temporarily and turn it off again afterwards:

1. In `docker-compose.yml`, remove the `logging: driver: none` lines from the service you're debugging (or set `driver: json-file`). For room activity from the signaling server, also add `- DEBUG_LOGS=1` to its `environment`.
2. For Caddy's error log, remove the global `log default { output discard }` block at the top of `Caddyfile`.
3. `docker compose up -d --build`, reproduce the problem, and read `docker compose logs <service>`.
4. Restore the files and run `docker compose up -d --build` again. `docker compose down && docker compose up -d` (or `sudo bash deploy.sh`) recreates the containers, which deletes the logs Docker kept.

These logs can contain IP addresses, room ids, names and (in Caddy's error log) invite tokens, so keep the window short. On Cloudflare, `npx wrangler tail` shows live output without storing it (set `DEBUG_LOGS=1` as a variable for room activity).

---

## Updating pinned images

The Docker setup pins its images by digest: Caddy's runtime and builder images in `Dockerfile.web`, and coturn in `docker-compose.yml` (plus the caddy-l4 version in `Dockerfile.web`). A pinned image never changes under you, but it also doesn't pick up security fixes by itself. Image publishers rebuild their tags from time to time (coturn re-pushes `4.19.0` with each rebuild, for example), each time under a new digest, and a digest no tag points to any more can eventually stop being pullable, which would make deployments fail. So move the pins forward now and then:

1. Pick the versions: the image tags on Docker Hub, and for caddy-l4 its GitHub releases (its `go.mod` must not require a newer Caddy than the one you pin).
2. Look up each tag's multi-platform digest, e.g. `docker buildx imagetools inspect caddy:2.11.9-alpine` (the `Digest:` line at the top). Do the same for `caddy:2.11.9-builder-alpine` and `coturn/coturn:4.19.0`.
3. Update the tag and digest in `Dockerfile.web` and `docker-compose.yml` (and the Caddy version in the `xcaddy build` line, which must match the builder image), then run `sudo bash deploy.sh`.

---

## Known limitations

- Mesh topology: everyone uploads a copy of their video to each other person. Outgoing video is capped at about 3.5 Mbps in total, so with more people each copy gets a lower resolution, and encoding several copies costs CPU. 6 is the practical cap.
- Only one shared screen is shown on the stage at a time (the most recent presenter's); other shared screens are smaller, in the strip. While you present, the stage shows your own screen.
- Mixed versions in one call (someone hasn't reloaded since an update) get the old screen-sharing behaviour between them. An older client sees a newer presenter's camera on the stage, not the screen. A newer client sees an older presenter's screen in that person's tile (it replaces their camera), not on the stage. A newer client can't send its screen to an older client that started their connection, because that connection has no screen transceiver. Reloading fixes all of it.
- Choosing the speaker (`setSinkId`) works in Chromium browsers and recent Firefox. Safari can't, so the speaker picker isn't shown there and "Test speaker" plays on the default output.
- The front/back camera flip is offered on touch devices with more than one camera. Phones that can't run two cameras at once briefly release the current one; if the other camera then fails to open, your camera is left off (turn it on again to retry).
- The screen wake lock needs a browser with the Screen Wake Lock API, and the browser may refuse it (battery saver, for example).
- Per-person volume has no effect on iPhone and iPad, where browsers ignore volume changes on media elements. "Mute for me" still works.
- The pop-out window with everyone in it needs Chromium on desktop (Document Picture-in-Picture). Safari and Chromium on Android pop out a single video, and Firefox has no web API for picture-in-picture, so the button is hidden there.
- Docker setup: two people who can only connect through the relay (for example both on HTTPS-only networks, or both using "Hide my IP address") can't reach each other, because coturn refuses to relay to its own address (`denied-peer-ip`), and that includes the other person's relay address. Allowing it would also open the host's other UDP services to relayed traffic.

---

## Desktop app

`apps/desktop` is an experimental [Tauri v2](https://tauri.app) shell around the web app. It needs Rust and app icons:

```bash
pnpm --filter @vchat/desktop exec tauri icon path/to/icon.png   # generates src-tauri/icons
pnpm desktop:dev
```

The web app always talks to the server it was loaded from; there's no custom-server setting in the UI. So for now the desktop shell is only useful in development (`pnpm desktop:dev` loads the dev server). A packaged build can't yet be pointed at your own server.

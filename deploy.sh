#!/usr/bin/env bash
# Interactive deployment of vchat on a Linux server with Docker. Run with: sudo bash deploy.sh
# Safe to re-run: existing secrets and your own .env settings are kept, so invite links keep working.
set -euo pipefail
cd "$(dirname "$0")"

echo "=== vchat deploy ==="
echo

fail() {
  echo "Error: $*" >&2
  exit 1
}

warn() {
  echo "WARNING: $*" >&2
}

[ "$(id -u)" -eq 0 ] || fail "Run as root (sudo bash deploy.sh) — it configures the firewall and Docker."
command -v docker &>/dev/null || fail "Docker is not installed. Install it first: curl -fsSL https://get.docker.com | sh"
docker compose version &>/dev/null || fail "The Docker Compose plugin is not installed."
command -v openssl &>/dev/null || fail "openssl is required."

# ── .env ──────────────────────────────────────────────────────────────────
#
# deploy.sh owns one block of .env (between the two marker lines) and rewrites it on every run,
# keeping the values. Every other line, comments included, is kept exactly as it is.

MANAGED_KEYS="DOMAIN ACME_EMAIL TURN_SECRET SECRET_KEY ADMIN_PASSWORD TURN_TLS TURN_TLS_DOMAIN TURN_TLS_UPSTREAM COMPOSE_FILE"
ENV_BEGIN="# --- Written by deploy.sh, which rewrites this block on every run (values you change here are kept) ---"
ENV_END="# --- End of the deploy.sh block. Add your own settings below; deploy.sh keeps them as they are ---"

# Reads .env the way Docker Compose does: KEY=value (or "export KEY=value"), with the value
# unquoted (up to a " #" comment), in 'single' or "double" quotes (which may span lines); blank
# lines and # comments. Modes:
#   get   print the value Compose uses for `want` (its last assignment)
#   check report anything that would make deploy.sh misread a managed key, and exit 1 if so
#   rest  print every line that isn't deploy.sh's: not in its block, not a managed key
# shellcheck disable=SC2016
ENV_AWK='
function ltrim(s) { sub(/^[ \t]+/, "", s); return s }
function closing(s, q,    i, c) {
  if (q == "\047") return index(s, q)
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == "\\") { i++; continue }
    if (c == q) return i
  }
  return 0
}
BEGIN { n = split(managed, mk, " "); for (i = 1; i <= n; i++) ismanaged[mk[i]] = 1 }
{
  sub(/\r$/, "")
  line[NR] = $0
  if (open != "") {
    owner[NR] = cur
    p = closing($0, open)
    if (p) { val[cur] = val[cur] "\n" substr($0, 1, p - 1); open = "" }
    else val[cur] = val[cur] "\n" $0
    next
  }
  s = ltrim($0)
  if (s == "" || substr(s, 1, 1) == "#") next
  if (s ~ /^export[ \t]/) s = ltrim(substr(s, 7))
  if (!match(s, /^[A-Za-z_][A-Za-z0-9_.]*[ \t]*[=:]/)) next
  k = substr(s, 1, RLENGTH); sub(/[ \t]*[=:]$/, "", k)
  v = ltrim(substr(s, RLENGTH + 1))
  cur = ++count; key[cur] = k; owner[NR] = cur; first[cur] = NR
  q = substr(v, 1, 1)
  if (q == "\047" || q == "\"") {
    quote[cur] = q
    v = substr(v, 2)
    p = closing(v, q)
    if (p) val[cur] = substr(v, 1, p - 1)
    else { val[cur] = v; open = q }
  } else {
    if (match(v, /[ \t]#/)) v = substr(v, 1, RSTART - 1)
    sub(/[ \t]+$/, "", v)
    val[cur] = v
  }
}
END {
  if (open != "") { print "line " first[cur] ": the quoted value of " key[cur] " is never closed"; exit 1 }
  if (mode == "get") {
    for (i = 1; i <= count; i++) if (key[i] == want) { v = val[i]; got = 1 }
    if (got) printf "%s", v
    exit 0
  }
  if (mode == "check") {
    for (i = 1; i <= count; i++) {
      k = key[i]
      if (!(k in ismanaged)) continue
      if ((k in seen) && seen[k] != val[i]) { print k " is set more than once, to different values"; bad = 1 }
      seen[k] = val[i]
      if (quote[i] != "\047" && val[i] ~ /[$\\]/) { print k " has a $ or \\ outside single quotes, which Docker Compose would expand"; bad = 1 }
    }
    exit bad
  }
  for (i = 1; i <= NR; i++) {
    if (line[i] == begin) { inblock = 1; continue }
    if (line[i] == end) { inblock = 0; continue }
    o = owner[i]
    if (o && (key[o] in ismanaged)) continue
    if (inblock && !o) continue
    print line[i]
  }
}
'

env_awk() {
  awk -v mode="$1" -v want="${2:-}" -v managed="$MANAGED_KEYS" -v begin="$ENV_BEGIN" -v end="$ENV_END" "$ENV_AWK" .env
}

# The value Docker Compose uses for a key in .env (nothing if it isn't set).
env_value() {
  [ -f .env ] || return 0
  env_awk get "$1"
}

if [ -f .env ]; then
  if ! ENV_PROBLEMS=$(env_awk check); then
    fail "deploy.sh can't safely read .env, so it changed nothing. Fix this by hand and run it again:
$ENV_PROBLEMS"
  fi
fi

valid_ipv4() {
  local ip=$1 o
  [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do
    [ "$o" = "$((10#$o))" ] && [ "$o" -le 255 ] || return 1 # no leading zeros, 0-255
  done
}

# The IPv4 addresses a name resolves to, one per line, in DNS order (nothing if none). Uses dig if
# it's installed and has an answer, otherwise the system resolver.
resolve_ipv4() {
  local ips=""
  if command -v dig &>/dev/null; then
    ips=$(dig +short "$1" A 2>/dev/null || true)
  fi
  if ! grep -qE '^[0-9.]+$' <<<"$ips" && command -v getent &>/dev/null; then
    ips=$(getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' || true)
  fi
  grep -E '^[0-9.]+$' <<<"$ips" | awk '!seen[$0]++' || true
}

HOSTNAME_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'

# ── Inputs ────────────────────────────────────────────────────────────────

DEFAULT_DOMAIN=$(env_value DOMAIN)
read -rp "Domain (e.g. call.example.com)${DEFAULT_DOMAIN:+ [$DEFAULT_DOMAIN]}: " DOMAIN
DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}
DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
[[ "$DOMAIN" =~ $HOSTNAME_RE ]] || fail "'$DOMAIN' is not a valid domain name."

DEFAULT_EMAIL=$(env_value ACME_EMAIL)
read -rp "Email for HTTPS certificates (Let's Encrypt)${DEFAULT_EMAIL:+ [$DEFAULT_EMAIL]}: " ACME_EMAIL
ACME_EMAIL=${ACME_EMAIL:-$DEFAULT_EMAIL}
[[ "$ACME_EMAIL" =~ ^[^[:space:]@\'\"\\\$\`]+@[^[:space:]@\'\"\\\$\`]+\.[^[:space:]@\'\"\\\$\`]+$ ]] || fail "'$ACME_EMAIL' is not a valid email address."

# The public IPv4 address is needed by the TURN relay. Prefer the domain's own DNS record (no third
# party involved); ask ifconfig.me only if DNS has no answer.
DETECTED_IP=$(resolve_ipv4 "$DOMAIN" | head -1)
if [ -z "$DETECTED_IP" ]; then
  echo "Notice: $DOMAIN has no IPv4 DNS record yet; asking ifconfig.me for this server's public address."
  DETECTED_IP=$(curl -fs4 --max-time 10 https://ifconfig.me || true)
fi
valid_ipv4 "$DETECTED_IP" || DETECTED_IP=""
read -rp "This server's public IPv4 address${DETECTED_IP:+ [$DETECTED_IP]}: " EXTERNAL_IP
EXTERNAL_IP=${EXTERNAL_IP:-$DETECTED_IP}
valid_ipv4 "$EXTERNAL_IP" || fail "'$EXTERNAL_IP' is not an IPv4 address."
echo "Public IP: $EXTERNAL_IP"

# Relay on port 443 (TURN over TLS): optional and off unless you turn it on. Your answer is kept in
# .env (TURN_TLS), apart from the hostname, so pressing Enter keeps whatever you chose last time.
TURN_TLS=$(env_value TURN_TLS)
[ "$TURN_TLS" = on ] || TURN_TLS=off
TURN_TLS_DOMAIN=$(env_value TURN_TLS_DOMAIN)
TURN_TLS_UPSTREAM=$(env_value TURN_TLS_UPSTREAM)
OLD_COMPOSE_FILE=$(env_value COMPOSE_FILE)
# Both end up in Caddy's configuration, so only plain values are accepted.
UPSTREAM_RE='^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$'
[ -z "$TURN_TLS_DOMAIN" ] || [[ "$TURN_TLS_DOMAIN" =~ $HOSTNAME_RE ]] ||
  fail "TURN_TLS_DOMAIN in .env ('$TURN_TLS_DOMAIN') isn't a valid hostname."
[ -z "$TURN_TLS_UPSTREAM" ] || [[ "$TURN_TLS_UPSTREAM" =~ $UPSTREAM_RE ]] ||
  fail "TURN_TLS_UPSTREAM in .env ('$TURN_TLS_UPSTREAM') must be address:port, e.g. 203.0.113.7:3478."
echo
echo "Relay on port 443 (new, optional). Some networks (offices, hotels, some mobile carriers) only"
echo "let HTTPS out, which blocks the relay's port 3478. With this on, the relay also answers on port"
echo "443 (TURN over TLS) under a hostname of its own, which needs a DNS A record pointing at this"
echo "server. It compiles Caddy with an extra plugin (a few minutes the first time), and so far it has"
echo "only been checked by review, not on a real server. If any step fails, the script turns it off"
echo "again and deploys the rest as usual. See README.md → \"Relay on port 443\"."
if [ "$TURN_TLS" = on ]; then HINT="[Y/n]"; else HINT="[y/N]"; fi
read -rp "Enable the relay on port 443 (TURN over TLS)? $HINT " ANSWER
case "$(printf '%s' "$ANSWER" | tr '[:upper:]' '[:lower:]')" in
  "") ;;
  y | yes) TURN_TLS=on ;;
  n | no) TURN_TLS=off ;;
  *) fail "Please answer y or n." ;;
esac

TURN_TLS_ACTIVE="" # on for this deployment: TURN_TLS=on and every check so far passed
TURN_TLS_OFF_REASON="not enabled"
if [ "$TURN_TLS" = on ]; then
  DEFAULT_TURN_TLS_DOMAIN=${TURN_TLS_DOMAIN:-turn.$DOMAIN}
  read -rp "Relay hostname (A record pointing at $EXTERNAL_IP, DNS only) [$DEFAULT_TURN_TLS_DOMAIN]: " ANSWER
  TURN_TLS_DOMAIN=$(printf '%s' "${ANSWER:-$DEFAULT_TURN_TLS_DOMAIN}" | tr '[:upper:]' '[:lower:]')
  [[ "$TURN_TLS_DOMAIN" =~ $HOSTNAME_RE ]] || fail "'$TURN_TLS_DOMAIN' is not a valid hostname."
  [ "$TURN_TLS_DOMAIN" != "$DOMAIN" ] || fail "The relay needs a hostname other than $DOMAIN (e.g. turn.$DOMAIN)."

  # Caddy tells relay connections apart from the website by this name (TLS SNI), so it must point here.
  TURN_TLS_IPS=$(resolve_ipv4 "$TURN_TLS_DOMAIN" | sort -u | paste -sd ' ' -)
  if [ "$TURN_TLS_IPS" = "$EXTERNAL_IP" ]; then
    echo "$TURN_TLS_DOMAIN points at this server."
    TURN_TLS_ACTIVE=on
  else
    if [ -z "$TURN_TLS_IPS" ]; then
      warn "$TURN_TLS_DOMAIN has no IPv4 (A) record yet."
    else
      warn "$TURN_TLS_DOMAIN points at $TURN_TLS_IPS, not at this server ($EXTERNAL_IP)."
      echo "  If it's proxied through a CDN (e.g. Cloudflare's orange cloud), set it to DNS only." >&2
    fi
    echo "  The relay on port 443 stays off this time; everything else is deployed as usual. Your" >&2
    echo "  choice is kept: once the record points here, run this script again." >&2
    TURN_TLS_OFF_REASON="$TURN_TLS_DOMAIN doesn't point at this server yet"
  fi

  # Where Caddy hands relay connections to coturn. coturn relays from the address a client connected
  # to, so this has to be the address outside traffic to port 3478 arrives at. A value already in
  # .env is kept. Otherwise guess: the public IP itself if it's on an interface, else (1:1 NAT, as on
  # AWS or Google Cloud) the source address of the default route, else the domain.
  UPSTREAM_SOURCE="from .env"
  if [ -z "$TURN_TLS_UPSTREAM" ]; then
    UPSTREAM_SOURCE="guessed"
    LOCAL_IP=""
    if command -v ip &>/dev/null; then
      if ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -xF "$EXTERNAL_IP" >/dev/null; then
        LOCAL_IP=$EXTERNAL_IP
      else
        LOCAL_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)
      fi
    fi
    valid_ipv4 "$LOCAL_IP" || LOCAL_IP=""
    TURN_TLS_UPSTREAM=${LOCAL_IP:-$DOMAIN}:3478
  fi
  echo "Caddy will hand relay connections to coturn at $TURN_TLS_UPSTREAM ($UPSTREAM_SOURCE). If outside"
  echo "traffic to port 3478 arrives at another address on this server (the anchor IP of a DigitalOcean"
  echo "Reserved IP, a host with several IPs or a VPN as its default route), set TURN_TLS_UPSTREAM in"
  echo ".env to that address and port, and run this script again."
fi

EXISTING_PASSWORD=$(env_value ADMIN_PASSWORD)
if [ -n "$EXISTING_PASSWORD" ]; then
  IFS= read -rsp "Owner password (press Enter to keep the current one): " ADMIN_PASSWORD
  echo
  ADMIN_PASSWORD=${ADMIN_PASSWORD:-$EXISTING_PASSWORD}
else
  IFS= read -rsp "Owner password (you'll sign in with this at /admin): " ADMIN_PASSWORD
  echo
fi
[ ${#ADMIN_PASSWORD} -ge 10 ] || fail "Use at least 10 characters."
case "$ADMIN_PASSWORD" in
  *"'"*) fail "The password can't contain a single quote (')." ;;
  *\\*) fail "The password can't contain a backslash (\\)." ;;
esac

# Secrets: never changed once they exist, so invite links and the relay keep working. New ones are
# only generated when .env has none.
TURN_SECRET=$(env_value TURN_SECRET)
TURN_SECRET=${TURN_SECRET:-$(openssl rand -hex 32)}
SECRET_KEY=$(env_value SECRET_KEY)
SECRET_KEY=${SECRET_KEY:-$(openssl rand -hex 32)}
[[ "$TURN_SECRET" =~ ^[A-Za-z0-9]+$ && "$SECRET_KEY" =~ ^[A-Za-z0-9]+$ ]] || fail "TURN_SECRET/SECRET_KEY in .env must be alphanumeric."

# ── Files (readable only by root; coturn's group can read its config) ─────

# COMPOSE_FILE: lists docker-compose.turn-tls.yml only while the relay on port 443 is on for this
# deployment. Other files you listed there are kept. Prints nothing (leave Compose's defaults) if
# there's nothing to list.
compose_files() {
  local extra="" f
  while IFS= read -r f; do
    case "$f" in
      "" | docker-compose.yml | ./docker-compose.yml | docker-compose.turn-tls.yml | ./docker-compose.turn-tls.yml) ;;
      *) extra="$extra:$f" ;;
    esac
  done < <(printf '%s\n' "$OLD_COMPOSE_FILE" | tr ':' '\n')
  if [ -n "$TURN_TLS_ACTIVE" ]; then
    # Setting COMPOSE_FILE stops Compose loading an override file by itself, so list it.
    for f in docker-compose.override.yml docker-compose.override.yaml; do
      if [ -f "$f" ] && [[ ":$extra:" != *":$f:"* ]]; then extra="$extra:$f"; fi
    done
    printf '%s' "docker-compose.yml:docker-compose.turn-tls.yml$extra"
  else
    # Without other files, leave COMPOSE_FILE out: Compose then loads an override file by itself.
    f=${extra//:docker-compose.override.yml/}
    f=${f//:docker-compose.override.yaml/}
    if [ -n "$f" ]; then printf '%s' "docker-compose.yml$extra"; fi
  fi
}

write_env() {
  local kept="" compose_file
  if [ -f .env ]; then kept=$(env_awk rest); fi
  compose_file=$(compose_files)
  case "$compose_file" in *"'"*) fail "COMPOSE_FILE in .env can't contain a single quote (')." ;; esac
  (
    umask 077
    {
      printf '%s\n' "$ENV_BEGIN"
      printf 'DOMAIN=%s\n' "$DOMAIN"
      printf "ACME_EMAIL='%s'\n" "$ACME_EMAIL"
      printf 'TURN_SECRET=%s\n' "$TURN_SECRET"
      printf 'SECRET_KEY=%s\n' "$SECRET_KEY"
      printf "ADMIN_PASSWORD='%s'\n" "$ADMIN_PASSWORD"
      printf '%s\n' "# Relay on port 443 (TURN over TLS), optional: README.md → \"Relay on port 443\". TURN_TLS is"
      printf '%s\n' "# your choice; COMPOSE_FILE lists docker-compose.turn-tls.yml only while it's on and its"
      printf '%s\n' "# checks passed. TURN_TLS_UPSTREAM is where Caddy hands relay connections to coturn."
      printf 'TURN_TLS=%s\n' "$TURN_TLS"
      printf 'TURN_TLS_DOMAIN=%s\n' "$TURN_TLS_DOMAIN"
      printf 'TURN_TLS_UPSTREAM=%s\n' "$TURN_TLS_UPSTREAM"
      if [ -n "$compose_file" ]; then printf "COMPOSE_FILE='%s'\n" "$compose_file"; fi
      printf '%s\n' "$ENV_END"
      if [ -n "$kept" ]; then printf '%s\n' "$kept"; fi
    } > .env.new
    mv -f .env.new .env
  )
  chmod 600 .env
}

umask 077
write_env
echo "Wrote .env"

# coturn must never relay to this machine: deny every global address it has (IPv4 and IPv6).
HOST_DENY=$(mktemp)
trap 'rm -f "$HOST_DENY"' EXIT
if command -v ip &>/dev/null; then
  ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | sort -u | while read -r addr; do
    [[ "$addr" =~ ^[0-9a-fA-F:.]+$ ]] && echo "denied-peer-ip=$addr"
  done > "$HOST_DENY" || true
fi

# Values are validated above. They're passed through the environment rather than on a command
# line, so the TURN secret never shows up in the process list.
EXTERNAL_IP="$EXTERNAL_IP" TURN_SECRET="$TURN_SECRET" DOMAIN="$DOMAIN" HOST_DENY="$HOST_DENY" \
  awk '
    function fill(placeholder, value,    at, out) {
      out = ""
      while ((at = index($0, placeholder)) > 0) {
        out = out substr($0, 1, at - 1) value
        $0 = substr($0, at + length(placeholder))
      }
      $0 = out $0
    }
    $0 == "HOST_ADDRESSES_PLACEHOLDER" { while ((getline l < ENVIRON["HOST_DENY"]) > 0) print l; next }
    {
      fill("EXTERNAL_IP_PLACEHOLDER", ENVIRON["EXTERNAL_IP"])
      fill("TURN_SECRET_PLACEHOLDER", ENVIRON["TURN_SECRET"])
      fill("DOMAIN_PLACEHOLDER", ENVIRON["DOMAIN"])
      print
    }
  ' turnserver.conf.template > turnserver.conf
# coturn runs as nobody/nogroup (65534) inside its container and needs to read this file.
chgrp 65534 turnserver.conf || fail "Couldn't give coturn's group (65534) access to turnserver.conf."
chmod 640 turnserver.conf
umask 022
echo "Wrote turnserver.conf ($(wc -l < "$HOST_DENY" | tr -d ' ') host address(es) denied as relay peers)"

# ── Firewall ──────────────────────────────────────────────────────────────

if command -v ufw &>/dev/null; then
  # Find every port SSH listens on, so enabling the firewall can't lock you out.
  SSH_PORTS=$(
    {
      (sshd -T 2>/dev/null || true) | awk '$1 == "port" { print $2 } $1 == "listenaddress" { n = split($2, a, ":"); print a[n] }'
      (ss -Htlnp 2>/dev/null || true) | awk '/"sshd"/ { n = split($4, a, ":"); print a[n] }'
      if [ -n "${SSH_CONNECTION:-}" ]; then echo "${SSH_CONNECTION##* }"; fi # the port you're connected to
    } | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ' || true
  )
  SSH_PORTS=${SSH_PORTS:-22}
  echo
  echo "Firewall (ufw): SSH will stay open on port(s): $SSH_PORTS"
  read -rp "Is that right? Type 'yes' to enable the firewall, or enter the SSH port(s) to allow: " ANSWER
  if [ "$ANSWER" != "yes" ]; then
    [[ "$ANSWER" =~ ^[0-9]+([[:space:],]+[0-9]+)*$ ]] || fail "Firewall not changed. Re-run and confirm the SSH port(s)."
    SSH_PORTS=$(echo "$ANSWER" | tr ',' ' ')
  fi
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  for p in $SSH_PORTS; do ufw allow "$p"/tcp >/dev/null; done # SSH
  ufw allow 80/tcp >/dev/null          # HTTP (certificate issuance + redirect)
  ufw allow 443/tcp >/dev/null         # HTTPS (and TURN over TLS, if the relay on port 443 is on)
  ufw allow 3478/tcp >/dev/null        # TURN / STUN (and Caddy's way to coturn for TURN over TLS)
  ufw allow 3478/udp >/dev/null        # TURN / STUN
  ufw allow 61000:65535/udp >/dev/null # TURN relay ports
  # Rules from older versions of this script (TLS relay, old port range)
  ufw delete allow 5349/tcp >/dev/null 2>&1 || true
  ufw delete allow 5349/udp >/dev/null 2>&1 || true
  ufw delete allow 49152:65535/udp >/dev/null 2>&1 || true
  ufw logging off >/dev/null # no log of who knocked on which port
  ufw --force enable
else
  echo "Note: ufw not found. Make sure these ports are open:"
  echo "  TCP: your SSH port, 80, 443, 3478"
  echo "  UDP: 3478, 61000-65535"
  if [ -n "$TURN_TLS_ACTIVE" ]; then
    echo "  and, for the relay on port 443, from Caddy's container to $TURN_TLS_UPSTREAM"
  fi
fi

# ── Build ─────────────────────────────────────────────────────────────────

# Turns the relay on port 443 off for this deployment (TURN_TLS and the hostname stay as they are).
turn_tls_off() {
  warn "$1. The relay on port 443 is off for this deployment; the rest is unaffected."
  TURN_TLS_ACTIVE=""
  TURN_TLS_OFF_REASON=$1
  write_env
}

echo
echo "Pulling and building images..."
docker compose pull --ignore-buildable 2>/dev/null || docker compose pull coturn
if [ -n "$TURN_TLS_ACTIVE" ]; then
  # Compile Caddy with the layer4 plugin on its own first: doing it while the web app builds can run
  # a 1GB server out of memory. The next step reuses the result.
  echo "Compiling Caddy with the layer4 plugin for the relay on port 443 (a few minutes the first time)..."
  docker build --pull --target caddy-l4 --output type=cacheonly -f Dockerfile.web . ||
    turn_tls_off "Compiling Caddy with the layer4 plugin failed (see the output above)"
fi
if [ -n "$TURN_TLS_ACTIVE" ] && ! docker compose build --pull; then
  turn_tls_off "Building the images with the relay on port 443 failed (see the output above)"
fi
if [ -z "$TURN_TLS_ACTIVE" ]; then
  docker compose build --pull
fi

# With the relay on, check Caddy's configuration before replacing the running containers.
CADDY_VALIDATE="docker compose run --rm --no-deps -T web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
if [ -n "$TURN_TLS_ACTIVE" ]; then
  echo "Checking the web server configuration..."
  if ! $CADDY_VALIDATE &>/dev/null; then
    turn_tls_off "The web server configuration for the relay on port 443 doesn't validate (to see why:
  COMPOSE_FILE=docker-compose.yml:docker-compose.turn-tls.yml $CADDY_VALIDATE)"
    docker compose build --pull
  fi
fi

# ── Start ─────────────────────────────────────────────────────────────────

start_containers() {
  docker compose up -d
  # Pick up a changed turnserver.conf on re-deploys
  docker compose restart coturn >/dev/null
}

# Waits up to 2 minutes for https://$DOMAIN/api/config; sets CONFIG to its answer.
site_answers() {
  CONFIG=""
  for _ in $(seq 1 30); do
    if CONFIG=$(curl -fsS --max-time 5 "https://$DOMAIN/api/config" 2>/dev/null); then return 0; fi
    CONFIG=""
    sleep 4
  done
  return 1
}

echo "Starting containers..."
start_containers

echo
echo "Checking https://$DOMAIN/api/config (the HTTPS certificate can take a minute)..."
if ! site_answers && [ -n "$TURN_TLS_ACTIVE" ]; then
  turn_tls_off "https://$DOMAIN/api/config didn't answer with the relay on port 443 on; going back without it"
  docker compose build --pull
  start_containers
  echo "Checking https://$DOMAIN/api/config again..."
  site_answers || true
fi
if [ -z "$CONFIG" ]; then
  warn "https://$DOMAIN/api/config did not answer after 2 minutes."
  echo "  Check that $DOMAIN points at $EXTERNAL_IP and ports 80/443 are open, then run:" >&2
  echo "  docker compose ps   (logs are off by default; see DOCS.md → Debugging with logs)" >&2
  exit 1
fi
case "$CONFIG" in
  *'"misconfigured":true'*)
    warn "the server reports a configuration error: $CONFIG"
    echo "  Check ADMIN_PASSWORD and SECRET_KEY in .env, then re-run this script." >&2
    exit 1
    ;;
  *'"mode":"private"'*) ;;
  *)
    warn "unexpected answer from the server: $CONFIG"
    exit 1
    ;;
esac

# Sends a STUN Binding request (RFC 8489) over TLS to the relay on port 443, checking the
# certificate. coturn answers with a Binding success response, whose type is 0x0101. Standard
# input stays open for 3 seconds so the answer can arrive before openssl hangs up. This checks the
# TLS path to coturn only, not that relaying works (see DOCS.md → "TURN over TLS on port 443").
turn_tls_answers() {
  local reply
  reply=$(
    { printf '\000\001\000\000\041\022\244\102vchat-deploy'; sleep 3; } |
      timeout 15 openssl s_client -quiet -no_ign_eof -connect "$TURN_TLS_DOMAIN:443" \
        -servername "$TURN_TLS_DOMAIN" -verify_hostname "$TURN_TLS_DOMAIN" -verify_return_error 2>/dev/null |
      head -c 2 | od -An -tx1 | tr -d ' \n'
  ) || true
  [ "$reply" = "0101" ]
}

if [ -n "$TURN_TLS_ACTIVE" ]; then
  echo "Checking the relay at $TURN_TLS_DOMAIN:443 (its certificate can take a minute)..."
  TURN_TLS_OK=""
  for _ in $(seq 1 12); do
    if turn_tls_answers; then TURN_TLS_OK=1; break; fi
    sleep 2
  done
  if [ -n "$TURN_TLS_OK" ]; then
    echo "It answers over TLS with a valid certificate. That doesn't prove relaying works: test a call"
    echo "from an HTTPS-only network (DOCS.md → \"TURN over TLS on port 443\" → \"Checks after enabling\")."
  else
    warn "the relay didn't answer on $TURN_TLS_DOMAIN:443 with a valid certificate yet."
    echo "  Calls still work; browsers that can't use it fall back to port 3478. Check that" >&2
    echo "  $TURN_TLS_DOMAIN points at $EXTERNAL_IP and ports 80 and 443 are open, then run this" >&2
    echo "  script again (or test with: openssl s_client -connect $TURN_TLS_DOMAIN:443 -servername $TURN_TLS_DOMAIN)." >&2
  fi
fi

echo
echo "=== Deployed! ==="
echo "Site:        https://$DOMAIN"
echo "Owner login: https://$DOMAIN/admin"
if [ -n "$TURN_TLS_ACTIVE" ]; then
  echo "Relay:       $DOMAIN:3478 (UDP/TCP) and $TURN_TLS_DOMAIN:443 (TLS)"
else
  echo "Relay:       $DOMAIN:3478 (UDP/TCP); port 443: $TURN_TLS_OFF_REASON"
fi
echo
echo "Sign in, create a room, and send the invite link to whoever you want to talk to."

#!/usr/bin/env bash
# Interactive deployment of vchat on a Linux server with Docker. Run with: sudo bash deploy.sh
# Safe to re-run: existing secrets and hand-added settings are kept, so invite links keep working.
set -euo pipefail
cd "$(dirname "$0")"

echo "=== vchat deploy ==="
echo

fail() {
  echo "Error: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "Run as root (sudo bash deploy.sh) — it configures the firewall and Docker."
command -v docker &>/dev/null || fail "Docker is not installed. Install it first: curl -fsSL https://get.docker.com | sh"
docker compose version &>/dev/null || fail "The Docker Compose plugin is not installed."
command -v openssl &>/dev/null || fail "openssl is required."
# docker-compose.yml builds the relay settings from nested variables, which Compose expands
# correctly from version 2.20 on.
COMPOSE_VERSION=$(docker compose version --short 2>/dev/null || true)
COMPOSE_VERSION=${COMPOSE_VERSION#v}
if [[ "$COMPOSE_VERSION" =~ ^([0-9]+)\.([0-9]+) ]] &&
  ((BASH_REMATCH[1] < 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] < 20))); then
  fail "Docker Compose $COMPOSE_VERSION is too old (2.20 or newer is needed). Update Docker: curl -fsSL https://get.docker.com | sh"
fi

# Reuse a previous value from .env (re-deploys). Strips one pair of matching quotes.
from_env() {
  local v
  [ -f .env ] || return 0
  v=$(grep -E "^$1=" .env | head -1 | cut -d= -f2-) || true
  if [[ "$v" =~ ^\'(.*)\'$ ]] || [[ "$v" =~ ^\"(.*)\"$ ]]; then v=${BASH_REMATCH[1]}; fi
  printf '%s' "$v"
}

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

DEFAULT_DOMAIN=$(from_env DOMAIN)
read -rp "Domain (e.g. call.example.com)${DEFAULT_DOMAIN:+ [$DEFAULT_DOMAIN]}: " DOMAIN
DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}
DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
[[ "$DOMAIN" =~ $HOSTNAME_RE ]] || fail "'$DOMAIN' is not a valid domain name."

DEFAULT_EMAIL=$(from_env ACME_EMAIL)
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

# TURN over TLS on port 443 shares the port with the website, so it needs a hostname of its own:
# Caddy tells relay connections apart by the name the browser asks for (TLS SNI).
DEFAULT_TURN_TLS_DOMAIN=$(from_env TURN_TLS_DOMAIN)
DEFAULT_TURN_TLS_DOMAIN=${DEFAULT_TURN_TLS_DOMAIN:-turn.$DOMAIN}
echo
echo "Relay on port 443: some networks (offices, hotels, some mobile carriers) only let HTTPS out,"
echo "which blocks the relay's usual port 3478. The relay can also answer there, on port 443 (TURN"
echo "over TLS), under a hostname of its own. It needs a DNS A record for that name pointing at"
echo "$EXTERNAL_IP, set to DNS only (not proxied through a CDN such as Cloudflare). Without it,"
echo "everything else works as usual."
read -rp "Relay hostname, or 'none' to skip [$DEFAULT_TURN_TLS_DOMAIN]: " TURN_TLS_DOMAIN
TURN_TLS_DOMAIN=${TURN_TLS_DOMAIN:-$DEFAULT_TURN_TLS_DOMAIN}
TURN_TLS_DOMAIN=$(printf '%s' "$TURN_TLS_DOMAIN" | tr '[:upper:]' '[:lower:]')
TURN_TLS_OFF_REASON=""
if [ "$TURN_TLS_DOMAIN" = "none" ]; then
  TURN_TLS_DOMAIN=""
  TURN_TLS_OFF_REASON="skipped"
else
  [[ "$TURN_TLS_DOMAIN" =~ $HOSTNAME_RE ]] || fail "'$TURN_TLS_DOMAIN' is not a valid hostname (type 'none' to skip)."
  [ "$TURN_TLS_DOMAIN" != "$DOMAIN" ] || fail "The relay needs a hostname other than $DOMAIN (e.g. turn.$DOMAIN)."
  TURN_TLS_IPS=$(resolve_ipv4 "$TURN_TLS_DOMAIN" | sort -u | paste -sd ' ' -)
  if [ "$TURN_TLS_IPS" = "$EXTERNAL_IP" ]; then
    echo "$TURN_TLS_DOMAIN points at this server: the relay will also answer on port 443."
  else
    if [ -z "$TURN_TLS_IPS" ]; then
      echo "WARNING: $TURN_TLS_DOMAIN has no IPv4 (A) record yet." >&2
    else
      echo "WARNING: $TURN_TLS_DOMAIN points at $TURN_TLS_IPS, not at this server ($EXTERNAL_IP)." >&2
      echo "  If it's proxied through a CDN (e.g. Cloudflare's orange cloud), set it to DNS only." >&2
    fi
    echo "  Skipping the relay on port 443 for now; the rest of the deployment is unaffected." >&2
    echo "  Once the record points here, run this script again." >&2
    TURN_TLS_OFF_REASON="$TURN_TLS_DOMAIN doesn't point at this server yet"
    TURN_TLS_DOMAIN=""
  fi
fi

# Where Caddy hands TURN-over-TLS connections to coturn. coturn relays from the address a client
# connected to, so this must be the address outside traffic to the relay arrives at: the public IP
# itself when it's on an interface, otherwise (1:1 NAT, as on AWS or Google Cloud) the source
# address of the default route. Left empty, Caddy connects through the domain (docker-compose.yml).
LOCAL_IP=""
if command -v ip &>/dev/null; then
  if ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -xF "$EXTERNAL_IP" >/dev/null; then
    LOCAL_IP=$EXTERNAL_IP
  else
    LOCAL_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)
  fi
fi
valid_ipv4 "$LOCAL_IP" || LOCAL_IP=""
TURN_TLS_UPSTREAM=${LOCAL_IP:+$LOCAL_IP:3478}

EXISTING_PASSWORD=$(from_env ADMIN_PASSWORD)
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

# Secrets: reuse on re-deploys so invite links and the relay keep working
TURN_SECRET=$(from_env TURN_SECRET)
TURN_SECRET=${TURN_SECRET:-$(openssl rand -hex 32)}
SECRET_KEY=$(from_env SECRET_KEY)
SECRET_KEY=${SECRET_KEY:-$(openssl rand -hex 32)}
[[ "$TURN_SECRET" =~ ^[A-Za-z0-9]+$ && "$SECRET_KEY" =~ ^[A-Za-z0-9]+$ ]] || fail "TURN_SECRET/SECRET_KEY in .env must be alphanumeric."

# ── Files (readable only by root; coturn's group can read its config) ─────

# Settings added to .env by hand (email, Cloudflare Access, ...) are carried over as they are.
KEPT_SETTINGS=""
if [ -f .env ]; then
  KEPT_SETTINGS=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env |
    grep -vE '^(DOMAIN|ACME_EMAIL|TURN_TLS_DOMAIN|TURN_TLS_UPSTREAM|TURN_SECRET|SECRET_KEY|ADMIN_PASSWORD)=' || true)
fi

write_env() {
  (
    umask 077
    cat > .env <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL='$ACME_EMAIL'
# Relay over TLS on port 443 (turns:), through Caddy; empty TURN_TLS_DOMAIN turns it off.
# TURN_TLS_UPSTREAM is where Caddy hands those connections to coturn (see docker-compose.yml).
TURN_TLS_DOMAIN=$TURN_TLS_DOMAIN
TURN_TLS_UPSTREAM=$TURN_TLS_UPSTREAM
TURN_SECRET=$TURN_SECRET
SECRET_KEY=$SECRET_KEY
ADMIN_PASSWORD='$ADMIN_PASSWORD'
EOF
    if [ -n "$KEPT_SETTINGS" ]; then printf '%s\n' "$KEPT_SETTINGS" >> .env; fi
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
  ufw allow 443/tcp >/dev/null         # HTTPS, and TURN over TLS (turns:) through Caddy
  ufw allow 3478/tcp >/dev/null        # TURN / STUN; also how Caddy reaches coturn for turns:
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
  echo "  TCP: your SSH port, 80, 443 (HTTPS and the relay over TLS), 3478"
  echo "  UDP: 3478, 61000-65535"
fi

# ── Start ─────────────────────────────────────────────────────────────────

echo
echo "Pulling and building images (compiling Caddy takes a few minutes the first time)..."
docker compose pull --ignore-buildable 2>/dev/null || docker compose pull coturn
# Compile Caddy and its layer4 plugin on their own first: doing it while the web app builds can run
# a 1GB server out of memory. The result is cached and reused by the next step (which, if this step
# fails, builds everything again and reports the error).
docker build --pull --target caddy --output type=cacheonly -f Dockerfile.web . ||
  echo "Note: building Caddy separately didn't work; building everything together instead."
docker compose build --pull

# Check the new web server configuration before replacing the running containers. If only the
# relay-over-TLS part is at fault, carry on without it rather than take the site down.
CADDY_VALIDATE=(docker compose run --rm --no-deps -T web caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile)
echo "Checking the web server configuration..."
if ! "${CADDY_VALIDATE[@]}" &>/dev/null; then
  if [ -n "$TURN_TLS_DOMAIN" ]; then
    echo "WARNING: the configuration for the relay on port 443 doesn't validate; leaving it off." >&2
    echo "  To see why: set TURN_TLS_DOMAIN=$TURN_TLS_DOMAIN in .env and run: ${CADDY_VALIDATE[*]}" >&2
    TURN_TLS_OFF_REASON="its web server configuration didn't validate"
    TURN_TLS_DOMAIN=""
    write_env
  fi
  "${CADDY_VALIDATE[@]}" &>/dev/null ||
    fail "The web server configuration doesn't validate (the running site is unchanged). To see why: ${CADDY_VALIDATE[*]}"
fi

echo "Starting containers..."
docker compose up -d
# Pick up a changed turnserver.conf on re-deploys
docker compose restart coturn >/dev/null

echo
echo "Checking https://$DOMAIN/api/config (the HTTPS certificate can take a minute)..."
CONFIG=""
for _ in $(seq 1 30); do
  if CONFIG=$(curl -fsS --max-time 5 "https://$DOMAIN/api/config" 2>/dev/null); then break; fi
  CONFIG=""
  sleep 4
done
if [ -z "$CONFIG" ]; then
  echo "WARNING: https://$DOMAIN/api/config did not answer after 2 minutes." >&2
  echo "  Check that $DOMAIN points at $EXTERNAL_IP and ports 80/443 are open, then run:" >&2
  echo "  docker compose ps   (logs are off by default; see DOCS.md → Debugging with logs)" >&2
  exit 1
fi
case "$CONFIG" in
  *'"misconfigured":true'*)
    echo "WARNING: the server reports a configuration error: $CONFIG" >&2
    echo "  Check ADMIN_PASSWORD and SECRET_KEY in .env, then re-run this script." >&2
    exit 1
    ;;
  *'"mode":"private"'*) ;;
  *)
    echo "WARNING: unexpected answer from the server: $CONFIG" >&2
    exit 1
    ;;
esac

# Sends a STUN Binding request (RFC 8489) over TLS to the relay on port 443, checking the
# certificate. coturn answers with a Binding success response, whose type is 0x0101. Standard
# input stays open for 3 seconds so the answer can arrive before openssl hangs up.
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

if [ -n "$TURN_TLS_DOMAIN" ]; then
  echo "Checking the relay at $TURN_TLS_DOMAIN:443 (its certificate can take a minute)..."
  TURN_TLS_OK=""
  for _ in $(seq 1 12); do
    if turn_tls_answers; then TURN_TLS_OK=1; break; fi
    sleep 2
  done
  if [ -z "$TURN_TLS_OK" ]; then
    echo "WARNING: the relay didn't answer on $TURN_TLS_DOMAIN:443 with a valid certificate yet." >&2
    echo "  Calls still work; browsers that can't use it fall back to port 3478. Check that" >&2
    echo "  $TURN_TLS_DOMAIN points at $EXTERNAL_IP and ports 80 and 443 are open, then run this" >&2
    echo "  script again (or test with: openssl s_client -connect $TURN_TLS_DOMAIN:443 -servername $TURN_TLS_DOMAIN)." >&2
  fi
fi

echo
echo "=== Deployed! ==="
echo "Site:        https://$DOMAIN"
echo "Owner login: https://$DOMAIN/admin"
if [ -n "$TURN_TLS_DOMAIN" ]; then
  echo "Relay:       $DOMAIN:3478 (UDP/TCP) and $TURN_TLS_DOMAIN:443 (TLS)"
else
  echo "Relay:       $DOMAIN:3478 (UDP/TCP); port 443 off: $TURN_TLS_OFF_REASON"
fi
echo
echo "Sign in, create a room, and send the invite link to whoever you want to talk to."

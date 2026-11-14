#!/usr/bin/env bash
# Interactive deployment of vchat on a Linux server with Docker. Run with: sudo bash deploy.sh
# Safe to re-run: existing secrets are reused, so invite links keep working.
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

# ── Inputs ────────────────────────────────────────────────────────────────

DEFAULT_DOMAIN=$(from_env DOMAIN)
read -rp "Domain (e.g. call.example.com)${DEFAULT_DOMAIN:+ [$DEFAULT_DOMAIN]}: " DOMAIN
DOMAIN=${DOMAIN:-$DEFAULT_DOMAIN}
DOMAIN=$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail "'$DOMAIN' is not a valid domain name."

DEFAULT_EMAIL=$(from_env ACME_EMAIL)
read -rp "Email for HTTPS certificates (Let's Encrypt)${DEFAULT_EMAIL:+ [$DEFAULT_EMAIL]}: " ACME_EMAIL
ACME_EMAIL=${ACME_EMAIL:-$DEFAULT_EMAIL}
[[ "$ACME_EMAIL" =~ ^[^[:space:]@\'\"\\\$\`]+@[^[:space:]@\'\"\\\$\`]+\.[^[:space:]@\'\"\\\$\`]+$ ]] || fail "'$ACME_EMAIL' is not a valid email address."

# The public IPv4 address is needed by the TURN relay. Prefer the domain's own DNS record (no third
# party involved); ask ifconfig.me only if DNS has no answer.
DETECTED_IP=""
if command -v dig &>/dev/null; then
  DETECTED_IP=$(dig +short "$DOMAIN" A 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)
fi
if [ -z "$DETECTED_IP" ] && command -v getent &>/dev/null; then
  DETECTED_IP=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)
fi
if [ -z "$DETECTED_IP" ]; then
  echo "Notice: $DOMAIN has no IPv4 DNS record yet; asking ifconfig.me for this server's public address."
  DETECTED_IP=$(curl -fs4 --max-time 10 https://ifconfig.me || true)
fi
valid_ipv4 "$DETECTED_IP" || DETECTED_IP=""
read -rp "This server's public IPv4 address${DETECTED_IP:+ [$DETECTED_IP]}: " EXTERNAL_IP
EXTERNAL_IP=${EXTERNAL_IP:-$DETECTED_IP}
valid_ipv4 "$EXTERNAL_IP" || fail "'$EXTERNAL_IP' is not an IPv4 address."
echo "Public IP: $EXTERNAL_IP"

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

umask 077
cat > .env <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL='$ACME_EMAIL'
TURN_SECRET=$TURN_SECRET
SECRET_KEY=$SECRET_KEY
ADMIN_PASSWORD='$ADMIN_PASSWORD'
EOF
chmod 600 .env
echo "Wrote .env"

# coturn must never relay to this machine: deny every global address it has (IPv4 and IPv6).
HOST_DENY=$(mktemp)
trap 'rm -f "$HOST_DENY"' EXIT
if command -v ip &>/dev/null; then
  ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | sort -u | while read -r addr; do
    [[ "$addr" =~ ^[0-9a-fA-F:.]+$ ]] && echo "denied-peer-ip=$addr"
  done > "$HOST_DENY" || true
fi

# Values are validated above, so they contain no sed metacharacters.
sed -e "s|EXTERNAL_IP_PLACEHOLDER|$EXTERNAL_IP|g" \
    -e "s|TURN_SECRET_PLACEHOLDER|$TURN_SECRET|g" \
    -e "s|DOMAIN_PLACEHOLDER|$DOMAIN|g" \
    turnserver.conf.template |
  awk -v f="$HOST_DENY" '$0 == "HOST_ADDRESSES_PLACEHOLDER" { while ((getline l < f) > 0) print l; next } { print }' \
    > turnserver.conf
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
  ufw allow 443/tcp >/dev/null         # HTTPS
  ufw allow 3478/tcp >/dev/null        # TURN / STUN
  ufw allow 3478/udp >/dev/null        # TURN / STUN
  ufw allow 61000:65535/udp >/dev/null # TURN relay ports
  # Rules from older versions of this script (TLS relay, old port range)
  ufw delete allow 5349/tcp >/dev/null 2>&1 || true
  ufw delete allow 5349/udp >/dev/null 2>&1 || true
  ufw delete allow 49152:65535/udp >/dev/null 2>&1 || true
  ufw --force enable
else
  echo "Note: ufw not found. Make sure these ports are open:"
  echo "  TCP: your SSH port, 80, 443, 3478"
  echo "  UDP: 3478, 61000-65535"
fi

# ── Start ─────────────────────────────────────────────────────────────────

echo
echo "Pulling and building images..."
docker compose pull --ignore-buildable 2>/dev/null || docker compose pull coturn
docker compose build --pull
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

echo
echo "=== Deployed! ==="
echo "Site:        https://$DOMAIN"
echo "Owner login: https://$DOMAIN/admin"
echo
echo "Sign in, create a room, and send the invite link to whoever you want to talk to."

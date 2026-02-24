#!/usr/bin/env bash
set -euo pipefail

echo "=== vchat deploy ==="
echo

# Check for Docker
if ! command -v docker &>/dev/null; then
  echo "Error: Docker is not installed. Install it first:"
  echo "  curl -fsSL https://get.docker.com | sh"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  echo "Error: Docker Compose plugin is not installed."
  exit 1
fi

# Detect external IP
EXTERNAL_IP=$(curl -s4 https://ifconfig.me || curl -s4 https://api.ipify.org || echo "")
if [ -z "$EXTERNAL_IP" ]; then
  echo "Could not detect external IP automatically."
  read -rp "Enter your VPS external IP: " EXTERNAL_IP
fi
echo "External IP: $EXTERNAL_IP"

# Prompt for domain
read -rp "Domain (e.g. vchat.xyz): " DOMAIN
if [ -z "$DOMAIN" ]; then
  echo "Error: Domain is required."
  exit 1
fi

# Prompt for ACME email
read -rp "Email for Let's Encrypt ($DOMAIN): " ACME_EMAIL
if [ -z "$ACME_EMAIL" ]; then
  echo "Error: Email is required for TLS certificates."
  exit 1
fi

# Prompt for basic auth password
read -rsp "Basic auth password (protects the site): " AUTH_PASSWORD
echo
if [ -z "$AUTH_PASSWORD" ]; then
  echo "Error: Password is required."
  exit 1
fi

# Generate bcrypt hash for basic auth
echo "Generating bcrypt hash..."
BASIC_AUTH_HASH=$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$AUTH_PASSWORD")

# Generate strong TURN password
TURN_PASSWORD=$(openssl rand -base64 24)
TURN_USER="vchat"

echo
echo "Configuration:"
echo "  Domain:      $DOMAIN"
echo "  Email:       $ACME_EMAIL"
echo "  External IP: $EXTERNAL_IP"
echo "  TURN user:   $TURN_USER"
echo

# Write .env
cat > .env <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
TURN_USER=$TURN_USER
TURN_PASSWORD=$TURN_PASSWORD
BASIC_AUTH_HASH=$BASIC_AUTH_HASH
VITE_TURN_URL=turn:$DOMAIN:3478
VITE_TURN_USER=$TURN_USER
VITE_TURN_CREDENTIAL=$TURN_PASSWORD
EOF
echo "Wrote .env"

# Template turnserver.conf
sed -e "s|EXTERNAL_IP_PLACEHOLDER|$EXTERNAL_IP|g" \
    -e "s|TURN_PASSWORD_PLACEHOLDER|$TURN_PASSWORD|g" \
    -e "s|DOMAIN_PLACEHOLDER|$DOMAIN|g" \
    turnserver.conf.template > turnserver.conf
echo "Wrote turnserver.conf"

# Configure firewall (ufw)
if command -v ufw &>/dev/null; then
  echo "Configuring firewall (ufw)..."
  ufw allow 22/tcp       # SSH
  ufw allow 80/tcp       # HTTP (ACME)
  ufw allow 443/tcp      # HTTPS
  ufw allow 3478/tcp     # TURN
  ufw allow 3478/udp     # TURN
  ufw allow 5349/tcp     # TURNS
  ufw allow 5349/udp     # TURNS
  ufw allow 49152:65535/udp  # TURN relay
  ufw --force enable
  echo "Firewall configured."
else
  echo "Note: ufw not found. Make sure these ports are open:"
  echo "  TCP: 22, 80, 443, 3478, 5349"
  echo "  UDP: 3478, 5349, 49152-65535"
fi

echo
echo "Building and starting containers..."

# Stage 1: Start web first to obtain TLS certificates
echo "Starting web service to obtain TLS certificate..."
docker compose up -d --build web

# Poll for TLS cert (up to 120 seconds)
echo "Waiting for TLS certificate..."
CERT_WAIT=0
CERT_MAX=120
while [ $CERT_WAIT -lt $CERT_MAX ]; do
  # Check if cert file exists in the caddy data volume
  if docker compose exec -T web test -d /data/caddy/certificates 2>/dev/null; then
    CERT_COUNT=$(docker compose exec -T web find /data/caddy/certificates -name "*.crt" 2>/dev/null | wc -l || echo "0")
    if [ "$CERT_COUNT" -gt 0 ]; then
      echo "TLS certificate obtained!"
      break
    fi
  fi
  sleep 5
  CERT_WAIT=$((CERT_WAIT + 5))
  echo "  Waiting for cert... (${CERT_WAIT}s/${CERT_MAX}s)"
done

if [ $CERT_WAIT -ge $CERT_MAX ]; then
  echo "Warning: TLS certificate may not be ready yet. Starting remaining services anyway."
fi

# Stage 2: Start signaling and coturn
echo "Starting signaling and coturn services..."
docker compose up -d --build signaling coturn

echo
echo "=== Deployed! ==="
echo "Site: https://$DOMAIN"
echo "Username: vchat"
echo "Password: (the one you just entered)"
echo
echo "Share the URL and password with your friends."

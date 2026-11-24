#!/bin/bash
# Entrypoint wrapper for the protonmail-bridge service in compose.yaml.
#
# Runs Proton Bridge with its gRPC service (the API Proton's desktop app uses)
# instead of --noninteractive, and shares that service with MailPouch only, so
# MailPouch can read which sender addresses the Proton account has. IMAP and
# SMTP behave exactly as before.
#
# Bridge writes the service's token and certificate to its config directory
# and listens on a unix socket in $TMPDIR. This script points $TMPDIR at the
# volume shared with MailPouch, copies the config file there whenever Bridge
# rewrites it (every start), and gives both to MailPouch's user. Nothing else
# from Bridge's volume is shared.
#
# Everything else is the image's own entrypoint, run unchanged except for the
# final command line. `init` (interactive login) is passed straight through.
set -euo pipefail

UPSTREAM=/protonmail/entrypoint.sh
if [[ "${1:-}" == init ]]; then
  exec bash "$UPSTREAM" "$@"
fi

SHARE=${MAILPOUCH_BRIDGE_GRPC_DIR:-/run/mailpouch-bridge}
OWNER=${MAILPOUCH_BRIDGE_GRPC_OWNER:-1000:1000}
CONFIG="$HOME/.config/protonmail/bridge-v3/grpcServerConfig.json"
SHARED_CONFIG="$SHARE/grpcServerConfig.json"

# The image's entrypoint ends in `exec /protonmail/proton-bridge --noninteractive`.
# Run the bridge binary itself with --grpc: the launcher would try to start the
# desktop GUI when it sees --grpc.
patched=$(mktemp)
sed 's|^\([[:space:]]*\)exec /protonmail/proton-bridge --noninteractive |\1exec /protonmail/bridge --grpc |' \
  "$UPSTREAM" > "$patched"
if ! grep -q 'exec /protonmail/bridge --grpc ' "$patched"; then
  echo "bridge-grpc.sh: the Bridge image's entrypoint changed; cannot enable the gRPC service" >&2
  exit 1
fi

# Start from an empty share so MailPouch never reads a previous run's token.
mkdir -p "$SHARE"
find "$SHARE" -mindepth 1 -delete
chown "$OWNER" "$SHARE"
chmod 0700 "$SHARE"
rm -f "$CONFIG"

# Publish the config once Bridge has written it and its socket exists.
publish() {
  local socket
  set +e  # a failed attempt is retried on the next pass, never fatal
  while sleep 2; do
    [[ -s "$CONFIG" ]] || continue
    cmp -s "$CONFIG" "$SHARED_CONFIG" 2>/dev/null && continue
    socket=$(grep -o '"fileSocketPath":"[^"]*"' "$CONFIG" | cut -d'"' -f4) || continue
    [[ -S "$socket" ]] || continue
    chown "$OWNER" "$socket" && chmod 0600 "$socket"
    cp "$CONFIG" "$SHARE/.grpcServerConfig.json.tmp"
    chown "$OWNER" "$SHARE/.grpcServerConfig.json.tmp"
    chmod 0600 "$SHARE/.grpcServerConfig.json.tmp"
    mv -f "$SHARE/.grpcServerConfig.json.tmp" "$SHARED_CONFIG"
    echo "Bridge gRPC service shared with MailPouch at $SHARE"
  done
}
publish &

export TMPDIR="$SHARE"
exec bash "$patched" "$@"

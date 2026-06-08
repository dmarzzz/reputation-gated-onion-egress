#!/usr/bin/env bash
# CLIENT / LAPTOP role: prove membership and tunnel out through the remote gateway.
#
# Runs the two client-side pieces:
#   1. a client-only Tor SOCKS (no onion) unless you point at an existing one,
#   2. client/shim.mjs, the local HTTP proxy that mints a Semaphore proof and
#      dials the gateway's .onion over Tor.
#
# Requires:
#   RGOE_ONION   the gateway's onion address (from the droplet's run-gateway.sh)
#   RGOE_SECRET  this member's secret (from `node group/enroll.mjs`; or a .secret file)
#
# This box must hold the SAME group/members.json as the gateway (public set), or
# every proof is built against the wrong Merkle root and the gateway drops it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${RGOE_SECRET:-}" ] && [ -f .secret ]; then export RGOE_SECRET="$(cat .secret)"; fi
if [ -z "${RGOE_SECRET:-}" ]; then
  echo "no RGOE_SECRET. Run:  node group/enroll.mjs   then   export RGOE_SECRET=..." >&2
  exit 1
fi
# Default to the live deployed gateway (DigitalOcean NYC, 204.48.28.220) so a
# friend can run with no args. Override RGOE_ONION to point at a different box.
export RGOE_ONION="${RGOE_ONION:-ezguggje6sbldhw4pl5nudwg2mrwkb5zzyu3a26qc4eka2ur24bv3eqd.onion}"
echo "gateway onion: ${RGOE_ONION}"

# SOCKS source: reuse an existing Tor if RGOE_TOR_PORT is already set (e.g. system
# tor 9050), otherwise start our own client-only Tor on 9260.
if [ -n "${RGOE_TOR_PORT:-}" ]; then
  echo "using existing Tor SOCKS at 127.0.0.1:${RGOE_TOR_PORT}"
else
  bash scripts/start-tor-client.sh
  export RGOE_TOR_PORT=9260
fi

if pgrep -f "client/shim.mjs" >/dev/null; then
  echo "shim already running"
else
  node client/shim.mjs > shim.log 2>&1 &
  echo "shim pid $!"
fi
sleep 1
echo ""
echo "client role up. test it:"
echo "  curl -x http://127.0.0.1:${RGOE_SHIM_PORT:-8888} 'https://api.ipify.org?format=json'"
echo "the returned IP should be the GATEWAY's, not yours. logs: shim.log, tor/tor-client.log"

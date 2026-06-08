#!/usr/bin/env bash
# FRIEND entrypoint: join the egress and prove it works, in one command.
#
# Hand a friend: this repo (with group/members.json) and their own RGOE_SECRET.
# The live gateway onion is already the default, so they just run:
#
#   scripts/join.sh                       # uses .secret + the default gateway
#   scripts/join.sh <their-secret>        # pass the secret inline
#   scripts/join.sh <gateway-onion> <their-secret>   # override the gateway too
#
# or set RGOE_ONION / RGOE_SECRET in the environment.
# It starts their client-side Tor + shim, then runs the verification receipt.
set -euo pipefail
cd "$(dirname "$0")/.."

# Arg handling: one arg = secret; two args = onion then secret. A .onion-looking
# first arg is treated as the gateway address either way.
if [ -n "${2:-}" ]; then
  export RGOE_ONION="$1"; export RGOE_SECRET="$2"
elif [ -n "${1:-}" ]; then
  case "$1" in
    *.onion) export RGOE_ONION="$1" ;;
    *) export RGOE_SECRET="$1" ;;
  esac
fi

# Default verification target: assert egress really comes out of the droplet.
export RGOE_EXPECT_IP="${RGOE_EXPECT_IP:-204.48.28.220}"

echo "joining the gated egress as a member..."
bash scripts/run-client.sh

echo ""
echo "giving the onion descriptor a moment to resolve, then verifying..."
sleep 2
bash scripts/verify.sh

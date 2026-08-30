#!/usr/bin/env bash
# deploy/hostinger/bootstrap-agent.sh
#
# Thin shim for server.siobytes.cloud: sets the environment contract and hands
# off to the shared bootstrap (deploy/bootstrap/agent-bootstrap.sh), which
# holds all real logic and is shared with the AWS agent module.
#
# Idempotent -- safe to re-run. Run as root on the VPS.
set -euo pipefail

SECRETS=/root/.secrets/server-siobytes-cloud
REPO_URL="${REPO_URL:?set REPO_URL to the clone URL of this repo}"

# Locate the shared bootstrap: next to this script when run from a checkout,
# otherwise from a throwaway clone.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP="$SCRIPT_DIR/../bootstrap/agent-bootstrap.sh"
if [ ! -f "$BOOTSTRAP" ]; then
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git >/dev/null; }
  rm -rf /opt/pi-bootstrap
  git clone --depth 1 "$REPO_URL" /opt/pi-bootstrap
  BOOTSTRAP=/opt/pi-bootstrap/deploy/bootstrap/agent-bootstrap.sh
fi

# Provider keys as an env file. The host store keeps the OpenAI key as a raw
# string, so assemble the KEY=VALUE file the shared bootstrap expects.
OPENAI_KEY="$(cat "$SECRETS/openai-piagent.apikey" 2>/dev/null || true)"
[ -n "$OPENAI_KEY" ] || { echo "missing $SECRETS/openai-piagent.apikey" >&2; exit 1; }
KEYS_FILE="$(mktemp)"
chmod 600 "$KEYS_FILE"
echo "OPENAI_API_KEY=$OPENAI_KEY" > "$KEYS_FILE"
trap 'rm -f "$KEYS_FILE"' EXIT

export AGENT_NAME="${AGENT_NAME:-devops}"
export PI_MODEL="${PI_MODEL:-openai/gpt-5.4-mini}"
export COMS_PROJECT="${COMS_PROJECT:-default}"
export AGENT_PURPOSE="${AGENT_PURPOSE:-Hostinger devops agent on server.siobytes.cloud}"

# The agent reaches the hub over loopback, not through Traefik. Fewer moving
# parts, and it keeps working if the cert or the router is being changed.
export PI_COMS_NET_SERVER_URL="http://127.0.0.1:8787"

export SECRETS_SOURCE=file
export COMS_TOKEN_ENV_FILE="$SECRETS/coms-net-hub.env"
export PROVIDER_KEYS_ENV_FILE="$KEYS_FILE"

# The hub runs in Docker on this host; the agent unit must wait for it.
export EXTRA_UNIT_DEPS="docker.service"
export REPO_URL

bash "$BOOTSTRAP"

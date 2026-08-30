#!/usr/bin/env bash
# deploy/hostinger/connect.sh
#
# Connects a laptop Pi to the coms-net hub on server.siobytes.cloud.
#
#   source deploy/hostinger/connect.sh     # env only, then run pi yourself
#   ./deploy/hostinger/connect.sh          # env + launch pi interactively
#
# Secrets are read over SSH at run time and never written to disk here.
set -euo pipefail

VPS="${VPS_HOST:-server.siobytes.cloud}"
SECRETS=/root/.secrets/server-siobytes-cloud

export PI_COMS_NET_SERVER_URL="${PI_COMS_NET_SERVER_URL:-https://coms.siobytes.cloud}"
export PI_COMS_NET_AUTH_TOKEN="$(ssh "$VPS" "cut -d= -f2- $SECRETS/coms-net-hub.env")"

# Only fetch a model key if the shell has none. `pi /login` credentials in
# ~/.pi/auth.json also work and take precedence over this.
if [ -z "${OPENAI_API_KEY:-}" ] && [ ! -f "$HOME/.pi/auth.json" ]; then
  OPENAI_API_KEY="$(ssh "$VPS" "cat $SECRETS/openai-piagent.apikey" | tr -d '\r\n')"
  export OPENAI_API_KEY
fi

echo "hub:   $PI_COMS_NET_SERVER_URL"
echo "peers: $(curl -fsS -H "Authorization: Bearer $PI_COMS_NET_AUTH_TOKEN" \
  "$PI_COMS_NET_SERVER_URL/v1/agents" \
  | python3 -c "import json,sys
ags=json.load(sys.stdin)['agents']
print(', '.join(a['name'] + ' (' + a['status'] + ')' for a in ags) or 'none')")"

# Only launch when executed, not when sourced.
(return 0 2>/dev/null) && return 0

# Provider-qualified model id: a bare `gpt-5.4-mini` fuzzy-matches to
# azure-openai-responses and fails with "No API key for provider".
exec pi -e extensions/coms-net.ts \
  --cname "${COMS_CNAME:-laptop}" \
  --purpose "${COMS_PURPOSE:-laptop peer}" \
  --model "${PI_MODEL:-openai/gpt-5.4-mini}" \
  "$@"

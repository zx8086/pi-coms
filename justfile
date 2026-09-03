set dotenv-load := true

default:
    @just --list

# Plain Pi with the minimal footer
pi:
    pi -e extensions/minimal.ts

# Auto-kills any stale process holding the pinned port first.

# Start a local coms-net hub (binds 127.0.0.1, OS-claimed port unless PI_COMS_NET_PORT is set)
coms-net-server:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    bun scripts/coms-net-server.ts

# Start a LAN-visible coms-net hub (binds 0.0.0.0, requires PI_COMS_NET_AUTH_TOKEN)
coms-net-server-lan:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_HOST=0.0.0.0 bun scripts/coms-net-server.ts

# The agent name flag is --cname (pi owns --name). Pass both so pi's session and
# the coms-net agent share a name, e.g.: just coms --name laptop --cname laptop

# Pi with the coms-net client (auto-discovers local server.json)
coms *args:
    pi -e extensions/coms-net.ts {{args}}

# Fleet auth principals (SSM-backed; IAM on /pi-coms/auth decides who may run these)

# Mint a principal token: just token-create <principal> ["name1,name2"] [kind] [profile]
token-create principal names="" kind="operator" profile="":
    ./deploy/token-admin.sh create {{principal}} "{{names}}" "{{kind}}" "{{profile}}"

# Revoke a principal token (live sessions evicted on the hub's next refresh)
token-revoke principal profile="":
    ./deploy/token-admin.sh revoke {{principal}} "{{profile}}"

# List principals, kinds and names (never tokens)
token-list profile="":
    ./deploy/token-admin.sh list "{{profile}}"

# Resolves the instance by its Name tag at connect time: instance ids change on
# replacement, the tag does not.

# SSM port-forward to the corp hub on localhost:<port>
hub-tunnel profile="eu-shared-services-dev" region="eu-central-1" port="8787":
    #!/usr/bin/env bash
    set -euo pipefail
    HUB_ID=$(aws ec2 describe-instances --profile {{profile}} --region {{region}} \
      --filters "Name=tag:Name,Values=pi-coms-hub-hub" "Name=instance-state-name,Values=running" \
      --query "Reservations[].Instances[].InstanceId" --output text)
    if [ -z "$HUB_ID" ] || [ "$HUB_ID" = "None" ]; then echo "no running hub instance found" >&2; exit 1; fi
    echo "hub instance: $HUB_ID -> localhost:{{port}}"
    exec aws ssm start-session --profile {{profile}} --region {{region}} --target "$HUB_ID" \
      --document-name AWS-StartPortForwardingSession \
      --parameters '{"portNumber":["{{port}}"],"localPortNumber":["{{port}}"]}'

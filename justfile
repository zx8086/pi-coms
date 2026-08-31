set dotenv-load := true

default:
    @just --list

# Plain Pi with the minimal footer + theme cycler
pi:
    pi -e extensions/minimal.ts

# Coms: peer-to-peer, same-machine messaging between Pi agents
local-coms *args:
    pi -e extensions/coms.ts {{args}}

# Start a local coms-net server (binds 127.0.0.1, OS-claimed port)
# Auto-kills any stale process holding the pinned port first.
coms-net-server:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    bun scripts/coms-net-server.ts

# Start a LAN-visible coms-net server (binds 0.0.0.0, requires PI_COMS_NET_AUTH_TOKEN)
coms-net-server-lan:
    -lsof -ti :${PI_COMS_NET_PORT:-52965} | xargs -r kill -TERM 2>/dev/null
    PI_COMS_NET_HOST=0.0.0.0 bun scripts/coms-net-server.ts

# Pi with networked coms client (auto-discovers local server.json)
# Agent name flag is --cname (pi owns --name). Pass both so pi's session and the
# coms-net agent share a name, e.g.: just coms --name laptop --cname laptop
coms *args:
    pi -e extensions/coms-net.ts {{args}}

# Fleet auth principals (SSM-backed; IAM on /pi-coms/auth decides who may run these)
token-create principal names="" kind="operator" profile="":
    ./deploy/token-admin.sh create {{principal}} "{{names}}" "{{kind}}" "{{profile}}"

token-revoke principal profile="":
    ./deploy/token-admin.sh revoke {{principal}} "{{profile}}"

token-list profile="":
    ./deploy/token-admin.sh list "{{profile}}"

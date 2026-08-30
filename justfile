set dotenv-load := true

default:
    @just --list

# Plain Pi with the minimal footer + theme cycler
pi:
    pi -e extensions/minimal.ts -e extensions/theme-cycler.ts

# Coms: peer-to-peer, same-machine messaging between Pi agents
local-coms *args:
    pi -e extensions/coms.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts {{args}}

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
# coms-net agent share a name, e.g.: just coms --name dev --cname dev
coms *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts {{args}}

# coms-net with gpt-5.5
coms1 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --provider openai --model gpt-5.5 {{args}}

# coms-net with claude-opus-4-7
coms2 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --model claude-opus-4-7 {{args}}

# coms-net with deepseek/deepseek-v4-pro
coms3 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --model deepseek/deepseek-v4-pro {{args}}

# coms-net with z-ai/glm-5.1
coms4 *args:
    pi -e extensions/coms-net.ts -e extensions/minimal.ts -e extensions/theme-cycler.ts --model z-ai/glm-5.1 {{args}}

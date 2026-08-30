#!/usr/bin/env bash
# deploy/bootstrap/agent-bootstrap.sh
#
# Provider-agnostic bootstrap for a cloud Pi coms-net agent. Installs Bun, Pi,
# and Herdr, then runs Pi inside a headless Herdr pane wired to a coms-net hub.
# Idempotent -- safe to re-run. Run as root.
#
# Callers are thin shims that set the environment contract below and exec this
# script: deploy/modules/agent/userdata.sh.tftpl (AWS EC2 userdata) and
# deploy/hostinger/bootstrap-agent.sh (VPS).
#
# Environment contract
#   Required:
#     AGENT_NAME                --cname the agent registers under
#     PI_COMS_NET_SERVER_URL   hub base URL (http://127.0.0.1:8787 or https://...)
#     SECRETS_SOURCE           "aws" or "file"
#   SECRETS_SOURCE=aws:
#     COMS_TOKEN_SECRET_ARN    Secrets Manager ARN holding the bearer token string
#     PROVIDER_KEYS_SECRET_ARN Secrets Manager ARN holding a JSON object of
#                              provider API keys, e.g. {"OPENAI_API_KEY":"sk-..."}
#     AWS_REGION               region for the CLI calls; exported to the agent
#   SECRETS_SOURCE=file:
#     COMS_TOKEN_ENV_FILE      env file containing PI_COMS_NET_AUTH_TOKEN=...
#     PROVIDER_KEYS_ENV_FILE   env file of KEY=VALUE provider API keys
#   Optional:
#     AGENT_USER      (default piagent)
#     AGENT_PURPOSE   (default derived from AGENT_NAME)
#     PI_MODEL        (default openai/gpt-5.4-mini; provider-qualified -- a bare
#                      model id can fuzzy-match the wrong provider)
#     COMS_PROJECT    (default "default")
#     REPO_URL        clone URL of this repo (required)
#     AWS_ACCOUNT_ID  exported to the agent env when set
#     SSH_PUBLIC_KEY  authorizes one key for AGENT_USER (herdr --remote)
#     EXTRA_UNIT_DEPS extra systemd units pi-agent.service requires, e.g. docker.service
set -euo pipefail

AGENT_USER="${AGENT_USER:-piagent}"
AGENT_HOME="/home/$AGENT_USER"
REPO_URL="${REPO_URL:?set REPO_URL to the clone URL of this repo}"
AGENT_NAME="${AGENT_NAME:?AGENT_NAME is required}"
PI_MODEL="${PI_MODEL:-openai/gpt-5.4-mini}"
COMS_PROJECT="${COMS_PROJECT:-default}"
AGENT_PURPOSE="${AGENT_PURPOSE:-Pi coms-net agent $AGENT_NAME}"
SERVER_URL="${PI_COMS_NET_SERVER_URL:?PI_COMS_NET_SERVER_URL is required}"
SECRETS_SOURCE="${SECRETS_SOURCE:?SECRETS_SOURCE is required (aws|file)}"
EXTRA_UNIT_DEPS="${EXTRA_UNIT_DEPS:-}"

echo "=== pi agent bootstrap ($SECRETS_SOURCE) $(date -Is) ==="

# ── Packages ───────────────────────────────────────────────────────────────
if command -v dnf >/dev/null; then
  dnf install -y git tar gzip unzip
elif command -v apt-get >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq git curl unzip ca-certificates >/dev/null
else
  echo "no supported package manager (dnf/apt-get)" >&2
  exit 1
fi

id -u "$AGENT_USER" &>/dev/null || useradd -m -s /bin/bash "$AGENT_USER"

# ── Runtime and tools ──────────────────────────────────────────────────────
sudo -u "$AGENT_USER" -H env AGENT_HOME="$AGENT_HOME" bash -euo pipefail <<'BOOTSTRAP'
export HOME="$AGENT_HOME"
cd "$HOME"

command -v "$HOME/.bun/bin/bun" >/dev/null || curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

bun install -g @mariozechner/pi-coding-agent

# `bun install -g` leaves a `#!/usr/bin/env node` shebang on the pi symlink, and
# these hosts have no (or too old a) Node -- pi-tui needs the regex `v` flag.
# Herdr launches Pi from a non-login shell that never sources .bashrc, so a
# wrapper earlier in PATH is not enough: the wrapper has to occupy
# ~/.bun/bin/pi itself.
#
# Write to a temp file and mv it into place. Writing directly to ~/.bun/bin/pi
# would follow the symlink and overwrite the package's real cli.js, corrupting
# the install -- Bun then tries to parse shell script as JavaScript.
PI_CLI="$HOME/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js"
cat > "$HOME/.pi-wrapper.tmp" <<'PIWRAP'
#!/usr/bin/env bash
exec "$HOME/.bun/bin/bun" "$HOME/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/dist/cli.js" "$@"
PIWRAP
rm -f "$HOME/.bun/bin/pi"
mv "$HOME/.pi-wrapper.tmp" "$HOME/.bun/bin/pi"
chmod 755 "$HOME/.bun/bin/pi"

# Fail loudly if a previous bad run corrupted cli.js.
head -1 "$PI_CLI" | grep -q '^exec ' && { echo "cli.js is corrupted; reinstall pi" >&2; exit 1; }

command -v "$HOME/.local/bin/herdr" >/dev/null || curl -fsSL https://herdr.dev/install.sh | sh

grep -q 'BUN_INSTALL' "$HOME/.bashrc" || cat >> "$HOME/.bashrc" <<'PROFILE'
export BUN_INSTALL="$HOME/.bun"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
PROFILE
BOOTSTRAP

# ── Project checkout ───────────────────────────────────────────────────────
if [ -d "$AGENT_HOME/pi-coms/.git" ]; then
  sudo -u "$AGENT_USER" -H git -C "$AGENT_HOME/pi-coms" pull --ff-only
else
  sudo -u "$AGENT_USER" -H git clone --depth 1 "$REPO_URL" "$AGENT_HOME/pi-coms"
fi
sudo -u "$AGENT_USER" -H bash -lc "cd '$AGENT_HOME/pi-coms' && \$HOME/.bun/bin/bun install"

# ── Secrets ────────────────────────────────────────────────────────────────
# Resolved into a 0600 env file the agent sources. Values are never echoed.

case "$SECRETS_SOURCE" in
  aws)
    : "${COMS_TOKEN_SECRET_ARN:?COMS_TOKEN_SECRET_ARN required for SECRETS_SOURCE=aws}"
    : "${PROVIDER_KEYS_SECRET_ARN:?PROVIDER_KEYS_SECRET_ARN required for SECRETS_SOURCE=aws}"
    : "${AWS_REGION:?AWS_REGION required for SECRETS_SOURCE=aws}"
    command -v aws >/dev/null || { echo "aws cli not found" >&2; exit 1; }

    COMS_TOKEN="$(aws secretsmanager get-secret-value \
      --secret-id "$COMS_TOKEN_SECRET_ARN" --region "$AWS_REGION" \
      --query SecretString --output text)"

    # Provider keys may be unpopulated on first boot; tolerate that so the host
    # still comes up and registers.
    PROVIDER_JSON="$(aws secretsmanager get-secret-value \
      --secret-id "$PROVIDER_KEYS_SECRET_ARN" --region "$AWS_REGION" \
      --query SecretString --output text 2>/dev/null || echo '{}')"

    PROVIDER_EXPORTS="$(echo "$PROVIDER_JSON" | python3 -c \
      'import json,sys,shlex
try: d=json.load(sys.stdin)
except Exception: d={}
for k,v in d.items():
    print("export %s=%s" % (k, shlex.quote(str(v))))')"
    ;;
  file)
    : "${COMS_TOKEN_ENV_FILE:?COMS_TOKEN_ENV_FILE required for SECRETS_SOURCE=file}"
    : "${PROVIDER_KEYS_ENV_FILE:?PROVIDER_KEYS_ENV_FILE required for SECRETS_SOURCE=file}"

    COMS_TOKEN="$(grep -E '^PI_COMS_NET_AUTH_TOKEN=' "$COMS_TOKEN_ENV_FILE" | cut -d= -f2-)"

    PROVIDER_EXPORTS="$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$PROVIDER_KEYS_ENV_FILE" 2>/dev/null \
      | python3 -c 'import sys,shlex
for line in sys.stdin:
    k,_,v=line.rstrip("\n").partition("=")
    print("export %s=%s" % (k, shlex.quote(v)))' || true)"
    ;;
  *)
    echo "unknown SECRETS_SOURCE '$SECRETS_SOURCE' (expected aws|file)" >&2
    exit 1
    ;;
esac

[ -n "$COMS_TOKEN" ] || { echo "coms-net auth token is empty" >&2; exit 1; }

ENV_FILE="$AGENT_HOME/.coms-env"
{
  echo "export PI_COMS_NET_SERVER_URL='$SERVER_URL'"
  echo "export PI_COMS_NET_AUTH_TOKEN='$COMS_TOKEN'"
  if [ -n "${AWS_REGION:-}" ]; then echo "export AWS_REGION='$AWS_REGION'"; fi
  if [ -n "${AWS_ACCOUNT_ID:-}" ]; then echo "export AWS_ACCOUNT_ID='$AWS_ACCOUNT_ID'"; fi
  if [ -n "$PROVIDER_EXPORTS" ]; then echo "$PROVIDER_EXPORTS"; fi
} > "$ENV_FILE"
chown "$AGENT_USER:$AGENT_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── SSH access for `herdr --remote` ────────────────────────────────────────
SSH_PUBKEY="${SSH_PUBLIC_KEY:-}"
if [ -n "$SSH_PUBKEY" ]; then
  install -d -m 700 -o "$AGENT_USER" -g "$AGENT_USER" "$AGENT_HOME/.ssh"
  echo "$SSH_PUBKEY" > "$AGENT_HOME/.ssh/authorized_keys"
  chown "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.ssh/authorized_keys"
  chmod 600 "$AGENT_HOME/.ssh/authorized_keys"
  # Service name differs across distros; enable whichever exists.
  systemctl enable --now sshd 2>/dev/null || systemctl enable --now ssh 2>/dev/null || true
  echo "ssh access enabled for $AGENT_USER"
fi

# ── Herdr config ───────────────────────────────────────────────────────────
# headless_* sizes the virtual terminal when no client is attached, which is the
# normal state. resume_agents_on_restore brings Pi back after a server restart.
sudo -u "$AGENT_USER" -H mkdir -p "$AGENT_HOME/.config/herdr"
cat > "$AGENT_HOME/.config/herdr/config.toml" <<'HERDRCONF'
headless_cols = 200
headless_rows = 50

[session]
resume_agents_on_restore = true
HERDRCONF
chown -R "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/.config"

# ── Units ──────────────────────────────────────────────────────────────────
# Two units. `herdr server` is the long-running daemon; every other herdr
# subcommand is a socket client that fails with server_not_running if the
# daemon is absent. So the server must be up before anything creates a
# workspace.

cat > /etc/systemd/system/herdr.service <<UNIT
[Unit]
Description=Herdr headless terminal server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$AGENT_USER
WorkingDirectory=$AGENT_HOME/pi-coms
Environment=HOME=$AGENT_HOME
ExecStart=$AGENT_HOME/.local/bin/herdr server
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/pi-agent.service <<UNIT
[Unit]
Description=Pi coms-net agent ($AGENT_NAME)
Requires=herdr.service $EXTRA_UNIT_DEPS
After=herdr.service $EXTRA_UNIT_DEPS

[Service]
Type=oneshot
RemainAfterExit=yes
User=$AGENT_USER
WorkingDirectory=$AGENT_HOME/pi-coms
Environment=HOME=$AGENT_HOME
ExecStart=/bin/bash -lc '$AGENT_HOME/bin/start-pi-agent.sh'

[Install]
WantedBy=multi-user.target
UNIT

# The account monitor: deterministic scheduled checks, reports via the hub
# mailbox. Independent of pi-agent.service by design -- a wedged agent never
# stops detection.
cat > /etc/systemd/system/pi-monitor.service <<UNIT
[Unit]
Description=Pi AWS account monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$AGENT_USER
WorkingDirectory=$AGENT_HOME/pi-coms
Environment=HOME=$AGENT_HOME
ExecStart=/bin/bash -c 'source \$HOME/.coms-env && exec \$HOME/.bun/bin/bun scripts/coms-net-monitor.ts'
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

sudo -u "$AGENT_USER" -H mkdir -p "$AGENT_HOME/bin"
cat > "$AGENT_HOME/bin/start-pi-agent.sh" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.coms-env"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# systemd starts this as soon as herdr.service is spawned, which can precede the
# server binding its socket. Poll until the API answers.
for i in $(seq 1 30); do
  herdr workspace list >/dev/null 2>&1 && { echo "herdr ready after $i attempt(s)"; break; }
  [ "$i" -eq 30 ] && { echo "herdr server did not become ready" >&2; exit 1; }
  sleep 2
done

# Wait for the hub, which may still be starting (local Docker) or a boot-time
# network race (remote hub).
for i in $(seq 1 30); do
  curl -fsS "$PI_COMS_NET_SERVER_URL/health" >/dev/null 2>&1 && { echo "hub ready"; break; }
  [ "$i" -eq 30 ] && { echo "hub not reachable at $PI_COMS_NET_SERVER_URL" >&2; exit 1; }
  sleep 2
done

# Already running under the right name? Then Herdr restored it; nothing to do.
# Ask the hub rather than Herdr -- `herdr agent list` returns empty on some
# hosts even while Pi is running, so it cannot answer this question.
if curl -fsS -H "Authorization: Bearer $PI_COMS_NET_AUTH_TOKEN" \
     "$PI_COMS_NET_SERVER_URL/v1/agents" 2>/dev/null \
     | grep -q "\"name\":\"AGENT_NAME_PLACEHOLDER\""; then
  echo "agent already registered as AGENT_NAME_PLACEHOLDER; leaving it alone"
  exit 0
fi

# Close any workspace left over from a previous run. Herdr never detects Pi on
# these hosts, so the registry guard above is the only reliable check -- without
# this each restart would stack another workspace, and the orphan's registration
# keeps holding the --cname, bumping the live agent to name2, name3, and so on.
for ws in $(herdr workspace list 2>/dev/null \
    | python3 -c 'import json,sys
try:
  for w in json.load(sys.stdin)["result"]["workspaces"]: print(w["workspace_id"])
except Exception: pass'); do
  echo "closing stale workspace $ws"
  herdr workspace close "$ws" >/dev/null 2>&1 || true
done

# Workspace env is inherited by every pane, so Pi sees the hub URL, token, and
# provider keys. Forward every export from .coms-env.
ENV_ARGS=()
while IFS= read -r line; do
  case "$line" in
    "export "*)
      key="${line#export }"
      key="${key%%=*}"
      ENV_ARGS+=(--env "$key=${!key}")
      ;;
  esac
done < "$HOME/.coms-env"

WS_JSON="$(herdr workspace create \
  --cwd "$HOME/pi-coms" \
  --label "coms-net" \
  "${ENV_ARGS[@]}" \
  --no-focus)"

PANE_ID="$(echo "$WS_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')"
echo "root pane: $PANE_ID"

# Native pi flags pass after `--`. Herdr's readiness detection never fires for
# Pi on these hosts, so `agent start` blocks for its timeout and then reports
# failure -- even though Pi started and registered within seconds. Keep the
# timeout short and treat the failure as non-fatal; the hub registry below is
# the real readiness signal.
herdr agent start "AGENT_NAME_PLACEHOLDER" --kind pi --pane "$PANE_ID" --timeout 15000 -- \
  -e extensions/coms-net.ts \
  -e extensions/minimal.ts \
  --model "PI_MODEL_PLACEHOLDER" \
  --cname "AGENT_NAME_PLACEHOLDER" \
  --project "COMS_PROJECT_PLACEHOLDER" \
  --purpose "AGENT_PURPOSE_PLACEHOLDER" || echo "herdr agent start reported failure; verifying against the hub"

for i in $(seq 1 20); do
  if curl -fsS -H "Authorization: Bearer $PI_COMS_NET_AUTH_TOKEN" \
       "$PI_COMS_NET_SERVER_URL/v1/agents" | grep -q '"name":"AGENT_NAME_PLACEHOLDER"'; then
    echo "agent registered with the hub as AGENT_NAME_PLACEHOLDER"
    exit 0
  fi
  sleep 3
done

echo "agent did not register with the hub within 60s" >&2
exit 1
LAUNCH

# Substitute after the heredoc so bash does not expand these above.
sed -i \
  -e "s|AGENT_NAME_PLACEHOLDER|$AGENT_NAME|g" \
  -e "s|PI_MODEL_PLACEHOLDER|$PI_MODEL|g" \
  -e "s|COMS_PROJECT_PLACEHOLDER|$COMS_PROJECT|g" \
  -e "s|AGENT_PURPOSE_PLACEHOLDER|$AGENT_PURPOSE|g" \
  "$AGENT_HOME/bin/start-pi-agent.sh"

chown "$AGENT_USER:$AGENT_USER" "$AGENT_HOME/bin/start-pi-agent.sh"
chmod 755 "$AGENT_HOME/bin/start-pi-agent.sh"

systemctl daemon-reload
systemctl enable --now herdr.service
systemctl enable pi-agent.service
systemctl restart pi-agent.service
systemctl enable pi-monitor.service
systemctl restart pi-monitor.service

echo "=== bootstrap complete $(date -Is) ==="

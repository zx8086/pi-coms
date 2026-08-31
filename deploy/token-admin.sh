#!/usr/bin/env bash
# deploy/token-admin.sh <create|revoke|list> [args]
#
# Administers per-principal hub tokens in SSM Parameter Store. IAM on the
# parameter path decides who may run these; CloudTrail records every call.
#
#   create <principal> [names-csv] [kind] [profile]   generate + store, print token ONCE
#   revoke <principal> [profile]                      delete the parameter
#   list   [profile]                                  principals, kinds, names (no tokens)
set -euo pipefail

AUTH_PATH="${PI_COMS_AUTH_PATH:-/pi-coms/auth}"
CMD="${1:?usage: token-admin.sh <create|revoke|list> ...}"

profile_args() { [ -n "${1:-}" ] && printf -- "--profile %s" "$1" || true; }

case "$CMD" in
  create)
    PRINCIPAL="${2:?principal required}"
    NAMES="${3:-$PRINCIPAL}"
    KIND="${4:-operator}"
    PROFILE="${5:-}"
    TOKEN="$(openssl rand -hex 32)"
    NAMES_JSON="$(printf '%s' "$NAMES" | python3 -c 'import json,sys; print(json.dumps([n.strip() for n in sys.stdin.read().split(",") if n.strip()]))')"
    VALUE="$(python3 -c 'import json,sys; print(json.dumps({"token": sys.argv[1], "kind": sys.argv[2], "names": json.loads(sys.argv[3])}))' "$TOKEN" "$KIND" "$NAMES_JSON")"
    # shellcheck disable=SC2046
    aws ssm put-parameter --name "$AUTH_PATH/$PRINCIPAL" --type SecureString \
      --value "$VALUE" --overwrite $(profile_args "$PROFILE") >/dev/null
    echo "principal: $PRINCIPAL  kind: $KIND  names: $NAMES"
    echo "token (shown once, not stored anywhere else):"
    echo "$TOKEN"
    echo "hub picks it up within its refresh interval (default 60s)."
    ;;
  revoke)
    PRINCIPAL="${2:?principal required}"
    PROFILE="${3:-}"
    # shellcheck disable=SC2046
    aws ssm delete-parameter --name "$AUTH_PATH/$PRINCIPAL" $(profile_args "$PROFILE")
    echo "revoked $PRINCIPAL; hub drops it within its refresh interval, closing live sessions."
    ;;
  list)
    PROFILE="${2:-}"
    # shellcheck disable=SC2046
    aws ssm get-parameters-by-path --path "$AUTH_PATH" --with-decryption --recursive \
      --output json $(profile_args "$PROFILE") | python3 -c '
import json, sys
for p in json.load(sys.stdin).get("Parameters", []):
    name = p["Name"].split("/")[-1]
    try:
        v = json.loads(p["Value"])
        print(f"{name:24} kind={v.get(\"kind\",\"?\"):10} names={\",\".join(v.get(\"names\",[]))}")
    except Exception:
        print(f"{name:24} (malformed entry)")
'
    ;;
  *)
    echo "unknown command '$CMD' (expected create|revoke|list)" >&2
    exit 1
    ;;
esac

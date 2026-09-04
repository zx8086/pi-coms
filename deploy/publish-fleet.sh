#!/usr/bin/env bash
# deploy/publish-fleet.sh <s3-bucket> [profile]
#
# Build and upload the fleet bundle: a git archive of HEAD plus vendored
# node_modules (all deps are pure JS, so the vendor tree is platform-
# independent). Hosts running in S3 bundle mode converge on it within the
# State Manager window, or immediately via Run Command.
#
#   ./deploy/publish-fleet.sh pi-coms-dist-352896877281 eu-shared-services-dev
set -euo pipefail

BUCKET="${1:?usage: publish-fleet.sh <s3-bucket> [aws-profile]}"
PROFILE="${2:-}"
PROFILE_ARGS=()
[ -n "$PROFILE" ] && PROFILE_ARGS=(--profile "$PROFILE")

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]; then
  echo "refusing to publish: uncommitted changes in tracked files" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

git -C "$REPO_ROOT" archive HEAD | tar -x -C "$STAGE"
(cd "$STAGE" && bun install --frozen-lockfile --production --omit=peer)
echo "$VERSION" > "$STAGE/.bundle-version"

tar -czf "$STAGE.tar.gz" -C "$STAGE" .
aws s3 cp "$STAGE.tar.gz" "s3://$BUCKET/fleet/bundle.tar.gz" "${PROFILE_ARGS[@]}"
printf '%s' "$VERSION" | aws s3 cp - "s3://$BUCKET/fleet/version" "${PROFILE_ARGS[@]}"
rm -f "$STAGE.tar.gz"

echo "published fleet bundle $VERSION to s3://$BUCKET/fleet/"
echo "hosts converge within 30 min; immediate rollout:"
echo "  aws ssm send-command --targets Key=tag:Project,Values=pi-coms-net \\"
echo "    --document-name AWS-RunShellScript --parameters 'commands=[\"/usr/local/bin/pi-coms-update\"]' ${PROFILE_ARGS[*]:-}"

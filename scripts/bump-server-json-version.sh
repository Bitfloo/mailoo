#!/usr/bin/env bash
# Stamp server.json version and every packages[].version from the release version.
set -euo pipefail
v=${1:?version}
source "$(dirname "${BASH_SOURCE[0]}")/release-version.sh"
require_release_version "$v"
jq --arg v "$v" \
  '.version = $v | if (.packages | type == "array") then .packages |= map(.version = $v) else . end' \
  server.json > server.tmp && mv server.tmp server.json

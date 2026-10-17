#!/usr/bin/env bash
# Stamp server.json version and every packages[].version from the release version.
set -euo pipefail
v=${1:?version}
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a release version (X.Y.Z): $v" >&2; exit 1; }
jq --arg v "$v" \
  '.version = $v | if (.packages | type == "array") then .packages |= map(.version = $v) else . end' \
  server.json > server.tmp && mv server.tmp server.json

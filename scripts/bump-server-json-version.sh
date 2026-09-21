#!/usr/bin/env bash
# Stamp server.json version; skip packages[0] until an npm packages entry exists.
set -euo pipefail
v=${1:?version}
jq --arg v "$v" \
  '.version = $v | if (.packages | type == "array" and length > 0) then .packages[0].version = $v else . end' \
  server.json > server.tmp && mv server.tmp server.json

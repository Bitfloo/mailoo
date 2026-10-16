#!/usr/bin/env bash
# Point the README Docker examples at the image tag of the release's minor line.
set -euo pipefail
v=${1:?version}
[[ $v =~ ^([0-9]+\.[0-9]+)\.[0-9]+([-+].+)?$ ]] || { echo "not a semver version: $v" >&2; exit 1; }
LINE=${BASH_REMATCH[1]} perl -pi -e '
  s{(ghcr\.io/bitfloo/mailoo:)\d+\.\d+(?![\d.])}{$1$ENV{LINE}}g;
  s{The `\d+\.\d+` tag follows the newest \d+\.\d+\.x release}{The `$ENV{LINE}` tag follows the newest $ENV{LINE}.x release}g;
' README.md

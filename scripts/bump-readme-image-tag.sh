#!/usr/bin/env bash
# Point the README Docker examples at the image tag of the release's minor line.
set -euo pipefail
v=${1:?version}
source "$(dirname "${BASH_SOURCE[0]}")/release-version.sh"
require_release_version "$v"
LINE=${BASH_REMATCH[1]}.${BASH_REMATCH[2]} perl -pi -e '
  s{(ghcr\.io/bitfloo/mailoo:)\d+\.\d+(?!\.?\d)}{$1$ENV{LINE}}g;
  s{The `\d+\.\d+` tag follows the newest \d+\.\d+\.x release}{The `$ENV{LINE}` tag follows the newest $ENV{LINE}.x release};
' README.md

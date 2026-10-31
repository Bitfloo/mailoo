#!/usr/bin/env bash
# Publish every alias in npm-aliases.txt at the root package.json version. The release workflow runs
# it after the main package is on npm; a maintainer runs it from a terminal, at a released version,
# once per new name. `--dry-run` builds and packs each alias without publishing.
#
# A name that is not on npm yet cannot be published from the workflow: trusted publishing needs the
# package to exist. Locally the script publishes it (npm opens a browser to confirm); in the
# workflow it warns and skips, so the release is not failed by a name that needs the bootstrap.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo=$(jq -r '.repository.url' "$root/package.json")
main=$(jq -r '.name' "$root/package.json")
version=$(jq -r '.version' "$root/package.json")

usage() {
  echo "usage: $0 [--dry-run]" >&2
  exit 2
}

flags=()
case $# in
  0) ;;
  1) [[ $1 == --dry-run ]] || usage; flags+=(--dry-run) ;;
  *) usage ;;
esac

if [[ -z ${GITHUB_ACTIONS:-} ]]; then
  flags+=(--auth-type=web)
fi
# An alias depends on exactly this version of the main package, so one published before that
# version exists would not install. Right after the npm job the check is skipped: the registry can
# answer 404 for a version that was published a moment ago. When that job was skipped nothing
# published the version in this run, so it is checked there too.
if [[ -z ${GITHUB_ACTIONS:-} || ${NPM_JOB_RESULT:-} == skipped ]]; then
  npm view "$main@$version" version >/dev/null 2>&1 || {
    echo "$main@$version is not on npm: run this at a released version" >&2
    exit 1
  }
fi

# Everything the run creates lives here, so an interrupt at npm's one-time-password prompt
# leaves nothing behind. The exit codes are 128 plus the signal, as a shell reports a signal death.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/mailoo-alias.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Sets `listed` to the repository.url of a package that is on npm. Returns 1 for a package that is
# not (E404) and 2 for any other failure: an outage is not a reason to publish, nor to skip.
lookup() {
  local outcome=0
  listed=$(npm view "$1" repository.url 2>"$scratch/errors") || {
    if grep -q E404 "$scratch/errors"; then outcome=1; else cat "$scratch/errors" >&2; outcome=2; fi
  }
  return "$outcome"
}

status=0
# The list comes in on fd 3: npm asks for the one-time password on standard input, and a loop
# reading the list there would hand it the list instead of the terminal.
while IFS= read -r name <&3 || [[ -n $name ]]; do
  [[ -z $name || $name == \#* ]] && continue
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "skip $name@$version: already published"
    continue
  fi
  found=0
  lookup "$name" || found=$?
  if ((found == 2)); then
    echo "could not look up $name on npm" >&2
    status=1
    continue
  fi
  # Our packages always carry the repository field, so an empty one belongs to someone else.
  if ((found == 0)) && [[ $listed != "$repo" ]]; then
    echo "TAKEN $name: the name belongs to another package ($listed)" >&2
    status=1
    continue
  fi
  if ((found == 1)) && [[ -n ${GITHUB_ACTIONS:-} ]]; then
    echo "::warning::$name is not on npm yet: publish it once from a maintainer terminal (CONTRIBUTING.md)"
    continue
  fi
  dir="$scratch/$name"
  echo "publish $name@$version"
  if ! {
    bash "$root/scripts/build-npm-alias.sh" "$name" "$dir" &&
      (cd "$dir" && npm publish --access public ${flags[@]+"${flags[@]}"})
  }; then
    status=1
  fi
done 3< "$root/scripts/npm-aliases.txt"
exit "$status"

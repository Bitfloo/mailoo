#!/usr/bin/env bash
# Fail if a commit message would leak operator/plugin internals on public GitHub.
# Rubric: .claude/rules/public-git.md
set -euo pipefail

usage() {
  echo "usage: $0 --file <commit-msg-file> | --range <git-range>" >&2
  exit 2
}

# Case-insensitive extended regex. Tested in tests/agents/public-git.test.ts.
# Generic leaks only: home paths, private session links, plugin dispatch names.
FORBIDDEN='(/Users/|/home/|Claude-Session:|claude\.ai/code/session_|[a-z][a-z0-9-]*:(test-auditor|test-smith|push-gate))'

# Private patterns stay out of the public repo. Add them as one extended regex
# per line in .git/info/public-git-denylist (or PUBLIC_GIT_DENYLIST_FILE), or as
# one alternation in PUBLIC_GIT_EXTRA_FORBIDDEN (CI reads a repository variable).
EXTRA=${PUBLIC_GIT_EXTRA_FORBIDDEN:-}
denylist_file=${PUBLIC_GIT_DENYLIST_FILE:-$(git rev-parse --git-common-dir 2>/dev/null || echo .git)/info/public-git-denylist}
if [[ -f "$denylist_file" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    EXTRA="${EXTRA:+$EXTRA|}$line"
  done <"$denylist_file"
fi
if [[ -n "$EXTRA" ]]; then
  FORBIDDEN="${FORBIDDEN%)}|${EXTRA})"
fi

scan() {
  local label=$1
  local text=$2
  if echo "$text" | grep -Eiq "$FORBIDDEN"; then
    echo "public-git: forbidden token in $label (see .claude/rules/public-git.md)" >&2
    echo "$text" | grep -Ei "$FORBIDDEN" >&2 || true
    return 1
  fi
  return 0
}

mode=${1:-}
case "$mode" in
  --file)
    file=${2:-}
    [[ -n "$file" && -f "$file" ]] || usage
    scan "$file" "$(cat "$file")"
    ;;
  --range)
    range=${2:-}
    [[ -n "$range" ]] || usage
    failed=0
    while IFS= read -r sha; do
      [[ -z "$sha" ]] && continue
      if ! scan "$sha" "$(git log -1 --format='%s%n%n%b' "$sha")"; then
        failed=1
      fi
    done < <(git rev-list "$range")
    exit "$failed"
    ;;
  *)
    usage
    ;;
esac

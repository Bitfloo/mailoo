#!/usr/bin/env bash
# Fail if a commit message would leak operator/plugin internals on public GitHub.
# Rubric: .claude/rules/public-git.md
set -euo pipefail

usage() {
  echo "usage: $0 --file <commit-msg-file> | --range <git-range>" >&2
  exit 2
}

# Case-insensitive extended regex. Tested in tests/agents/public-git.test.ts.
FORBIDDEN='(/Users/|/home/|AI-DATA|PROJEKTY|_knowledge/|cbc:test-auditor|cbc:test-smith|cbc:push-gate|cursor-grok|L4 twins)'

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

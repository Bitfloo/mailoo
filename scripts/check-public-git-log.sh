#!/usr/bin/env bash
# Fail if a commit message would leak operator/plugin internals on public GitHub.
# Rubric: .claude/rules/public-git.md
# Exit 0 = clean, 1 = forbidden token, 2 = usage error or invalid extra pattern.
set -euo pipefail

usage() {
  echo "usage: $0 --file <commit-msg-file> | --range <git-range>" >&2
  exit 2
}

# Case-insensitive extended regex. Tested in tests/agents/public-git.test.ts.
# Generic leaks only: home paths, private session links, plugin dispatch names.
BUILTIN='(/Users/|/home/|Claude-Session:|claude\.ai/code/session_|[a-z][a-z0-9-]*:(test-auditor|test-smith|push-gate))'

# Private patterns stay out of the public repo. Add them as one extended regex
# per line in the denylist file (default: info/public-git-denylist in the git
# dir, shared by all worktrees; override with PUBLIC_GIT_DENYLIST_FILE), or as
# one alternation in PUBLIC_GIT_EXTRA_FORBIDDEN (CI reads a repository variable).
# A denylist line is used verbatim, spaces and backslashes included; blank lines
# and lines starting with # are skipped.
# The built-in and extra patterns run as separate greps, so a malformed extra
# pattern cannot hide a built-in hit. A malformed extra pattern fails the check.
EXTRAS=()
config_error=0

add_extra() {
  local source=$1
  local pattern=$2
  local rc=0
  grep -Eiq -e "$pattern" </dev/null 2>/dev/null || rc=$?
  if ((rc >= 2)); then
    # Name the source only: the pattern itself is private and CI logs are public.
    echo "public-git: invalid extra pattern in $source" >&2
    config_error=1
    return 0
  fi
  EXTRAS+=(-e "$pattern")
}

if [[ -n "${PUBLIC_GIT_EXTRA_FORBIDDEN:-}" ]]; then
  add_extra PUBLIC_GIT_EXTRA_FORBIDDEN "$PUBLIC_GIT_EXTRA_FORBIDDEN"
fi
# Outside a git repository there is no default denylist; built-ins still run.
denylist_file=${PUBLIC_GIT_DENYLIST_FILE:-$(git rev-parse --git-path info/public-git-denylist 2>/dev/null || true)}
if [[ -n "$denylist_file" && -f "$denylist_file" ]]; then
  lineno=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    line=${line%$'\r'}
    [[ -z "$line" || "$line" == \#* ]] && continue
    add_extra "$denylist_file line $lineno" "$line"
  done <"$denylist_file"
fi

# Returns 0 on a hit, 1 when clean; exits 2 if grep itself fails.
matches() {
  local text=$1
  shift
  local rc=0
  grep -Eiq "$@" <<<"$text" || rc=$?
  if ((rc >= 2)); then
    echo "public-git: grep failed (exit $rc)" >&2
    exit 2
  fi
  return "$rc"
}

scan() {
  local label=$1
  local text=$2
  local hit=0
  if matches "$text" -e "$BUILTIN"; then
    hit=1
    grep -Ei -e "$BUILTIN" <<<"$text" >&2 || true
  fi
  if ((${#EXTRAS[@]})) && matches "$text" "${EXTRAS[@]}"; then
    hit=1
    grep -Ei "${EXTRAS[@]}" <<<"$text" >&2 || true
  fi
  if ((hit)); then
    echo "public-git: forbidden token in $label (see .claude/rules/public-git.md)" >&2
    return 1
  fi
  return 0
}

finish() {
  local failed=$1
  if ((config_error)); then
    exit 2
  fi
  exit "$failed"
}

mode=${1:-}
case "$mode" in
  --file)
    file=${2:-}
    [[ -n "$file" && -f "$file" ]] || usage
    if ! text=$(cat -- "$file"); then
      echo "public-git: cannot read $file" >&2
      exit 2
    fi
    failed=0
    scan "$file" "$text" || failed=1
    finish "$failed"
    ;;
  --range)
    range=${2:-}
    [[ -n "$range" ]] || usage
    if ! shas=$(git rev-list "$range"); then
      echo "public-git: cannot list commits in $range" >&2
      exit 2
    fi
    failed=0
    while IFS= read -r sha; do
      [[ -z "$sha" ]] && continue
      if ! scan "$sha" "$(git log -1 --format='%s%n%n%b' "$sha")"; then
        failed=1
      fi
    done <<<"$shas"
    finish "$failed"
    ;;
  *)
    usage
    ;;
esac

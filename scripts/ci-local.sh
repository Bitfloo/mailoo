#!/usr/bin/env bash
# Laptop stand-in for GitHub unit CI. GreenMail runs when Docker answers.
# GitHub Actions is for pull_request (untrusted linux) and GHCR, not this loop.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

pnpm check
pnpm typecheck
pnpm test

docker_ok=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  docker_ok=1
fi

if [[ "$docker_ok" -eq 1 ]]; then
  pnpm test:integration
else
  echo "ci-local: skip integration (Docker not running)" >&2
fi

if [[ "${1:-}" == "--image" ]]; then
  if [[ "$docker_ok" -eq 1 ]]; then
    pnpm docker:build
  else
    echo "ci-local: --image needs Docker" >&2
    exit 1
  fi
fi

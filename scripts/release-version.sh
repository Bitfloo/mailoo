#!/usr/bin/env bash
# Sourced by the release stamp scripts. A stamp must refuse anything but X.Y.Z:
# a dispatch without a version once fell back to GITHUB_REF (refs/heads/<branch>).
# On success BASH_REMATCH holds the major, minor and patch numbers.
require_release_version() {
  [[ $1 =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || {
    echo "not a release version (X.Y.Z): $1" >&2
    exit 1
  }
}

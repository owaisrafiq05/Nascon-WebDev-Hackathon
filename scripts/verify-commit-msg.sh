#!/usr/bin/env bash
# Fails if the most recent commit message carries any AI attribution.
# Run before every push, as required by CLAUDE.md.
#
#   ./scripts/verify-commit-msg.sh        # checks HEAD
#   ./scripts/verify-commit-msg.sh HEAD~3 # checks an earlier commit
set -euo pipefail

ref="${1:-HEAD}"
message="$(git log -1 --format=%B "$ref")"

if printf '%s' "$message" | grep -iE "co-authored|claude|generated with" >/dev/null; then
  echo "error: commit message for $ref contains attribution that must not be committed:" >&2
  printf '%s\n' "$message" | grep -inE "co-authored|claude|generated with" >&2
  echo "" >&2
  echo "Amend it with: git commit --amend" >&2
  exit 1
fi

echo "ok: commit message for $ref is clean"

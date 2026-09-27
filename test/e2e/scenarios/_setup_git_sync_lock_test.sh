#!/usr/bin/env bash
# Builds the two-teammate scratch setup _drive_git_sync_lock.js needs: one
# bare remote and two clones of it, each holding TESTPART/TESTPART.FCStd.
# Never touches real company data; everything lives under /tmp/sync_test.
set -euo pipefail

ROOT=/tmp/sync_test
rm -rf "$ROOT"
mkdir -p "$ROOT"
git init -q --bare -b main "$ROOT/remote.git"
git clone -q "$ROOT/remote.git" "$ROOT/cloneA" 2>/dev/null
( cd "$ROOT/cloneA"
  git config user.email a@example.com
  git config user.name A
  mkdir TESTPART
  echo "part" > TESTPART/TESTPART.FCStd
  git add -A
  git commit -q -m init
  git push -q -u origin main )
git clone -q "$ROOT/remote.git" "$ROOT/cloneB"
( cd "$ROOT/cloneB"
  git config user.email b@example.com
  git config user.name B )
echo "ready: $ROOT"

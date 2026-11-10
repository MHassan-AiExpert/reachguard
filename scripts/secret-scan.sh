#!/usr/bin/env bash
# Fails if the working tree or any commit contains a key-shaped string or a committed .env file.
set -euo pipefail
cd "$(dirname "$0")/.."
pat='(AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'
bad=0
if git grep -nIE "$pat" -- . ':!scripts/secret-scan.sh' ; then bad=1; fi
if git log --all -p --no-color | grep -nE "$pat" | grep -v 'secret-scan.sh' | head -5 | grep . ; then bad=1; fi
if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$' | grep . ; then bad=1; fi
[ "$bad" = 0 ] && echo "secret scan clean" || { echo "secret scan FAILED"; exit 1; }

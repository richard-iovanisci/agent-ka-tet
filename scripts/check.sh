#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun test
bun run typecheck
git diff --check
git diff --cached --check
printf '%s\n' 'Whitespace checks passed.'

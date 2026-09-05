#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun test
bun run typecheck

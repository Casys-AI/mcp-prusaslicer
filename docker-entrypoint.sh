#!/bin/sh
# Two run modes, chosen by the first argument:
#   (none) | http  — stateless HTTP on 0.0.0.0, the park's native mode
#   stdio          — native MCP stdio for catalog/desktop clients. Requires
#                    `docker run -i`.
set -e
MODE="${1:-http}"
case "$MODE" in
  http)
    exec deno run --allow-all server.ts --port=3022 --hostname=0.0.0.0
    ;;
  stdio)
    exec deno run --allow-all server.ts --stdio
    ;;
  *)
    echo "unknown mode: $MODE (expected: http | stdio)" >&2
    exit 2
    ;;
esac

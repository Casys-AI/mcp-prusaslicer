# syntax=docker/dockerfile:1
#
# mcp-prusaslicer — stateless HTTP MCP server for FDM slicing estimation.
# Port: 3022  Protocol: 2026-07-28  Engine: PrusaSlicer 2.9.2 (Debian trixie arm64)
#
# Build:
#   docker build --platform linux/arm64 -t mcp-prusaslicer .
# Run:
#   docker run --rm -p 3022:3022 mcp-prusaslicer
# Smoke test (from host):
#   curl -s -X POST http://127.0.0.1:3022/mcp \
#     -H 'Content-Type: application/json' \
#     -H 'Accept: application/json, text/event-stream' \
#     -H 'MCP-Protocol-Version: 2026-07-28' \
#     -H 'Mcp-Method: tools/list' \
#     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'

FROM denoland/deno:debian

# ─── System packages ──────────────────────────────────────────────────────────
# PrusaSlicer 2.9.2 ships as a Debian trixie package (already the base OS).
# Its hard Depends pull GTK3/wxWidgets libs, but the CLI (--export-gcode) works
# headless: no DISPLAY required, no X11 server, no Wayland compositor.
# --no-install-recommends is belt-and-suspenders; upstream declares no Recommends.
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       prusa-slicer=2.9.2+dfsg-1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ─── Deno dependency cache ────────────────────────────────────────────────────
# Copy the lock file and all source files consumed at import time so that
# `deno cache` can fully resolve the import graph. The lock file (deno.lock v5)
# pins every JSR/npm specifier; --frozen rejects any drift at run time too.
COPY deno.json deno.lock ./
COPY src/ src/
COPY mod.ts server.ts ./

# Pre-populate /deno-dir/ (DENO_DIR in this base image) with all remote deps.
# --frozen: fail the build if deno.lock would change (integrity gate).
RUN deno cache --frozen server.ts mod.ts

# ─── Runtime ─────────────────────────────────────────────────────────────────
EXPOSE 3022

# parseCli() in server.ts supports --hostname (overrides DEFAULT_HOSTNAME=127.0.0.1).
# We pass --hostname=0.0.0.0 so the server is reachable from outside the container.
# --allow-all mirrors the deno task serve definition in deno.json.
# --cached-only: refuse any network fetch not already in /deno-dir/ (fail-fast).
CMD ["deno", "run", \
     "--allow-all", \
     "--cached-only", \
     "server.ts", \
     "--port=3022", \
     "--hostname=0.0.0.0"]

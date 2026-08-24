# @casys/mcp-prusaslicer

Run the real PrusaSlicer CLI behind MCP and return the print-time and material
statistics written into its generated G-code.

The server exposes `prusaslicer_estimate_fff`. The caller owns the STL and the
PrusaSlicer INI profile. The server snapshots and hashes both inputs, runs PrusaSlicer
headlessly, parses its G-code comment block, and removes the temporary G-code after the
call.

This is a slicing estimate, not printer telemetry or a price quote. It complements
[`mcp-dfm`](https://github.com/Casys-AI/mcp-dfm), which measures STEP geometry, and
[`mcp-calculix`](https://github.com/Casys-AI/mcp-calculix), which performs FEA.

## Quick start: Docker over stdio

The published image bundles PrusaSlicer 2.9.2 and runs without a display. A classic
stdio MCP host can launch it without a native PrusaSlicer installation. The digest
below is the published multi-architecture 0.3.0 image. Package metadata and server
runtime identity in that image are aligned at 0.3.0. Both `linux/amd64` and
`linux/arm64` OCI labels point to commit
`f1cf6dd5489f64f53458117f291a5bd779ed1efb`.

```json
{
  "mcpServers": {
    "prusaslicer": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-v",
        "/absolute/path/to/slicing-jobs:/data:ro",
        "ghcr.io/casys-ai/mcp-prusaslicer@sha256:628b2c06c7a184eb1542650787d146e42ec151d916953c4ee77a24783a90db97",
        "stdio"
      ]
    }
  }
}
```

Both `stl_path` and `profile_ini_path` must be absolute paths as seen inside the
container, for example `/data/bracket.stl` and `/data/profiles/mk4-pla.ini`. Docker
Desktop must be allowed to share the host directory where applicable. Configuration file
names vary by MCP host, but the `command` and `args` contract above is the tested stdio
entrypoint.

The stdio adapter answers the classic MCP `initialize` handshake locally and forwards
calls to a private stateless HTTP server. It is shipped in the Docker image and source
checkout; it is not a public JSR export.

## Docker over HTTP

The default image mode is stateless HTTP on `/mcp`, port 3022, protocol `2026-07-28`:

```bash
docker run --rm \
  -p 127.0.0.1:3022:3022 \
  -v "$PWD/tests/fixtures:/data:ro" \
  ghcr.io/casys-ai/mcp-prusaslicer@sha256:628b2c06c7a184eb1542650787d146e42ec151d916953c4ee77a24783a90db97
```

From a source checkout, this complete call slices the committed 20 mm cube with the
committed test profile. `Mcp-Name` must mirror `params.name`:

```bash
curl -sS -X POST http://127.0.0.1:3022/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: prusaslicer_estimate_fff' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "prusaslicer_estimate_fff",
      "arguments": {
        "stl_path": "/data/cube_20mm.stl",
        "profile_ini_path": "/data/pla_0.4_0.2.ini",
        "stl_sha256": "f69866e117ef51b57020e628e438723b89fb7a9daa13db238f781b0256a1621f",
        "profile_sha256": "28172b6a4614655eea634cf6448090695cf4b135b0dd4d906c90eec2beebd841"
      },
      "_meta": {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {}
      }
    }
  }'
```

The native reference call returns these values in `structuredContent`:

```json
{
  "print_time_s": 1190,
  "print_time_normal_mode": "19m 50s",
  "print_time_silent_mode": "20m 40s",
  "filament_length_mm": 1487.15,
  "filament_volume_mm3": 3580,
  "filament_mass_g": 4.44
}
```

It also returns `gcode_sha256`, `engine_name`, `engine_version`,
`effective_config_sha256`, `overrides_applied`, both input attestations, and
`not_checked`. The text `content` is only a short model-facing summary; use
`structuredContent` for automation.

The examples above use the published multi-architecture 0.3.0 image
`ghcr.io/casys-ai/mcp-prusaslicer@sha256:628b2c06c7a184eb1542650787d146e42ec151d916953c4ee77a24783a90db97`.
Package metadata and server runtime identity in that image are both `0.3.0`. Both
`linux/amd64` and `linux/arm64` OCI labels point to commit
`f1cf6dd5489f64f53458117f291a5bd779ed1efb`. `ghcr.io/casys-ai/mcp-prusaslicer:latest`
is a mutable convenience tag, not the authority for a specific version or capability.

The earlier 0.2.0 package and image are historical. That image's `/app/deno.json`
package version is `0.2.0`, but `/app/server.ts` still has the legacy `VERSION`
`0.1.0`, so `server/discover` or health runtime identity from that published package
or image reports `0.1.0`. Those artifacts do not emit `engine_name`, `engine_version`,
`effective_config_sha256`, or `overrides_applied`.

The images are published for `linux/amd64` and `linux/arm64`. Pin the OCI digest when a
deployment must be reproducible.

## Tool contract

### Inputs

| Field                    | Type    | Required | Description                                               |
| ------------------------ | ------- | -------- | --------------------------------------------------------- |
| `stl_path`               | string  | yes      | Absolute path to the STL on the server filesystem         |
| `profile_ini_path`       | string  | yes      | Absolute path to the caller-owned PrusaSlicer INI         |
| `stl_sha256`             | string  | no       | Expected 64-character SHA-256 of the STL snapshot         |
| `profile_sha256`         | string  | no       | Expected 64-character SHA-256 of the profile snapshot     |
| `layer_height_mm`        | number  | no       | Positive override forwarded as `--layer-height N`         |
| `infill_percent`         | number  | no       | Integer 0–100 override forwarded as `--fill-density N%`   |
| `filament_density_g_cm3` | number  | no       | Positive override forwarded as `--filament-density N`     |
| `timeout_ms`             | integer | no       | Positive integer subprocess timeout in ms; default 120000 |

The effective slicing configuration is the supplied INI plus the three explicit
overrides above. The server injects no bundled production profile or hidden print
setting. It also does not validate whether an INI is complete; PrusaSlicer owns the
behavior of omitted keys. For repeatable work, export a complete profile, keep it under
change control, and supply `profile_sha256`.

The included `tests/fixtures/pla_0.4_0.2.ini` is deliberately a small test profile, not
a recommended production profile.

### Outputs

| Field                     | Always present | Semantics                                                                               |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------- |
| `print_time_s`            | yes            | Parsed normal-mode PrusaSlicer estimate in seconds                                      |
| `print_time_normal_mode`  | yes            | Raw normal-mode G-code string such as `19m 50s`                                         |
| `print_time_silent_mode`  | yes            | Raw silent-mode string, or `null` when the line is absent                               |
| `filament_length_mm`      | yes            | Parsed `filament used [mm]` G-code statistic                                            |
| `filament_volume_mm3`     | yes            | Parsed `filament used [cm3]`, converted to mm³ and rounded to two decimals              |
| `filament_mass_g`         | no             | Positive parsed `filament used [g]`; absent rather than `null` when unavailable or zero |
| `gcode_sha256`            | yes            | SHA-256 of the generated G-code before its temporary directory is removed               |
| `engine_name`             | yes            | Observed slicer name parsed from the G-code `; generated by` header                     |
| `engine_version`          | yes            | Observed slicer version parsed from the G-code `; generated by` header                  |
| `effective_config_sha256` | yes            | SHA-256 of the exact emitted `prusaslicer_config` block, begin through end markers      |
| `overrides_applied`       | yes            | Caller-provided print overrides that were forwarded; `{}` when none were supplied       |
| `stl_artifact`            | yes            | `{ sha256, bytes, source_path }` for the exact STL snapshot consumed                    |
| `profile_artifact`        | yes            | `{ sha256, bytes, source_path }` for the exact INI snapshot consumed                    |
| `not_checked`             | yes            | Explicit limits of the result                                                           |

The mass value is PrusaSlicer's G-code statistic. The server does not recompute mass as
volume × density. A `filament_density` entry in the profile or the
`filament_density_g_cm3` override normally causes PrusaSlicer to emit a positive mass;
if the emitted value is absent or zero, the MCP field is omitted. No density or mass is
invented.

`gcode_sha256` attests the transient output of that call, but it is not a
reproducibility guarantee or a download handle. PrusaSlicer embeds a build timestamp, so
identical STL and profile bytes sliced on different dates can produce different hashes.
The current tool returns statistics and the digest, not the G-code bytes or a persistent
G-code resource.

`engine_name` and `engine_version` are read from the G-code header, not queried from the
`prusa-slicer` binary on `PATH`. `effective_config_sha256` hashes the exact
`; prusaslicer_config = begin` … `end` block PrusaSlicer wrote; it is not a hash of the
input INI. `overrides_applied` contains only the caller-supplied `layer_height_mm`,
`infill_percent`, and `filament_density_g_cm3` values that were forwarded as CLI flags.

## What the estimate does not establish

The `not_checked` array is part of every result. In particular:

- print time comes from PrusaSlicer's estimator, not an observed printer run; firmware,
  acceleration, and machine behavior can change the actual duration;
- this repository provides no calibrated error band between estimated and observed time;
  qualify the selected printer, firmware, and profile when accuracy matters;
- bed adhesion, warping, shrinkage, and dimensional tolerance are not evaluated;
- material statistics reflect the generated toolpath: if supports are disabled by the
  profile, no support material is included;
- multi-material and multi-extruder profiles are not covered by the native test suite;
  use a single-extruder profile unless you qualify another configuration;
- no filament price, machine rate, labor, or quote is computed.

## Engine and reference evidence

The Dockerfile pins Debian's `prusa-slicer=2.9.2+dfsg-1`. The CLI runs headlessly with
this pattern:

```text
prusa-slicer --load <profile.ini> [overrides...] \
  --export-gcode --output <out.gcode> <in.stl>
```

The 20 mm reference above was measured with PrusaSlicer 2.9.2 on aarch64 Debian trixie
using a 0.4 mm nozzle, 0.2 mm layer height, 20% infill, and PLA density 1.24 g/cm³. The
committed G-code fixture contains the real header and statistic block used by the
non-native parser tests.

For comparison, the committed 10 mm cube reference with the same profile is:

| Field                    | Value     |
| ------------------------ | --------- |
| `filament_length_mm`     | 426.64    |
| `filament_volume_mm3`    | 1030      |
| `filament_mass_g`        | 1.27      |
| `print_time_s`           | 765       |
| `print_time_normal_mode` | `12m 45s` |

These fixture values demonstrate the parser and one qualified engine/profile
combination. They are not universal estimates for similarly sized parts.

## Input attestation

Before invoking PrusaSlicer, the tool independently:

1. Copies the STL and INI into private temporary directories.
2. Hashes the private copies with SHA-256.
3. Compares them with `stl_sha256` and `profile_sha256`, when supplied.
4. Makes both snapshots read-only.
5. Passes only those snapshots to PrusaSlicer and returns the digests, byte counts, and
   original source paths.

The expectation fields are optional so exploratory calls remain possible;
provenance-sensitive workflows should require both.

## Run from source or JSR

A native run requires `prusa-slicer` on `PATH`. From a checkout:

```bash
deno task serve
deno task serve -- --port=3099 --hostname=0.0.0.0
```

The published JSR package is `0.3.0`; package metadata and server runtime identity
are aligned. The earlier `@0.2.0` package is historical; its runtime identity still
reports `0.1.0`.

```bash
deno run -A jsr:@casys/mcp-prusaslicer@0.3.0/server --port=3022
```

Both commands expose stateless HTTP only. For stdio, use the Docker mode above or run
`scripts/stdio-shim.ts` from a checkout.

## Development

```bash
deno task release:check
PRUSASLICER_RUN_NATIVE=1 deno task test
```

`release:check` covers formatting, type checking, linting, non-native tests, and the
stdio wire tests. Native tests additionally require PrusaSlicer 2.9.2 on `PATH`.

Relevant implementation boundaries:

```text
server.ts                          stateless HTTP composition root
scripts/stdio-shim.ts              classic stdio to stateless HTTP adapter
src/api/input-artifact.ts          private snapshots and SHA-256 attestation
src/api/prusa-slicer.ts            subprocess bridge and G-code statistic parser
src/tools/estimate.ts              prusaslicer_estimate_fff contract
tests/fixtures/                    qualified test STL, profile, and G-code stats
```

The main-branch workflow publishes a new JSR version only when the version in
`deno.json` is not already present. A separate workflow publishes the multi-arch GHCR
image from `main` and creates a semantic image tag when a `v*` Git tag is pushed.

## Security

This server invokes a native slicer on caller-supplied files. Keep HTTP bound to
loopback unless it is protected by an appropriate trusted boundary. See
[`SECURITY.md`](SECURITY.md) for private vulnerability reporting.

## License

MIT

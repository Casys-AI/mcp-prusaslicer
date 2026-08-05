# @casys/mcp-slicer

FDM slicing estimation MCP server. Slices an STL with a caller-supplied
PrusaSlicer INI profile and returns print-time and material-consumption
measurements from the real G-code.

**Scope:** measurement only. No prices — pricing is downstream (erpnext).
Complements `mcp-dfm` (printability) and `mcp-calculix` (structural FEA).

## Tool

### `slicer_estimate_fff`

Inputs:
- `stl_path` (string, required) — absolute path to the STL file
- `profile_ini` (string, required) — PrusaSlicer INI profile content; the
  caller is the sole authority on print parameters
- `expected_stl_sha256` (string, optional) — SHA-256 hex digest for input
  attestation
- `timeout_ms` (number, optional, default 120 000) — subprocess timeout

Outputs:
- `estimated_print_time_s` — print time in seconds (normal mode)
- `print_time_normal_mode` — raw string from G-code, e.g. `"12m 45s"`
- `print_time_silent_mode` — raw string or null
- `filament_used_mm` — filament length in mm
- `filament_used_cm3` — filament volume in cm³
- `filament_used_g` — filament mass in g, or null when `filament_density` is
  absent from the profile (no density → no mass; server never invents one)
- `not_checked` — explicit list of aspects the tool does not verify
- `input_artifact` — `{ sha256, bytes, source_path }`

## Engine

PrusaSlicer 2.9.2 (Debian trixie `prusa-slicer`, arm64 verified).

CLI pattern:
```
prusa-slicer --load <profile.ini> --export-gcode --output <out.gcode> <in.stl>
```

## Port

`3022` (stateless HTTP `/mcp`)

## Usage

```bash
deno task serve                # listen on 127.0.0.1:3022
deno task test                 # unit + wire tests
SLICER_RUN_NATIVE=1 deno task test   # + integration tests against real slicer
deno task release:check        # fmt + check + lint + test
```

## Architecture

```
server.ts           composition root, stateless McpApp
src/
  client.ts         SlicerToolsClient → handler map + MCP descriptors
  api/
    input-artifact.ts   snapshot + SHA-256 attestation of STL input
    slicer.ts           PrusaSlicer subprocess bridge + G-code stat parser
  tools/
    types.ts            SlicerTool, SlicerToolCategory, SlicerToolHandler
    estimate.ts         slicer_estimate_fff
    mod.ts              allTools, getToolByName, toolsByCategory
tests/
  server_test.ts    unit + wire + native integration tests
  fixtures/
    cube.stl        10mm ASCII STL for integration tests
scripts/
  gen_cube_gcode_fixture.ts   generate G-code fixture from real slicer
```

## License

MIT

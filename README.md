# @casys/mcp-prusaslicer

FDM slicing estimation MCP server. Slices an STL with a caller-supplied
PrusaSlicer INI profile and returns print-time and material-consumption
measurements from the real G-code.

**Scope:** measurement only. No prices — pricing is downstream (erpnext).
Complements `mcp-dfm` (printability) and `mcp-calculix` (structural FEA).

## Tool

### `prusaslicer_estimate_fff`

**Inputs:**

| Field | Type | Required | Description |
|---|---|---|---|
| `stl_path` | string | yes | Absolute path to the STL file to slice |
| `profile_ini_path` | string | yes | Absolute path to a PrusaSlicer INI profile file. The profile is the sole authority on all print parameters. Include `filament_density` to get `filament_mass_g` in the output. |
| `stl_sha256` | string | no | SHA-256 hex digest (64 hex chars) for STL input attestation |
| `profile_sha256` | string | no | SHA-256 hex digest (64 hex chars) for profile attestation |
| `layer_height_mm` | number | no | Override layer height in mm (positive). Forwarded as `--layer-height N`. |
| `infill_percent` | number | no | Override infill density (integer 0-100). Forwarded as `--fill-density N%`. |
| `filament_density_g_cm3` | number | no | Override filament density in g/cm³ (positive). Forces `filament_mass_g` into the output. |
| `timeout_ms` | number | no | Subprocess timeout in ms (default: 120 000) |

**Outputs:**

| Field | Type | Always present | Description |
|---|---|---|---|
| `print_time_s` | number | yes | Estimated print time in seconds (normal mode) |
| `print_time_normal_mode` | string | yes | Raw time string from G-code, e.g. `"19m 50s"` |
| `print_time_silent_mode` | string\|null | yes | Raw time string for silent mode; null if absent from G-code |
| `filament_length_mm` | number | yes | Total filament path length in mm |
| `filament_volume_mm3` | number | yes | Total filament volume in mm³ (converted from G-code `cm³ × 1000`) |
| `filament_mass_g` | number | **no** | Total filament mass in grams. **Absent (not null) when `filament_density` is not set in the profile or override.** The server never invents a density. |
| `gcode_sha256` | string | yes | SHA-256 of the produced G-code (audit trail; non-deterministic — PrusaSlicer embeds a build timestamp) |
| `stl_artifact` | object | yes | Input attestation: `{ sha256, bytes, source_path }` |
| `profile_artifact` | object | yes | Profile attestation: `{ sha256, bytes, source_path }` |
| `not_checked` | string[] | yes | Explicit list of aspects not verified by this tool (read before deciding if sufficient) |

**Not verified by this tool (declared in `not_checked`):**

- Bed adhesion (first-layer adhesion to build plate) is not verified.
- Warping risk is not assessed; use brim or enclosure settings in the profile if needed.
- Dimensional tolerances of the printed part are not estimated; shrinkage is not modelled.
- Print-time accuracy depends on printer firmware and acceleration settings; the estimate
  may differ from actual print time by 5-20%.
- Support volume is not included when supports are disabled in the profile.
- Multi-material or multi-extruder configurations are not tested.
- `filament_mass_g` is absent (not null) when density is absent from profile and override.
- `gcode_sha256` is non-deterministic: identical inputs on different dates produce different hashes.

## Engine

PrusaSlicer 2.9.2 (Debian trixie, `apt install prusa-slicer`, arm64 verified).

CLI pattern:
```
prusa-slicer --load <profile.ini> [overrides...] --export-gcode --output <out.gcode> <in.stl>
```

## Port

`3022` (stateless HTTP `/mcp`, protocol `2026-07-28`)

## Reference measurements (PrusaSlicer 2.9.2, aarch64 Debian trixie)

**20 mm cube + `tests/fixtures/pla_0.4_0.2.ini` (PLA 1.24 g/cm³, 0.4 mm nozzle, 0.2 mm layer, 20% infill):**

| Field | Value |
|---|---|
| `filament_length_mm` | 1487.15 |
| `filament_volume_mm3` | 3580 |
| `filament_mass_g` | 4.44 |
| `print_time_s` | 1190 |
| `print_time_normal_mode` | `19m 50s` |
| `print_time_silent_mode` | `20m 40s` |

**10 mm cube + same profile:**

| Field | Value |
|---|---|
| `filament_length_mm` | 426.64 |
| `filament_volume_mm3` | 1030 |
| `filament_mass_g` | 1.27 |
| `print_time_s` | 765 |
| `print_time_normal_mode` | `12m 45s` |

## Usage

```bash
deno task serve                         # listen on 127.0.0.1:3022
deno task test                          # unit + wire tests (25 tests, no slicer needed)
PRUSASLICER_RUN_NATIVE=1 deno task test      # + 5 integration tests against real slicer
deno task release:check                 # fmt --check + check + lint + test
```

## Architecture

```
server.ts                          composition root, stateless McpApp
mod.ts                             public API surface (exports)
src/
  client.ts                        SlicerToolsClient → handler map + MCP descriptors
  api/
    input-artifact.ts              snapshot + SHA-256 attestation of input files
    slicer.ts                      PrusaSlicer subprocess bridge + G-code stat parser
  tools/
    types.ts                       SlicerTool, SlicerToolCategory, SlicerToolHandler
    estimate.ts                    prusaslicer_estimate_fff implementation
    mod.ts                         allTools, getToolByName, toolsByCategory
tests/
  server_test.ts                   unit + wire + native integration tests (30 total; 5 gated)
  fixtures/
    cube.stl                       10 mm ASCII STL (legacy integration test)
    cube_20mm.stl                  20 mm ASCII STL (primary fixture; generated by gen_cube_20mm_stl.ts)
    pla_0.4_0.2.ini                PLA test profile — NOT a production profile
    cube_20mm_pla.gcode            Truncated G-code from real PrusaSlicer 2.9.2 (stat lines are ground truth)
scripts/
  gen_cube_20mm_stl.ts             Generates tests/fixtures/cube_20mm.stl
  gen_cube_20mm_gcode_fixture.ts   Generates tests/fixtures/cube_20mm_pla.gcode via real slicer
  gen_cube_gcode_fixture.ts        Legacy: generates 10 mm cube G-code (reference; unmaintained)
```

**Fixture provenance:**

- `cube_20mm.stl` — exact 20 mm cube, 12 triangles, analytically defined geometry
  (generated by `gen_cube_20mm_stl.ts`; volume = 8 000 mm³).
- `cube_20mm_pla.gcode` — truncated output from real PrusaSlicer 2.9.2 on 2026-08-05;
  header + stat comment block only. The stat lines are the ground truth for unit tests.
- `pla_0.4_0.2.ini` — hand-written test profile; explicitly documented as non-production.
- `cube.stl` — 10 mm cube, hand-written ASCII STL; used only in native integration tests.

## Docker

Port du parc : **3022**. Engine embarqué : PrusaSlicer 2.9.2 (Debian trixie, arm64).
Le CLI slicing fonctionne headless (aucun display requis) ; les libs GTK3/wxWidgets
sont des `Depends:` durs du paquet Debian mais ne lancent pas de fenêtre en mode
`--export-gcode`.

```bash
# Build (arm64 — adapter à linux/amd64 si besoin)
docker build --platform linux/arm64 -t mcp-prusaslicer .

# Run
docker run --rm -p 3022:3022 mcp-prusaslicer

# Smoke test — protocole stateless 2026-07-28
curl -s -X POST http://127.0.0.1:3022/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Réponse attendue : `"tools":[{"name":"prusaslicer_estimate_fff",...}]`.

Le serveur se bind à `0.0.0.0:3022` dans le conteneur via le flag `--hostname=0.0.0.0`
(parsé par `parseCli()` dans `server.ts`). Sur l'hôte, `127.0.0.1:3022` suffit pour un
déploiement mono-opérateur loopback.

## License

MIT

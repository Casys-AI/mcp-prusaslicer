# Changelog

All notable changes to this project will be documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-05

### Added

- `slicer_estimate_fff` — FDM slicing estimation via PrusaSlicer CLI.
  Caller supplies an STL path and an INI profile; tool returns print-time and
  material-consumption measurements from the real G-code comment block.
  No prices emitted (pricing is downstream, erpnext).
- `snapshotStlArtifact` — SHA-256 attestation of the STL input before slicing.
  The copy is frozen read-only (0o400) before any subprocess sees it.
- `parsePrusaTime` — parses PrusaSlicer time strings ("12m 45s", "1h 2m 30s")
  to integer seconds.
- Stateless HTTP MCP server on port 3022 (`transport: "stateless"`).

### Reference measurements (PrusaSlicer 2.9.2, aarch64-linux, 10mm cube, PLA 1.24 g/cm3)

- `filament used [mm]` = 426.64
- `filament used [cm3]` = 1.03
- `filament used [g]` = 1.27
- `estimated printing time (normal mode)` = 12m 45s (765 s)
- `estimated printing time (silent mode)` = 12m 50s

### Engine

- PrusaSlicer 2.9.2+UNKNOWN (Debian trixie, `apt install prusa-slicer`, arm64)
- CLI: `prusa-slicer --load <profile.ini> --export-gcode --output <out.gcode> <in.stl>`

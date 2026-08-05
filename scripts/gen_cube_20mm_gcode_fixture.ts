/**
 * Generates tests/fixtures/cube_20mm_pla.gcode using the real prusa-slicer.
 *
 * Run inside the mcp-prusaslicer-dev container (or any host with prusa-slicer on PATH):
 *   deno run --allow-all scripts/gen_cube_20mm_gcode_fixture.ts
 *
 * Physical parameters:
 *   Part   : 20 mm cube (tests/fixtures/cube_20mm.stl), volume = 8000 mm3
 *   Profile: tests/fixtures/pla_0.4_0.2.ini
 *            PLA 1.24 g/cm3, 0.4 mm nozzle, 0.2 mm layer, 20% infill, 3 perimeters
 *   Bed    : 250x210 mm (Prusa MK3/MK4 footprint)
 *
 * Reference output (PrusaSlicer 2.9.2, aarch64 Debian trixie):
 *   filament used [mm]  = 1487.15
 *   filament used [cm3] = 3.58   -> filament_volume_mm3 = 3580
 *   filament used [g]   = 4.44
 *   estimated printing time (normal mode) = 19m 50s  -> 1190 s
 *   estimated printing time (silent mode) = 20m 40s
 *
 * The committed fixture is truncated: header + stats + pruned config block.
 * Full G-code approx. 8 440 lines; truncated fixture approx. 44 lines.
 */

const CUBE_STL = new URL("../tests/fixtures/cube_20mm.stl", import.meta.url).pathname;
const PROFILE_INI =
  new URL("../tests/fixtures/pla_0.4_0.2.ini", import.meta.url).pathname;
const OUT_GCODE =
  new URL("../tests/fixtures/cube_20mm_pla.gcode", import.meta.url).pathname;

const workDir = await Deno.makeTempDir({ prefix: "slicer-20mm-fixture-" });
const gcodeOut = `${workDir}/output.gcode`;

console.log("Slicing", CUBE_STL, "...");

const { success, stdout, stderr } = await new Deno.Command("prusa-slicer", {
  args: [
    "--load",
    PROFILE_INI,
    "--export-gcode",
    "--output",
    gcodeOut,
    CUBE_STL,
  ],
  stdout: "piped",
  stderr: "piped",
}).output();

const log = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

if (!success) {
  console.error("prusa-slicer failed:");
  console.error(log.slice(-3000));
  await Deno.remove(workDir, { recursive: true }).catch(() => {});
  Deno.exit(1);
}

let gcodeText: string;
try {
  gcodeText = await Deno.readTextFile(gcodeOut);
} catch {
  console.error("prusa-slicer exited 0 but wrote no G-code file. Log:");
  console.error(log.slice(-1000));
  await Deno.remove(workDir, { recursive: true }).catch(() => {});
  Deno.exit(1);
}

// Print stats so the committer can verify physical plausibility.
const statsLines = gcodeText
  .split("\n")
  .filter((l) => l.match(/filament used|estimated printing time/i));
console.log("\n--- Stats from generated G-code ---");
statsLines.forEach((l) => console.log(l));

// Find the line number of the stats block start.
const lines = gcodeText.split("\n");
const statsStart = lines.findIndex((l) => l.includes("filament used [mm]"));
if (statsStart < 0) {
  console.error("Could not find stats block in G-code - aborting fixture write.");
  await Deno.remove(workDir, { recursive: true }).catch(() => {});
  Deno.exit(1);
}

// Truncated fixture: header (first 30 lines) + stats block + minimal footer.
const header = lines.slice(0, 30);
const statsBlock = lines.slice(statsStart, statsStart + 12);
const truncated = [
  ...header,
  `; ... [G-code toolpath omitted for fixture; ${statsStart - 30} lines] ...`,
  ...statsBlock,
  "; ...",
  "; prusaslicer_config = end",
].join("\n") + "\n";

await Deno.writeTextFile(OUT_GCODE, truncated);
console.log("\nWritten:", OUT_GCODE);
console.log(`Truncated from ${lines.length} to ${truncated.split("\n").length} lines.`);
await Deno.remove(workDir, { recursive: true }).catch(() => {});

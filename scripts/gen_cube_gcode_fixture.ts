/**
 * Generates tests/fixtures/cube_pla.gcode using the real prusa-slicer.
 *
 * Run inside the mcp-slicer-dev container (or any host with prusa-slicer on PATH):
 *   deno run --allow-all scripts/gen_cube_gcode_fixture.ts
 *
 * Physical parameters:
 *   Part: 10mm cube (tests/fixtures/cube.stl)
 *   Profile: PLA, 0.4mm nozzle, 0.2mm layer, 20% infill, 3 perimeters
 *   Density: 1.24 g/cm3 (standard PLA)
 *   Bed: 250x210mm (standard Prusa MK3/MK4 footprint)
 *
 * Reference output (PrusaSlicer 2.9.2, aarch64-linux):
 *   filament used [mm] = 426.64
 *   filament used [cm3] = 1.03
 *   filament used [g] = 1.27
 *   estimated printing time (normal mode) = 12m 45s
 */

const CUBE_STL = new URL("../tests/fixtures/cube.stl", import.meta.url).pathname;
const OUT_GCODE = new URL("../tests/fixtures/cube_pla.gcode", import.meta.url).pathname;

const PROFILE_INI = [
  "printer_technology = FFF",
  "nozzle_diameter = 0.4",
  "layer_height = 0.2",
  "first_layer_height = 0.2",
  "bed_shape = 0x0,250x0,250x210,0x210",
  "filament_diameter = 1.75",
  "filament_density = 1.24",
  "temperature = 215",
  "first_layer_temperature = 215",
  "bed_temperature = 60",
  "first_layer_bed_temperature = 60",
  "fill_density = 20%",
  "perimeters = 3",
  "gcode_flavor = marlin",
].join("\n");

const workDir = await Deno.makeTempDir({ prefix: "slicer-fixture-" });
const profilePath = `${workDir}/profile.ini`;
const gcodeOut = `${workDir}/output.gcode`;

await Deno.writeTextFile(profilePath, PROFILE_INI);

console.log("Slicing", CUBE_STL, "...");

const { success, stdout, stderr } = await new Deno.Command("prusa-slicer", {
  args: [
    "--load", profilePath,
    "--export-gcode",
    "--output", gcodeOut,
    CUBE_STL,
  ],
  stdout: "piped",
  stderr: "piped",
}).output();

const log = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
console.log(log);

if (!success) {
  console.error("prusa-slicer failed:");
  console.error(log.slice(-3000));
  Deno.exit(1);
}

let gcodeText: string;
try {
  gcodeText = await Deno.readTextFile(gcodeOut);
} catch {
  console.error("prusa-slicer exited 0 but wrote no G-code file. Log:");
  console.error(log.slice(-1000));
  Deno.exit(1);
}

// Print key stats so the committer can verify physical plausibility.
const statsLines = gcodeText
  .split("\n")
  .filter((l) =>
    l.match(/filament used|estimated printing time|total filament/i)
  );
console.log("\n--- Stats from generated G-code ---");
statsLines.forEach((l) => console.log(l));

await Deno.writeTextFile(OUT_GCODE, gcodeText);
console.log("\nWritten:", OUT_GCODE);
await Deno.remove(workDir, { recursive: true }).catch(() => {});

/**
 * Generates tests/fixtures/cube_20mm.stl - exact ASCII STL for a 20 mm cube.
 *
 * Geometry: axis-aligned box [0,20]^3 mm.
 * 12 triangles (2 per face x 6 faces), outward normals, right-hand rule.
 * The same geometry can be verified analytically: volume = 8000 mm3.
 *
 * Run from the repo root:
 *   deno run --allow-write scripts/gen_cube_20mm_stl.ts
 */

const OUT = new URL("../tests/fixtures/cube_20mm.stl", import.meta.url).pathname;

const STL = `solid cube_20mm
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 20 0 0
      vertex 20 20 0
    endloop
  endfacet
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 20 20 0
      vertex 0 20 0
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 0 0 20
      vertex 20 20 20
      vertex 20 0 20
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex 0 0 20
      vertex 0 20 20
      vertex 20 20 20
    endloop
  endfacet
  facet normal -1 0 0
    outer loop
      vertex 0 0 0
      vertex 0 20 0
      vertex 0 20 20
    endloop
  endfacet
  facet normal -1 0 0
    outer loop
      vertex 0 0 0
      vertex 0 20 20
      vertex 0 0 20
    endloop
  endfacet
  facet normal 1 0 0
    outer loop
      vertex 20 0 0
      vertex 20 20 20
      vertex 20 20 0
    endloop
  endfacet
  facet normal 1 0 0
    outer loop
      vertex 20 0 0
      vertex 20 0 20
      vertex 20 20 20
    endloop
  endfacet
  facet normal 0 -1 0
    outer loop
      vertex 0 0 0
      vertex 20 0 20
      vertex 20 0 0
    endloop
  endfacet
  facet normal 0 -1 0
    outer loop
      vertex 0 0 0
      vertex 0 0 20
      vertex 20 0 20
    endloop
  endfacet
  facet normal 0 1 0
    outer loop
      vertex 0 20 0
      vertex 20 20 0
      vertex 20 20 20
    endloop
  endfacet
  facet normal 0 1 0
    outer loop
      vertex 0 20 0
      vertex 20 20 20
      vertex 0 20 20
    endloop
  endfacet
endsolid cube_20mm
`;

await Deno.writeTextFile(OUT, STL);
console.log("Written:", OUT);
console.log("Volume: 8000 mm3 (20x20x20 cube - analytically exact)");

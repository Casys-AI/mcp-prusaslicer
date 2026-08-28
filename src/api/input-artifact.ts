/**
 * Snapshot and attest input files before handing them to the slicer.
 *
 * Two surfaces are exposed:
 *   snapshotStlArtifact  — STL geometry file
 *   snapshotIniArtifact  — PrusaSlicer INI profile
 *
 * Both follow the same pattern:
 *   1. For geometry, admit only a boundedly identified STL source.
 *   2. Copy the source file into a private temp directory.
 *   3. Compute the SHA-256 of the private copy.
 *   4. Optionally verify an expected digest.
 *   5. Make the copy read-only before any subprocess sees it.
 *
 * The returned handle carries a cleanup() that MUST be called in a finally
 * block — even when the subprocess fails.
 */

/** Raised when the provided artifact is invalid or cannot be snapshotted. */
export class InputArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputArtifactError";
  }
}

export interface InputArtifact {
  /** Path inside the private snapshot directory (ephemeral). */
  path: string;
  /** Original path supplied by the caller. */
  sourcePath: string;
  /** SHA-256 hex digest of the private copy. */
  sha256: string;
  /** Byte size of the private copy. */
  bytes: number;
}

export interface ArtifactSnapshot {
  artifact: InputArtifact;
  cleanup(): Promise<void>;
}

/**
 * The geometric-input contract is intentionally STL-only. This is an identity
 * preflight, not a mesh-quality or slicer-feasibility claim: it accepts either
 * a binary STL with an exact declared triangle payload or an ASCII STL whose
 * bounded head/tail expose the standard lexical envelope.
 */
const STL_SNIFF_BYTES = 8 * 1024;

async function readWindow(
  path: string,
  offset: number,
  maximumBytes: number,
): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    await file.seek(offset, Deno.SeekMode.Start);
    const buffer = new Uint8Array(maximumBytes);
    let readBytes = 0;
    while (readBytes < buffer.length) {
      const read = await file.read(buffer.subarray(readBytes));
      if (read === null) break;
      readBytes += read;
    }
    return buffer.slice(0, readBytes);
  } finally {
    file.close();
  }
}

function hasBinaryStlLayout(bytes: Uint8Array, fileSize: number): boolean {
  if (fileSize < 84 || bytes.length < 84) return false;
  const triangleCount = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(80, true);
  return fileSize === 84 + triangleCount * 50;
}

function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return false;
  }
  return (bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08);
}

function hasAsciiStlEnvelope(head: Uint8Array, tail: Uint8Array): boolean {
  const decoder = new TextDecoder();
  const headText = decoder.decode(head);
  const tailText = decoder.decode(tail);
  if (/\0/.test(headText) || /\0/.test(tailText)) return false;

  const startsAsSolid = /^(?:\uFEFF)?[\t\n\r ]*solid(?:[\t\n\r ]|$)/i.test(
    headText,
  );
  const hasTriangleEnvelope = /\bfacet\s+normal\b/i.test(headText) &&
    /\bouter\s+loop\b/i.test(headText) &&
    /\bvertex\b/i.test(headText) &&
    /\bendloop\b/i.test(headText) &&
    /\bendfacet\b/i.test(headText);
  const endsAsSolid = /\bendsolid(?:[\t\n\r ]|$)/i.test(tailText);
  return startsAsSolid && hasTriangleEnvelope && endsAsSolid;
}

/**
 * Refuse a non-STL geometry input before a temporary snapshot or slicer
 * process exists. A `.stl` extension is necessary but insufficient: the
 * bounded binary/ASCII identity check rejects renamed project archives.
 */
export async function assertAdmittedStlSource(
  toolName: string,
  sourcePath: string,
  reportedPath = sourcePath,
): Promise<void> {
  if (!sourcePath.toLowerCase().endsWith(".stl")) {
    throw new InputArtifactError(
      `[${toolName}] STL input must use the admitted .stl contract; ` +
        `refused non-STL path before snapshot or slicer execution: ${reportedPath}`,
    );
  }

  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(sourcePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new InputArtifactError(
        `[${toolName}] STL file not found: ${reportedPath}`,
      );
    }
    throw error;
  }

  if (!stat.isFile) {
    throw new InputArtifactError(
      `[${toolName}] STL input must be a regular file: ${reportedPath}`,
    );
  }
  if (stat.size === 0) {
    throw new InputArtifactError(
      `[${toolName}] STL input is empty: ${reportedPath}`,
    );
  }

  const head = await readWindow(sourcePath, 0, STL_SNIFF_BYTES);
  if (hasZipSignature(head)) {
    throw new InputArtifactError(
      `[${toolName}] STL input has a ZIP/3MF archive signature; ` +
        `refused before slicer execution: ${reportedPath}`,
    );
  }
  const tailOffset = Math.max(0, stat.size - STL_SNIFF_BYTES);
  const tail = tailOffset === 0
    ? head
    : await readWindow(sourcePath, tailOffset, STL_SNIFF_BYTES);
  if (hasBinaryStlLayout(head, stat.size) || hasAsciiStlEnvelope(head, tail)) {
    return;
  }

  throw new InputArtifactError(
    `[${toolName}] STL input failed the bounded ASCII/binary STL identity check; ` +
      `refused before slicer execution: ${reportedPath}`,
  );
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const contiguous = Uint8Array.from(bytes);
  return crypto.subtle.digest("SHA-256", contiguous.buffer).then((digest) =>
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Generic snapshot implementation. Exposed via typed wrappers below.
 */
async function snapshotFile(
  toolName: string,
  kind: string,
  extension: string,
  prefix: string,
  sourcePath: string,
  expectedSha256: string | undefined,
  sourcePreflight?: () => Promise<void>,
  snapshotPreflight?: (snapshotPath: string) => Promise<void>,
): Promise<ArtifactSnapshot> {
  if (expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    throw new InputArtifactError(
      `[${toolName}] expected_${kind}_sha256 must be a 64-character hexadecimal SHA-256 digest.`,
    );
  }

  // A source preflight happens before makeTempDir/copyFile so refused formats
  // never become private artifacts and never reach the slicer process.
  await sourcePreflight?.();

  const workDir = await Deno.makeTempDir({ prefix });
  const snapshotPath = `${workDir}/input.${extension}`;
  const cleanup = () => Deno.remove(workDir, { recursive: true }).catch(() => {});

  try {
    await Deno.copyFile(sourcePath, snapshotPath);
    // Revalidate the private copy itself. The source path may have changed
    // after its preflight; only the bytes that can reach the subprocess count.
    await snapshotPreflight?.(snapshotPath);
    const fileBytes = await Deno.readFile(snapshotPath);
    if (fileBytes.length === 0) {
      throw new InputArtifactError(
        `[${toolName}] ${kind.toUpperCase()} input is empty: ${sourcePath}`,
      );
    }
    const sha256 = await sha256Hex(fileBytes);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) {
      throw new InputArtifactError(
        `[${toolName}] ${kind.toUpperCase()} SHA-256 mismatch: ` +
          `expected ${expectedSha256.toLowerCase()}, ` +
          `computed ${sha256} from the private input snapshot.`,
      );
    }
    // Freeze the snapshot before any subprocess reads it.
    await Deno.chmod(snapshotPath, 0o400);
    return {
      artifact: { path: snapshotPath, sourcePath, sha256, bytes: fileBytes.length },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (error instanceof InputArtifactError) throw error;
    if (error instanceof Deno.errors.NotFound) {
      throw new InputArtifactError(
        `[${toolName}] ${kind.toUpperCase()} file not found: ${sourcePath}`,
      );
    }
    throw error;
  }
}

/**
 * Copy the STL at sourcePath into a private temp directory, hash the copy,
 * optionally verify expectedSha256, then make the copy read-only.
 */
export function snapshotStlArtifact(
  toolName: string,
  sourcePath: string,
  expectedSha256?: string,
): Promise<ArtifactSnapshot> {
  return snapshotFile(
    toolName,
    "stl",
    "stl",
    "slicer-stl-",
    sourcePath,
    expectedSha256,
    () => assertAdmittedStlSource(toolName, sourcePath),
    (snapshotPath) => assertAdmittedStlSource(toolName, snapshotPath, sourcePath),
  );
}

/**
 * Copy the INI profile at sourcePath into a private temp directory, hash the
 * copy, optionally verify expectedSha256, then make the copy read-only.
 */
export function snapshotIniArtifact(
  toolName: string,
  sourcePath: string,
  expectedSha256?: string,
): Promise<ArtifactSnapshot> {
  return snapshotFile(
    toolName,
    "ini",
    "ini",
    "slicer-ini-",
    sourcePath,
    expectedSha256,
  );
}

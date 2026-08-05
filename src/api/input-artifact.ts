/**
 * Snapshot and attest input files before handing them to the slicer.
 *
 * Two surfaces are exposed:
 *   snapshotStlArtifact  — STL geometry file
 *   snapshotIniArtifact  — PrusaSlicer INI profile
 *
 * Both follow the same pattern:
 *   1. Copy the source file into a private temp directory.
 *   2. Compute the SHA-256 of the private copy.
 *   3. Optionally verify an expected digest.
 *   4. Make the copy read-only before any subprocess sees it.
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
): Promise<ArtifactSnapshot> {
  if (expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    throw new InputArtifactError(
      `[${toolName}] expected_${kind}_sha256 must be a 64-character hexadecimal SHA-256 digest.`,
    );
  }

  const workDir = await Deno.makeTempDir({ prefix });
  const snapshotPath = `${workDir}/input.${extension}`;
  const cleanup = () => Deno.remove(workDir, { recursive: true }).catch(() => {});

  try {
    await Deno.copyFile(sourcePath, snapshotPath);
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

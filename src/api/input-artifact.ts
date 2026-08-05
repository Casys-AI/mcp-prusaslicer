/**
 * Snapshot and attest an input STL file before handing it to the slicer.
 *
 * The caller provides a path; we copy the file into a private temp directory,
 * hash the copy, and optionally verify a declared digest. The copy is made
 * read-only before any subprocess sees it. The returned handle carries a
 * cleanup() that must be called in a finally block.
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

export interface StlSnapshot {
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
 * Copy the STL at sourcePath into a private temp directory, hash the copy,
 * optionally verify expectedSha256, then make the copy read-only.
 *
 * Caller MUST invoke cleanup() in a finally block.
 */
export async function snapshotStlArtifact(
  toolName: string,
  sourcePath: string,
  expectedSha256?: string,
): Promise<StlSnapshot> {
  if (expectedSha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    throw new InputArtifactError(
      `[${toolName}] expected_stl_sha256 must be a 64-character hexadecimal SHA-256 digest.`,
    );
  }

  const workDir = await Deno.makeTempDir({ prefix: "slicer-input-" });
  const snapshotPath = `${workDir}/input.stl`;
  const cleanup = () => Deno.remove(workDir, { recursive: true }).catch(() => {});

  try {
    await Deno.copyFile(sourcePath, snapshotPath);
    const fileBytes = await Deno.readFile(snapshotPath);
    if (fileBytes.length === 0) {
      throw new InputArtifactError(`[${toolName}] STL input is empty: ${sourcePath}`);
    }
    const sha256 = await sha256Hex(fileBytes);
    if (expectedSha256 !== undefined && sha256 !== expectedSha256.toLowerCase()) {
      throw new InputArtifactError(
        `[${toolName}] STL SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, ` +
          `computed ${sha256} from the private input snapshot.`,
      );
    }
    // Freeze the snapshot before any subprocess reads it.
    await Deno.chmod(snapshotPath, 0o400);
    return {
      artifact: {
        path: snapshotPath,
        sourcePath,
        sha256,
        bytes: fileBytes.length,
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    if (error instanceof InputArtifactError) throw error;
    if (error instanceof Deno.errors.NotFound) {
      throw new InputArtifactError(`[${toolName}] STL file not found: ${sourcePath}`);
    }
    throw error;
  }
}

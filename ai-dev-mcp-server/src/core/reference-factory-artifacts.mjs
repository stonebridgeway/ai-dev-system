/**
 * The files a Reference Factory manifest produces: where they live, what a
 * registry entry for them looks like, and whether a generated PNG is one a
 * reviewer could actually have inspected.
 *
 * `src/core/reference-factory.mjs` owns the manifest itself — planning it,
 * validating it, rendering its plan. This module owns what happens around the
 * manifest on disk, minus the disk: the extension reads the bytes and hands
 * them here for judgement.
 */
import { FRONTEND_PRODUCT_PATHS } from "./frontend-product-quality.mjs";

/** Manifest ids are minted as `rf-<14 digits>-<10 hex>`; nothing else is one. */
const MANIFEST_ID_PATTERN = /^rf-\d{14}-[a-f0-9]{10}$/;


/** Perceptual distance below which two concepts are the same picture. */
export const NEAR_DUPLICATE_MAX_DISTANCE = 6;

/** Bit width of the perceptual hash, quoted in the duplicate finding. */
export const PERCEPTUAL_HASH_BITS = 128;

function assertManifestId(manifestId) {
  if (!MANIFEST_ID_PATTERN.test(String(manifestId || ""))) {
    throw new Error("Invalid Reference Factory manifest id.");
  }
}

/** Project-relative path of one manifest's JSON. */
export function referenceFactoryManifestRelativePath(manifestId) {
  assertManifestId(manifestId);
  return `${FRONTEND_PRODUCT_PATHS.referenceFactoryManifests}/${manifestId}.json`;
}

/** Project-relative path of one manifest's human-readable plan. */
export function referenceFactoryPlanRelativePath(manifestId) {
  assertManifestId(manifestId);
  return `${FRONTEND_PRODUCT_PATHS.referenceFactoryPlans}/${manifestId}.md`;
}

/**
 * The record the product state keeps for one manifest stage.
 *
 * @param {object} manifest
 * @param {string} manifestPath
 * @param {string} planPath
 * @param {string} [status] - planned | registered.
 * @param {string} [updatedAt]
 * @returns {object}
 */
export function referenceFactoryEntry(
  manifest,
  manifestPath,
  planPath,
  status = "planned",
  updatedAt = new Date().toISOString()
) {
  return {
    manifest_id: manifest.id,
    manifest_path: manifestPath,
    plan_path: planPath,
    manifest_fingerprint: manifest.manifest_fingerprint,
    context_fingerprint: manifest.context_fingerprint,
    approved_direction_id: manifest.approved_direction_id,
    surface: manifest.surface,
    generator: manifest.generator,
    artifact_count: manifest.artifacts.length,
    status,
    updated_at: updatedAt
  };
}

/**
 * Read a PNG's structure from its bytes: dimensions plus every way the file
 * fails to be a usable PNG. No decoding — the chunk walk is enough to tell a
 * real screenshot from a truncated or fabricated one.
 *
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, errors: string[] }}
 */
export function inspectPngStructure(buffer) {
  const errors = [];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    return { width: 0, height: 0, errors: ["File is not a PNG image."] };
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasIdat = false;
  let hasIend = false;
  let chunkIndex = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const next = dataStart + length + 4;
    if (next > buffer.length) {
      errors.push("PNG chunk exceeds file length.");
      break;
    }
    const type = buffer.toString("ascii", typeStart, typeStart + 4);
    if (chunkIndex === 0 && type !== "IHDR") errors.push("PNG must start with IHDR.");
    if (type === "IHDR") {
      if (length !== 13) errors.push("PNG IHDR has an invalid length.");
      if (length >= 8) {
        width = buffer.readUInt32BE(dataStart);
        height = buffer.readUInt32BE(dataStart + 4);
      }
    }
    if (type === "IDAT") hasIdat = true;
    if (type === "IEND") {
      hasIend = true;
      break;
    }
    offset = next;
    chunkIndex += 1;
  }
  if (!width || !height) errors.push("PNG dimensions are missing or invalid.");
  if (!hasIdat) errors.push("PNG has no image-data chunk.");
  if (!hasIend) errors.push("PNG has no end chunk.");
  return { width, height, errors };
}

/**
 * Everything wrong with one generated artifact, given its bytes' structure.
 *
 * Orientation and the size floors are what separate an image somebody looked at
 * from a placeholder: a 64-pixel thumbnail cannot have been reviewed.
 *
 * @param {object} input
 * @param {{ id: string, orientation?: string }} input.artifact
 * @param {{ width: number, height: number, errors: string[] }} input.structure
 * @param {number} input.sizeBytes
 * @returns {string[]}
 */
export function referenceFactoryImageFindings({ artifact, structure, sizeBytes }) {
  const errors = structure.errors.map((item) => `Artifact "${artifact.id}": ${item}`);
  if (sizeBytes < 256) {
    errors.push(`Artifact "${artifact.id}" is implausibly small for an inspectable reference.`);
  }
  const portrait = structure.height > structure.width;
  if (artifact.orientation === "portrait" && !portrait) {
    errors.push(`Artifact "${artifact.id}" must be portrait.`);
  }
  if (artifact.orientation === "landscape" && portrait) {
    errors.push(`Artifact "${artifact.id}" must be landscape.`);
  }
  const minimumWidth = artifact.orientation === "portrait" ? 320 : 800;
  const minimumHeight = artifact.orientation === "portrait" ? 568 : 450;
  if (structure.width < minimumWidth || structure.height < minimumHeight) {
    errors.push(
      `Artifact "${artifact.id}" is too small: ${structure.width}x${structure.height}; ` +
      `minimum ${minimumWidth}x${minimumHeight}.`
    );
  }
  return errors;
}

/**
 * The finding for two artifacts that came out byte-identical: distinct jobs
 * cannot both have been generated and inspected if they produced one file.
 *
 * @param {string} previousId - The artifact that claimed the hash first.
 * @param {string} id
 * @returns {string}
 */
export function referenceFactoryIdenticalFinding(previousId, id) {
  return `Artifacts "${previousId}" and "${id}" are byte-identical; distinct jobs require distinct inspected images.`;
}

/**
 * The comparison key for near-duplicate detection: two concepts are only
 * comparable when they show the same thing, so a desktop default is judged
 * against other desktop defaults and never against a mobile success state.
 */
export function referenceFactoryComparisonGroup(artifact) {
  return [artifact?.scope, artifact?.viewport, artifact?.state, artifact?.orientation].join("|");
}

/**
 * Findings for concepts that are perceptually the same picture across two
 * directions — distinct styling over an identical composition.
 *
 * @param {Array<{ left_id: string, right_id: string, distance: number }>} duplicates
 * @returns {string[]}
 */
export function referenceFactoryDuplicateFindings(duplicates) {
  return duplicates.map((duplicate) => (
    `Artifacts "${duplicate.left_id}" and "${duplicate.right_id}" are perceptually near-identical ` +
    `(distance ${duplicate.distance}/${PERCEPTUAL_HASH_BITS}); visual directions must differ in composition, not only styling.`
  ));
}

import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { FRONTEND_PRODUCT_PATHS } from "./frontend-product-quality.mjs";
import {
  NEAR_DUPLICATE_MAX_DISTANCE,
  PERCEPTUAL_HASH_BITS,
  inspectPngStructure,
  referenceFactoryComparisonGroup,
  referenceFactoryDuplicateFindings,
  referenceFactoryEntry,
  referenceFactoryIdenticalFinding,
  referenceFactoryImageFindings,
  referenceFactoryManifestRelativePath,
  referenceFactoryPlanRelativePath
} from "./reference-factory-artifacts.mjs";

const MANIFEST_ID = "rf-20260101000000-0123456789";

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function ihdr(width, height, length = 13) {
  const data = Buffer.alloc(length);
  if (length >= 8) {
    data.writeUInt32BE(width, 0);
    data.writeUInt32BE(height, 4);
  }
  if (length >= 10) {
    data[8] = 8;
    data[9] = 2;
  }
  return data;
}
function png(width, height, { omit = [] } = {}) {
  const parts = [SIGNATURE, chunk("IHDR", ihdr(width, height))];
  if (!omit.includes("IDAT")) parts.push(chunk("IDAT", zlib.deflateSync(Buffer.alloc(width * height * 3 + height))));
  if (!omit.includes("IEND")) parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

test("manifest and plan paths live under the Reference Factory directories", () => {
  assert.equal(
    referenceFactoryManifestRelativePath(MANIFEST_ID),
    `${FRONTEND_PRODUCT_PATHS.referenceFactoryManifests}/${MANIFEST_ID}.json`
  );
  assert.equal(
    referenceFactoryPlanRelativePath(MANIFEST_ID),
    `${FRONTEND_PRODUCT_PATHS.referenceFactoryPlans}/${MANIFEST_ID}.md`
  );
});

test("anything that is not a minted manifest id is refused", () => {
  for (const bad of ["", null, undefined, "rf-1-2", "rf-20260101000000-0123456789x", "../../etc/passwd", "rf-2026010100000X-0123456789"]) {
    assert.throws(() => referenceFactoryManifestRelativePath(bad), /Invalid Reference Factory manifest id/);
    assert.throws(() => referenceFactoryPlanRelativePath(bad), /Invalid Reference Factory manifest id/);
  }
});

test("a registry entry carries the manifest's identity, shape and status", () => {
  const entry = referenceFactoryEntry(
    {
      id: MANIFEST_ID,
      manifest_fingerprint: "fp",
      context_fingerprint: "ctx",
      approved_direction_id: "atlas-calm",
      surface: "application",
      generator: "imagegen",
      artifacts: [{ id: "a" }, { id: "b" }]
    },
    "manifests/one.json",
    "plans/one.md",
    "registered",
    "2026-02-03T04:05:06.000Z"
  );
  assert.deepEqual(entry, {
    manifest_id: MANIFEST_ID,
    manifest_path: "manifests/one.json",
    plan_path: "plans/one.md",
    manifest_fingerprint: "fp",
    context_fingerprint: "ctx",
    approved_direction_id: "atlas-calm",
    surface: "application",
    generator: "imagegen",
    artifact_count: 2,
    status: "registered",
    updated_at: "2026-02-03T04:05:06.000Z"
  });
  assert.equal(referenceFactoryEntry({ id: MANIFEST_ID, artifacts: [] }, "m", "p").status, "planned");
});

test("a well-formed PNG reports its dimensions and no findings", () => {
  assert.deepEqual(inspectPngStructure(png(960, 640)), { width: 960, height: 640, errors: [] });
});

test("anything that is not a PNG is rejected before the chunk walk", () => {
  assert.deepEqual(inspectPngStructure(Buffer.alloc(8)), { width: 0, height: 0, errors: ["File is not a PNG image."] });
  assert.deepEqual(
    inspectPngStructure(Buffer.concat([Buffer.from("NOTAPNG!"), Buffer.alloc(64)])),
    { width: 0, height: 0, errors: ["File is not a PNG image."] }
  );
});

test("a truncated or incomplete PNG names what is missing", () => {
  const noEnd = inspectPngStructure(png(960, 640, { omit: ["IEND"] }));
  assert.deepEqual(noEnd.errors, ["PNG has no end chunk."]);

  const noData = inspectPngStructure(png(960, 640, { omit: ["IDAT", "IEND"] }));
  assert.deepEqual(noData.errors, ["PNG has no image-data chunk.", "PNG has no end chunk."]);

  const full = png(960, 640);
  const truncated = full.subarray(0, full.length - 20);
  assert.ok(inspectPngStructure(truncated).errors.includes("PNG chunk exceeds file length."));
});

test("a PNG whose first chunk is not IHDR, or whose IHDR is malformed, is flagged", () => {
  const wrongFirst = Buffer.concat([
    SIGNATURE,
    chunk("tEXt", Buffer.from("comment")),
    chunk("IHDR", ihdr(100, 100)),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    chunk("IEND", Buffer.alloc(0))
  ]);
  assert.ok(inspectPngStructure(wrongFirst).errors.includes("PNG must start with IHDR."));

  const shortHeader = Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr(100, 100, 10)),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    chunk("IEND", Buffer.alloc(0))
  ]);
  assert.ok(inspectPngStructure(shortHeader).errors.includes("PNG IHDR has an invalid length."));

  const noDimensions = Buffer.concat([
    SIGNATURE,
    chunk("IHDR", Buffer.alloc(13)),
    chunk("IDAT", zlib.deflateSync(Buffer.alloc(16))),
    chunk("IEND", Buffer.alloc(0))
  ]);
  assert.ok(inspectPngStructure(noDimensions).errors.includes("PNG dimensions are missing or invalid."));
});

test("image findings quote the artifact and enforce orientation and the size floor", () => {
  const clean = referenceFactoryImageFindings({
    artifact: { id: "hero", orientation: "landscape" },
    structure: { width: 960, height: 640, errors: [] },
    sizeBytes: 12000
  });
  assert.deepEqual(clean, []);

  const portraitExpected = referenceFactoryImageFindings({
    artifact: { id: "hero", orientation: "portrait" },
    structure: { width: 960, height: 640, errors: [] },
    sizeBytes: 12000
  });
  // 960x640 clears the portrait floor, so orientation is the only finding.
  assert.deepEqual(portraitExpected, ['Artifact "hero" must be portrait.']);

  const landscapeExpected = referenceFactoryImageFindings({
    artifact: { id: "hero", orientation: "landscape" },
    structure: { width: 390, height: 844, errors: [] },
    sizeBytes: 12000
  });
  assert.deepEqual(landscapeExpected, [
    'Artifact "hero" must be landscape.',
    'Artifact "hero" is too small: 390x844; minimum 800x450.'
  ]);
});

test("a structurally broken, tiny artifact reports both, structure first", () => {
  assert.deepEqual(
    referenceFactoryImageFindings({
      artifact: { id: "thumb", orientation: "landscape" },
      structure: { width: 0, height: 0, errors: ["File is not a PNG image."] },
      sizeBytes: 12
    }),
    [
      'Artifact "thumb": File is not a PNG image.',
      'Artifact "thumb" is implausibly small for an inspectable reference.',
      'Artifact "thumb" is too small: 0x0; minimum 800x450.'
    ]
  );
});

test("an artifact with no declared orientation still has to clear the landscape floor", () => {
  assert.deepEqual(
    referenceFactoryImageFindings({
      artifact: { id: "free" },
      structure: { width: 800, height: 450, errors: [] },
      sizeBytes: 900
    }),
    []
  );
});

test("byte-identical artifacts name both sides of the collision", () => {
  assert.equal(
    referenceFactoryIdenticalFinding("left", "right"),
    'Artifacts "left" and "right" are byte-identical; distinct jobs require distinct inspected images.'
  );
});

test("the comparison group keys on what the artifact shows, not which direction it belongs to", () => {
  assert.equal(
    referenceFactoryComparisonGroup({ scope: "root", viewport: "desktop", state: "default", orientation: "landscape" }),
    "root|desktop|default|landscape"
  );
  assert.equal(referenceFactoryComparisonGroup(undefined), "|||");
});

test("near-duplicate findings quote the distance against the hash width", () => {
  assert.deepEqual(
    referenceFactoryDuplicateFindings([{ left_id: "a", right_id: "b", distance: 3 }]),
    [
      'Artifacts "a" and "b" are perceptually near-identical '
      + `(distance 3/${PERCEPTUAL_HASH_BITS}); visual directions must differ in composition, not only styling.`
    ]
  );
  assert.deepEqual(referenceFactoryDuplicateFindings([]), []);
  assert.ok(NEAR_DUPLICATE_MAX_DISTANCE < PERCEPTUAL_HASH_BITS);
});

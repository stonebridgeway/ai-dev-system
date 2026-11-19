import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  DISK_RESERVE_BYTES,
  DISK_TIGHT_HEADROOM_BYTES,
  formatBytes,
  freeSpaceFor,
  judgeDiskSpace
} from "./disk-space.mjs";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A statfs that answers for some paths and reports the rest as absent. */
function fakeStatfs(answers, { code = "ENOENT" } = {}) {
  const asked = [];
  const statfs = async (target) => {
    asked.push(target);
    if (!(target in answers)) {
      const error = new Error(`no such directory: ${target}`);
      error.code = code;
      throw error;
    }
    return { bsize: 4096, bavail: answers[target] / 4096 };
  };
  return { statfs, asked };
}

test("byte counts are said the way a person would say them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(601 * MB), "601 MB");
  assert.equal(formatBytes(3 * GB), "3.0 GB");
  assert.equal(formatBytes(2.5 * 1024 * GB), "2.5 TB");
  // Nothing invented for a number that is not one.
  assert.equal(formatBytes(Number.NaN), "unknown");
  assert.equal(formatBytes(-1), "unknown");
});

test("a directory that does not exist yet is measured on the disk it will live on", async () => {
  const home = path.resolve("/home/somebody");
  const { statfs, asked } = fakeStatfs({ [home]: 40 * GB });

  const free = await freeSpaceFor(path.join(home, ".ai-dev", "models", "bge-m3-onnx"), { statfs });

  assert.equal(free, 40 * GB);
  assert.deepEqual(asked, [
    path.join(home, ".ai-dev", "models", "bge-m3-onnx"),
    path.join(home, ".ai-dev", "models"),
    path.join(home, ".ai-dev"),
    home
  ], "it walks up one level at a time and stops at the first directory that exists");
});

test("a filesystem that will not describe itself is not an answer of zero", async () => {
  // The check exists to refuse a download that cannot fit. A machine where the
  // measurement is unavailable — an exotic filesystem, a platform without
  // statfs — must keep the download it would have finished, so the only honest
  // return is "no opinion".
  const refused = fakeStatfs({}, { code: "EPERM" });
  assert.equal(await freeSpaceFor("/anywhere", { statfs: refused.statfs }), null);
  assert.equal(refused.asked.length, 1, "a refusal is final, not something to walk up from");

  const absent = fakeStatfs({});
  assert.equal(await freeSpaceFor("/anywhere", { statfs: absent.statfs }), null, "walking up ends at the root");

  const nonsense = async () => ({ bsize: "block", bavail: undefined });
  assert.equal(await freeSpaceFor("/anywhere", { statfs: nonsense }), null);
});

test("a download that does not fit is refused, in a sentence with both numbers in it", () => {
  const room = judgeDiskSpace({ free: 280 * MB, needed: 601 * MB, where: "/home/u/.ai-dev/models" });

  assert.equal(room.verdict, "refuse");
  assert.match(room.message, /601 MB/, "what it needs");
  assert.match(room.message, /280 MB/, "what there is");
  assert.match(room.message, /833 MB/, "and what to free, so the user does not do the subtraction");
  assert.match(room.message, /\/home\/u\/\.ai-dev\/models/, "on which disk");
});

test("the reserve is what keeps a download from taking the last of a disk", () => {
  const needed = 601 * MB;
  // Room for the files and nothing after them: refused, because the next thing
  // to be written would be the one that fails.
  assert.equal(judgeDiskSpace({ free: needed + 1 * MB, needed }).verdict, "refuse");
  assert.equal(judgeDiskSpace({ free: needed + DISK_RESERVE_BYTES - 1, needed }).verdict, "refuse");
  assert.notEqual(judgeDiskSpace({ free: needed + DISK_RESERVE_BYTES, needed }).verdict, "refuse");
});

test("a disk that fits the download but little else says so once", () => {
  // As a tester met it: about 3 GB free, the download fits, and the
  // write rate collapses without a word.
  const room = judgeDiskSpace({ free: 3 * GB, needed: 601 * MB, where: "/models" });

  assert.equal(room.verdict, "tight");
  assert.match(room.message, /3\.0 GB free in \/models/);
  assert.match(room.message, /1 MB\/min/, "it names the slowdown that was actually measured");
  assert.match(room.message, /not the network/, "and says which of the two look-alike failures this is");
});

test("a roomy disk is passed over in silence", () => {
  const room = judgeDiskSpace({ free: 601 * MB + DISK_TIGHT_HEADROOM_BYTES, needed: 601 * MB });
  assert.equal(room.verdict, "ok");
  assert.equal(room.message, null);
});

test("nothing is decided from a number nobody has", () => {
  assert.equal(judgeDiskSpace({ free: null, needed: 601 * MB }).verdict, "unknown");
  assert.equal(judgeDiskSpace({ free: 1 * MB, needed: 0 }).verdict, "unknown");
  assert.equal(judgeDiskSpace({ free: 1 * MB, needed: Number.NaN }).verdict, "unknown");
});

test("a total assembled from partly unknown sizes says it is a floor", () => {
  const room = judgeDiskSpace({ free: 100 * MB, needed: 601 * MB, atLeast: true });
  assert.match(room.message, /at least 601 MB/);
});

import fs from "node:fs/promises";
import { after } from "node:test";
import { READER_IDLE_MS } from "../../src/core/search-sqlite.mjs";

const folders = new Set();

// After every test of the file and every test's own `after`: a database a test
// closes in a hook it registered after its folder's was still open when the
// folder went, and Windows refuses to delete a file that is open, where POSIX
// unlinks it (EPERM, EBUSY).
after(() => Promise.all([...folders].map((folder) => removeWhenFree(folder))));

/**
 * Remove a test's temporary folder once the file's tests are over.
 *
 * @param {string} folder
 */
export function removeAfterAll(folder) {
  folders.add(folder);
}

/**
 * A folder removed once nothing holds a file in it: a search reader lets go of
 * its index after `READER_IDLE_MS` idle. A handle never let go still fails it.
 *
 * @param {string} folder
 * @param {{ timeoutMs?: number }} [options]
 */
export async function removeWhenFree(folder, { timeoutMs = READER_IDLE_MS + 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.rm(folder, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

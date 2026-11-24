// Every test gets its own state folder (run log), so no test writes to the real home folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";
const KEY = "AFFINITY_AXI_HOME";
const fresh = (): string => mkdtempSync(join(tmpdir(), "axi-state-"));
const fileDir = fresh(); // covers beforeAll hooks and module-level code of the test file
process.env[KEY] = fileDir;
let dir = fileDir;
beforeEach(() => {
  dir = fresh();
  process.env[KEY] = dir;
});
afterEach(() => {
  process.env[KEY] = fileDir;
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(fileDir, { recursive: true, force: true }));

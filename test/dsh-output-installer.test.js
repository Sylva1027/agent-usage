import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { installDshOutputCapture } from "../scripts/install-dsh-output-capture.mjs";

test("DSH installer preserves the existing patch and backup, and installs only once", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "dsh-output-installer-"));
  try {
    const file = path.join(home, "cordis.patch.yml");
    const previous = "# user config\n- id: user-plugin\n  disabled: false\n";
    await writeFile(file, previous);
    const collector = fileURLToPath(new URL("../scripts/dsh-output-capture.mjs", import.meta.url));
    const first = await installDshOutputCapture({ home, collector });
    assert.equal(first.changed, true);
    assert.equal(await readFile(first.backup, "utf8"), previous);
    const installed = await readFile(file, "utf8");
    assert.ok(installed.startsWith(previous));
    assert.equal(installed.includes("session-log-deepseek"), false);
    assert.equal((await installDshOutputCapture({ home, collector })).changed, false);
    assert.equal(await readFile(file, "utf8"), installed);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

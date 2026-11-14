import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("test runner isolates ambient Hermes paths, keeps discovery enabled and cleans success and failure", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "test-environment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const redirected = path.join(root, "redirected-temp");
  mkdirSync(redirected);
  const expectedParent = realpathSync(
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA, "Temp") : redirected,
  );
  const file = path.join(root, "isolated.test.js");
  writeFileSync(
    file,
    `
    import assert from 'node:assert/strict';
    import { existsSync, mkdirSync } from 'node:fs';
    import path from 'node:path';
    import { tmpdir } from 'node:os';
    import { DatabaseSync } from 'node:sqlite';
    import test from 'node:test';
    import { discoverHermesHomes } from ${JSON.stringify(new URL("../src/usage-core.js", import.meta.url).href)};
    test('isolated discovery', async () => {
      console.log('TEST_ENV_ROOT=' + tmpdir());
      assert.equal(path.dirname(tmpdir()), process.env.TEST_EXPECTED_TEMP_PARENT);
      for (const key of ['HERMES_HOME','HERMES_DATA_DIR_SUFFIX','CODEX_USAGE_HERMES_HOMES','CODEX_USAGE_HERMES'])
        assert.equal(process.env[key], undefined);
      assert.ok(existsSync(path.join(process.env.LOCALAPPDATA, 'Temp')));
      const options = { homeDir: tmpdir(), platform: 'win32' };
      assert.deepEqual(await discoverHermesHomes(options), []);
      const home = path.join(process.env.LOCALAPPDATA, 'hermes');
      mkdirSync(home);
      const db = new DatabaseSync(path.join(home, 'state.db'));
      db.exec('CREATE TABLE sessions(id TEXT,source TEXT,started_at REAL,input_tokens INTEGER,output_tokens INTEGER)');
      db.close();
      assert.equal((await discoverHermesHomes(options))[0].path, home);
      assert.equal(process.env.TEST_FORCE_FAILURE, '0');
    });
  `,
  );
  for (const forceFailure of ["0", "1"]) {
    const env = {
      ...process.env,
      HERMES_HOME: root,
      CODEX_USAGE_HERMES_HOMES: root,
      HERMES_DATA_DIR_SUFFIX: "sentinel",
      CODEX_USAGE_HERMES: "0",
      TEST_FORCE_FAILURE: forceFailure,
      TEMP: redirected,
      TMP: redirected,
      TEST_EXPECTED_TEMP_PARENT: expectedParent,
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/test.mjs", import.meta.url)), "--test-reporter=spec", file],
      {
        encoding: "utf8",
        windowsHide: true,
        env,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, Number(forceFailure), child.stdout + child.stderr);
    const isolated = /TEST_ENV_ROOT=([^\r\n]+)/.exec(child.stdout)?.[1];
    assert.ok(isolated, child.stdout + child.stderr);
    assert.equal(existsSync(isolated), false, "runner must remove its entire temporary environment");
  }
});

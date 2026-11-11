import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  commonHashes,
  isWaifuFile,
  packageRelease,
  releaseDirectory,
  releaseFiles,
  ROOT,
  standardHtml,
} from "../scripts/package-release.mjs";

test("standard HTML removes all five marked islands and preserves the shared page", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const standard = standardHtml(html);
  assert.match(standard, /<html[^>]*data-edition="standard"/);
  assert.match(standard, /href="\/styles.css"/);
  assert.match(standard, /src="\/app.js"/);
  assert.match(standard, /id="themeToggle"/);
  assert.match(standard, /id="importDialog"/);
  assert.doesNotMatch(standard, /waifu:|skinToggle|skinDialog|skinCharacters|skin-bootstrap|skins.css/);
  assert.throws(() => standardHtml(html.replace("<!-- waifu:end -->", "")), /five waifu block endings/);
  assert.throws(
    () => standardHtml(html.replace('data-edition="waifu"', 'data-edition="standard"')),
    /waifu edition root/,
  );
});

test("release allowlist retains runtime/helper inputs and excludes development and authoring files", async () => {
  const files = await releaseFiles();
  assert.ok(files.includes("src/cli.js") && files.includes("src/usage-executor.js"));
  assert.ok(files.includes("public/usage-fields.js") && files.includes("public/styles.css"));
  for (const name of [
    "Cargo.toml",
    "Cargo.lock",
    "build.ps1",
    "src/main.rs",
    "src/usn.rs",
    "bin/windows-source-proof.exe",
    "bin/windows-source-proof.build.json",
  ]) {
    assert.ok(files.includes(`native/windows-source-proof/${name}`), name);
  }
  assert.equal(files.filter((file) => file.endsWith(".webp")).length, 40);
  assert.doesNotMatch(files.join("\n"), /target\/|node_modules\/|\.git|\.png$|^test|^docs|^scripts|^output/m);
  const standard = files.filter((file) => !isWaifuFile(file));
  assert.doesNotMatch(standard.join("\n"), /public\/(?:skin|assets\/skins)/);
  assert.ok(files.includes("public/skin-palette-studio.js"));
});

test("shared core comparison detects a missing file, extra skin file and different bytes", () => {
  const waifu = { "src/cli.js": "a", "public/styles.css": "b", "public/index.html": "c", "public/skins.js": "d" };
  const standard = { "src/cli.js": "a", "public/styles.css": "b", "public/index.html": "e" };
  assert.deepEqual(commonHashes(standard, waifu), { "src/cli.js": "a", "public/styles.css": "b" });
  assert.throws(() => commonHashes({ ...standard, "src/cli.js": "changed" }, waifu), /Shared core differs/);
  assert.throws(() => commonHashes({ "public/index.html": "e" }, waifu));
  assert.throws(() => commonHashes({ ...standard, "public/skins.js": "d" }, waifu));
});

test("output validation rejects source/user locations and existing destinations without touching data", async (t) => {
  for (const directory of [".", "output", "public", "output/..", "../outside", path.parse(ROOT).root]) {
    await assert.rejects(releaseDirectory(ROOT, directory), /child of workspace\/output/);
  }
  await mkdir(path.join(ROOT, "output"), { recursive: true });
  const fixture = await mkdtemp(path.join(ROOT, "output/package-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const existing = path.join(fixture, "existing");
  await mkdir(existing);
  await writeFile(path.join(existing, "user-data.txt"), "keep");
  assert.equal(await releaseDirectory(ROOT, existing), existing);
  await assert.rejects(packageRelease(existing), { code: "EEXIST" });
  await assert.rejects(releaseDirectory(ROOT, path.join(existing, "user-data.txt/release")), /linked\/non-directory/);
  assert.equal(await readFile(path.join(existing, "user-data.txt"), "utf8"), "keep");
});

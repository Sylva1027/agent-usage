import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const ROOT = fileURLToPath(new URL("../", import.meta.url));
const NATIVE = "native/windows-source-proof";
const CORE_PUBLIC = [
  "app-state.js",
  "app.js",
  "calendar.js",
  "html-utils.js",
  "i18n.js",
  "index.html",
  "period-comparison.js",
  "pricing-models.js",
  "quota-usage.js",
  "styles.css",
  "timeline-utils.js",
  "usage-fields.js",
];
const SKIN_PUBLIC = [
  "skin-assets.json",
  "skin-bootstrap.js",
  "skin-palette-studio.html",
  "skin-palette-studio.js",
  "skin-palettes.js",
  "skin-picker.js",
  "skin-ui.js",
  "skins.css",
  "skins.js",
];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const isWaifuFile = (file) =>
  file.startsWith("public/assets/skins/") || SKIN_PUBLIC.some((name) => file === `public/${name}`);

async function walk(directory, extension) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing linked release input: ${file}`);
    if (entry.isDirectory()) files.push(...(await walk(file, extension)));
    else if (entry.isFile() && file.endsWith(extension)) files.push(file);
  }
  return files;
}

export async function releaseFiles(root = ROOT) {
  const files = [
    "package.json",
    "LICENSE",
    ...CORE_PUBLIC.map((name) => `public/${name}`),
    ...SKIN_PUBLIC.map((name) => `public/${name}`),
    ...[
      "Cargo.toml",
      "Cargo.lock",
      "build.ps1",
      "bin/windows-source-proof.exe",
      "bin/windows-source-proof.build.json",
    ].map((name) => `${NATIVE}/${name}`),
  ];
  for (const [directory, extension] of [
    ["src", ".js"],
    [`${NATIVE}/src`, ".rs"],
    ["public/assets/skins", ".webp"],
  ]) {
    files.push(
      ...(await walk(path.join(root, directory), extension)).map((file) =>
        path.relative(root, file).split(path.sep).join("/"),
      ),
    );
  }
  return files.sort();
}

export function standardHtml(html) {
  assert.equal((html.match(/<!-- waifu:start -->/g) || []).length, 5, "Expected five waifu blocks");
  assert.equal((html.match(/<!-- waifu:end -->/g) || []).length, 5, "Expected five waifu block endings");
  const stripped = html.replace(/<!-- waifu:start -->[\s\S]*?<!-- waifu:end -->/g, "");
  assert.ok(!stripped.includes("<!-- waifu:"), "Malformed waifu blocks");
  assert.equal((stripped.match(/data-edition="waifu"/g) || []).length, 1, "Expected waifu edition root");
  assert.ok(!/skinToggle|skinDialog|skinCharacters|\/skin[^\s"']*\.(?:js|css)/.test(stripped), "Unmarked skin entry");
  return stripped.replace('data-edition="waifu"', 'data-edition="standard"');
}

// Only a new output child is writable; no overwrite or recursive removal of caller-provided paths.
export async function releaseDirectory(root, output) {
  const directory = path.resolve(root, output);
  const relative = path.relative(path.resolve(root, "output"), directory);
  assert.ok(
    relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    "Release directory must be a child of workspace/output",
  );
  let current = path.resolve(root);
  for (const segment of path.relative(current, directory).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Refusing linked/non-directory output: ${current}`);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return directory;
}

export async function removeTemporary(directory, parent, prefix) {
  assert.equal(path.dirname(directory), parent);
  assert.ok(path.basename(directory).startsWith(prefix));
  assert.ok(!(await lstat(directory)).isSymbolicLink());
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

export async function nativeCheck(directory) {
  await exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(directory, NATIVE, "build.ps1"), "-Check"], {
    cwd: directory,
  });
}

export async function fileHashes(directory) {
  const files = await walk(directory, "");
  const hashes = {};
  for (const file of files.sort())
    hashes[path.relative(directory, file).split(path.sep).join("/")] = sha256(await readFile(file));
  return hashes;
}

export function commonHashes(standard, waifu) {
  const core = Object.fromEntries(
    Object.entries(waifu).filter(([file]) => file !== "public/index.html" && !isWaifuFile(file)),
  );
  assert.deepEqual(Object.keys(standard).sort(), [...Object.keys(core), "public/index.html"].sort());
  for (const [file, hash] of Object.entries(core)) assert.equal(standard[file], hash, `Shared core differs: ${file}`);
  return core;
}

export async function extractChecked(zip, destination, expected) {
  const { stdout } = await exec("tar", ["-tf", zip], { maxBuffer: 4 * 1024 * 1024 });
  const entries = stdout
    .trim()
    .split(/\r?\n/)
    .map((name) => name.replaceAll("\\", "/"));
  for (const name of entries) {
    assert.ok(
      !name.startsWith("/") && !name.includes(":") && !name.split("/").includes(".."),
      `Unsafe ZIP entry: ${name}`,
    );
    assert.ok(
      Object.hasOwn(expected, name) ||
        (name.endsWith("/") && Object.keys(expected).some((file) => file.startsWith(name))),
      `Unexpected ZIP entry: ${name}`,
    );
  }
  const files = entries.filter((name) => !name.endsWith("/"));
  assert.equal(new Set(files).size, files.length, "Duplicate ZIP entry");
  assert.deepEqual(files.sort(), Object.keys(expected).sort(), "ZIP inventory differs");
  await mkdir(destination);
  await exec("tar", ["-xf", zip, "-C", destination]);
  assert.deepEqual(await fileHashes(destination), expected, "Extracted ZIP hashes differ");
}

export async function packageRelease(output = "output/releases") {
  const directory = await releaseDirectory(ROOT, output);
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory); // EEXIST keeps earlier releases and unrelated files intact.
  const work = await mkdtemp(path.join(directory, ".package-"));
  try {
    const waifu = path.join(work, "waifu");
    const standard = path.join(work, "standard");
    for (const file of await releaseFiles()) {
      const source = path.join(ROOT, file);
      // Check ancestors as well as leaves so junctions cannot collect outside files.
      for (let item = source; item !== path.resolve(ROOT); item = path.dirname(item)) {
        assert.ok(!(await lstat(item)).isSymbolicLink(), `Refusing linked release input: ${item}`);
      }
      const bytes = await readFile(source);
      await mkdir(path.dirname(path.join(waifu, file)), { recursive: true });
      await writeFile(path.join(waifu, file), bytes);
      if (isWaifuFile(file)) continue;
      await mkdir(path.dirname(path.join(standard, file)), { recursive: true });
      await writeFile(
        path.join(standard, file),
        file === "public/index.html" ? standardHtml(bytes.toString("utf8")) : bytes,
      );
    }
    await nativeCheck(waifu);
    const { version, releaseVersion } = JSON.parse(await readFile(path.join(waifu, "package.json"), "utf8"));
    assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
    assert.match(releaseVersion, /^\d+\.\d+[a-z]?$/);
    const variants = {};
    for (const [edition, stage] of [
      ["standard", standard],
      ["waifu", waifu],
    ]) {
      const filename = `${releaseVersion}${edition === "waifu" ? "-waifu" : ""}.zip`;
      const zip = path.join(directory, filename);
      await exec(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          '$ErrorActionPreference = "Stop"; Get-ChildItem -LiteralPath $env:AGENT_USAGE_PACKAGE_STAGE | Compress-Archive -DestinationPath $env:AGENT_USAGE_PACKAGE_ZIP',
        ],
        { env: { ...process.env, AGENT_USAGE_PACKAGE_STAGE: stage, AGENT_USAGE_PACKAGE_ZIP: zip } },
      );
      const files = await fileHashes(stage);
      await extractChecked(zip, path.join(work, `verify-${edition}`), files);
      variants[edition] = { filename, sha256: sha256(await readFile(zip)), files };
    }
    const core = commonHashes(variants.standard.files, variants.waifu.files);
    const manifest = {
      version,
      releaseVersion,
      createdAt: new Date().toISOString(),
      coreSha256: sha256(JSON.stringify(core)),
      core,
      variants,
    };
    await writeFile(path.join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      directory,
      version,
      releaseVersion,
      coreSha256: manifest.coreSha256,
      archives: Object.values(variants).map(({ filename }) => filename),
    };
  } finally {
    await removeTemporary(work, directory, ".package-");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length <= 3, "Usage: node scripts/package-release.mjs [output/new-directory]");
  console.log(JSON.stringify(await packageRelease(process.argv[2]), null, 2));
}

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const packageScript = path.join(repositoryRoot, "scripts", "package-codex-generation.ps1");
const launcherScript = path.join(repositoryRoot, "scripts", "start-codex-generation.ps1");
const fakeSource = path.join(repositoryRoot, "test-support", "codex-generation-fake-process.cs");
const helperNames = [
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "rg.exe",
];
const fixturePids = new Set();
const auxiliaryRoots = new Set();

let temporaryRoot;
let sourceRoot;
let fakeExecutable;
let packageRoot;
let engineSource;
let helperSources;
let patchSource;
let packageBuild;
let desktopLauncherSequence = 0;

function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.CODEX_CLI_PATH;
  delete environment.CODEX_APP_RUNTIME_CLI_PATH;
  return { ...environment, ...overrides };
}

function runPwsh(arguments_, { environment = cleanEnvironment(), timeout = 30000 } = {}) {
  return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    timeout,
    windowsHide: true,
  });
}

function parseResult(result) {
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, `Expected JSON output. stderr=${result.stderr}`);
  return JSON.parse(lines.at(-1));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function findCSharpCompiler() {
  const windowsRoot = process.env.SystemRoot;
  assert.ok(windowsRoot, "SystemRoot is required for the Windows fixture compiler.");
  const candidates = [
    path.join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windowsRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const compiler = candidates.find((candidate) => existsSync(candidate));
  assert.ok(compiler, "Could not find the .NET Framework C# compiler.");
  return compiler;
}

function compileFakeExecutable(output) {
  const compiler = findCSharpCompiler();
  const result = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${output}`, fakeSource], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, `Fake executable compilation failed.\n${result.stdout}\n${result.stderr}`);
}

function trackPid(pid) {
  if (Number.isInteger(pid) && pid > 0) {
    fixturePids.add(pid);
  }
}

function stopFixtureProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForFile(file, timeoutMilliseconds = 5000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for fixture file: ${file}`);
}

async function listPackageFiles(root) {
  const files = [];
  async function visit(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function createDesktopFixture(name, options = {}) {
  const directory = path.join(temporaryRoot, name);
  await mkdir(directory, { recursive: true });
  const executable = path.join(directory, "ChatGPT Desktop.exe");
  const readyFile = path.join(directory, "desktop-ready.json");
  const evidenceFile = path.join(directory, "engine-evidence.json");
  const configFile = path.join(directory, "desktop config.txt");
  await copyFile(fakeExecutable, executable);
  await writeFile(
    configFile,
    [
      readyFile,
      evidenceFile,
      options.engineOverride ?? "-",
      String(options.engineHoldMilliseconds ?? 2500),
      String(options.desktopHoldMilliseconds ?? 6000),
    ].join("\r\n"),
    "utf8",
  );
  return { directory, executable, readyFile, evidenceFile, configFile };
}

async function createRegisteredDesktopFixture(name, options = {}) {
  const fixture = await createDesktopFixture(name, options);
  const manifestPath = path.join(fixture.directory, "AppxManifest.xml");
  await writeFile(
    manifestPath,
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">',
      "  <Applications>",
      '    <Application Id="App" Executable="ChatGPT Desktop.exe" EntryPoint="Windows.FullTrustApplication" />',
      "  </Applications>",
      "</Package>",
    ].join("\n"),
    "utf8",
  );
  return { ...fixture, manifestPath };
}

function powerShellString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function createDesktopLauncherHarness(manifestPaths) {
  const source = await readFile(launcherScript, "utf8");
  const startMarker = "function Get-RegisteredDesktopExecutables {";
  const endMarker = "\nfunction Get-DesktopExecutable {";
  assert.equal(source.split(startMarker).length - 1, 1, "Registry discovery function marker must be unique.");
  assert.doesNotMatch(source, /DesktopRegistryManifest|ManifestOverrides/);

  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, "Registry discovery function must precede the Desktop selector.");

  const manifests = manifestPaths.map(powerShellString).join(", ");
  const replacement = [
    startMarker,
    "    $registered = [System.Collections.Generic.List[string]]::new()",
    "    $seen = [System.Collections.Generic.HashSet[string]]::new(",
    "        [StringComparer]::OrdinalIgnoreCase",
    "    )",
    `    foreach ($manifestPath in @(${manifests})) {`,
    "        if (-not [System.IO.Path]::IsPathFullyQualified($manifestPath)) {",
    '            throw "Test registry manifest must be absolute: $manifestPath"',
    "        }",
    "        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {",
    '            throw "Test registry manifest does not exist: $manifestPath"',
    "        }",
    "        $fullManifestPath = [System.IO.Path]::GetFullPath($manifestPath)",
    "        $candidate = Get-DesktopExecutableFromManifest `",
    "            -PackageRoot (Split-Path -Parent $fullManifestPath) `",
    "            -ManifestPath $fullManifestPath",
    "        if ($null -eq $candidate) {",
    '            throw "Test registry manifest has no Desktop executable: $manifestPath"',
    "        }",
    "        if ($seen.Add($candidate)) {",
    "            $registered.Add($candidate)",
    "        }",
    "    }",
    "    return $registered.ToArray()",
    "}",
  ].join("\r\n");

  const harnessDirectory = path.join(temporaryRoot, "launcher harnesses");
  await mkdir(harnessDirectory, { recursive: true });
  const harnessPath = path.join(harnessDirectory, `launcher-${desktopLauncherSequence++}.ps1`);
  await writeFile(harnessPath, source.slice(0, start) + replacement + source.slice(end), "utf8");
  return harnessPath;
}

async function startDesktopFixture(fixture, environment = cleanEnvironment()) {
  if (!environment.CODEX_CLI_PATH) {
    environment = {
      ...environment,
      CODEX_CLI_PATH: path.join(packageRoot, "bin", "codex.exe"),
    };
  }
  const child = spawn(fixture.executable, [fixture.configFile], {
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });
  trackPid(child.pid);
  await waitForFile(fixture.readyFile);
  const ready = JSON.parse(await readFile(fixture.readyFile, "utf8"));
  trackPid(ready.childPid);
  return { child, ready };
}

before(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "codex generation launcher "));
  sourceRoot = path.join(temporaryRoot, "source inputs with spaces");
  await mkdir(sourceRoot, { recursive: true });

  fakeExecutable = path.join(sourceRoot, "fake process.exe");
  compileFakeExecutable(fakeExecutable);
  engineSource = path.join(sourceRoot, "codex.exe");
  await copyFile(fakeExecutable, engineSource);

  helperSources = [];
  for (const helperName of helperNames) {
    const helperPath = path.join(sourceRoot, helperName);
    await writeFile(helperPath, `fixture helper: ${helperName}\n`, "utf8");
    helperSources.push(helperPath);
  }

  patchSource = path.join(sourceRoot, "producer patch.patch");
  await writeFile(patchSource, "diff --git a/example b/example\n", "utf8");

  packageRoot = path.join(temporaryRoot, "packages with spaces", "0.165.0-alpha.1.2-fd885019");
  const result = runPwsh(
    [
      "-File",
      packageScript,
      "-Engine",
      engineSource,
      "-Helpers",
      helperSources.join(";"),
      "-Destination",
      packageRoot,
      "-Version",
      "0.165.0-alpha.1.2",
      "-UpstreamCommit",
      "720fec862a608ae1e5878d1eecb04fb93192e93c",
      "-Patch",
      patchSource,
    ],
    {
      environment: cleanEnvironment({
        LOCALAPPDATA: path.join(temporaryRoot, "redirected local app data", "Packages", "sandbox.fixture", "AC"),
      }),
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, `Package fixture failed.\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  packageBuild = parseResult(result);
});

after(async () => {
  for (const pid of fixturePids) {
    stopFixtureProcess(pid);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const root of auxiliaryRoots) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Codex generation package and launcher", { concurrency: false }, () => {
  test("builds the native package layout with complete manifest integrity", async () => {
    assert.equal(packageBuild.ok, true);
    assert.equal(packageBuild.packageRoot, packageRoot);

    const descriptor = JSON.parse(await readFile(path.join(packageRoot, "codex-package.json"), "utf8"));
    assert.deepEqual(descriptor, {
      layoutVersion: 1,
      version: "0.165.0-alpha.1.2",
      target: "x86_64-pc-windows-msvc",
      variant: "codex",
      entrypoint: "bin/codex.exe",
      resourcesDir: "codex-resources",
      pathDir: "codex-path",
    });

    const manifest = JSON.parse(await readFile(path.join(packageRoot, "codex-generation-manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.package.upstreamCommit, "720fec862a608ae1e5878d1eecb04fb93192e93c");
    assert.equal(manifest.package.producerPatch.sha256, sha256(await readFile(patchSource)));
    assert.equal(manifest.files.length, 6, "The descriptor, engine, and four required helpers must all be covered.");

    const listedPaths = manifest.files.map((entry) => entry.path).sort();
    const actualPaths = (await listPackageFiles(packageRoot)).filter(
      (file) => file !== "codex-generation-manifest.json",
    );
    assert.deepEqual(listedPaths, actualPaths);
    assert.ok(!manifest.files.some((entry) => entry.role === "windows_sandbox_service"));
    for (const entry of manifest.files) {
      const bytes = await readFile(path.join(packageRoot, ...entry.path.split("/")));
      assert.equal(bytes.length, entry.bytes, entry.path);
      assert.equal(sha256(bytes), entry.sha256, entry.path);
    }
  });

  test("rejects invalid package inputs before creating a destination", async () => {
    const missingDestination = path.join(temporaryRoot, "missing helper output");
    const missingHelperResult = runPwsh([
      "-File",
      packageScript,
      "-Engine",
      engineSource,
      "-Helpers",
      helperSources.slice(1).join(";"),
      "-Destination",
      missingDestination,
      "-Version",
      "0.165.0-alpha.1.2",
      "-UpstreamCommit",
      "720fec862a608ae1e5878d1eecb04fb93192e93c",
      "-Patch",
      patchSource,
    ]);
    assert.notEqual(missingHelperResult.status, 0);
    assert.match(parseResult(missingHelperResult).error.message, /Missing required helper/);
    assert.equal(existsSync(missingDestination), false);

    const badEngineResult = runPwsh([
      "-File",
      packageScript,
      "-Engine",
      path.join(temporaryRoot, "does-not-exist", "codex.exe"),
      "-Helpers",
      helperSources.join(";"),
      "-Destination",
      path.join(temporaryRoot, "bad engine output"),
      "-Version",
      "0.165.0-alpha.1.2",
      "-UpstreamCommit",
      "720fec862a608ae1e5878d1eecb04fb93192e93c",
      "-Patch",
      patchSource,
    ]);
    assert.notEqual(badEngineResult.status, 0);
    assert.match(parseResult(badEngineResult).error.message, /does not exist/);
  });

  test("CLI forwards every argument and preserves CODEX_HOME without adding CODEX_CLI_PATH", async () => {
    const originalCliPath = process.env.CODEX_CLI_PATH;
    const evidenceFile = path.join(temporaryRoot, "cli engine evidence.json");
    const isolatedHome = path.join(temporaryRoot, "isolated Codex Home");
    await mkdir(isolatedHome, { recursive: true });
    const cliArguments = [
      "engine",
      evidenceFile,
      "0",
      "plain",
      "space value",
      "",
      "--flag=value",
      'quote"value',
      "trailing\\",
      "-PackageRoot",
      "engine supplied value",
      "-DesktopExecutable",
      "desktop engine value",
    ];
    const result = runPwsh(["-File", launcherScript, "cli", "-PackageRoot", packageRoot, "--", ...cliArguments], {
      environment: cleanEnvironment({ CODEX_HOME: isolatedHome }),
    });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    assert.deepEqual(evidence.argv, cliArguments);
    assert.equal(evidence.codexHome, isolatedHome);
    assert.equal(evidence.codexCliPath, null);
    assert.equal(process.env.CODEX_CLI_PATH, originalCliPath);
  });

  test("package discovery handles redirected LOCALAPPDATA and rejects ambiguity", async () => {
    const privateTestRoot = path.join(
      repositoryRoot,
      ".codex-usage",
      "tps-v4-implementation-20261029",
      "codex",
      "test-runtime",
    );
    await mkdir(privateTestRoot, { recursive: true });
    const ordinaryProfile = await mkdtemp(path.join(privateTestRoot, "ordinary-profile-"));
    auxiliaryRoots.add(ordinaryProfile);
    const ordinaryLocalAppData = path.join(ordinaryProfile, "AppData", "Local");
    const discoveredRoot = path.join(
      ordinaryLocalAppData,
      "Programs",
      "CodexTps",
      "versions",
      "0.165.0-alpha.1.2-fd885019",
    );
    await mkdir(path.dirname(discoveredRoot), { recursive: true });
    await cp(packageRoot, discoveredRoot, { recursive: true });
    const explicitEvidenceFile = path.join(temporaryRoot, "explicit root package evidence.json");
    const discoveredEvidenceFile = path.join(temporaryRoot, "discovered root package evidence.json");
    const redirectedLocalAppData = path.join(
      temporaryRoot,
      "redirected local app data",
      "Packages",
      "sandbox.fixture",
      "AC",
    );

    const explicitResult = runPwsh(
      [
        "-File",
        launcherScript,
        "cli",
        "-LocalAppDataRoot",
        ordinaryLocalAppData,
        "--",
        "engine",
        explicitEvidenceFile,
        "0",
      ],
      {
        environment: cleanEnvironment({
          LOCALAPPDATA: redirectedLocalAppData,
          USERPROFILE: ordinaryProfile,
        }),
      },
    );
    assert.equal(explicitResult.status, 0, `stdout=${explicitResult.stdout}\nstderr=${explicitResult.stderr}`);
    const explicitEvidence = JSON.parse(await readFile(explicitEvidenceFile, "utf8"));
    assert.deepEqual(explicitEvidence.argv, ["engine", explicitEvidenceFile, "0"]);

    const discoveredResult = runPwsh(["-File", launcherScript, "cli", "--", "engine", discoveredEvidenceFile, "0"], {
      environment: cleanEnvironment({
        LOCALAPPDATA: redirectedLocalAppData,
        USERPROFILE: ordinaryProfile,
      }),
    });
    assert.equal(discoveredResult.status, 0, `stdout=${discoveredResult.stdout}\nstderr=${discoveredResult.stderr}`);
    const discoveredEvidence = JSON.parse(await readFile(discoveredEvidenceFile, "utf8"));
    assert.deepEqual(discoveredEvidence.argv, ["engine", discoveredEvidenceFile, "0"]);

    const secondRoot = path.join(ordinaryLocalAppData, "Programs", "CodexTps", "versions", "0.9.0-test");
    await mkdir(secondRoot, { recursive: true });
    await cp(path.join(packageRoot, "codex-package.json"), path.join(secondRoot, "codex-package.json"));
    const ambiguousResult = runPwsh(["-File", launcherScript, "cli", "--", "--version"], {
      environment: cleanEnvironment({
        LOCALAPPDATA: redirectedLocalAppData,
        USERPROFILE: ordinaryProfile,
      }),
    });
    assert.notEqual(ambiguousResult.status, 0);
    assert.match(
      parseResult(ambiguousResult).error.message,
      /Multiple side-by-side Codex packages.*specify -PackageRoot explicitly/,
    );
  });

  test("launcher rejects missing files, tampering, extra files, and an invalid root", async () => {
    const missingRoot = path.join(temporaryRoot, "missing file package");
    await cp(packageRoot, missingRoot, { recursive: true });
    await unlink(path.join(missingRoot, "codex-resources", "codex-command-runner.exe"));
    const missingResult = runPwsh(["-File", launcherScript, "cli", "-PackageRoot", missingRoot, "--", "--version"]);
    assert.notEqual(missingResult.status, 0);
    assert.match(parseResult(missingResult).error.message, /file set|integrity manifest/);

    const tamperedRoot = path.join(temporaryRoot, "tampered package");
    await cp(packageRoot, tamperedRoot, { recursive: true });
    await appendFile(path.join(tamperedRoot, "bin", "codex.exe"), "tamper");
    const tamperedResult = runPwsh(["-File", launcherScript, "cli", "-PackageRoot", tamperedRoot, "--", "--version"]);
    assert.notEqual(tamperedResult.status, 0);
    assert.match(parseResult(tamperedResult).error.message, /integrity verification/);

    const extraRoot = path.join(temporaryRoot, "extra file package");
    await cp(packageRoot, extraRoot, { recursive: true });
    await writeFile(
      path.join(extraRoot, "bin", "codex-generation-manifest.json"),
      "nested manifest-like extra",
      "utf8",
    );
    const extraResult = runPwsh(["-File", launcherScript, "cli", "-PackageRoot", extraRoot, "--", "--version"]);
    assert.notEqual(extraResult.status, 0);
    assert.match(parseResult(extraResult).error.message, /file set/);

    const invalidResult = runPwsh([
      "-File",
      launcherScript,
      "cli",
      "-PackageRoot",
      path.join(temporaryRoot, "missing package"),
      "--",
      "--version",
    ]);
    assert.notEqual(invalidResult.status, 0);
    assert.match(parseResult(invalidResult).error.message, /does not exist/);
  });

  test("Desktop verifies only the new descendant engine path and hash", async () => {
    const originalCliPath = process.env.CODEX_CLI_PATH;
    const fixture = await createRegisteredDesktopFixture("verified desktop");
    const desktopLauncher = await createDesktopLauncherHarness([fixture.manifestPath]);
    const result = runPwsh([
      "-File",
      desktopLauncher,
      "desktop",
      "-PackageRoot",
      packageRoot,
      "-DesktopExecutable",
      fixture.executable,
      "-DesktopArgument",
      fixture.configFile,
      "-IdentityTimeoutMilliseconds",
      "5000",
    ]);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const output = parseResult(result);
    assert.equal(output.status, "desktop_engine_verified");
    assert.equal(output.engineExecutable, path.join(packageRoot, "bin", "codex.exe"));
    assert.equal(output.engineSha256, sha256(await readFile(path.join(packageRoot, "bin", "codex.exe"))));
    trackPid(output.desktopProcessId);
    await waitForFile(fixture.readyFile);
    const ready = JSON.parse(await readFile(fixture.readyFile, "utf8"));
    trackPid(ready.childPid);
    await waitForFile(fixture.evidenceFile);
    const evidence = JSON.parse(await readFile(fixture.evidenceFile, "utf8"));
    assert.equal(ready.codexCliPath, path.join(packageRoot, "bin", "codex.exe"));
    assert.equal(evidence.codexCliPath, path.join(packageRoot, "bin", "codex.exe"));
    assert.equal(process.env.CODEX_CLI_PATH, originalCliPath);
  });

  test("Desktop running refusal does not launch or stop the existing process", async () => {
    const runningFixture = await createRegisteredDesktopFixture("already running desktop", {
      desktopHoldMilliseconds: 10000,
    });
    const running = await startDesktopFixture(runningFixture);
    const secondFixture = await createDesktopFixture("must not launch desktop");
    const desktopLauncher = await createDesktopLauncherHarness([runningFixture.manifestPath]);

    const result = runPwsh([
      "-File",
      desktopLauncher,
      "desktop",
      "-PackageRoot",
      packageRoot,
      "-DesktopExecutable",
      runningFixture.executable,
      "-DesktopArgument",
      secondFixture.configFile,
      "-IdentityTimeoutMilliseconds",
      "1000",
    ]);
    assert.equal(result.status, 2);
    const output = parseResult(result);
    assert.equal(output.error.code, "desktop_already_running");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(running.child.exitCode, null);
    assert.equal(isProcessRunning(running.child.pid), true);
    assert.equal(existsSync(secondFixture.readyFile), false);
  });

  test("Desktop refusal includes an older registered version while auto-selecting the newest", async () => {
    const newestFixture = await createRegisteredDesktopFixture("newest registered desktop");
    const olderFixture = await createRegisteredDesktopFixture("older running desktop", {
      desktopHoldMilliseconds: 10000,
    });
    const running = await startDesktopFixture(olderFixture);
    const desktopLauncher = await createDesktopLauncherHarness([newestFixture.manifestPath, olderFixture.manifestPath]);

    const result = runPwsh([
      "-File",
      desktopLauncher,
      "desktop",
      "-PackageRoot",
      packageRoot,
      "-DesktopArgument",
      newestFixture.configFile,
      "-IdentityTimeoutMilliseconds",
      "1000",
    ]);
    assert.equal(result.status, 2);
    const output = parseResult(result);
    assert.equal(output.error.code, "desktop_already_running");
    assert.equal(output.desktopExecutable, newestFixture.executable);
    assert.deepEqual(output.registeredDesktopExecutables, [newestFixture.executable, olderFixture.executable]);
    assert.deepEqual(output.matchedDesktopExecutables, [olderFixture.executable]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(running.child.exitCode, null);
    assert.equal(isProcessRunning(running.child.pid), true);
    assert.equal(existsSync(newestFixture.readyFile), false);
  });

  test("Desktop refusal includes a registered identity different from the explicit target", async () => {
    const runningFixture = await createRegisteredDesktopFixture("registered older desktop", {
      desktopHoldMilliseconds: 10000,
    });
    const running = await startDesktopFixture(runningFixture);
    const targetFixture = await createDesktopFixture("explicit newer desktop");
    const desktopLauncher = await createDesktopLauncherHarness([runningFixture.manifestPath]);

    const result = runPwsh([
      "-File",
      desktopLauncher,
      "desktop",
      "-PackageRoot",
      packageRoot,
      "-DesktopExecutable",
      targetFixture.executable,
      "-DesktopArgument",
      targetFixture.configFile,
      "-IdentityTimeoutMilliseconds",
      "1000",
    ]);
    assert.equal(result.status, 2);
    const output = parseResult(result);
    assert.equal(output.error.code, "desktop_already_running");
    assert.equal(output.desktopExecutable, targetFixture.executable);
    assert.deepEqual(output.registeredDesktopExecutables, [runningFixture.executable]);
    assert.deepEqual(output.matchedDesktopExecutables, [runningFixture.executable]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(running.child.exitCode, null);
    assert.equal(isProcessRunning(running.child.pid), true);
    assert.equal(existsSync(targetFixture.readyFile), false);
  });

  test("Desktop running checks ignore an unrelated process merely named codex.exe", async () => {
    const fixture = await createRegisteredDesktopFixture("desktop with unrelated cli");
    const cliDirectory = path.join(temporaryRoot, "unrelated cli");
    await mkdir(cliDirectory, { recursive: true });
    const cliExecutable = path.join(cliDirectory, "codex.exe");
    const cliEvidence = path.join(cliDirectory, "cli evidence.json");
    await copyFile(fakeExecutable, cliExecutable);
    const unrelatedCli = spawn(cliExecutable, ["engine", cliEvidence, "60000"], {
      env: cleanEnvironment(),
      stdio: "ignore",
      windowsHide: true,
    });
    trackPid(unrelatedCli.pid);
    await waitForFile(cliEvidence);
    const desktopLauncher = await createDesktopLauncherHarness([fixture.manifestPath]);

    const result = runPwsh([
      "-File",
      desktopLauncher,
      "desktop",
      "-PackageRoot",
      packageRoot,
      "-DesktopExecutable",
      fixture.executable,
      "-DesktopArgument",
      fixture.configFile,
      "-IdentityTimeoutMilliseconds",
      "5000",
    ]);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const output = parseResult(result);
    assert.equal(output.status, "desktop_engine_verified");
    assert.notEqual(output.engineProcessId, unrelatedCli.pid);
    assert.equal(isProcessRunning(unrelatedCli.pid), true);
    trackPid(output.desktopProcessId);
    await waitForFile(fixture.readyFile);
    const ready = JSON.parse(await readFile(fixture.readyFile, "utf8"));
    trackPid(ready.childPid);
  });

  test("Desktop fallback to a different engine is a failure, not a window-start success", async () => {
    const fallbackDirectory = path.join(temporaryRoot, "fallback engine");
    await mkdir(fallbackDirectory, { recursive: true });
    const fallbackEngine = path.join(fallbackDirectory, "codex.exe");
    await copyFile(fakeExecutable, fallbackEngine);
    const fixture = await createRegisteredDesktopFixture("fallback desktop", {
      engineOverride: fallbackEngine,
      engineHoldMilliseconds: 2000,
      desktopHoldMilliseconds: 5000,
    });
    const desktopLauncher = await createDesktopLauncherHarness([fixture.manifestPath]);

    const result = runPwsh([
      "-File",
      desktopLauncher,
      "desktop",
      "-PackageRoot",
      packageRoot,
      "-DesktopExecutable",
      fixture.executable,
      "-DesktopArgument",
      fixture.configFile,
      "-IdentityTimeoutMilliseconds",
      "1200",
    ]);
    assert.equal(result.status, 3);
    const output = parseResult(result);
    assert.equal(output.error.code, "desktop_engine_identity_not_found");
    assert.ok(output.observedCodexExecutables.includes(fallbackEngine));
    trackPid(output.desktopProcessId);
    await waitForFile(fixture.readyFile);
    const ready = JSON.parse(await readFile(fixture.readyFile, "utf8"));
    trackPid(ready.childPid);
  });
});

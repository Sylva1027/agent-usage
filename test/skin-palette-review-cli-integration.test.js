import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createPaletteFixture,
  FIXTURE_EVENT_COUNT,
  FIXTURE_TOTAL_TOKENS,
} from "../test-support/skin-palette-fixture.mjs";
import * as contracts from "../scripts/skin-palette/contracts.mjs";
import { REPO_ROOT } from "../scripts/skin-palette/review-evidence.mjs";
import { runReviewCommand } from "../scripts/skin-palette/review-cli.mjs";
import { PALETTE_TOKEN_KEYS } from "../public/skins.js";

const cliPath = path.resolve("scripts/skin-palette/review-cli.mjs");
const validationRoot = path.join(REPO_ROOT, "docs", "validation");

function createCandidateSet() {
  const skinId = contracts.SKIN_IDS[0];
  const profileSnapshot = { sample: "C2 integration only" };
  const tokens = Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, "#334455"]));
  const candidate = {
    schemaVersion: 1,
    skinId,
    variant: "a",
    profileVersion: 1,
    profileSnapshot,
    profileHash: contracts.sha256Canonical(profileSnapshot),
    policyHash: "a".repeat(64),
    derivationHash: "b".repeat(64),
    seed: "palette-redesign-v1",
    style: { title: "C2 fixture", rationale: "Integration wiring sample", identitySource: "test" },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light: tokens, dark: tokens },
  };
  candidate.candidateHash = contracts.hashCandidate(candidate);
  candidate.id = `${skinId}-a-${candidate.candidateHash.slice(0, 12)}`;
  const candidateSet = {
    schemaVersion: 1,
    inputHashes: {
      profiles: "1".repeat(64),
      policy: "2".repeat(64),
      roles: contracts.hashRoleInputs(),
      derivation: "3".repeat(64),
    },
    candidates: [candidate],
    rejected: [],
  };
  candidateSet.candidateSetHash = contracts.hashCandidateSet(candidateSet);
  assert.equal(contracts.validateCandidateSet(candidateSet, { expectedSkinIds: [] }).valid, true);
  return candidateSet;
}

async function createRun(testRoot, name, candidateSet = createCandidateSet()) {
  const runDir = path.join(testRoot, name);
  await fs.promises.mkdir(runDir, { recursive: true });
  await fs.promises.writeFile(path.join(runDir, "candidates.json"), `${JSON.stringify(candidateSet)}\n`, "utf8");
  await fs.promises.writeFile(
    path.join(runDir, "captures-index.json"),
    `${JSON.stringify({ schemaVersion: 1, captures: {} })}\n`,
    "utf8",
  );
  return {
    candidateSet,
    indexArg: path.relative(REPO_ROOT, path.join(runDir, "captures-index.json")),
    reportPath: path.join(runDir, "report.html"),
    runArg: path.relative(REPO_ROOT, runDir),
    runDir,
  };
}

function runNode(args, cwd, timeoutMs = 15_000) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        timedOut,
      });
    });
  });
}

async function makeDifferentCwd() {
  const cwdRoot = await fs.promises.mkdtemp(path.join(tmpdir(), "review cli c2-"));
  try {
    const cwd = path.join(cwdRoot, "different working directory with spaces");
    await fs.promises.mkdir(cwd);
    return { cwd, cwdRoot };
  } catch (error) {
    await fs.promises.rm(cwdRoot, { recursive: true, force: true });
    throw error;
  }
}

function assertNoTimeout(result) {
  assert.equal(result.timedOut, false, "child process exceeded its watchdog bound");
}

test("default verify/report subprocesses preserve incomplete evidence and reject invalid inputs", async () => {
  const testRoot = await fs.promises.mkdtemp(path.join(validationRoot, "m4-4-5-c2-"));
  let cwdRoot = null;
  try {
    const cwdFixture = await makeDifferentCwd();
    const { cwd } = cwdFixture;
    cwdRoot = cwdFixture.cwdRoot;
    const incomplete = await createRun(testRoot, "incomplete");
    const verify = await runNode([cliPath, "verify", "--run", incomplete.runArg], cwd);
    assertNoTimeout(verify);
    assert.equal(verify.code, 2);
    assert.equal(verify.signal, null);
    const verifyOutput = JSON.parse(verify.stdout);
    assert.equal(verifyOutput.status, "incomplete");
    assert.ok(verifyOutput.gaps.some((gap) => gap.code === "capture-missing"));
    assert.ok(verifyOutput.gaps.some((gap) => gap.code === "assessment-missing"));

    const requireSelections = await runNode(
      [cliPath, "verify", "--run", incomplete.runArg, "--require-selections"],
      cwd,
    );
    assertNoTimeout(requireSelections);
    assert.equal(requireSelections.code, 2);
    const selectionsOutput = JSON.parse(requireSelections.stdout);
    assert.equal(selectionsOutput.status, "incomplete");
    assert.ok(selectionsOutput.gaps.some((gap) => gap.code === "selections-missing"));
    assert.doesNotMatch(requireSelections.stdout, /"status":"pass"/);

    const report = await runNode(
      [cliPath, "report", "--run", incomplete.runArg, "--captures-index", incomplete.indexArg],
      cwd,
    );
    assertNoTimeout(report);
    assert.equal(report.code, 0);
    assert.equal(report.signal, null);
    assert.match(report.stderr, /warning: report generated with status=incomplete/);
    assert.deepEqual(JSON.parse(report.stdout), { status: "incomplete", reportPath: incomplete.reportPath });
    const originalReport = await fs.promises.readFile(incomplete.reportPath);
    const html = originalReport.toString("utf8");
    assert.match(html, new RegExp(incomplete.candidateSet.candidates[0].id));
    assert.match(html, /capture-missing/);
    assert.match(html, /assessment-missing/);
    assert.match(html, /createSelectionExportCore/);
    assert.doesNotMatch(html, /交互尚未接线/);
    const candidateRadios = [...html.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)].map(([element]) => element);
    assert.equal(candidateRadios.length, 1);
    assert.ok(candidateRadios.every((input) => /\bdisabled\b/.test(input)));

    const duplicateReport = await runNode(
      [cliPath, "report", "--run", incomplete.runArg, "--captures-index", incomplete.indexArg],
      cwd,
    );
    assertNoTimeout(duplicateReport);
    assert.equal(duplicateReport.code, 1);
    assert.equal(duplicateReport.signal, null);
    assert.equal(duplicateReport.stdout, "");
    assert.match(duplicateReport.stderr, /report failed/);
    assert.deepEqual(await fs.promises.readFile(incomplete.reportPath), originalReport);

    for (const invalidKind of ["bad-json", "hash-drift"]) {
      const invalid = await createRun(testRoot, invalidKind);
      if (invalidKind === "bad-json") {
        await fs.promises.writeFile(path.join(invalid.runDir, "candidates.json"), "{bad json", "utf8");
      } else {
        const driftedSet = structuredClone(invalid.candidateSet);
        driftedSet.candidates[0].modes.light.accent = "#AABBCC";
        await fs.promises.writeFile(
          path.join(invalid.runDir, "candidates.json"),
          `${JSON.stringify(driftedSet)}\n`,
          "utf8",
        );
      }

      const invalidVerify = await runNode([cliPath, "verify", "--run", invalid.runArg], cwd);
      assertNoTimeout(invalidVerify);
      assert.equal(invalidVerify.code, 1);
      assert.equal(invalidVerify.stdout, "");
      assert.match(
        invalidVerify.stderr,
        invalidKind === "bad-json" ? /candidates\.json.*合法 JSON/ : /candidateHash|摘要不一致/,
      );

      const invalidReport = await runNode(
        [cliPath, "report", "--run", invalid.runArg, "--captures-index", invalid.indexArg],
        cwd,
      );
      assertNoTimeout(invalidReport);
      assert.equal(invalidReport.code, 1);
      assert.equal(invalidReport.stdout, "");
      assert.match(
        invalidReport.stderr,
        invalidKind === "bad-json" ? /candidates\.json.*合法 JSON/ : /candidateHash|摘要不一致/,
      );
      assert.equal(fs.existsSync(invalid.reportPath), false);
    }

    const outsideArg = path.join("docs", "validation", "..", "..", "c2-outside-run");
    const outsideReport = await runNode(
      [cliPath, "report", "--run", outsideArg, "--captures-index", incomplete.indexArg],
      cwd,
    );
    assertNoTimeout(outsideReport);
    assert.equal(outsideReport.code, 1);
    assert.equal(outsideReport.stdout, "");
    assert.match(outsideReport.stderr, /越出校验根|PATH_ESCAPE|词法路径/);
  } finally {
    await fs.promises.rm(testRoot, { recursive: true, force: true });
    if (cwdRoot) await fs.promises.rm(cwdRoot, { recursive: true, force: true });
  }
});

test("default candidate loader and preview serve the isolated candidate and fixture over HTTP", async () => {
  const testRoot = await fs.promises.mkdtemp(path.join(validationRoot, "m4-4-5-c2-serve-"));
  const signalSource = new EventEmitter();
  let fixture = null;
  let command = null;

  try {
    const sample = await createRun(testRoot, "preview");
    const candidate = sample.candidateSet.candidates[0];
    const stdout = [];
    const stderr = [];
    const fixtures = [];
    const outputReady = new Promise((resolveOutput) => {
      stdout.write = (line) => {
        stdout.push(line);
        resolveOutput(JSON.parse(line));
      };
    });
    command = runReviewCommand(["serve", "--run", sample.runArg, "--candidate", candidate.id], {
      fixtureFactory: async () => {
        fixture = await createPaletteFixture();
        fixtures.push(fixture);
        return fixture;
      },
      signalSource,
      stdout,
      stderr: { write: (line) => stderr.push(line) },
    });
    const commandFinished = command.then(
      (result) => ({ result }),
      (error) => ({ error }),
    );

    const start = await Promise.race([outputReady.then((output) => ({ output })), commandFinished]);
    assert.ok(start.output, start.error?.message ?? `serve exited before output with ${start.result}`);
    assert.deepEqual(start.output, {
      command: "serve",
      candidateId: candidate.id,
      url: start.output.url,
    });
    const usageResponse = await fetch(new URL("/api/usage?preset=all&view=dashboard", start.output.url));
    assert.equal(usageResponse.status, 200);
    const usage = await usageResponse.json();
    assert.equal(usage.metadata.eventCount, FIXTURE_EVENT_COUNT);
    assert.equal(usage.summary.totals.total, FIXTURE_TOTAL_TOKENS);

    const paletteResponse = await fetch(new URL("/skin-palettes.js", start.output.url));
    assert.equal(paletteResponse.status, 200);
    const paletteModule = await paletteResponse.text();
    assert.match(paletteModule, new RegExp(candidate.skinId));
    assert.match(paletteModule, /#334455/);

    signalSource.emit("SIGINT");
    assert.equal(await command, 130);
    const port = Number(new URL(start.output.url).port);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), (error) => {
      const causes = [error.cause, ...(error.cause?.errors ?? [])];
      return causes.some((cause) => cause?.code === "ECONNREFUSED");
    });
    assert.equal(fixtures.length, 1);
    assert.equal(fs.existsSync(path.dirname(fixture.homeDir)), false);
    assert.equal(signalSource.listenerCount("SIGINT"), 0);
    assert.equal(signalSource.listenerCount("SIGTERM"), 0);
    assert.deepEqual(stderr, []);
  } finally {
    if (signalSource.listenerCount("SIGINT") || signalSource.listenerCount("SIGTERM")) {
      signalSource.emit("SIGTERM");
    }
    if (command) await command.catch(() => undefined);
    if (fixture && fs.existsSync(path.dirname(fixture.homeDir))) await fixture.close();
    await fs.promises.rm(testRoot, { recursive: true, force: true });
  }
});

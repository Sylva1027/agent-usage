import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { read, save } from "./c1-datasets.mjs";
import { analyze as analyzeVerification, verificationRows } from "./archive-verification-analyze.mjs";
import { GROUPS, RESULT_ROOT, verifyManifest } from "./archive-compaction-prepare.mjs";
import { validationGate } from "./archive-compaction-run.mjs";
import { exactParity, regressionPassed, resources } from "./persistent-history-analyze.mjs";
import { fingerprint, verifyEntries } from "./persistent-history-prepare.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";
import { deriveResources, withDerivedResources } from "./resource-identity-analysis.mjs";

export const COMPACTION = {
  twoYearLimitsMs: { "append-codex": 35000, "append-dsh": 35000, "append-claude": 35000,
    "append-workbuddy": 35000, "append-zcode": 45000, "append-opencode": 42000, reopen: 45000, "revision-zcode": 78000 },
  improve: ["append-codex", "append-dsh", "append-claude", "append-workbuddy"],
  maximumByteRatio: 0.55,
};
export const STAGES = { current: 4, year: 8, all: 10 };
const COUNTS = { current: 1, year: 4, "two-years": 8 };
const MEMORY_LIMIT = 512 * 1048576;
const SEMANTIC = new Set(["databaseEvidence", "eventEvidence", "sourceEvidence", "candidate.range"]);
const finite = (value, name) => assert.ok(Number.isFinite(value) && value >= 0, `missing/invalid ${name}`);

export function packageGate(packages, stage) {
  assert.ok(Object.hasOwn(STAGES, stage), "stage current|year|all");
  const labels = [...new Set(GROUPS.slice(0, STAGES[stage]).map(row => row.label))];
  return labels.map(label => {
    const entries = packages.filter(row => row.label === label).sort((a, b) => a.index - b.index);
    assert.deepEqual(entries.map(row => row.index), Array.from({ length: COUNTS[label] }, (_, i) => i), `${label}: package coverage`);
    const identities = new Set(), files = new Set();
    for (const row of entries) for (const entry of [row.previous, row.next]) {
      assert.ok(path.isAbsolute(entry.databaseFile));
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
      assert.ok(!identities.has(entry.sha256) && !files.has(entry.databaseFile), "duplicate package identity/path");
      identities.add(entry.sha256); files.add(entry.databaseFile);
    }
    const oldBytes = entries.reduce((sum, row) => sum + row.previous.bytes, 0);
    const newBytes = entries.reduce((sum, row) => sum + row.next.bytes, 0);
    assert.ok(label !== "two-years" || newBytes <= oldBytes * COMPACTION.maximumByteRatio, "two-year packages exceed 55% of original bytes");
    return { label, packages: entries.length, oldBytes, newBytes, byteRatio: newBytes / oldBytes };
  });
}

export function maintenanceGate(maintenance, samples) {
  assert.equal(maintenance.passed, true, "maintenance failed");
  assert.equal(maintenance.result.projection.coldCopied, 0, "maintenance copied cold facts");
  assert.equal(maintenance.result.projection.rebuilt, false, "maintenance rebuilt the projection");
  finite(maintenance.wallMs, "maintenance wall time");
  const active = samples.filter(row => row.service?.processCount > 0);
  assert.ok(active.length > 0, "maintenance has no resource samples");
  for (const row of active) {
    assert.equal(row.service.memoryAvailableProcessCount, row.service.processCount, "incomplete maintenance process memory");
    finite(row.service.workingSetBytes, "maintenance working set");
    finite(row.service.reportedPeakWorkingSetBytes, "maintenance reported peak");
  }
  assert.ok(Number.isFinite(maintenance.resourceUsage?.maxRSS) && maintenance.resourceUsage.maxRSS > 0, "missing maintenance process high-water mark");
  const peakBytes = Math.max(maintenance.resourceUsage.maxRSS * 1024,
    ...active.flatMap(row => [row.service.workingSetBytes, row.service.reportedPeakWorkingSetBytes]));
  assert.equal(maintenance.observed.peakBytes, peakBytes, "maintenance peak disagrees with corrected process evidence");
  assert.ok(peakBytes <= MEMORY_LIMIT, "maintenance exceeds 512 MiB");
  return { peakBytes, limitBytes: MEMORY_LIMIT, samples: active.length };
}

export function upgradeGate(result, measured, responses, clock, packages) {
  assert.equal(result.passed, true, "upgrade runner failed");
  assert.ok(Number.isFinite(Date.parse(clock.asOf)) && clock.phase === "upgrade" && clock.referencePhase === "upgrade", "invalid frozen upgrade clock");
  assert.equal(result.setup.reopen, undefined, "setup must build the old projection once");
  for (const field of ["startedAtMs", "endedAtMs", "wallMs", "defaultMs"]) finite(result.setup.first?.[field], `setup/first/${field}`);
  assert.ok(result.setup.first.endedAtMs >= result.setup.first.startedAtMs, "invalid setup window");
  for (const variant of ["setup", "baseline", "candidate"]) {
    assert.equal(result[variant].passed, true, `${variant}: page runner failed`);
    assert.equal(measured[variant].memory.passed, true, `${variant}: incomplete resources or over 512 MiB`);
  }
  for (const variant of ["baseline", "candidate"]) assert.ok(
    measured[variant].verification.some(row => row.stage === "process-born") && measured[variant].verification.some(row => row.stage === "process-exit"),
    `${variant}: missing verification lifetime trace`);
  assert.equal(result.maintenance.result.switched, packages.length, "maintenance omitted packages");
  const latencies = [];
  for (const phase of ["first", "reopen"]) {
    for (const variant of ["baseline", "candidate"]) {
      const window = result[variant][phase];
      for (const field of ["startedAtMs", "endedAtMs", "wallMs", "defaultMs"]) finite(window?.[field], `${variant}/${phase}/${field}`);
      assert.ok(window.endedAtMs >= window.startedAtMs, "invalid upgrade window");
      assert.equal(responses[variant][phase].metadata.modelUsageAsOf, clock.asOf, `${variant}/${phase}: business clock changed`);
      const clocks = measured[variant].businessClocks.filter(row => row.readAtMs >= Math.floor(window.startedAtMs) && row.readAtMs <= window.endedAtMs);
      assert.ok(clocks.length > 0, `${variant}/${phase}: missing active business-clock reads`);
      assert.ok(clocks.every(row => row.asOf === clock.asOf && row.phase === "upgrade" && row.referencePhase === "upgrade"), "upgrade did not use the frozen clock");
      const expected = new Map(packages.map(row => {
        const entry = row[variant === "baseline" ? "previous" : "next"];
        return [entry.databaseFile, [entry.bytes, entry.sha256]];
      }));
      const hashes = measured[variant].archiveProofs.filter(row => row.startedAtMs >= Math.floor(window.startedAtMs) && row.endedAtMs <= window.endedAtMs);
      assert.equal(new Set(hashes.map(row => row.file)).size, packages.length, `${variant}/${phase}: missing archive hashes`);
      for (const row of hashes) {
        assert.ok(!row.error, "upgrade archive verification failed");
        assert.deepEqual([row.bytes, row.sha256], expected.get(row.file), `${variant}/${phase}: wrong archive bytes/identity`);
      }
    }
    exactParity(responses.candidate[phase], responses.baseline[phase], false, true);
    const baselineMs = result.baseline[phase].wallMs, candidateMs = result.candidate[phase].wallMs;
    latencies.push({ name: phase, baselineMs, candidateMs, passed: regressionPassed(baselineMs, candidateMs) });
    const window = result.candidate[phase];
    const queries = measured.candidate.history.filter(row => row.startedAtMs >= Math.floor(window.startedAtMs) && row.startedAtMs <= window.endedAtMs);
    const fast = (measured.candidate.fastHistory || []).filter(row => row.success === true && !row.error &&
      row.path === "single-archive-all" && row.requestedPreset === "all" && row.preset === "all" && row.bucket === "day" &&
      packages.some(entry => entry.next.sha256 === row.segmentId) && typeof row.summaryProjectionCacheReused === "boolean" &&
      Number.isFinite(row.startedAtMs) && Number.isFinite(row.endedAtMs) && row.endedAtMs >= row.startedAtMs &&
      row.startedAtMs >= Math.floor(window.startedAtMs) && row.endedAtMs <= window.endedAtMs &&
      measured.candidate.nodes.some(node => node.role === "executor" && node.pid === row.pid && node.startedAtMs <= row.startedAtMs && node.endedAtMs >= row.endedAtMs));
    assert.ok(queries.length > 0 || fast.length > 0, `${phase}: missing projection/verified fast-path evidence`);
    for (const row of queries) {
      assert.ok(!row.error && row.endedAtMs >= row.startedAtMs && row.endedAtMs <= window.endedAtMs, `${phase}: incomplete query`);
      assert.equal(row.work?.projection?.coldCopied, 0, `${phase}: copied cold facts`);
      assert.equal(row.work?.projection?.rebuilt, false, `${phase}: rebuilt projection`);
      assert.ok(row.inputVersion && row.publishedVersion?.status === "ready", `${phase}: missing published input version`);
      assert.equal(fingerprint(JSON.parse(row.publishedVersion.inputs_json)), fingerprint(row.inputVersion), `${phase}: projection input mismatch`);
    }
    assert.equal(measured.candidate.verification.filter(row => SEMANTIC.has(row.stage) &&
      row.startedAtMs <= window.endedAtMs && row.endedAtMs >= Math.floor(window.startedAtMs)).length, 0, `${phase}: repeated semantic scan`);
  }
  assert.deepEqual(result.latencies, latencies, "upgrade latency receipt disagrees with raw phase timings");
  assert.ok(latencies.every(row => row.passed), JSON.stringify(latencies.filter(row => !row.passed)));
  return latencies;
}

async function readSamples(file) {
  const rows = [];
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

async function analyzeUpgrade(manifest, label, manifestSha256) {
  const directory = path.join(manifest.resultRoot, "upgrades", label), result = await read(path.join(directory, "result.json"));
  assert.equal(result.label, label);
  assert.equal(result.manifestSha256, manifestSha256);
  assert.equal(result.candidateFingerprint, manifest.candidateFingerprint);
  const measured = {}, responses = {};
  for (const variant of ["setup", "baseline", "candidate"]) {
    const root = path.join(directory, variant);
    assert.deepEqual(await read(path.join(root, "result.json")), result[variant], `${variant}: upgrade result differs from phase receipt`);
    measured[variant] = await resources(root);
    if (variant !== "setup") {
      responses[variant] = { first: await read(path.join(root, "first-all.json")), reopen: await read(path.join(root, "reopen-all.json")) };
      measured[variant].verification = await verificationRows(root);
    }
  }
  assert.deepEqual(await read(path.join(directory, "maintenance/result.json")), result.maintenance);
  const maintenance = maintenanceGate(result.maintenance, await readSamples(path.join(directory, "maintenance/resources.ndjson")));
  const latencies = upgradeGate(result, measured, responses, await read(path.join(directory, "clock.json")),
    manifest.compactPackages.filter(row => row.label === label));
  return { label, directory, passed: true, result, measured, maintenance, latencies };
}

/** Analysis never starts runners. A rejected admission or missing evidence still produces a failed issues artifact. */
export async function analyze(manifestFile, validationFile, outputFile, stage = "all") {
  await assert.rejects(stat(outputFile), { code: "ENOENT" }, "analysis output must be new; preserve previous results");
  const result = { version: 1, kind: "archive-compaction", stage, manifestFile: path.resolve(manifestFile),
    validationFile, groups: [], upgrades: [], issues: [], passed: false, createdAt: new Date().toISOString() };
  const check = async (group, gate, work) => {
    try { return await work(); } catch (error) { result.issues.push({ group, gate, message: error.message }); }
  };
  await check("admission", "analysis", async () => {
    assert.ok(Object.hasOwn(STAGES, stage), "stage current|year|all");
    const manifest = await verifyManifest(manifestFile);
    result.candidateFingerprint = manifest.candidateFingerprint;
    result.manifestSha256 = await hashFile(manifestFile);
    const scopes = ["datasets", "upgrades"].filter(scope => existsSync(path.join(manifest.resultRoot, scope)));
    const receipt = await deriveResources(manifest.resultRoot, scopes);
    result.resourceIdentityCorrection = { receipt: path.join(manifest.resultRoot, "resource-identity/receipt.json"),
      files: receipt.files.length, correctedSamples: receipt.files.reduce((n, row) => n + row.correctedSamples, 0), excludedIdentities: receipt.excludedIdentities };
    await withDerivedResources(receipt, async () => {
      const pages = await analyzeVerification(manifestFile, validationFile, outputFile, stage,
        { ...COMPACTION, verifyManifest: async () => manifest, validationGate, saveResult: false });
      Object.assign(result, { ...pages, issues: [...result.issues, ...pages.issues], passed: false });
      result.packages = await check("packages", "size-and-identity", () => packageGate(manifest.compactPackages, stage));
      for (const label of [...new Set(GROUPS.slice(0, STAGES[stage]).map(row => row.label))]) {
        const upgrade = await check(`upgrade/${label}`, "existing-projection", () => analyzeUpgrade(manifest, label, result.manifestSha256));
        result.upgrades.push(upgrade ?? { label, passed: false });
      }
      await check("packages", "immutable-files", () => verifyEntries(manifest.packageEntries));
    });
  });
  result.standards = { ...result.standards, maximumGroups: 10, requiredGroups: STAGES[stage] ?? null,
    twoYearLimitsMs: COMPACTION.twoYearLimitsMs, requireImprovement: COMPACTION.improve, maximumByteRatio: COMPACTION.maximumByteRatio,
    amountTolerance: 0, serviceEnvelopeBytes: MEMORY_LIMIT, yearMixedRatio: 0.2,
    regression: ">10% AND >100ms fails each operation", upgradeSetup: "one old projection build, charged separately from maintenance and first/reopen" };
  result.passed = result.issues.length === 0 && result.groups.length === STAGES[stage] && result.upgrades.length === ({ current: 1, year: 2, all: 3 }[stage]);
  await save(outputFile, result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const stage = process.argv[2] ?? "all";
  const result = await analyze(path.join(RESULT_ROOT, "manifest.json"), process.argv[3] ?? path.join(RESULT_ROOT, "validation.json"),
    process.argv[4] ?? path.join(RESULT_ROOT, `analysis-${stage}.json`), stage);
  console.log(JSON.stringify({ stage, passed: result.passed, issues: result.issues }));
  if (!result.passed) process.exitCode = 1;
}

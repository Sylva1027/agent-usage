import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { before, describe, it } from "node:test";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPaletteFixture,
  FIXTURE_EVENT_COUNT,
  FIXTURE_TOTAL_TOKENS,
} from "../test-support/skin-palette-fixture.mjs";

describe("parseReviewArgs", () => {
  let parseReviewArgs;
  let runReviewCommand;
  let repoRoot;
  let hashCandidateSet;
  let sha256Canonical;
  let productionSkinId;

  const watchSideEffects = async (callback, { filesystem = false } = {}) => {
    const calls = [];
    const replacements = [];
    const guard =
      (name) =>
      (..._args) => {
        calls.push(name);
        throw new Error(`unexpected side effect: ${name}`);
      };
    const replace = (target, key, name) => {
      if (typeof target[key] !== "function") return;
      replacements.push([target, key, target[key]]);
      target[key] = guard(name);
    };

    replace(console, "log", "console.log");
    replace(console, "warn", "console.warn");
    replace(console, "error", "console.error");
    replace(process, "exit", "process.exit");
    replace(process.stdout, "write", "stdout.write");
    replace(process.stderr, "write", "stderr.write");
    if (filesystem) {
      for (const method of ["readFileSync", "writeFileSync", "openSync", "readdirSync"]) {
        replace(fs, method, `fs.${method}`);
      }
      for (const method of ["readFile", "writeFile", "open", "readdir"]) {
        replace(fs.promises, method, `fs.promises.${method}`);
      }
    }

    try {
      await callback();
      assert.deepEqual(calls, [], "must not perform observable I/O or execution side effects");
    } finally {
      for (const [target, key, original] of replacements.reverse()) target[key] = original;
    }
  };

  before(async () => {
    await watchSideEffects(async () => {
      const imported = await import(pathToFileURL(resolve("scripts/skin-palette/review-cli.mjs")).href);
      parseReviewArgs = imported.parseReviewArgs;
      runReviewCommand = imported.runReviewCommand;
      const evidence = await import(pathToFileURL(resolve("scripts/skin-palette/review-evidence.mjs")).href);
      const contracts = await import(pathToFileURL(resolve("scripts/skin-palette/contracts.mjs")).href);
      repoRoot = evidence.REPO_ROOT;
      hashCandidateSet = contracts.hashCandidateSet;
      sha256Canonical = contracts.sha256Canonical;
      productionSkinId = contracts.SKIN_IDS[0];
      assert.equal(typeof parseReviewArgs, "function");
      assert.equal(typeof runReviewCommand, "function");
      assert.equal(typeof hashCandidateSet, "function");
      assert.equal(typeof sha256Canonical, "function");
    });
    await watchSideEffects(
      () => {
        assert.deepEqual(parseReviewArgs(["verify", "--run", "run-a"]), {
          command: "verify",
          runDir: "run-a",
          candidateId: null,
          outDir: null,
          capturesIndexPath: null,
          requireSelections: false,
          production: false,
        });
      },
      { filesystem: true },
    );
  });

  it("returns the fixed shape for each command and preserves path strings", () => {
    assert.deepEqual(parseReviewArgs(["serve", "--run", "C:\\runs\\palette run", "--candidate", "candidate / one"]), {
      command: "serve",
      runDir: "C:\\runs\\palette run",
      candidateId: "candidate / one",
      outDir: null,
      capturesIndexPath: null,
      requireSelections: false,
      production: false,
    });
    assert.deepEqual(parseReviewArgs(["capture", "--run", "run dir", "--candidate", "c-1", "--out", "output dir"]), {
      command: "capture",
      runDir: "run dir",
      candidateId: "c-1",
      outDir: "output dir",
      capturesIndexPath: null,
      requireSelections: false,
      production: false,
    });
    assert.deepEqual(parseReviewArgs(["report", "--run", "run dir", "--captures-index", "captures index.json"]), {
      command: "report",
      runDir: "run dir",
      candidateId: null,
      outDir: null,
      capturesIndexPath: "captures index.json",
      requireSelections: false,
      production: false,
    });
  });

  it("parses independent valueless verify and capture switches", () => {
    assert.equal(parseReviewArgs(["verify", "--run", "run-a"]).requireSelections, false);
    assert.equal(parseReviewArgs(["verify", "--run", "run-a", "--require-selections"]).requireSelections, true);
    assert.deepEqual(
      [
        parseReviewArgs(["verify", "--run", "run-a", "--production", "--require-selections"]),
        parseReviewArgs(["verify", "--run", "run-a", "--require-selections", "--production"]),
      ].map(({ requireSelections, production }) => ({ requireSelections, production })),
      [
        { requireSelections: true, production: true },
        { requireSelections: true, production: true },
      ],
    );
    assert.deepEqual(
      parseReviewArgs(["capture", "--run", "run-a", "--candidate", "c-1", "--out", "out", "--production"]),
      {
        command: "capture",
        runDir: "run-a",
        candidateId: "c-1",
        outDir: "out",
        capturesIndexPath: null,
        requireSelections: false,
        production: true,
      },
    );
  });

  it("rejects unsupported grammar with parameter-specific TypeErrors", () => {
    const invalidCases = [
      { argv: [], message: /Unknown command.*missing/ },
      { argv: ["unknown"], message: /Unknown command/ },
      { argv: ["serve"], message: /Missing required option.*--run/ },
      { argv: ["serve", "--run", "run-a"], message: /Missing required option.*--candidate/ },
      { argv: ["serve", "--run", "--candidate", "c-1"], message: /Missing value.*--run/ },
      { argv: ["serve", "--run", " ", "--candidate", "c-1"], message: /must not be blank/ },
      { argv: ["serve", "--run=run-a", "--candidate", "c-1"], message: /--name=value/ },
      { argv: ["serve", "--run", "run-a", "--candidate", "c-1", "extra"], message: /positional argument/ },
      { argv: ["serve", "--run", "run-a", "--candidate", "c-1", "--out", "output"], message: /not valid for serve/ },
      { argv: ["report", "--run", "run-a", "--candidate", "c-1"], message: /not valid for report/ },
      { argv: ["serve", "--run", "run-a", "--candidate", "c-1", "--production"], message: /not valid for serve/ },
      {
        argv: ["report", "--run", "run-a", "--captures-index", "index", "--production"],
        message: /not valid for report/,
      },
      {
        argv: ["capture", "--run", "run-a", "--candidate", "c-1", "--production"],
        message: /Missing required option.*--out/,
      },
      { argv: ["verify", "--run", "run-a", "--require-selections", "true"], message: /does not take a value/ },
      { argv: ["verify", "--run", "run-a", "--require-selections", "false"], message: /does not take a value/ },
      { argv: ["verify", "--run", "run-a", "--production", "true"], message: /does not take a value/ },
      { argv: ["verify", "--run", "run-a", "--production", "false"], message: /does not take a value/ },
      { argv: ["verify", "--run", "run-a", "--production=true"], message: /--name=value/ },
      {
        argv: ["capture", "--run", "run-a", "--candidate", "c-1", "--out", "out", "--production=true"],
        message: /--name=value/,
      },
      {
        argv: ["capture", "--run", "run-a", "--candidate", "c-1", "--out", "out", "--production", "true"],
        message: /does not take a value/,
      },
      {
        argv: ["capture", "--run", "run-a", "--candidate", "c-1", "--out", "out", "--production", "--production"],
        message: /Duplicate option.*--production/,
      },
      {
        argv: ["verify", "--run", "run-a", "--require-selections", "--require-selections"],
        message: /Duplicate option/,
      },
      { argv: ["verify", "--run", "run-a", "--run", "run-b"], message: /Duplicate option/ },
      { argv: ["verify", "--run", "run-a", "--help"], message: /Unknown option.*--help/ },
      { argv: ["verify", "--run", "run-a", "--toString"], message: /Unknown option.*--toString/ },
      { argv: ["verify", "--run", "run-a", "--constructor"], message: /Unknown option.*--constructor/ },
      { argv: ["verify", "--run", "run-a", "--__proto__"], message: /Unknown option.*--__proto__/ },
      { argv: ["verify", "--run", "run-a", "--require-selections", "extra"], message: /positional argument/ },
    ];

    for (const { argv, message } of invalidCases) {
      assert.throws(() => parseReviewArgs(argv), { name: "TypeError", message });
    }
    assert.throws(() => parseReviewArgs(["verify", 3]), { name: "TypeError", message: /array of strings/ });
    assert.throws(() => parseReviewArgs(["toString"]), { name: "TypeError", message: /Unknown command/ });
  });

  describe("runReviewCommand", () => {
    const makeStream = () => {
      const writes = [];
      return { writes, write: (value) => writes.push(value) };
    };

    const makeHarness = ({ result, loadError, verifyError } = {}) => {
      const calls = { loadEvidence: [], verifyEvidence: [] };
      const evidence = { marker: "loaded evidence" };
      const stdout = makeStream();
      const stderr = makeStream();
      const dependencies = {
        loadEvidence: async (input) => {
          calls.loadEvidence.push(input);
          if (loadError) throw loadError;
          return evidence;
        },
        verifyEvidence: async (input) => {
          calls.verifyEvidence.push(input);
          if (verifyError) throw verifyError;
          return result ?? { status: "pass", errors: [], gaps: [] };
        },
        stdout,
        stderr,
      };
      return { calls, dependencies, evidence, stdout, stderr };
    };

    const makeProductionHarness = ({
      result = {
        status: "pass",
        exitCode: 0,
        errors: [],
        gaps: [],
        sourceResult: { marker: "do not print source result" },
        productionResult: { marker: "do not print production result" },
      },
      loadError,
      productionError,
    } = {}) => {
      const calls = { loadEvidence: [], verifyEvidence: [], verifyProductionEvidence: [] };
      const evidence = { marker: "loaded candidate evidence" };
      const stdout = makeStream();
      const stderr = makeStream();
      const dependencies = {
        loadEvidence: async (input) => {
          calls.loadEvidence.push(input);
          if (loadError) throw loadError;
          return evidence;
        },
        verifyEvidence: async (input) => {
          calls.verifyEvidence.push(input);
          throw new Error("ordinary verifier must not run for production");
        },
        verifyProductionEvidence: async (input) => {
          calls.verifyProductionEvidence.push(input);
          if (productionError) throw productionError;
          return result;
        },
        stdout,
        stderr,
      };
      return { calls, dependencies, evidence, stdout, stderr };
    };

    const makeProductionCaptureHarness = ({
      evidence: suppliedEvidence,
      sourceResult: suppliedSourceResult,
      capture: suppliedCapture,
      classification: suppliedClassification,
      originResult: suppliedOriginResult,
      currentResult: suppliedCurrentResult,
      bindingResult: suppliedBindingResult,
      shardResult: suppliedShardResult,
      failures = {},
    } = {}) => {
      const runArg = "docs/validation/production capture run";
      const outArg = "docs/validation/production capture run/output/candidate-a";
      const runDir = resolve(repoRoot, runArg);
      const outDir = resolve(repoRoot, outArg);
      const candidateId = "candidate-a";
      const verifiedModel = { marker: "original historical verified model" };
      const historicalContext = { historicalEvidence: { historicalResult: { verifiedModel } } };
      const currentSources = { marker: "source snapshot" };
      const currentAssets = { marker: "asset snapshot" };
      const evidence = suppliedEvidence ?? { selections: { record: { marker: "complete original selections" } } };
      const sourceResult = suppliedSourceResult ?? {
        status: "pass",
        errors: [],
        gaps: [],
        historicalContext,
        currentContext: { currentSources, currentAssets },
      };
      const captureResult = { skinId: productionSkinId, outDir, marker: "private capture result" };
      const capture = suppliedCapture ?? {
        candidateId,
        selectionBinding: { candidateId, skinId: productionSkinId },
        captureResult,
      };
      const classification = suppliedClassification ?? { status: "captured", exitCode: 0, errors: [], gaps: [] };
      const originResult = suppliedOriginResult ?? { status: "pass", errors: [], gaps: [] };
      const currentResult = suppliedCurrentResult ?? { status: "pass", errors: [], gaps: [] };
      const bindingResult = suppliedBindingResult ?? {
        bindingPath: join(outDir, "production-selection.json"),
        binding: { marker: "private selection binding" },
      };
      const shardResult = suppliedShardResult ?? {
        shardPath: join(outDir, "production-index-shard.json"),
        index: { schemaVersion: 1, captures: { [productionSkinId]: "output/candidate-a" } },
      };
      const calls = [];
      const stdout = makeStream();
      const stderr = makeStream();
      const invoke = (name, input, result) => {
        calls.push({ name, input });
        if (Object.hasOwn(failures, name)) throw failures[name];
        return result;
      };
      const productionCaptureAdapter = {
        verifyProductionSourceContext: async (input) => invoke("source", input, sourceResult),
        runProductionCapture: async (input) => invoke("capture", input, capture),
        classifyProductionCapture: async (input) => invoke("classify", input, classification),
        verifyProductionOriginStability: async (input) => invoke("origin", input, originResult),
        verifyProductionCurrentStability: async (input) => invoke("current", input, currentResult),
        writeProductionCaptureBinding: async (input) => invoke("binding", input, bindingResult),
        writeProductionCaptureIndexShard: async (input) => invoke("shard", input, shardResult),
      };
      const dependencies = {
        loadEvidence: async (input) => invoke("loadEvidence", input, evidence),
        productionCaptureAdapter,
        stdout,
        stderr,
      };
      const argv = ["capture", "--run", runArg, "--candidate", candidateId, "--out", outArg, "--production"];
      return {
        argv,
        bindingResult,
        calls,
        capture,
        captureResult,
        candidateId,
        classification,
        currentAssets,
        currentResult,
        currentSources,
        dependencies,
        evidence,
        historicalContext,
        originResult,
        outDir,
        runDir,
        shardResult,
        sourceResult,
        stderr,
        stdout,
        verifiedModel,
      };
    };

    it("runs production capture through the fixed gates and writes one bounded summary", async () => {
      const harness = makeProductionCaptureHarness();
      assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 0);
      assert.deepEqual(harness.calls, [
        {
          name: "loadEvidence",
          input: {
            runDir: harness.runDir,
            capturesIndexPath: join(harness.runDir, "captures-index.json"),
          },
        },
        { name: "source", input: { manifestRunDir: harness.runDir, evidence: harness.evidence } },
        {
          name: "capture",
          input: {
            runDir: harness.runDir,
            verifiedModel: harness.verifiedModel,
            selections: harness.evidence.selections.record,
            candidateId: harness.candidateId,
            outDir: harness.outDir,
          },
        },
        { name: "classify", input: { skinId: productionSkinId, captureResult: harness.captureResult } },
        {
          name: "origin",
          input: {
            manifestRunDir: harness.runDir,
            evidence: harness.evidence,
            historicalContext: harness.historicalContext,
          },
        },
        {
          name: "current",
          input: { currentSources: harness.currentSources, currentAssets: harness.currentAssets },
        },
        {
          name: "binding",
          input: {
            runDir: harness.runDir,
            verifiedModel: harness.verifiedModel,
            selections: harness.evidence.selections.record,
            candidateId: harness.candidateId,
            captureResult: harness.captureResult,
          },
        },
        {
          name: "shard",
          input: {
            runDir: harness.runDir,
            outDir: harness.outDir,
            verifiedModel: harness.verifiedModel,
            selections: harness.evidence.selections.record,
            candidateId: harness.candidateId,
          },
        },
      ]);
      assert.deepEqual(JSON.parse(harness.stdout.writes.join("")), {
        command: "capture",
        production: true,
        candidateId: harness.candidateId,
        skinId: productionSkinId,
        outDir: harness.outDir,
        status: "captured",
        errors: [],
        gaps: [],
        bindingPath: join(harness.outDir, "production-selection.json"),
        shardPath: join(harness.outDir, "production-index-shard.json"),
      });
      assert.equal(harness.stdout.writes.length, 1);
      assert.doesNotMatch(
        harness.stdout.writes[0],
        /private capture result|verified model|source snapshot|selection record/,
      );
      assert.deepEqual(harness.stderr.writes, []);
    });

    it("stops before capture and registration when the source gate is incomplete or rejected", async () => {
      for (const sourceResult of [
        { status: "incomplete", errors: [], gaps: [{ code: "source-gap" }] },
        { status: "rejected", errors: [{ code: "source-drift" }], gaps: [] },
      ]) {
        const harness = makeProductionCaptureHarness({ sourceResult });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 2);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source"],
        );
        assert.deepEqual(JSON.parse(harness.stdout.writes.join("")), {
          command: "capture",
          production: true,
          candidateId: harness.candidateId,
          skinId: null,
          outDir: harness.outDir,
          status: sourceResult.status,
          errors: sourceResult.errors,
          gaps: sourceResult.gaps,
        });
        assert.deepEqual(harness.stderr.writes, []);
      }
    });

    it("rejects a malformed source gate or a pass without its original model and current snapshots", async () => {
      for (const sourceResult of [
        { status: "pass", errors: [{ code: "contradiction" }], gaps: [] },
        { status: "pass", errors: [], gaps: null },
        { status: "future", errors: [], gaps: [] },
        {
          status: "pass",
          errors: [],
          gaps: [],
          historicalContext: { historicalEvidence: { historicalResult: {} } },
          currentContext: { currentSources: {}, currentAssets: {} },
        },
        {
          status: "pass",
          errors: [],
          gaps: [],
          historicalContext: { historicalEvidence: { historicalResult: { verifiedModel: {} } } },
          currentContext: { currentSources: null, currentAssets: {} },
        },
      ]) {
        const harness = makeProductionCaptureHarness({ sourceResult });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source"],
        );
        assert.deepEqual(harness.stdout.writes, []);
        assert.match(harness.stderr.writes.join(""), /production source verification failed/);
      }

      const missingSelections = makeProductionCaptureHarness({ evidence: {} });
      assert.equal(await runReviewCommand(missingSelections.argv, missingSelections.dependencies), 1);
      assert.deepEqual(
        missingSelections.calls.map(({ name }) => name),
        ["loadEvidence", "source"],
      );
      assert.match(missingSelections.stderr.writes.join(""), /selections\.record/);
    });

    it("preserves and registers structured failed and incomplete production captures", async () => {
      for (const classification of [
        { status: "failed", exitCode: 2, errors: [{ code: "role-failed" }], gaps: [] },
        { status: "incomplete", exitCode: 2, errors: [], gaps: [{ code: "role-missing" }] },
      ]) {
        const harness = makeProductionCaptureHarness({ classification });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 2);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source", "capture", "classify", "origin", "current", "binding", "shard"],
        );
        const summary = JSON.parse(harness.stdout.writes.join(""));
        assert.equal(summary.status, classification.status);
        assert.deepEqual(summary.errors, classification.errors);
        assert.deepEqual(summary.gaps, classification.gaps);
        assert.equal(summary.bindingPath, join(harness.outDir, "production-selection.json"));
        assert.equal(summary.shardPath, join(harness.outDir, "production-index-shard.json"));
      }
    });

    it("runs current stability after origin drift and blocks both sidecar writers", async () => {
      const classification = {
        status: "failed",
        exitCode: 2,
        errors: [{ code: "capture-error" }],
        gaps: [{ code: "capture-gap" }],
      };
      const originResult = { status: "rejected", errors: [{ code: "origin-drift" }], gaps: [{ code: "origin-gap" }] };
      const currentResult = { status: "incomplete", errors: [], gaps: [{ code: "current-gap" }] };
      const harness = makeProductionCaptureHarness({ classification, originResult, currentResult });
      assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 2);
      assert.deepEqual(
        harness.calls.map(({ name }) => name),
        ["loadEvidence", "source", "capture", "classify", "origin", "current"],
      );
      assert.deepEqual(JSON.parse(harness.stdout.writes.join("")), {
        command: "capture",
        production: true,
        candidateId: harness.candidateId,
        skinId: productionSkinId,
        outDir: harness.outDir,
        status: "rejected",
        errors: [...classification.errors, ...originResult.errors],
        gaps: [...classification.gaps, ...originResult.gaps, ...currentResult.gaps],
      });
    });

    it("makes aggregate end-block status rejected when capture errors accompany an origin gap", async () => {
      const classification = { status: "failed", exitCode: 2, errors: [{ code: "capture-error" }], gaps: [] };
      const originResult = { status: "incomplete", errors: [], gaps: [{ code: "origin-gap" }] };
      const currentResult = { status: "pass", errors: [], gaps: [] };
      const harness = makeProductionCaptureHarness({ classification, originResult, currentResult });
      assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 2);
      assert.deepEqual(
        harness.calls.map(({ name }) => name),
        ["loadEvidence", "source", "capture", "classify", "origin", "current"],
      );
      assert.deepEqual(JSON.parse(harness.stdout.writes.join("")), {
        command: "capture",
        production: true,
        candidateId: harness.candidateId,
        skinId: productionSkinId,
        outDir: harness.outDir,
        status: "rejected",
        errors: classification.errors,
        gaps: originResult.gaps,
      });
    });

    it("awaits capture, both end checks, binding, and shard in sequence", async () => {
      const harness = makeProductionCaptureHarness();
      const gates = Object.fromEntries(
        ["capture", "origin", "current", "binding", "shard"].map((name) => {
          let release;
          const promise = new Promise((resolve) => {
            release = resolve;
          });
          return [name, { promise, release }];
        }),
      );
      const adapter = harness.dependencies.productionCaptureAdapter;
      const pending = (name, result) => (input) => {
        harness.calls.push({ name, input });
        return gates[name].promise.then(() => result);
      };
      adapter.runProductionCapture = pending("capture", harness.capture);
      adapter.verifyProductionOriginStability = pending("origin", harness.originResult);
      adapter.verifyProductionCurrentStability = pending("current", harness.currentResult);
      adapter.writeProductionCaptureBinding = pending("binding", harness.bindingResult);
      adapter.writeProductionCaptureIndexShard = pending("shard", harness.shardResult);

      const command = runReviewCommand(harness.argv, harness.dependencies);
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      await tick();
      assert.deepEqual(
        harness.calls.map(({ name }) => name),
        ["loadEvidence", "source", "capture"],
      );
      gates.capture.release();
      await tick();
      assert.deepEqual(
        harness.calls.map(({ name }) => name),
        ["loadEvidence", "source", "capture", "classify", "origin"],
      );
      gates.origin.release();
      await tick();
      assert.deepEqual(
        harness.calls.map(({ name }) => name),
        ["loadEvidence", "source", "capture", "classify", "origin", "current"],
      );
      gates.current.release();
      await tick();
      assert.equal(harness.calls.at(-1).name, "binding");
      gates.binding.release();
      await tick();
      assert.equal(harness.calls.at(-1).name, "shard");
      assert.deepEqual(harness.stdout.writes, []);
      gates.shard.release();
      assert.equal(await command, 0);
      assert.equal(harness.calls.at(-1).name, "shard");
    });

    it("stops at each exception boundary, keeps the output directory visible, and skips later writes", async () => {
      const expectedCalls = {
        loadEvidence: ["loadEvidence"],
        source: ["loadEvidence", "source"],
        capture: ["loadEvidence", "source", "capture"],
        classify: ["loadEvidence", "source", "capture", "classify"],
        origin: ["loadEvidence", "source", "capture", "classify", "origin"],
        current: ["loadEvidence", "source", "capture", "classify", "origin", "current"],
        binding: ["loadEvidence", "source", "capture", "classify", "origin", "current", "binding"],
        shard: ["loadEvidence", "source", "capture", "classify", "origin", "current", "binding", "shard"],
      };
      for (const name of Object.keys(expectedCalls)) {
        const error = new Error(`${name} boundary failed`);
        const harness = makeProductionCaptureHarness({ failures: { [name]: error } });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1, name);
        assert.deepEqual(
          harness.calls.map(({ name: called }) => called),
          expectedCalls[name],
          name,
        );
        assert.deepEqual(harness.stdout.writes, [], name);
        assert.match(harness.stderr.writes.join(""), new RegExp(`${name} boundary failed`), name);
        assert.ok(harness.stderr.writes.join("").includes(harness.outDir), name);
      }
    });

    it("reports both the capture and cleanup failures from AggregateError", async () => {
      const harness = makeProductionCaptureHarness({
        failures: {
          capture: new AggregateError(
            [new Error("matrix main failure"), new Error("fixture cleanup failure")],
            "capture and cleanup failed",
          ),
        },
      });
      assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1);
      assert.match(harness.stderr.writes.join(""), /matrix main failure/);
      assert.match(harness.stderr.writes.join(""), /fixture cleanup failure/);
      assert.ok(harness.stderr.writes.join("").includes(harness.outDir));
      assert.deepEqual(harness.stdout.writes, []);
      assert.deepEqual(
        harness.calls.map(({ name }) => name),
        ["loadEvidence", "source", "capture"],
      );
    });

    it("rejects invalid production capture identity, classification, end-check, and writer results", async () => {
      const invalidCapture = [
        (harness) => {
          harness.capture.candidateId = "other-candidate";
        },
        (harness) => {
          harness.capture.selectionBinding.candidateId = "other-candidate";
        },
        (harness) => {
          harness.capture.selectionBinding.skinId = "unknown-skin";
        },
        (harness) => {
          harness.capture.captureResult.skinId = "other-skin";
        },
        (harness) => {
          harness.capture.captureResult.outDir = join(harness.outDir, "other");
        },
      ];
      for (const invalidate of invalidCapture) {
        const harness = makeProductionCaptureHarness();
        invalidate(harness);
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source", "capture"],
        );
        assert.deepEqual(harness.stdout.writes, []);
      }

      const invalidClassifications = [
        { status: "future", exitCode: 0, errors: [], gaps: [] },
        { status: "captured", exitCode: 2, errors: [], gaps: [] },
        { status: "captured", exitCode: 0, errors: null, gaps: [] },
        { status: "captured", exitCode: 0, errors: [], gaps: null },
        { status: "captured", exitCode: 0, errors: [], gaps: [{}] },
        { status: "failed", exitCode: 2, errors: [], gaps: [] },
        { status: "incomplete", exitCode: 2, errors: [], gaps: [] },
      ];
      for (const classification of invalidClassifications) {
        const harness = makeProductionCaptureHarness({ classification });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source", "capture", "classify"],
        );
        assert.deepEqual(harness.stdout.writes, []);
      }

      for (const [originResult, currentResult] of [
        [
          { status: "pass", errors: [{ code: "contradiction" }], gaps: [] },
          { status: "pass", errors: [], gaps: [] },
        ],
        [
          { status: "pass", errors: [], gaps: [] },
          { status: "future", errors: [], gaps: [] },
        ],
      ]) {
        const harness = makeProductionCaptureHarness({ originResult, currentResult });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source", "capture", "classify", "origin", "current"],
        );
        assert.deepEqual(harness.stdout.writes, []);
      }

      for (const bindingResult of [
        {},
        { bindingPath: "wrong/path", binding: {} },
        { bindingPath: "x", binding: null },
      ]) {
        const harness = makeProductionCaptureHarness({ bindingResult });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source", "capture", "classify", "origin", "current", "binding"],
        );
        assert.deepEqual(harness.stdout.writes, []);
      }

      for (const shardResult of [
        {},
        { shardPath: "wrong/path", index: { schemaVersion: 1, captures: { [productionSkinId]: "capture-a" } } },
        { shardPath: "x", index: { schemaVersion: 2, captures: { [productionSkinId]: "capture-a" } } },
        {
          shardPath: "x",
          index: { schemaVersion: 1, captures: { [productionSkinId]: "capture-a", other: "capture-b" } },
        },
      ]) {
        const harness = makeProductionCaptureHarness({ shardResult });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source", "capture", "classify", "origin", "current", "binding", "shard"],
        );
        assert.deepEqual(harness.stdout.writes, []);
      }
    });

    it("rejects a single-skin shard path that does not identify this output directory", async () => {
      const outDir = resolve(repoRoot, "docs/validation/production capture run/output/candidate-a");
      for (const relativePath of ["output/another-candidate", "output\\candidate-a", "."]) {
        const harness = makeProductionCaptureHarness({
          shardResult: {
            shardPath: join(outDir, "production-index-shard.json"),
            index: { schemaVersion: 1, captures: { [productionSkinId]: relativePath } },
          },
        });
        assert.equal(await runReviewCommand(harness.argv, harness.dependencies), 1, relativePath);
        assert.deepEqual(
          harness.calls.map(({ name }) => name),
          ["loadEvidence", "source", "capture", "classify", "origin", "current", "binding", "shard"],
          relativePath,
        );
        assert.deepEqual(harness.stdout.writes, [], relativePath);
        assert.match(harness.stderr.writes.join(""), /malformed single-skin shard/, relativePath);
      }
    });

    it("loads candidate evidence and passes only the fixed formal index to E1", async () => {
      const cases = [
        { runArg: "docs/validation/relative production run", flags: ["--production"] },
        {
          runArg: resolve(repoRoot, "docs/validation", "absolute production run"),
          flags: ["--require-selections", "--production"],
        },
        {
          runArg: "docs/validation/production run with reversed flags",
          flags: ["--production", "--require-selections"],
        },
      ];

      for (const { runArg, flags } of cases) {
        const harness = makeProductionHarness();
        assert.equal(await runReviewCommand(["verify", "--run", runArg, ...flags], harness.dependencies), 0);
        const runDir = resolve(repoRoot, runArg);
        assert.deepEqual(harness.calls.loadEvidence, [
          { runDir, capturesIndexPath: join(runDir, "captures-index.json") },
        ]);
        assert.deepEqual(harness.calls.verifyProductionEvidence, [
          {
            manifestRunDir: runDir,
            evidence: harness.evidence,
            capturesIndexPath: join(runDir, "production-captures-index.json"),
          },
        ]);
        assert.deepEqual(harness.calls.verifyEvidence, []);
        assert.equal(harness.stdout.writes.join(""), `${JSON.stringify({ status: "pass", errors: [], gaps: [] })}\n`);
        assert.deepEqual(harness.stderr.writes, []);
      }
    });

    it("maps production pass, incomplete, and rejected to bounded output and fixed exit codes", async () => {
      for (const result of [
        { status: "pass", exitCode: 0, errors: [], gaps: [] },
        { status: "incomplete", exitCode: 2, errors: [], gaps: [{ code: "missing-source" }] },
        { status: "rejected", exitCode: 2, errors: [{ code: "source-drift" }], gaps: [] },
      ]) {
        const harness = makeProductionHarness({ result });
        const expectedExitCode = result.status === "pass" ? 0 : 2;
        assert.equal(
          await runReviewCommand(["verify", "--run", "run-a", "--production"], harness.dependencies),
          expectedExitCode,
        );
        assert.equal(
          harness.stdout.writes.join(""),
          `${JSON.stringify({ status: result.status, errors: result.errors, gaps: result.gaps })}\n`,
        );
        assert.doesNotMatch(harness.stdout.writes.join(""), /sourceResult|productionResult|candidate evidence/);
        assert.deepEqual(harness.stderr.writes, []);
      }
    });

    it("returns 1 without success output when candidate loading or E1 throws", async () => {
      const loadHarness = makeProductionHarness({ loadError: new Error("candidate loader exploded") });
      assert.equal(await runReviewCommand(["verify", "--run", "run-a", "--production"], loadHarness.dependencies), 1);
      assert.deepEqual(loadHarness.calls.verifyProductionEvidence, []);
      assert.deepEqual(loadHarness.calls.verifyEvidence, []);
      assert.deepEqual(loadHarness.stdout.writes, []);
      assert.match(loadHarness.stderr.writes.join(""), /candidate loader exploded/);

      const productionHarness = makeProductionHarness({ productionError: new Error("E1 exploded") });
      assert.equal(
        await runReviewCommand(["verify", "--run", "run-a", "--production"], productionHarness.dependencies),
        1,
      );
      assert.equal(productionHarness.calls.loadEvidence.length, 1);
      assert.equal(productionHarness.calls.verifyProductionEvidence.length, 1);
      assert.deepEqual(productionHarness.calls.verifyEvidence, []);
      assert.deepEqual(productionHarness.stdout.writes, []);
      assert.match(productionHarness.stderr.writes.join(""), /E1 exploded/);
    });

    it("rejects malformed production E1 results and pass diagnostics", async () => {
      const malformedResults = [
        null,
        [],
        {},
        { status: "invalid", exitCode: 1, errors: [], gaps: [] },
        { status: "future", exitCode: 0, errors: [], gaps: [] },
        { status: "pass", errors: [], gaps: [] },
        { status: "pass", exitCode: 1, errors: [], gaps: [] },
        { status: "incomplete", exitCode: 0, errors: [], gaps: [] },
        { status: "rejected", exitCode: 0, errors: [{ code: "reject" }], gaps: [] },
        { status: "pass", exitCode: 0, errors: null, gaps: [] },
        { status: "pass", exitCode: 0, errors: [], gaps: null },
        { status: "pass", exitCode: 0, gaps: [] },
        { status: "pass", exitCode: 0, errors: [] },
        { status: "pass", exitCode: 0, errors: [{ code: "diagnostic" }], gaps: [] },
        { status: "pass", exitCode: 0, errors: [], gaps: [{ code: "diagnostic" }] },
      ];

      for (const result of malformedResults) {
        const harness = makeProductionHarness({ result });
        assert.equal(
          await runReviewCommand(["verify", "--run", "run-a", "--production"], harness.dependencies),
          1,
          JSON.stringify(result),
        );
        assert.deepEqual(harness.stdout.writes, [], JSON.stringify(result));
        assert.match(harness.stderr.writes.join(""), /production verify/);
      }
    });

    it("maps all verifier statuses and writes only the fixed diagnostic summary", async () => {
      for (const [status, exitCode] of [
        ["pass", 0],
        ["incomplete", 2],
        ["rejected", 2],
        ["invalid", 1],
      ]) {
        const errors = status === "pass" ? [] : [{ code: `${status}-diagnostic` }];
        const gaps = status === "incomplete" ? [{ code: "missing-input" }] : [];
        const harness = makeHarness({
          result: {
            status,
            errors,
            gaps,
            verifiedModel: { images: { assets: [{ dataUrl: "data:image/png;base64,not-for-output" }] } },
          },
        });

        assert.equal(await runReviewCommand(["verify", "--run", "run-a"], harness.dependencies), exitCode);
        assert.deepEqual(JSON.parse(harness.stdout.writes.join("")), { status, errors, gaps });
        assert.deepEqual(Object.keys(JSON.parse(harness.stdout.writes[0])), ["status", "errors", "gaps"]);
        assert.doesNotMatch(harness.stdout.writes.join(""), /verifiedModel|data:image/);
        assert.deepEqual(harness.stderr.writes, []);
      }
    });

    it("uses the repository root and fixed captures-index path for relative and absolute runs", async () => {
      const relativeRun = "docs/validation/relative run";
      const absoluteRun = resolve(repoRoot, "docs/validation", "absolute run");
      const harness = makeHarness();

      for (const [runArg, requireSelections] of [
        [relativeRun, false],
        [absoluteRun, true],
      ]) {
        const argv = ["verify", "--run", runArg];
        if (requireSelections) argv.push("--require-selections");
        assert.equal(await runReviewCommand(argv, harness.dependencies), 0);
      }

      for (const [index, runArg] of [relativeRun, absoluteRun].entries()) {
        const runDir = resolve(repoRoot, runArg);
        assert.deepEqual(harness.calls.loadEvidence[index], {
          runDir,
          capturesIndexPath: join(runDir, "captures-index.json"),
        });
        assert.strictEqual(harness.calls.verifyEvidence[index].evidence, harness.evidence);
        assert.equal(harness.calls.verifyEvidence[index].requireSelections, index === 1);
        assert.equal(harness.calls.verifyEvidence[index].production, false);
      }
    });

    it("reports parse failures without calling either injected dependency", async () => {
      const harness = makeHarness();

      assert.equal(await runReviewCommand(["verify", "--run"], harness.dependencies), 1);
      assert.deepEqual(harness.calls, { loadEvidence: [], verifyEvidence: [] });
      assert.deepEqual(harness.stdout.writes, []);
      assert.match(harness.stderr.writes.join(""), /Missing value.*--run/);
    });

    it("returns 1 with diagnostics when loading or verification throws", async () => {
      const loadHarness = makeHarness({ loadError: new Error("loader exploded") });
      assert.equal(await runReviewCommand(["verify", "--run", "run-a"], loadHarness.dependencies), 1);
      assert.deepEqual(loadHarness.calls.verifyEvidence, []);
      assert.match(loadHarness.stderr.writes.join(""), /loader exploded/);

      const verifyHarness = makeHarness({ verifyError: new Error("verifier exploded") });
      assert.equal(await runReviewCommand(["verify", "--run", "run-a"], verifyHarness.dependencies), 1);
      assert.equal(verifyHarness.calls.loadEvidence.length, 1);
      assert.equal(verifyHarness.calls.verifyEvidence.length, 1);
      assert.match(verifyHarness.stderr.writes.join(""), /verifier exploded/);
    });

    it("rejects unknown verifier statuses instead of treating them as success", async () => {
      const harness = makeHarness({ result: { status: "future-status", errors: [], gaps: [] } });

      assert.equal(await runReviewCommand(["verify", "--run", "run-a"], harness.dependencies), 1);
      assert.deepEqual(harness.stdout.writes, []);
      assert.match(harness.stderr.writes.join(""), /unknown status.*future-status/);
    });

    it("captures, classifies, then registers before writing one bounded diagnostic line", async () => {
      for (const [status, exitCode, errors, gaps] of [
        ["captured", 0, [], []],
        ["failed", 2, [{ code: "required-role-fail", detail: "kept role reason" }], []],
        ["incomplete", 2, [], [{ code: "required-role-missing", detail: "kept missing reason" }]],
      ]) {
        const calls = [];
        const stdout = makeStream();
        const stderr = makeStream();
        const runDir = resolve(repoRoot, "run with spaces");
        const outDir = resolve(repoRoot, "output with spaces");
        const captureResult = { marker: "capture result must not be printed" };
        const candidateHash = "a".repeat(64);
        const captureAdapter = {
          async runReviewCapture(input) {
            calls.push(["capture", input]);
            return { candidateId: "candidate-a", candidateHash, captureResult };
          },
          async classifyReviewCapture(input) {
            calls.push(["classify", input]);
            return { status, exitCode, errors, gaps };
          },
          async writeReviewCaptureIndexShard(input) {
            calls.push(["index", input]);
            return { shardPath: `${outDir}/capture-index-shard.json`, index: {} };
          },
        };
        const code = await runReviewCommand(
          ["capture", "--run", "run with spaces", "--candidate", "candidate-a", "--out", "output with spaces"],
          { captureAdapter, stdout, stderr },
        );

        assert.equal(code, exitCode);
        assert.deepEqual(calls, [
          ["capture", { runDir, candidateId: "candidate-a", outDir }],
          ["classify", { candidateId: "candidate-a", candidateHash, captureResult }],
          ["index", { runDir, candidateId: "candidate-a", candidateHash, captureResult }],
        ]);
        assert.deepEqual(JSON.parse(stdout.writes.join("")), {
          command: "capture",
          candidateId: "candidate-a",
          candidateHash,
          status,
          errors,
          gaps,
          indexShardPath: `${outDir}/capture-index-shard.json`,
        });
        assert.equal(stdout.writes.length, 1);
        assert.doesNotMatch(stdout.writes[0], /capture result must not be printed|captureResult/);
        assert.deepEqual(stderr.writes, []);
      }
    });

    it("awaits each capture step before invoking the next one", async () => {
      const calls = [];
      const stdout = makeStream();
      const stderr = makeStream();
      let resolveCapture;
      let resolveClassification;
      let resolveIndex;
      const captureGate = new Promise((resolve) => {
        resolveCapture = resolve;
      });
      const classificationGate = new Promise((resolve) => {
        resolveClassification = resolve;
      });
      const indexGate = new Promise((resolve) => {
        resolveIndex = resolve;
      });
      const captureResult = {};
      const candidateHash = "b".repeat(64);
      const captureAdapter = {
        runReviewCapture() {
          calls.push("capture");
          return captureGate;
        },
        classifyReviewCapture() {
          calls.push("classify");
          return classificationGate;
        },
        writeReviewCaptureIndexShard() {
          calls.push("index");
          return indexGate;
        },
      };
      const command = runReviewCommand(["capture", "--run", "run-a", "--candidate", "candidate-a", "--out", "out-a"], {
        captureAdapter,
        stdout,
        stderr,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["capture"]);
      assert.deepEqual(stdout.writes, []);
      resolveCapture({ candidateId: "candidate-a", candidateHash, captureResult });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["capture", "classify"]);
      assert.deepEqual(stdout.writes, []);
      resolveClassification({ status: "captured", exitCode: 0, errors: [], gaps: [] });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, ["capture", "classify", "index"]);
      assert.deepEqual(stdout.writes, []);
      resolveIndex({ shardPath: "/capture-index-shard.json" });
      assert.equal(await command, 0);
      assert.deepEqual(calls, ["capture", "classify", "index"]);
    });

    it("stops on each failed capture step and maps stream errors to 1", async () => {
      for (const failAt of ["capture", "classify", "index", "stdout"]) {
        const calls = [];
        const stdout = makeStream();
        if (failAt === "stdout") {
          stdout.write = () => {
            throw new Error("stdout failed");
          };
        }
        const stderr = makeStream();
        const captureResult = {};
        const candidateHash = "c".repeat(64);
        const captureAdapter = {
          async runReviewCapture() {
            calls.push("capture");
            if (failAt === "capture") throw new Error("capture step failed");
            return { candidateId: "candidate-a", candidateHash, captureResult };
          },
          async classifyReviewCapture() {
            calls.push("classify");
            if (failAt === "classify") throw new Error("classification step failed");
            return { status: "captured", exitCode: 0, errors: [], gaps: [] };
          },
          async writeReviewCaptureIndexShard() {
            calls.push("index");
            if (failAt === "index") throw new Error("index step failed");
            return { shardPath: "/capture-index-shard.json" };
          },
        };
        assert.equal(
          await runReviewCommand(["capture", "--run", "run-a", "--candidate", "candidate-a", "--out", "out-a"], {
            captureAdapter,
            stdout,
            stderr,
          }),
          1,
        );
        const expectedCalls = {
          capture: ["capture"],
          classify: ["capture", "classify"],
          index: ["capture", "classify", "index"],
          stdout: ["capture", "classify", "index"],
        }[failAt];
        const expectedError = {
          capture: "capture step failed",
          classify: "classification step failed",
          index: "index step failed",
          stdout: "stdout failed",
        }[failAt];
        assert.deepEqual(calls, expectedCalls, failAt);
        assert.deepEqual(stdout.writes, [], failAt);
        assert.match(stderr.writes.join(""), new RegExp(expectedError));
      }
    });

    it("rejects malformed capture, classification, and shard adapter results", async () => {
      const cases = [
        {
          name: "candidate mismatch",
          capture: { candidateId: "other", candidateHash: "d".repeat(64), captureResult: {} },
        },
        { name: "missing capture hash", capture: { candidateId: "candidate-a", captureResult: {} } },
        { name: "missing capture result", capture: { candidateId: "candidate-a", candidateHash: "d".repeat(64) } },
        { name: "unknown status", classification: { status: "future", exitCode: 0, errors: [], gaps: [] } },
        {
          name: "captured with diagnostics",
          classification: { status: "captured", exitCode: 0, errors: [], gaps: [{}] },
        },
        { name: "failed without error", classification: { status: "failed", exitCode: 2, errors: [], gaps: [] } },
        { name: "incomplete without gap", classification: { status: "incomplete", exitCode: 2, errors: [], gaps: [] } },
        { name: "wrong captured exit", classification: { status: "captured", exitCode: 2, errors: [], gaps: [] } },
        {
          name: "wrong noncaptured exit",
          classification: { status: "incomplete", exitCode: 0, errors: [], gaps: [{ code: "gap" }] },
        },
        { name: "errors not array", classification: { status: "captured", exitCode: 0, errors: null, gaps: [] } },
        { name: "gaps not array", classification: { status: "captured", exitCode: 0, errors: [], gaps: null } },
        { name: "missing shard path", shard: {} },
      ];
      for (const invalid of cases) {
        const stdout = makeStream();
        const stderr = makeStream();
        const calls = [];
        const captureAdapter = {
          async runReviewCapture() {
            calls.push("capture");
            return invalid.capture ?? { candidateId: "candidate-a", candidateHash: "d".repeat(64), captureResult: {} };
          },
          async classifyReviewCapture() {
            calls.push("classify");
            return invalid.classification ?? { status: "captured", exitCode: 0, errors: [], gaps: [] };
          },
          async writeReviewCaptureIndexShard() {
            calls.push("index");
            return invalid.shard ?? { shardPath: "/capture-index-shard.json" };
          },
        };
        assert.equal(
          await runReviewCommand(["capture", "--run", "run-a", "--candidate", "candidate-a", "--out", "out-a"], {
            captureAdapter,
            stdout,
            stderr,
          }),
          1,
          invalid.name,
        );
        assert.deepEqual(stdout.writes, [], invalid.name);
        assert.match(stderr.writes.join(""), /capture failed:/, invalid.name);
        if (
          invalid.name === "candidate mismatch" ||
          invalid.name === "missing capture hash" ||
          invalid.name === "missing capture result"
        ) {
          assert.deepEqual(calls, ["capture"], invalid.name);
        } else if (invalid.classification) {
          assert.deepEqual(calls, ["capture", "classify"], invalid.name);
        }
      }
    });

    describe("report command", () => {
      const makeReportHarness = ({ result, evidenceRunDir } = {}) => {
        const calls = [];
        const evidence = { run: { dir: evidenceRunDir ?? resolve(repoRoot, "docs/validation/injected-run") } };
        const stdout = makeStream();
        const stderr = makeStream();
        const verifiedModel = result?.verifiedModel ?? { marker: "verified model" };
        const selectionScript = "(() => { document.body.dataset.selection = 'ready'; })();";
        const html = `<!doctype html><script>${selectionScript}</script><p>报告内容</p>`;
        const dependencies = {
          loadEvidence: async (input) => {
            calls.push({ name: "loadEvidence", input });
            return evidence;
          },
          verifyEvidence: async (input) => {
            calls.push({ name: "verifyEvidence", input });
            return result ?? { status: "pass", errors: [], gaps: [], verifiedModel };
          },
          buildSelection: async (model) => {
            calls.push({ name: "buildSelection", model });
            return selectionScript;
          },
          renderReport: async (input) => {
            calls.push({ name: "renderReport", input });
            return html;
          },
          writeReport: async (input) => {
            calls.push({ name: "writeReport", input });
            return join(evidence.run.dir, "report.html");
          },
          stdout,
          stderr,
        };
        return { calls, dependencies, evidence, html, selectionScript, stderr, stdout, verifiedModel };
      };

      const reportArgv = (
        runDir = "docs/validation/run with spaces",
        capturesIndex = "docs/validation/index with spaces.json",
      ) => ["report", "--run", runDir, "--captures-index", capturesIndex];

      it("uses the explicit repo-root index, passes one verified model through the real script slot, and warns on diagnostics", async () => {
        const cases = [
          { status: "pass", errors: [], gaps: [], warns: false },
          { status: "pass", errors: [], gaps: [{ code: "nonblocking-gap" }], warns: true },
          { status: "incomplete", errors: [], gaps: [{ code: "missing-capture" }], warns: true },
          { status: "rejected", errors: [{ code: "role-failed" }], gaps: [], warns: true },
        ];

        for (const { status, errors, gaps, warns } of cases) {
          const verifiedModel = { marker: `model-${status}`, gaps };
          const harness = makeReportHarness({
            result: { status, errors, gaps, verifiedModel },
            evidenceRunDir: resolve(repoRoot, "docs/validation/verified-run"),
          });
          const argv = reportArgv();

          assert.equal(await runReviewCommand(argv, harness.dependencies), 0);
          assert.deepEqual(
            harness.calls.map((call) => call.name),
            ["loadEvidence", "verifyEvidence", "buildSelection", "renderReport", "writeReport"],
          );
          assert.deepEqual(harness.calls[0].input, {
            runDir: resolve(repoRoot, argv[2]),
            capturesIndexPath: resolve(repoRoot, argv[4]),
          });
          assert.strictEqual(harness.calls[1].input.evidence, harness.evidence);
          assert.equal(harness.calls[1].input.requireSelections, false);
          assert.equal(harness.calls[1].input.production, false);
          assert.strictEqual(harness.calls[2].model, verifiedModel);
          assert.strictEqual(harness.calls[3].input.verifiedModel, verifiedModel);
          assert.equal(harness.calls[3].input.selectionScript, harness.selectionScript);
          assert.equal(harness.calls[4].input.runDir, harness.evidence.run.dir);
          assert.equal(harness.calls[4].input.html, harness.html);
          assert.deepEqual(JSON.parse(harness.stdout.writes[0]), {
            status,
            reportPath: join(harness.evidence.run.dir, "report.html"),
          });
          assert.equal(harness.stderr.writes.length > 0, warns);
          if (warns) assert.match(harness.stderr.writes.join(""), new RegExp(`status=${status}`));
        }
      });

      it("resolves both relative and absolute run/index arguments from REPO_ROOT", async () => {
        const cases = [
          ["docs/validation/relative run", "docs/validation/relative index/captures-index.json"],
          [resolve(repoRoot, "docs/validation/absolute run"), resolve(repoRoot, "index/captures-index.json")],
        ];

        for (const [runArg, indexArg] of cases) {
          const harness = makeReportHarness();
          await runReviewCommand(reportArgv(runArg, indexArg), harness.dependencies);
          assert.deepEqual(harness.calls[0].input, {
            runDir: resolve(repoRoot, runArg),
            capturesIndexPath: resolve(repoRoot, indexArg),
          });
        }
      });

      it("does not render or write invalid, unknown, malformed, or model-less results", async () => {
        const cases = [
          { status: "invalid", errors: [{ code: "invalid" }], gaps: [], verifiedModel: { marker: "unused" } },
          { status: "future", errors: [], gaps: [], verifiedModel: { marker: "unused" } },
          { status: "pass", errors: [], gaps: [], verifiedModel: null },
          { status: "pass", errors: null, gaps: [], verifiedModel: { marker: "unused" } },
        ];

        for (const result of cases) {
          const harness = makeReportHarness({ result });
          assert.equal(await runReviewCommand(reportArgv(), harness.dependencies), 1);
          assert.deepEqual(
            harness.calls.map((call) => call.name),
            ["loadEvidence", "verifyEvidence"],
          );
          assert.deepEqual(harness.stdout.writes, []);
          assert.notEqual(harness.stderr.writes.length, 0);
        }
      });

      it("returns 1 without writing success output when rendering or writing throws", async () => {
        for (const [dependency, message] of [
          ["renderReport", "renderer exploded"],
          ["writeReport", "writer exploded"],
        ]) {
          const harness = makeReportHarness();
          harness.dependencies[dependency] = async () => {
            throw new Error(message);
          };

          assert.equal(await runReviewCommand(reportArgv(), harness.dependencies), 1);
          assert.deepEqual(harness.stdout.writes, []);
          assert.match(harness.stderr.writes.join(""), new RegExp(message));
        }
      });

      it("returns 1 with a diagnostic when report loading or verification throws", async () => {
        for (const [dependency, message] of [
          ["loadEvidence", "report loader exploded"],
          ["verifyEvidence", "report verifier exploded"],
        ]) {
          const harness = makeReportHarness();
          harness.dependencies[dependency] = async () => {
            throw new Error(message);
          };

          assert.equal(await runReviewCommand(reportArgv(), harness.dependencies), 1);
          assert.deepEqual(harness.stdout.writes, []);
          assert.match(harness.stderr.writes.join(""), new RegExp(message));
        }
      });

      const makeMinimalVerifiedModel = () => {
        const candidateSet = { schemaVersion: 1, kind: "skin-palette-candidate-set", candidates: [] };
        candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
        const container = { schemaVersion: 1, candidateSetHash: candidateSet.candidateSetHash, assessments: [] };
        container.assessmentHash = sha256Canonical({
          schemaVersion: container.schemaVersion,
          candidateSetHash: container.candidateSetHash,
          assessments: container.assessments,
        });
        return {
          schemaVersion: 1,
          kind: "skin-palette-review-verified-model",
          candidateSet,
          container,
          images: { baseline: [], units: [], assets: [] },
          selectableCandidateIds: [],
          gaps: [],
        };
      };

      const makeDiskDependencies = ({ runDir, html, stdout, stderr, calls }) => ({
        loadEvidence: async (input) => {
          calls.push({ name: "loadEvidence", input });
          return { run: { dir: runDir } };
        },
        verifyEvidence: async (input) => {
          calls.push({ name: "verifyEvidence", input });
          return { status: "pass", errors: [], gaps: [], verifiedModel: makeMinimalVerifiedModel() };
        },
        renderReport: ({ verifiedModel, selectionScript }) => {
          calls.push({ name: "renderReport", verifiedModel, selectionScript });
          return html;
        },
        stdout,
        stderr,
      });

      it("uses the default selection builder and renderer with one verified model", async () => {
        const runDir = resolve(repoRoot, "docs/validation/injected-default-renderer-run");
        const stdout = makeStream();
        const stderr = makeStream();
        const calls = [];
        const verifiedModel = makeMinimalVerifiedModel();
        const dependencies = {
          loadEvidence: async (input) => {
            calls.push({ name: "loadEvidence", input });
            return { run: { dir: runDir } };
          },
          verifyEvidence: async (input) => {
            calls.push({ name: "verifyEvidence", input });
            return { status: "pass", errors: [], gaps: [], verifiedModel };
          },
          writeReport: async ({ runDir: targetRunDir, html }) => {
            calls.push({ name: "writeReport", targetRunDir, html });
            return join(targetRunDir, "report.html");
          },
          stdout,
          stderr,
        };

        assert.equal(
          await runReviewCommand(reportArgv(runDir, resolve(repoRoot, "unused-index.json")), dependencies),
          0,
        );
        const { targetRunDir, html } = calls.at(-1);
        assert.equal(targetRunDir, runDir);
        assert.match(html, /createSelectionExportCore/);
        assert.doesNotMatch(html, /交互尚未接线/);
        assert.deepEqual(JSON.parse(stdout.writes[0]), { status: "pass", reportPath: join(runDir, "report.html") });
        assert.deepEqual(stderr.writes, []);
      });

      it("writes complete UTF-8 HTML once under the verified run directory", async () => {
        const validationRoot = resolve(repoRoot, "docs/validation");
        const runDir = await fs.promises.mkdtemp(join(validationRoot, "m4-4-5-b2-write-"));
        const stdout = makeStream();
        const stderr = makeStream();
        const calls = [];
        const html = '<!doctype html><meta charset="utf-8"><p>报告生成成功 ✅</p>';
        const dependencies = makeDiskDependencies({ runDir, html, stdout, stderr, calls });

        try {
          assert.equal(
            await runReviewCommand(reportArgv(runDir, resolve(repoRoot, "unused-index.json")), dependencies),
            0,
            stderr.writes.join(""),
          );
          const reportPath = join(runDir, "report.html");
          assert.deepEqual(await fs.promises.readFile(reportPath), Buffer.from(html, "utf8"));
          assert.deepEqual(JSON.parse(stdout.writes[0]), { status: "pass", reportPath });
          assert.deepEqual(stderr.writes, []);
          assert.equal(calls.at(-1).name, "renderReport");
          assert.match(calls.at(-1).selectionScript, /createSelectionExportCore/);
          assert.equal(calls.at(-1).verifiedModel.kind, "skin-palette-review-verified-model");
        } finally {
          await fs.promises.rm(runDir, { recursive: true, force: true });
        }
      });

      it("does not overwrite an existing report and rejects the validation root, escapes, and missing directories", async () => {
        const validationRoot = resolve(repoRoot, "docs/validation");
        const runDir = await fs.promises.mkdtemp(join(validationRoot, "m4-4-5-b2-existing-"));
        const reportPath = join(runDir, "report.html");
        const sentinel = Buffer.from("keep existing report");
        await fs.promises.writeFile(reportPath, sentinel);

        try {
          const stdout = makeStream();
          const stderr = makeStream();
          const dependencies = makeDiskDependencies({ runDir, html: "<p>new</p>", stdout, stderr, calls: [] });
          assert.equal(
            await runReviewCommand(reportArgv(runDir, resolve(repoRoot, "unused-index.json")), dependencies),
            1,
          );
          assert.deepEqual(await fs.promises.readFile(reportPath), sentinel);
          assert.deepEqual(stdout.writes, []);

          const rootReport = join(repoRoot, "report.html");
          const rootReportExisted = await fs.promises
            .lstat(rootReport)
            .then(() => true)
            .catch(() => false);
          for (const rejectedRunDir of [repoRoot, validationRoot]) {
            const rejectedStdout = makeStream();
            const rejectedStderr = makeStream();
            const rejectedDependencies = makeDiskDependencies({
              runDir: rejectedRunDir,
              html: "<p>must not write</p>",
              stdout: rejectedStdout,
              stderr: rejectedStderr,
              calls: [],
            });
            assert.equal(
              await runReviewCommand(
                reportArgv(rejectedRunDir, resolve(repoRoot, "unused-index.json")),
                rejectedDependencies,
              ),
              1,
            );
            assert.deepEqual(rejectedStdout.writes, []);
            assert.equal(rejectedStderr.writes.length > 0, true);
          }
          assert.equal(
            await fs.promises
              .lstat(rootReport)
              .then(() => true)
              .catch(() => false),
            rootReportExisted,
          );

          const missingRunDir = join(validationRoot, `m4-4-5-b2-missing-${randomUUID()}`);
          assert.equal(fs.existsSync(missingRunDir), false);
          const missingStdout = makeStream();
          const missingStderr = makeStream();
          const missingDependencies = makeDiskDependencies({
            runDir: missingRunDir,
            html: "<p>must not write</p>",
            stdout: missingStdout,
            stderr: missingStderr,
            calls: [],
          });
          assert.equal(
            await runReviewCommand(
              reportArgv(missingRunDir, resolve(repoRoot, "unused-index.json")),
              missingDependencies,
            ),
            1,
          );
          assert.equal(fs.existsSync(missingRunDir), false);
          assert.deepEqual(missingStdout.writes, []);
        } finally {
          await fs.promises.rm(runDir, { recursive: true, force: true });
        }
      });

      it("refuses a report symlink without changing its target when symlinks are available", async (t) => {
        const validationRoot = resolve(repoRoot, "docs/validation");
        const runDir = await fs.promises.mkdtemp(join(validationRoot, "m4-4-5-b2-symlink-"));
        const targetPath = join(runDir, "sentinel.txt");
        const reportPath = join(runDir, "report.html");
        const sentinel = Buffer.from("symlink target stays intact");

        try {
          await fs.promises.writeFile(targetPath, sentinel);
          try {
            await fs.promises.symlink(targetPath, reportPath, "file");
          } catch (error) {
            if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"].includes(error.code)) {
              t.diagnostic(
                `symbolic link creation unavailable (${error.code}); existing-file no-overwrite test still ran`,
              );
              return;
            }
            throw error;
          }

          const stdout = makeStream();
          const stderr = makeStream();
          const dependencies = makeDiskDependencies({
            runDir,
            html: "<p>must not write</p>",
            stdout,
            stderr,
            calls: [],
          });
          assert.equal(
            await runReviewCommand(reportArgv(runDir, resolve(repoRoot, "unused-index.json")), dependencies),
            1,
          );
          assert.deepEqual(await fs.promises.readFile(targetPath), sentinel);
          assert.equal(await fs.promises.readlink(reportPath), targetPath);
          assert.deepEqual(stdout.writes, []);
        } finally {
          await fs.promises.rm(runDir, { recursive: true, force: true });
        }
      });
    });

    describe("serve command", () => {
      const serveArgv = ["serve", "--run", "run-a", "--candidate", "candidate-a"];
      const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        return { promise, reject, resolve };
      };

      it("passes exact inputs, remains pending after publishing the URL, closes in order, and maps both signals", async () => {
        for (const [signal, exitCode] of [
          ["SIGINT", 130],
          ["SIGTERM", 143],
        ]) {
          const calls = [];
          const candidate = { marker: "candidate identity" };
          const fixture = { marker: "fixture identity", close: async () => calls.push("fixture.close") };
          const preview = {
            url: "http://127.0.0.1:43210/",
            close: async () => calls.push("preview.close"),
          };
          const signalSource = new EventEmitter();
          const stdout = makeStream();
          const stderr = makeStream();
          const urlWritten = deferred();
          stdout.write = (value) => {
            stdout.writes.push(value);
            urlWritten.resolve(value);
          };
          let settled = false;
          const command = runReviewCommand(serveArgv, {
            loadCandidate: async (input) => {
              assert.equal(signalSource.listenerCount("SIGINT"), 1);
              assert.equal(signalSource.listenerCount("SIGTERM"), 1);
              calls.push(["loadCandidate", input]);
              return candidate;
            },
            fixtureFactory: async () => {
              calls.push("fixtureFactory");
              return fixture;
            },
            startPreview: async (input) => {
              calls.push(["startPreview", input]);
              return preview;
            },
            signalSource,
            stdout,
            stderr,
          });
          command.then(() => {
            settled = true;
          });

          try {
            const line = await urlWritten.promise;
            assert.equal(settled, false, "serve stays alive until a signal arrives");
            assert.deepEqual(JSON.parse(line), { command: "serve", candidateId: "candidate-a", url: preview.url });
            assert.deepEqual(calls.slice(0, 3), [
              ["loadCandidate", { runDir: resolve(repoRoot, "run-a"), candidateId: "candidate-a" }],
              "fixtureFactory",
              ["startPreview", { candidate, fixture, port: 0, maxConcurrent: 1 }],
            ]);

            signalSource.emit(signal);
            assert.equal(await command, exitCode);
            assert.deepEqual(calls.slice(3), ["preview.close", "fixture.close"]);
            assert.deepEqual(stderr.writes, []);
            assert.equal(signalSource.listenerCount("SIGINT"), 0);
            assert.equal(signalSource.listenerCount("SIGTERM"), 0);
          } finally {
            if (signalSource.listenerCount("SIGINT") || signalSource.listenerCount("SIGTERM")) {
              signalSource.emit("SIGINT");
            }
            await command.catch(() => undefined);
          }
        }
      });

      it("uses the first repeated or mixed signal and performs cleanup only once", async () => {
        const closeCalls = [];
        const signalSource = new EventEmitter();
        const urlWritten = deferred();
        const stdout = makeStream();
        stdout.write = (value) => {
          stdout.writes.push(value);
          urlWritten.resolve(value);
        };
        const command = runReviewCommand(serveArgv, {
          loadCandidate: async () => ({}),
          fixtureFactory: async () => ({ close: async () => closeCalls.push("fixture") }),
          startPreview: async () => ({ url: "http://127.0.0.1:43211/", close: async () => closeCalls.push("preview") }),
          signalSource,
          stdout,
          stderr: makeStream(),
        });

        try {
          await urlWritten.promise;
          signalSource.emit("SIGTERM");
          signalSource.emit("SIGINT");
          signalSource.emit("SIGTERM");
          assert.equal(await command, 143);
          assert.deepEqual(closeCalls, ["preview", "fixture"]);
          assert.equal(signalSource.listenerCount("SIGINT"), 0);
          assert.equal(signalSource.listenerCount("SIGTERM"), 0);
        } finally {
          if (signalSource.listenerCount("SIGINT") || signalSource.listenerCount("SIGTERM")) {
            signalSource.emit("SIGINT");
          }
          await command.catch(() => undefined);
        }
      });

      it("remembers signals received during candidate, fixture, and preview startup awaits", async () => {
        for (const [stage, signal, exitCode] of [
          ["loadCandidate", "SIGINT", 130],
          ["fixtureFactory", "SIGTERM", 143],
          ["startPreview", "SIGINT", 130],
        ]) {
          const calls = [];
          const candidate = { marker: "candidate" };
          const fixture = { close: async () => calls.push("fixture.close") };
          const preview = { url: "http://127.0.0.1:43212/", close: async () => calls.push("preview.close") };
          const signalSource = new EventEmitter();
          const entered = deferred();
          const pendingStage = deferred();
          const stdout = makeStream();
          const command = runReviewCommand(serveArgv, {
            loadCandidate: async () => {
              calls.push("loadCandidate");
              if (stage === "loadCandidate") {
                entered.resolve();
                return pendingStage.promise;
              }
              return candidate;
            },
            fixtureFactory: async () => {
              calls.push("fixtureFactory");
              if (stage === "fixtureFactory") {
                entered.resolve();
                return pendingStage.promise;
              }
              return fixture;
            },
            startPreview: async () => {
              calls.push("startPreview");
              if (stage === "startPreview") {
                entered.resolve();
                return pendingStage.promise;
              }
              return preview;
            },
            signalSource,
            stdout,
            stderr: makeStream(),
          });

          try {
            await entered.promise;
            signalSource.emit(signal);
            pendingStage.resolve(
              stage === "loadCandidate" ? candidate : stage === "fixtureFactory" ? fixture : preview,
            );
            assert.equal(await command, exitCode);
            assert.deepEqual(stdout.writes, [], "startup signal must suppress the URL announcement");
            assert.equal(calls.includes("fixture.close"), stage !== "loadCandidate");
            assert.equal(calls.includes("preview.close"), stage === "startPreview");
            assert.equal(signalSource.listenerCount("SIGINT"), 0);
            assert.equal(signalSource.listenerCount("SIGTERM"), 0);
          } finally {
            pendingStage.resolve(candidate);
            if (signalSource.listenerCount("SIGINT") || signalSource.listenerCount("SIGTERM")) {
              signalSource.emit(signal);
            }
            await command.catch(() => undefined);
          }
        }
      });

      it("handles a signal emitted while listeners are being registered before starting candidate loading", async () => {
        const signalSource = new EventEmitter();
        const addListener = signalSource.on.bind(signalSource);
        signalSource.on = (signal, listener) => {
          const result = addListener(signal, listener);
          if (signal === "SIGINT") signalSource.emit("SIGINT");
          return result;
        };
        let loadCalls = 0;
        const stderr = makeStream();

        assert.equal(
          await runReviewCommand(serveArgv, {
            loadCandidate: async () => {
              loadCalls += 1;
              return {};
            },
            fixtureFactory: async () => ({ close: async () => undefined }),
            startPreview: async () => ({ url: "http://127.0.0.1:43216/", close: async () => undefined }),
            signalSource,
            stdout: makeStream(),
            stderr,
          }),
          130,
        );
        assert.equal(loadCalls, 0);
        assert.deepEqual(stderr.writes, []);
        assert.equal(signalSource.listenerCount("SIGINT"), 0);
        assert.equal(signalSource.listenerCount("SIGTERM"), 0);
      });

      it("returns 1 and cleans only resources already acquired when startup or stdout fails", async () => {
        for (const stage of ["loadCandidate", "fixtureFactory", "startPreview", "stdout"]) {
          const calls = [];
          const signalSource = new EventEmitter();
          const stderr = makeStream();
          const fixture = { close: async () => calls.push("fixture.close") };
          const preview = { url: "http://127.0.0.1:43213/", close: async () => calls.push("preview.close") };
          const stdout = makeStream();
          if (stage === "stdout")
            stdout.write = () => {
              throw new Error("stdout broken");
            };
          const dependencies = {
            loadCandidate: async () => {
              calls.push("loadCandidate");
              if (stage === "loadCandidate") throw new Error("candidate load failed");
              return {};
            },
            fixtureFactory: async () => {
              calls.push("fixtureFactory");
              if (stage === "fixtureFactory") throw new Error("fixture create failed");
              return fixture;
            },
            startPreview: async () => {
              calls.push("startPreview");
              if (stage === "startPreview") throw new Error("preview start failed");
              return preview;
            },
            signalSource,
            stdout,
            stderr,
          };

          assert.equal(await runReviewCommand(serveArgv, dependencies), 1);
          assert.equal(calls.includes("preview.close"), stage === "stdout");
          assert.equal(calls.includes("fixture.close"), ["startPreview", "stdout"].includes(stage));
          assert.match(stderr.writes.join(""), /serve failed/);
          assert.equal(signalSource.listenerCount("SIGINT"), 0);
          assert.equal(signalSource.listenerCount("SIGTERM"), 0);
        }
      });

      it("retains a fixture when preview close fails and reports cleanup failures", async () => {
        const previewFailureCalls = [];
        const previewFailureStderr = makeStream();
        const previewFailureSource = new EventEmitter();
        const previewFailureOutput = deferred();
        const previewFailureStdout = makeStream();
        previewFailureStdout.write = (line) => {
          previewFailureStdout.writes.push(line);
          previewFailureOutput.resolve();
        };
        const previewFailure = runReviewCommand(serveArgv, {
          loadCandidate: async () => ({}),
          fixtureFactory: async () => ({ close: async () => previewFailureCalls.push("fixture.close") }),
          startPreview: async () => ({
            url: "http://127.0.0.1:43214/",
            close: async () => {
              previewFailureCalls.push("preview.close");
              throw new Error("preview close failed");
            },
          }),
          signalSource: previewFailureSource,
          stdout: previewFailureStdout,
          stderr: previewFailureStderr,
        });
        await previewFailureOutput.promise;
        previewFailureSource.emit("SIGINT");
        assert.equal(await previewFailure, 1);
        assert.deepEqual(previewFailureCalls, ["preview.close"]);
        assert.match(previewFailureStderr.writes.join(""), /fixture was retained.*caller must clean it up/);
        assert.equal(previewFailureSource.listenerCount("SIGINT"), 0);
        assert.equal(previewFailureSource.listenerCount("SIGTERM"), 0);

        const fixtureFailureCalls = [];
        const fixtureFailureStderr = makeStream();
        const fixtureFailureSource = new EventEmitter();
        const fixtureFailureOutput = deferred();
        const fixtureFailureStdout = makeStream();
        fixtureFailureStdout.write = (line) => {
          fixtureFailureStdout.writes.push(line);
          fixtureFailureOutput.resolve();
        };
        const fixtureFailure = runReviewCommand(serveArgv, {
          loadCandidate: async () => ({}),
          fixtureFactory: async () => ({
            close: async () => {
              fixtureFailureCalls.push("fixture.close");
              throw new Error("fixture close failed");
            },
          }),
          startPreview: async () => ({
            url: "http://127.0.0.1:43215/",
            close: async () => fixtureFailureCalls.push("preview.close"),
          }),
          signalSource: fixtureFailureSource,
          stdout: fixtureFailureStdout,
          stderr: fixtureFailureStderr,
        });
        await fixtureFailureOutput.promise;
        fixtureFailureSource.emit("SIGTERM");
        assert.equal(await fixtureFailure, 1);
        assert.deepEqual(fixtureFailureCalls, ["preview.close", "fixture.close"]);
        assert.match(fixtureFailureStderr.writes.join(""), /fixture close failed/);
        assert.equal(fixtureFailureSource.listenerCount("SIGINT"), 0);
        assert.equal(fixtureFailureSource.listenerCount("SIGTERM"), 0);
      });

      it("serves real fixture data over its own HTTP URL and closes the port and fixture on signal", async () => {
        const contracts = await import(pathToFileURL(resolve("scripts/skin-palette/contracts.mjs")).href);
        const skins = await import(pathToFileURL(resolve("public/skins.js")).href);
        const profileSnapshot = { fixture: "serve-http-test" };
        const tokens = Object.fromEntries(skins.PALETTE_TOKEN_KEYS.map((key) => [key, "#334455"]));
        const candidate = {
          schemaVersion: 1,
          skinId: contracts.SKIN_IDS[0],
          variant: "a",
          profileVersion: 1,
          profileSnapshot,
          profileHash: contracts.sha256Canonical(profileSnapshot),
          policyHash: "a".repeat(64),
          derivationHash: "b".repeat(64),
          seed: "palette-redesign-v1",
          style: { title: "HTTP fixture test", rationale: "Valid preview test candidate", identitySource: "test" },
          parameters: { light: {}, dark: {}, search: {} },
          modes: { light: tokens, dark: tokens },
        };
        candidate.candidateHash = contracts.hashCandidate(candidate);
        candidate.id = `${candidate.skinId}-a-${candidate.candidateHash.slice(0, 12)}`;
        assert.equal(contracts.validateCandidate(candidate).valid, true);

        const fixtures = [];
        const signalSource = new EventEmitter();
        const stdout = makeStream();
        const stderr = makeStream();
        const urlWritten = deferred();
        stdout.write = (line) => {
          stdout.writes.push(line);
          urlWritten.resolve(JSON.parse(line));
        };
        const command = runReviewCommand(serveArgv.slice(0, 4).concat(candidate.id), {
          loadCandidate: async () => candidate,
          fixtureFactory: async () => {
            const fixture = await createPaletteFixture();
            fixtures.push(fixture);
            return fixture;
          },
          signalSource,
          stdout,
          stderr,
        });
        const commandFinished = command.then(
          (result) => ({ result }),
          (error) => ({ error }),
        );

        try {
          const startup = await Promise.race([urlWritten.promise.then((output) => ({ output })), commandFinished]);
          assert.ok(startup.output, startup.error?.message ?? `serve exited before URL with ${startup.result}`);
          const output = startup.output;
          assert.equal(output.command, "serve");
          assert.equal(output.candidateId, candidate.id);
          const response = await fetch(new URL("/api/usage?preset=all&view=dashboard", output.url));
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.metadata.eventCount, FIXTURE_EVENT_COUNT);
          assert.equal(body.summary.totals.total, FIXTURE_TOTAL_TOKENS);

          signalSource.emit("SIGTERM");
          assert.equal(await command, 143);
          const port = Number(new URL(output.url).port);
          await assert.rejects(fetch(`http://127.0.0.1:${port}/`), (error) => {
            const causes = [error.cause, ...(error.cause?.errors ?? [])];
            return causes.some((cause) => cause?.code === "ECONNREFUSED");
          });
          assert.equal(fixtures.length, 1);
          assert.equal(fs.existsSync(dirname(fixtures[0].homeDir)), false);
          assert.deepEqual(stderr.writes, []);
        } finally {
          if (signalSource.listenerCount("SIGINT") || signalSource.listenerCount("SIGTERM")) {
            signalSource.emit("SIGINT");
          }
          await command.catch(() => undefined);
          for (const fixture of fixtures) {
            if (fs.existsSync(dirname(fixture.homeDir))) await fixture.close();
          }
        }
      });
    });
  });
});

describe("loadPreviewCandidate", () => {
  let loadPreviewCandidate;
  let hashCandidate;
  let hashCandidateSet;
  let hashRoleInputs;
  let sha256Canonical;
  let validateCandidateSet;
  let skinIds;
  let paletteTokenKeys;

  before(async () => {
    const cli = await import(pathToFileURL(resolve("scripts/skin-palette/review-cli.mjs")).href);
    const contracts = await import(pathToFileURL(resolve("scripts/skin-palette/contracts.mjs")).href);
    const skins = await import(pathToFileURL(resolve("public/skins.js")).href);
    loadPreviewCandidate = cli.loadPreviewCandidate;
    ({
      hashCandidate,
      hashCandidateSet,
      hashRoleInputs,
      sha256Canonical,
      validateCandidateSet,
      SKIN_IDS: skinIds,
    } = contracts);
    paletteTokenKeys = skins.PALETTE_TOKEN_KEYS;
  });

  const makeCandidateSet = () => {
    const candidates = skinIds.slice(0, 2).map((skinId, index) => {
      const profileSnapshot = { fixtureSkin: skinId };
      const tokens = Object.fromEntries(paletteTokenKeys.map((key) => [key, index ? "#223344" : "#112233"]));
      const candidate = {
        schemaVersion: 1,
        skinId,
        variant: "a",
        profileVersion: 1,
        profileSnapshot,
        profileHash: sha256Canonical(profileSnapshot),
        policyHash: "a".repeat(64),
        derivationHash: "b".repeat(64),
        seed: "palette-redesign-v1",
        style: { title: `Fixture ${index}`, rationale: "Contract-valid test candidate", identitySource: "test" },
        parameters: { light: {}, dark: {}, search: {} },
        modes: { light: tokens, dark: tokens },
      };
      candidate.candidateHash = hashCandidate(candidate);
      candidate.id = `${skinId}-a-${candidate.candidateHash.slice(0, 12)}`;
      return candidate;
    });
    const candidateSet = {
      schemaVersion: 1,
      inputHashes: {
        profiles: "1".repeat(64),
        policy: "2".repeat(64),
        roles: hashRoleInputs(),
        derivation: "3".repeat(64),
      },
      candidates,
      rejected: [],
    };
    candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
    return candidateSet;
  };

  const withFixture = async (callback) => {
    const rootDir = await fs.promises.mkdtemp(join(tmpdir(), "m4-4-5-b3a-"));
    const runDir = join(rootDir, "docs", "validation", "run-a");
    const candidatePath = join(runDir, "candidates.json");
    const candidateSet = makeCandidateSet();
    try {
      await fs.promises.mkdir(runDir, { recursive: true });
      await fs.promises.writeFile(candidatePath, JSON.stringify(candidateSet), "utf8");
      await callback({ rootDir, runDir, candidatePath, candidateSet, runArg: join("docs", "validation", "run-a") });
    } finally {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
  };

  it("loads the exact requested candidate from a valid set without index or assessment files", async () => {
    await withFixture(async ({ rootDir, runDir, candidateSet, runArg }) => {
      assert.equal(candidateSet.candidates.length, 2);
      assert.equal(validateCandidateSet(candidateSet, { expectedSkinIds: [] }).valid, true);
      assert.equal(fs.existsSync(join(runDir, "captures-index.json")), false);
      assert.equal(fs.existsSync(join(runDir, "assessments.json")), false);

      const selected = await loadPreviewCandidate({
        rootDir,
        runDir: runArg,
        candidateId: candidateSet.candidates[1].id,
      });
      assert.deepEqual(selected, candidateSet.candidates[1]);
      assert.equal(selected.id, candidateSet.candidates[1].id);
    });
  });

  it("rejects malformed inputs, URLs, validation-root runs, and lexical escapes", async () => {
    await withFixture(async ({ rootDir, runArg }) => {
      for (const input of [
        { runDir: "", candidateId: "candidate-a", rootDir },
        { runDir: 3, candidateId: "candidate-a", rootDir },
        { runDir: runArg, candidateId: " ", rootDir },
        { runDir: runArg, candidateId: null, rootDir },
        { runDir: runArg, candidateId: "candidate-a", rootDir: " " },
        { runDir: runArg, candidateId: "candidate-a", rootDir: null },
        { runDir: "https://example.test/run", candidateId: "candidate-a", rootDir },
        { runDir: join("docs", "validation"), candidateId: "candidate-a", rootDir },
        { runDir: join("docs", "validation", "..", "..", "outside"), candidateId: "candidate-a", rootDir },
      ]) {
        await assert.rejects(loadPreviewCandidate(input), TypeError);
      }
    });
  });

  it("rejects unknown IDs, bad JSON, missing runs, missing candidates, and missing roots", async () => {
    await withFixture(async ({ rootDir, runDir, candidatePath, runArg }) => {
      await assert.rejects(
        loadPreviewCandidate({ rootDir, runDir: runArg, candidateId: "unregistered / odd id" }),
        /unknown candidate ID/,
      );

      await fs.promises.writeFile(candidatePath, "{bad json", "utf8");
      await assert.rejects(
        loadPreviewCandidate({ rootDir, runDir: runArg, candidateId: "candidate-a" }),
        /candidates\.json is invalid JSON/,
      );

      await fs.promises.unlink(candidatePath);
      await assert.rejects(
        loadPreviewCandidate({ rootDir, runDir: runArg, candidateId: "candidate-a" }),
        (error) => error.code === "ENOENT",
      );
      await fs.promises.rm(runDir, { recursive: true });
      await assert.rejects(
        loadPreviewCandidate({ rootDir, runDir: runArg, candidateId: "candidate-a" }),
        (error) => error.code === "ENOENT",
      );
      await assert.rejects(
        loadPreviewCandidate({
          rootDir: join(rootDir, "missing-root"),
          runDir: runArg,
          candidateId: "candidate-a",
        }),
        (error) => error.code === "ENOENT",
      );
    });
  });

  it("rejects candidate-hash drift and candidate-set-hash drift through the contract validator", async () => {
    await withFixture(async ({ rootDir, candidatePath, runArg, candidateSet }) => {
      const driftedCandidateSet = structuredClone(candidateSet);
      driftedCandidateSet.candidates[1].style.title += " changed";
      await fs.promises.writeFile(candidatePath, JSON.stringify(driftedCandidateSet), "utf8");
      await assert.rejects(
        loadPreviewCandidate({ rootDir, runDir: runArg, candidateId: candidateSet.candidates[1].id }),
        /candidateHash.*摘要不一致/,
      );

      const driftedSetHash = structuredClone(candidateSet);
      driftedSetHash.inputHashes.policy = "4".repeat(64);
      await fs.promises.writeFile(candidatePath, JSON.stringify(driftedSetHash), "utf8");
      await assert.rejects(
        loadPreviewCandidate({ rootDir, runDir: runArg, candidateId: candidateSet.candidates[1].id }),
        /candidateSetHash.*摘要不一致/,
      );
    });
  });

  it("refuses a candidates.json symlink when link creation is available", async (t) => {
    await withFixture(async ({ rootDir, runDir, candidatePath, runArg, candidateSet }) => {
      const targetPath = join(runDir, "candidate-set-target.json");
      await fs.promises.rename(candidatePath, targetPath);
      try {
        await fs.promises.symlink(targetPath, candidatePath, "file");
      } catch (error) {
        if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"].includes(error.code)) {
          t.diagnostic(`candidate symlink test unavailable (${error.code}); direct file validation tests still ran`);
          return;
        }
        throw error;
      }

      await assert.rejects(
        loadPreviewCandidate({ rootDir, runDir: runArg, candidateId: candidateSet.candidates[0].id }),
        /must not be a symlink or junction/,
      );
      assert.deepEqual(JSON.parse(await fs.promises.readFile(targetPath, "utf8")), candidateSet);
    });
  });

  it("rejects a run junction that resolves outside docs/validation when junctions are available", async (t) => {
    await withFixture(async ({ rootDir, candidateSet }) => {
      const outsideRun = join(rootDir, "outside-run");
      const junctionRun = join(rootDir, "docs", "validation", "linked-run");
      await fs.promises.mkdir(outsideRun, { recursive: true });
      await fs.promises.writeFile(join(outsideRun, "candidates.json"), JSON.stringify(candidateSet), "utf8");
      try {
        await fs.promises.symlink(outsideRun, junctionRun, "junction");
      } catch (error) {
        if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"].includes(error.code)) {
          t.diagnostic(`run junction test unavailable (${error.code}); real-path containment remains unverified`);
          return;
        }
        throw error;
      }

      await assert.rejects(
        loadPreviewCandidate({
          rootDir,
          runDir: join("docs", "validation", "linked-run"),
          candidateId: candidateSet.candidates[0].id,
        }),
        /resolves outside rootDir\/docs\/validation/,
      );
    });
  });
});

describe("review CLI direct execution", () => {
  const cliPath = resolve("scripts/skin-palette/review-cli.mjs");
  const repoRoot = resolve(".");

  const runNode = (args, cwd, timeoutMs = 15_000) =>
    new Promise((resolveResult, rejectResult) => {
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

  it("returns real exit 1 with diagnostics for missing command and invalid or inherited options", async () => {
    const rootDir = await fs.promises.mkdtemp(join(tmpdir(), "review cli c1-"));
    const cwd = join(rootDir, "working directory with spaces");
    await fs.promises.mkdir(cwd);
    try {
      for (const [argv, diagnostic] of [
        [[], /Unknown command/],
        [["verify", "--run", "run dir", "--unknown"], /Unknown option.*--unknown/],
        [["verify", "--run", "run dir", "--constructor"], /Unknown option.*--constructor/],
      ]) {
        const result = await runNode([cliPath, ...argv], cwd);
        assert.equal(result.timedOut, false);
        assert.equal(result.code, 1);
        assert.equal(result.signal, null);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, diagnostic);
        assert.doesNotMatch(result.stdout, /"status"/);
      }
    } finally {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("executes default capture from a spaced foreign cwd and exits 1 for a missing validation run", async () => {
    const rootDir = await fs.promises.mkdtemp(join(tmpdir(), "review cli c1-"));
    const cwd = join(rootDir, "foreign working directory with spaces");
    const runDir = join(repoRoot, "docs", "validation", `missing-capture-run-${randomUUID()}`);
    const outputDir = join(cwd, "capture output with spaces");
    await fs.promises.mkdir(cwd);
    try {
      const result = await runNode(
        [cliPath, "capture", "--run", runDir, "--candidate", "candidate-id-with-spaces", "--out", outputDir],
        cwd,
      );
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /capture failed:/);
      assert.doesNotMatch(result.stderr, /not wired yet/);
      assert.equal(fs.existsSync(outputDir), false);
      assert.equal(fs.existsSync(runDir), false);
    } finally {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("imports without output, signal listeners, or process.exitCode changes", async () => {
    const rootDir = await fs.promises.mkdtemp(join(tmpdir(), "review cli c1-"));
    const cwd = join(rootDir, "import cwd with spaces");
    await fs.promises.mkdir(cwd);
    const cliUrl = JSON.stringify(pathToFileURL(cliPath).href);
    const source = [
      'import { pathToFileURL } from "node:url";',
      `const target = ${cliUrl};`,
      'const before = { exitCode: process.exitCode, sigint: process.listenerCount("SIGINT"), sigterm: process.listenerCount("SIGTERM") };',
      "await import(target);",
      'if (process.exitCode !== before.exitCode || process.listenerCount("SIGINT") !== before.sigint || process.listenerCount("SIGTERM") !== before.sigterm) {',
      '  process.stderr.write("CLI import changed process state\\n");',
      "  process.exitCode = 1;",
      "}",
    ].join("\n");
    try {
      const result = await runNode(["--input-type=module", "-e", source], cwd);
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    } finally {
      await fs.promises.rm(rootDir, { recursive: true, force: true });
    }
  });
});

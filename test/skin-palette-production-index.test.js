import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT } from "../scripts/skin-palette/review-evidence.mjs";
import {
  hashCandidate,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
  SKIN_IDS,
} from "../scripts/skin-palette/contracts.mjs";
import { PALETTE_TOKEN_KEYS } from "../public/skins.js";
import { buildFixedMatrixFixtureBindings } from "../scripts/skin-palette/capture.mjs";
import { getPaletteFixtureHash, getTimelineWarningFixtureHash } from "../test-support/skin-palette-fixture.mjs";
import {
  readBoundProductionCaptureShards,
  assembleProductionCaptureIndex,
  mergeProductionCaptureShards,
  readProductionCaptureShards,
  writeProductionCaptureIndex,
} from "../scripts/skin-palette/production-index.mjs";
import { createSelectionExport } from "../scripts/skin-palette/review-selection.mjs";
import {
  writeProductionCaptureBinding,
  writeProductionCaptureIndexShard,
} from "../scripts/skin-palette/review-production.mjs";

function shard(skinId, captureDir = `captures/${skinId}`) {
  return { schemaVersion: 1, captures: { [skinId]: captureDir } };
}

function makeBoundFixture() {
  const policyHash = "a".repeat(64);
  const derivationHash = "b".repeat(64);
  const candidates = SKIN_IDS.flatMap((skinId) =>
    ["a", "b", "c"].map((variant) => {
      const profileSnapshot = { fixtureSkin: skinId };
      const candidate = {
        schemaVersion: 1,
        skinId,
        variant,
        profileVersion: 1,
        profileSnapshot,
        profileHash: sha256Canonical(profileSnapshot),
        policyHash,
        derivationHash,
        seed: "palette-redesign-v1",
        style: { title: "Reader test", rationale: "Synthetic preverified fixture", identitySource: "test" },
        parameters: { light: {}, dark: {}, search: {} },
        modes: {
          light: Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, "#112233"])),
          dark: Object.fromEntries(PALETTE_TOKEN_KEYS.map((key) => [key, "#445566"])),
        },
      };
      candidate.candidateHash = hashCandidate(candidate);
      candidate.id = `${skinId}-${variant}-${candidate.candidateHash.slice(0, 12)}`;
      return candidate;
    }),
  );
  const candidateSet = {
    schemaVersion: 1,
    inputHashes: {
      profiles: "c".repeat(64),
      policy: policyHash,
      roles: hashRoleInputs(),
      derivation: derivationHash,
    },
    candidates,
    rejected: [],
  };
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const assessments = candidates.map(({ id: candidateId, candidateHash }) => ({
    candidateId,
    candidateHash,
    readiness: "ready",
  }));
  const container = {
    schemaVersion: 1,
    candidateSetHash: candidateSet.candidateSetHash,
    assessments,
  };
  container.assessmentHash = sha256Canonical(container);
  const verifiedModel = {
    schemaVersion: 1,
    kind: "skin-palette-review-verified-model",
    candidateSet,
    container,
    selectableCandidateIds: candidates.map(({ id }) => id),
    gaps: [],
    images: {
      baseline: [],
      units: candidates.flatMap(({ id: candidateId }) => [
        { candidateId, mode: "light" },
        { candidateId, mode: "dark" },
      ]),
    },
  };
  return { candidates, verifiedModel };
}

function makeBoundSelection(verifiedModel, variantOverrides = {}) {
  const choices = Object.fromEntries(
    SKIN_IDS.map((skinId) => {
      const variant = variantOverrides[skinId] ?? "a";
      const candidate = verifiedModel.candidateSet.candidates.find(
        (item) => item.skinId === skinId && item.variant === variant,
      );
      return [skinId, { candidateId: candidate.id, candidateHash: candidate.candidateHash }];
    }),
  );
  return createSelectionExport({
    verifiedModel,
    choices,
    decisionSource: "Synthetic reader test selection",
    recordedAt: "2026-10-10T00:00:00.000Z",
  }).record;
}

function makeIncompleteMatrix({ skinId, outDir }) {
  const groups = ["S0"];
  const fixtureHash = getPaletteFixtureHash();
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups,
    fixtureHash,
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  const modes = {
    light: { status: "incomplete", reason: "small reader fixture" },
    dark: { status: "incomplete", reason: "small reader fixture" },
  };
  return {
    outDir,
    skinId,
    modes,
    capture: {
      schemaVersion: 1,
      kind: "skin-palette-capture-matrix",
      candidate: { production: true, skinId },
      groups,
      fixtureHash,
      fixtureBindings,
      modes: structuredClone(modes),
    },
    progress: {
      groups: [...groups],
      modes: Object.keys(modes),
      digests: { fixtureHash, fixtureBindings: structuredClone(fixtureBindings) },
      units: {},
      attempts: [],
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

test("merges one, two, and ten shards in registered skin order", () => {
  for (const count of [1, 2, 10]) {
    const input = SKIN_IDS.slice(0, count)
      .map((skinId) => shard(skinId))
      .reverse();
    const merged = mergeProductionCaptureShards({ shards: input });

    assert.deepEqual(Object.keys(merged.captures), SKIN_IDS.slice(0, count));
    assert.deepEqual(merged, {
      schemaVersion: 1,
      captures: Object.fromEntries(SKIN_IDS.slice(0, count).map((skinId) => [skinId, `captures/${skinId}`])),
    });
    assert.notStrictEqual(merged, input[0]);
    assert.notStrictEqual(merged.captures, input[0].captures);
  }
});

test("accepts canonical sibling paths and frozen normal or null-prototype inputs", () => {
  const [firstSkin, secondSkin] = SKIN_IDS;
  const frozen = deepFreeze({ shards: [shard(firstSkin, "../validation/s0/capture")] });
  assert.equal(mergeProductionCaptureShards(frozen).captures[firstSkin], "../validation/s0/capture");

  const nullProtoCaptures = Object.assign(Object.create(null), { [secondSkin]: "../validation/s1/capture" });
  const nullProtoShard = Object.assign(Object.create(null), { schemaVersion: 1, captures: nullProtoCaptures });
  const nullProtoOptions = Object.assign(Object.create(null), { shards: [nullProtoShard] });
  assert.equal(mergeProductionCaptureShards(nullProtoOptions).captures[secondSkin], "../validation/s1/capture");
});

test("rejects duplicate skins and duplicate capture paths", () => {
  const [firstSkin, secondSkin] = SKIN_IDS;
  assert.throws(() => mergeProductionCaptureShards({ shards: [shard(firstSkin), shard(firstSkin)] }), TypeError);
  assert.throws(
    () => mergeProductionCaptureShards({ shards: [shard(firstSkin, "captures/a"), shard(firstSkin, "captures/b")] }),
    TypeError,
  );
  assert.throws(
    () =>
      mergeProductionCaptureShards({
        shards: [shard(firstSkin, "captures/shared"), shard(secondSkin, "captures/shared")],
      }),
    TypeError,
  );
});

test("rejects malformed options, shards, capture maps, and shard arrays", () => {
  const [skinId] = SKIN_IDS;
  const valid = shard(skinId);
  const symbol = Symbol("extra");
  class CustomOptions {
    constructor() {
      this.shards = [valid];
    }
  }
  class CustomShard {
    constructor() {
      this.schemaVersion = 1;
      this.captures = valid.captures;
    }
  }

  for (const options of [null, [], new CustomOptions(), Object.assign(Object.create({ shards: [valid] }), {})]) {
    assert.throws(() => mergeProductionCaptureShards(options), TypeError);
  }
  assert.throws(() => mergeProductionCaptureShards({ shards: [valid], extra: true }), TypeError);
  assert.throws(() => mergeProductionCaptureShards({ shards: [valid], [symbol]: true }), TypeError);
  assert.throws(() => mergeProductionCaptureShards({ shards: [] }), TypeError);
  assert.throws(() => mergeProductionCaptureShards({ shards: Array(11).fill(valid) }), TypeError);
  assert.throws(() => mergeProductionCaptureShards({ shards: Array(1) }), TypeError);
  assert.throws(() => mergeProductionCaptureShards({ shards: [new CustomShard()] }), TypeError);

  const extraArrayKey = [valid];
  extraArrayKey.extra = true;
  assert.throws(() => mergeProductionCaptureShards({ shards: extraArrayKey }), TypeError);
  const symbolArrayKey = [valid];
  symbolArrayKey[symbol] = true;
  assert.throws(() => mergeProductionCaptureShards({ shards: symbolArrayKey }), TypeError);
  assert.throws(() => mergeProductionCaptureShards({ shards: [{ ...valid, [symbol]: true }] }), TypeError);

  assert.throws(
    () => mergeProductionCaptureShards({ shards: [{ schemaVersion: "1", captures: valid.captures }] }),
    TypeError,
  );
  assert.throws(() => mergeProductionCaptureShards({ shards: [{ ...valid, extra: true }] }), TypeError);
  assert.throws(
    () => mergeProductionCaptureShards({ shards: [Object.assign(Object.create({ inherited: true }), valid)] }),
    TypeError,
  );
  assert.throws(
    () =>
      mergeProductionCaptureShards({
        shards: [{ schemaVersion: 1, captures: { ...valid.captures, unknown: "captures/other" } }],
      }),
    TypeError,
  );
  assert.throws(
    () => mergeProductionCaptureShards({ shards: [{ schemaVersion: 1, captures: { unknown: "captures/other" } }] }),
    TypeError,
  );
  assert.throws(
    () =>
      mergeProductionCaptureShards({
        shards: [
          { schemaVersion: 1, captures: Object.assign(Object.create({ inherited: "captures/x" }), valid.captures) },
        ],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      mergeProductionCaptureShards({ shards: [{ schemaVersion: 1, captures: { ...valid.captures, [symbol]: true } }] }),
    TypeError,
  );
});

test("rejects noncanonical, absolute, and non-POSIX capture paths", () => {
  const [skinId] = SKIN_IDS;
  const invalidPaths = [
    "",
    " \t ",
    "captures/part\0bad",
    "captures\\part",
    "C:/captures/a",
    "C:captures/a",
    "file:captures/a",
    "https://host/a",
    "//server/share",
    "/captures/a",
    "captures//a",
    "captures/./a",
    "captures/a/../b",
    "captures/a/",
  ];

  for (const captureDir of invalidPaths) {
    assert.throws(() => mergeProductionCaptureShards({ shards: [shard(skinId, captureDir)] }), TypeError, captureDir);
  }
});

test("rejects accessors without invoking them", () => {
  const [skinId] = SKIN_IDS;
  let getterCalls = 0;
  const options = Object.defineProperty({}, "shards", {
    get() {
      getterCalls += 1;
      return [shard(skinId)];
    },
  });
  assert.throws(() => mergeProductionCaptureShards(options), TypeError);

  const accessorShard = Object.defineProperty({ captures: { [skinId]: "captures/a" } }, "schemaVersion", {
    get() {
      getterCalls += 1;
      return 1;
    },
  });
  assert.throws(() => mergeProductionCaptureShards({ shards: [accessorShard] }), TypeError);

  const accessorCaptures = Object.defineProperty({}, skinId, {
    get() {
      getterCalls += 1;
      return "captures/a";
    },
  });
  assert.throws(
    () => mergeProductionCaptureShards({ shards: [{ schemaVersion: 1, captures: accessorCaptures }] }),
    TypeError,
  );

  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", {
    get() {
      getterCalls += 1;
      return shard(skinId);
    },
  });
  assert.throws(() => mergeProductionCaptureShards({ shards: accessorArray }), TypeError);
  assert.equal(getterCalls, 0);
});

test("reads only explicit shards inside a real validation fixture", async (t) => {
  const repoReal = await realpath(REPO_ROOT);
  const validationReal = await realpath(path.join(repoReal, "docs", "validation"));
  let fixturePath;
  let fixtureReal;
  try {
    fixturePath = await mkdtemp(path.join(validationReal, "m4-4-7-e3d-2-"));
    fixtureReal = await realpath(fixturePath);
    assert.notEqual(path.relative(validationReal, fixtureReal), "");
    assert.equal(path.relative(validationReal, fixtureReal).startsWith(`..${path.sep}`), false);

    const runDir = path.join(fixturePath, "run");
    const outA = path.join(fixturePath, "capture-a");
    const outB = path.join(fixturePath, "capture-b");
    const outMismatch = path.join(fixturePath, "capture-mismatch");
    const outMissing = path.join(fixturePath, "capture-missing");
    const outBadJson = path.join(fixturePath, "capture-bad-json");
    const outBadUtf8 = path.join(fixturePath, "capture-bad-utf8");
    for (const dir of [runDir, outA, outB, outMismatch, outMissing, outBadJson, outBadUtf8]) {
      await mkdir(dir);
    }

    const [firstSkin, secondSkin] = SKIN_IDS;
    async function writeShard(outDir, skinId, captureDir = path.relative(runDir, outDir).split(path.sep).join("/")) {
      const index = { schemaVersion: 1, captures: { [skinId]: captureDir } };
      const filePath = path.join(outDir, "production-index-shard.json");
      await writeFile(filePath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      return filePath;
    }

    const shardA = await writeShard(outA, firstSkin);
    const shardB = await writeShard(outB, secondSkin);
    const single = await readProductionCaptureShards({ runDir, shardPaths: [shardA] });
    assert.deepEqual(Object.keys(single), ["runDir", "index", "shards"]);
    assert.equal(single.runDir, await realpath(runDir));
    assert.deepEqual(single.index.captures, { [firstSkin]: "../capture-a" });
    assert.deepEqual(Object.keys(single.shards[0]), ["skinId", "shardPath", "outDir", "index", "fileSha256"]);
    assert.equal(single.shards[0].shardPath, await realpath(shardA));
    assert.equal(single.shards[0].outDir, await realpath(outA));
    assert.equal(
      single.shards[0].fileSha256,
      createHash("sha256")
        .update(await readFile(shardA))
        .digest("hex"),
    );
    assert.deepEqual(single.shards[0].index, { schemaVersion: 1, captures: { [firstSkin]: "../capture-a" } });

    const both = await readProductionCaptureShards({ runDir, shardPaths: [shardB, shardA] });
    assert.deepEqual(Object.keys(both.index.captures), SKIN_IDS.slice(0, 2));
    assert.deepEqual(
      both.shards.map(({ skinId }) => skinId),
      SKIN_IDS.slice(0, 2),
    );
    assert.deepEqual(both.index.captures, { [firstSkin]: "../capture-a", [secondSkin]: "../capture-b" });

    const copiedInputPaths = [shardA];
    const pendingRead = readProductionCaptureShards({ runDir, shardPaths: copiedInputPaths });
    copiedInputPaths[0] = path.join(outMissing, "production-index-shard.json");
    assert.equal((await pendingRead).shards[0].skinId, firstSkin);

    let getterCalls = 0;
    const accessorOptions = Object.defineProperty({ shardPaths: [shardA] }, "runDir", {
      get() {
        getterCalls += 1;
        return runDir;
      },
    });
    await assert.rejects(readProductionCaptureShards(accessorOptions), TypeError);
    await assert.rejects(readProductionCaptureShards({ runDir, shardPaths: ["https://example.test/a"] }), TypeError);
    await assert.rejects(readProductionCaptureShards({ runDir, shardPaths: ["bad\0path"] }), TypeError);
    await assert.rejects(readProductionCaptureShards({ runDir: "file:///tmp/run", shardPaths: [shardA] }), TypeError);
    assert.equal(getterCalls, 0);

    await assert.rejects(readProductionCaptureShards({ runDir: repoReal, shardPaths: [shardA] }), TypeError);
    await assert.rejects(
      readProductionCaptureShards({ runDir, shardPaths: [path.join(repoReal, "package.json")] }),
      TypeError,
    );
    await assert.rejects(
      readProductionCaptureShards({ runDir, shardPaths: [path.join(outA, "wrong-name.json")] }),
      TypeError,
    );
    await assert.rejects(
      readProductionCaptureShards({ runDir, shardPaths: [path.join(outMissing, "production-index-shard.json")] }),
    );

    const badJson = path.join(outBadJson, "production-index-shard.json");
    const badUtf8 = path.join(outBadUtf8, "production-index-shard.json");
    await writeFile(badJson, "{", "utf8");
    await writeFile(badUtf8, Buffer.from([0xc3, 0x28]));
    await assert.rejects(readProductionCaptureShards({ runDir, shardPaths: [badJson] }), /strict UTF-8 JSON/);
    await assert.rejects(readProductionCaptureShards({ runDir, shardPaths: [badUtf8] }), /strict UTF-8 JSON/);

    const mismatchShard = await writeShard(outMismatch, secondSkin, "../capture-a");
    await assert.rejects(
      readProductionCaptureShards({ runDir, shardPaths: [mismatchShard] }),
      /actual output directory/,
    );
    const duplicateAlias = path.join(outA, "not-created", "..", "production-index-shard.json");
    await assert.rejects(
      readProductionCaptureShards({ runDir, shardPaths: [shardA, duplicateAlias] }),
      /duplicates an existing/,
    );

    await t.test("rejects a file symlink when the host permits creating one", async (subtest) => {
      const linkDir = path.join(fixturePath, "capture-file-symlink");
      await mkdir(linkDir);
      const targetPath = path.join(linkDir, "target.json");
      const linkPath = path.join(linkDir, "production-index-shard.json");
      await writeFile(
        targetPath,
        `${JSON.stringify({ schemaVersion: 1, captures: { [firstSkin]: "../capture-file-symlink" } })}\n`,
      );
      try {
        await symlink(targetPath, linkPath, "file");
      } catch (error) {
        subtest.skip(`file symlink unavailable: ${error.code ?? error.message}`);
        return;
      }
      await assert.rejects(readProductionCaptureShards({ runDir, shardPaths: [linkPath] }), /non-symlink file/);
    });

    await t.test("rejects an external directory junction when the host permits creating one", async (subtest) => {
      const junctionPath = path.join(fixturePath, "external-run");
      try {
        await symlink(repoReal, junctionPath, "junction");
      } catch (error) {
        subtest.skip(`directory junction unavailable: ${error.code ?? error.message}`);
        return;
      }
      await assert.rejects(
        readProductionCaptureShards({ runDir: junctionPath, shardPaths: [shardA] }),
        /runDir realpath/,
      );
    });
  } finally {
    if (fixturePath && fixtureReal) {
      const cleanupTarget = path.resolve(fixturePath);
      const cleanupReal = await realpath(cleanupTarget);
      assert.equal(cleanupTarget, fixturePath);
      assert.equal(cleanupReal, fixtureReal);
      const fixtureRelative = path.relative(validationReal, cleanupReal);
      assert.notEqual(fixtureRelative, "");
      assert.equal(fixtureRelative === ".." || fixtureRelative.startsWith(`..${path.sep}`), false);
      await rm(cleanupTarget, { recursive: true, force: false });
    }
  }
});

test("binds each shard through the production reader and rejects changed evidence", async () => {
  const repoReal = await realpath(REPO_ROOT);
  const validationReal = await realpath(path.join(repoReal, "docs", "validation"));
  let fixturePath;
  let fixtureReal;
  try {
    fixturePath = await mkdtemp(path.join(validationReal, "m4-4-7-e3d-3-"));
    fixtureReal = await realpath(fixturePath);
    const fixtureRelative = path.relative(validationReal, fixtureReal);
    assert.notEqual(fixtureRelative, "");
    assert.equal(fixtureRelative === ".." || fixtureRelative.startsWith(`..${path.sep}`), false);

    const runDir = path.join(fixturePath, "run");
    const outDir = path.join(fixturePath, `capture-${SKIN_IDS[0]}`);
    await mkdir(runDir);
    await mkdir(outDir);

    const { candidates, verifiedModel } = makeBoundFixture();
    const selections = makeBoundSelection(verifiedModel);
    const candidate = candidates.find((item) => item.skinId === SKIN_IDS[0] && item.variant === "a");
    const alternateCandidate = candidates.find((item) => item.skinId === SKIN_IDS[0] && item.variant === "b");
    assert.equal(candidates.length, 30);
    assert.equal(Object.keys(selections.choices).length, SKIN_IDS.length);

    const candidatesPath = path.join(runDir, "candidates.json");
    const capturePath = path.join(outDir, "capture.json");
    const progressPath = path.join(outDir, "progress.json");
    const sidecarPath = path.join(outDir, "production-selection.json");
    const captureResult = makeIncompleteMatrix({ skinId: SKIN_IDS[0], outDir });
    await writeFile(candidatesPath, `${JSON.stringify(verifiedModel.candidateSet)}\n`, "utf8");
    await writeFile(capturePath, `${JSON.stringify(captureResult.capture)}\n`, "utf8");
    await writeFile(progressPath, `${JSON.stringify(captureResult.progress)}\n`, "utf8");
    const writtenBinding = await writeProductionCaptureBinding({
      runDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
      captureResult,
    });
    const writtenShard = await writeProductionCaptureIndexShard({
      runDir,
      outDir,
      verifiedModel,
      selections,
      candidateId: candidate.id,
    });
    assert.deepEqual(writtenShard.index, {
      schemaVersion: 1,
      captures: { [SKIN_IDS[0]]: `../capture-${SKIN_IDS[0]}` },
    });

    const shardPaths = [writtenShard.shardPath];
    const input = { runDir, shardPaths, verifiedModel, selections };
    const bound = await readBoundProductionCaptureShards(input);
    assert.deepEqual(Object.keys(bound), ["runDir", "index", "shards"]);
    assert.deepEqual(bound.index, writtenShard.index);
    assert.equal(bound.shards.length, 1);
    assert.equal(bound.shards[0].skinId, SKIN_IDS[0]);
    assert.deepEqual(bound.shards[0].binding, writtenBinding.binding);
    assert.notStrictEqual(bound.shards[0].binding, writtenBinding.binding);
    assert.equal(bound.shards[0].binding.selectionBinding.candidateId, candidate.id);
    assert.equal(bound.shards[0].binding.selectionBinding.skinId, SKIN_IDS[0]);
    assert.deepEqual(Object.keys(bound.shards[0].binding).sort(), [
      "candidateFileSha256",
      "captureFileSha256",
      "kind",
      "originRun",
      "progressFileSha256",
      "schemaVersion",
      "selectionBinding",
      "selectionHash",
    ]);
    assert.deepEqual(Object.keys(bound.shards[0]), ["skinId", "shardPath", "outDir", "index", "fileSha256", "binding"]);
    assert.equal(Object.hasOwn(bound.shards[0], "captureResult"), false);
    assert.equal(captureResult.modes.light.status, "incomplete");

    const mutableModel = structuredClone(verifiedModel);
    const mutableSelections = structuredClone(selections);
    const pendingSnapshotRead = readBoundProductionCaptureShards({
      runDir,
      shardPaths,
      verifiedModel: mutableModel,
      selections: mutableSelections,
    });
    mutableModel.candidateSet.candidates.find((item) => item.id === candidate.id).style.rationale =
      "mutated after call";
    mutableSelections.choices[SKIN_IDS[0]].candidateId = "changed-after-call";
    assert.deepEqual((await pendingSnapshotRead).shards[0].binding, writtenBinding.binding);

    let getterCalls = 0;
    const accessorModel = Object.defineProperty({ ...verifiedModel }, "candidateSet", {
      get() {
        getterCalls += 1;
        return verifiedModel.candidateSet;
      },
    });
    await assert.rejects(
      readBoundProductionCaptureShards({ runDir, shardPaths, verifiedModel: accessorModel, selections }),
      TypeError,
    );
    const accessorSelections = Object.defineProperty({ ...selections }, "choices", {
      get() {
        getterCalls += 1;
        return selections.choices;
      },
    });
    await assert.rejects(
      readBoundProductionCaptureShards({ runDir, shardPaths, verifiedModel, selections: accessorSelections }),
      TypeError,
    );
    assert.equal(getterCalls, 0);

    const changedSelections = makeBoundSelection(verifiedModel, { [SKIN_IDS[0]]: "b" });
    await assert.rejects(
      readBoundProductionCaptureShards({ runDir, shardPaths, verifiedModel, selections: changedSelections }),
      TypeError,
    );

    const originalFiles = new Map(
      await Promise.all(
        [candidatesPath, capturePath, progressPath, sidecarPath].map(async (filePath) => [
          filePath,
          await readFile(filePath),
        ]),
      ),
    );
    async function expectDriftRejected(filePath, changedBytes) {
      const original = originalFiles.get(filePath);
      try {
        await writeFile(filePath, changedBytes);
        await assert.rejects(readBoundProductionCaptureShards(input));
      } finally {
        await writeFile(filePath, original);
      }
      assert.deepEqual(await readFile(filePath), original);
    }
    async function expectMissingRejected(filePath) {
      const original = originalFiles.get(filePath);
      try {
        await unlink(filePath);
        await assert.rejects(readBoundProductionCaptureShards(input));
      } finally {
        await writeFile(filePath, original);
      }
      assert.deepEqual(await readFile(filePath), original);
    }

    await expectDriftRejected(candidatesPath, Buffer.concat([originalFiles.get(candidatesPath), Buffer.from(" ")]));
    await expectDriftRejected(capturePath, Buffer.concat([originalFiles.get(capturePath), Buffer.from(" ")]));
    await expectDriftRejected(progressPath, Buffer.concat([originalFiles.get(progressPath), Buffer.from(" ")]));
    const changedSidecar = JSON.parse(originalFiles.get(sidecarPath).toString("utf8"));
    changedSidecar.selectionHash = "f".repeat(64);
    await expectDriftRejected(sidecarPath, Buffer.from(`${JSON.stringify(changedSidecar)}\n`));
    await expectMissingRejected(candidatesPath);
    await expectMissingRejected(capturePath);
    await expectMissingRejected(progressPath);
    await expectMissingRejected(sidecarPath);

    const oldSidecar = originalFiles.get(sidecarPath);
    try {
      await unlink(sidecarPath);
      await writeProductionCaptureBinding({
        runDir,
        verifiedModel,
        selections: changedSelections,
        candidateId: alternateCandidate.id,
        captureResult,
      });
      await assert.rejects(readBoundProductionCaptureShards(input));
    } finally {
      await writeFile(sidecarPath, oldSidecar);
    }
    assert.deepEqual(await readFile(sidecarPath), oldSidecar);
  } finally {
    if (fixturePath && fixtureReal) {
      const cleanupTarget = path.resolve(fixturePath);
      const cleanupReal = await realpath(cleanupTarget);
      assert.equal(cleanupTarget, fixturePath);
      assert.equal(cleanupReal, fixtureReal);
      const relative = path.relative(validationReal, cleanupReal);
      assert.notEqual(relative, "");
      assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`), false);
      await rm(cleanupTarget, { recursive: true, force: false });
    }
  }
});

test("writes the fixed production index once and accepts only byte-identical reuse", async (t) => {
  const repoReal = await realpath(REPO_ROOT);
  const validationReal = await realpath(path.join(repoReal, "docs", "validation"));
  let fixturePath;
  let fixtureReal;
  try {
    fixturePath = await mkdtemp(path.join(validationReal, "m4-4-7-e3d-4-"));
    fixtureReal = await realpath(fixturePath);
    const fixtureRelative = path.relative(validationReal, fixtureReal);
    assert.notEqual(fixtureRelative, "");
    assert.equal(fixtureRelative === ".." || fixtureRelative.startsWith(`..${path.sep}`), false);

    const runDir = path.join(fixturePath, "run");
    await mkdir(runDir);
    const { candidates, verifiedModel } = makeBoundFixture();
    const selections = makeBoundSelection(verifiedModel);
    const [firstSkin, secondSkin] = SKIN_IDS;
    const candidateA = candidates.find((item) => item.skinId === firstSkin && item.variant === "a");
    const candidateB = candidates.find((item) => item.skinId === secondSkin && item.variant === "a");
    await writeFile(path.join(runDir, "candidates.json"), `${JSON.stringify(verifiedModel.candidateSet)}\n`, "utf8");
    const candidateIndexPath = path.join(runDir, "captures-index.json");
    const candidateIndexBytes = Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, captures: { [candidateA.id]: `captures/${candidateA.id}` } })}\n`,
    );
    await writeFile(candidateIndexPath, candidateIndexBytes);

    async function writeCaptureShard(candidate, outName) {
      const outDir = path.join(fixturePath, outName);
      await mkdir(outDir);
      const captureResult = makeIncompleteMatrix({ skinId: candidate.skinId, outDir });
      await writeFile(path.join(outDir, "capture.json"), `${JSON.stringify(captureResult.capture)}\n`, "utf8");
      await writeFile(path.join(outDir, "progress.json"), `${JSON.stringify(captureResult.progress)}\n`, "utf8");
      await writeProductionCaptureBinding({
        runDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
        captureResult,
      });
      return writeProductionCaptureIndexShard({
        runDir,
        outDir,
        verifiedModel,
        selections,
        candidateId: candidate.id,
      });
    }

    const shardA = await writeCaptureShard(candidateA, `capture-${firstSkin}`);
    const input = { runDir, shardPaths: [shardA.shardPath], verifiedModel, selections };
    const simultaneousWrites = await Promise.all(Array.from({ length: 3 }, () => writeProductionCaptureIndex(input)));
    assert.equal(simultaneousWrites.filter(({ created }) => created).length, 1);
    assert.equal(simultaneousWrites.filter(({ created }) => !created).length, 2);
    const first = simultaneousWrites.find(({ created }) => created);
    const expectedIndexPath = path.join(await realpath(runDir), "production-captures-index.json");
    const firstBytes = Buffer.from(`${JSON.stringify(shardA.index, null, 2)}\n`, "utf8");
    assert.deepEqual(Object.keys(first), ["indexPath", "index", "fileSha256", "created"]);
    assert.equal(first.indexPath, expectedIndexPath);
    assert.deepEqual(first.index, shardA.index);
    assert.equal(first.created, true);
    assert.deepEqual(await readFile(first.indexPath), firstBytes);
    assert.equal(first.fileSha256, createHash("sha256").update(firstBytes).digest("hex"));

    const repeated = await writeProductionCaptureIndex(input);
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.index, first.index);
    assert.equal(repeated.fileSha256, first.fileSha256);
    assert.deepEqual(await readFile(first.indexPath), firstBytes);

    const shardB = await writeCaptureShard(candidateB, `capture-${secondSkin}`);
    await assert.rejects(
      writeProductionCaptureIndex({ ...input, shardPaths: [shardA.shardPath, shardB.shardPath] }),
      /different bytes|write-once/,
    );
    assert.deepEqual(await readFile(first.indexPath), firstBytes);

    const shardAAlternate = await writeCaptureShard(candidateA, `capture-${firstSkin}-alternate`);
    await assert.rejects(
      writeProductionCaptureIndex({ ...input, shardPaths: [shardAAlternate.shardPath] }),
      /different bytes|write-once/,
    );
    assert.deepEqual(await readFile(first.indexPath), firstBytes);

    const compactBytes = Buffer.from(`${JSON.stringify(first.index)}\n`, "utf8");
    await unlink(first.indexPath);
    await writeFile(first.indexPath, compactBytes);
    await assert.rejects(writeProductionCaptureIndex(input), /different bytes|write-once/);
    assert.deepEqual(await readFile(first.indexPath), compactBytes);
    await writeFile(first.indexPath, firstBytes);

    const sidecarPath = path.join(path.dirname(shardA.shardPath), "production-selection.json");
    const sidecarBytes = await readFile(sidecarPath);
    await unlink(first.indexPath);
    try {
      const changedSidecar = JSON.parse(sidecarBytes.toString("utf8"));
      changedSidecar.selectionHash = "f".repeat(64);
      await writeFile(sidecarPath, `${JSON.stringify(changedSidecar)}\n`, "utf8");
      await assert.rejects(writeProductionCaptureIndex(input), TypeError);
      await assert.rejects(access(first.indexPath), { code: "ENOENT" });
    } finally {
      await writeFile(sidecarPath, sidecarBytes);
    }
    await writeFile(first.indexPath, firstBytes);

    await unlink(first.indexPath);
    await mkdir(first.indexPath);
    await assert.rejects(writeProductionCaptureIndex(input), /regular non-symlink file/);
    assert.equal((await lstat(first.indexPath)).isDirectory(), true);
    await rmdir(first.indexPath);
    await writeFile(first.indexPath, firstBytes);

    await t.test("rejects a fixed-index symlink when the host permits creating one", async (subtest) => {
      const targetPath = path.join(runDir, "untouched-index-target.txt");
      const targetBytes = Buffer.from("target remains untouched\n", "utf8");
      await unlink(first.indexPath);
      await writeFile(targetPath, targetBytes);
      try {
        await symlink(targetPath, first.indexPath, "file");
      } catch (error) {
        await writeFile(first.indexPath, firstBytes);
        subtest.skip(`file symlink unavailable: ${error.code ?? error.message}`);
        return;
      }
      try {
        await assert.rejects(writeProductionCaptureIndex(input), /regular non-symlink file/);
        assert.deepEqual(await readFile(targetPath), targetBytes);
      } finally {
        await unlink(first.indexPath);
        await writeFile(first.indexPath, firstBytes);
      }
    });

    assert.deepEqual(await readFile(candidateIndexPath), candidateIndexBytes);
    assert.deepEqual(await readFile(first.indexPath), firstBytes);
  } finally {
    if (fixturePath && fixtureReal) {
      const cleanupTarget = path.resolve(fixturePath);
      const cleanupReal = await realpath(cleanupTarget);
      assert.equal(cleanupTarget, fixturePath);
      assert.equal(cleanupReal, fixtureReal);
      const relative = path.relative(validationReal, cleanupReal);
      assert.notEqual(relative, "");
      assert.equal(relative === ".." || relative.startsWith(`..${path.sep}`), false);
      await rm(cleanupTarget, { recursive: true, force: false });
    }
  }
});

test("assembler rejects malformed or injected arguments before source I/O", async () => {
  let getterCalls = 0;
  const accessorOptions = Object.defineProperties(
    {},
    {
      runDir: {
        get() {
          getterCalls += 1;
          return "docs/validation/run";
        },
      },
      shardPaths: { value: ["docs/validation/capture/production-index-shard.json"] },
    },
  );
  const accessorPaths = new Array(1);
  Object.defineProperty(accessorPaths, "0", {
    get() {
      getterCalls += 1;
      return "docs/validation/capture/production-index-shard.json";
    },
  });

  await assert.rejects(assembleProductionCaptureIndex(accessorOptions), TypeError);
  await assert.rejects(
    assembleProductionCaptureIndex({
      runDir: "docs/validation/run",
      shardPaths: ["docs/validation/capture/production-index-shard.json"],
      verifiedModel: { forged: true },
      selections: { forged: true },
      sourceContext: { forged: true },
      evidence: { forged: true },
    }),
    TypeError,
  );
  await assert.rejects(
    assembleProductionCaptureIndex({ runDir: "https://example.invalid/run", shardPaths: ["unused"] }),
    TypeError,
  );
  await assert.rejects(
    assembleProductionCaptureIndex({ runDir: "docs/validation/run", shardPaths: accessorPaths }),
    TypeError,
  );
  await assert.rejects(assembleProductionCaptureIndex({ runDir: "docs/validation/run", shardPaths: [] }), TypeError);
  assert.equal(getterCalls, 0);
});

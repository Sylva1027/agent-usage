import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseOpencodeDb, opencodeDatabaseFiles, streamOpencodeDbEvents } from "../../src/opencode-usage.js";
import { parseZcodeDb, streamZcodeDbEvents, zcodeDatabaseFile } from "../../src/zcode-usage.js";
import { generateSqliteInputs } from "./growth-sqlite-inputs.mjs";

const START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const END_MS = START_MS + 90 * 86_400_000;
const INPUTS = [
  { key: "z-base", kind: "zcode", events: 6, sourceBytes: 2 * 1024 * 1024, sessions: 3 },
  { key: "oc-base", kind: "opencode", events: 4, sourceBytes: 1024 * 1024 + 888, sessions: 2 },
];

test("multi-blob SQLite padding records bounded b-tree page overhead", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'growth-sqlite-padding-'));
  try {
    const inputs = [
      { key: '11111111111111111111', kind: 'zcode', events: 100, sourceBytes: 70 * 1024 * 1024, sessions: 1 },
      { key: '22222222222222222222', kind: 'opencode', events: 5260, sourceBytes: 300040880, sessions: 11 },
    ];
    const outputs = await generateSqliteInputs({ root, scale: 1, files: inputs });
    for (const output of outputs) {
      const target = inputs.find(f => f.kind === output.kind);
      const rounded = Math.ceil(target.sourceBytes / 4096) * 4096;
      assert.ok(output.sourceBytes >= rounded && output.sourceBytes <= rounded + 8 * 4096);
      assert.ok(output.schemaDifferences.paddingRows > 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function sourceFor(root, kind) {
  return {
    id: `synthetic-${kind}`,
    label: `Synthetic ${kind}`,
    path: path.join(root, kind === "zcode" ? ".zcode" : ".opencode"),
    kind,
  };
}

function sumTotals(events) {
  return events.reduce(
    (totals, event) => {
      for (const field of ["total", "input", "cached", "output", "reasoning"]) {
        totals[field] += event.total[field];
      }
      return totals;
    },
    { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
  );
}

test("growth SQLite inputs preserve real parser counts and scale linearly at 1x, 5x, and 10x", async () => {
  for (const scale of [1, 5, 10]) {
    const root = await mkdtemp(path.join(tmpdir(), `growth-sqlite-${scale}-`));
    try {
      const result = await generateSqliteInputs({ root, scale, files: INPUTS });
      assert.equal(result.length, 2);

      const zcodeResult = result.find((source) => source.kind === "zcode");
      const opencodeResult = result.find((source) => source.kind === "opencode");
      assert.ok(zcodeResult);
      assert.ok(opencodeResult);

      const zcodeHome = path.join(root, ".zcode");
      const opencodeHome = path.join(root, ".opencode");
      const zcodeFile = await zcodeDatabaseFile(zcodeHome);
      const opencodeFiles = await opencodeDatabaseFiles(opencodeHome);
      assert.equal(zcodeFile, path.join(root, ".zcode", "cli", "db", "db.sqlite"));
      assert.deepEqual(opencodeFiles, [path.join(root, ".opencode", "opencode.db")]);
      assert.equal(
        (await readdir(path.join(root, ".zcode", "cli", "db"))).filter((name) => name.endsWith(".sqlite")).length,
        1,
      );
      assert.equal((await readdir(opencodeHome)).filter((name) => /^opencode.*\.db$/.test(name)).length, 1);

      const zcodeExpectedBytes = Math.ceil((INPUTS[0].sourceBytes * scale) / 4096) * 4096;
      const opencodeExpectedBytes = Math.ceil((INPUTS[1].sourceBytes * scale) / 4096) * 4096;
      assert.equal((await stat(zcodeFile)).size, zcodeExpectedBytes);
      assert.equal((await stat(opencodeFiles[0])).size, opencodeExpectedBytes);
      assert.equal(zcodeResult.sourceBytes, zcodeExpectedBytes);
      assert.equal(opencodeResult.sourceBytes, opencodeExpectedBytes);
      assert.equal(zcodeResult.rawRows, 6 * scale);
      assert.equal(opencodeResult.rawRows, 4 * scale);

      let zcodeStreamCount = 0;
      await streamZcodeDbEvents(zcodeFile, sourceFor(root, "zcode"), () => {
        zcodeStreamCount += 1;
      });
      const zcodeParsed = await parseZcodeDb(zcodeFile, sourceFor(root, "zcode"));
      assert.equal(zcodeStreamCount, 6 * scale);
      assert.equal(zcodeParsed.events.length, 6 * scale);
      assert.equal(zcodeParsed.sessions.length, 3);
      assert.deepEqual(sumTotals(zcodeParsed.events), zcodeResult.expectedTotals);
      assert.ok(
        zcodeParsed.events.every(
          (event) =>
            event.total.total === 15 &&
            event.total.input === 10 &&
            event.total.cached === 2 &&
            event.total.output === 5 &&
            event.total.reasoning === 1,
        ),
      );

      let opencodeStreamCount = 0;
      await streamOpencodeDbEvents(opencodeFiles[0], sourceFor(root, "opencode"), () => {
        opencodeStreamCount += 1;
      });
      const opencodeParsed = await parseOpencodeDb(opencodeFiles[0], sourceFor(root, "opencode"));
      assert.equal(opencodeStreamCount, 4 * scale);
      assert.equal(opencodeParsed.events.length, 4 * scale);
      assert.equal(opencodeParsed.sessions.length, 2);
      assert.deepEqual(sumTotals(opencodeParsed.events), opencodeResult.expectedTotals);
      assert.ok(
        opencodeParsed.events.every(
          (event) =>
            event.total.total === 15 &&
            event.total.input === 10 &&
            event.total.cached === 2 &&
            event.total.output === 5 &&
            event.total.reasoning === 1,
        ),
      );

      const zcodeIds = zcodeParsed.events.map((event) => event.id);
      const opencodeIds = opencodeParsed.events.map((event) => event.id);
      assert.equal(new Set(zcodeIds).size, zcodeIds.length);
      assert.equal(new Set(opencodeIds).size, opencodeIds.length);
      assert.equal(new Set([...zcodeIds, ...opencodeIds]).size, zcodeIds.length + opencodeIds.length);
      assert.deepEqual(
        zcodeParsed.events.map((event) => event.model),
        Array(zcodeIds.length).fill("gpt-6-sol"),
      );
      assert.deepEqual(
        opencodeParsed.events.map((event) => event.model),
        Array(opencodeIds.length).fill("deepseek-flash"),
      );

      const zcodeTimes = zcodeParsed.events.map((event) => Date.parse(event.timestamp));
      const opencodeTimes = opencodeParsed.events.map((event) => Date.parse(event.timestamp));
      assert.equal(Math.min(...zcodeTimes), START_MS);
      assert.equal(Math.max(...zcodeTimes), END_MS);
      assert.equal(Math.min(...opencodeTimes), START_MS);
      assert.equal(Math.max(...opencodeTimes), END_MS);
      assert.deepEqual(zcodeResult.expectedTotals, {
        total: 15 * 6 * scale,
        input: 10 * 6 * scale,
        cached: 2 * 6 * scale,
        output: 5 * 6 * scale,
        reasoning: 6 * scale,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

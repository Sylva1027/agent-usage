import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { KINDS, accountSource, appendChange, planChanges, reviseChange } from "../experiments/architecture-20261101/remaining-harness-delivery-fixture.mjs";
import { createEventPricing } from "../src/pricing.js";
import { FIXTURE_TIME, createRemainingHarnessFixture } from "../test-support/remaining-harness-fixture.mjs";

const runtimeDirectory = fileURLToPath(new URL("../", import.meta.url));
const appendTimeMs = FIXTURE_TIME + 86400000;
const adapters = {
  claude: ["claude-code-usage.js", "streamClaudeSessionEvents"],
  workbuddy: ["workbuddy-usage.js", "streamWorkbuddySessionEvents"],
  zcode: ["zcode-usage.js", "streamZcodeDbEvents"],
  opencode: ["opencode-usage.js", "streamOpencodeDbEvents"],
};
async function reference(kind, fixture) {
  const [module, method] = adapters[kind];
  const events = [];
  await (await import(pathToFileURL(path.join(runtimeDirectory, "src", module))))[method](fixture.filePath, fixture.source,
    (event) => events.push(event), { repositoryResolver: (cwd) => ({ key: cwd, path: cwd, kind: "directory" }) });
  return events;
}
function counts(events) {
  return { total: events.reduce((sum, event) => sum + event.usage.total, 0), eventCount: events.length,
    sessionCount: new Set(events.map((event) => event.sessionId)).size };
}
const identity = (event) => event.eventId ?? event.messageId;
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), "remaining-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function sql(file, action) {
  const db = new DatabaseSync(file);
  try { return action(db); } finally { db.close(); }
}
async function capturedShape(fixture, kind) {
  if (kind === "claude" || kind === "workbuddy") {
    const content = (await readFile(fixture.filePath, "utf8")).trimEnd();
    await writeFile(fixture.filePath, `\r\nignored non-JSON line\r\n${content.replaceAll("\n", "\r\n")}`);
  } else {
    sql(fixture.filePath, (db) => {
      if (kind === "zcode") {
        db.exec(`ALTER TABLE model_usage ADD COLUMN logical_request_id TEXT NOT NULL DEFAULT 'seed-request';
          ALTER TABLE model_usage ADD COLUMN attempt_index INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE model_usage ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'seed-provider';
          ALTER TABLE model_usage ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
          ALTER TABLE model_usage ADD COLUMN first_token_at INTEGER;
          ALTER TABLE model_usage ADD COLUMN raw_usage_json TEXT;
          ALTER TABLE model_usage ADD COLUMN provider_total_tokens INTEGER;
          UPDATE model_usage SET provider_total_tokens=computed_total_tokens,raw_usage_json='{}';`);
      } else {
        db.exec(`ALTER TABLE session_message ADD COLUMN time_updated INTEGER NOT NULL DEFAULT 123;
          CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id,seq);`);
      }
    });
  }
}

for (const kind of KINDS) {
  test(`${kind}: two literal appends and one original historical revision survive a serialized plan`, async (t) => {
    const root = await temporary(t);
    const fixture = createRemainingHarnessFixture(path.join(root, "source"), kind, 3);
    await capturedShape(fixture, kind);
    const beforeBytes = await readFile(fixture.filePath);
    const before = await reference(kind, fixture);
    const expected = { total: kind === "claude" ? 498 : 483, eventCount: 3, sessionCount: kind === "claude" || kind === "workbuddy" ? 1 : 3 };
    assert.deepEqual(counts(before), expected);
    assert.deepEqual(await accountSource({ kind, ...fixture }), expected);
    const args = { kind, ...fixture, runtimeDirectory, appendTimeMs };
    const plan = jsonCopy(await planChanges(args));
    assert.deepEqual(jsonCopy(await planChanges(args)), plan);
    assert.deepEqual(await readFile(fixture.filePath), beforeBytes, "planning cannot change the source");
    assert.equal(plan.original.identity, identity(before[0]));
    if (kind === "claude") assert.equal(plan.original.raw.message.usage.output_tokens, 25, "select the winning duplicate");
    if (kind === "workbuddy") assert.equal(plan.original.raw.providerData.usage.outputTokens, 20, "select the first eligible row");

    const copyPath = path.join(root, "copy", path.basename(fixture.filePath));
    await mkdir(path.dirname(copyPath));
    await copyFile(fixture.filePath, copyPath);
    const copyPlan = jsonCopy(await planChanges({ ...args, filePath: copyPath }));
    assert.deepEqual({ ...copyPlan, filePath: "" }, { ...plan, filePath: "" }, "fresh copies select the same source event and IDs");
    const receipts = [];
    for (const ordinal of [1, 2]) {
      const start = Date.now();
      const receipt = await appendChange(plan, ordinal);
      const end = Date.now();
      assert.ok(start <= receipt.startedAtMs && receipt.startedAtMs <= receipt.landedAtMs && receipt.landedAtMs <= end);
      assert.deepEqual([receipt.deltaTotal, receipt.deltaEvents, receipt.deltaSessions], [160, 1, 0]);
      receipts.push(receipt);
      await appendChange(copyPlan, ordinal);
    }
    const afterAppend = await reference(kind, fixture);
    const appendedCounts = { ...expected, total: expected.total + 320, eventCount: 5 };
    assert.deepEqual(counts(afterAppend), appendedCounts);
    assert.deepEqual(await accountSource({ kind, ...fixture }), appendedCounts);
    assert.equal(new Set(receipts.map((receipt) => receipt.identity)).size, 2);
    for (const [index, receipt] of receipts.entries()) {
      const event = afterAppend.find((event) => identity(event) === receipt.identity);
      assert.ok(event);
      assert.deepEqual(event.usage, { total: 160, input: 140, output: 20, cached: 30, reasoning: kind === "claude" ? 0 : 5 });
      assert.equal(event.sessionId, before[0].sessionId);
      assert.equal(event.timestampMs, appendTimeMs + (index + 1) * 1000);
      assert.equal(event.detailMask & 15, 15);
      assert.equal(event.cacheWriteTokens, 10);
      assert.equal(event.cacheWriteKnown, true);
      assert.equal(event.reconciliationGap, 0);
      const price = createEventPricing().estimate(event);
      assert.equal(price.pricedTokens, 160);
      assert.equal(price.unpricedTokens, 0);
      assert.ok(price.totalUsd > 0);
    }
    await assert.rejects(appendChange(plan, 1), /identity already exists/);
    const revisionBytes = await readFile(fixture.filePath);
    const start = Date.now();
    const revised = await reviseChange(plan);
    assert.ok(start <= revised.startedAtMs && revised.startedAtMs <= revised.landedAtMs && revised.landedAtMs <= Date.now());
    assert.deepEqual([revised.deltaTotal, revised.deltaEvents, revised.deltaSessions], [19, 0, 0]);
    assert.equal(revised.identity, identity(before[0]));
    const final = await reference(kind, fixture);
    const finalCounts = { ...appendedCounts, total: expected.total + 339 };
    assert.deepEqual(counts(final), finalCounts);
    assert.deepEqual(await accountSource({ kind, ...fixture }), finalCounts);
    const target = final.find((event) => identity(event) === revised.identity);
    assert.deepEqual(target, { ...before[0], usage: { ...before[0].usage, output: before[0].usage.output + 19, total: before[0].usage.total + 19 } });
    assert.deepEqual(final.filter((event) => identity(event) !== revised.identity), afterAppend.filter((event) => identity(event) !== revised.identity));
    if (kind === "claude" || kind === "workbuddy") {
      const afterBytes = await readFile(fixture.filePath);
      const oldLines = revisionBytes.toString("utf8").split("\r\n");
      const newLines = afterBytes.toString("utf8").split("\r\n");
      assert.deepEqual(newLines.filter((_, index) => index !== plan.original.lineIndex), oldLines.filter((_, index) => index !== plan.original.lineIndex));
      assert.notEqual(newLines[plan.original.lineIndex], oldLines[plan.original.lineIndex]);
      assert.ok(!afterBytes.toString("utf8").endsWith("\n"), "unterminated final line stays unterminated");
    } else {
      sql(fixture.filePath, (db) => {
        const table = kind === "zcode" ? "model_usage" : "session_message";
        const rows = db.prepare(`SELECT * FROM ${table} WHERE id LIKE 'remaining-delivery-%'`).all();
        assert.equal(rows.length, 2);
        for (const row of rows) {
          if (kind === "zcode") {
            assert.equal(row.provider_id, "seed-provider");
            assert.equal(row.status, "completed");
            assert.equal(row.logical_request_id, row.id);
            assert.equal(row.computed_total_tokens, 160);
            assert.equal(row.provider_total_tokens, 160);
            assert.equal(JSON.parse(row.raw_usage_json).total_tokens, 160);
          } else assert.equal(row.time_updated, row.time_created);
        }
      });
    }
    await reviseChange(copyPlan);
    assert.deepEqual(await reference(kind, { ...fixture, filePath: copyPath }), final);
    await assert.rejects(reviseChange(plan), /changed since planning/);
  });
}

for (const totals of ["provider", "none", "null"]) {
  test(`zcode: optional total columns (${totals}) preserve accounting during history correction`, async (t) => {
    const root = await temporary(t);
    const fixture = createRemainingHarnessFixture(root, "zcode", 2);
    sql(fixture.filePath, (db) => {
      db.exec("ALTER TABLE model_usage DROP COLUMN computed_total_tokens");
      if (totals !== "none") {
        db.exec("ALTER TABLE model_usage ADD COLUMN provider_total_tokens INTEGER");
        if (totals === "provider") db.exec("UPDATE model_usage SET provider_total_tokens=input_tokens+output_tokens");
      }
    });
    const plan = await planChanges({ kind: "zcode", ...fixture, runtimeDirectory, appendTimeMs });
    await appendChange(plan, 1);
    await appendChange(plan, 2);
    await reviseChange(plan);
    const expected = { total: 321 + 339, eventCount: 4, sessionCount: 2 };
    assert.deepEqual(await accountSource({ kind: "zcode", ...fixture }), expected);
    assert.deepEqual(counts(await reference("zcode", fixture)), expected);
    if (totals === "null") sql(fixture.filePath, (db) => assert.equal(db.prepare("SELECT provider_total_tokens FROM model_usage WHERE id='event-0'").get().provider_total_tokens, null));
  });
}

test("failed SQLite append rolls back and frozen captures cannot be mutated", async (t) => {
  const root = await temporary(t);
  const fixture = createRemainingHarnessFixture(path.join(root, "source"), "zcode", 1);
  const plan = await planChanges({ kind: "zcode", ...fixture, runtimeDirectory, appendTimeMs });
  sql(fixture.filePath, (db) => db.exec("CREATE TRIGGER reject_append BEFORE INSERT ON model_usage BEGIN SELECT RAISE(ABORT,'fixture insert rejected'); END"));
  await assert.rejects(appendChange(plan, 1), /fixture insert rejected/);
  assert.deepEqual(await accountSource({ kind: "zcode", ...fixture }), { total: 160, eventCount: 1, sessionCount: 1 });
  const frozen = createRemainingHarnessFixture(path.join(root, "capture-20261102"), "claude", 1);
  const before = await readFile(frozen.filePath);
  await assert.rejects(planChanges({ kind: "claude", ...frozen, runtimeDirectory, appendTimeMs }), /frozen capture/);
  assert.deepEqual(await readFile(frozen.filePath), before);
});

test("unsupported detail columns fail while planning, before any source mutation", async (t) => {
  const root = await temporary(t);
  const fixture = createRemainingHarnessFixture(root, "zcode", 1);
  sql(fixture.filePath, (db) => db.exec("ALTER TABLE model_usage DROP COLUMN cache_creation_input_tokens"));
  const before = await readFile(fixture.filePath);
  await assert.rejects(planChanges({ kind: "zcode", ...fixture, runtimeDirectory, appendTimeMs }), /unsupported ZCode token columns/);
  assert.deepEqual(await readFile(fixture.filePath), before);
});

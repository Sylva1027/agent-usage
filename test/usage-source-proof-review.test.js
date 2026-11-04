import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { discoverUsageSources, streamUsageFileEvents } from "../src/usage-core.js";
import {
  captureUsageSourcePrefix,
  UsageSourceProof,
  USAGE_SOURCE_SHA_KIND,
  usageSourceIdentity,
} from "../src/usage-source-proof.js";
import { UsageStore } from "../src/usage-store.js";

const REVIEW_DIRECTORY = path.resolve("output", "source-proof-review");
const FIXED_TIME = 1_700_000_000;
const PAD = `${" ".repeat(70 * 1024)}\n`;
const AT = "2026-11-03T01:00:00.000Z";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const line = (row) => `${JSON.stringify(row)}\n`;

async function fixture(t, label) {
  await mkdir(REVIEW_DIRECTORY, { recursive: true });
  const root = await mkdtemp(path.join(REVIEW_DIRECTORY, `${label}-`));
  t.after(async () => {
    assert.ok(root.startsWith(`${REVIEW_DIRECTORY}${path.sep}`));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

// Raw frames keep the overwrite the same size, beyond both 64 KiB sample windows.
function rawFrame(text) {
  const payload = Buffer.from(text);
  assert.ok(payload.length <= 128 * 1024);
  const header = Buffer.alloc(12);
  header.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0]);
  header.writeUInt32LE(payload.length, 5);
  header.writeUIntLE((payload.length << 3) | 1, 9, 3);
  return Buffer.concat([header, payload]);
}

function usage(total) {
  return {
    total_tokens: total,
    input_tokens: total,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function codexEvent(total, last, timestamp = AT) {
  return line({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: usage(total), last_token_usage: usage(last) } },
  });
}

function dshEvent(total, seq = 1) {
  return line({
    type: "assistant/message",
    seq,
    time: Date.parse(AT) + seq,
    data: {
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: total, totalTokens: total },
    },
  });
}

function codexHeader() {
  return (
    line({
      timestamp: AT,
      type: "session_meta",
      payload: {
        id: "review",
        cwd: "/work/review",
        source: "cli",
        originator: "codex-tui",
      },
    }) + line({ type: "turn_context", payload: { model: "gpt-5.1-codex" } })
  );
}

function dshHeader() {
  return line({
    type: "session",
    version: 4,
    id: "review",
    cwd: "/work/review",
    delegationDepth: 0,
    createdAt: Date.parse(AT),
  });
}

class ShaOnlyProof extends UsageSourceProof {
  async provider() {
    return null;
  }
}

function createStore(options, proof = new ShaOnlyProof()) {
  const store = new UsageStore(options);
  store.sourceProof = proof;
  store.repositoryResolver = (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
  return store;
}

function totals(store) {
  return store.database
    .prepare("SELECT total FROM events ORDER BY timestamp_ms,id")
    .all()
    .map((row) => Number(row.total));
}

function facts(store) {
  return Object.fromEntries(
    ["events", "rate_limit_observations", "quota_usage_sources", "source_files", "usage_source_progress"].map(
      (table) => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}

for (const adapter of ["jsonl", "dsh"]) {
  for (const phase of ["initial", "append"]) {
    test(`SHA ${adapter} ${phase} rejects a same-size middle rewrite and rolls back facts and progress`, async (t) => {
      const root = await fixture(t, `${adapter}-${phase}`);
      const isCodex = adapter === "jsonl";
      const sourcePath = isCodex
        ? path.join(root, ".codex", "sessions", "2026", "11", "03", "rollout-review.jsonl")
        : path.join(root, ".dsh", "sessions", "fixture", "review", "session.v4.jsonl.zstd");
      await mkdir(path.dirname(sourcePath), { recursive: true });
      const encode = isCodex ? (text) => Buffer.from(text) : rawFrame;
      const baseline = encode(
        (isCodex ? codexHeader() : dshHeader()) +
          (phase === "append" ? (isCodex ? codexEvent(100, 100) : dshEvent(100)) : ""),
      );
      const oldRow = isCodex
        ? codexEvent(200, phase === "append" ? 100 : 200, "2026-11-03T01:01:00.000Z")
        : dshEvent(200, 2);
      const newRow = isCodex
        ? codexEvent(900, phase === "append" ? 800 : 900, "2026-11-03T01:01:00.000Z")
        : dshEvent(900, 2);
      const original = Buffer.concat([baseline, encode(PAD), encode(oldRow), encode(PAD)]);
      const replacement = encode(newRow);
      const mutationOffset = baseline.length + encode(PAD).length;
      const staleTotals = phase === "initial" ? [200] : isCodex ? [100, 100] : [100, 200];
      const currentTotals = phase === "initial" ? [900] : isCodex ? [100, 800] : [100, 900];
      assert.equal(replacement.length, encode(oldRow).length);
      assert.ok(mutationOffset > 64 * 1024 && mutationOffset + replacement.length < original.length - 64 * 1024);

      class RacingShaProof extends ShaOnlyProof {
        armed = phase === "initial";
        mutated = false;
        async capture(filePath, offset, expectedInfo, verified, parsed) {
          if (!this.armed) return super.capture(filePath, offset, expectedInfo, verified, parsed);
          assert.deepEqual(totals(store), staleTotals, "the production parser has already inserted the old facts");
          assert.equal(Boolean(verified), phase === "append");
          assert.deepEqual(parsed, { offset: original.length, digest: sha(original) });
          const handle = await open(filePath, "r+");
          try {
            assert.equal(
              (await handle.write(replacement, 0, replacement.length, mutationOffset)).bytesWritten,
              replacement.length,
            );
          } finally {
            await handle.close();
          }
          await utimes(filePath, expectedInfo.atime, expectedInfo.mtime);
          const current = await stat(filePath);
          const rewritten = readFileSync(filePath);
          assert.equal(current.size, expectedInfo.size);
          assert.equal(current.mtimeMs, expectedInfo.mtimeMs);
          assert.equal(usageSourceIdentity(current), usageSourceIdentity(expectedInfo));
          assert.notEqual(sha(original), sha(rewritten));
          assert.deepEqual(original.subarray(0, 64 * 1024), rewritten.subarray(0, 64 * 1024));
          assert.deepEqual(original.subarray(-64 * 1024), rewritten.subarray(-64 * 1024));
          this.mutated = true;
          const collision = current.ctimeMs === expectedInfo.ctimeMs;
          t.diagnostic(
            `natural ctime collision=${collision}; ctimeMs=${expectedInfo.ctimeMs}/${current.ctimeMs}; first/last 64 KiB unchanged`,
          );
          // When the filesystem changes ctime, align only the observer fences to isolate byte-digest rejection.
          const observed = collision ? expectedInfo : { ...expectedInfo, ctimeMs: current.ctimeMs };
          const prior =
            !verified || collision ? verified : { ...verified, info: { ...verified.info, ctimeMs: current.ctimeMs } };
          return super.capture(filePath, offset, observed, prior, parsed);
        }
      }

      const options = { homeDir: root, databaseFile: path.join(root, "usage.sqlite"), env: {}, importDirs: [] };
      const proof = new RacingShaProof();
      const store = createStore(options, proof);
      try {
        await store.open();
        await writeFile(sourcePath, baseline);
        if (phase === "append") {
          await store.sync();
          assert.deepEqual(totals(store), [100]);
          proof.armed = true;
        }
        const source = (await discoverUsageSources(options)).find((candidate) => sourcePath.startsWith(candidate.path));
        assert.ok(source);
        const before = facts(store);
        await writeFile(sourcePath, original);
        await utimes(sourcePath, FIXED_TIME, FIXED_TIME);
        const file = { filePath: sourcePath, source, info: await stat(sourcePath) };
        await assert.rejects(phase === "initial" ? store.replaceFile(file) : store.appendFile(file), (error) => {
          assert.equal(error.code, "LIVE_SOURCE_CHANGED");
          assert.match(error.message, /Source bytes changed after parsing/);
          return true;
        });
        assert.equal(proof.mutated, true);
        assert.deepEqual(facts(store), before);
        assert.equal(store.database.isTransaction, false);
        assert.equal(store.writeTransactionDepth, 0);
        proof.armed = false;
        await store.sync();
        assert.deepEqual(totals(store), currentTotals);
        const saved = store.database
          .prepare("SELECT validation_json FROM usage_source_progress WHERE source_path=?")
          .get(sourcePath);
        assert.equal(JSON.parse(saved.validation_json).kind, USAGE_SOURCE_SHA_KIND);
        const oracle = createStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
        try {
          await oracle.sync();
          assert.deepEqual(totals(store), totals(oracle));
        } finally {
          oracle.close();
        }
      } finally {
        store.close();
      }
    });
  }
}

test("JSONL digest rejects a natural ctime collision and covers bytes beyond its checkpoint", async (t) => {
  const root = await fixture(t, "natural-collision");
  const filePath = path.join(root, "source.jsonl");
  const original = Buffer.from(`${codexHeader()}${PAD}${codexEvent(200, 200)}${PAD}{"partial":1`);
  const tailOffset = original.length - 1;
  let collisions = 0;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await writeFile(filePath, original);
    await utimes(filePath, FIXED_TIME, FIXED_TIME);
    const info = await stat(filePath);
    const hash = createHash("sha256");
    let parsedOffset = 0;
    let checkpoint;
    const events = [];
    await streamUsageFileEvents(
      filePath,
      { kind: "codex", id: "review", label: "Review", path: root },
      (event) => events.push(event),
      {
        endOffset: info.size,
        onProgress: (value) => {
          checkpoint = value;
        },
        onSourceBytes: (bytes) => {
          hash.update(bytes);
          parsedOffset += bytes.length;
        },
        repositoryResolver: (cwd) => ({ key: cwd, path: cwd, kind: "directory" }),
      },
    );
    assert.deepEqual(
      events.map((event) => event.usage.total),
      [200],
    );
    const parsed = { offset: parsedOffset, digest: hash.digest("hex") };
    assert.deepEqual(parsed, { offset: original.length, digest: sha(original) });
    assert.ok(checkpoint.offset < parsed.offset);
    const good = await captureUsageSourcePrefix(filePath, checkpoint.offset, info, null, parsed);
    assert.equal(good.validation.digest, sha(original.subarray(0, checkpoint.offset)));
    const handle = await open(filePath, "r+");
    try {
      await handle.write(Buffer.from("9"), 0, 1, tailOffset);
    } finally {
      await handle.close();
    }
    await utimes(filePath, info.atime, info.mtime);
    const current = await stat(filePath);
    assert.equal(current.size, info.size);
    assert.equal(current.mtimeMs, info.mtimeMs);
    const collision = current.ctimeMs === info.ctimeMs;
    if (collision) {
      collisions += 1;
      t.diagnostic(
        `real ctime collision=${info.ctimeMs}/${current.ctimeMs}; parsed=${parsed.offset}; checkpoint=${checkpoint.offset}`,
      );
    }
    await assert.rejects(captureUsageSourcePrefix(filePath, checkpoint.offset, current, null, parsed), {
      code: "LIVE_SOURCE_CHANGED",
      message: "Source bytes changed after parsing",
    });
    if (collision) break;
  }
  t.diagnostic(`natural collisions observed=${collisions}; digest semantics checked without skipping`);
});

test("DSH reports each complete compressed frame, including one with no checkpoint", async (t) => {
  const root = await fixture(t, "dsh-frames");
  const filePath = path.join(root, "session.v4.jsonl.zstd");
  const event = dshEvent(200);
  const cut = Math.floor(event.length / 2);
  const frames = [rawFrame(dshHeader() + event.slice(0, cut)), rawFrame(event.slice(cut))];
  await writeFile(filePath, Buffer.concat(frames));
  const seen = [];
  const checkpoints = [];
  const events = [];
  const source = { kind: "dsh", id: "review", label: "Review", path: root };
  const options = { repositoryResolver: (cwd) => ({ key: cwd, path: cwd, kind: "directory" }) };
  await streamUsageFileEvents(filePath, source, (value) => events.push(value), {
    ...options,
    onProgress: (value) => checkpoints.push(value),
    onSourceBytes: (bytes) => seen.push(Buffer.from(bytes)),
  });
  assert.deepEqual(seen, frames);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].offset, frames[0].length + frames[1].length);
  const full = [];
  await streamUsageFileEvents(filePath, source, (value) => full.push(value), {
    ...options,
    onSourceBytes: () => assert.fail("the full parser must not emit progress source bytes"),
  });
  assert.deepEqual(events, full);
  assert.deepEqual(
    events.map((value) => value.usage.total),
    [200],
  );
});

test("v1 checkpoints force reparsing present sources while missing source facts survive", async (t) => {
  const root = await fixture(t, "v1-migration");
  const sourcePath = path.join(root, ".codex", "sessions", "rollout-migration.jsonl");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, codexHeader() + codexEvent(200, 200));
  const store = createStore({ homeDir: root, databaseFile: path.join(root, "usage.sqlite"), env: {}, importDirs: [] });
  const downgrade = (staleFacts = false) => {
    const saved = store.database.prepare("SELECT * FROM usage_source_progress WHERE source_path=?").get(sourcePath);
    const validation = JSON.parse(saved.validation_json);
    assert.equal(validation.kind, USAGE_SOURCE_SHA_KIND);
    validation.kind = "sha256-prefix-v1";
    // Restore a historical v1 mismatch after the legacy-write trigger invalidates its cursor.
    if (staleFacts) store.database.prepare("UPDATE events SET total=999 WHERE source_path=?").run(sourcePath);
    store.database
      .prepare("INSERT OR REPLACE INTO usage_source_progress VALUES (?,?,?,?)")
      .run(sourcePath, saved.source_binding, saved.checkpoint_json, JSON.stringify(validation));
  };
  try {
    await store.sync();
    assert.deepEqual(totals(store), [200]);
    downgrade(true);
    const repaired = await store.sync();
    assert.equal(
      repaired.updatedFileCount,
      1,
      JSON.stringify({
        warnings: store.warnings,
        work: store.lastSyncSourceWork,
        progress: store.database
          .prepare("SELECT validation_json FROM usage_source_progress WHERE source_path=?")
          .get(sourcePath),
      }),
    );
    assert.equal(store.lastSyncSourceWork.replacedFiles, 1);
    assert.deepEqual(totals(store), [200]);
    downgrade();
    const previousFacts = store.database.prepare("SELECT * FROM events ORDER BY id").all();
    await rm(sourcePath);
    const missing = await store.sync();
    assert.equal(missing.updatedFileCount, 0);
    assert.deepEqual(store.database.prepare("SELECT * FROM events ORDER BY id").all(), previousFacts);
    assert.ok(store.database.prepare("SELECT 1 FROM source_files WHERE path=?").get(sourcePath));
  } finally {
    store.close();
  }
});

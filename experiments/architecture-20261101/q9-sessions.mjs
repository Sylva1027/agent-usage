import assert from "node:assert/strict";
import { mkdir, readdir, readFile, lstat, unlink, rmdir, utimes, open } from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { BASE, HERE, absent, hashFile, save, sha } from "./q9-benchmark.mjs";

export const CASES = ["codex-existing", "codex-new", "dsh-existing", "dsh-new"];
let owned = [], parents = [], inventoryBefore, activeCell, beforeStartedAtMs;

export function pathsFor(home) {
  return CASES.map((id) => {
    const [kind, location] = id.split("-");
    const root = path.join(home, `.${kind}`, "sessions");
    const directory = kind === "codex" && location === "existing" ? root :
      path.join(root, ...(kind === "dsh" ? ["project"] : []), `q9-${id}`);
    return { id, kind, location, directory, file: path.join(directory, kind === "codex" ? `q9-${id}.jsonl` : "session.v4.jsonl.zstd"),
      ownedDirectory: directory !== root };
  });
}

export function sessionBytes(point, at, tools) {
  const id = `q9-session-${point.id}`;
  if (point.kind === "codex") {
    const meta = { type: "session_meta", timestamp: new Date(at).toISOString(),
      payload: { id, source: "cli", originator: "codex-tui", cwd: "/q9-session" } };
    return Buffer.concat([Buffer.from(JSON.stringify(meta) + "\n"), tools.codexAppendRows({
      cumulative: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 }, nextTimestampMs: at })]);
  }
  const header = [{ type: "session", version: 4, id, cwd: "/q9-session", createdAt: at, delegationDepth: 0 },
    { type: "request/header", seq: 1, time: at, data: { header: { config: { model: "deepseek-flash", provider: "deepseek-account" } } } }];
  return Buffer.concat([zstdCompressSync(Buffer.from(header.map((r) => JSON.stringify(r)).join("\n") + "\n")),
    tools.dshAppendFrame({ nextSequence: 2, nextTimestampMs: at + 1, turn: 1, step: 1 })]);
}

async function inventory(home) {
  const result = [];
  for (const kind of ["codex", "dsh"]) {
    const root = path.join(home, `.${kind}`, "sessions");
    async function walk(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const file = path.join(directory, entry.name), info = await lstat(file);
        assert.ok(!info.isSymbolicLink(), "Source inventory contains a link");
        if (entry.isDirectory()) { result.push({ path: file, directory: true }); await walk(file); }
        else result.push({ path: file, bytes: info.size, mtimeMs: info.mtimeMs, sha256: activeCell.suite === "new" ? await hashFile(file) : undefined });
      }
    }
    await walk(root);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function install(cell, matrix) {
  activeCell = cell;
  const tools = await import("./b2-page-diagnostic.mjs");
  const delivery = await import("./q5-summary-hook.mjs");
  globalThis.__q9Before = async () => {
    beforeStartedAtMs = Date.now();
    inventoryBefore = await inventory(cell.prepared.home);
    await save(path.join(cell.directory, "source-inventory-before.json"), inventoryBefore, true);
  };
  globalThis.__q9Setup = async (_cell, result, checkpoint) => {
    const startedAtMs = Date.now();
    // Clone restores the selected sources first; source checks and directory preparation stay outside delta time.
    result.q9Setup = { startedAtMs, inventoryStartedAtMs: beforeStartedAtMs, fixtureEndedAtMs: result.fixture.endedAtMs, sourceFiles: inventoryBefore.filter((p) => !p.directory).length };
    if (cell.suite === "new") {
      assert.equal(result.q9Setup.sourceFiles, cell.fileCount);
      owned = pathsFor(cell.prepared.home);
      for (const point of owned) {
        await absent(point.file);
        if (point.ownedDirectory) await absent(point.directory);
        const parent = point.ownedDirectory ? path.dirname(point.directory) : point.directory;
        if (!parents.some((p) => p.path === parent)) {
          const info = await lstat(parent); assert.ok(info.isDirectory() && !info.isSymbolicLink());
          parents.push({ path: parent, atimeMs: info.atimeMs, mtimeMs: info.mtimeMs });
        }
        point.bytes = sessionBytes(point, matrix.appendTimeMs, tools);
        point.sha256 = sha(point.bytes);
        if (point.ownedDirectory && point.location === "existing") {
          await mkdir(point.directory); point.createdDirectory = true;
          assert.deepEqual(await readdir(point.directory), []);
        }
      }
      result.q9Setup.ownedPaths = owned.map(({ bytes, ...p }) => ({ ...p, bytes: bytes.length }));
    }
    result.q9Setup.endedAtMs = Date.now(); await checkpoint();
  };
  globalThis.__q9Initial = async (browser, _cell, result, checkpoint) => {
    result.q9Setup.initialOpenEndedAtMs = Date.now();
    result.q9Setup.initialOpenAndCatalogMs = Date.now() - result.first.startedAtMs;
    result.q9Setup.totalSetupMs = Date.now() - beforeStartedAtMs;
    if (cell.proofMode === "native") assert.equal(result.initialStorage.catalog?.ready, 1, "Catalog preparation must complete before deltas");
    await checkpoint();
  };
  globalThis.__q9NewSessions = async (browser, _cell, result, checkpoint) => {
    if (cell.suite !== "new") return;
    result.newSessions = [];
    let expectedTotal = browser.all.total, expectedEvents = browser.all.eventCount;
    for (const point of owned) {
      expectedTotal += point.kind === "codex" ? 1000 : 1900; expectedEvents++;
      const row = { id: point.id, kind: point.kind, location: point.location, file: point.file, bytes: point.bytes.length,
        sha256: point.sha256, expectedTotal, expectedEvents, status: "started" };
      result.newSessions.push(row); await checkpoint();
      let pending;
      try {
        row.sseBefore = await browser.page.evaluate(() => window.__e1Diagnostic.usageSynced);
        assert.equal(Number(String(await browser.page.locator("#totalTokens").getAttribute("title")).replace(/[^0-9]/g, "")),
          expectedTotal - (point.kind === "codex" ? 1000 : 1900));
        pending = browser.page.waitForResponse(async (response) => {
          const url = new URL(response.url());
          if (url.pathname !== "/api/usage" || url.searchParams.get("preset") !== "all") return false;
          try { return (await response.json()).summary?.totals?.total === expectedTotal; } catch { return false; }
        }); void pending.catch(() => {});
        row.startedAtMs = Date.now();
        if (point.ownedDirectory && point.location === "new") {
          await mkdir(point.directory); point.createdDirectory = true;
        }
        const handle = await open(point.file, "wx"); point.createdFile = true;
        try { await handle.writeFile(point.bytes); } finally { await handle.close(); }
        row.landedAtMs = Date.now(); await checkpoint();
        const response = await pending; row.responseAtMs = Date.now(); row.responseStatus = response.status();
        row.cache = response.headers()["x-summary-cache"]; row.body = await response.json();
        assert.equal(row.responseStatus, 200); assert.equal(row.body.summary.totals.total, expectedTotal);
        assert.equal(row.body.summary.eventCount, expectedEvents);
        await tools.painted(browser.page, expectedTotal, 120000);
        const observed = await delivery.readQ5Delivery(browser.page);
        const paint = observed.rows.find((p) => p.kind === "paint" && (p.clock ?? p.at) >= row.landedAtMs &&
          Number(String(p.total).replace(/[^0-9]/g, "")) === expectedTotal);
        assert.ok(paint, "Original page correct-value paint missing");
        row.actualPaintAtMs = paint.clock ?? paint.at;
        row.landingToPaintMs = row.actualPaintAtMs - row.landedAtMs;
        row.createToPaintMs = row.actualPaintAtMs - row.startedAtMs;
        row.sseAfter = await browser.page.evaluate(() => window.__e1Diagnostic.usageSynced);
        row.automaticSseObserved = row.sseAfter > row.sseBefore; assert.equal(row.automaticSseObserved, true);
        row.endedAtMs = Date.now(); row.status = "passed";
      } catch (e) { row.status = "failed"; row.error = { message: e.message, stack: e.stack }; row.endedAtMs = Date.now(); throw e; }
      finally { await checkpoint(); }
    }
    // Continue the unchanged Q6 final-body/storage checks with the observed totals.
    browser.all = { ...browser.all, total: expectedTotal, eventCount: expectedEvents };
  };
}

export async function cleanup() {
  const receipt = [];
  for (const point of [...owned].reverse()) {
    if (point.createdFile) {
      const info = await lstat(point.file).catch((e) => { if (e.code !== "ENOENT") throw e; });
      if (info) {
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
        assert.equal(await hashFile(point.file), point.sha256, "Owned source changed; retain it for inspection");
        await unlink(point.file);
      }
      receipt.push({ path: point.file, removed: true });
    }
    if (point.createdDirectory) {
      const info = await lstat(point.directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
      assert.deepEqual(await readdir(point.directory), [], "Do not remove a nonempty session directory");
      await rmdir(point.directory); receipt.push({ path: point.directory, removed: true });
    }
  }
  for (const p of parents) await utimes(p.path, p.atimeMs / 1000, p.mtimeMs / 1000);
  return receipt;
}

export async function verifyRestored() {
  if (!inventoryBefore) return { checked: false };
  const after = await inventory(activeCell.prepared.home);
  await save(path.join(activeCell.directory, "source-inventory-after.json"), after, true);
  assert.deepEqual(after, inventoryBefore, "Source paths/bytes/mtimes must match the original inventory");
  return { checked: true, identical: true, entries: after.length,
    contentCoverage: activeCell.suite === "new" ? "all fixture source SHA256" : "all source path/size/mtime + both changed source SHA256" };
}

export async function selfcheck() {
  const source = await readFile(path.join(BASE, "versions/q8", HERE, "b2-page-diagnostic.mjs"), "utf8");
  const codex = source.slice(source.indexOf("function codexAppendRows("), source.indexOf("function dshAppendFrame("))
    .replace("Date.now() + 5 * 60 * 60 * 1000", "state.nextTimestampMs - 1000 + 5 * 60 * 60 * 1000");
  const dsh = source.slice(source.indexOf("function dshAppendFrame("), source.indexOf("async function appendAndPaint("));
  const tools = new Function("CODEX_DELTA", "DSH_DELTA", "TOKEN_FIELDS", "zstdCompressSync", `${codex}\n${dsh};return {codexAppendRows,dshAppendFrame};`)
    (1000, 1900, ["total", "input", "cached", "output", "reasoning"], zstdCompressSync);
  const cases = pathsFor("C:/fixture/home"); assert.deepEqual(cases.map((p) => p.id), CASES);
  assert.equal(cases.filter((p) => p.ownedDirectory && p.location === "existing").length, 1);
  assert.equal(cases.find((p) => p.id === "dsh-existing").file.split(path.sep).at(-1), "session.v4.jsonl.zstd");
  for (const point of cases) {
    const bytes = sessionBytes(point, 1793865165000, tools);
    assert.deepEqual(bytes, sessionBytes(point, 1793865165000, tools));
    const rows = (point.kind === "dsh" ? zstdDecompressSync(bytes) : bytes).toString().trim().split("\n").map(JSON.parse);
    assert.equal(rows.filter((r) => r.type === "assistant/message" || r.type === "event_msg").length, 1);
    assert.ok(rows[0].id || rows[0].payload.id);
    assert.equal(point.kind === "codex" ? rows.at(-1).payload.info.total_token_usage.total_tokens : rows.at(-1).data.usage.totalTokens,
      point.kind === "codex" ? 1000 : 1900);
  }
}

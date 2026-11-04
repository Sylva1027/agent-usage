// Run only in an agreed quiet interval: node --max-old-space-size=224 --max-semi-space-size=4 <file> quota-growth-<new-label> [--self-test]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as candidate from "../../src/usage-quota-store.js";
import { USAGE_QUOTA_PROJECTION_TABLE_NAMES } from "../../src/usage-quota-projection.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT = path.join(ROOT, "output/architecture-20261104/q3");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const SAMPLES = 20;
const WINDOWS = [300, 10_080];
const PRESET = { 300: "quota_5h", 10080: "quota_week" };
const resetAt = (minutes) => NOW + (minutes === 300 ? 240 * MINUTE : 6 * DAY);
function sourceHash(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(file, "r");
  try {
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function open(file) {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA journal_mode=WAL; PRAGMA recursive_triggers=OFF; PRAGMA busy_timeout=5000");
  return database;
}

function seed(database, days, density) {
  database.exec(`CREATE TABLE rate_limit_observations (
    source_path TEXT NOT NULL,line_number INTEGER NOT NULL,role TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL,limit_id TEXT NOT NULL,limit_name TEXT,plan_type TEXT,
    window_minutes REAL NOT NULL CHECK(window_minutes>0),resets_at_ms INTEGER NOT NULL,
    used_percent REAL CHECK(used_percent IS NULL OR used_percent BETWEEN 0 AND 100),
    PRIMARY KEY(source_path,line_number,role)) STRICT;
    CREATE INDEX rate_limit_window_lookup_idx ON rate_limit_observations(limit_id,window_minutes,observed_at_ms DESC);
    CREATE INDEX rate_limit_source_line_idx ON rate_limit_observations(source_path,line_number);`);
  database
    .prepare(`WITH RECURSIVE sequence(n) AS (
      VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n+1<?
    ), windows(minutes,anchor,role) AS (VALUES(300,?,'primary'),(10080,?,'secondary')),
    samples AS (SELECT n,minutes,anchor,role,?+n*? observed FROM sequence CROSS JOIN windows)
    INSERT INTO rate_limit_observations
    SELECT 'history-'||minutes,n+1,role,observed,'codex',NULL,NULL,minutes,
      anchor-CAST((anchor-observed-1)/(minutes*${MINUTE}) AS INTEGER)*minutes*${MINUTE},40
    FROM samples`)
    .run(days * density, resetAt(300), resetAt(10_080), NOW - days * DAY, DAY / density);
  for (const minutes of WINDOWS) {
    put(database, "latest", minutes, NOW - MINUTE, resetAt(minutes), 42);
    put(database, "future", minutes, NOW + 3 * MINUTE, resetAt(minutes), 43);
  }
  assert.equal(rawCount(database), days * density * 2 + 4);
}

function put(database, source, minutes, observed, reset = resetAt(minutes), percent = 77) {
  const result = database
    .prepare(`INSERT INTO rate_limit_observations
    (source_path,line_number,role,observed_at_ms,limit_id,window_minutes,resets_at_ms,used_percent)
    VALUES(?,1,?,?, 'codex',?,?,?)`)
    .run(source, minutes === 300 ? "primary" : "secondary", observed, minutes, reset, percent);
  assert.equal(Number(result.changes), 1);
}

function rawCount(database) {
  return Number(database.prepare("SELECT COUNT(*) n FROM rate_limit_observations").get().n);
}

function clone(source, destination) {
  for (const file of [source, destination]) {
    assert.equal(existsSync(file + "-wal"), false, "Clone only closed/checkpointed private databases");
    assert.equal(existsSync(file + "-shm"), false, "No live connection may own a clone");
  }
  copyFileSync(source, destination);
}

function storage(database, file) {
  return {
    mainPages: database.prepare("PRAGMA main.page_count").get().page_count,
    freePages: database.prepare("PRAGMA main.freelist_count").get().freelist_count,
    pageSize: database.prepare("PRAGMA main.page_size").get().page_size,
    tempPages: database.prepare("PRAGMA temp.page_count").get().page_count,
    tempFreePages: database.prepare("PRAGMA temp.freelist_count").get().freelist_count,
    tempPageSize: database.prepare("PRAGMA temp.page_size").get().page_size,
    fileBytes: statSync(file).size,
    walBytes: existsSync(file + "-wal") ? statSync(file + "-wal").size : 0,
    structures: database
      .prepare(`SELECT name,SUM(pgsize) bytes,COUNT(*) pages FROM dbstat GROUP BY name ORDER BY name`)
      .all(),
  };
}

function projectionCounts(database) {
  return Object.fromEntries(
    USAGE_QUOTA_PROJECTION_TABLE_NAMES.map((table) => [
      table,
      Number(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),
    ]),
  );
}

function measure(api, database, asOf) {
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = api.selectStoredQuotaWindows(database, asOf);
  const elapsedMs = performance.now() - started;
  return {
    elapsedMs,
    cpu: process.cpuUsage(cpu),
    work: api.quotaProjectionWork ? { ...api.quotaProjectionWork(database) } : null,
    memorySample: process.memoryUsage(),
    result,
  };
}

function bounded(work, changes, maximum) {
  assert.ok(work, "The candidate must expose its actual projection work");
  assert.equal(work.rebuilt, false, "Ordinary append/clock/reopen must not rebuild all observations");
  assert.notEqual(work.fallback, true, "Ordinary measurements must execute the projection");
  assert.equal(work.changes, changes);
  assert.ok(work.endpoints <= maximum, `Unexpected endpoint traversal: ${JSON.stringify(work)}`);
  assert.ok(work.cycles <= maximum, `Unexpected cycle rebuild: ${JSON.stringify(work)}`);
}

function compareCompleted(left, right, label) {
  if (left === null || right === null) {
    assert.equal(left, right, label);
    return { ambiguous: true, rows: 0, sha256: null };
  }
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  const hash = createHash("sha256");
  let rows = 0;
  try {
    for (;;) {
      const next = a.next();
      const expected = b.next();
      assert.equal(next.done, expected.done, label + ": length");
      if (next.done) break;
      assert.deepEqual(next.value, expected.value, `${label}: row ${rows}`);
      hash.update(JSON.stringify(next.value) + "\n");
      rows += 1;
    }
  } finally {
    a.return?.();
    b.return?.();
  }
  return { ambiguous: false, rows, sha256: hash.digest("hex") };
}

function smallOracle(database, actual, asOf, js) {
  assert.ok(rawCount(database) < 10_000, "Never materialize the large history for the JS oracle");
  const rows = database.prepare("SELECT * FROM rate_limit_observations ORDER BY rowid").all();
  assert.deepEqual(actual, js.selectQuotaWindows(rows, asOf), "Independent frozen JS current/previous oracle");
  for (const minutes of WINDOWS) {
    compareCompleted(
      candidate.iterateStoredQuotaWindows(database, "codex", asOf, minutes),
      js.completedQuotaWindows(rows, "codex", asOf, minutes),
      `Independent JS completed ${minutes}`,
    );
  }
}

function parity(pair, frozen, asOf, { small = false, fullHistory = false, js, reverse = false } = {}) {
  // The reference must really execute frozen Q2 SQL, including on reopen/cache hits.
  pair.q2.database.exec("DELETE FROM usage_quota_window_cache");
  let current, reference;
  if (reverse) {
    reference = measure(frozen, pair.q2.database, asOf);
    current = measure(candidate, pair.q3.database, asOf);
  } else {
    current = measure(candidate, pair.q3.database, asOf);
    reference = measure(frozen, pair.q2.database, asOf);
  }
  assert.deepEqual(current.result, reference.result, "All current/previous fields must match frozen Q2 SQL");
  assert.equal(rawCount(pair.q3.database), rawCount(pair.q2.database));
  const history = {};
  if (fullHistory)
    for (const minutes of WINDOWS) {
      history[minutes] = compareCompleted(
        candidate.iterateStoredQuotaWindows(pair.q3.database, "codex", asOf, minutes),
        frozen.iterateStoredQuotaWindows(pair.q2.database, "codex", asOf, minutes),
        `Frozen SQL completed ${minutes}`,
      );
    }
  if (small) smallOracle(pair.q3.database, current.result, asOf, js);
  return { candidate: current, frozenSqlOracle: reference, history };
}

function reopen(pair) {
  for (const item of Object.values(pair)) {
    item.database.close();
    item.database = open(item.file);
  }
}

function closePair(pair) {
  for (const item of Object.values(pair)) if (item.database.isOpen) item.database.close();
}

function mutateBoth(pair, work) {
  for (const item of Object.values(pair)) work(item.database);
}

function capturePlans(database, work) {
  const prepare = database.prepare;
  const plans = [];
  database.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    for (const method of ["get", "all", "run", "iterate"]) {
      const invoke = statement[method];
      statement[method] = function (...parameters) {
        if (/\b(?:FROM|INTO|UPDATE)\b/i.test(sql)) {
          try {
            plans.push({
              sql,
              method,
              parameters,
              plan: prepare.call(database, "EXPLAIN QUERY PLAN " + sql).all(...parameters),
            });
          } catch (error) {
            plans.push({ sql, method, parameters, error: error.message });
          }
        }
        return invoke.call(this, ...parameters);
      };
    }
    return statement;
  };
  try {
    work();
  } finally {
    database.prepare = prepare;
  }
  return plans;
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  assert.equal(sorted.length, SAMPLES);
  return (sorted[9] + sorted[10]) / 2;
}

async function main() {
  const [label, ...args] = process.argv.slice(2);
  assert.match(label || "", /^quota-growth-[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--self-test"));
  assert.ok(process.execArgv.includes("--max-old-space-size=224"));
  assert.ok(process.execArgv.includes("--max-semi-space-size=4"));
  const directory = path.join(OUTPUT, label);
  mkdirSync(directory); // A label is never reused or overwritten.
  const report = {
    passed: false,
    scope: "quota queries only; synthetic history; no end-to-end capacity claim",
    node: process.version,
    flags: process.execArgv,
    startedAt: new Date().toISOString(),
    label,
    config: {
      days: [365, 730],
      observationsPerDayPerWindow: [24, 240],
      windows: WINDOWS,
      samples: SAMPLES,
      asOf: new Date(NOW).toISOString(),
      parallel: false,
      q2Cache: "forced miss outside selection timer: semantic SQL reference, not reopen speed comparison",
      clocks: "future promotion, stale boundary, 5h reset and weekly reset; separate from append samples",
      historyParity: "every field for every selection; completed rows streamed at each diagnostic stage and sample 0",
      memory: "process snapshots after queries; not a measured peak",
      actualRowsScanned: null,
    },
    cells: [],
    records: [],
  };
  const record = (value) => {
    report.records.push(value);
    appendFileSync(path.join(directory, "measurements.jsonl"), JSON.stringify(value) + "\n");
    console.log(
      JSON.stringify({
        cell: value.cell,
        stage: value.stage,
        sample: value.sample,
        elapsedMs: value.candidate?.elapsedMs,
        work: value.candidate?.work,
      }),
    );
  };
  try {
    const baseline = path.join(OUTPUT, "baseline");
    const hashes = JSON.parse(readFileSync(path.join(OUTPUT, "baseline-hashes.json"), "utf8"));
    for (const [relative, expected] of Object.entries(hashes)) {
      assert.equal(sourceHash(path.join(baseline, relative)), expected, `Frozen Q2 changed: ${relative}`);
    }
    const frozen = await import(pathToFileURL(path.join(baseline, "src/usage-quota-store.js")));
    const core = await import(pathToFileURL(path.join(baseline, "src/usage-core.js")));
    const timeline = await import(pathToFileURL(path.join(baseline, "public/timeline-utils.js")));
    const js = { selectQuotaWindows: core.selectQuotaWindows, completedQuotaWindows: timeline.completedQuotaWindows };
    report.sources = {
      frozenManifest: sourceHash(path.join(OUTPUT, "baseline-hashes.json")),
      candidate: Object.fromEntries(
        [
          "src/usage-quota-store.js",
          "src/usage-quota-projection.js",
          path.relative(ROOT, fileURLToPath(import.meta.url)),
        ].map((file) => [file, sourceHash(path.join(ROOT, file))]),
      ),
    };

    function prepareCell(days, density, small) {
      const name = `${small ? "small-" : ""}${days}d-${density}perday`;
      const cellDirectory = path.join(directory, name);
      mkdirSync(cellDirectory);
      const rawFile = path.join(cellDirectory, "raw.sqlite");
      let database = open(rawFile);
      try {
        seed(database, days, density);
      } finally {
        database.close();
      }
      const cell = {
        name,
        days,
        density,
        small,
        directory: cellDirectory,
        rawSha256: sourceHash(rawFile),
        bases: {},
        summaries: [],
      };
      let initial;
      for (const [variant, api] of [
        ["q2", frozen],
        ["q3", candidate],
      ]) {
        const file = path.join(cellDirectory, `${variant}-base.sqlite`);
        clone(rawFile, file);
        database = open(file);
        try {
          api.ensureUsageQuotaSchema(database);
          const measured = measure(api, database, NOW);
          if (initial) assert.deepEqual(measured.result, initial);
          else initial = measured.result;
          if (small && variant === "q3") smallOracle(database, measured.result, NOW, js);
          cell.bases[variant] = {
            file,
            initialization: measured,
            storage: storage(database, file),
            counts: variant === "q3" ? projectionCounts(database) : null,
          };
        } finally {
          database.close();
        }
        cell.bases[variant].sha256 = sourceHash(file);
      }
      report.cells.push(cell);
      return cell;
    }

    function freshPair(cell) {
      const pair = {};
      try {
        for (const [variant, api] of [
          ["q2", frozen],
          ["q3", candidate],
        ]) {
          const file = path.join(cell.directory, `${variant}-work.sqlite`);
          clone(cell.bases[variant].file, file);
          const database = open(file);
          pair[variant] = { database, file };
          const warm = measure(api, database, NOW);
          assert.deepEqual(warm.result, cell.bases[variant].initialization.result);
          if (variant === "q3") bounded(warm.work, 0, 0);
        }
        return pair;
      } catch (error) {
        closePair(pair);
        throw error;
      }
    }

    function diagnostics(pair, cell, minutes) {
      const options = { small: cell.small, fullHistory: true, js };
      const verify = (stage, asOf = NOW + 1000) => {
        const measured = parity(pair, frozen, asOf, options);
        record({ cell: cell.name, minutes, stage, ...measured });
        return measured;
      };
      mutateBoth(pair, (database) => put(database, "conflict", minutes, NOW + 1000, resetAt(minutes) + 3 * MINUTE));
      assert.equal(verify("same-time-conflict").candidate.result.windows[PRESET[minutes]].state, "ambiguous");
      mutateBoth(pair, (database) =>
        database.prepare("DELETE FROM rate_limit_observations WHERE source_path='conflict'").run(),
      );
      assert.equal(verify("conflict-removed").candidate.result.windows[PRESET[minutes]].state, "available");
      const old = pair.q3.database
        .prepare("SELECT * FROM rate_limit_observations WHERE source_path=? AND line_number=1")
        .get(`history-${minutes}`);
      mutateBoth(pair, (database) =>
        database
          .prepare(`UPDATE rate_limit_observations
        SET observed_at_ms=?,resets_at_ms=? WHERE source_path=? AND line_number=1`)
          .run(NOW - 59 * MINUTE, NOW - 2 * MINUTE, `history-${minutes}`),
      );
      // A late old snapshot overlaps the current cycle. Its propagation cost is deliberately not bounded like append.
      assert.equal(
        verify("old-revision-propagation").candidate.result.previousWindows[PRESET[minutes]].state,
        "ambiguous",
      );
      mutateBoth(pair, (database) =>
        database
          .prepare(`UPDATE rate_limit_observations
        SET observed_at_ms=?,resets_at_ms=? WHERE source_path=? AND line_number=1`)
          .run(old.observed_at_ms, old.resets_at_ms, `history-${minutes}`),
      );
      assert.equal(verify("revision-restored").candidate.result.previousWindows[PRESET[minutes]].state, "available");
      reopen(pair);
      const reused = verify("reopen");
      bounded(reused.candidate.work, 0, 0);
      assert.equal(reused.candidate.work.reused, true);
      for (const [stage, asOf] of [
        ["clock-before-promotion", NOW + 3 * MINUTE - 1],
        ["clock-promotion", NOW + 3 * MINUTE],
        ["clock-stale-boundary", NOW + 13 * MINUTE + 1],
        ["clock-5h-reset", resetAt(300)],
        ["clock-week-reset", resetAt(10_080)],
      ]) {
        const measured = verify(stage, asOf);
        bounded(measured.candidate.work, 0, stage === "clock-promotion" ? 2 : 0);
        if (stage === "clock-promotion") assert.equal(measured.candidate.work.promotedTimes, 2);
      }
      record({
        cell: cell.name,
        minutes,
        stage: "diagnostic-storage",
        q2: storage(pair.q2.database, pair.q2.file),
        q3: storage(pair.q3.database, pair.q3.file),
        projectionCounts: projectionCounts(pair.q3.database),
      });
    }

    function runCell(cell, samples) {
      for (const minutes of WINDOWS) {
        const times = [],
          referenceTimes = [];
        for (let sample = 0; sample < samples; sample += 1) {
          const pair = freshPair(cell);
          try {
            mutateBoth(pair, (database) => put(database, "append", minutes, NOW + 1000));
            const measured = parity(pair, frozen, NOW + 1000, {
              small: cell.small,
              fullHistory: sample === 0,
              js,
              reverse: sample % 2 === 1,
            });
            bounded(measured.candidate.work, 1, 1);
            assert.equal(measured.candidate.result.windows[PRESET[minutes]].usedPercent, 77);
            assert.equal(rawCount(pair.q3.database), cell.days * cell.density * 2 + 5);
            times.push(measured.candidate.elapsedMs);
            referenceTimes.push(measured.frozenSqlOracle.elapsedMs);
            record({ cell: cell.name, minutes, stage: "fixed-one-append", sample, ...measured });
            if (sample === 0) {
              record({
                cell: cell.name,
                minutes,
                stage: "append-storage",
                q2: storage(pair.q2.database, pair.q2.file),
                q3: storage(pair.q3.database, pair.q3.file),
              });
              diagnostics(pair, cell, minutes);
            }
          } finally {
            closePair(pair);
          }
        }
        if (!cell.small)
          cell.summaries.push({
            minutes,
            samples,
            fixedObservation: {
              source: "append",
              line: 1,
              role: minutes === 300 ? "primary" : "secondary",
              observedAtMs: NOW + 1000,
              windowMinutes: minutes,
              resetsAtMs: resetAt(minutes),
              usedPercent: 77,
            },
            rawMs: times,
            frozenSqlReferenceRawMs: referenceTimes,
            medianMs: median(times),
            frozenSqlReferenceMedianMs: median(referenceTimes),
          });
        const pair = freshPair(cell);
        try {
          const plans = {};
          for (const [variant, api] of [
            ["q2", frozen],
            ["q3", candidate],
          ]) {
            put(pair[variant].database, "append", minutes, NOW + 1000);
            plans[variant] = capturePlans(pair[variant].database, () =>
              api.selectStoredQuotaWindows(pair[variant].database, NOW + 1000),
            );
          }
          writeFileSync(
            path.join(cell.directory, `explain-${minutes}.json`),
            JSON.stringify({ timed: false, plans }, null, 2),
          );
        } finally {
          closePair(pair);
        }
      }
      for (const base of Object.values(cell.bases)) assert.equal(sourceHash(base.file), base.sha256);
      assert.equal(sourceHash(path.join(cell.directory, "raw.sqlite")), cell.rawSha256);
    }

    runCell(prepareCell(14, 24, true), 1);
    report.smallIndependentJsOraclePassed = true;
    if (!args.includes("--self-test")) {
      for (const days of [365, 730])
        for (const density of [24, 240]) runCell(prepareCell(days, density, false), SAMPLES);
      for (const days of [365, 730]) {
        const cells = report.cells.filter((cell) => !cell.small && cell.days === days);
        for (const table of ["usage_quota_projection_endpoints", "usage_quota_projection_cycles"]) {
          assert.equal(
            cells[0].bases.q3.counts[table],
            cells[1].bases.q3.counts[table],
            "Density must grow observations without adding periods",
          );
        }
      }
      report.growth = [24, 240].flatMap((density) =>
        WINDOWS.map((minutes) => {
          const find = (days) =>
            report.cells
              .find((cell) => !cell.small && cell.days === days && cell.density === density)
              .summaries.find((summary) => summary.minutes === minutes);
          return {
            density,
            minutes,
            median365Ms: find(365).medianMs,
            median730Ms: find(730).medianMs,
            ratio730To365: find(730).medianMs / find(365).medianMs,
          };
        }),
      );
    }
    for (const [relative, expected] of Object.entries(report.sources.candidate)) {
      assert.equal(sourceHash(path.join(ROOT, relative)), expected, `Runtime changed during diagnosis: ${relative}`);
    }
    report.passed = true;
  } catch (error) {
    report.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    writeFileSync(path.join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n", { flush: true });
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      selfTestOnly: args.includes("--self-test"),
      directory,
      growth: report.growth,
    }),
  );
}

await main();

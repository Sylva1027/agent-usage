import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";

import { parseClaudeSessions } from "../../src/claude-code-usage.js";
import { parseDshSessions } from "../../src/dsh-usage.js";
import { parseSessionFile } from "../../src/usage-core.js";
import { parseWorkbuddySessions } from "../../src/workbuddy-usage.js";
import { generateLineInputs } from "./growth-line-inputs.mjs";

const START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const END_MS = Date.parse("2026-10-30T00:00:00.000Z");
const PROFILES = [
  {
    key: "cx01",
    kind: "codex",
    events: 4,
    rows: 8,
    decodedBytes: 8192,
    sourceBytes: 6200,
    frames: 3,
    compressed: true,
    sessionKey: "session-codex",
    quotaObservations: 10,
  },
  {
    key: "ds01",
    kind: "dsh",
    events: 4,
    rows: 8,
    decodedBytes: 8192,
    sourceBytes: 4096,
    frames: 2,
    compressed: true,
    sessionKey: "session-dsh",
  },
  {
    key: "cl01",
    kind: "claude",
    events: 4,
    rows: 8,
    decodedBytes: 8192,
    sourceBytes: 8192,
    frames: 0,
    compressed: false,
    sessionKey: "session-claude",
  },
  {
    key: "wb01",
    kind: "workbuddy",
    events: 4,
    rows: 8,
    decodedBytes: 8192,
    sourceBytes: 8192,
    frames: 0,
    compressed: false,
    sessionKey: "session-workbuddy",
  },
];

async function withFreshRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "growth-line-inputs-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectedUsage(kind) {
  return {
    input: 10,
    cached: 2,
    output: 5,
    reasoning: kind === "codex" || kind === "workbuddy" ? 1 : 0,
    total: 15,
  };
}

function assertWithinRange(timestampMs, timeRange) {
  assert.ok(timestampMs >= timeRange.startMs && timestampMs <= timeRange.endMs);
}

test("1x/5x/10x rebuilds parse through the formal four-harness parsers", async () => {
  const observations = [];

  for (const scale of [1, 5, 10]) {
    await withFreshRoot(async (root) => {
      const progress = [];
      const result = await generateLineInputs({
        root,
        scale,
        files: PROFILES,
        onProgress: async (fileResult, index, total) => {
          progress.push({ key: fileResult.key, index, total });
        },
      });
      assert.equal(result.files.length, PROFILES.length);
      assert.equal(result.totals.fileCount, PROFILES.length);
      assert.equal(result.time.start, new Date(START_MS).toISOString());
      assert.equal(result.time.end, new Date(END_MS).toISOString());
      assert.deepEqual(
        progress,
        PROFILES.map((profile, index) => ({ key: profile.key, index, total: PROFILES.length })),
      );

      for (const [index, profile] of PROFILES.entries()) {
        const generated = result.files[index];
        assert.equal(generated.rows, profile.rows * scale);
        assert.equal(generated.events, profile.events * scale);
        assert.equal(generated.decodedBytes, profile.decodedBytes * scale);
        assert.equal(generated.sessionKey, profile.sessionKey);
        assert.equal((await stat(generated.path)).size, generated.sourceBytes);
        if (!profile.compressed) assert.equal(generated.sourceBytes, generated.decodedBytes);
      }

      const [codexFile, dshFile, claudeFile, workbuddyFile] = result.files;
      const parsed = [
        await (() => {
          const rateLimits = [];
          return parseSessionFile(
            codexFile.path,
            {
              id: "fixture-codex",
              label: "Codex fixture",
              path: path.join(root, ".codex"),
              kind: "codex",
            },
            { onRateLimit: (observation) => rateLimits.push(observation) },
          ).then((entry) => ({ ...entry, rateLimits, sessions: entry.session ? [entry.session] : [] }));
        })(),
        await parseDshSessions(path.join(root, ".dsh"), {
          id: "fixture-dsh",
          label: "DSH fixture",
          path: path.join(root, ".dsh"),
          kind: "dsh",
        }),
        await parseClaudeSessions(path.join(root, ".claude"), {
          id: "fixture-claude",
          label: "Claude fixture",
          path: path.join(root, ".claude"),
          kind: "claude",
        }),
        await parseWorkbuddySessions(path.join(root, ".workbuddy-ai"), {
          id: "fixture-workbuddy",
          label: "WorkBuddy fixture",
          path: path.join(root, ".workbuddy-ai"),
          kind: "workbuddy",
        }),
      ];
      const events = parsed.flatMap((entry) => entry.events);
      assert.equal(events.length, PROFILES.reduce((sum, profile) => sum + profile.events, 0) * scale);
      assert.equal(events.length, result.totals.events);
      assert.equal(new Set(events.map((event) => event.id)).size, events.length);
      assert.equal(new Set(events.map((event) => event.timestamp)).size, events.length);

      for (const event of events) assert.ok(Date.parse(event.timestamp) >= START_MS && Date.parse(event.timestamp) <= END_MS);
      assert.equal(parsed[0].rateLimits.length, PROFILES[0].quotaObservations * scale);
      assert.equal(new Set(parsed[0].rateLimits.map((observation) => observation.role)).size, 2);
      for (const observation of parsed[0].rateLimits) {
        assert.equal(observation.limitId, "codex");
        assert.equal(observation.usedPercent, 42.5);
        assert.equal(
          observation.resetsAtMs,
          (Math.floor(observation.observedAtMs / 1000) + observation.windowMinutes * 60) * 1000,
        );
      }
      for (const [index, parsedEntry] of parsed.entries()) {
        const profile = PROFILES[index];
        assert.equal(parsedEntry.events.length, profile.events * scale);
        assert.deepEqual(new Set(parsedEntry.sessions.map((session) => session.id)), new Set([profile.sessionKey]));
        for (const event of parsedEntry.events) {
          assert.deepEqual(
            {
              input: event.total.input,
              cached: event.total.cached,
              output: event.total.output,
              reasoning: event.total.reasoning,
              total: event.total.total,
            },
            expectedUsage(profile.kind),
          );
        }
      }

      const workbuddyName = path.basename(workbuddyFile.path);
      assert.match(workbuddyName, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/);
      const workbuddyText = await readFile(workbuddyFile.path, "utf8");
      assert.match(workbuddyText, /"type":"session-meta"/);

      observations.push(result);
    });
  }

  assert.equal(observations[0].files.length, observations[1].files.length);
  assert.equal(observations[0].files.length, observations[2].files.length);
  assert.deepEqual(
    observations.map((result) => result.totals.events),
    [PROFILES.length * PROFILES[0].events, PROFILES.length * PROFILES[0].events * 5, PROFILES.length * PROFILES[0].events * 10],
  );
  assert.deepEqual(
    observations.map((result) => result.totals.quotaObservations),
    [PROFILES[0].quotaObservations, PROFILES[0].quotaObservations * 5, PROFILES[0].quotaObservations * 10],
  );
  // Synthetic 1x is a format/count fixture, not a stand-in for real 1x I/O, compression, or parser performance.
});

test("compressed padding is deterministic and tracks the requested physical ratio", async () => {
  const files = [
    {
      key: "cx02",
      kind: "codex",
      events: 8,
      rows: 32,
      decodedBytes: 131072,
      sourceBytes: 100000,
      frames: 0,
      compressed: true,
      sessionKey: "session-codex-deterministic",
      quotaObservations: 20,
    },
    {
      key: "ds02",
      kind: "dsh",
      events: 8,
      rows: 32,
      decodedBytes: 131072,
      sourceBytes: 60000,
      frames: 4,
      compressed: true,
      sessionKey: "session-dsh-deterministic",
    },
  ];
  const checksums = [];

  for (let run = 0; run < 2; run += 1) {
    await withFreshRoot(async (root) => {
      const result = await generateLineInputs({ root, scale: 1, files });
      assert.equal(result.files[0].frames, 1);
      for (const [index, generated] of result.files.entries()) {
        const distance = Math.abs(generated.sourceBytes / generated.decodedBytes - files[index].sourceBytes / files[index].decodedBytes);
        assert.ok(distance < 0.2, `${generated.key} compression ratio drifted by ${distance.toFixed(3)}`);
      }
      checksums.push(
        await Promise.all(
          result.files.map(async (file) =>
            createHash("sha256")
              .update(await readFile(file.path))
              .digest("hex"),
          ),
        ),
      );
    });
  }

  assert.deepEqual(checksums[0], checksums[1]);
});

test("byte calibration uses ignored fields when a zero-event file has no padding rows", async () => {
  const files = [
    {
      key: "cx00",
      kind: "codex",
      events: 0,
      rows: 2,
      decodedBytes: 24747,
      sourceBytes: 24747,
      frames: 0,
      compressed: false,
      sessionKey: "zero-event-session",
      quotaObservations: 0,
    },
  ];

  await withFreshRoot(async (root) => {
    const result = await generateLineInputs({ root, scale: 1, files });
    assert.equal(result.files[0].rows, 2);
    assert.equal(result.files[0].events, 0);
    assert.equal(result.files[0].decodedBytes, 24747);
    assert.equal(result.files[0].sourceBytes, 24747);
    const text = await readFile(result.files[0].path, "utf8");
    assert.equal(text.trimEnd().split("\n").length, 2);
    assert.match(text, /"synthetic_padding":"[A-Za-z0-9+/]+"/);
    const parsed = await parseSessionFile(result.files[0].path, {
      id: "zero-event-codex-home",
      label: "Codex fixture",
      path: path.join(root, ".codex"),
      kind: "codex",
    });
    assert.equal(parsed, null);
  });
});

test("event identity is unique by source path plus parser event id across shared Codex sessions", async () => {
  const files = ["cx03", "cx04"].map((key) => ({
    key,
    kind: "codex",
    events: 2,
    rows: 8,
    decodedBytes: 4096,
    sourceBytes: 4096,
    frames: 0,
    compressed: false,
    sessionKey: "shared-codex-session",
    quotaObservations: 0,
  }));

  await withFreshRoot(async (root) => {
    const result = await generateLineInputs({ root, scale: 1, files });
    const events = [];
    for (const generated of result.files) {
      const parsed = await parseSessionFile(generated.path, {
        id: "shared-codex-home",
        label: "Codex fixture",
        path: path.join(root, ".codex"),
        kind: "codex",
      });
      for (const event of parsed.events) {
        events.push({
          sourcePath: generated.path,
          eventId: event.id,
          sessionId: event.sessionId,
          timestamp: event.timestamp,
        });
      }
    }

    assert.deepEqual(new Set(events.map((event) => event.sessionId)), new Set(["shared-codex-session"]));
    assert.equal(new Set(events.map((event) => event.eventId)).size, 2);
    assert.equal(events.filter((event) => event.eventId === "shared-codex-session:1").length, 2);
    assert.equal(new Set(events.map((event) => `${event.sourcePath}\0${event.eventId}`)).size, events.length);
    assert.equal(new Set(events.map((event) => event.timestamp)).size, events.length);
  });
});

test("per-file ranges keep shared Codex session fragments disjoint while preserving quotas and totals", async () => {
  const firstRange = {
    startMs: Date.parse("2024-01-01T00:00:00.000Z"),
    endMs: Date.parse("2024-01-11T00:00:00.000Z"),
  };
  const secondRange = {
    startMs: Date.parse("2025-01-01T00:00:00.000Z"),
    endMs: Date.parse("2025-01-11T00:00:00.000Z"),
  };
  const sessionKey = "shared-codex-history";
  const projectKey = "historyRepo";
  const files = [
    {
      key: "cxr1",
      kind: "codex",
      events: 4,
      rows: 9,
      decodedBytes: 4096,
      sourceBytes: 4096,
      frames: 0,
      compressed: false,
      sessionKey,
      projectKey,
      quotaObservations: 6,
      timeRange: firstRange,
    },
    {
      key: "cxr2",
      kind: "codex",
      events: 3,
      rows: 10,
      decodedBytes: 4096,
      sourceBytes: 4096,
      frames: 0,
      compressed: false,
      sessionKey,
      projectKey,
      quotaObservations: 8,
      timeRange: secondRange,
    },
  ];

  await withFreshRoot(async (root) => {
    const result = await generateLineInputs({ root, scale: 1, files });
    assert.deepEqual(result.time, {
      start: new Date(firstRange.startMs).toISOString(),
      end: new Date(secondRange.endMs).toISOString(),
      eventSlots: 7,
    });
    assert.deepEqual(
      {
        events: result.totals.events,
        quotaObservations: result.totals.quotaObservations,
        rows: result.totals.rows,
        decodedBytes: result.totals.decodedBytes,
        sourceBytes: result.totals.sourceBytes,
      },
      { events: 7, quotaObservations: 14, rows: 19, decodedBytes: 8192, sourceBytes: 8192 },
    );

    const parsedSessions = [];
    const parsedEvents = [];
    const eventIdentities = [];
    for (const [index, generated] of result.files.entries()) {
      const timeRange = files[index].timeRange;
      const rateLimits = [];
      const parsed = await parseSessionFile(
        generated.path,
        {
          id: "ranged-codex-home",
          label: "Codex fixture",
          path: path.join(root, ".codex"),
          kind: "codex",
        },
        { onRateLimit: (observation) => rateLimits.push(observation) },
      );
      assert.equal(parsed.events.length, files[index].events);
      assert.equal(rateLimits.length, files[index].quotaObservations);
      for (const observation of rateLimits) assertWithinRange(observation.observedAtMs, timeRange);
      for (const event of parsed.events) {
        assertWithinRange(Date.parse(event.timestamp), timeRange);
        assert.deepEqual(
          {
            input: event.total.input,
            cached: event.total.cached,
            output: event.total.output,
            reasoning: event.total.reasoning,
            total: event.total.total,
          },
          expectedUsage("codex"),
        );
        eventIdentities.push(`${generated.path}\0${event.id}`);
      }
      parsedSessions.push(parsed.session);
      parsedEvents.push(...parsed.events);

      const rows = (await readFile(generated.path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(rows.length, generated.rows);
      for (const row of rows) assertWithinRange(Date.parse(row.timestamp), timeRange);
      const tokenRows = rows.filter((row) => row.payload?.type === "token_count");
      const zeroRows = tokenRows.filter((row) => row.payload.info.last_token_usage.total_tokens === 0);
      assert.equal(zeroRows.length, index === 0 ? 0 : 1);
    }

    assert.deepEqual(new Set(parsedSessions.map((session) => session.id)), new Set([sessionKey]));
    assert.deepEqual(new Set(parsedSessions.map((session) => session.cwd)), new Set(["/synthetic/codex/historyRepo"]));
    assert.equal(parsedEvents.length, result.totals.events);
    assert.equal(new Set(eventIdentities).size, parsedEvents.length);
    assert.equal(parsedEvents.reduce((sum, event) => sum + event.total.input, 0), 70);
    assert.equal(parsedEvents.reduce((sum, event) => sum + event.total.cached, 0), 14);
    assert.equal(parsedEvents.reduce((sum, event) => sum + event.total.output, 0), 35);
    assert.equal(parsedEvents.reduce((sum, event) => sum + event.total.reasoning, 0), 7);
    assert.equal(parsedEvents.reduce((sum, event) => sum + event.total.total, 0), 105);
  });
});

test("explicit file ranges keep usage and quota times independent of unrelated files", async () => {
  const latestRange = {
    startMs: Date.parse("2025-06-01T00:00:00.000Z"),
    endMs: Date.parse("2025-06-10T00:00:00.000Z"),
  };
  const olderRange = {
    startMs: Date.parse("2025-04-01T00:00:00.000Z"),
    endMs: Date.parse("2025-04-15T00:00:00.000Z"),
  };
  const latest = {
    key: "cxnew",
    kind: "codex",
    events: 5,
    rows: 12,
    decodedBytes: 8192,
    sourceBytes: 8192,
    frames: 0,
    compressed: false,
    sessionKey: "latest-session",
    projectKey: "historyRepo",
    quotaObservations: 14,
    timeRange: latestRange,
  };
  const older = {
    key: "cxold",
    kind: "codex",
    events: 7,
    rows: 9,
    decodedBytes: 8192,
    sourceBytes: 8192,
    frames: 0,
    compressed: false,
    sessionKey: "older-session",
    projectKey: "historyRepo",
    quotaObservations: 0,
    timeRange: olderRange,
  };

  async function snapshot(files) {
    let captured;
    await withFreshRoot(async (root) => {
      const result = await generateLineInputs({ root, scale: 1, files });
      const generated = result.files.find((file) => file.key === latest.key);
      const rows = (await readFile(generated.path, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const tokenRows = rows.filter((row) => row.payload?.type === "token_count");
      const eventRows = tokenRows.filter((row) => row.payload.info.last_token_usage.total_tokens !== 0);
      const zeroRows = tokenRows.filter((row) => row.payload.info.last_token_usage.total_tokens === 0);
      const rateLimits = [];
      const parsed = await parseSessionFile(
        generated.path,
        {
          id: "latest-codex-home",
          label: "Codex fixture",
          path: path.join(root, ".codex"),
          kind: "codex",
        },
        { onRateLimit: (observation) => rateLimits.push(observation) },
      );
      captured = {
        prefixTimes: [rows[0].timestamp, rows[0].payload.timestamp, rows[1].timestamp],
        eventTimes: eventRows.map((row) => row.timestamp),
        zeroTimes: zeroRows.map((row) => row.timestamp),
        parsedEventTimes: parsed.events.map((event) => event.timestamp),
        quotaTimes: rateLimits.map((observation) => observation.observedAtMs),
        counts: {
          events: parsed.events.length,
          quotas: rateLimits.length,
          rows: generated.rows,
          decodedBytes: generated.decodedBytes,
          sourceBytes: generated.sourceBytes,
        },
        totals: parsed.events.reduce(
          (sum, event) => ({
            input: sum.input + event.total.input,
            cached: sum.cached + event.total.cached,
            output: sum.output + event.total.output,
            reasoning: sum.reasoning + event.total.reasoning,
            total: sum.total + event.total.total,
          }),
          { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 },
        ),
      };
    });
    return captured;
  }

  const standalone = await snapshot([latest]);
  const withOlderFile = await snapshot([older, latest]);
  assert.deepEqual(withOlderFile, standalone);

  const eventTimes = Array.from({ length: latest.events }, (_, eventIndex) =>
    new Date(
      latestRange.startMs +
        Math.floor(
          ((latestRange.endMs - latestRange.startMs) * eventIndex) /
            (latest.events - 1),
        ),
    ).toISOString(),
  );
  assert.deepEqual(standalone.prefixTimes, [eventTimes[0], eventTimes[0], eventTimes[0]]);
  assert.deepEqual(standalone.eventTimes, eventTimes);
  assert.deepEqual(standalone.zeroTimes, eventTimes.slice(0, 2));
  assert.deepEqual(standalone.parsedEventTimes, eventTimes);
  for (const timestampMs of standalone.quotaTimes) assertWithinRange(timestampMs, latestRange);
  assert.deepEqual(standalone.counts, {
    events: 5,
    quotas: 14,
    rows: 12,
    decodedBytes: 8192,
    sourceBytes: 8192,
  });
  assert.deepEqual(standalone.totals, {
    input: 50,
    cached: 10,
    output: 25,
    reasoning: 5,
    total: 75,
  });
});

test("per-file ranges round-trip through multi-frame zstd DSH inputs", async () => {
  const firstRange = {
    startMs: Date.parse("2023-03-01T00:00:00.000Z"),
    endMs: Date.parse("2023-03-06T00:00:00.000Z"),
  };
  const secondRange = {
    startMs: Date.parse("2023-03-10T00:00:00.000Z"),
    endMs: Date.parse("2023-03-16T00:00:00.000Z"),
  };
  const sessionKey = "shared-dsh-history";
  const files = [
    {
      key: "dsr1",
      kind: "dsh",
      events: 3,
      rows: 7,
      decodedBytes: 4096,
      sourceBytes: 2048,
      frames: 2,
      compressed: true,
      sessionKey,
      timeRange: firstRange,
    },
    {
      key: "dsr2",
      kind: "dsh",
      events: 2,
      rows: 6,
      decodedBytes: 4096,
      sourceBytes: 2560,
      frames: 3,
      compressed: true,
      sessionKey,
      timeRange: secondRange,
    },
  ];

  await withFreshRoot(async (root) => {
    const result = await generateLineInputs({ root, scale: 1, files });
    assert.equal(result.totals.events, 5);
    assert.equal(result.totals.rows, 13);
    assert.equal(result.totals.decodedBytes, 8192);
    assert.equal(result.totals.frames, 5);
    assert.deepEqual(
      result.files.map((file) => file.frames),
      [2, 3],
    );

    for (const [index, generated] of result.files.entries()) {
      const timeRange = files[index].timeRange;
      const rows = zstdDecompressSync(await readFile(generated.path))
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(rows.length, generated.rows);
      assert.equal(rows.filter((row) => row.type === "request/header").length, 1);
      for (const row of rows) {
        const timestampMs = row.time ?? row.createdAt;
        assertWithinRange(timestampMs, timeRange);
      }
    }

    const parsed = await parseDshSessions(path.join(root, ".dsh"), {
      id: "ranged-dsh-home",
      label: "DSH fixture",
      path: path.join(root, ".dsh"),
      kind: "dsh",
    });
    const events = parsed.events;
    assert.equal(events.length, result.totals.events);
    assert.deepEqual(new Set(parsed.sessions.map((session) => session.id)), new Set([sessionKey]));
    assert.equal(new Set(events.map((event) => event.id)).size, events.length);
    assert.deepEqual(
      events.reduce(
        (sum, event) => ({
          input: sum.input + event.total.input,
          cached: sum.cached + event.total.cached,
          output: sum.output + event.total.output,
          reasoning: sum.reasoning + event.total.reasoning,
          total: sum.total + event.total.total,
        }),
        { input: 0, cached: 0, output: 0, reasoning: 0, total: 0 },
      ),
      { input: 50, cached: 10, output: 25, reasoning: 0, total: 75 },
    );
  });
});

test("timeRange rejects unsafe, invalid, or empty ranges while allowing epoch zero", async () => {
  const file = {
    key: "cxrange",
    kind: "codex",
    events: 0,
    rows: 2,
    decodedBytes: 1024,
    sourceBytes: 1024,
    frames: 0,
    compressed: false,
    sessionKey: "range-validation",
    quotaObservations: 0,
  };
  const invalidDateMs = 8_640_000_000_000_001;

  await withFreshRoot(async (root) => {
    for (const timeRange of [
      null,
      { startMs: 0.5, endMs: 1 },
      { startMs: 0, endMs: invalidDateMs },
      { startMs: invalidDateMs, endMs: invalidDateMs + 1 },
      { startMs: 0, endMs: 0 },
      { startMs: 1, endMs: 0 },
    ]) {
      await assert.rejects(
        () => generateLineInputs({ root, scale: 1, files: [{ ...file, timeRange }] }),
        /timeRange/,
      );
    }

    for (const projectKey of ["", "not-safe", "a".repeat(33)]) {
      await assert.rejects(
        () => generateLineInputs({ root, scale: 1, files: [{ ...file, projectKey }] }),
        /projectKey/,
      );
    }

    const epochRange = { startMs: 0, endMs: 1000 };
    const result = await generateLineInputs({
      root,
      scale: 1,
      files: [{ ...file, key: "cxepoch", timeRange: epochRange }],
    });
    assert.deepEqual(result.time, {
      start: "1970-01-01T00:00:00.000Z",
      end: "1970-01-01T00:00:01.000Z",
      eventSlots: 0,
    });
    const rows = (await readFile(result.files[0].path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const row of rows) assertWithinRange(Date.parse(row.timestamp), epochRange);
  });
});

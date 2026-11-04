import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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

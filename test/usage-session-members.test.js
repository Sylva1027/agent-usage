import assert from "node:assert/strict";
import test from "node:test";
import { UsageSessionMembers } from "../src/usage-session-members.js";
import { buildTimelineRows } from "../public/timeline-utils.js";

test("session counters stay exact across shared-budget spill and late sets", () => {
  const members = new UsageSessionMembers(500);
  try {
    const first = members.createSet(),
      second = members.createSet();
    first.add("a").add("a");
    second.add("a");
    assert.equal(members.database, null);
    first.add("b");
    second.add("c");
    assert.ok(members.database);
    first.add("b");
    second.add("a");
    const late = members.createSet();
    late.add("a").add("a");
    assert.deepEqual([first.size, second.size, late.size], [2, 2, 1]);
    assert.equal(members.bytes, 0);
  } finally {
    members.close();
  }
});

test("disk-backed timeline membership preserves exact timeline results", () => {
  const events = Array.from({ length: 100 }, (_, index) => ({
    timestamp: Date.parse("2026-10-01T00:00:00Z") + index * 60000,
    sessionId: `s${index % 17}`,
    model: `m${index % 3}`,
    channel: `c${index % 2}`,
    total: { total: 3, input: 2, cached: 1, output: 1, reasoning: 0 },
  }));
  const members = new UsageSessionMembers(100);
  try {
    const range = { calendarZone: "utc" };
    assert.deepEqual(
      buildTimelineRows(events, range, "hour", { createSessionSet: () => members.createSet() }),
      buildTimelineRows(events, range, "hour"),
    );
  } finally {
    members.close();
  }
});

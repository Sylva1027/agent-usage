import assert from "node:assert/strict";
import test from "node:test";
import { createQuotaSourceTracker, isQuotaUsage } from "../public/quota-usage.js";
import { quotaSourceResolver } from "../src/quota-usage-source.js";

test("quota candidates retain namespaces and reject explicit non-plan sources", () => {
  for (const model of ["gpt-9", "GPT-10-codex", "codex/gpt-6-sol", "openai/gpt-5.1", "o3", "codex-mini-latest"]) {
    assert.equal(isQuotaUsage({ model }), true, model);
    for (const quotaSource of ["api", "external", "credits"]) assert.equal(isQuotaUsage({ model, quotaSource }), false);
  }
  for (const model of [
    "gpt-oss-120b",
    "gpt-anything",
    "deepseek-flash",
    "step-5-preview",
    "provider/gpt-6-sol",
    "codex-auto-review",
  ]) {
    assert.equal(isQuotaUsage({ model }), false, model);
  }
});

test("credits require local availability and exhausted-window evidence, then end at reset or recovery", () => {
  const track = createQuotaSourceTracker();
  const snapshot = (time, used, credits = false) => ({
    timestamp: new Date(time).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        credits: { has_credits: credits },
        primary: { used_percent: used, window_minutes: 300, resets_at: 1000 },
      },
    },
  });
  assert.equal(track(snapshot(100, 100)).quotaSource, "unknown");
  assert.equal(track(snapshot(200, 100, true)).quotaSource, "credits");
  assert.equal(track({ timestamp: new Date(1000000).toISOString() }).quotaSource, "unknown");
  assert.equal(track(snapshot(300, 100, true)).quotaSource, "credits");
  assert.equal(track(snapshot(400, 1, true)).quotaSource, "plan");
});

test("bounded local credits evidence applies across threads without leaking across homes", () => {
  const resolve = quotaSourceResolver([
    { homeId: "h", sessionId: "a", timestampMs: 10, quotaSource: "credits", quotaSourceUntil: 30 },
    { homeId: "h", sessionId: "a", timestampMs: 25, quotaSource: "plan" },
  ]);
  assert.equal(resolve("h", "b", 15), "credits");
  assert.equal(resolve("other", "b", 15), "unknown");
  assert.equal(resolve("h", "b", 25), "unknown");
  assert.equal(resolve("h", "a", 35), "plan");
  assert.equal(resolve("h", "b", 15, "api"), "api");
});

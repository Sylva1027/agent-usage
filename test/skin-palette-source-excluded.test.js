import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  withSourceExcludedState,
  STATE_MATRIX_GROUPS,
  buildFixedMatrixFixtureBindings,
} from "../scripts/skin-palette/capture.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";
import { getPaletteFixtureHash, getTimelineWarningFixtureHash } from "../test-support/skin-palette-fixture.mjs";

const state = STATE_CATALOG.find((entry) => entry.id === "dialog-import-source-excluded");

function createHarness({
  filterStatus = 200,
  restoreStatus = 200,
  initiallyChecked = true,
  delayRestoreBadge = false,
} = {}) {
  const events = [];
  const responseTargets = [];
  const waiters = [];
  let checked = initiallyChecked;
  let badgePresent = !initiallyChecked;
  let dialogOpen = false;
  let releaseRedraw;
  let markRestoreWaitStarted;
  const redrawReady = new Promise((resolve) => {
    releaseRedraw = resolve;
  });
  const restoreWaitStarted = new Promise((resolve) => {
    markRestoreWaitStarted = resolve;
  });

  const dispatch = (url, status) => {
    const response = { url: () => url, status: () => status };
    for (const [index, waiter] of [...waiters.entries()].reverse()) {
      if (!waiter.predicate(response)) continue;
      waiters.splice(index, 1);
      events.push(`response:${new URL(url).search}`);
      waiter.resolve(response);
    }
  };
  const respondToFilterChange = (excludeId, status) => {
    dispatch("http://127.0.0.1/api/other?exclude=home-1", 200);
    dispatch("http://127.0.0.1/api/usage?exclude=another-home", 200);
    const query = excludeId ? `?exclude=${encodeURIComponent(excludeId)}` : "";
    dispatch(`http://127.0.0.1/api/usage${query}`, status);
  };

  const badge = {
    count: async () => (badgePresent ? 1 : 0),
    isVisible: async () => {
      events.push("badge-visible-check");
      return dialogOpen && badgePresent;
    },
  };
  const checkbox = {
    getAttribute: async (name) => (name === "data-source-id" ? "home-1" : null),
    isChecked: async () => checked,
    uncheck: async () => {
      events.push("uncheck");
      checked = false;
      badgePresent = true;
      respondToFilterChange("home-1", filterStatus);
    },
    check: async () => {
      events.push("check");
      checked = true;
      if (!delayRestoreBadge) badgePresent = false;
      respondToFilterChange(null, restoreStatus);
    },
    locator: (selector) => {
      assert.equal(selector, "xpath=ancestor::label[1]");
      return {
        count: async () => 1,
        locator: (childSelector) => {
          assert.equal(childSelector, ".home-excluded");
          return badge;
        },
      };
    },
  };
  const sources = {
    count: async () => 1,
    first: () => checkbox,
    nth: () => checkbox,
  };
  const page = {
    locator: (selector) => {
      assert.equal(selector, "#sourcePicker input[data-source-id]");
      return sources;
    },
    waitForResponse: (predicate, options) => {
      const targetedResponse = { url: () => "http://127.0.0.1/api/usage?exclude=home-1" };
      responseTargets.push({ hasExclude: predicate(targetedResponse), timeout: options.timeout });
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    waitForFunction: async (source, argument, options) => {
      if (typeof source === "string" && source.includes("#sourcePicker .home-excluded")) {
        events.push("ready-check");
        if (!dialogOpen || checked || !badgePresent) throw new Error("排除状态尚未就绪");
        return;
      }
      if (typeof source === "string" && source.includes("#importDialog")) {
        if (dialogOpen) throw new Error("导入弹窗仍打开");
        return;
      }
      assert.equal(typeof source, "function");
      assert.equal(options.timeout, 50);
      events.push("restore-dom-wait-started");
      markRestoreWaitStarted();
      if (delayRestoreBadge && badgePresent) await redrawReady;
      events.push("restore-dom-wait-completed");
      const ready = runInNewContext(`(${source.toString()})(expectedSourceId)`, {
        expectedSourceId: argument,
        document: {
          querySelectorAll: () => [
            {
              checked,
              getAttribute: (name) => (name === "data-source-id" ? "home-1" : null),
              closest: (selector) => {
                assert.equal(selector, "label");
                return {
                  querySelector: (badgeSelector) => {
                    assert.equal(badgeSelector, ".home-excluded");
                    return badgePresent ? {} : null;
                  },
                };
              },
            },
          ],
        },
      });
      if (!ready) throw new Error("来源恢复 DOM 条件未成立");
      return true;
    },
  };
  const trace = { steps: [], restore: [] };
  const step = async (entry, phase) => {
    events.push(`${phase}:${entry.selector}`);
    if (entry.selector === "#addImportButton") dialogOpen = true;
    if (entry.selector === "#cancelImportButton") dialogOpen = false;
    const record = { phase, action: entry.action, selector: entry.selector, ok: true };
    if (phase === "trigger") trace.steps.push(record);
    else trace.restore.push(record);
    return record;
  };
  return {
    page,
    trace,
    step,
    events,
    responseTargets,
    isChecked: () => checked,
    isBadgePresent: () => badgePresent,
    isDialogOpen: () => dialogOpen,
    restoreWaitStarted,
    completeRedraw: () => {
      badgePresent = false;
      releaseRedraw();
    },
    setCheckedForTest: (value) => {
      checked = value;
    },
  };
}

const runLifecycle = (harness, callback) =>
  withSourceExcludedState(
    { page: harness.page, state, stateTimeoutMs: 50, trace: harness.trace, step: harness.step },
    callback,
  );

test("D12-A2 成功：回调仅在排除态运行，原测量结果透传，随后恢复并关闭", async () => {
  const harness = createHarness();
  const measurement = { counts: { pass: 0, fail: 1, unmeasured: 1 }, records: [{ result: "fail" }] };
  const unit = STATE_MATRIX_GROUPS.find((group) => group.id === "S3").units.find(
    (entry) => entry.id === "dialog-import-source-excluded",
  );
  const s3 = STATE_MATRIX_GROUPS.find((group) => group.id === "S3");
  const allUnits = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
  const role = ROLE_CATALOG.find((entry) => entry.id === "status.home-excluded");

  assert.equal(allUnits.length, 45);
  assert.equal(allUnits.length * 2, 90);
  assert.deepEqual(
    s3.units.map((entry) => entry.id),
    [
      "dialog-import-open",
      "dialog-import-source-excluded",
      "dialog-import-error",
      "home-list-reason",
      "home-source-excluded",
    ],
  );
  assert.deepEqual(unit, {
    id: "dialog-import-source-excluded",
    kind: "procedure",
    handler: "source-excluded",
    stateId: "dialog-import-source-excluded",
    clipSelector: "#sourcePicker",
  });
  assert.deepEqual(s3.units[4], {
    id: "home-source-excluded",
    kind: "procedure",
    handler: "home-source-excluded",
    stateId: "home-source-excluded",
    clipSelector: "#homeList",
  });
  assert.deepEqual(s3.units[0], {
    id: "dialog-import-open",
    kind: "catalog",
    stateId: "dialog-import-open",
    clipSelector: "#importDialog",
    importControls: true,
  });
  assert.equal(s3.units[2].id, "dialog-import-error");
  assert.deepEqual(role.states, ["dialog-import-source-excluded"]);
  assert.deepEqual(state.expectedRoleIds, [role.id, "dialog.source-excluded-name", "dialog.source-excluded-path"]);
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups: STATE_MATRIX_GROUPS.map((group) => group.id),
    fixtureHash: getPaletteFixtureHash(),
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  assert.equal(fixtureBindings.S3.fixtureKind, "base");

  const returned = await runLifecycle(harness, async () => {
    harness.events.push("measure-callback");
    assert.equal(harness.isChecked(), false);
    assert.equal(harness.trace.sourceExcluded.filter.checkboxUnchecked, true);
    return measurement;
  });

  assert.strictEqual(returned, measurement);
  assert.equal(harness.isChecked(), true);
  assert.equal(harness.isDialogOpen(), false);
  assert.deepEqual(harness.trace.sourceExcluded.order, [
    "dialog-open",
    "initial-state-read",
    "filter-request-started",
    "filter-response",
    "excluded-state-ready",
    "measurement-callback-started",
    "measurement-callback-completed",
    "excluded-state-confirmed-after-measurement",
    "restore-request-started",
    "restore-response",
    "restore-dom-wait-started",
    "restore-dom-ready",
    "source-restored",
    "dialog-close-started",
    "dialog-closed",
  ]);
  assert.deepEqual(
    harness.responseTargets.map((entry) => entry.hasExclude),
    [true, false],
  );
  assert.deepEqual(harness.events.indexOf("measure-callback") < harness.events.indexOf("check"), true);
  assert.equal(harness.trace.sourceExcluded.initiallyChecked, true);
  assert.equal(harness.trace.sourceExcluded.filter.responseUrl, "http://127.0.0.1/api/usage?exclude=home-1");
  assert.equal(harness.trace.sourceExcluded.restore.responseUrl, "http://127.0.0.1/api/usage");
  assert.equal(harness.trace.sourceExcluded.restore.ok, true);
  assert.equal(harness.trace.sourceExcluded.filter.badgePresent, true);
  assert.equal(harness.trace.sourceExcluded.restore.badgePresent, false);
});

test("D12-A2 callback 异常：保留原错并继续尝试筛选恢复和关闭弹窗", async () => {
  const harness = createHarness({ restoreStatus: 503 });
  const callbackError = new Error("measurement failed");

  await assert.rejects(
    runLifecycle(harness, async () => {
      assert.equal(harness.isChecked(), false);
      throw callbackError;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(callbackError));
      assert.match(error.message, /操作及恢复均失败/);
      return true;
    },
  );
  assert.equal(harness.isChecked(), true);
  assert.equal(harness.isDialogOpen(), false);
  assert.equal(harness.trace.sourceExcluded.restore.responseStatus, 503);
  assert.equal(harness.trace.restore.at(-1).selector, "#cancelImportButton");
  assert.ok(harness.trace.sourceExcluded.restore.errors.some((message) => /HTTP 200.*503/.test(message)));
  assert.equal(harness.trace.sourceExcluded.order.includes("restore-dom-wait-started"), false);
  assert.equal(harness.trace.sourceExcluded.order.includes("source-restored"), false);
});

test("D12-A2 排除响应 500：不调用测量回调，仍恢复筛选并关闭弹窗", async () => {
  const harness = createHarness({ filterStatus: 500 });
  let callbackCalled = false;

  await assert.rejects(
    runLifecycle(harness, async () => (callbackCalled = true)),
    /HTTP 200.*500/,
  );
  assert.equal(callbackCalled, false);
  assert.equal(harness.isChecked(), true);
  assert.equal(harness.isDialogOpen(), false);
  assert.equal(harness.trace.sourceExcluded.filter.responseStatus, 500);
  assert.equal(harness.trace.sourceExcluded.restore.responseStatus, 200);
});

test("D12-A2 callback 成功但恢复响应 500：恢复异常外显且仍关闭弹窗", async () => {
  const harness = createHarness({ restoreStatus: 500 });
  const measurement = { counts: { pass: 1, fail: 0, unmeasured: 0 } };

  await assert.rejects(
    runLifecycle(harness, async () => measurement),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /来源排除恢复失败/);
      assert.match(error.errors[0].message, /HTTP 200.*500/);
      return true;
    },
  );
  assert.equal(harness.isChecked(), true);
  assert.equal(harness.isDialogOpen(), false);
  assert.equal(harness.trace.sourceExcluded.restore.responseStatus, 500);
  assert.equal(harness.trace.restore.at(-1).selector, "#cancelImportButton");
  assert.equal(harness.trace.sourceExcluded.order.includes("restore-dom-wait-started"), false);
  assert.equal(harness.trace.sourceExcluded.order.includes("source-restored"), false);
});

test("D12-A2-R1：HTTP 200 后等待同一来源的 badge 重绘消失才记录恢复", async () => {
  const delayed = createHarness({ delayRestoreBadge: true });
  const measurement = { counts: { pass: 1, fail: 0, unmeasured: 0 } };
  const pending = runLifecycle(delayed, async () => measurement);

  await delayed.restoreWaitStarted;
  assert.equal(delayed.trace.sourceExcluded.restore.responseStatus, 200);
  assert.equal(delayed.isChecked(), true);
  assert.equal(delayed.isBadgePresent(), true);
  assert.equal(delayed.trace.sourceExcluded.order.includes("source-restored"), false);
  assert.equal(delayed.trace.sourceExcluded.order.includes("dialog-close-started"), false);
  delayed.completeRedraw();

  assert.strictEqual(await pending, measurement);
  assert.equal(delayed.isBadgePresent(), false);
  assert.equal(delayed.trace.sourceExcluded.restore.badgePresent, false);
  assert.ok(
    delayed.trace.sourceExcluded.order.indexOf("restore-dom-ready") <
      delayed.trace.sourceExcluded.order.indexOf("source-restored"),
  );
  assert.equal(delayed.isDialogOpen(), false);

  const alreadyChecked = createHarness({ delayRestoreBadge: true });
  const failedCapture = runLifecycle(alreadyChecked, async () => {
    alreadyChecked.setCheckedForTest(true);
    return measurement;
  });
  await alreadyChecked.restoreWaitStarted;
  assert.deepEqual(
    alreadyChecked.responseTargets.map((entry) => entry.hasExclude),
    [true],
  );
  assert.equal(alreadyChecked.isChecked(), true);
  assert.equal(alreadyChecked.isBadgePresent(), true);
  assert.equal(alreadyChecked.trace.sourceExcluded.restore.filterAttempted, false);
  assert.equal(alreadyChecked.trace.sourceExcluded.order.includes("dialog-close-started"), false);
  alreadyChecked.completeRedraw();
  await assert.rejects(failedCapture, /测量回调期间来源排除态发生变化/);
  assert.equal(alreadyChecked.isDialogOpen(), false);
});

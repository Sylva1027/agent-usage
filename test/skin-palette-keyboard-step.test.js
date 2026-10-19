import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  adaptRoleCatalogForMeasurement,
  applyStateStep,
  buildStateBlockers,
  classifyExpectedQuotaErrors,
  createQuotaEvidenceRecorder,
  diffPaletteDeclarations,
  settleStateEvidenceViewport,
  STATE_MATRIX_GROUPS,
} from "../scripts/skin-palette/capture.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";

function fakePage({
  active = "body",
  order = ["other", "addImportButton", "body"],
  tabbable = order.filter((id) => id !== "body"),
  tabError = null,
} = {}) {
  const nodes = new Map(
    ["body", "other", "addImportButton", "pricingSearch"].map((key) => [
      key,
      {
        key,
        id: key === "body" ? "" : key,
        tagName: key === "body" ? "BODY" : key === "pricingSearch" ? "INPUT" : "BUTTON",
        matches(selector) {
          return selector === "body" ? key === "body" : selector === `#${this.id}`;
        },
        getBoundingClientRect() {
          return { width: 100, height: 20 };
        },
      },
    ]),
  );
  let current = nodes.get(active);
  const calls = { tabAttempts: 0, tabTargets: [], directFocus: [] };
  const document = {
    get activeElement() {
      return current;
    },
    querySelectorAll() {
      return tabbable.map((key) => nodes.get(key));
    },
  };
  const page = {
    async evaluate(fn, arg) {
      return runInNewContext(`(${fn.toString()})(arg)`, {
        document,
        arg,
        getComputedStyle: () => ({ visibility: "visible" }),
      });
    },
    keyboard: {
      async press(key) {
        assert.equal(key, "Tab");
        calls.tabAttempts += 1;
        if (tabError) throw tabError;
        current = nodes.get(order[(order.indexOf(current.key) + 1) % order.length]);
        calls.tabTargets.push(current.key);
      },
    },
    async focus(selector, options) {
      calls.directFocus.push({ selector, options });
      current = nodes.get(selector === "body" ? "body" : selector.slice(1));
    },
  };
  return { page, calls, active: () => current.key };
}

function diagnostic(t, fake, result) {
  t.diagnostic(JSON.stringify({ calls: fake.calls, active: fake.active(), result }));
}

test("C3 trigger：未聚焦目标必须通过真实入口的 Tab 成功", async (t) => {
  const fake = fakePage();
  const result = await applyStateStep(
    fake.page,
    { action: "focus", selector: "#addImportButton" },
    { phase: "trigger", stateTimeoutMs: 1234 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.focusStrategy, "tab");
  assert.equal(result.focusPresses, 2);
  assert.equal(result.tabbableCount, 2);
  assert.equal(result.focusBudget, 60);
  assert.deepEqual(fake.calls.tabTargets, ["other", "addImportButton"]);
  assert.deepEqual(fake.calls.directFocus, []);
  diagnostic(t, fake, result);
});

test("C3 trigger：初始已聚焦的输入仍须 Tab 离开并循环命中", async (t) => {
  const fake = fakePage({ active: "pricingSearch", order: ["other", "pricingSearch", "body"] });
  const result = await applyStateStep(
    fake.page,
    { action: "focus", selector: "#pricingSearch" },
    { phase: "trigger", stateTimeoutMs: 1234 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.focusStrategy, "tab");
  assert.equal(result.focusPresses, 3);
  assert.deepEqual(fake.calls.tabTargets, ["body", "other", "pricingSearch"]);
  assert.deepEqual(fake.calls.directFocus, []);
  diagnostic(t, fake, result);
});

test("C3 trigger：不可达时明确失败且禁止 page.focus 回退", async (t) => {
  const fake = fakePage({ order: ["other", "body"] });
  const result = await applyStateStep(
    fake.page,
    { action: "focus", selector: "#addImportButton" },
    { phase: "trigger", stateTimeoutMs: 1234 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.focusStrategy, "tab-unreachable");
  assert.equal(result.focusPresses, 2);
  assert.equal(result.focusBudget, 60);
  assert.match(result.error, /自然 Tab 未命中.*trigger 禁止直接 focus/);
  assert.equal(fake.calls.tabAttempts, 2);
  assert.deepEqual(fake.calls.directFocus, []);
  diagnostic(t, fake, result);
});

test("C3 trigger：Tab 异常保留原错误且不转为 direct 成功", async (t) => {
  const error = new Error("C3 intentional Tab failure");
  const fake = fakePage({ tabError: error });
  const result = await applyStateStep(
    fake.page,
    { action: "focus", selector: "#addImportButton" },
    { phase: "trigger", stateTimeoutMs: 1234 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, error.message);
  assert.equal(result.focusPresses, 1);
  assert.equal(fake.calls.tabAttempts, 1);
  assert.deepEqual(fake.calls.directFocus, []);
  diagnostic(t, fake, result);
});

test("C3 restore：body 已聚焦维持 already，不按 Tab", async (t) => {
  const fake = fakePage();
  const result = await applyStateStep(
    fake.page,
    { action: "focus", selector: "body" },
    { phase: "restore", stateTimeoutMs: 1234 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.focusStrategy, "already");
  assert.equal(fake.calls.tabAttempts, 0);
  assert.deepEqual(fake.calls.directFocus, []);
  diagnostic(t, fake, result);
});

test("C3 restore：body 不在 Tab 圈时维持原 direct 回退", async (t) => {
  const fake = fakePage({ active: "other", order: ["other", "addImportButton"] });
  const result = await applyStateStep(
    fake.page,
    { action: "focus", selector: "body" },
    { phase: "restore", stateTimeoutMs: 1234 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.focusStrategy, "direct");
  assert.equal(fake.calls.tabAttempts, 2);
  assert.deepEqual(fake.calls.directFocus, [{ selector: "body", options: { timeout: 1234 } }]);
  assert.equal(fake.active(), "body");
  diagnostic(t, fake, result);
});

test("C3 默认非 trigger 阶段维持原 already 行为", async (t) => {
  const fake = fakePage({ active: "addImportButton" });
  const result = await applyStateStep(fake.page, { action: "focus", selector: "#addImportButton" });
  assert.equal(result.ok, true);
  assert.equal(result.phase, "step");
  assert.equal(result.focusStrategy, "already");
  assert.equal(fake.calls.tabAttempts, 0);
  assert.deepEqual(fake.calls.directFocus, []);
  diagnostic(t, fake, result);
});

const captureSource = readFileSync(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
const sourceBetween = (start, end) => {
  const begin = captureSource.indexOf(start);
  const finish = captureSource.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin, `Missing private source boundary: ${start}`);
  return captureSource.slice(begin, finish);
};
const catalogSource = [
  sourceBetween("function rewriteCatalogStep(", "const STATE_MATRIX_GROUPS"),
  sourceBetween("const errorCountKeys =", "/** 保留历史 runner 导入名"),
  captureSource.match(/^const STEP_FAILURE_PREFIXES = .*;$/m)[0],
  sourceBetween("async function runStateUnit(", "/** S7 规程一"),
].join("\n");
const hoverUnit = STATE_MATRIX_GROUPS.find((group) => group.id === "S1")?.units.find(
  (unit) => unit.id === "button-hover",
);
assert.ok(hoverUnit, "Missing button-hover matrix unit");

async function runCatalogFixture(
  stateId,
  { entryReady = true, hoverBefore = true, hoverAfter = true, quotaScenario = null, ...focusOptions } = {},
) {
  const fake = fakePage(focusOptions);
  const io = {
    clicks: [],
    hovers: [],
    regions: [],
    scrollTops: 0,
    readyResults: [],
    readyWaits: 0,
    measurements: 0,
    rebaselines: 0,
    declarations: 0,
    screenshots: 0,
  };
  const readiness = stateId === "button-hover" ? [entryReady, hoverBefore, hoverAfter] : [entryReady];
  const stubMeasurement = { records: [], captures: [], diagnostics: {} };
  let quotaCtx;
  let dialogOpen = stateId === "input-focus" && entryReady;
  const focusEvaluate = fake.page.evaluate;
  fake.page.evaluate = async (source, argument) => {
    if (typeof source === "function") return focusEvaluate(source, argument);
    if (source === "catalog-declarations") {
      io.declarations++;
      return { declarations: {} };
    }
    if (source.includes("window.scrollTo(0, 0)")) {
      io.scrollTops++;
      return {};
    }
    if (source.includes("requestAnimationFrame(() => requestAnimationFrame")) return undefined;
    if (source === "catalog-layout" || source === "catalog-paint") return {};
    throw new Error(`Unexpected catalog IO: ${source}`);
  };
  fake.page.hover = async (selector) => {
    io.hovers.push(selector);
  };
  fake.page.click = async (selector) => {
    io.clicks.push(selector);
    if (selector === "#presetButtons .quota-preset-toggle" && quotaScenario) {
      const url = "http://127.0.0.1:12581/api/usage?preset=quota_5h&bucket=quota_30m&view=dashboard";
      const request = { url: () => url, method: () => "GET", frame: () => ({ page: () => fake.page }) };
      quotaCtx.quotaEvidence?.onRequest(request);
      quotaCtx.errors.resourceFailures.push({ url, status: 409 });
      if (quotaScenario === "handler-error") {
        quotaCtx.quotaEvidenceErrors.push({ method: "onResponse", message: "native hook failure" });
        quotaCtx.quotaEvidence = null;
      }
      quotaCtx.quotaEvidence?.onResponse(
        {
          request: () => request,
          url: () => url,
          status: () => 409,
          body: async () =>
            Buffer.from(quotaScenario === "missing-code" ? "{}" : '{"code":"QUOTA_WINDOW_UNAVAILABLE"}'),
        },
        quotaCtx.errors.resourceFailures.length - 1,
      );
      if (quotaScenario === "ambiguous") {
        const second = { ...request };
        quotaCtx.quotaEvidence?.onRequest(second);
        quotaCtx.quotaEvidence?.onResponse({ request: () => second, url: () => url, status: () => 200 }, undefined);
      }
      const text = "Failed to load resource: the server responded with a status of 409 (Conflict)";
      quotaCtx.errors.consoleErrors.push(text);
      quotaCtx.quotaEvidence?.onConsole(
        { text: () => text, location: () => ({ url }) },
        quotaCtx.errors.consoleErrors.length - 1,
      );
      if (quotaScenario === "failed-trigger") throw new Error("quota click failed");
    }
    if (selector === "#updatePricingButton") dialogOpen = true;
    if (selector === "#cancelPricingButton") dialogOpen = false;
  };
  fake.page.screenshot = async (options) => {
    assert.equal(options.fullPage, false);
    io.screenshots++;
    return Buffer.alloc(0); // 调度IO占位，不是PNG/测色或writer证据。
  };
  const runStateUnit = runInNewContext(`${catalogSource}\nrunStateUnit`, {
    STATE_BY_ID: new Map(STATE_CATALOG.map((state) => [state.id, state])),
    ROLE_CATALOG,
    applyStateStep,
    adaptRoleCatalogForMeasurement,
    buildStateBlockers,
    settleStateEvidenceViewport,
    classifyExpectedQuotaErrors: (input) => {
      if (quotaScenario === "classification-error") throw new Error("classification failed");
      return classifyExpectedQuotaErrors(input);
    },
    diffPaletteDeclarations,
    evaluateReady: async () => {
      assert.ok(readiness.length > 0, "不允许额外ready读取掩盖调度变化");
      if (quotaScenario === "early-errors" || quotaScenario === "entry-ready") {
        quotaCtx.errors.resourceFailures.push({ url: "http://127.0.0.1:12581/early", status: 500 });
        quotaCtx.errors.consoleErrors.push("early unrelated console");
      }
      if (quotaScenario === "fault-control") {
        quotaCtx.errors.requestFailed.push({ url: "http://127.0.0.1:12581/api/usage", error: "ERR_FAILED" });
        quotaCtx.errors.consoleErrors.push("Failed to load resource: net::ERR_FAILED");
        quotaCtx.errors.resourceFailures.push({ url: "http://127.0.0.1:12581/other", status: 500 });
      }
      const ready = readiness.shift();
      io.readyResults.push(ready);
      return ready;
    },
    waitStateReady: async () => {
      io.readyWaits++;
      if (quotaScenario === "early-exception") throw new Error("early quota flow exception");
      return { ok: true };
    },
    buildLayoutProbeSource: () => "catalog-layout",
    buildDeclarationsProbeSource: () => "catalog-declarations",
    PAINT_SETTLE_SOURCE: "catalog-paint",
    captureRegionShot: async (_page, selector) => {
      io.regions.push(selector);
      return { ok: true, buffer: Buffer.alloc(0), clip: {} };
    },
    measureBrowserRoles: async (options) => {
      io.measurements++;
      assert.equal(options.stateId, stateId);
      assert.strictEqual(options.roleCatalog, ROLE_CATALOG);
      return stubMeasurement;
    },
    rebaselineToAll: async () => {
      io.rebaselines++;
      io.dialogOpenAtRebaseline = dialogOpen;
      return { ok: true }; // 只验证catalog恢复边界；真实全局复位另有关闭dialog的原逻辑。
    },
  });
  const errors = Object.fromEntries(
    ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"].map((key) => [key, []]),
  );
  quotaCtx = { page: fake.page, errors, quotaEvidenceErrors: [] };
  if (quotaScenario && quotaScenario !== "missing-recorder") {
    quotaCtx.quotaEvidence = createQuotaEvidenceRecorder({ page: fake.page, errors, origin: "http://127.0.0.1:12581" });
    if (quotaScenario === "snapshot-error")
      quotaCtx.quotaEvidence.settleAndSnapshot = async () => {
        throw new Error("snapshot failed");
      };
  }
  if (quotaScenario === "settle-errors") {
    const originalSettle = quotaCtx.quotaEvidence.settleAndSnapshot;
    quotaCtx.quotaEvidence.settleAndSnapshot = async () => {
      const snapshot = await originalSettle();
      errors.resourceFailures.push({ url: "http://127.0.0.1:12581/settle-late", status: 500 });
      errors.consoleErrors.push("late during bounded settlement");
      return snapshot;
    };
  }
  if (quotaScenario === "end-error")
    quotaCtx.quotaEvidence.endWindow = () => {
      throw new Error("end failed");
    };
  const quotaRecorder = quotaCtx.quotaEvidence;
  fake.page.route = async () => {};
  fake.page.unroute = async () => {};
  const unit = stateId === "button-hover" ? hoverUnit : { id: stateId, kind: "catalog", stateId };
  if (quotaScenario === "fault-control") unit.routeFault = "/api/usage";
  const result = await runStateUnit({
    ctx: quotaCtx,
    unit,
    mode: "light",
    skinId: "chatgpt",
    candidate: null,
    expectedPairs: [],
    otherModePairs: [],
    policy: {},
    stateTimeoutMs: 1234,
    baselineTimeoutMs: 1234,
    attempt: 1,
    fixtureHash: null,
  });
  assert.equal(
    io.rebaselines,
    quotaScenario === "early-exception" ? 0 : 1,
    "原流程仍调用全局基准复位，没有跳过后续控制流",
  );
  assert.equal(io.declarations, quotaScenario === "early-exception" ? 0 : 1, "原流程仍执行收尾声明复读");
  if (quotaScenario !== "early-exception") assert.equal(result.trace.declarations.postMatches, true);
  return { ...fake, io, result, stubMeasurement, ctx: quotaCtx, quotaRecorder };
}

function catalogDiagnostic(t, fixture) {
  t.diagnostic(
    JSON.stringify({
      offlineCatalogOnly: true,
      calls: fixture.calls,
      io: fixture.io,
      entryReady: fixture.result.trace.entryReady,
      hoverMeasurement: fixture.result.trace.hoverMeasurement ?? null,
      measurementRetained: fixture.result.measurement === fixture.stubMeasurement,
      steps: fixture.result.trace.steps,
      restore: fixture.result.trace.restore,
      blockers: fixture.result.blockers,
      status: fixture.result.status,
    }),
  );
}

test("C6-A catalog：keyboard入口已ready仍Tab离开再返回", async (t) => {
  const fixture = await runCatalogFixture("keyboard-focus", { active: "addImportButton" });
  assert.equal(fixture.result.status, "captured");
  assert.equal(fixture.result.trace.entryReady, true);
  const focus = fixture.result.trace.steps.find((step) => step.action === "focus");
  assert.equal(focus.focusStrategy, "tab");
  assert.equal(focus.focusPresses, 3);
  assert.deepEqual(fixture.calls.tabTargets, ["body", "other", "addImportButton"]);
  assert.deepEqual(fixture.calls.directFocus, []);
  assert.equal(fixture.result.trace.restore[0].action, "skipped");
  assert.equal(fixture.io.readyWaits, 1);
  assert.equal(fixture.io.measurements, 1);
  assert.equal(fixture.io.scrollTops, 1, "非hover保留原回顶");
  assert.deepEqual(fixture.io.readyResults, [true], "非hover不新增边界检查");
  catalogDiagnostic(t, fixture);
});

test("C6-A catalog：input入口已ready只重建Tab，不重复打开或catalog关闭dialog", async (t) => {
  const fixture = await runCatalogFixture("input-focus", {
    active: "pricingSearch",
    order: ["other", "pricingSearch", "body"],
  });
  assert.equal(fixture.result.status, "captured");
  const skipped = fixture.result.trace.steps[0];
  assert.equal(skipped.action, "skipped");
  assert.equal(skipped.skippedAction, "click");
  assert.equal(skipped.selector, "#updatePricingButton");
  assert.match(skipped.reason, /entry-ready.*非 focus/);
  const focus = fixture.result.trace.steps[1];
  assert.equal(focus.action, "focus");
  assert.equal(focus.focusStrategy, "tab");
  assert.equal(focus.focusPresses, 3);
  assert.deepEqual(fixture.calls.tabTargets, ["body", "other", "pricingSearch"]);
  assert.deepEqual(fixture.calls.directFocus, []);
  assert.deepEqual(fixture.io.clicks, []);
  assert.equal(fixture.result.trace.restore[0].action, "skipped");
  assert.equal(fixture.io.dialogOpenAtRebaseline, true, "catalog未关闭，后续真实全局复位的关闭行为不在此IO stub证明内");
  assert.equal(fixture.io.measurements, 1);
  catalogDiagnostic(t, fixture);
});

test("C6-A catalog：入口ready也不能忽略Tab失败或direct回退", async (t) => {
  const fixture = await runCatalogFixture("keyboard-focus", {
    active: "addImportButton",
    tabError: new Error("C6 intentional Tab failure"),
  });
  assert.equal(fixture.result.trace.entryReady, true);
  assert.equal(fixture.result.status, "failed");
  assert.ok(fixture.result.blockers.some((blocker) => /触发步骤失败.*C6 intentional Tab failure/.test(blocker)));
  assert.equal(fixture.result.trace.steps[0].ok, false);
  assert.equal(fixture.result.trace.steps[0].focusPresses, 1);
  assert.equal(fixture.calls.tabAttempts, 1);
  assert.deepEqual(fixture.calls.directFocus, []);
  assert.equal(fixture.io.measurements, 0);
  assert.equal(fixture.io.readyWaits, 0);
  catalogDiagnostic(t, fixture);
});

test("C6-A catalog：非focus入口ready仍跳过trigger与catalog restore", async (t) => {
  const fixture = await runCatalogFixture("preset-selected");
  assert.equal(fixture.result.status, "captured");
  assert.equal(fixture.result.trace.steps.length, 1);
  assert.equal(fixture.result.trace.steps[0].action, "skipped");
  assert.equal(fixture.result.trace.restore[0].action, "skipped");
  assert.deepEqual(fixture.io.clicks, []);
  assert.equal(fixture.calls.tabAttempts, 0);
  assert.equal(fixture.io.readyWaits, 1);
  assert.equal(fixture.io.measurements, 1);
  catalogDiagnostic(t, fixture);
});

test("C7-B1 catalog：hover保留触发视口并裁真实目标，边界通过仍不证明中途保态", async (t) => {
  const fixture = await runCatalogFixture("button-hover", { entryReady: false });
  assert.equal(fixture.result.status, "captured");
  assert.equal(fixture.io.scrollTops, 0);
  assert.deepEqual(fixture.io.regions, ["#addImportButton"]);
  assert.deepEqual(fixture.io.hovers, ["#addImportButton", "body"], "仅原触发和恢复，不补hover");
  assert.equal(fixture.io.measurements, 1);
  assert.deepEqual(fixture.io.readyResults, [false, true, true]);
  assert.equal(fixture.result.trace.hoverMeasurement.before, true);
  assert.equal(fixture.result.trace.hoverMeasurement.after, true);
  assert.strictEqual(fixture.result.measurement, fixture.stubMeasurement);
  catalogDiagnostic(t, fixture);
});

test("C7-B1 catalog：测量前hover丢失阻断且M3零调用", async (t) => {
  const fixture = await runCatalogFixture("button-hover", { entryReady: false, hoverBefore: false });
  assert.equal(fixture.result.status, "failed");
  assert.equal(fixture.io.measurements, 0);
  assert.equal(fixture.io.scrollTops, 0);
  assert.deepEqual(fixture.io.regions, ["#addImportButton"]);
  assert.deepEqual(fixture.io.readyResults, [false, false]);
  assert.equal(fixture.result.trace.hoverMeasurement.before, false);
  assert.equal(fixture.result.trace.hoverMeasurement.after, null);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.result.measurement)), {
    records: [],
    captures: [],
    diagnostics: {
      candidateId: null,
      mode: "light",
      stateId: "button-hover",
      partial: true,
      counts: { pass: 0, fail: 0, unmeasured: 0, notApplicable: 0 },
      notes: ["悬停在M3前丢失，未执行测量"],
    },
  });
  assert.equal(fixture.result.trace.measurementFailure, undefined, "未执行不能冒充M3抛错");
  t.diagnostic(JSON.stringify({ guardFailureMeasurement: fixture.result.measurement }));
  assert.ok(fixture.result.blockers.some((blocker) => blocker.includes("悬停状态在M3测量前丢失")));
  assert.deepEqual(fixture.io.hovers, ["#addImportButton", "body"]);
  catalogDiagnostic(t, fixture);
});

test("C7-B1 catalog：测量后hover丢失保留已返回测量但单元失败", async (t) => {
  const fixture = await runCatalogFixture("button-hover", { entryReady: false, hoverAfter: false });
  assert.equal(fixture.result.status, "failed");
  assert.equal(fixture.io.measurements, 1);
  assert.strictEqual(fixture.result.measurement, fixture.stubMeasurement);
  assert.deepEqual(fixture.io.readyResults, [false, true, false]);
  assert.equal(fixture.result.trace.hoverMeasurement.before, true);
  assert.equal(fixture.result.trace.hoverMeasurement.after, false);
  assert.ok(fixture.result.blockers.some((blocker) => blocker.includes("悬停状态在M3测量后丢失")));
  assert.deepEqual(fixture.io.hovers, ["#addImportButton", "body"]);
  assert.equal(fixture.io.scrollTops, 0);
  catalogDiagnostic(t, fixture);
});

test("C6-A catalog：focus入口未ready保持完整点击、Tab、catalog恢复", async (t) => {
  const fixture = await runCatalogFixture("input-focus", {
    entryReady: false,
    order: ["other", "pricingSearch", "body"],
  });
  assert.equal(fixture.result.status, "captured");
  assert.equal(fixture.result.trace.entryReady, false);
  assert.deepEqual(
    Array.from(fixture.result.trace.steps, (step) => step.action),
    ["click", "focus"],
  );
  assert.equal(fixture.result.trace.steps[1].focusStrategy, "tab");
  assert.equal(fixture.result.trace.steps[1].focusPresses, 2);
  assert.deepEqual(fixture.calls.tabTargets, ["other", "pricingSearch"]);
  assert.deepEqual(fixture.io.clicks, ["#updatePricingButton", "#cancelPricingButton"]);
  assert.equal(fixture.result.trace.restore[0].selector, "#cancelPricingButton");
  assert.equal(fixture.result.trace.restore[0].ok, true);
  assert.equal(fixture.io.dialogOpenAtRebaseline, false);
  assert.equal(fixture.io.readyWaits, 1);
  assert.equal(fixture.io.measurements, 1);
  catalogDiagnostic(t, fixture);
});

test("C8-C2b：实际quota trigger/restore经记录器+C1，保留raw只移出精确伴生错误", async () => {
  const fixture = await runCatalogFixture("quota-toast", { entryReady: false, quotaScenario: "normal" });
  const { result } = fixture;
  const trace = result.trace.quotaEvidence;
  assert.equal(result.status, "captured");
  assert.equal(result.blockers.length, 0);
  assert.equal(result.errors.resourceFailures.length, 1);
  assert.equal(result.errors.consoleErrors.length, 1);
  assert.equal(trace.started, true);
  assert.equal(trace.windowEnded, true);
  assert.equal(trace.snapshot.responses[0].bodyCode, "QUOTA_WINDOW_UNAVAILABLE");
  assert.ok(trace.snapshot.responses[0].bodyText);
  assert.ok(trace.snapshot.responses[0].bodySha256);
  assert.equal(trace.expectedErrors.resourceFailures.length, 1);
  assert.equal(trace.expectedErrors.consoleErrors.length, 1);
  assert.equal(trace.matches.length, 2);
  assert.equal(trace.matches[1].binding, "INFERRED_UNIQUE");
  assert.equal(trace.indexTranslation.offsets.resourceFailures, 0);
  assert.deepEqual(fixture.io.clicks, [
    "#presetButtons .quota-preset-toggle",
    '#presetButtons button[data-preset="today"]',
  ]);
});

test("C8-C2b：unit入口到begin之间错误偏移准确，早期错误继续阻断", async () => {
  const { result } = await runCatalogFixture("quota-toast", { entryReady: false, quotaScenario: "early-errors" });
  const trace = result.trace.quotaEvidence;
  assert.equal(result.status, "failed");
  assert.equal(result.errors.resourceFailures.length, 2);
  assert.equal(result.errors.consoleErrors.length, 2);
  assert.equal(trace.indexTranslation.unitErrorStart.resourceFailures, 0);
  assert.equal(trace.indexTranslation.recorderBegin.resourceFailures, 1);
  assert.equal(trace.indexTranslation.offsets.resourceFailures, 1);
  assert.equal(trace.indexTranslation.offsets.consoleErrors, 1);
  assert.equal(trace.snapshot.responses[0].resourceFailureIndex, 0, "原snapshot不平移改写");
  assert.equal(trace.snapshot.consoles[0].index, 0);
  assert.equal(trace.translatedIndexes.responses[0].resourceFailureIndex, 1);
  assert.equal(trace.translatedIndexes.consoles[0].index, 1);
  assert.equal(trace.matches[0].resourceFailureIndex, 1);
  assert.equal(trace.matches[1].consoleErrorIndex, 1);
  assert.ok(result.blockers.some((entry) => entry.includes("early unrelated console")));
  assert.ok(result.blockers.some((entry) => entry.includes("/early")));
  assert.ok(!result.blockers.some((entry) => entry.includes("quota_5h")), "只剩早期错误；quota原件仍在payload.errors");
});

test("C8-C2b：trigger失败/缺记录器/缺code/歧义及采集分类异常都保留原阻断", async (t) => {
  for (const scenario of [
    "failed-trigger",
    "missing-recorder",
    "missing-code",
    "ambiguous",
    "snapshot-error",
    "handler-error",
    "classification-error",
    "end-error",
  ])
    await t.test(scenario, async () => {
      const { result, ctx } = await runCatalogFixture("quota-toast", { entryReady: false, quotaScenario: scenario });
      assert.equal(result.status, "failed");
      assert.equal(result.errors.resourceFailures.length, 1);
      assert.equal(result.errors.consoleErrors.length, 1);
      assert.ok(result.blockers.some((entry) => entry.includes("409")));
      assert.equal(result.trace.quotaEvidence.expectedErrors?.resourceFailures.length ?? 0, 0);
      if (
        ["missing-recorder", "snapshot-error", "handler-error", "classification-error", "end-error"].includes(scenario)
      ) {
        assert.equal(ctx.quotaEvidence, null);
        assert.ok(result.trace.quotaEvidence.errors.length > 0);
      }
      if (scenario === "failed-trigger")
        assert.equal(result.trace.quotaEvidence.snapshot.scope.triggerSucceeded, false);
    });
});

test("C8-C2b：entryReady没有实际click不建窗口、不豁免入口期间原错误", async () => {
  const fixture = await runCatalogFixture("quota-toast", { entryReady: true, quotaScenario: "entry-ready" });
  assert.equal(fixture.result.trace.quotaEvidence.started, false);
  assert.equal(fixture.io.clicks.length, 0);
  assert.equal(fixture.result.status, "failed");
  assert.equal(fixture.result.errors.resourceFailures.length, 1);
  assert.equal(fixture.result.trace.quotaEvidence.expectedErrors, undefined);
  await assert.rejects(fixture.quotaRecorder.settleAndSnapshot(), /begin/);
});

test("C8-C2b：提前流程异常finally关闭窗口，下一窗口没有旧response移植", async () => {
  const fixture = await runCatalogFixture("quota-toast", { entryReady: false, quotaScenario: "early-exception" });
  assert.equal(fixture.result.status, "failed");
  assert.ok(fixture.result.blockers.some((entry) => entry.includes("early quota flow exception")));
  const old = fixture.result.trace.quotaEvidence.snapshot;
  assert.equal(fixture.result.trace.quotaEvidence.windowEnded, true);
  assert.ok(Number.isSafeInteger(old.scope.endOrder));
  fixture.quotaRecorder.begin({ mode: "light", attempt: 2, unitId: "quota-toast", stateId: "quota-toast" });
  fixture.quotaRecorder.endWindow();
  const next = await fixture.quotaRecorder.settleAndSnapshot();
  assert.notEqual(next.scope.id, old.scope.id);
  assert.equal(next.responses.length, 0);
});

test("C8-C2b：非quota原fault分支仍只分类注入噪声，其它HTTP故障阻断", async () => {
  const { result } = await runCatalogFixture("autorefresh-error", { entryReady: true, quotaScenario: "fault-control" });
  assert.equal(result.status, "failed");
  assert.equal(result.trace.quotaEvidence, undefined);
  assert.equal(result.trace.faultInducedErrors.requestFailed.length, 1);
  assert.equal(result.trace.faultInducedErrors.consoleErrors.length, 1);
  assert.equal(result.errors.requestFailed.length, 1);
  assert.equal(result.errors.consoleErrors.length, 1);
  assert.ok(result.blockers.some((entry) => entry.includes("500")));
  assert.ok(!result.blockers.some((entry) => entry.includes("ERR_FAILED")));
});

test("C8-C2b：有界snapshot等待期间出现的原错误仍进入最终delta并阻断", async () => {
  const { result } = await runCatalogFixture("quota-toast", { entryReady: false, quotaScenario: "settle-errors" });
  assert.equal(result.status, "failed");
  assert.equal(result.errors.resourceFailures.length, 2);
  assert.equal(result.errors.consoleErrors.length, 2);
  assert.equal(result.trace.quotaEvidence.expectedErrors.resourceFailures.length, 1);
  assert.ok(result.blockers.some((entry) => entry.includes("settle-late")));
  assert.ok(result.blockers.some((entry) => entry.includes("late during bounded settlement")));
});

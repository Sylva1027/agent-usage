import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  captureHomeSourceExcludedEvidence,
  readHomeSourceBinding,
  withHomeSourceExcludedState,
} from "../scripts/skin-palette/capture.mjs";
import { ROLE_CATALOG } from "../scripts/skin-palette/roles.mjs";

function createPage({ sources, homes, dialogVisible = false }) {
  const sideEffects = [];
  const nodes = [];
  const makeLocator = (items) => {
    const one = () => {
      if (items.length !== 1) throw new Error(`expected one fake locator, got ${items.length}`);
      return items[0];
    };
    const locator = {
      count: async () => items.length,
      first: () => makeLocator(items.slice(0, 1)),
      nth: (index) => makeLocator(items.slice(index, index + 1)),
      getAttribute: async (name) => one().attributes?.[name] ?? null,
      isChecked: async () => Boolean(one().checked),
      isVisible: async () => Boolean(one().visible),
      locator: (selector) => {
        const item = one();
        if (item.kind === "checkbox" && selector === "xpath=ancestor::label[1]") return makeLocator([item.option]);
        if (item.kind === "option" && selector === ".source-option-path") return makeLocator(item.paths);
        if (item.kind === "option" && selector === ".home-excluded") return makeLocator(item.badges);
        if (item.kind === "home-row" && selector === ":scope > .home-path") return makeLocator(item.paths);
        if (item.kind === "home-row" && selector === ":scope > .home-label > strong") {
          return makeLocator(item.names);
        }
        throw new Error(`unexpected fake locator selector: ${selector}`);
      },
      click: () => sideEffects.push("click"),
      check: async (...args) => {
        sideEffects.push("check");
        await one().onCheck?.(...args);
      },
      uncheck: async (...args) => {
        sideEffects.push("uncheck");
        await one().onUncheck?.(...args);
      },
      fill: () => sideEffects.push("fill"),
      scrollIntoViewIfNeeded: () => sideEffects.push("scroll"),
    };
    nodes.push(locator);
    return locator;
  };
  const sourceNodes = sources.map((source) => {
    const option = {
      kind: "option",
      attributes: { class: "source-option" },
      paths: (source.paths ?? [{ title: source.path }]).map((title) => ({
        kind: "path",
        attributes: typeof title === "object" ? title : { title },
      })),
      badges: source.badge ? [{ kind: "badge", visible: source.badgeVisible ?? true }] : [],
    };
    return {
      kind: "checkbox",
      attributes: { "data-source-id": source.id ?? null },
      checked: source.checked ?? true,
      option,
    };
  });
  const homeNodes = homes.map((home) => ({
    kind: "home-row",
    attributes: { class: home.excluded ? "home-row excluded" : "home-row" },
    visible: home.visible ?? true,
    paths: (home.paths ?? [{ title: home.path }]).map((title) => ({
      kind: "path",
      attributes: typeof title === "object" ? title : { title },
    })),
    names: Array.from({ length: home.nameCount ?? 1 }, () => ({ kind: "name" })),
  }));
  const dialog = { kind: "dialog", visible: dialogVisible, attributes: { hidden: dialogVisible ? null : "" } };
  Object.defineProperty(dialog, "hidden", { get: () => dialog.attributes.hidden !== null });
  const page = {
    locator: (selector) => {
      if (selector === "#sourcePicker input[data-source-id]") {
        return makeLocator(sourceNodes.filter((source) => source.attributes["data-source-id"] !== null));
      }
      if (selector === "#sourcePicker input[type=checkbox]") return makeLocator(sourceNodes);
      if (selector === "#sourcePicker .source-option-path[title]") {
        return makeLocator(
          sourceNodes.flatMap((source) =>
            source.option.paths.filter((path) => Object.hasOwn(path.attributes, "title")),
          ),
        );
      }
      if (selector === "#homeList > .home-row") return makeLocator(homeNodes);
      if (selector === "#homeList > .home-row.excluded") {
        return makeLocator(homeNodes.filter((home) => home.attributes.class.split(/\s+/).includes("excluded")));
      }
      if (selector === "#importDialog") return makeLocator([dialog]);
      throw new Error(`unexpected fake page selector: ${selector}`);
    },
    evaluate: () => sideEffects.push("evaluate"),
    waitForFunction: () => sideEffects.push("waitForFunction"),
    waitForResponse: () => sideEffects.push("waitForResponse"),
  };
  return { page, sideEffects, nodes, sourceNodes, homeNodes, dialog };
}

const escapedPath = String.raw`E:\Profiles\O'Neil & <logs>\"Codex"`;

function validFixture(overrides = {}) {
  return createPage({
    sources: [
      { id: 'runtime:home/α"1', path: escapedPath, checked: false, badge: true },
      { id: "other-home", path: "C:\\other", checked: false },
      { id: null, path: "C:\\missing-id", checked: false },
      { id: "enabled-home", path: "C:\\enabled", checked: true },
    ],
    homes: [
      { path: escapedPath, excluded: true, nameCount: 1 },
      { path: "C:\\other", excluded: true, nameCount: 1 },
      { paths: [{}], excluded: true },
      { path: "C:\\enabled", excluded: false },
    ],
    ...overrides,
  });
}

function createHomeLifecycleHarness({
  filterStatus = 200,
  restoreStatus = 200,
  otherExcluded = false,
  dialogVisible = false,
  restoreActionThrows,
  failFilterCheckboxLookup = false,
} = {}) {
  const sourceId = "runtime-home-source";
  const path = String.raw`C:\Users\test\source-home`;
  const otherPath = String.raw`C:\Users\test\other-home`;
  const events = [];
  const waiters = [];
  const fixture = createPage({
    sources: [
      { id: sourceId, path, checked: true },
      { id: "other-source", path: otherPath, checked: !otherExcluded, badge: otherExcluded },
    ],
    homes: [
      { path, excluded: false },
      { path: otherPath, excluded: otherExcluded },
    ],
    dialogVisible,
  });
  if (failFilterCheckboxLookup) {
    const originalLocator = fixture.page.locator;
    let sourceLookupCount = 0;
    fixture.page.locator = (selector) => {
      if (selector === "#sourcePicker input[data-source-id]" && ++sourceLookupCount === 4) {
        throw new Error("injected filter checkbox lookup failure");
      }
      return originalLocator(selector);
    };
  }
  const [targetSource, otherSource] = fixture.sourceNodes;
  const [targetHome] = fixture.homeNodes;
  const dialog = fixture.dialog;
  const dispatch = (url, status) => {
    const response = { url: () => url, status: () => status };
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(response)) continue;
      waiters.splice(index, 1);
      events.push(`response:${new URL(url).search || "no-exclude"}:${status}`);
      waiter.resolve(response);
    }
  };
  const setExcluded = (excluded) => {
    targetSource.checked = !excluded;
    targetSource.option.badges = excluded ? [{ kind: "badge", visible: true }] : [];
    targetHome.attributes.class = excluded ? "home-row excluded" : "home-row";
  };
  targetSource.onUncheck = () => {
    events.push("checkbox-uncheck:target");
    setExcluded(true);
    dispatch(`http://127.0.0.1/api/usage?exclude=${encodeURIComponent(sourceId)}`, filterStatus);
  };
  targetSource.onCheck = () => {
    events.push("checkbox-check:target");
    setExcluded(false);
    dispatch("http://127.0.0.1/api/usage", restoreStatus);
    if (restoreActionThrows) throw restoreActionThrows.value;
  };
  otherSource.onCheck = () => events.push("checkbox-check:other");
  otherSource.onUncheck = () => events.push("checkbox-uncheck:other");

  const readySelector = "#homeList .home-row.excluded > .home-label > strong";
  const state = {
    id: "home-source-excluded",
    ready: { kind: "visible", selector: readySelector },
    restore: [{ action: "click", selector: "#cancelImportButton" }],
  };
  const document = {
    querySelector(selector) {
      if (selector === "#importDialog") return dialog;
      if (selector === readySelector) {
        const excluded = targetHome.attributes.class.split(/\s+/).includes("excluded");
        return dialog.hidden && excluded ? { getBoundingClientRect: () => ({ width: 1, height: 1 }) } : null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== "#homeList > .home-row") return [];
      return fixture.homeNodes.map((home) => ({
        querySelectorAll: (childSelector) =>
          childSelector === ":scope > .home-path"
            ? home.paths.map((node) => ({ getAttribute: (name) => node.attributes[name] ?? null }))
            : [],
        classList: {
          contains: (className) => home.attributes.class.split(/\s+/).includes(className),
        },
      }));
    },
  };
  fixture.page.waitForResponse = (predicate, options) => {
    events.push(`wait-response:${options.timeout}`);
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };
  fixture.page.waitForFunction = async (source, argument, options) => {
    events.push(`wait-function:${options.timeout}`);
    const result =
      typeof source === "function"
        ? runInNewContext(`(${source.toString()})(argument)`, {
            argument,
            document,
            getComputedStyle: () => ({ visibility: "visible" }),
          })
        : runInNewContext(source, { document, getComputedStyle: () => ({ visibility: "visible" }) });
    if (!result) throw new Error("fake wait condition was false");
    return true;
  };
  const step = async (entry, phase) => {
    events.push(`step:${phase}:${entry.selector}`);
    if (entry.selector === "#addImportButton") dialog.attributes.hidden = null;
    else if (entry.selector === "#cancelImportButton") dialog.attributes.hidden = "";
    else return { ok: false, error: `unexpected selector ${entry.selector}` };
    return { phase, action: entry.action, selector: entry.selector, ok: true };
  };
  const trace = {};
  return {
    ...fixture,
    events,
    sourceId,
    path,
    state,
    step,
    trace,
    run: (callback) =>
      withHomeSourceExcludedState({ page: fixture.page, state, stateTimeoutMs: 50, trace, step }, callback),
    addDriftedHomePath: (nextPath) => {
      targetSource.option.paths[0].attributes.title = nextPath;
      fixture.homeNodes.push({
        kind: "home-row",
        attributes: { class: "home-row" },
        visible: true,
        paths: [{ kind: "path", attributes: { title: nextPath } }],
        names: [{ kind: "name" }],
      });
    },
    sourceChecked: () => targetSource.checked,
    otherSourceChecked: () => otherSource.checked,
    dialogHidden: () => dialog.hidden,
    targetHomeExcluded: () => targetHome.attributes.class.split(/\s+/).includes("excluded"),
  };
}

function prepareHomeEvidenceHarness(harness, measureRoles) {
  const unit = {
    id: "home-source-excluded",
    stateId: "home-source-excluded",
    clipSelector: "#homeList",
  };
  const candidate = { id: "candidate-a7-3" };
  const policy = { marker: "same-policy" };
  const evidence = { measurement: null, geometry: null, shots: {} };
  harness.page.evaluate = async (source) => {
    if (typeof source === "function") {
      const body = source.toString();
      if (body.includes("scrollIntoView")) {
        harness.events.push("scroll:homeList");
        return true;
      }
      if (body.includes("getBoundingClientRect")) return { x: 8, y: 12, width: 120, height: 64 };
      if (body.includes("window.innerWidth")) return { width: 1280, height: 720 };
    }
    if (typeof source === "string" && source.includes("const firstMetric")) return { documentHeight: 1440 };
    return undefined;
  };
  harness.page.screenshot = async ({ clip } = {}) => {
    harness.events.push(clip ? "screenshot:region" : "screenshot:state");
    return Buffer.from(clip ? "home-region" : "home-state");
  };
  const run = () =>
    withHomeSourceExcludedState(
      {
        page: harness.page,
        state: harness.state,
        stateTimeoutMs: 50,
        trace: harness.trace,
        step: harness.step,
      },
      () =>
        captureHomeSourceExcludedEvidence({
          page: harness.page,
          unit,
          mode: "light",
          skinId: "chatgpt",
          candidate,
          policy,
          trace: harness.trace,
          evidence,
          measureRoles,
        }),
    );
  return { candidate, evidence, policy, run, unit };
}

test("A7-1: 用运行时 ID 和未裁切原始路径唯一绑定主页行，并读取全部排除项", async () => {
  const harness = validFixture();
  const binding = await readHomeSourceBinding(harness.page, 'runtime:home/α"1');

  assert.deepEqual(binding, {
    sourceId: 'runtime:home/α"1',
    path: escapedPath,
    checked: false,
    dialogHidden: true,
    sourceBadgePresent: true,
    sourceBadgeVisible: true,
    homeExcluded: true,
    homeVisible: true,
    targetNameCount: 1,
    targetPathCount: 1,
    excludedSourceIds: ['runtime:home/α"1', "other-home", null],
    excludedHomePaths: [escapedPath, "C:\\other", null],
  });
  assert.deepEqual(harness.sideEffects, [], "读取不得点击、勾选、滚动、evaluate 或等待网络");

  const spacedPath = ` ${escapedPath} `;
  const spacedPathHarness = validFixture({
    sources: [{ id: 'runtime:home/α"1', path: spacedPath }],
    homes: [{ path: spacedPath }],
  });
  assert.equal((await readHomeSourceBinding(spacedPathHarness.page, 'runtime:home/α"1')).path, spacedPath);
});

test("A7-1: 返回当前绑定状态而不要求已勾选、已排除或弹窗已关闭", async () => {
  const harness = validFixture({
    sources: [{ id: 'runtime:home/α"1', path: escapedPath, checked: true }],
    homes: [{ path: escapedPath, excluded: false }],
    dialogVisible: true,
  });
  const binding = await readHomeSourceBinding(harness.page, 'runtime:home/α"1');

  assert.equal(binding.checked, true);
  assert.equal(binding.dialogHidden, false);
  assert.equal(binding.sourceBadgePresent, false);
  assert.equal(binding.homeExcluded, false);
  assert.equal(binding.homeVisible, true);
  assert.deepEqual(binding.excludedSourceIds, []);
  assert.deepEqual(binding.excludedHomePaths, []);
  assert.deepEqual(harness.sideEffects, []);
});

test("A7-1: 拒绝无效或重复 sourceId", async (t) => {
  const harness = validFixture();
  for (const invalidId of [null, 1, "", " \t "]) {
    await t.test(`invalid sourceId: ${String(invalidId)}`, async () => {
      await assert.rejects(readHomeSourceBinding(harness.page, invalidId), TypeError);
    });
  }

  const duplicate = validFixture({
    sources: [
      { id: 'runtime:home/α"1', path: escapedPath },
      { id: 'runtime:home/α"1', path: "C:\\different" },
    ],
  });
  await assert.rejects(readHomeSourceBinding(duplicate.page, 'runtime:home/α"1'), /sourceId 必须唯一/);
});

test("A7-1: 拒绝缺失或重复的来源/主页完整路径", async (t) => {
  const sourceWithoutTitle = validFixture({
    sources: [{ id: 'runtime:home/α"1', paths: [{}] }],
    homes: [{ path: escapedPath }],
  });
  await t.test("source path title missing", async () => {
    await assert.rejects(readHomeSourceBinding(sourceWithoutTitle.page, 'runtime:home/α"1'), /非空完整路径 title/);
  });

  const sourceWithWhitespaceTitle = validFixture({
    sources: [{ id: 'runtime:home/α"1', paths: [{ title: " \t " }] }],
    homes: [{ path: escapedPath }],
  });
  await t.test("source path title whitespace only", async () => {
    await assert.rejects(
      readHomeSourceBinding(sourceWithWhitespaceTitle.page, 'runtime:home/α"1'),
      /非空完整路径 title/,
    );
  });

  const duplicateSourcePath = validFixture({
    sources: [
      { id: 'runtime:home/α"1', path: escapedPath },
      { id: "other-home", path: escapedPath },
    ],
    homes: [{ path: escapedPath }],
  });
  await t.test("source path duplicated", async () => {
    await assert.rejects(readHomeSourceBinding(duplicateSourcePath.page, 'runtime:home/α"1'), /来源列表必须唯一/);
  });

  const missingHomePath = validFixture({ homes: [{ path: "C:\\elsewhere" }] });
  await t.test("home path missing", async () => {
    await assert.rejects(
      readHomeSourceBinding(missingHomePath.page, 'runtime:home/α"1'),
      /主页必须唯一，实际匹配 0 项/,
    );
  });

  const duplicateHomePath = validFixture({
    homes: [{ path: escapedPath }, { path: escapedPath, excluded: true }],
  });
  await t.test("home path duplicated", async () => {
    await assert.rejects(
      readHomeSourceBinding(duplicateHomePath.page, 'runtime:home/α"1'),
      /主页必须唯一，实际匹配 2 项/,
    );
  });

  const extraPathInTargetRow = validFixture({
    homes: [{ paths: [{ title: escapedPath }, { title: "C:\\different-leaf" }] }],
  });
  await t.test("target row extra direct path leaf", async () => {
    await assert.rejects(
      readHomeSourceBinding(extraPathInTargetRow.page, 'runtime:home/α"1'),
      /目标主页行必须只有一个直接 \.home-path，实际 2 项/,
    );
  });
});

test("A7-2: 只在主页同源排除态调用回调，随后按顺序恢复来源并关闭弹窗", async () => {
  const harness = createHomeLifecycleHarness();
  const callbackValue = { retained: true };
  const result = await harness.run(async () => {
    harness.events.push("callback");
    assert.equal(harness.dialogHidden(), true);
    assert.equal(harness.sourceChecked(), false);
    assert.equal(harness.targetHomeExcluded(), true);
    assert.deepEqual(harness.trace.homeSourceExcluded.bindings.home.excludedSourceIds, [harness.sourceId]);
    assert.deepEqual(harness.trace.homeSourceExcluded.bindings.home.excludedHomePaths, [harness.path]);
    return callbackValue;
  });

  assert.strictEqual(result, callbackValue);
  assert.deepEqual(harness.trace.homeSourceExcluded.order, [
    "entry-dialog-checked",
    "dialog-open-started",
    "dialog-opened",
    "initial-binding-read",
    "exclude-request-started",
    "exclude-response",
    "excluded-dialog-binding-confirmed",
    "dialog-close-started",
    "dialog-closed",
    "home-ready",
    "home-binding-confirmed",
    "callback-started",
    "callback-completed",
    "after-callback-binding-confirmed",
    "restore-dialog-open-started",
    "restore-dialog-opened",
    "restore-request-started",
    "restore-response",
    "restore-home-row-ready",
    "restore-binding-confirmed",
    "restore-dialog-close-started",
    "restore-dialog-closed",
  ]);
  assert.ok(harness.events.indexOf("checkbox-uncheck:target") < harness.events.indexOf("callback"));
  assert.ok(harness.events.indexOf("step:restore:#cancelImportButton") < harness.events.indexOf("callback"));
  assert.ok(harness.events.indexOf("callback") < harness.events.indexOf("checkbox-check:target"));
  assert.equal(harness.sourceChecked(), true);
  assert.equal(harness.targetHomeExcluded(), false);
  assert.equal(harness.dialogHidden(), true);
  assert.equal(harness.trace.homeSourceExcluded.restore.ok, true);
});

test("A7-2: 入口弹窗已打开或已有其他排除项时，在拨动来源前拒绝", async (t) => {
  const opened = createHomeLifecycleHarness({ dialogVisible: true });
  await t.test("保留调用方打开的弹窗", async () => {
    await assert.rejects(
      opened.run(async () => assert.fail("callback must not run")),
      /入口 #importDialog 必须已关闭/,
    );
    assert.equal(opened.dialogHidden(), false);
    assert.equal(
      opened.events.some((event) => event.startsWith("step:")),
      false,
    );
    assert.equal(opened.sourceChecked(), true);
  });

  const excluded = createHomeLifecycleHarness({ otherExcluded: true });
  await t.test("不改变现有其他排除项", async () => {
    await assert.rejects(
      excluded.run(async () => assert.fail("callback must not run")),
      /排除集合不符/,
    );
    assert.equal(excluded.sourceChecked(), true);
    assert.equal(excluded.otherSourceChecked(), false);
    assert.equal(excluded.dialogHidden(), true);
    assert.equal(
      excluded.events.some((event) => event.startsWith("checkbox-uncheck:")),
      false,
    );
    assert.equal(
      excluded.events.some((event) => event.startsWith("checkbox-check:")),
      false,
    );
    assert.equal(excluded.trace.homeSourceExcluded.restore.ok, true);
  });
});

test("A7-2: 排除请求失败或回调失败都恢复来源并关闭弹窗", async (t) => {
  const rejectedFilter = createHomeLifecycleHarness({ filterStatus: 500 });
  await t.test("排除请求非 200", async () => {
    let callbackCalled = false;
    await assert.rejects(
      rejectedFilter.run(async () => {
        callbackCalled = true;
      }),
      /来源请求必须返回 HTTP 200.*500/,
    );
    assert.equal(callbackCalled, false);
    assert.equal(rejectedFilter.trace.homeSourceExcluded.filter.responseStatus, 500);
    assert.equal(rejectedFilter.sourceChecked(), true);
    assert.equal(rejectedFilter.targetHomeExcluded(), false);
    assert.equal(rejectedFilter.dialogHidden(), true);
    assert.equal(rejectedFilter.trace.homeSourceExcluded.restore.ok, true);
  });

  const callbackFailure = createHomeLifecycleHarness();
  const cause = new Error("callback root");
  const primary = new Error("callback failed", { cause });
  await t.test("回调原错在成功恢复后原样抛出", async () => {
    await assert.rejects(
      callbackFailure.run(async () => {
        throw primary;
      }),
      (error) => error === primary,
    );
    assert.strictEqual(primary.cause, cause);
    assert.equal(callbackFailure.sourceChecked(), true);
    assert.equal(callbackFailure.targetHomeExcluded(), false);
    assert.equal(callbackFailure.dialogHidden(), true);
    assert.equal(callbackFailure.trace.homeSourceExcluded.restore.ok, true);
  });
});

test("A7-2: checkbox lookup 失败时不创建过滤 waiter 或 uncheck，仍关闭自开弹窗", async () => {
  const harness = createHomeLifecycleHarness({ failFilterCheckboxLookup: true });
  await assert.rejects(
    harness.run(async () => assert.fail("callback must not run")),
    /injected filter checkbox lookup failure/,
  );

  assert.equal(
    harness.events.some((event) => event.startsWith("wait-response:")),
    false,
  );
  assert.equal(
    harness.events.some((event) => event.startsWith("checkbox-uncheck:")),
    false,
  );
  assert.equal(harness.events.includes("step:restore:#cancelImportButton"), true);
  assert.equal(harness.dialogHidden(), true);
  assert.equal(harness.sourceChecked(), true);
  assert.equal(harness.trace.homeSourceExcluded.filter.requestedExclude, null);
});

test("A7-2: sourceId 路径漂移时不勾选陌生来源，并保留恢复失败", async () => {
  const harness = createHomeLifecycleHarness();
  await assert.rejects(
    harness.run(async () => {
      harness.addDriftedHomePath(String.raw`D:\different\source`);
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /身份漂移/);
      assert.match(String(error.errors[1]), /身份漂移/);
      assert.strictEqual(error.cause, error.errors[0]);
      return true;
    },
  );
  assert.equal(harness.sourceChecked(), false);
  assert.equal(harness.otherSourceChecked(), true);
  assert.equal(
    harness.events.some((event) => event.startsWith("checkbox-check:")),
    false,
  );
  assert.equal(harness.dialogHidden(), true);
  assert.equal(harness.trace.homeSourceExcluded.restore.ok, false);
});

test("A7-2: 主错 false 与恢复错 null 原样聚合并保留 cause", async () => {
  const harness = createHomeLifecycleHarness({ restoreActionThrows: { value: null } });
  await assert.rejects(
    harness.run(async () => {
      throw false;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [false, null]);
      assert.strictEqual(error.cause, false);
      return true;
    },
  );
  assert.equal(harness.sourceChecked(), true);
  assert.equal(harness.targetHomeExcluded(), false);
  assert.equal(harness.dialogHidden(), true);
  assert.equal(harness.trace.homeSourceExcluded.operationError.message, "false");
  assert.deepEqual(harness.trace.homeSourceExcluded.restore.errors, ["null"]);
  assert.equal(harness.trace.homeSourceExcluded.restore.ok, false);
  assert.ok(harness.trace.homeSourceExcluded.order.includes("restore-dialog-closed"));
});

test("A7-3: M3 在主页排除回调内使用完整目录，滚动区域证据先于恢复", async () => {
  const harness = createHomeLifecycleHarness();
  const measurement = { records: [{ result: "fail" }], captures: [], diagnostics: { counts: { fail: 1 } } };
  const runner = prepareHomeEvidenceHarness(harness, async (args) => {
    harness.events.push("measure");
    const homeBinding = harness.trace.homeSourceExcluded.bindings.home;
    assert.equal(homeBinding.dialogHidden, true);
    assert.equal(homeBinding.checked, false);
    assert.equal(homeBinding.homeExcluded, true);
    assert.strictEqual(args.candidate, runner.candidate);
    assert.strictEqual(args.policy, runner.policy);
    assert.equal(args.mode, "light");
    assert.equal(args.stateId, "home-source-excluded");
    assert.deepEqual(
      args.roleCatalog.map((role) => role.id),
      ROLE_CATALOG.map((role) => role.id),
    );
    assert.equal(args.roleCatalog.length, ROLE_CATALOG.length);
    return measurement;
  });

  assert.strictEqual(await runner.run(), measurement);
  assert.strictEqual(runner.evidence.measurement, measurement);
  assert.equal(runner.evidence.geometry.stage, "home-source-excluded");
  assert.equal(harness.trace.homeSourceExcluded.evidence.stateStage, "home-source-excluded");
  assert.equal(harness.trace.homeSourceExcluded.evidence.geometryStage, "home-source-excluded");
  assert.equal(harness.trace.homeSourceExcluded.evidence.regionStage, "home-source-excluded");
  assert.strictEqual(harness.trace.ready, harness.trace.homeSourceExcluded.ready);
  assert.equal(harness.trace.measurementFailure, undefined, "角色 FAIL 是测量结果，不是捕获异常");
  assert.ok(harness.events.indexOf("measure") < harness.events.indexOf("scroll:homeList"));
  assert.ok(harness.events.indexOf("scroll:homeList") < harness.events.indexOf("screenshot:region"));
  assert.ok(harness.events.indexOf("screenshot:region") < harness.events.indexOf("checkbox-check:target"));
  assert.equal(harness.dialogHidden(), true);
  assert.equal(harness.sourceChecked(), true);
});

test("A7-3: wrapper 恢复失败时仍保留已成功的 M3 测量", async () => {
  const harness = createHomeLifecycleHarness({ restoreStatus: 500 });
  const measurement = { records: [{ result: "pass" }], captures: [], diagnostics: { counts: { pass: 1 } } };
  const runner = prepareHomeEvidenceHarness(harness, async () => measurement);

  await assert.rejects(runner.run(), /来源请求必须返回 HTTP 200.*500/);
  assert.strictEqual(runner.evidence.measurement, measurement);
  assert.equal(runner.evidence.geometry.stage, "home-source-excluded");
  assert.equal(runner.evidence.shots.region.ok, true);
  assert.equal(harness.trace.measurementFailure, undefined);
  assert.equal(harness.trace.homeSourceExcluded.restore.ok, false);
  assert.ok(harness.events.indexOf("measure") < harness.events.indexOf("screenshot:region"));
  assert.ok(harness.events.indexOf("screenshot:region") < harness.events.indexOf("checkbox-check:target"));
});

test("A7-3: M3 抛错时保留合法 partial records/captures，并先拍排除态 region", async () => {
  const harness = createHomeLifecycleHarness();
  const primary = new Error("M3 roles failed", { cause: new Error("nested role failure") });
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMgAAAABJRU5ErkJggg==";
  const partialRecord = {
    roleId: ROLE_CATALOG[0].id,
    candidateId: "candidate-a7-3",
    mode: "light",
    stateId: "home-source-excluded",
    result: "pass",
  };
  Object.defineProperty(primary, "measurementEvidence", {
    value: {
      complete: false,
      phase: "roles",
      records: [partialRecord],
      captures: [{ roleId: partialRecord.roleId, pngBase64 }],
      diagnostics: { candidateId: "candidate-a7-3", mode: "light", stateId: "home-source-excluded" },
    },
  });
  const runner = prepareHomeEvidenceHarness(harness, async () => {
    harness.events.push("measure");
    throw primary;
  });

  await assert.rejects(runner.run(), (error) => error === primary);
  assert.equal(harness.trace.measurementFailure.packet, "accepted");
  assert.equal(harness.trace.measurementFailure.phase, "roles");
  assert.equal(harness.trace.measurementFailure.error.cause.message, "nested role failure");
  assert.deepEqual(runner.evidence.measurement.records, [partialRecord]);
  assert.deepEqual(runner.evidence.measurement.captures, [{ roleId: partialRecord.roleId, pngBase64 }]);
  assert.equal(runner.evidence.shots.region.ok, true);
  assert.ok(harness.events.indexOf("measure") < harness.events.indexOf("scroll:homeList"));
  assert.ok(harness.events.indexOf("screenshot:region") < harness.events.indexOf("checkbox-check:target"));
  assert.equal(harness.sourceChecked(), true);
  assert.equal(harness.dialogHidden(), true);
});

test("A33: partial 接受严格绑定的状态差异双帧并拒绝伪造 capture", async () => {
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMgAAAABJRU5ErkJggg==";
  const candidateId = "candidate-a7-3";
  const partialRecord = {
    roleId: ROLE_CATALOG[0].id,
    candidateId,
    mode: "light",
    stateId: "home-source-excluded",
    result: "pass",
  };
  const roleCapture = { roleId: partialRecord.roleId, kind: "text", pngBase64 };
  const stateBefore = { roleId: null, kind: "state-diff-before", pngBase64 };
  const stateAfter = { roleId: null, kind: "state-diff-after", pngBase64 };
  const diagnosticsFor = (
    stateDiffCaptures,
    {
      statePixelDiff = { identical: false, differingPixels: 68, maxChannelDelta: 1 },
      statePixelScope = { kind: "full-page" },
      omitStatePixelScope = false,
    } = {},
  ) => ({
    candidateId,
    mode: "light",
    stateId: "home-source-excluded",
    restoration: {
      statePixelDiff,
      ...(omitStatePixelScope ? {} : { statePixelScope }),
      stateDiffCaptures,
    },
  });
  const runCase = async (captures, stateDiffCaptures, { phase = "record-validation", ...diagnosticOptions } = {}) => {
    const harness = createHomeLifecycleHarness();
    const primary = new Error("M3 roles failed");
    Object.defineProperty(primary, "measurementEvidence", {
      value: {
        complete: false,
        phase,
        records: [partialRecord],
        captures,
        diagnostics: diagnosticsFor(stateDiffCaptures, diagnosticOptions),
      },
    });
    const runner = prepareHomeEvidenceHarness(harness, async () => {
      throw primary;
    });
    await assert.rejects(runner.run(), (error) => error === primary);
    return runner;
  };

  const captures = [roleCapture, stateBefore, stateAfter];
  const accepted = await runCase(captures, { before: 1, after: 2 });
  assert.equal(accepted.evidence.measurement.captures.length, 3);
  assert.deepEqual(accepted.evidence.measurement.captures, captures);
  assert.equal(accepted.evidence.measurement.diagnostics.partial, true);

  for (const [label, forgedCaptures, binding, options] of [
    ["错绑角色图", captures, { before: 0, after: 2 }, {}],
    ["未绑定 null 角色图", [roleCapture, stateBefore, stateAfter, { ...stateAfter }], { before: 1, after: 2 }, {}],
    ["未知角色图", [{ ...roleCapture, roleId: "unknown.role" }, stateBefore, stateAfter], { before: 1, after: 2 }, {}],
    [
      "负数差异",
      captures,
      { before: 1, after: 2 },
      { statePixelDiff: { identical: false, differingPixels: -1, maxChannelDelta: -1 } },
    ],
    [
      "超范围通道差",
      captures,
      { before: 1, after: 2 },
      { statePixelDiff: { identical: false, differingPixels: 68, maxChannelDelta: 256 } },
    ],
    ["缺少 scope", captures, { before: 1, after: 2 }, { omitStatePixelScope: true }],
    ["错误 phase", captures, { before: 1, after: 2 }, { phase: "compare" }],
  ]) {
    const rejected = await runCase(forgedCaptures, binding, options);
    assert.deepEqual(rejected.evidence.measurement.captures, [], label);
  }
});

test("A7-3: 主页排除规程缺失目标证据时不套用 post-procedure 恢复态 fallback", () => {
  const captureSource = readFileSync(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const fallbackStart = captureSource.indexOf(
    'const homeExcludedEvidenceRequired = unit.handler === "home-source-excluded"',
  );
  const fallbackEnd = captureSource.indexOf("\n    } else if (state) {", fallbackStart);
  assert.ok(fallbackStart >= 0 && fallbackEnd > fallbackStart);
  const fallbackSource = captureSource.slice(fallbackStart, fallbackEnd);

  assert.match(fallbackSource, /const homeExcludedEvidenceRequired = unit\.handler === "home-source-excluded"/);
  assert.match(fallbackSource, /if \(!geometry && !homeExcludedEvidenceRequired\)/);
  assert.match(fallbackSource, /if \(!homeExcludedEvidenceRequired\) shots\.state/);
  assert.match(fallbackSource, /主页排除态目标证据缺失/);
  assert.match(fallbackSource, /homeSourceExcludedEvidenceMissing = missing/);
});

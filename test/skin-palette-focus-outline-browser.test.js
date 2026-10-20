import assert from "node:assert/strict";
import test from "node:test";

import { measureFocusOutlineAdjacentPixels } from "../scripts/skin-palette/focus-outline-browser.mjs";

const SELECTOR = "#addImportButton";
const WIDTH = 72;
const HEIGHT = 48;

function probeState(overrides = {}) {
  return {
    identity: { count: 1, sameNode: true, connected: true },
    active: true,
    focusVisible: true,
    rect: { x: 100, y: 100, width: 54, height: 30 },
    viewport: { width: 800, height: 600, dpr: 1 },
    scroll: { x: 0, y: 0 },
    outline: { style: "solid", width: "2px", offset: "3px", color: "rgb(255, 255, 255)" },
    radii: ["11px", "11px", "11px", "11px"],
    inline: { hadStyle: false, value: "", priority: "", other: [] },
    spotlightCount: 0,
    effects: [
      {
        tag: "BUTTON",
        id: "addImportButton",
        opacity: "1",
        transform: "none",
        zoom: "1",
        clip: "auto",
        clipPath: "none",
        filter: "none",
        backdropFilter: "none",
        maskImage: "none",
        perspective: "none",
        mixBlendMode: "normal",
        visibility: "visible",
        scrollLeft: 0,
        scrollTop: 0,
      },
    ],
    ...overrides,
  };
}

function solidDecoded(rgba = [255, 255, 255, 255]) {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(rgba, offset);
  return { width: WIDTH, height: HEIGHT, data: Array.from(data) };
}

function makeHandle({ states = [], disposeError, disposeThrows = false } = {}) {
  let stateIndex = 0;
  return {
    evaluateCalls: [],
    disposeCalls: 0,
    async evaluate(_callback, selector) {
      this.evaluateCalls.push(selector);
      if (selector !== SELECTOR) throw new Error("单帧适配器只允许完整 probe");
      if (stateIndex >= states.length) throw new Error("缺少测试状态");
      return states[stateIndex++];
    },
    async dispose() {
      this.disposeCalls += 1;
      if (disposeThrows) throw disposeError;
    },
  };
}

function makePage({
  handles,
  decoded = solidDecoded(),
  screenshotError,
  screenshotThrows = false,
  decodeError,
  decodeThrows = false,
} = {}) {
  return {
    queryCalls: [],
    screenshotCalls: [],
    evaluateCalls: [],
    async $$(selector) {
      this.queryCalls.push(selector);
      return handles;
    },
    async screenshot(options) {
      this.screenshotCalls.push(options);
      if (screenshotThrows) throw screenshotError;
      return Buffer.from([137, 80, 78, 71]);
    },
    async evaluate(_callback, base64) {
      this.evaluateCalls.push(base64);
      if (decodeThrows) throw decodeError;
      return decoded;
    },
  };
}

test("A59 adjacent browser：唯一自然焦点目标只捕获一帧且零样式写入", async () => {
  const before = probeState();
  const handle = makeHandle({ states: [before, before, before] });
  const page = makePage({ handles: [handle], decoded: solidDecoded([255, 255, 255, 255]) });

  const result = await measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR });
  assert.equal(result.analysis.result, "fail");
  assert.equal(result.analysis.reason, "background-contrast-below-threshold");
  assert.equal(result.mutated, false);
  assert.equal(result.diagnostics.mutated, false);
  assert.equal("restoration" in result.diagnostics, false);
  assert.deepEqual(result.captures.clip, { x: 91, y: 91, width: 72, height: 48 });
  assert.deepEqual(result.diagnostics.probes.before, before);
  assert.deepEqual(result.diagnostics.probes.afterFocused, before);
  assert.deepEqual(result.diagnostics.probes.afterDecode, before);
  assert.equal(page.screenshotCalls.length, 1);
  assert.equal(page.evaluateCalls.length, 1, "page.evaluate 仅用于 PNG 解码");
  assert.deepEqual(handle.evaluateCalls, [SELECTOR, SELECTOR, SELECTOR]);
  assert.equal(handle.disposeCalls, 1);
});

test("A59 adjacent browser：多目标和自然焦点未就绪均拒测并释放", async (t) => {
  await t.test("目标不唯一", async () => {
    const first = makeHandle();
    const second = makeHandle();
    const page = makePage({ handles: [first, second] });
    const result = await measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR });
    assert.equal(result.analysis.result, "unmeasured");
    assert.equal(result.analysis.reason, "target-not-unique");
    assert.equal(result.mutated, false);
    assert.equal(page.screenshotCalls.length, 0);
    assert.equal(first.disposeCalls, 1);
    assert.equal(second.disposeCalls, 1);
  });

  await t.test("自然焦点未就绪", async () => {
    const handle = makeHandle({ states: [probeState({ active: false })] });
    const page = makePage({ handles: [handle] });
    const result = await measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR });
    assert.equal(result.analysis.result, "unmeasured");
    assert.equal(result.analysis.reason, "natural-focus-not-ready");
    assert.equal(page.screenshotCalls.length, 0);
    assert.equal(handle.evaluateCalls.length, 1);
    assert.equal(handle.disposeCalls, 1);
  });
});

test("A59 adjacent browser：DPR 与 clip 支持域拒绝", async (t) => {
  await t.test("DPR 不是 1", async () => {
    const state = probeState({ viewport: { width: 800, height: 600, dpr: 2 } });
    const handle = makeHandle({ states: [state] });
    const page = makePage({ handles: [handle] });
    const result = await measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR });
    assert.equal(result.analysis.reason, "unsupported-device-pixel-ratio");
    assert.equal(page.screenshotCalls.length, 0);
  });

  await t.test("clip 越出 viewport", async () => {
    const state = probeState({ rect: { x: 2, y: 100, width: 54, height: 30 } });
    const handle = makeHandle({ states: [state] });
    const page = makePage({ handles: [handle] });
    const result = await measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR });
    assert.equal(result.analysis.reason, "clip-outside-viewport");
    assert.deepEqual(result.captures.clip, { x: -7, y: 91, width: 72, height: 48 });
    assert.equal(page.screenshotCalls.length, 0);
  });
});

test("A59 adjacent browser：截图后与解码后完整探针漂移分别拒测", async (t) => {
  await t.test("截图后漂移", async () => {
    const before = probeState();
    const after = probeState({ scroll: { x: 0, y: 1 } });
    const handle = makeHandle({ states: [before, after] });
    const page = makePage({ handles: [handle] });
    const result = await measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR });
    assert.equal(result.analysis.reason, "focused-capture-state-drift");
    assert.equal(page.screenshotCalls.length, 1);
    assert.equal(page.evaluateCalls.length, 0);
    assert.equal(handle.evaluateCalls.length, 2);
  });

  await t.test("解码后漂移", async () => {
    const before = probeState();
    const after = probeState({ scroll: { x: 0, y: 1 } });
    const handle = makeHandle({ states: [before, before, after] });
    const page = makePage({ handles: [handle] });
    const result = await measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR });
    assert.equal(result.analysis.reason, "decode-state-drift");
    assert.equal(page.screenshotCalls.length, 1);
    assert.equal(page.evaluateCalls.length, 1);
    assert.equal(handle.evaluateCalls.length, 3);
  });
});

test("A59 adjacent browser：清理和原始抛出值保持身份与 cause", async (t) => {
  await t.test("成功后 dispose 错误保持对象身份", async () => {
    const before = probeState();
    const disposeError = new Error("dispose failed");
    const handle = makeHandle({
      states: [before, before, before],
      disposeThrows: true,
      disposeError,
    });
    const page = makePage({ handles: [handle] });
    await assert.rejects(measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR }), (error) => {
      assert.strictEqual(error, disposeError);
      assert.equal(error.focusOutlineEvidence.diagnostics.selector, SELECTOR);
      assert.equal(error.focusOutlineEvidence.diagnostics.mutated, false);
      return true;
    });
  });

  await t.test("falsy 主错与 dispose 错保留在 AggregateError", async () => {
    const handle = makeHandle({
      states: [probeState()],
      disposeThrows: true,
      disposeError: false,
    });
    const page = makePage({
      handles: [handle],
      screenshotThrows: true,
      screenshotError: null,
    });
    await assert.rejects(measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [null, false]);
      assert.equal(error.cause, null);
      assert.equal(error.focusOutlineEvidence.captures.focused, null);
      return true;
    });
  });

  await t.test("单一 falsy 主错保留为 cause", async () => {
    const handle = makeHandle({ states: [probeState()] });
    const page = makePage({
      handles: [handle],
      screenshotThrows: true,
      screenshotError: false,
    });
    await assert.rejects(measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR }), (error) => {
      assert.equal(error.cause, false);
      assert.equal(error.focusOutlineEvidence.diagnostics.selector, SELECTOR);
      return true;
    });
  });

  await t.test("对象主错与 dispose 错保持 AggregateError 顺序和 cause", async () => {
    const primary = new Error("screenshot failed");
    const cleanup = new Error("dispose failed");
    const handle = makeHandle({
      states: [probeState()],
      disposeThrows: true,
      disposeError: cleanup,
    });
    const page = makePage({
      handles: [handle],
      screenshotThrows: true,
      screenshotError: primary,
    });
    await assert.rejects(measureFocusOutlineAdjacentPixels({ page, selector: SELECTOR }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.strictEqual(error.cause, primary);
      return true;
    });
  });
});

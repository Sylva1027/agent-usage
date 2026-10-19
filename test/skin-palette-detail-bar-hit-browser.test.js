import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  probeDetailBarActiveCenterStripHits,
  probeDetailBarCenterRowHits,
  probeDetailBarCenterStripHits,
} from "../scripts/skin-palette/detail-bar-hit-browser.mjs";

const STASH_KEY = "__codexSkinDetailBarHitV1__";
const CLIP = Object.freeze({ x: 10, y: 20, width: 10, height: 1 });

const clone = (value) => JSON.parse(JSON.stringify(value));

class FakeNode {}

class FakeCSSPseudoElement {
  constructor({ type = "::after", element = null, parent = null } = {}) {
    this.type = type;
    this.element = element;
    this.parent = parent;
  }
}

class FakeElement extends FakeNode {
  constructor({ id = "", className = "", rect = { x: 10, y: 20, width: 10, height: 1 } } = {}) {
    super();
    this.nodeType = 1;
    this.tagName = "DIV";
    this.id = id;
    this.className = className;
    this.isConnected = true;
    this.ownerDocument = null;
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.rect = { ...rect };
    this.style = {
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
    };
  }

  append(child) {
    child.ownerDocument = this.ownerDocument;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(node) {
    return this === node || this.children.some((child) => child.contains(node));
  }

  getBoundingClientRect() {
    return { ...this.rect };
  }

  getRootNode() {
    return this.ownerDocument;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  closest(selector) {
    if (selector !== "#detailPanel") return null;
    for (let current = this; current; current = current.parentElement) {
      if (current.id === "detailPanel") return current;
    }
    return null;
  }
}

function createWorld({ existingStash = null, activePanel = false, scrollX = 0, scrollY = 0 } = {}) {
  const document = {};
  const fill = new FakeElement({ className: "bar-fill" });
  fill.ownerDocument = document;
  const overlay = new FakeElement({
    id: "overlay",
    className: "pointer-events-none-overlay",
    rect: { ...CLIP },
  });
  overlay.ownerDocument = document;
  overlay.style.pointerEvents = "none";
  const panels = [];
  let panel = null;
  let list = null;
  let row = null;
  let track = null;
  if (activePanel) {
    panel = new FakeElement({ id: "detailPanel", className: "panel detail-panel" });
    panel.ownerDocument = document;
    panel.setAttribute("data-spotlight-active", "");
    list = new FakeElement({ id: "detailList", className: "bar-list" });
    row = new FakeElement({ className: "bar-row" });
    track = new FakeElement({ className: "bar-track" });
    panel.append(list);
    list.append(row);
    row.append(track);
    track.append(fill);
    panels.push(panel);
  }

  const domCalls = [];
  const domHits = [fill, fill, fill];
  document.elementFromPoint = (x, y) => {
    domCalls.push({ x, y });
    return domHits.length > 0 ? domHits.shift() : fill;
  };
  document.contains = (node) => node === fill || node === overlay;
  document.querySelectorAll = (selector) => {
    if (selector === "#detailPanel") return panels;
    if (selector === "[data-spotlight-active]") {
      return panels.filter((entry) => entry.hasAttribute("data-spotlight-active"));
    }
    return [];
  };
  document.defaultView = null;

  const window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    scrollX,
    scrollY,
  };
  window.top = window;
  window.document = document;
  document.defaultView = window;
  if (existingStash !== null) window[STASH_KEY] = existingStash;

  const context = {
    window,
    document,
    Node: FakeNode,
    Element: FakeElement,
    CSSPseudoElement: FakeCSSPseudoElement,
    getComputedStyle: (node) => ({ ...node.style }),
  };
  const evaluateCalls = [];
  fill.evaluate = async (fn, arg) => {
    const isolated = vm.runInNewContext(`(${fn.toString()})`, context);
    const invoke = (element, options) => {
      evaluateCalls.push({ name: fn.name, elementIsFill: element === fill, arg: clone(options) });
      return isolated(element, options);
    };
    return clone(invoke(fill, arg));
  };

  return {
    document,
    fill,
    overlay,
    panel,
    list,
    row,
    track,
    domCalls,
    evaluateCalls,
    window,
    context,
  };
}

function createSession(world, options = {}) {
  const calls = [];
  const objectIds = new Map();
  const backendIds = new Map();
  const nativeHits = [
    ...(typeof options.nativeHits === "function"
      ? options.nativeHits(world)
      : (options.nativeHits ?? [world.fill, world.fill, world.fill])),
  ];
  const frameIds = options.frameIds ?? null;
  let pointIndex = 0;
  let evaluateIndex = 0;

  const session = {
    calls,
    async send(method, params = {}) {
      calls.push({ method, params });
      if (options.overrides?.[method]) {
        return options.overrides[method](params, pointIndex, calls);
      }
      if (method === "Runtime.evaluate") {
        const value = vm.runInNewContext(String(params.expression), world.context);
        if (!value) return { result: {} };
        const objectId = `evaluated-object-${evaluateIndex}`;
        evaluateIndex += 1;
        objectIds.set(objectId, value);
        return { result: { objectId } };
      }
      if (method === "Page.getFrameTree") {
        return { frameTree: { frame: { id: options.mainFrameId ?? "main-frame" } } };
      }
      if (method === "DOM.getNodeForLocation") {
        options.hooks?.beforePoint?.(pointIndex);
        if (Object.hasOwn(options.failAtPoint ?? {}, pointIndex)) {
          throw options.failAtPoint[pointIndex];
        }
        const hit = nativeHits[pointIndex];
        const frameId = frameIds?.[pointIndex] ?? "main-frame";
        pointIndex += 1;
        if (!hit) return {};
        if (!backendIds.has(hit)) backendIds.set(hit, backendIds.size + 1);
        const backendNodeId = backendIds.get(hit);
        objectIds.set(`hit-${backendNodeId}`, hit);
        return { backendNodeId, frameId };
      }
      if (method === "DOM.resolveNode") {
        const hit = [...backendIds].find(([, id]) => id === params.backendNodeId)?.[0];
        return hit ? { object: { objectId: `hit-${params.backendNodeId}` } } : {};
      }
      if (method === "Runtime.callFunctionOn") {
        const declaration = vm.runInNewContext(`(${params.functionDeclaration})`, world.context);
        const self = objectIds.get(params.objectId);
        const args = (params.arguments ?? []).map((argument) =>
          Object.hasOwn(argument, "objectId") ? objectIds.get(argument.objectId) : argument.value,
        );
        return { result: { value: clone(declaration.call(self, ...args)) } };
      }
      if (method === "DOM.describeNode") {
        if (options.describeFailure) throw options.describeFailure;
        return (
          options.describeNodeResult ?? {
            node: {
              backendNodeId: params.backendNodeId,
              nodeType: 1,
              nodeName: "DIV",
              localName: "div",
              nodeValue: "",
            },
          }
        );
      }
      if (method === "Runtime.releaseObjectGroup") {
        if (options.releaseFailure) throw options.releaseFailure.value;
        return {};
      }
      throw new Error(`未实现的 CDP 方法：${method}`);
    },
    async detach() {
      calls.push({ method: "detach" });
      if (options.detachFailure) throw options.detachFailure.value;
    },
  };
  return session;
}

function createFixture(options = {}) {
  const world = createWorld({
    existingStash: options.existingStash ?? null,
    activePanel: options.activePanel ?? false,
    scrollX: options.scrollX ?? 0,
    scrollY: options.scrollY ?? 0,
  });
  const session = createSession(world, options);
  const created = [];
  const page = {
    context() {
      return {
        newCDPSession: async (target) => {
          created.push(target);
          return session;
        },
      };
    },
  };
  return {
    world,
    session,
    created,
    page,
    run: (runOptions = {}) =>
      probeDetailBarCenterRowHits({
        page,
        fill: runOptions.fill ?? world.fill,
        clip: runOptions.clip ?? CLIP,
      }),
    runStrip: (runOptions = {}) =>
      probeDetailBarCenterStripHits({
        page,
        fill: runOptions.fill ?? world.fill,
        clip: runOptions.clip ?? CLIP,
      }),
    runActive: (runOptions = {}) =>
      probeDetailBarActiveCenterStripHits({
        page,
        fill: runOptions.fill ?? world.fill,
        clip: runOptions.clip ?? CLIP,
      }),
  };
}

async function captureFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("预期失败但调用成功返回");
}

const methods = (session) => session.calls.map((call) => call.method);

test("normal：三中心点 DOM/native 精确命中，单会话单对象组并清理", async () => {
  const fixture = createFixture();
  const result = await fixture.run();

  assert.equal(result.status, "observed");
  assert.equal(result.scope, "three-center-row-points-only");
  assert.deepEqual(result.clip, CLIP);
  assert.deepEqual(result.frame, { main: "main-frame" });
  assert.deepEqual(
    result.points.map((point) => point.kind),
    ["left", "center", "right"],
  );
  assert.deepEqual(
    result.points.map((point) => [point.x, point.y, point.integer.x, point.integer.y]),
    [
      [10.5, 20.5, 10, 20],
      [15, 20.5, 15, 20],
      [19.5, 20.5, 19, 20],
    ],
  );
  assert.deepEqual(
    fixture.world.domCalls,
    result.points.map((point) => ({ x: point.x, y: point.y })),
  );
  assert.deepEqual(
    fixture.session.calls
      .filter((call) => call.method === "DOM.getNodeForLocation")
      .map((call) => [call.params.x, call.params.y, call.params.ignorePointerEventsNone]),
    [
      [10, 20, true],
      [15, 20, true],
      [19, 20, true],
    ],
  );
  assert.ok(result.points.every((point) => point.dom.exactFill === true));
  assert.ok(result.points.every((point) => point.native.exactFill === true));
  assert.ok(result.points.every((point) => point.native.frameId === "main-frame"));
  assert.deepEqual(
    result.points.map((point) => point.native.documentInteger),
    result.points.map((point) => point.integer),
  );
  assert.ok(result.points.every((point) => point.domNativeDiffer === false));
  assert.equal(result.fill.style.backgroundColor, "rgba(0, 0, 0, 0)");
  assert.equal(result.fill.style.pointerEvents, "auto");
  assert.equal(result.pointerEvents.unchanged, true);
  assert.equal(fixture.created.length, 1);
  assert.deepEqual(
    fixture.world.evaluateCalls.map((call) => call.name),
    [
      "installDetailBarHitStash",
      "readDetailBarDomHits",
      "readDetailBarHitSnapshot",
      "readDetailBarHitSnapshot",
      "readDetailBarHitSnapshot",
      "clearDetailBarHitStash",
    ],
  );
  assert.ok(fixture.world.evaluateCalls.every((call) => call.elementIsFill === true));

  const objectGroups = fixture.session.calls
    .filter((call) => call.method === "Runtime.evaluate" || call.method === "DOM.resolveNode")
    .map((call) => call.params.objectGroup);
  assert.equal(new Set(objectGroups).size, 1);
  assert.match(objectGroups[0], /^codex-detail-bar-hit-v1:/);
  assert.equal(methods(fixture.session).filter((method) => method === "Runtime.releaseObjectGroup").length, 1);
  assert.equal(methods(fixture.session).filter((method) => method === "detach").length, 1);
  assert.equal(methods(fixture.session).filter((method) => method === "DOM.describeNode").length, 0);
  assert.ok(
    methods(fixture.session).indexOf("Runtime.releaseObjectGroup") < methods(fixture.session).indexOf("detach"),
  );
  assert.deepEqual(result.cleanup, {
    releaseObjectGroup: "released",
    detach: "detached",
    stash: "cleared",
  });
  assert.equal(fixture.world.window[STASH_KEY], undefined);
});

test("B69：仅 CDP 使用 document CSS 整数，DOM 与 viewport 坐标保持不变", async () => {
  const fixture = createFixture({ scrollX: 13, scrollY: 36 });
  const result = await fixture.run();

  assert.equal(result.status, "observed");
  assert.deepEqual(
    result.points.map((point) => [point.x, point.y, point.integer.x, point.integer.y]),
    [
      [10.5, 20.5, 10, 20],
      [15, 20.5, 15, 20],
      [19.5, 20.5, 19, 20],
    ],
  );
  assert.deepEqual(
    result.points.map((point) => point.native.documentInteger),
    [
      { x: 23, y: 56 },
      { x: 28, y: 56 },
      { x: 32, y: 56 },
    ],
  );
  assert.deepEqual(
    fixture.world.domCalls,
    result.points.map((point) => ({ x: point.x, y: point.y })),
  );
  assert.deepEqual(
    fixture.session.calls
      .filter((call) => call.method === "DOM.getNodeForLocation")
      .map((call) => [call.params.x, call.params.y]),
    [
      [23, 56],
      [28, 56],
      [32, 56],
    ],
  );
  assert.ok(result.points.every((point) => point.native.exactFill === true));
  assert.equal(result.cleanup.stash, "cleared");
});

test("B69：fractional root scroll 明确拒绝且不建立 CDP 坐标 fallback", async () => {
  const fixture = createFixture({ scrollX: 13.5, scrollY: 36.5 });
  const result = await fixture.run();

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "viewport-scroll-not-safe-integer");
  assert.equal(result.points.length, 0);
  assert.equal(fixture.created.length, 0);
  assert.equal(fixture.session.calls.length, 0);
  assert.equal(result.cleanup.stash, "cleared");
  assert.equal(fixture.world.window[STASH_KEY], undefined);
});

test("B43：width=1 与整条中心像素顺序完整覆盖", async () => {
  const singleClip = Object.freeze({ x: 10, y: 20, width: 1, height: 1 });
  const single = createFixture({ nativeHits: (world) => [world.fill] });
  const singleResult = await single.runStrip({ clip: singleClip });

  assert.equal(singleResult.status, "observed");
  assert.equal(singleResult.scope, "all-center-strip-pixel-centers");
  assert.deepEqual(singleResult.clip, singleClip);
  assert.deepEqual(
    singleResult.points.map((point) => [point.kind, point.x, point.y, point.integer.x, point.integer.y]),
    [["pixel-0", 10.5, 20.5, 10, 20]],
  );
  assert.equal(single.created.length, 1);
  assert.equal(singleResult.cleanup.stash, "cleared");

  const stripClip = Object.freeze({ x: 10, y: 20, width: 5, height: 1 });
  const strip = createFixture({ nativeHits: (world) => new Array(5).fill(world.fill) });
  const stripResult = await strip.runStrip({ clip: stripClip });

  assert.equal(stripResult.status, "observed");
  assert.equal(stripResult.scope, "all-center-strip-pixel-centers");
  assert.deepEqual(
    stripResult.points.map((point) => [point.kind, point.x, point.y, point.integer.x, point.integer.y]),
    [
      ["pixel-0", 10.5, 20.5, 10, 20],
      ["pixel-1", 11.5, 20.5, 11, 20],
      ["pixel-2", 12.5, 20.5, 12, 20],
      ["pixel-3", 13.5, 20.5, 13, 20],
      ["pixel-4", 14.5, 20.5, 14, 20],
    ],
  );
  assert.deepEqual(
    strip.session.calls
      .filter((call) => call.method === "DOM.getNodeForLocation")
      .map((call) => [call.params.x, call.params.y]),
    [
      [10, 20],
      [11, 20],
      [12, 20],
      [13, 20],
      [14, 20],
    ],
  );
  assert.ok(stripResult.points.every((point) => point.dom.exactFill && point.native.exactFill));
  assert.equal(stripResult.cleanup.releaseObjectGroup, "released");
  assert.equal(stripResult.cleanup.detach, "detached");
  assert.equal(stripResult.cleanup.stash, "cleared");
  assert.equal(strip.world.window[STASH_KEY], undefined);
});

test("B43：原三点遗漏的内部第 2 像素遮挡由整条入口拒绝并清理", async () => {
  const row = createFixture({ nativeHits: (world) => new Array(3).fill(world.fill) });
  const rowResult = await row.run();
  assert.equal(rowResult.status, "observed");
  assert.deepEqual(
    rowResult.points.map((point) => point.x),
    [10.5, 15, 19.5],
  );
  assert.equal(
    rowResult.points.some((point) => point.x === 11.5),
    false,
  );

  const strip = createFixture({
    nativeHits: (world) => {
      const hits = new Array(10).fill(world.fill);
      hits[1] = world.overlay;
      return hits;
    },
  });
  const stripResult = await strip.runStrip();

  assert.equal(stripResult.status, "rejected");
  assert.equal(stripResult.reason, "native-non-fill:pixel-1");
  assert.equal(stripResult.points.length, 2);
  assert.equal(stripResult.points[1].x, 11.5);
  assert.equal(stripResult.points[1].native.exactFill, false);
  assert.equal(stripResult.points[1].native.top.id, "overlay");
  assert.equal(stripResult.cleanup.releaseObjectGroup, "released");
  assert.equal(stripResult.cleanup.detach, "detached");
  assert.equal(stripResult.cleanup.stash, "cleared");
  assert.equal(strip.world.window[STASH_KEY], undefined);
});

test("B45：实际比较函数安全拒绝非 Node 并保留 describeNode 元数据", async () => {
  class FakePseudoElement {
    constructor() {
      this.type = "CSSPseudoElement";
      this.pseudoType = "after";
    }
  }

  const pseudo = new FakePseudoElement();
  const fixture = createFixture({
    nativeHits: [pseudo],
    describeNodeResult: {
      node: {
        backendNodeId: 1,
        nodeType: 1,
        nodeName: "DIV",
        localName: "div",
        pseudoType: "after",
      },
    },
  });
  const result = await fixture.runStrip({
    clip: { x: 10, y: 20, width: 1, height: 1 },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "native-non-node:pixel-0");
  assert.equal(result.points.length, 1);
  const native = result.points[0].native;
  assert.equal(native.exactFill, false);
  assert.equal(native.withinFill, false);
  assert.equal(native.fillConnected, true);
  assert.equal(native.hitKind, "non-node");
  assert.equal(native.rejected, true);
  assert.equal(native.reason, "native-non-node");
  assert.equal(native.top.constructorName, "FakePseudoElement");
  assert.equal(native.top.type, "CSSPseudoElement");
  assert.equal(native.top.pseudoType, "after");
  assert.equal(native.nodeDescription.status, "observed");
  assert.equal(native.nodeDescription.node.pseudoType, "after");
  assert.deepEqual(
    fixture.session.calls.filter((call) => call.method === "DOM.describeNode").map((call) => call.params),
    [{ backendNodeId: 1, depth: 0 }],
  );
  assert.equal(result.cleanup.stash, "cleared");
  assert.equal(fixture.world.window[STASH_KEY], undefined);
});

test("B45：比较异常保留 exceptionDetails 与 protocol node metadata", async () => {
  const exceptionDetails = {
    exceptionId: 7,
    text: "Uncaught TypeError: contains rejected",
    lineNumber: 0,
    columnNumber: 42,
    exception: {
      type: "object",
      subtype: "error",
      className: "TypeError",
      description: "TypeError: contains rejected",
    },
  };
  const node = {
    backendNodeId: 1,
    nodeType: 1,
    nodeName: "DIV",
    localName: "div",
    pseudoType: "after",
  };
  const fixture = createFixture({
    nativeHits: (world) => [world.fill],
    overrides: {
      "Runtime.callFunctionOn": () => ({
        exceptionDetails,
        result: { type: "object", subtype: "error" },
      }),
    },
    describeNodeResult: { node },
  });
  const error = await captureFailure(
    fixture.runStrip({
      clip: { x: 10, y: 20, width: 1, height: 1 },
    }),
  );

  assert.match(error.message, /pixel-0 严格对象比较抛出异常/);
  const evidence = error.detailBarHitEvidence;
  assert.equal(evidence.status, "failed");
  assert.deepEqual(evidence.points[0].native.exceptionDetails, exceptionDetails);
  assert.deepEqual(evidence.points[0].native.nodeDescription, {
    status: "observed",
    node,
  });
  assert.deepEqual(
    fixture.session.calls.filter((call) => call.method === "DOM.describeNode").map((call) => call.params),
    [{ backendNodeId: 1, depth: 0 }],
  );
  assert.equal(evidence.cleanup.releaseObjectGroup, "released");
  assert.equal(evidence.cleanup.detach, "detached");
  assert.equal(evidence.cleanup.stash, "cleared");
});

test("B45：describeNode 失败只留次要诊断，不覆盖比较主错", async () => {
  const exceptionDetails = {
    exceptionId: 8,
    text: "Uncaught TypeError: original comparison failure",
    lineNumber: 1,
    columnNumber: 2,
    exception: {
      type: "object",
      subtype: "error",
      className: "TypeError",
      description: "TypeError: original comparison failure",
    },
  };
  const fixture = createFixture({
    nativeHits: (world) => [world.fill],
    overrides: {
      "Runtime.callFunctionOn": () => ({
        exceptionDetails,
        result: { type: "object", subtype: "error" },
      }),
    },
    describeFailure: new Error("describe secondary failure"),
  });
  const error = await captureFailure(
    fixture.runStrip({
      clip: { x: 10, y: 20, width: 1, height: 1 },
    }),
  );

  assert.match(error.message, /pixel-0 严格对象比较抛出异常/);
  assert.doesNotMatch(error.message, /describe secondary failure/);
  assert.deepEqual(error.detailBarHitEvidence.points[0].native.exceptionDetails, exceptionDetails);
  assert.deepEqual(error.detailBarHitEvidence.points[0].native.nodeDescription, {
    status: "failed",
    error: "describe secondary failure",
  });
  assert.equal(fixture.session.calls.filter((call) => call.method === "DOM.describeNode").length, 1);
  assert.equal(error.detailBarHitEvidence.cleanup.stash, "cleared");
});

test("B47：固定 active 条入口接受真实 after pseudo 且每 probe 只解析 panel 一次", async () => {
  const fixture = createFixture({
    activePanel: true,
    nativeHits: (world) =>
      new Array(3).fill(null).map(
        () =>
          new FakeCSSPseudoElement({
            type: "::after",
            element: world.panel,
            parent: world.panel,
          }),
      ),
  });
  const result = await fixture.runActive({
    clip: { x: 10, y: 20, width: 3, height: 1 },
  });

  assert.equal(result.status, "observed");
  assert.equal(result.scope, "all-center-strip-pixel-centers");
  assert.equal(result.paintMode, "active-detail");
  assert.equal(result.admission.requireActiveDetailPanel, true);
  assert.equal(result.detailPanel.id, "detailPanel");
  assert.equal(result.points.length, 3);
  assert.ok(result.points.every((point) => point.native.exactFill === false));
  assert.ok(result.points.every((point) => point.native.expectedDetailSpotlight === true));
  assert.ok(result.points.every((point) => point.native.detailSpotlight.accepted === true));
  assert.ok(
    result.points.every(
      (point) =>
        point.native.detailSpotlight.identity.type === "::after" &&
        point.native.detailSpotlight.identity.origin.id === "detailPanel" &&
        point.native.detailSpotlight.identity.parent.id === "detailPanel",
    ),
  );
  assert.equal(methods(fixture.session).filter((method) => method === "Runtime.evaluate").length, 2);
  assert.equal(methods(fixture.session).filter((method) => method === "DOM.resolveNode").length, 3);
  assert.equal(methods(fixture.session).filter((method) => method === "DOM.describeNode").length, 0);
  assert.equal(result.cleanup.releaseObjectGroup, "released");
  assert.equal(result.cleanup.detach, "detached");
  assert.equal(result.cleanup.stash, "cleared");
});

test("B47：错 type/origin/parent、Node、HTML overlay 与缺品牌均拒绝", async () => {
  const cases = [
    {
      name: "before",
      make: (world) =>
        new FakeCSSPseudoElement({
          type: "::before",
          element: world.panel,
          parent: world.panel,
        }),
      reason: "native-active-spotlight-type-mismatch:pixel-0",
    },
    {
      name: "wrong-origin",
      make: (world) =>
        new FakeCSSPseudoElement({
          type: "::after",
          element: world.overlay,
          parent: world.panel,
        }),
      reason: "native-active-spotlight-origin-mismatch:pixel-0",
    },
    {
      name: "nested-parent",
      make: (world) =>
        new FakeCSSPseudoElement({
          type: "::after",
          element: world.panel,
          parent: new FakeCSSPseudoElement({
            type: "::before",
            element: world.panel,
            parent: world.panel,
          }),
        }),
      reason: "native-active-spotlight-parent-mismatch:pixel-0",
    },
    {
      name: "node",
      make: () => new FakeNode(),
      reason: "native-active-spotlight-brand-missing:pixel-0",
    },
    {
      name: "html-overlay",
      make: (world) => world.overlay,
      reason: "native-active-spotlight-brand-missing:pixel-0",
    },
    {
      name: "missing-brand",
      make: (world) => ({
        type: "::after",
        element: world.panel,
        parent: world.panel,
      }),
      reason: "native-active-spotlight-brand-missing:pixel-0",
    },
  ];

  for (const entry of cases) {
    const fixture = createFixture({
      activePanel: true,
      nativeHits: (world) => [entry.make(world)],
    });
    const result = await fixture.runActive({
      clip: { x: 10, y: 20, width: 1, height: 1 },
    });
    assert.equal(result.status, "rejected", entry.name);
    assert.equal(result.reason, entry.reason, entry.name);
    assert.equal(result.points[0].native.exactFill, false, entry.name);
    assert.equal(result.points[0].native.expectedDetailSpotlight, false, entry.name);
    assert.equal(result.cleanup.stash, "cleared", entry.name);
    assert.equal(fixture.world.window[STASH_KEY], undefined, entry.name);
  }
});

test("B47：旧 strip 入口仍不把匹配 origin/parent 的 pseudo 当作命中", async () => {
  const fixture = createFixture({
    activePanel: true,
    nativeHits: (world) => [
      new FakeCSSPseudoElement({
        type: "::after",
        element: world.panel,
        parent: world.panel,
      }),
    ],
  });
  const result = await fixture.runStrip({
    clip: { x: 10, y: 20, width: 1, height: 1 },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "native-non-node:pixel-0");
  assert.equal(result.paintMode, "exact-fill");
  assert.equal(result.admission.requireActiveDetailPanel, false);
  assert.equal(result.points[0].native.exactFill, false);
  assert.equal(result.points[0].native.expectedDetailSpotlight, false);
});

test("B43：坐标溢出或巨大 width 在建立 CDP 会话前拒绝", async () => {
  const overflow = createFixture({ nativeHits: (world) => [world.fill] });
  const overflowResult = await overflow.runStrip({
    clip: { x: 10, y: 20, width: Number.MAX_SAFE_INTEGER, height: 1 },
  });
  assert.equal(overflowResult.status, "rejected");
  assert.equal(overflowResult.reason, "clip-coordinate-overflow:x");
  assert.equal(overflowResult.points.length, 0);
  assert.equal(overflow.created.length, 0);
  assert.equal(overflowResult.cleanup.stash, "cleared");
  assert.equal(overflow.world.window[STASH_KEY], undefined);

  const huge = createFixture({ nativeHits: (world) => [world.fill] });
  const hugeResult = await huge.runStrip({
    clip: { x: 0, y: 20, width: 1_000_000_000, height: 1 },
  });
  assert.equal(hugeResult.status, "rejected");
  assert.equal(hugeResult.reason, "clip-outside-viewport");
  assert.equal(hugeResult.points.length, 0);
  assert.equal(huge.created.length, 0);
  assert.equal(hugeResult.cleanup.stash, "cleared");
  assert.equal(huge.world.window[STASH_KEY], undefined);
});

test("pointer-events:none overlay：DOM 命中 fill，native 命中 overlay 时拒测", async () => {
  const world = createWorld();
  const session = createSession(world, {
    nativeHits: [world.fill, world.overlay, world.fill],
  });
  const page = {
    context: () => ({ newCDPSession: async () => session }),
  };

  const result = await probeDetailBarCenterRowHits({
    page,
    fill: world.fill,
    clip: CLIP,
  });

  assert.equal(world.overlay.style.pointerEvents, "none");
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "native-non-fill:center");
  assert.equal(result.points.length, 2);
  assert.equal(result.points[1].dom.exactFill, true);
  assert.equal(result.points[1].dom.top.id, "");
  assert.equal(result.points[1].native.exactFill, false);
  assert.equal(result.points[1].native.top.id, "overlay");
  assert.equal(result.points[1].domNativeDiffer, true);
  assert.equal(result.cleanup.releaseObjectGroup, "released");
  assert.equal(result.cleanup.detach, "detached");
  assert.equal(result.cleanup.stash, "cleared");
  assert.equal(world.window[STASH_KEY], undefined);
});

test("身份、布局或子 frame 变化均拒测并保留已完成点", async () => {
  const layout = createFixture({
    hooks: {
      beforePoint(index) {
        if (index === 1) layout.world.fill.rect.x += 1;
      },
    },
  });
  const layoutResult = await layout.run();
  assert.equal(layoutResult.status, "rejected");
  assert.match(layoutResult.reason, /^layout-drift:center:rect$/);
  assert.equal(layoutResult.points.length, 2);
  assert.equal(layout.world.window[STASH_KEY], undefined);

  const scrolling = createFixture({
    scrollY: 36,
    hooks: {
      beforePoint(index) {
        if (index === 1) scrolling.world.window.scrollY += 1;
      },
    },
  });
  const scrollingResult = await scrolling.run();
  assert.equal(scrollingResult.status, "rejected");
  assert.equal(scrollingResult.reason, "layout-drift:center:viewport");
  assert.equal(scrollingResult.points.length, 2);
  assert.equal(scrolling.world.window[STASH_KEY], undefined);

  const identity = createFixture({
    hooks: {
      beforePoint(index) {
        if (index === 0) identity.world.window[STASH_KEY].fill = identity.world.overlay;
      },
    },
  });
  const identityResult = await identity.run();
  assert.equal(identityResult.status, "rejected");
  assert.equal(identityResult.reason, "fill-identity-mismatch");
  assert.equal(identityResult.points.length, 1);
  assert.equal(identity.world.window[STASH_KEY], undefined);

  const iframe = createFixture({ frameIds: ["child-frame", "main-frame", "main-frame"] });
  const iframeResult = await iframe.run();
  assert.equal(iframeResult.status, "rejected");
  assert.equal(iframeResult.reason, "native-frame-not-main:left:child-frame");
  assert.equal(iframeResult.points.length, 1);
  assert.equal(iframeResult.points[0].native.frameId, "child-frame");
  assert.equal(iframe.world.window[STASH_KEY], undefined);
});

test("stash 占用、CDP 失败与 cleanup 失败保留证据和原始错误值", async () => {
  const occupiedStash = { token: "other", fill: {} };
  const occupied = createFixture({ existingStash: occupiedStash });
  const occupiedResult = await occupied.run();
  assert.equal(occupiedResult.status, "rejected");
  assert.equal(occupiedResult.reason, "stash-occupied");
  assert.equal(occupied.created.length, 0);
  assert.equal(occupied.world.window[STASH_KEY], occupiedStash);
  assert.deepEqual(
    occupied.world.evaluateCalls.map((call) => call.name),
    ["installDetailBarHitStash"],
  );
  assert.equal(occupied.world.evaluateCalls[0].elementIsFill, true);

  const primary = new Error("native boom");
  const cdpFailure = createFixture({
    failAtPoint: { 1: primary },
  });
  const cdpError = await captureFailure(cdpFailure.run());
  assert.equal(cdpError, primary);
  assert.equal(cdpError.detailBarHitEvidence.status, "failed");
  assert.equal(cdpError.detailBarHitEvidence.points.length, 1);
  assert.equal(cdpError.detailBarHitEvidence.cleanup.releaseObjectGroup, "released");
  assert.equal(cdpError.detailBarHitEvidence.cleanup.detach, "detached");
  assert.equal(cdpError.detailBarHitEvidence.cleanup.stash, "cleared");
  assert.equal(cdpFailure.world.window[STASH_KEY], undefined);

  const nullFailure = createFixture({
    failAtPoint: { 0: null },
  });
  const nullError = await captureFailure(nullFailure.run());
  assert.ok(nullError instanceof Error);
  assert.equal(nullError.cause, null);
  assert.equal(nullError.detailBarHitEvidence.status, "failed");
  assert.equal(nullError.detailBarHitEvidence.cleanup.stash, "cleared");
  assert.equal(nullFailure.world.window[STASH_KEY], undefined);

  const falseFailure = createFixture({
    failAtPoint: { 0: false },
  });
  const falseError = await captureFailure(falseFailure.run());
  assert.ok(falseError instanceof Error);
  assert.equal(falseError.cause, false);
  assert.equal(falseError.detailBarHitEvidence.status, "failed");
  assert.equal(falseFailure.world.window[STASH_KEY], undefined);

  const frozenPrimary = Object.freeze(new Error("frozen native boom"));
  const frozenFailure = createFixture({
    failAtPoint: { 0: frozenPrimary },
  });
  const frozenError = await captureFailure(frozenFailure.run());
  assert.notEqual(frozenError, frozenPrimary);
  assert.equal(frozenError.cause, frozenPrimary);
  assert.equal(frozenError.detailBarHitEvidence.status, "failed");
  assert.equal(frozenFailure.world.window[STASH_KEY], undefined);

  const cleanupFailure = createFixture({
    releaseFailure: { value: false },
    detachFailure: { value: null },
  });
  const cleanupError = await captureFailure(cleanupFailure.run());
  assert.ok(cleanupError instanceof AggregateError);
  assert.deepEqual(cleanupError.errors, [false, null]);
  assert.equal(cleanupError.detailBarHitEvidence.status, "failed");
  assert.equal(cleanupError.detailBarHitEvidence.points.length, 3);
  assert.equal(cleanupError.detailBarHitEvidence.cleanup.releaseObjectGroup, "failed");
  assert.equal(cleanupError.detailBarHitEvidence.cleanup.detach, "failed");
  assert.equal(cleanupError.detailBarHitEvidence.cleanup.stash, "cleared");
  assert.equal(cleanupFailure.world.window[STASH_KEY], undefined);

  const combinedPrimary = Object.freeze(new Error("combined native boom"));
  const combinedFailure = createFixture({
    failAtPoint: { 0: combinedPrimary },
    releaseFailure: { value: false },
    detachFailure: { value: null },
  });
  const combinedError = await captureFailure(combinedFailure.run());
  assert.ok(combinedError instanceof AggregateError);
  assert.equal(combinedError.errors[0], combinedPrimary);
  assert.deepEqual(combinedError.errors.slice(1), [false, null]);
  assert.equal(combinedError.detailBarHitEvidence.status, "failed");
  assert.equal(combinedFailure.world.window[STASH_KEY], undefined);
});

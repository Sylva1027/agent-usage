import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { captureDetailBarThreeFrames as captureDetailBarThreeFramesImpl } from "../scripts/skin-palette/detail-bar-capture.mjs";
import { probeDetailBarGeometry } from "../scripts/skin-palette/detail-bar-browser.mjs";
import {
  beginDetailBarPaintHide,
  restoreDetailBarPaintHide,
} from "../scripts/skin-palette/detail-bar-paint-browser.mjs";

const BASE_PROBE = {
  status: "observed",
  fillRect: { x: 10, y: 20, width: 100, height: 8 },
  visibleRect: { x: 10, y: 20, width: 100, height: 8 },
  radius: 4,
  cssRadius: 4,
  rawRadii: { topLeft: "4px", topRight: "4px", bottomRight: "4px", bottomLeft: "4px" },
  rowIndex: 0,
  viewport: { width: 800, height: 600, dpr: 1, visualScale: 1 },
  scroll: {
    window: { x: 0, y: 0 },
    list: { left: 0, top: 0, width: 400, height: 200, clientWidth: 400, clientHeight: 200 },
  },
  structure: {
    detailPanel: "section#detailPanel.detail-panel",
    detailList: "div#detailList.bar-list",
    row: "div.bar-row",
    track: "div.bar-track",
    fill: "div.bar-fill",
  },
  trackContentRect: { x: 11, y: 20, width: 98, height: 8 },
  clipSources: [],
  ancestors: [],
  clipShapes: [
    { rect: { x: 10, y: 20, width: 100, height: 8 }, radius: 4, source: "fill-inner" },
    { rect: { x: 8, y: 18, width: 104, height: 12 }, radius: 6, source: "track-inner" },
    { rect: { x: 0, y: 0, width: 200, height: 100 }, radius: 9, source: "ancestor-inner" },
  ],
  spotlight: { active: false, backgroundImage: "none", maskImage: "none", zIndex: "auto" },
};

function stackEntry(overrides = {}) {
  return {
    source: "test",
    position: "static",
    zIndex: "auto",
    isolation: "auto",
    display: "block",
    visibility: "visible",
    opacity: "1",
    transform: "none",
    filter: "none",
    mixBlendMode: "normal",
    ...overrides,
  };
}

const ACTIVE_SPOTLIGHT = {
  active: true,
  backgroundImage: "radial-gradient(circle, rgba(10, 20, 30, 0.22), transparent)",
  maskImage: 'url("data:image/svg+xml,spotlight")',
  zIndex: "0",
  activeHostCount: 1,
  activeHostIsPanel: true,
  pseudo: {
    content: '""',
    position: "absolute",
    inset: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    opacity: "1",
    pointerEvents: "none",
    maskSize: "100% 100%",
    maskRepeat: "no-repeat",
  },
  host: { isolation: "isolate", position: "relative" },
  x: "120px",
  y: "130px",
  radius: "320px",
  mask: 'url("data:image/svg+xml,mask")',
  stack: {
    heading: stackEntry({ source: "heading", position: "relative", zIndex: "1" }),
    labels: [stackEntry({ source: "label-0", position: "relative", zIndex: "1" })],
    fill: stackEntry({ source: "fill" }),
    track: stackEntry({ source: "track" }),
    list: stackEntry({ source: "list", display: "grid" }),
    row: stackEntry({ source: "row", display: "grid" }),
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const C4_BASE_STYLE = {
  display: "block",
  visibility: "visible",
  opacity: "1",
  position: "static",
  zIndex: "auto",
  isolation: "auto",
  backgroundColor: "rgba(0, 0, 0, 0)",
  backgroundImage: "none",
  boxShadow: "none",
  transform: "none",
  translate: "none",
  rotate: "none",
  zoom: "1",
  scale: "none",
  filter: "none",
  mixBlendMode: "normal",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  overflowX: "visible",
  overflowY: "visible",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderRadius: "0px",
};

class C4Element {
  constructor(tagName, options = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.id = options.id || "";
    this.className = options.className || "";
    this.parentElement = null;
    this.children = [];
    this.isConnected = true;
    this.hidden = false;
    this._attrs = { ...(options.attrs || {}) };
    this._rect = options.rect || { x: 0, y: 0, width: 0, height: 0 };
    this._style = { ...C4_BASE_STYLE, ...(options.style || {}) };
    this._inline = { ...(options.inline || {}) };
    this._pseudo = {
      content: "none",
      position: "static",
      top: "auto",
      right: "auto",
      bottom: "auto",
      left: "auto",
      opacity: "1",
      pointerEvents: "auto",
      zIndex: "auto",
      backgroundImage: "none",
      maskImage: "none",
      maskSize: "auto",
      maskRepeat: "repeat",
      ...(options.pseudo || {}),
    };
    this.style = {
      getPropertyValue: (name) => (Object.hasOwn(this._inline, name) ? String(this._inline[name]) : ""),
    };
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return false;
  }

  hasAttribute(name) {
    return Object.hasOwn(this._attrs, name);
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  get clientWidth() {
    return this._rect.width;
  }

  get clientHeight() {
    return this._rect.height;
  }
}

function radii(value) {
  return {
    borderRadius: value,
    borderTopLeftRadius: value,
    borderTopRightRadius: value,
    borderBottomRightRadius: value,
    borderBottomLeftRadius: value,
  };
}

function actualDetailBarProbeOutput() {
  const panel = new C4Element("section", {
    id: "detailPanel",
    className: "panel detail-panel",
    attrs: { "data-spotlight-active": "" },
    rect: { x: 10, y: 10, width: 500, height: 400 },
    style: {
      ...radii("21px"),
      overflowX: "hidden",
      overflowY: "hidden",
      position: "relative",
      isolation: "isolate",
      backgroundImage: "linear-gradient(135deg, #fff, #eee)",
    },
    inline: {
      "--spotlight-x": "120px",
      "--spotlight-y": "130px",
      "--spotlight-radius": "320px",
      "--spotlight-mask": 'url("data:image/svg+xml,mask")',
    },
    pseudo: {
      content: '""',
      position: "absolute",
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: "0px",
      opacity: "1",
      pointerEvents: "none",
      zIndex: "0",
      backgroundImage: "radial-gradient(circle, rgba(10, 20, 30, 0.22), transparent)",
      maskImage: 'url("data:image/svg+xml,spotlight")',
      maskSize: "100% 100%",
      maskRepeat: "no-repeat",
    },
  });
  panel.append(
    new C4Element("div", {
      className: "panel-heading",
      rect: { x: 20, y: 20, width: 460, height: 20 },
      style: { position: "relative", zIndex: "1" },
    }),
  );
  const list = panel.append(
    new C4Element("div", {
      id: "detailList",
      className: "bar-list",
      rect: { x: 20, y: 50, width: 460, height: 300 },
      style: { display: "grid", overflowX: "auto", overflowY: "auto" },
    }),
  );
  const row = list.append(
    new C4Element("div", {
      className: "bar-row",
      rect: { x: 20, y: 60, width: 460, height: 30 },
      style: { display: "grid" },
    }),
  );
  row.append(
    new C4Element("div", {
      className: "bar-label",
      rect: { x: 20, y: 60, width: 460, height: 20 },
      style: { position: "relative", zIndex: "1" },
    }),
  );
  const track = row.append(
    new C4Element("div", {
      className: "bar-track",
      rect: { x: 20, y: 90, width: 460, height: 12 },
      style: {
        ...radii("999px"),
        borderTopWidth: "1px",
        borderRightWidth: "1px",
        borderBottomWidth: "1px",
        borderLeftWidth: "1px",
        overflowX: "hidden",
        overflowY: "hidden",
      },
    }),
  );
  const fill = track.append(
    new C4Element("div", {
      className: "bar-fill",
      rect: { x: 21, y: 91, width: 200, height: 10 },
      style: radii("999px"),
    }),
  );
  const activeHosts = [panel];
  const document = {
    querySelectorAll(selector) {
      if (selector === "#detailPanel") return [panel];
      if (selector === "#detailList") return [list];
      if (selector === "[data-spotlight-active]") return activeHosts;
      return [];
    },
  };
  const window = {
    innerWidth: 1000,
    innerHeight: 700,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    visualViewport: { scale: 1 },
  };
  const getComputedStyle = (element, pseudo) => (pseudo ? element._pseudo : element._style);
  const producer = vm.runInNewContext(`(${probeDetailBarGeometry.toString()})`, {
    window,
    document,
    getComputedStyle,
  });
  return JSON.parse(JSON.stringify(producer(fill)));
}

const HIT_TEST_PHASES = ["beforeNormal", "afterNormal", "hidden", "afterBackground", "restored", "afterVerify"];

function observedHitResult(clip) {
  const points = Array.from({ length: clip.width }, (_, index) => ({
    kind: `pixel-${index}`,
    x: clip.x + index + 0.5,
    y: clip.y + 0.5,
    integer: { x: clip.x + index, y: clip.y },
    dom: { exactFill: true },
    native: { exactFill: true },
  }));
  return {
    status: "observed",
    reason: "",
    scope: "all-center-strip-pixel-centers",
    paintMode: "exact-fill",
    clip: clone(clip),
    points,
  };
}

function activeDetailSpotlightHitResult(clip) {
  const result = observedHitResult(clip);
  result.paintMode = "active-detail";
  for (const point of result.points) {
    point.native = {
      exactFill: false,
      withinFill: false,
      fillConnected: true,
      hitKind: "non-node",
      rejected: false,
      reason: "",
      expectedDetailSpotlight: true,
      top: {
        kind: "non-node",
        constructorName: "CSSPseudoElement",
        type: "::after",
        pseudoType: null,
      },
    };
  }
  return result;
}

function defaultProbeHits({ clip }) {
  return observedHitResult(clip);
}

function captureDetailBarThreeFrames(options) {
  const input = { ...options };
  if (!Object.hasOwn(input, "probeHits")) input.probeHits = defaultProbeHits;
  if (!Object.hasOwn(input, "probeActiveHits")) input.probeActiveHits = defaultProbeHits;
  return captureDetailBarThreeFramesImpl(input);
}

function createHitProbe({ events, decisions = {} } = {}) {
  const calls = [];
  return {
    calls,
    async probeHits(input) {
      const phase = HIT_TEST_PHASES[calls.length];
      calls.push({ phase, ...input, clip: clone(input.clip) });
      events?.push({ type: "hit", phase });
      const decision = decisions[phase];
      if (decision?.throw !== undefined) throw decision.throw;
      return typeof decision?.result === "function"
        ? decision.result(input.clip)
        : (decision?.result ?? observedHitResult(input.clip));
    },
  };
}

function makeProbes(mutate = () => {}) {
  return Array.from({ length: 7 }, (_, index) => {
    const probe = clone(BASE_PROBE);
    mutate(probe, index);
    return probe;
  });
}

function makeActiveProbes(mutate = () => {}) {
  return makeProbes((probe, index) => {
    probe.spotlight = clone(ACTIVE_SPOTLIGHT);
    mutate(probe, index);
  });
}

function createPage({ events, onScreenshot } = {}) {
  const calls = [];
  const page = {
    evaluate: async () => ({ ok: true, count: 0, errors: [], released: true, missing: false }),
    screenshot: async (options) => {
      const index = calls.length + 1;
      calls.push({ index, options: clone(options) });
      events?.push({ type: "screenshot", index });
      if (onScreenshot) return onScreenshot(index, options);
      return Buffer.from(`frame-${index}`);
    },
  };
  return { page, calls };
}

function createFill({
  events,
  probes = makeProbes(),
  beginResult = { status: "hidden" },
  restoreResult = { status: "restored", changed: true, pollution: [] },
  onBegin,
  onRestore,
} = {}) {
  const calls = { probe: 0, begin: 0, restore: 0 };
  let index = 0;
  const fill = {
    evaluate: async (fn) => {
      if (fn === probeDetailBarGeometry) {
        const value = probes[Math.min(index, probes.length - 1)];
        index += 1;
        calls.probe += 1;
        events?.push({ type: "probe", index: calls.probe });
        return clone(value);
      }
      if (fn === beginDetailBarPaintHide) {
        calls.begin += 1;
        events?.push({ type: "begin" });
        return onBegin ? onBegin(calls.begin) : clone(beginResult);
      }
      if (fn === restoreDetailBarPaintHide) {
        calls.restore += 1;
        events?.push({ type: "restore" });
        return onRestore ? onRestore(calls.restore) : clone(restoreResult);
      }
      throw new Error("未预期的 fill.evaluate 函数");
    },
  };
  return { fill, calls };
}

function captureFailure(promise) {
  return promise.then(
    () => {
      throw new Error("预期 capture 失败但成功返回");
    },
    (error) => error,
  );
}

test("三帧顺序、同 clip、同 fill 探针与未验结果", async () => {
  const events = [];
  const { page, calls } = createPage({ events });
  const { fill, calls: fillCalls } = createFill({ events });
  const hitProbe = createHitProbe({ events });

  const result = await captureDetailBarThreeFrames({ page, fill, probeHits: hitProbe.probeHits });

  assert.equal(result.status, "captured-unvalidated", result.reason);
  assert.equal(result.validatedPixels, false);
  assert.equal(result.pixelAnalysis, "not-run");
  assert.deepEqual(result.spotlightAdmission, { status: "inactive", reason: "" });
  assert.equal(result.hitTest.status, "observed");
  assert.equal(result.hitTest.scope, "all-center-strip-pixel-centers");
  assert.deepEqual(Object.keys(result.hitTest.phases), HIT_TEST_PHASES);
  assert.ok(Object.values(result.hitTest.phases).every((entry) => entry.status === "observed"));
  assert.equal(result.roundedAncestorProof, "not-run");
  assert.equal(result.proof.status, "measured");
  assert.equal(result.proof.shapeCount, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].options.clip, calls[0].options.clip);
  assert.deepEqual(calls[2].options.clip, calls[0].options.clip);
  assert.deepEqual(calls[0].options, {
    type: "png",
    fullPage: false,
    scale: "css",
    caret: "initial",
    clip: calls[0].options.clip,
  });
  assert.equal(calls[0].options.clip.height, 1);
  assert.deepEqual(result.frames.normal, Buffer.from("frame-1"));
  assert.deepEqual(result.frames.background, Buffer.from("frame-2"));
  assert.deepEqual(result.frames.verify, Buffer.from("frame-3"));
  assert.equal(result.restoration.attempted, true);
  assert.equal(result.restoration.verified, true);
  assert.equal(fillCalls.probe, 7);
  assert.equal(hitProbe.calls.length, 6);
  assert.deepEqual(
    hitProbe.calls.map((call) => call.phase),
    HIT_TEST_PHASES,
  );
  assert.ok(hitProbe.calls.every((call) => call.page === page && call.fill === fill));
  assert.ok(hitProbe.calls.every((call) => JSON.stringify(call.clip) === JSON.stringify(calls[0].options.clip)));
  assert.deepEqual(
    events.map((entry) =>
      entry.type === "screenshot"
        ? `screenshot:${entry.index}`
        : entry.type === "hit"
          ? `hit:${entry.phase}`
          : entry.type,
    ),
    [
      "probe",
      "probe",
      "hit:beforeNormal",
      "screenshot:1",
      "probe",
      "hit:afterNormal",
      "begin",
      "probe",
      "hit:hidden",
      "screenshot:2",
      "probe",
      "hit:afterBackground",
      "restore",
      "probe",
      "hit:restored",
      "screenshot:3",
      "probe",
      "hit:afterVerify",
    ],
  );
});

test("normal 前 hit 非 observed 时零截图、零 paint 拒绝", async () => {
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill();
  const hitProbe = createHitProbe({
    decisions: {
      beforeNormal: { result: { status: "rejected", reason: "normal-hit-boom", phases: [] } },
    },
  });

  const result = await captureDetailBarThreeFrames({ page, fill, probeHits: hitProbe.probeHits });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "hit-test-not-observed:beforeNormal:normal-hit-boom");
  assert.equal(result.hitTest.status, "rejected");
  assert.deepEqual(Object.keys(result.hitTest.phases), ["beforeNormal"]);
  assert.deepEqual(result.hitTest.phases.beforeNormal, {
    status: "rejected",
    reason: "normal-hit-boom",
    phases: [],
  });
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("任一中心条像素不是 exact fill 时拒绝，即使 probe 返回 observed", async () => {
  const hitProbe = createHitProbe({
    decisions: {
      beforeNormal: {
        result: (clip) => {
          const result = observedHitResult(clip);
          result.points[1].native.exactFill = false;
          return result;
        },
      },
    },
  });
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill();

  const result = await captureDetailBarThreeFrames({ page, fill, probeHits: hitProbe.probeHits });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "hit-test-non-fill:beforeNormal:pixel-1");
  assert.equal(result.hitTest.status, "rejected");
  assert.equal(result.hitTest.scope, "all-center-strip-pixel-centers");
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("paint-hidden 前/后 hit 拒绝仍 finally 恢复", async () => {
  for (const phase of ["hidden", "afterBackground"]) {
    const { page, calls } = createPage();
    const { fill, calls: fillCalls } = createFill();
    const hitProbe = createHitProbe({
      decisions: {
        [phase]: { result: { status: "unmeasured", reason: `${phase}-boom` } },
      },
    });

    const result = await captureDetailBarThreeFrames({ page, fill, probeHits: hitProbe.probeHits });

    assert.equal(result.status, "rejected");
    assert.equal(result.reason, `hit-test-not-observed:${phase}:${phase}-boom`);
    assert.equal(result.hitTest.status, "rejected");
    assert.equal(result.hitTest.phases[phase].status, "unmeasured");
    assert.equal(fillCalls.begin, 1);
    assert.equal(fillCalls.restore, 1);
    assert.equal(result.restoration.attempted, true);
    assert.equal(result.restoration.verified, true);
    assert.equal(calls.length, phase === "hidden" ? 1 : 2);
    if (phase === "hidden") assert.equal(result.frames.background, null);
    else assert.deepEqual(result.frames.background, Buffer.from("frame-2"));
  }
});

test("verify 前 hit 拒绝时保留两帧并已恢复", async () => {
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill();
  const hitProbe = createHitProbe({
    decisions: {
      restored: { result: { status: "rejected", reason: "restored-hit-boom" } },
    },
  });

  const result = await captureDetailBarThreeFrames({ page, fill, probeHits: hitProbe.probeHits });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "hit-test-not-observed:restored:restored-hit-boom");
  assert.equal(calls.length, 2);
  assert.deepEqual(result.frames.normal, Buffer.from("frame-1"));
  assert.deepEqual(result.frames.background, Buffer.from("frame-2"));
  assert.equal(result.frames.verify, null);
  assert.equal(fillCalls.restore, 1);
  assert.equal(result.restoration.verified, true);
  assert.deepEqual(Object.keys(result.hitTest.phases), HIT_TEST_PHASES.slice(0, 5));
});

test("hit probe 抛 null/frozen 保留 capture partial 与原值 cause", async () => {
  const nullHit = createHitProbe({ decisions: { beforeNormal: { throw: null } } });
  const nullPage = createPage();
  const nullFill = createFill();
  const nullError = await captureFailure(
    captureDetailBarThreeFrames({
      page: nullPage.page,
      fill: nullFill.fill,
      probeHits: nullHit.probeHits,
    }),
  );
  assert.equal(nullError.cause, null);
  assert.equal(nullError.detailBarCaptureEvidence.status, "failed");
  assert.equal(nullError.detailBarCaptureEvidence.hitTest.status, "failed");
  assert.equal(nullError.detailBarCaptureEvidence.hitTest.phases.beforeNormal.status, "threw");
  assert.equal(nullPage.calls.length, 0);
  assert.equal(nullFill.calls.begin, 0);
  assert.equal(nullFill.calls.restore, 0);

  const frozen = Object.freeze(new Error("frozen hit boom"));
  const frozenHit = createHitProbe({ decisions: { beforeNormal: { throw: frozen } } });
  const frozenPage = createPage();
  const frozenFill = createFill();
  const frozenError = await captureFailure(
    captureDetailBarThreeFrames({
      page: frozenPage.page,
      fill: frozenFill.fill,
      probeHits: frozenHit.probeHits,
    }),
  );
  assert.notEqual(frozenError, frozen);
  assert.equal(frozenError.cause, frozen);
  assert.equal(frozenError.detailBarCaptureEvidence.status, "failed");
  assert.equal(frozenError.detailBarCaptureEvidence.hitTest.status, "failed");
  assert.equal(frozenError.detailBarCaptureEvidence.hitTest.phases.beforeNormal.status, "threw");
  assert.equal(frozenPage.calls.length, 0);
  assert.equal(frozenFill.calls.restore, 0);
});

test("hidden hit 主错与 restore cleanup 错聚合且保留 helper partial", async () => {
  const hitPartial = {
    status: "failed",
    reason: "native hidden boom",
    points: [{ kind: "left", native: { exactFill: false } }],
    cleanup: { releaseObjectGroup: "released", detach: "detached", stash: "cleared" },
  };
  const hitError = Object.assign(new Error("hidden hit boom"), { detailBarHitEvidence: hitPartial });
  const restoreError = Object.freeze(new Error("hidden restore boom"));
  const hitProbe = createHitProbe({ decisions: { hidden: { throw: hitError } } });
  const { page } = createPage();
  const { fill, calls } = createFill({
    onRestore: () => {
      throw restoreError;
    },
  });

  const error = await captureFailure(captureDetailBarThreeFrames({ page, fill, probeHits: hitProbe.probeHits }));

  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[0], hitError);
  assert.equal(error.errors[1], restoreError);
  const evidence = error.detailBarCaptureEvidence;
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.hitTest.status, "failed");
  assert.equal(evidence.hitTest.phases.hidden, hitPartial);
  assert.deepEqual(evidence.frames.normal, Buffer.from("frame-1"));
  assert.equal(evidence.frames.background, null);
  assert.equal(evidence.restoration.attempted, true);
  assert.equal(evidence.restoration.verified, false);
  assert.equal(calls.restore, 1);
});

test("background 截图失败仍 finally 恢复并保留 normal 帧", async () => {
  const { page } = createPage({
    onScreenshot: (index) => {
      if (index === 2) throw new Error("background boom");
      return Buffer.from(`frame-${index}`);
    },
  });
  const { fill, calls } = createFill();

  const error = await captureFailure(captureDetailBarThreeFrames({ page, fill }));
  assert.match(error.message, /background boom/);
  assert.equal(calls.restore, 1);
  const evidence = error.detailBarCaptureEvidence;
  assert.equal(evidence.status, "failed");
  assert.deepEqual(evidence.frames.normal, Buffer.from("frame-1"));
  assert.equal(evidence.frames.background, null);
  assert.equal(evidence.frames.verify, null);
  assert.equal(evidence.restoration.attempted, true);
  assert.equal(evidence.restoration.verified, true);
});

test("primary 与 restore 双失败聚合，不覆盖 primary", async () => {
  const { page } = createPage({
    onScreenshot: (index) => {
      if (index === 2) throw new Error("background boom");
      return Buffer.from(`frame-${index}`);
    },
  });
  const { fill } = createFill({
    onRestore: () => {
      throw new Error("restore boom");
    },
  });

  const error = await captureFailure(captureDetailBarThreeFrames({ page, fill }));
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.match(error.errors[0].message, /background boom/);
  assert.match(error.errors[1].message, /restore boom/);
  assert.deepEqual(error.detailBarCaptureEvidence.frames.normal, Buffer.from("frame-1"));
  assert.equal(error.detailBarCaptureEvidence.restoration.verified, false);
});

test("截图前后几何变化拒绝，且不进入 paint", async () => {
  const probes = makeProbes((probe, index) => {
    if (index === 2) probe.viewport.height = 601;
  });
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes });

  const result = await captureDetailBarThreeFrames({ page, fill });
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /geometry-drift:afterNormal/);
  assert.deepEqual(result.frames.normal, Buffer.from("frame-1"));
  assert.equal(result.frames.background, null);
  assert.equal(calls.length, 1);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("已知 active detailPanel 层级准入后完成六阶段全中心条与三帧", async () => {
  const probes = makeActiveProbes();
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes });

  const result = await captureDetailBarThreeFrames({ page, fill });
  assert.equal(result.status, "captured-unvalidated", result.reason);
  assert.deepEqual(result.spotlightAdmission, { status: "admitted", reason: "" });
  assert.equal(result.hitTest.status, "observed");
  assert.equal(result.hitTest.scope, "all-center-strip-pixel-centers");
  assert.equal(result.restoration.verified, true);
  assert.equal(calls.length, 3);
  assert.equal(fillCalls.begin, 1);
  assert.equal(fillCalls.restore, 1);
});

test("C21 直接消费实际 C19 producer 的真实顶层聚光字段", async () => {
  const produced = actualDetailBarProbeOutput();
  assert.equal(produced.status, "observed");
  assert.equal(produced.spotlight.backgroundImage.includes("radial-gradient"), true);
  assert.equal(produced.spotlight.maskImage, 'url("data:image/svg+xml,spotlight")');
  assert.equal(produced.spotlight.zIndex, "0");
  assert.equal(Object.hasOwn(produced.spotlight.pseudo, "backgroundImage"), false);
  assert.equal(Object.hasOwn(produced.spotlight.pseudo, "maskImage"), false);
  assert.equal(Object.hasOwn(produced.spotlight.pseudo, "zIndex"), false);

  const probes = Array.from({ length: 7 }, () => clone(produced));
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes });
  const result = await captureDetailBarThreeFrames({ page, fill });

  assert.equal(result.status, "captured-unvalidated", result.reason);
  assert.deepEqual(result.spotlightAdmission, { status: "admitted", reason: "" });
  assert.equal(calls.length, 3);
  assert.equal(fillCalls.begin, 1);
  assert.equal(fillCalls.restore, 1);
});

test("普通态不接受 active expectedDetailSpotlight 例外", async () => {
  const hitProbe = createHitProbe({
    decisions: {
      beforeNormal: { result: activeDetailSpotlightHitResult },
    },
  });
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill();

  const result = await captureDetailBarThreeFrames({ page, fill, probeHits: hitProbe.probeHits });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "hit-test-non-fill:beforeNormal:pixel-0");
  assert.equal(result.hitTest.phases.beforeNormal.points[0].native.exactFill, false);
  assert.equal(result.hitTest.phases.beforeNormal.points[0].native.expectedDetailSpotlight, true);
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("active 普通 overlay 或未证明 origin 的 native 命中仍拒绝", async () => {
  const activeProbe = createHitProbe({
    decisions: {
      beforeNormal: {
        result: (clip) => {
          const result = observedHitResult(clip);
          result.paintMode = "active-detail";
          result.points[0].native = {
            exactFill: false,
            expectedDetailSpotlight: false,
            top: { kind: "element", id: "unexpected-overlay" },
          };
          return result;
        },
      },
    },
  });
  const ordinaryProbe = createHitProbe();
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes: makeActiveProbes() });

  const result = await captureDetailBarThreeFrames({
    page,
    fill,
    probeHits: ordinaryProbe.probeHits,
    probeActiveHits: activeProbe.probeHits,
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "hit-test-non-fill:beforeNormal:pixel-0");
  assert.equal(ordinaryProbe.calls.length, 0);
  assert.equal(activeProbe.calls.length, 1);
  assert.equal(result.hitTest.phases.beforeNormal.points[0].native.exactFill, false);
  assert.equal(result.hitTest.phases.beforeNormal.points[0].native.expectedDetailSpotlight, false);
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("active producer 快照由准入结果选择新入口并保留真实 native 语义", async () => {
  const decisions = Object.fromEntries(
    HIT_TEST_PHASES.map((phase) => [phase, { result: activeDetailSpotlightHitResult }]),
  );
  const activeProbe = createHitProbe({ decisions });
  const ordinaryProbe = createHitProbe();
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes: makeActiveProbes() });

  const result = await captureDetailBarThreeFrames({
    page,
    fill,
    probeHits: ordinaryProbe.probeHits,
    probeActiveHits: activeProbe.probeHits,
  });

  assert.equal(result.status, "captured-unvalidated", result.reason);
  assert.equal(ordinaryProbe.calls.length, 0);
  assert.equal(activeProbe.calls.length, HIT_TEST_PHASES.length);
  assert.deepEqual(
    activeProbe.calls.map((call) => call.phase),
    HIT_TEST_PHASES,
  );
  assert.ok(
    Object.values(result.hitTest.phases).every(
      (phase) =>
        phase.paintMode === "active-detail" &&
        phase.points.every(
          (point) =>
            point.dom.exactFill === true &&
            point.native.exactFill === false &&
            point.native.expectedDetailSpotlight === true,
        ),
    ),
  );
  assert.equal(calls.length, 3);
  assert.equal(fillCalls.begin, 1);
  assert.equal(fillCalls.restore, 1);
  assert.equal(result.restoration.verified, true);
});

test("active 准入后缺少 active probe 接口时零截图、零 paint 拒绝", async () => {
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes: makeActiveProbes() });

  const result = await captureDetailBarThreeFrames({
    page,
    fill,
    probeActiveHits: null,
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "active-hit-probe-missing");
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("active 层级未证明时零截图、零 paint 拒绝", async () => {
  const probes = makeActiveProbes((probe) => {
    probe.spotlight.stack.fill.transform = "translateY(1px)";
  });
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes });

  const result = await captureDetailBarThreeFrames({ page, fill });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "spotlight-admission:spotlight-stack-unproven");
  assert.deepEqual(result.spotlightAdmission, {
    status: "rejected",
    reason: "spotlight-stack-unproven",
  });
  assert.equal(result.hitTest.status, "not-run");
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("throw null/false 保留为 cause 或 AggregateError 成员", async () => {
  const nullPage = createPage({
    onScreenshot: (index) => {
      if (index === 1) throw null;
      return Buffer.from(`frame-${index}`);
    },
  });
  const nullFill = createFill();
  const nullError = await captureFailure(captureDetailBarThreeFrames({ page: nullPage.page, fill: nullFill.fill }));
  assert.equal(nullError.cause, null);
  assert.equal(nullError.detailBarCaptureEvidence.status, "failed");
  assert.equal(nullFill.calls.restore, 0);

  const primaryPage = createPage({
    onScreenshot: (index) => {
      if (index === 2) throw new Error("primary boom");
      return Buffer.from(`frame-${index}`);
    },
  });
  const falseFill = createFill({
    onRestore: () => {
      throw false;
    },
  });
  const falseError = await captureFailure(
    captureDetailBarThreeFrames({ page: primaryPage.page, fill: falseFill.fill }),
  );
  assert.ok(falseError instanceof AggregateError);
  assert.equal(falseError.errors[1], false);
  assert.deepEqual(falseError.detailBarCaptureEvidence.frames.normal, Buffer.from("frame-1"));
});

test("begin 显式 rejected already-hidden 时不 restore 其他事务", async () => {
  const { page } = createPage();
  const { fill, calls } = createFill({ beginResult: { status: "rejected", reason: "already-hidden" } });

  const result = await captureDetailBarThreeFrames({ page, fill });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "paint-hide-rejected:already-hidden");
  assert.equal(result.restoration.attempted, false);
  assert.equal(calls.restore, 0);
});

test("begin 抛错时仍 finally restore", async () => {
  const { page } = createPage();
  const { fill, calls } = createFill({
    onBegin: () => {
      throw new Error("begin boom");
    },
  });

  const error = await captureFailure(captureDetailBarThreeFrames({ page, fill }));
  assert.match(error.message, /begin boom/);
  assert.equal(calls.restore, 1);
  assert.equal(error.detailBarCaptureEvidence.restoration.attempted, true);
  assert.deepEqual(error.detailBarCaptureEvidence.frames.normal, Buffer.from("frame-1"));
});

test("normal/background 返回 null、false 或空 Buffer 均拒绝为失败", async () => {
  for (const value of [null, false, Buffer.alloc(0)]) {
    const normalPage = createPage({ onScreenshot: (index) => (index === 1 ? value : Buffer.from(`frame-${index}`)) });
    const normalFill = createFill();
    const normalError = await captureFailure(
      captureDetailBarThreeFrames({ page: normalPage.page, fill: normalFill.fill }),
    );
    assert.match(normalError.message, /invalid-normal-frame/);
    assert.equal(normalError.detailBarCaptureEvidence.frames.normal, null);
    assert.equal(normalFill.calls.restore, 0);

    const backgroundPage = createPage({
      onScreenshot: (index) => (index === 2 ? value : Buffer.from(`frame-${index}`)),
    });
    const backgroundFill = createFill();
    const backgroundError = await captureFailure(
      captureDetailBarThreeFrames({ page: backgroundPage.page, fill: backgroundFill.fill }),
    );
    assert.match(backgroundError.message, /invalid-background-frame/);
    assert.deepEqual(backgroundError.detailBarCaptureEvidence.frames.normal, Buffer.from("frame-1"));
    assert.equal(backgroundFill.calls.restore, 1);
    assert.equal(backgroundError.detailBarCaptureEvidence.restoration.verified, true);
  }
});

test("不可扩展原始 Error 用 cause 包装并附 partial", async () => {
  const frozen = Object.freeze(new Error("frozen boom"));
  const { page } = createPage({
    onScreenshot: (index) => {
      if (index === 2) throw frozen;
      return Buffer.from(`frame-${index}`);
    },
  });
  const { fill, calls } = createFill();

  const error = await captureFailure(captureDetailBarThreeFrames({ page, fill }));
  assert.notEqual(error, frozen);
  assert.equal(error.cause, frozen);
  assert.match(error.message, /原始错误保留在 cause/);
  assert.deepEqual(error.detailBarCaptureEvidence.frames.normal, Buffer.from("frame-1"));
  assert.equal(calls.restore, 1);
});

test("轴内但圆角外时零截图、零 paint 拒绝", async () => {
  const probes = makeProbes((probe, index) => {
    if (index === 0) {
      probe.clipShapes = [{ rect: { x: 12, y: 24, width: 96, height: 1 }, radius: 0.5, source: "tight-rounded" }];
    }
  });
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes });

  const result = await captureDetailBarThreeFrames({ page, fill });
  assert.equal(result.status, "rejected");
  assert.match(result.reason, /clip-shapes-unproven/);
  assert.equal(result.proof.status, "unmeasured");
  assert.match(result.proof.reason, /圆角/);
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

test("缺少 clipShapes 时零截图、零 paint 拒绝", async () => {
  const probes = makeProbes((probe, index) => {
    if (index === 0) delete probe.clipShapes;
  });
  const { page, calls } = createPage();
  const { fill, calls: fillCalls } = createFill({ probes });

  const result = await captureDetailBarThreeFrames({ page, fill });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "clip-shapes-missing");
  assert.equal(result.proof.status, "unmeasured");
  assert.equal(result.proof.reason, "clip-shapes-missing");
  assert.equal(calls.length, 0);
  assert.equal(fillCalls.begin, 0);
  assert.equal(fillCalls.restore, 0);
});

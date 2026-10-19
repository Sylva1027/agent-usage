import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";

import {
  buildStateReadyWaitSource,
  settleStateEvidenceViewport,
  STATE_MATRIX_GROUPS,
} from "../scripts/skin-palette/capture.mjs";

const HOST_SELECTOR = ".shell .metric[data-spotlight-active]:has(.metric-label:not(:empty))";
const ACTIVE_HOST_SELECTOR = ".shell [data-spotlight-active]";
const DEFAULT_HOST_STYLE = { display: "block", visibility: "visible", opacity: "1" };
const DEFAULT_AFTER_STYLE = {
  content: '""',
  display: "block",
  visibility: "visible",
  opacity: "1",
  backgroundImage: "radial-gradient(circle, rgb(0 0 0 / 0.2), transparent)",
  maskImage: "linear-gradient(black, black)",
};

function createHost(overrides = {}) {
  const rect = overrides.rect ?? { x: 0, y: 0, width: 120, height: 48 };
  return {
    isConnected: overrides.isConnected ?? true,
    getBoundingClientRect: () => rect,
    getClientRects: () => (rect.width > 0 && rect.height > 0 ? [rect] : []),
  };
}

function runSpotlightReady({
  selector = HOST_SELECTOR,
  matches,
  activeHosts,
  host = createHost(),
  hostStyle = DEFAULT_HOST_STYLE,
  afterStyle = DEFAULT_AFTER_STYLE,
  styleError,
  queryError,
} = {}) {
  const selected = matches ?? [host];
  const active = activeHosts ?? [host];
  const document = {
    querySelectorAll(value) {
      if (queryError) throw queryError;
      if (value === selector) return selected;
      if (value === ACTIVE_HOST_SELECTOR) return active;
      return [];
    },
  };
  const getComputedStyle = (_node, pseudo) => {
    if (styleError) throw styleError;
    return pseudo === "::after" ? afterStyle : hostStyle;
  };
  return vm.runInNewContext(buildStateReadyWaitSource({ kind: "spotlightHost", selector }), {
    document,
    getComputedStyle,
  });
}

test("spotlightHost ready requires one live, visible masked host with a fully opaque after layer", () => {
  assert.equal(runSpotlightReady(), true);
  assert.throws(() => buildStateReadyWaitSource({ kind: "spotlightHost" }), /需要 selector/);

  for (const afterStyle of [
    { ...DEFAULT_AFTER_STYLE, content: "none" },
    { ...DEFAULT_AFTER_STYLE, opacity: "0.99" },
    { ...DEFAULT_AFTER_STYLE, backgroundImage: "none" },
    { ...DEFAULT_AFTER_STYLE, backgroundImage: undefined },
    { ...DEFAULT_AFTER_STYLE, maskImage: "none" },
    { ...DEFAULT_AFTER_STYLE, maskImage: undefined },
  ]) {
    assert.equal(runSpotlightReady({ afterStyle }), false);
  }

  const host = createHost();
  assert.equal(runSpotlightReady({ matches: [host, createHost()], activeHosts: [host] }), false);
  assert.equal(runSpotlightReady({ host, activeHosts: [host, createHost()] }), false);
  assert.equal(runSpotlightReady({ host, activeHosts: [createHost()] }), false);
  assert.equal(runSpotlightReady({ host: createHost({ isConnected: false }) }), false);
  assert.equal(runSpotlightReady({ host: createHost({ rect: { x: 0, y: 0, width: 0, height: 48 } }) }), false);
  assert.equal(runSpotlightReady({ hostStyle: { ...DEFAULT_HOST_STYLE, display: "none" } }), false);
  assert.equal(runSpotlightReady({ hostStyle: { ...DEFAULT_HOST_STYLE, visibility: "hidden" } }), false);
  assert.equal(runSpotlightReady({ hostStyle: { ...DEFAULT_HOST_STYLE, opacity: "0" } }), false);
  assert.equal(runSpotlightReady({ styleError: new Error("computed style failed") }), false);
  assert.equal(runSpotlightReady({ queryError: new Error("invalid selector") }), false);
  assert.equal(runSpotlightReady({ matches: [] }), false);
});

test("existing ready kinds keep their previous boolean behavior", () => {
  const node = { getBoundingClientRect: () => ({ width: 20, height: 10 }) };
  const context = {
    document: {
      querySelector: () => node,
      querySelectorAll: () => [{ textContent: "-" }, { textContent: "12" }],
    },
    getComputedStyle: () => ({ visibility: "visible" }),
  };
  assert.equal(vm.runInNewContext(buildStateReadyWaitSource({ kind: "matches", selector: ".ready" }), context), true);
  assert.equal(vm.runInNewContext(buildStateReadyWaitSource({ kind: "exists", selector: ".ready" }), context), true);
  assert.equal(vm.runInNewContext(buildStateReadyWaitSource({ kind: "visible", selector: ".ready" }), context), true);
  assert.equal(
    vm.runInNewContext(buildStateReadyWaitSource({ kind: "nonZeroText", selector: ".metric strong" }), context),
    true,
  );
  assert.equal(
    vm.runInNewContext(buildStateReadyWaitSource({ kind: "dataCount", selector: "tbody tr", min: 2 }), context),
    true,
  );
});

function createFakePage({ scrollError, paintError } = {}) {
  const events = [];
  const scroll = { x: 17, y: 420 };
  const window = {
    get scrollX() {
      return scroll.x;
    },
    get scrollY() {
      return scroll.y;
    },
    scrollTo(x, y) {
      events.push("scrollTo");
      if (scrollError) throw scrollError;
      scroll.x = x;
      scroll.y = y;
    },
  };
  const page = {
    async evaluate(source) {
      if (source.includes("window.scrollTo")) {
        events.push("scroll-evaluate");
        return vm.runInNewContext(source, { window });
      }
      events.push("paint-evaluate");
      if (paintError) throw paintError;
      return await vm.runInNewContext(source, {
        requestAnimationFrame(callback) {
          events.push("raf");
          callback();
        },
      });
    },
  };
  return { page, events, scroll };
}

test("evidence viewport helper preserves only explicit opt-ins, settles after scrolling, and propagates errors", async () => {
  assert.deepEqual(
    STATE_MATRIX_GROUPS.flatMap((group) => group.units)
      .filter((unit) => unit.preserveTriggerViewport === true)
      .map((unit) => unit.id),
    [
      "button-hover",
      "spotlight-metric-label",
      "spotlight-timeline-heading",
      "spotlight-detail-bars",
      "spotlight-detail-fill",
    ],
  );

  const s6 = STATE_MATRIX_GROUPS.find((group) => group.id === "S6");
  const metricUnit = s6.units.find((unit) => unit.id === "spotlight-metric-label");
  const timelineUnit = s6.units.find((unit) => unit.id === "spotlight-timeline-heading");
  const detailUnit = s6.units.find((unit) => unit.id === "spotlight-detail-bars");
  const fillUnit = s6.units.find((unit) => unit.id === "spotlight-detail-fill");
  assert.deepEqual(
    s6.units.slice(-4).map((unit) => unit.id),
    ["spotlight-metric-label", "spotlight-timeline-heading", "spotlight-detail-bars", "spotlight-detail-fill"],
  );
  assert.deepEqual(metricUnit, {
    id: "spotlight-metric-label",
    kind: "catalog",
    stateId: "spotlight-metric-label",
    clipSelector: ".metric:has(> #totalTokens)",
    preserveTriggerViewport: true,
    preSteps: [
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
      { action: "setSpotlight", value: "off" },
    ],
  });
  assert.deepEqual(fillUnit, {
    id: "spotlight-detail-fill",
    kind: "catalog",
    stateId: "spotlight-detail-fill",
    clipSelector: "#detailPanel",
    preserveTriggerViewport: true,
    preSteps: [
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
      { action: "click", selector: '#timelineModes [data-timeline-mode="channel"]' },
      { action: "setSpotlight", value: "off" },
    ],
  });
  assert.deepEqual(timelineUnit, {
    id: "spotlight-timeline-heading",
    kind: "catalog",
    stateId: "spotlight-timeline-heading",
    clipSelector: ".chart-panel",
    preserveTriggerViewport: true,
    preSteps: [
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
      { action: "setSpotlight", value: "off" },
    ],
  });
  assert.deepEqual(detailUnit, {
    id: "spotlight-detail-bars",
    kind: "catalog",
    stateId: "spotlight-detail-bars",
    clipSelector: "#detailPanel",
    preserveTriggerViewport: true,
    preSteps: [
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
      { action: "click", selector: '#timelineModes [data-timeline-mode="channel"]' },
      { action: "setSpotlight", value: "off" },
    ],
  });

  const preserved = createFakePage();
  await settleStateEvidenceViewport(preserved.page, { preserveTriggerViewport: true });
  assert.deepEqual(preserved.scroll, { x: 17, y: 420 });
  assert.deepEqual(preserved.events, ["paint-evaluate", "raf", "raf"]);

  const defaulted = createFakePage();
  await settleStateEvidenceViewport(defaulted.page, {});
  assert.deepEqual(defaulted.scroll, { x: 0, y: 0 });
  assert.deepEqual(defaulted.events, ["scroll-evaluate", "scrollTo", "paint-evaluate", "raf", "raf"]);

  const unexpectedTruthy = createFakePage();
  await settleStateEvidenceViewport(unexpectedTruthy.page, { preserveTriggerViewport: 1 });
  assert.deepEqual(unexpectedTruthy.scroll, { x: 0, y: 0 });

  const scrollError = new Error("scroll failed");
  const failedScroll = createFakePage({ scrollError });
  await assert.rejects(settleStateEvidenceViewport(failedScroll.page, {}), (error) => error === scrollError);
  assert.deepEqual(failedScroll.events, ["scroll-evaluate", "scrollTo"]);

  const paintError = new Error("paint failed");
  const failedPaint = createFakePage({ paintError });
  await assert.rejects(
    settleStateEvidenceViewport(failedPaint.page, { preserveTriggerViewport: true }),
    (error) => error === paintError,
  );
  assert.deepEqual(failedPaint.events, ["paint-evaluate"]);
});

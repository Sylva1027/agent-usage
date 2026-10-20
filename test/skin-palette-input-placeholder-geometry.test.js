import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { measureBrowserRoles } from "../scripts/skin-palette/browser-measure.mjs";
import { ROLE_CATALOG } from "../scripts/skin-palette/roles.mjs";

const POLICY = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
const PLACEHOLDER_ROLE = ROLE_CATALOG.find((role) => role.id === "input.placeholder");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NATIVE_STAGES = [
  "initial",
  "after-hide",
  "band-scroll",
  "before-png",
  "after-png",
  "after-scan",
  "restore",
  "verify",
];
const HOST_CLIENT = { left: 1, top: 1, width: 178, height: 34 };
const HOST_STYLE = {
  fontSize: "14px",
  fontFamily: "sans-serif",
  fontWeight: "400",
  lineHeight: "18px",
  paddingTop: "8px",
  paddingRight: "10px",
  paddingBottom: "8px",
  paddingLeft: "10px",
  borderTopWidth: "1px",
  borderRightWidth: "1px",
  borderBottomWidth: "1px",
  borderLeftWidth: "1px",
  direction: "ltr",
  writingMode: "horizontal-tb",
  display: "inline-block",
  visibility: "visible",
  opacity: "1",
  transform: "none",
  textFillColor: "rgb(35, 49, 60)",
  textShadow: "none",
};
const PLACEHOLDER_STYLE = {
  fontSize: "14px",
  fontFamily: "sans-serif",
  fontWeight: "400",
  lineHeight: "18px",
  display: "inline",
  visibility: "visible",
  opacity: "1",
  textFillColor: "rgb(112, 120, 128)",
  textShadow: "none",
};
const NATIVE_STYLE = {
  webkitTextFillColor: "rgb(112, 120, 128)",
  textShadow: "none",
  visibility: "visible",
  opacity: "1",
};

assert.ok(PLACEHOLDER_ROLE, "role catalog must contain input.placeholder");

function nodeRect(index, absoluteY) {
  return { x: 20 + index, y: absoluteY, width: 180, height: 36 };
}

function probeNode(index, absoluteY) {
  return {
    index,
    identityId: index + 1,
    text: `input-${index}`,
    tag: "input",
    id: index === 0 ? "modelComparisonSearch" : "repositoryComparisonSearch",
    className: "search-control",
    hostType: "input",
    inputType: "search",
    rect: nodeRect(index, absoluteY),
    client: { ...HOST_CLIENT },
    textRects: [nodeRect(index, absoluteY)],
    hasValue: false,
    hasPlaceholder: true,
    usesPlaceholder: true,
    isSvg: false,
    computed: {
      color: "rgb(0, 0, 0)",
      fontSize: "14px",
      fontWeight: "400",
      opacity: "1",
      textShadow: "none",
      textFillColor: "",
      visibility: "visible",
      display: "block",
      backgroundColor: "rgba(0, 0, 0, 0)",
      backgroundImage: "none",
    },
    pseudo: {
      color: "rgb(0, 0, 0)",
      opacity: "0.76",
      fontSize: "13px",
      textFillColor: "",
    },
    chain: [
      {
        tag: "div",
        opacity: "1",
        filter: "none",
        mixBlendMode: "normal",
        backdropFilter: "none",
      },
    ],
    scroll: { x: 0, y: 0 },
    dpr: 1,
  };
}

function parseCssColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    const channels =
      digits.length === 3
        ? [...digits].map((digit) => Number.parseInt(digit + digit, 16) / 255)
        : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)].map((pair) => Number.parseInt(pair, 16) / 255);
    return [...channels, 1];
  }
  const functional = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (!functional) return null;
  const parts = functional[1].split(",").map((part) => Number.parseFloat(part));
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return [parts[0] / 255, parts[1] / 255, parts[2] / 255, parts.length > 3 ? parts[3] : 1];
}

function scanResult() {
  const pixels = (rgba) => new Array(8).fill(0).flatMap(() => rgba);
  return {
    width: 220,
    height: 24,
    scale: { x: 1, y: 1 },
    regions: [
      { id: "text-0-0", columns: 2, rows: 1, origin: { x: 0, y: 0 }, pixels: pixels([255, 255, 255, 255]) },
      { id: "text-1-0", columns: 2, rows: 1, origin: { x: 0, y: 0 }, pixels: pixels([255, 255, 255, 255]) },
    ],
  };
}

function executeInputPlaceholderFunction(functionDeclaration, thisValue, args = []) {
  const fn = runInNewContext(`(${functionDeclaration})`, {});
  return structuredClone(fn.apply(thisValue, args));
}

function stableFunctionResult(callback) {
  const source = callback.toString();
  if (source.includes("new Map()") && source.includes("__skinScreenshotStyleGuard_")) {
    return { ok: true, count: 0 };
  }
  if (source.includes("snapshot.elements instanceof Map")) {
    return { missing: false, released: true, ok: true, errors: [] };
  }
  if (source.includes("const metrics = (element)")) {
    const metrics = {
      clientWidth: 1280,
      clientHeight: 800,
      offsetWidth: 1280,
      offsetHeight: 800,
      scrollWidth: 1280,
      scrollHeight: 800,
      rect: { x: 0, y: 0, width: 1280, height: 800 },
    };
    return {
      viewport: {
        innerWidth: 1280,
        innerHeight: 800,
        visualWidth: 1280,
        visualHeight: 800,
        visualOffsetLeft: 0,
        visualOffsetTop: 0,
        visualScale: 1,
      },
      scroll: { x: 0, y: 0 },
      html: metrics,
      body: metrics,
      elements: [],
      inline: {
        styleAttributePresent: false,
        styleAttributeValue: null,
        cssText: "",
        gutterValue: "",
        gutterPriority: "",
        computedGutter: "auto",
      },
    };
  }
  if (source.includes("declarationRestored")) {
    return { declarationRestored: true, attributeBoundaryRestored: true };
  }
  if (source.includes("window.scrollTo")) return undefined;
  if (source.includes("requestAnimationFrame")) return undefined;
  assert.fail(`unexpected function evaluation: ${source.slice(0, 120)}`);
}

function createInputPlaceholderPage({
  nodes,
  scrollYForIndex,
  reprobeIdentity = (index) => nodes[index].identityId,
  reprobeRectOffset = () => ({ x: 0, y: 0 }),
  stageVariant = () => ({}),
}) {
  const scroll = { x: 0, y: 0 };
  const bringCalls = [];
  const stageCalls = [];
  const stageIndexes = new Map();
  let currentIndex = 0;
  let attempt = 0;
  let nextNativeStage = null;

  const shiftedRect = (rect) => ({ ...rect, x: rect.x - scroll.x, y: rect.y - scroll.y });
  const nodeAt = (index, { useReprobeIdentity = false } = {}) => {
    const source = nodes[index];
    if (!source) return null;
    const rect = shiftedRect(source.rect);
    if (useReprobeIdentity) {
      const offset = reprobeRectOffset(index, attempt, source);
      rect.x += offset.x;
      rect.y += offset.y;
    }
    return {
      ...source,
      identityId: useReprobeIdentity ? reprobeIdentity(index, attempt, source) : source.identityId,
      rect,
      textRects: [rect],
      computed: { ...source.computed },
      pseudo: { ...source.pseudo },
      chain: source.chain.map((entry) => ({ ...entry })),
      scroll: { ...scroll },
    };
  };
  const styleState = (stage) => {
    const hidden = !["initial", "restore", "verify"].includes(stage);
    return {
      hidden,
      host: {
        ...HOST_STYLE,
        webkitTextFillColor: hidden ? "transparent" : HOST_STYLE.textFillColor,
        textShadow: hidden ? "none" : HOST_STYLE.textShadow,
      },
      placeholder: {
        ...PLACEHOLDER_STYLE,
        webkitTextFillColor: hidden ? "transparent" : PLACEHOLDER_STYLE.textFillColor,
        textShadow: hidden ? "none" : PLACEHOLDER_STYLE.textShadow,
      },
      native: {
        ...NATIVE_STYLE,
        ...(hidden ? { webkitTextFillColor: "transparent", textShadow: "none" } : {}),
      },
    };
  };

  const cdpObjects = (index, stage) => {
    const node = nodeAt(index);
    const variant = stageVariant(index, stage, attempt) ?? {};
    const styles = styleState(stage);
    const host = {
      tagName: "INPUT",
      type: "search",
      value: "",
      placeholder: "搜索模型",
      isConnected: true,
      selectionStart: 0,
      selectionEnd: 0,
      selectionDirection: "none",
      clientLeft: HOST_CLIENT.left,
      clientTop: HOST_CLIENT.top,
      clientWidth: HOST_CLIENT.width,
      clientHeight: HOST_CLIENT.height,
      getBoundingClientRect() {
        const rect = node.rect;
        const offset = variant.hostRectOffset ?? { x: 0, y: 0 };
        return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
      },
    };
    const nativeParent = { isConnected: true, ownerDocument: null };
    const nativeText = {
      nodeType: 3,
      nodeValue: "搜索模型",
      isConnected: true,
      parentElement: nativeParent,
      getRootNode: () => ({ host }),
    };
    const view = {
      scrollX: scroll.x,
      scrollY: scroll.y,
      getComputedStyle(target, pseudo) {
        if (target === host && pseudo === "::placeholder") return styles.placeholder;
        if (target === host) return styles.host;
        if (target === nativeParent) return styles.native;
        throw new Error("unexpected native placeholder style target");
      },
    };
    const document = {
      activeElement: host,
      defaultView: view,
      fonts: { status: "loaded" },
    };
    host.ownerDocument = document;
    nativeParent.ownerDocument = document;
    return { host, nativeText, variant };
  };

  const describedFor = (index, variant) => {
    const hostBackendNodeId = variant.hostBackendNodeId ?? index + 1;
    const candidateBackendNodeId = variant.candidateBackendNodeId ?? index + 101;
    return {
      backendNodeId: hostBackendNodeId,
      nodeType: 1,
      nodeName: "INPUT",
      shadowRoots: [
        {
          backendNodeId: index + 201,
          nodeType: 11,
          nodeName: "#shadow-root",
          shadowRootType: "user-agent",
          children: [
            {
              backendNodeId: index + 301,
              nodeType: 1,
              nodeName: "DIV",
              children: [
                {
                  backendNodeId: candidateBackendNodeId,
                  nodeType: 3,
                  nodeName: "#text",
                  nodeValue: "搜索模型",
                },
              ],
            },
          ],
        },
      ],
    };
  };

  const sessionFor = (index, stage) => {
    const objects = cdpObjects(index, stage);
    const objectsById = {
      [`host-object-${index}`]: objects.host,
      [`ua-text-${index}`]: objects.nativeText,
    };
    return {
      async send(method, params) {
        if (method === "Runtime.evaluate") {
          const nodeIndex = Number(/elements\[(\d+)\]/.exec(params.expression)?.[1]);
          assert.equal(nodeIndex, index);
          return { result: { objectId: `host-object-${index}` } };
        }
        if (method === "Runtime.callFunctionOn") {
          const target = objectsById[params.objectId];
          assert.ok(target, `unexpected CDP objectId ${params.objectId}`);
          const args = (params.arguments ?? []).map((entry) => objectsById[entry.objectId] ?? entry.value);
          return {
            result: {
              value: executeInputPlaceholderFunction(params.functionDeclaration, target, args),
            },
          };
        }
        if (method === "DOM.describeNode") return { node: describedFor(index, objects.variant) };
        if (method === "DOM.resolveNode") return { object: { objectId: `ua-text-${index}` } };
        if (method === "DOM.getContentQuads") {
          const rect = objects.host.getBoundingClientRect();
          const offset = { x: 11, y: 9, width: 64, height: 17, ...(objects.variant.quadOffset ?? {}) };
          return {
            quads: [
              [
                rect.x + offset.x,
                rect.y + offset.y,
                rect.x + offset.x + offset.width,
                rect.y + offset.y,
                rect.x + offset.x + offset.width,
                rect.y + offset.y + offset.height,
                rect.x + offset.x,
                rect.y + offset.y + offset.height,
              ],
            ],
          };
        }
        if (method === "Runtime.releaseObjectGroup") return {};
        throw new Error(`unexpected native placeholder CDP method: ${method}`);
      },
      async detach() {},
    };
  };

  const page = {
    async evaluate(source) {
      if (typeof source === "function") return stableFunctionResult(source);
      const tag = /\/\/ skinProbe: ([\w-]+)/.exec(String(source))?.[1];
      if (tag === "viewport") {
        return { width: 1280, height: 800, scrollX: scroll.x, scrollY: scroll.y, dpr: 1 };
      }
      if (tag === "spotlight-stability") {
        return {
          stable: true,
          reason: null,
          budgetMs: 500,
          waitedMs: 0,
          frameCount: 4,
          transitionsWaited: 0,
          initial: [],
          settled: [],
        };
      }
      if (tag === "compare-images") return { identical: true, differingPixels: 0, maxChannelDelta: 0, bbox: null };
      if (tag === "node-probe") {
        const trackIdentities = source.includes("const state = true ?");
        if (trackIdentities) attempt += 1;
        return {
          nodes: nodes.map((_, index) => nodeAt(index, { useReprobeIdentity: !trackIdentities })),
          ...(trackIdentities ? { attemptToken: `native-attempt-${attempt}` } : {}),
        };
      }
      if (tag === "color-parse") {
        const embedded = /const value = ("(?:[^"\\]|\\.)*");/.exec(source)?.[1];
        const value = embedded ? JSON.parse(embedded) : null;
        const rgba = parseCssColor(value);
        return rgba
          ? { ok: true, rgb: rgba.slice(0, 3), alpha: rgba[3], readBack: value }
          : { ok: false, reason: `无法解析颜色 ${String(value)}` };
      }
      if (tag === "bring-into-view") {
        const index = Number(/querySelectorAll\((.*?)\)\[(\d+)\]/.exec(source)?.[2]);
        assert.ok(Number.isInteger(index), "bring-into-view must target an input index");
        currentIndex = index;
        scroll.x = 0;
        scroll.y = scrollYForIndex(index);
        bringCalls.push({ index, scroll: { ...scroll } });
        return { ok: true, scrolled: true, scroll: { ...scroll } };
      }
      if (tag === "scroll-begin") return { ok: true, alreadyActive: false, movedContainers: 0 };
      if (tag === "scroll-by") return { ...scroll };
      if (tag === "scroll-to") return { ...scroll };
      if (tag === "scroll-restore") {
        scroll.x = 0;
        scroll.y = 0;
        return { ok: true, restored: true, mismatches: [] };
      }
      if (tag === "release-attempt") {
        scroll.x = 0;
        scroll.y = 0;
        return { ok: true, restoredTargets: 1, releasedSessions: 1, attemptReleased: true };
      }
      if (tag === "hide") {
        return {
          ok: true,
          token: `native-hide-${attempt}-${currentIndex}`,
          originals: { "-webkit-text-fill-color": "", "text-shadow": "none" },
          identityId: nodes[currentIndex].identityId,
          isolation: { isolated: true, remaining: [] },
        };
      }
      if (tag === "restore") {
        nextNativeStage = "restore";
        return { ok: true, identityValid: true, inlineRestored: true, restoreErrors: [] };
      }
      if (tag === "verify") {
        nextNativeStage = "verify";
        const node = nodeAt(currentIndex);
        return {
          ok: true,
          identityValid: true,
          inlineRestored: true,
          restoreErrors: [],
          after: {
            color: node.computed.color,
            textFillColor: node.computed.textFillColor,
            textShadow: node.computed.textShadow,
            backgroundColor: node.computed.backgroundColor,
            opacity: node.computed.opacity,
            rect: node.rect,
          },
        };
      }
      if (tag === "scan") return scanResult();
      if (tag === "occlusion-probe") {
        const index = Number(/const index = ([-0-9.]+);/.exec(source)?.[1]);
        const rects = JSON.parse(/const rects = (.*);/.exec(source)?.[1] ?? "[]");
        const sourceNode = nodes[index];
        const kinds = ["center", "topLeft", "topRight", "bottomLeft", "bottomRight"];
        return {
          identityValid: true,
          scroll: { ...scroll },
          rects: rects.map((rect, rectIndex) => ({
            rectIndex,
            points: kinds.map((kind, pointIndex) => ({
              kind,
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2,
              top: {
                identityId: sourceNode.identityId,
                tag: "input",
                id: sourceNode.id,
                className: sourceNode.className,
                hostType: "input",
                inputType: "search",
              },
              withinHost: true,
              pointIndex,
            })),
          })),
        };
      }
      throw new TypeError(`unexpected skinProbe tag: ${tag}`);
    },
    async screenshot() {
      return PNG;
    },
    context() {
      return {
        newCDPSession: async () => {
          const stage = nextNativeStage ?? NATIVE_STAGES[stageIndexes.get(`${attempt}:${currentIndex}`) ?? 0];
          assert.ok(stage, `native placeholder stage overflow for input ${currentIndex}`);
          if (nextNativeStage) nextNativeStage = null;
          else
            stageIndexes.set(`${attempt}:${currentIndex}`, (stageIndexes.get(`${attempt}:${currentIndex}`) ?? 0) + 1);
          stageCalls.push({ attempt, index: currentIndex, stage });
          return sessionFor(currentIndex, stage);
        },
      };
    },
  };

  return {
    page,
    bringCalls,
    stageCalls,
    run: () =>
      measureBrowserRoles({
        page,
        candidate: null,
        mode: "light",
        stateId: "dashboard-default",
        roleCatalog: [PLACEHOLDER_ROLE],
        policy: POLICY,
      }),
  };
}

test("sequential offscreen placeholder inputs bind the second input to its live viewport geometry", async () => {
  const fixture = createInputPlaceholderPage({
    nodes: [probeNode(0, 50), probeNode(1, 1035.015625)],
    scrollYForIndex: (index) => (index === 0 ? 0 : 513),
  });
  const result = await fixture.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.result, "pass", record.reason);
  assert.equal(evidence.measuredCount, 2);
  const secondInitial = evidence.nodes[1].nativePlaceholder.stages[0];
  assert.equal(secondInitial.resolverEvidence.before.rect.y, 522.015625);
  assert.equal(secondInitial.resolverEvidence.before.scroll.y, 513);
  assert.equal(secondInitial.rect.y, 531.015625);
  assert.deepEqual(
    fixture.stageCalls.filter((call) => call.index === 1 && call.attempt === 1).map((call) => call.stage),
    NATIVE_STAGES,
  );
  assert.ok(
    fixture.bringCalls.some((call, index) => {
      const firstSecondStage = fixture.stageCalls.findIndex((stage) => stage.index === 1 && stage.attempt === 1);
      return call.index === 1 && index < firstSecondStage;
    }),
    "the second input must be brought into view before its initial CDP binding",
  );
});

test("real document geometry drift during bring-into-view remains rejected", async () => {
  const fixture = createInputPlaceholderPage({
    nodes: [probeNode(0, 50), probeNode(1, 1035.015625)],
    scrollYForIndex: (index) => (index === 0 ? 0 : 513),
    reprobeRectOffset: (index) => (index === 1 ? { x: 0, y: 2 } : { x: 0, y: 0 }),
  });
  const result = await fixture.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.result, "unmeasured");
  assert.equal(evidence.sampleInvalid, true);
  assert.equal(evidence.attempts, 2);
  assert.equal(evidence.nativePlaceholderBinding.expected.documentRect.y, 1035.015625);
  assert.equal(evidence.nativePlaceholderBinding.live.documentRect.y, 1037.015625);
  assert.ok(fixture.stageCalls.every((call) => call.index === 0));
});

test("real layout drift after the live binding remains unmeasured", async () => {
  const fixture = createInputPlaceholderPage({
    nodes: [probeNode(0, 50), probeNode(1, 1035.015625)],
    scrollYForIndex: (index) => (index === 0 ? 0 : 513),
    stageVariant: (index, stage) => (index === 1 && stage === "initial" ? { hostRectOffset: { x: 0, y: 1 } } : {}),
  });
  const result = await fixture.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);
  const second = evidence.nodes.find((node) => node.index === 1);

  assert.equal(record.result, "unmeasured");
  assert.match(second.rejectedReason, /原 input 几何与调用参数不一致/);
  assert.equal(second.nativePlaceholder.phase, "initial");
  assert.equal(second.nativePlaceholder.status, "unmeasured");
  assert.equal(second.nativePlaceholder.reason, "原 input 几何与调用参数不一致");
});

test("replaced input identity is still rejected before CDP sampling", async () => {
  const fixture = createInputPlaceholderPage({
    nodes: [probeNode(0, 50), probeNode(1, 1035.015625)],
    scrollYForIndex: (index) => (index === 0 ? 0 : 513),
    reprobeIdentity: (index, attempt, source) => (index === 1 ? source.identityId + 100 + attempt : source.identityId),
  });
  const result = await fixture.run();
  const record = result.records[0];
  const evidence = JSON.parse(record.evidence);

  assert.equal(record.result, "unmeasured");
  assert.equal(evidence.sampleInvalid, true);
  assert.equal(evidence.attempts, 2);
  assert.equal(evidence.index, 1);
  assert.equal(evidence.nativePlaceholderBinding?.expected.identity.identityId, 2);
  assert.ok(evidence.nativePlaceholderBinding?.live.identity.identityId > 100);
  assert.ok(
    fixture.stageCalls.every((call) => call.index === 0),
    "the replaced second input must not enter native CDP sampling",
  );
});

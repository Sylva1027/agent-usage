import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  beginDetailBarPaintHide,
  restoreDetailBarPaintHide,
} from "../scripts/skin-palette/detail-bar-paint-browser.mjs";

const STASH_KEY = "__codexSkinDetailBarPaintHideV1__";

const BASE_STYLE = {
  display: "block",
  visibility: "visible",
  opacity: "1",
  position: "static",
  zIndex: "auto",
  isolation: "auto",
  backgroundColor: "rgba(0, 0, 0, 0)",
  boxShadow: "none",
  backgroundImage: "none",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  filter: "none",
  backdropFilter: "none",
  maskImage: "none",
  mixBlendMode: "normal",
  transform: "none",
};

class FakeStyle {
  constructor(entries = [], onWrite = () => {}) {
    this._entries = new Map();
    this.throwOn = null;
    this.throwOnRemove = null;
    this.throwValue = undefined;
    this.partialWriteOn = null;
    this._onWrite = onWrite;
    for (const [name, value, priority = ""] of entries) {
      this._entries.set(name, { value: String(value), priority });
    }
  }

  get length() {
    return this._entries.size;
  }

  getPropertyValue(name) {
    return this._entries.get(name)?.value ?? "";
  }

  getPropertyPriority(name) {
    return this._entries.get(name)?.priority ?? "";
  }

  setProperty(name, value, priority = "") {
    if (this.partialWriteOn === name) {
      this.partialWriteOn = null;
      this._onWrite();
      this._entries.set(name, { value: String(value), priority: String(priority) });
      throw this._failure(`setProperty(${name}) 写入后注入失败`);
    }
    if (this.throwOn === name) {
      this.throwOn = null;
      throw this._failure(`setProperty(${name}) 注入失败`);
    }
    this._onWrite();
    this._entries.set(name, { value: String(value), priority: String(priority) });
  }

  removeProperty(name) {
    if (this.throwOnRemove === name) {
      this.throwOnRemove = null;
      throw this._failure(`removeProperty(${name}) 注入失败`);
    }
    this._onWrite();
    const previous = this._entries.get(name)?.value ?? "";
    this._entries.delete(name);
    return previous;
  }

  _failure(message) {
    const value = this.throwValue;
    this.throwValue = undefined;
    return value === undefined ? new Error(message) : value;
  }

  *[Symbol.iterator]() {
    yield* this._entries.keys();
  }

  snapshot() {
    return Array.from(this._entries, ([name, entry]) => [name, entry.value, entry.priority]);
  }
}

class FakeElement {
  constructor(tagName, options = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.id = options.id || "";
    this.className = options.className || "";
    this.parentElement = null;
    this.children = [];
    this.isConnected = options.isConnected ?? true;
    this.hidden = options.hidden ?? false;
    this._attrs = { ...(options.attrs || {}) };
    this.style = new FakeStyle(options.style || [], () => {
      if (!Object.hasOwn(this._attrs, "style")) this._attrs.style = "";
    });
    if (options.styleAttribute === true) this._attrs.style = "";
    this._style = { ...BASE_STYLE, ...(options.computed || {}) };
    this._pseudo = {
      "::before": {
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
        transitionProperty: "all",
        transitionDuration: "0s",
        mixBlendMode: "normal",
        filter: "none",
        ...(options.before || {}),
      },
      "::after": {
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
        transitionProperty: "all",
        transitionDuration: "0s",
        mixBlendMode: "normal",
        filter: "none",
        ...(options.after || {}),
      },
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
    if (name === "hidden") return this.hidden;
    return Object.hasOwn(this._attrs, name);
  }

  removeAttribute(name) {
    delete this._attrs[name];
  }
}

function createWorld(options = {}) {
  const panel = new FakeElement("section", {
    id: "detailPanel",
    className: "detail-panel",
    style: options.panelStyle || [],
    computed: options.panelComputed || {},
    before: options.panelBefore || {},
    after: options.panelAfter || {},
    attrs: options.panelAttrs || {},
  });
  const list = new FakeElement("div", { id: "detailList", className: "bar-list" });
  const row = new FakeElement("div", { className: "bar-row" });
  const track = new FakeElement("div", { className: "bar-track" });
  const fill = new FakeElement("div", {
    className: "bar-fill",
    style: options.fillStyle || [],
    styleAttribute: options.styleAttribute ?? true,
    computed: options.fillComputed || {},
    before: options.before || {},
    after: options.after || {},
  });
  panel.append(list);
  list.append(row);
  row.append(track);
  track.append(fill);

  const panels = [panel];
  const lists = [list];
  const spotlights = [];
  const document = {
    querySelectorAll(selector) {
      if (selector === "#detailPanel") return panels;
      if (selector === "#detailList") return lists;
      if (selector === "[data-spotlight-active]") return spotlights;
      throw new Error(`未预期的选择器：${selector}`);
    },
  };
  const getComputedStyle = (element, pseudo) => {
    if (pseudo) return element._pseudo[pseudo];
    return { ...BASE_STYLE, ...element._style };
  };
  return {
    fill,
    row,
    track,
    list,
    panel,
    panels,
    lists,
    spotlights,
    document,
    getComputedStyle,
    context: { document, getComputedStyle },
  };
}

function activateSpotlight(world, overrides = {}) {
  world.panel._attrs["data-spotlight-active"] = "";
  world.spotlights.splice(0, world.spotlights.length, world.panel);
  Object.assign(world.panel._style, { isolation: "isolate", position: "relative" }, overrides.host || {});
  const variables = {
    "--spotlight-x": "120px",
    "--spotlight-y": "130px",
    "--spotlight-radius": "320px",
    "--spotlight-mask": 'url("data:image/svg+xml,mask")',
    ...(overrides.variables || {}),
  };
  for (const [name, value] of Object.entries(variables)) world.panel.style.setProperty(name, value);
  Object.assign(
    world.panel._pseudo["::after"],
    {
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
    overrides.pseudo || {},
  );
  return world;
}

function run(world, fn, ...args) {
  const isolated = vm.runInNewContext(`(${fn.toString()})`, world.context);
  return JSON.parse(JSON.stringify(isolated(...args)));
}

function begin(world, fill = world.fill) {
  return run(world, beginDetailBarPaintHide, fill);
}

function restore(world, fill = world.fill) {
  return run(world, restoreDetailBarPaintHide, fill);
}

test("含 !important 的原有背景值精确恢复，无关 inline 声明保留", () => {
  const world = createWorld({
    fillStyle: [
      ["background-color", "rgb(1, 2, 3)", "important"],
      ["width", "42%"],
    ],
  });

  assert.deepEqual(begin(world), {
    status: "hidden",
    token: "detail-bar-paint-hide-v1",
    background: { hadStyle: true, value: "rgb(1, 2, 3)", priority: "important" },
    unrelatedCount: 1,
  });
  assert.equal(world.fill.style.getPropertyValue("background-color"), "transparent");
  assert.equal(world.fill.style.getPropertyPriority("background-color"), "important");
  assert.equal(world.fill.style.getPropertyValue("width"), "42%");

  const result = restore(world);
  assert.equal(result.status, "restored");
  assert.equal(result.changed, true);
  assert.deepEqual(result.background, { hadStyle: true, value: "rgb(1, 2, 3)", priority: "important" });
  assert.deepEqual(result.pollution, []);
  assert.equal(world.fill.style.getPropertyValue("background-color"), "rgb(1, 2, 3)");
  assert.equal(world.fill.style.getPropertyPriority("background-color"), "important");
  assert.equal(world.fill.style.getPropertyValue("width"), "42%");
  assert.equal(world.fill.hasAttribute("style"), true);
  assert.equal(world.context[STASH_KEY], undefined);
});

test("无原属性时移除空 style 属性；有 style 属性但无背景时保留属性", () => {
  const bare = createWorld({ styleAttribute: false });
  assert.equal(begin(bare).status, "hidden");
  assert.equal(bare.fill.hasAttribute("style"), true);
  const bareResult = restore(bare);
  assert.equal(bareResult.status, "restored");
  assert.equal(bare.fill.style.getPropertyValue("background-color"), "");
  assert.equal(bare.fill.style.length, 0);
  assert.equal(bare.fill.hasAttribute("style"), false);

  const styled = createWorld({ fillStyle: [["width", "42%"]] });
  assert.equal(begin(styled).status, "hidden");
  assert.equal(restore(styled).status, "restored");
  assert.equal(styled.fill.style.getPropertyValue("background-color"), "");
  assert.equal(styled.fill.style.getPropertyValue("width"), "42%");
  assert.equal(styled.fill.hasAttribute("style"), true);
});

test("唯一合法 active #detailPanel 只隐藏 fill，并保存完整聚光快照与原始 host 链", () => {
  const world = activateSpotlight(
    createWorld({
      fillStyle: [
        ["background-color", "rgb(4, 5, 6)", "important"],
        ["width", "42%"],
      ],
    }),
  );
  const pseudoBefore = JSON.stringify(world.panel._pseudo["::after"]);
  const panelStyleBefore = JSON.stringify(world.panel.style.snapshot());

  assert.deepEqual(begin(world), {
    status: "hidden",
    token: "detail-bar-paint-hide-v1",
    background: { hadStyle: true, value: "rgb(4, 5, 6)", priority: "important" },
    unrelatedCount: 1,
    spotlight: { status: "observed", activeHostCount: 1, activeHostIsPanel: true },
  });
  assert.equal(world.fill.style.getPropertyValue("background-color"), "transparent");
  assert.equal(JSON.stringify(world.panel._pseudo["::after"]), pseudoBefore);
  assert.equal(JSON.stringify(world.panel.style.snapshot()), panelStyleBefore);

  const stash = world.context[STASH_KEY];
  assert.equal(stash.spotlight.nodes.panel, world.panel);
  assert.equal(stash.spotlight.nodes.list, world.list);
  assert.equal(stash.spotlight.nodes.row, world.row);
  assert.equal(stash.spotlight.nodes.track, world.track);
  assert.equal(stash.spotlight.snapshot.host.isolation, "isolate");
  assert.equal(stash.spotlight.snapshot.pseudo.maskSize, "100% 100%");
  assert.equal(
    JSON.stringify(stash.spotlight.snapshot.variables),
    JSON.stringify({
      x: "120px",
      y: "130px",
      radius: "320px",
      mask: 'url("data:image/svg+xml,mask")',
    }),
  );

  const result = restore(world);
  assert.equal(result.status, "restored");
  assert.deepEqual(result.spotlight, { verified: true, pollution: [] });
  assert.equal(world.fill.style.getPropertyValue("background-color"), "rgb(4, 5, 6)");
  assert.equal(world.fill.style.getPropertyPriority("background-color"), "important");
  assert.equal(JSON.stringify(world.panel._pseudo["::after"]), pseudoBefore);
  assert.equal(JSON.stringify(world.panel.style.snapshot()), panelStyleBefore);
  assert.equal(world.context[STASH_KEY], undefined);
});

test("active 错 host、聚光不稳定、mask 不可读或 host 链断开均在写入前拒绝", () => {
  const cases = [
    ["wrong-host", (world) => world.spotlights.push(world.fill), /spotlight-active: active host/],
    ["isolation", (world) => activateSpotlight(world, { host: { isolation: "auto" } }), /spotlight-active: 聚光/],
    ["opacity", (world) => activateSpotlight(world, { pseudo: { opacity: "0.5" } }), /spotlight-active: 聚光/],
    ["mask", (world) => activateSpotlight(world, { pseudo: { maskImage: "none" } }), /spotlight-active: 聚光/],
    [
      "radius",
      (world) => activateSpotlight(world, { variables: { "--spotlight-radius": "0px" } }),
      /spotlight-active: 聚光/,
    ],
    [
      "host-chain",
      (world) => {
        activateSpotlight(world);
        world.list.isConnected = false;
      },
      /spotlight-active: host 链/,
    ],
  ];

  for (const [name, arrange, reason] of cases) {
    const world = createWorld({ fillStyle: [["background-color", "rgb(9, 9, 9)"]] });
    arrange(world);
    const before = JSON.stringify(world.fill.style.snapshot());
    const result = begin(world);
    assert.equal(result.status, "rejected", name);
    assert.match(result.reason, reason);
    assert.equal(JSON.stringify(world.fill.style.snapshot()), before);
    assert.equal(world.context[STASH_KEY], undefined);
  }
});

test("恢复时 mask/变量变化保留外部值并报污染，不偷偷恢复聚光", () => {
  const world = activateSpotlight(createWorld({ fillStyle: [["background-color", "rgb(7, 8, 9)"]] }));
  assert.equal(begin(world).status, "hidden");
  world.panel._pseudo["::after"].maskImage = 'url("changed-image")';
  world.panel.style.setProperty("--spotlight-mask", 'url("changed-variable")');

  const result = restore(world);
  assert.equal(result.status, "restored-with-pollution");
  assert.notEqual(result.status, "restored");
  assert.equal(result.spotlight.verified, false);
  assert.equal(world.fill.style.getPropertyValue("background-color"), "rgb(7, 8, 9)");
  assert.equal(world.panel._pseudo["::after"].maskImage, 'url("changed-image")');
  assert.equal(world.panel.style.getPropertyValue("--spotlight-mask"), 'url("changed-variable")');
  assert.equal(
    result.pollution.some((entry) => entry.name === "spotlight.pseudo.maskImage"),
    true,
  );
  assert.equal(
    result.pollution.some((entry) => entry.name === "spotlight.variables.mask"),
    true,
  );
  assert.equal(world.context[STASH_KEY], undefined);
});

test("恢复前 host 被替换时保留替换结果、恢复旧 fill 并明确污染", () => {
  const world = activateSpotlight(createWorld({ fillStyle: [["background-color", "rgb(3, 2, 1)"]] }));
  assert.equal(begin(world).status, "hidden");
  const replacement = new FakeElement("section", {
    id: "detailPanel",
    className: "detail-panel",
    attrs: { "data-spotlight-active": "" },
  });
  world.panels.splice(0, 1, replacement);
  world.spotlights.splice(0, 1, replacement);
  for (const node of [world.panel, world.list, world.row, world.track, world.fill]) node.isConnected = false;

  const result = restore(world);
  assert.equal(result.status, "restored-with-pollution");
  assert.equal(result.spotlight.verified, false);
  assert.equal(world.fill.style.getPropertyValue("background-color"), "rgb(3, 2, 1)");
  assert.equal(world.panels[0], replacement);
  assert.equal(world.spotlights[0], replacement);
  assert.equal(
    result.pollution.some((entry) => entry.name.startsWith("spotlight.chain.")),
    true,
  );
  assert.equal(world.context[STASH_KEY], undefined);
});

test("拒绝条件在写入 style 前发生，且不留下 stash", () => {
  const cases = [
    [(world) => world.spotlights.push(world.fill), /spotlight-active/],
    [(world) => (world.fill.isConnected = false), /已连接/],
    [(world) => (world.fill.className = "not-fill"), /\.bar-fill/],
    [(world) => (world.track.className = "not-track"), /\.bar-track/],
    [(world) => (world.row.className = "not-row"), /\.bar-row/],
    [(world) => (world.list.hidden = true), /hidden/],
    [(world) => (world.fill._style.boxShadow = "0 2px 4px #000"), /shadow/],
    [(world) => (world.fill._style.backgroundImage = "linear-gradient(red, blue)"), /background-image/],
    [(world) => (world.fill._style.borderTopWidth = "1px"), /边框/],
    [(world) => (world.fill._style.paddingLeft = "2px"), /padding/],
    [(world) => (world.fill._style.filter = "blur(1px)"), /filter/],
    [(world) => (world.fill._style.backdropFilter = "blur(1px)"), /backdrop-filter/],
    [(world) => (world.fill._style.maskImage = 'url("mask")'), /mask/],
    [(world) => (world.fill._style.mixBlendMode = "multiply"), /blend/],
    [(world) => (world.fill._pseudo["::before"].content = '"x"'), /::before/],
    [(world) => (world.fill._pseudo["::after"].backgroundImage = "url(icon)"), /::after/],
  ];

  for (const [arrange, reason] of cases) {
    const world = createWorld({ fillStyle: [["background-color", "rgb(9, 9, 9)"]] });
    const before = JSON.stringify(world.fill.style.snapshot());
    arrange(world);
    const result = begin(world);
    assert.equal(result.status, "rejected");
    assert.match(result.reason, reason);
    assert.equal(JSON.stringify(world.fill.style.snapshot()), before);
    assert.equal(world.context[STASH_KEY], undefined);
  }
});

test("double begin、换节点 begin/restore 均显式拒绝", () => {
  const world = createWorld({ fillStyle: [["background-color", "rgb(1, 2, 3)"]] });
  assert.equal(begin(world).status, "hidden");
  assert.match(begin(world).reason, /already-hidden/);
  assert.equal(world.fill.style.getPropertyValue("background-color"), "transparent");

  const otherTrack = new FakeElement("div", { className: "bar-track" });
  const otherFill = new FakeElement("div", { className: "bar-fill" });
  world.row.append(otherTrack);
  otherTrack.append(otherFill);

  assert.match(begin(world, otherFill).reason, /another-fill-active/);
  assert.match(restore(world, otherFill).reason, /wrong-fill/);
  assert.equal(otherFill.style.length, 0);
  assert.equal(restore(world).status, "restored");
  assert.equal(begin(world, otherFill).status, "hidden");
  assert.equal(restore(world, otherFill).status, "restored");
});

test("恢复异常保留 stash 可重试，隐藏期间的无关变化保留并报污染", () => {
  const world = createWorld({ fillStyle: [["width", "42%"]] });
  assert.equal(begin(world).status, "hidden");
  world.fill.style.setProperty("height", "10px", "important");
  world.fill.style.throwOnRemove = "background-color";

  assert.throws(() => restore(world), /恢复失败/);
  assert.notEqual(world.context[STASH_KEY], undefined);
  assert.equal(world.fill.style.getPropertyValue("background-color"), "transparent");

  const result = restore(world);
  assert.equal(result.status, "restored-with-pollution");
  assert.equal(result.changed, true);
  assert.deepEqual(result.pollution, [{ name: "height", before: null, after: "10px\u0000important" }]);
  assert.equal(world.fill.style.getPropertyValue("background-color"), "");
  assert.equal(world.fill.style.getPropertyValue("width"), "42%");
  assert.equal(world.fill.style.getPropertyValue("height"), "10px");
  assert.equal(world.context[STASH_KEY], undefined);

  const again = restore(world);
  assert.equal(again.status, "restored");
  assert.equal(again.changed, false);
});

test("begin 部分写入后抛错且首次回滚失败时保留 stash，restore 可重试", () => {
  const world = createWorld({ fillStyle: [["background-color", "rgb(4, 5, 6)", "important"]] });
  world.fill.style.partialWriteOn = "background-color";
  world.fill.style.throwOn = "background-color";

  assert.throws(() => begin(world), /隐藏写入失败且回滚失败/);
  assert.notEqual(world.context[STASH_KEY], undefined);
  assert.equal(world.fill.style.getPropertyValue("background-color"), "transparent");

  const result = restore(world);
  assert.equal(result.status, "restored");
  assert.equal(world.fill.style.getPropertyValue("background-color"), "rgb(4, 5, 6)");
  assert.equal(world.fill.style.getPropertyPriority("background-color"), "important");
  assert.equal(world.context[STASH_KEY], undefined);
});

test("throw null/false 时原始值作为 cause 保留，begin/restore 均不二次包装成字符串", () => {
  for (const thrown of [null, false]) {
    const world = createWorld({ styleAttribute: false });
    world.fill.style.throwOn = "background-color";
    world.fill.style.throwValue = thrown;

    assert.throws(
      () => begin(world),
      (error) => error?.cause === thrown && world.context[STASH_KEY] === undefined,
    );
    assert.equal(world.fill.hasAttribute("style"), false);
    assert.equal(world.fill.style.length, 0);

    const hidden = createWorld({ styleAttribute: false });
    assert.equal(begin(hidden).status, "hidden");
    hidden.fill.style.throwOnRemove = "background-color";
    hidden.fill.style.throwValue = thrown;
    assert.throws(
      () => restore(hidden),
      (error) => error?.cause === thrown && hidden.context[STASH_KEY] !== undefined,
    );
    assert.equal(restore(hidden).status, "restored");
  }
});

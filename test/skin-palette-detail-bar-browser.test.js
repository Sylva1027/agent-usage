import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { probeDetailBarGeometry } from "../scripts/skin-palette/detail-bar-browser.mjs";

const BASE_STYLE = {
  display: "block",
  visibility: "visible",
  opacity: "1",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  backgroundImage: "none",
  transform: "none",
  translate: "none",
  rotate: "none",
  zoom: "1",
  scale: "none",
  overflowX: "visible",
  overflowY: "visible",
  borderTopLeftRadius: "0px",
  borderTopRightRadius: "0px",
  borderBottomRightRadius: "0px",
  borderBottomLeftRadius: "0px",
  borderRadius: "0px",
  boxShadow: "none",
  position: "static",
  zIndex: "auto",
  isolation: "auto",
  filter: "none",
  mixBlendMode: "normal",
};

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
    this._rect = { x: 0, y: 0, width: 0, height: 0, ...(options.rect || {}) };
    this._style = { ...BASE_STYLE, ...(options.style || {}) };
    this._inline = { ...(options.inline || {}) };
    this._pseudo = {
      backgroundImage: "none",
      maskImage: "none",
      zIndex: "auto",
      content: "none",
      position: "static",
      top: "auto",
      right: "auto",
      bottom: "auto",
      left: "auto",
      opacity: "1",
      pointerEvents: "auto",
      maskSize: "auto",
      maskRepeat: "repeat",
      ...(options.pseudo || {}),
    };
    this.style = {
      getPropertyValue: (name) => (Object.hasOwn(this._inline, name) ? String(this._inline[name]) : ""),
    };
    this.scrollLeft = options.scrollLeft ?? 0;
    this.scrollTop = options.scrollTop ?? 0;
    this.scrollWidth = options.scrollWidth ?? this._rect.width;
    this.scrollHeight = options.scrollHeight ?? this._rect.height;
    this.scrollbarWidth = options.scrollbarWidth ?? 0;
    this.scrollbarHeight = options.scrollbarHeight ?? 0;
    this._clientWidth = options.clientWidth ?? null;
    this._clientHeight = options.clientHeight ?? null;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return false;
  }

  hasAttribute(name) {
    if (name === "hidden") return this.hidden;
    return Object.hasOwn(this._attrs, name);
  }

  removeAttribute(name) {
    delete this._attrs[name];
  }

  getBoundingClientRect() {
    return {
      left: this._rect.x,
      top: this._rect.y,
      width: this._rect.width,
      height: this._rect.height,
    };
  }

  get clientWidth() {
    if (this._clientWidth !== null) return this._clientWidth;
    return Math.max(
      0,
      Math.round(this._rect.width - this._borderWidth("left") - this._borderWidth("right") - this.scrollbarWidth),
    );
  }

  set clientWidth(value) {
    this._clientWidth = value;
  }

  get clientHeight() {
    if (this._clientHeight !== null) return this._clientHeight;
    return Math.max(
      0,
      Math.round(this._rect.height - this._borderWidth("top") - this._borderWidth("bottom") - this.scrollbarHeight),
    );
  }

  set clientHeight(value) {
    this._clientHeight = value;
  }

  _borderWidth(side) {
    const value = Number.parseFloat(this._style[`border${side[0].toUpperCase()}${side.slice(1)}Width`]);
    return Number.isFinite(value) ? value : 0;
  }
}

function setRect(element, x, y, width, height) {
  element._rect = { x, y, width, height };
  element.scrollWidth = width;
  element.scrollHeight = height;
  element._clientWidth = null;
  element._clientHeight = null;
}

function setRadii(element, value) {
  for (const property of [
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomRightRadius",
    "borderBottomLeftRadius",
  ]) {
    element._style[property] = value;
  }
  element._style.borderRadius = value;
}

function createWorld() {
  const html = new FakeElement("html", { rect: { x: 0, y: 0, width: 800, height: 600 } });
  const body = html.append(new FakeElement("body", { rect: { x: 0, y: 0, width: 800, height: 600 } }));
  const panel = body.append(
    new FakeElement("section", {
      id: "detailPanel",
      className: "panel detail-panel",
      rect: { x: 10, y: 10, width: 500, height: 400 },
      style: {
        overflowX: "hidden",
        overflowY: "hidden",
        borderRadius: "18px",
        backgroundImage: "linear-gradient(135deg, #fff, #eee)",
        position: "relative",
        isolation: "isolate",
      },
      attrs: { "data-spotlight-active": true },
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
        backgroundImage: "radial-gradient(circle, rgba(0,0,0,.1), transparent)",
        maskImage: 'url("data:image/svg+xml,spotlight")',
        zIndex: "0",
        opacity: "1",
        pointerEvents: "none",
        maskSize: "100% 100%",
        maskRepeat: "no-repeat",
      },
    }),
  );
  const heading = panel.append(
    new FakeElement("div", {
      className: "panel-heading",
      rect: { x: 20, y: 15, width: 460, height: 25 },
      style: { position: "relative", zIndex: "1" },
    }),
  );
  const list = panel.append(
    new FakeElement("div", {
      id: "detailList",
      className: "bar-list",
      rect: { x: 20, y: 50, width: 460, height: 300 },
      style: { overflowX: "auto", overflowY: "auto" },
    }),
  );
  const row = list.append(
    new FakeElement("div", {
      className: "bar-row",
      rect: { x: 20, y: 60, width: 460, height: 30 },
    }),
  );
  row.append(
    new FakeElement("div", {
      className: "bar-label",
      rect: { x: 20, y: 60, width: 460, height: 20 },
      style: { position: "relative", zIndex: "1" },
    }),
  );
  const track = row.append(
    new FakeElement("div", {
      className: "bar-track",
      rect: { x: 20, y: 90, width: 460, height: 12 },
      style: {
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
    new FakeElement("div", {
      className: "bar-fill",
      rect: { x: 21, y: 91, width: 200, height: 10 },
      style: {
        borderTopLeftRadius: "999px",
        borderTopRightRadius: "999px",
        borderBottomRightRadius: "999px",
        borderBottomLeftRadius: "999px",
        borderRadius: "999px",
      },
    }),
  );

  const panels = [panel];
  const lists = [list];
  const activeHosts = [panel];
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    visualViewport: { scale: 1 },
  };
  const document = {
    querySelectorAll(selector) {
      if (selector === "#detailPanel") return panels;
      if (selector === "#detailList") return lists;
      if (selector === "[data-spotlight-active]") return activeHosts;
      return [];
    },
  };
  const getComputedStyle = (element, pseudo) => (pseudo ? element._pseudo : element._style);

  return {
    html,
    body,
    panel,
    heading,
    list,
    row,
    label: row.children[0],
    track,
    fill,
    panels,
    lists,
    activeHosts,
    window,
    document,
    getComputedStyle,
    context: { window, document, getComputedStyle },
  };
}

function probe(world) {
  const isolatedProbe = vm.runInNewContext(`(${probeDetailBarGeometry.toString()})`, world.context);
  return JSON.parse(JSON.stringify(isolatedProbe(world.fill)));
}

test("独立 VM 求值可读长胶囊，且保留真实半径与结构", () => {
  const world = createWorld();
  const isolatedProbe = vm.runInNewContext(`(${probeDetailBarGeometry.toString()})`, world.context);
  const result = JSON.parse(JSON.stringify(isolatedProbe(world.fill)));

  assert.equal(result.status, "observed");
  assert.deepEqual(result.fillRect, { x: 21, y: 91, width: 200, height: 10 });
  assert.deepEqual(result.visibleRect, { x: 21, y: 91, width: 458, height: 10 });
  assert.equal(result.cssRadius, 999);
  assert.equal(result.radius, 5);
  assert.deepEqual(result.rawRadii, {
    topLeft: "999px",
    topRight: "999px",
    bottomRight: "999px",
    bottomLeft: "999px",
  });
  assert.equal(result.rowIndex, 0);
  assert.equal(result.structure.fill, "div.bar-fill");
  assert.equal(result.viewport.dpr, 1);
});

test("C19 聚光快照保留旧字段并读取 pseudo、host、变量与必要 stack 字段", () => {
  const result = probe(createWorld());

  assert.equal(result.status, "observed");
  assert.equal(result.spotlight.active, true);
  assert.equal(result.spotlight.backgroundImage, "radial-gradient(circle, rgba(0,0,0,.1), transparent)");
  assert.equal(result.spotlight.maskImage, 'url("data:image/svg+xml,spotlight")');
  assert.equal(result.spotlight.zIndex, "0");
  assert.equal(result.spotlight.activeHostCount, 1);
  assert.equal(result.spotlight.activeHostIsPanel, true);
  assert.equal(result.spotlight.pseudo.content, '""');
  assert.deepEqual(result.spotlight.pseudo.inset, {
    top: "0px",
    right: "0px",
    bottom: "0px",
    left: "0px",
  });
  assert.equal(result.spotlight.pseudo.pointerEvents, "none");
  assert.equal(result.spotlight.host.isolation, "isolate");
  assert.equal(result.spotlight.host.position, "relative");
  assert.equal(result.spotlight.x, "120px");
  assert.equal(result.spotlight.y, "130px");
  assert.equal(result.spotlight.radius, "320px");
  assert.equal(result.spotlight.mask, 'url("data:image/svg+xml,mask")');
  assert.equal(result.spotlight.stack.heading.source, "div.panel-heading");
  assert.equal(result.spotlight.stack.labels.length, 1);
  assert.equal(result.spotlight.stack.labels[0].source, "div.bar-label");
  assert.equal(result.spotlight.stack.fill.position, "static");
  assert.equal(result.spotlight.stack.track.zIndex, "auto");
});

test("C19 多 active host 或 panel 之外的 active host 明确 unmeasured", () => {
  const multiple = createWorld();
  multiple.activeHosts.push(
    new FakeElement("div", {
      attrs: { "data-spotlight-active": true },
    }),
  );
  const multipleResult = probe(multiple);
  assert.equal(multipleResult.status, "unmeasured");
  assert.match(multipleResult.reason, /active host/);

  const wrong = createWorld();
  wrong.panel.removeAttribute("data-spotlight-active");
  wrong.activeHosts.splice(
    0,
    1,
    new FakeElement("div", {
      attrs: { "data-spotlight-active": true },
    }),
  );
  const wrongResult = probe(wrong);
  assert.equal(wrongResult.status, "unmeasured");
  assert.match(wrongResult.reason, /active host/);
});

test("C19 inactive 聚光历史形态保持可测，缺字段明确 unmeasured", () => {
  const inactive = createWorld();
  inactive.panel.removeAttribute("data-spotlight-active");
  inactive.activeHosts.length = 0;
  inactive.panel._inline = {};
  Object.assign(inactive.panel._pseudo, {
    content: "none",
    position: "static",
    top: "auto",
    right: "auto",
    bottom: "auto",
    left: "auto",
    backgroundImage: "none",
    maskImage: "none",
    zIndex: "auto",
    opacity: "1",
    pointerEvents: "auto",
    maskSize: "auto",
    maskRepeat: "repeat",
  });
  const inactiveResult = probe(inactive);
  assert.equal(inactiveResult.status, "observed");
  assert.equal(inactiveResult.spotlight.active, false);
  assert.equal(inactiveResult.spotlight.activeHostCount, 0);
  assert.equal(inactiveResult.spotlight.activeHostIsPanel, false);
  assert.equal(inactiveResult.spotlight.backgroundImage, "none");
  assert.equal(inactiveResult.spotlight.maskImage, "none");
  assert.equal(inactiveResult.spotlight.zIndex, "auto");
  assert.equal(inactiveResult.spotlight.x, "");
  assert.equal(inactiveResult.spotlight.stack.labels.length, 1);

  const missing = createWorld();
  delete missing.panel._pseudo.maskSize;
  const missingResult = probe(missing);
  assert.equal(missingResult.status, "unmeasured");
  assert.match(missingResult.reason, /聚光字段/);
});

test("窄竖胶囊按 min(radius,width/2,height/2) 归一化", () => {
  const world = createWorld();
  setRect(world.track, 20, 90, 8, 16);
  setRect(world.fill, 21, 91, 6, 14);

  const result = probe(world);
  assert.equal(result.status, "observed");
  assert.equal(result.cssRadius, 999);
  assert.equal(result.radius, 3);
  assert.deepEqual(result.visibleRect, { x: 21, y: 91, width: 6, height: 14 });
});

test("fractional 坐标按各轴实际 client 区域裁切并保留小数", () => {
  const world = createWorld();
  setRect(world.panel, 10.5, 20.5, 500.25, 300.75);
  setRect(world.list, 12.5, 40.25, 410.5, 200.2);
  world.list._style.borderLeftWidth = "2.5px";
  world.list._style.borderRightWidth = "2.5px";
  world.list._style.borderTopWidth = "2.5px";
  world.list._style.borderBottomWidth = "2.5px";
  setRect(world.track, 28, 50, 500, 14);
  setRect(world.fill, 29.25, 51.25, 300.5, 11.5);

  const result = probe(world);
  assert.equal(result.status, "observed");
  assert.equal(world.list.clientWidth, 406);
  assert.equal(result.fillRect.x, 29.25);
  assert.equal(result.fillRect.y, 51.25);
  assert.deepEqual(result.visibleRect, { x: 29, y: 51, width: 391.5, height: 12 });
  assert.equal(result.radius, 5.75);
  assert.equal(
    result.clipSources.some((source) => source.source === "div#detailList.bar-list"),
    true,
  );
});

test("overflow 仅在实际裁切轴生效", () => {
  const world = createWorld();
  setRect(world.list, 12.5, 100, 410.5, 50);
  world.list._style.overflowX = "auto";
  world.list._style.overflowY = "visible";
  setRect(world.track, 28, 50, 500, 14);
  setRect(world.fill, 29, 51, 300, 12);

  const result = probe(world);
  assert.equal(result.status, "observed");
  assert.deepEqual(result.visibleRect, { x: 29, y: 51, width: 394, height: 12 });
});

test("滚动条或无法解释的 client 缩小时明确拒绝，不拿整数尺寸冒充 fractional 裁切", () => {
  const vertical = createWorld();
  vertical.list.scrollbarWidth = 15;
  const verticalResult = probe(vertical);
  assert.equal(vertical.list.clientWidth, 445);
  assert.equal(verticalResult.status, "unmeasured");
  assert.match(verticalResult.reason, /滚动条|clientWidth/);

  const horizontal = createWorld();
  horizontal.list.scrollbarHeight = 12;
  const horizontalResult = probe(horizontal);
  assert.equal(horizontalResult.status, "unmeasured");
  assert.match(horizontalResult.reason, /滚动条|clientHeight/);

  const shrunk = createWorld();
  shrunk.list.clientWidth = 400;
  const shrunkResult = probe(shrunk);
  assert.equal(shrunkResult.status, "unmeasured");
  assert.match(shrunkResult.reason, /client 区域缩小/);
});

test("百分比、椭圆与四角不一致的圆角均明确拒绝", () => {
  const cases = [
    (world) => setRadii(world.fill, "50%"),
    (world) => {
      setRadii(world.fill, "10px");
      world.fill._style.borderTopLeftRadius = "10px 20px";
    },
    (world) => {
      setRadii(world.fill, "10px");
      world.fill._style.borderBottomLeftRadius = "9px";
    },
  ];

  for (const arrange of cases) {
    const world = createWorld();
    arrange(world);
    const result = probe(world);
    assert.equal(result.status, "unmeasured");
    assert.match(result.reason, /圆角/);
  }
});

test("结构、连通性、唯一宿主与 hidden 状态错误明确拒绝", () => {
  const disconnected = createWorld();
  disconnected.fill.isConnected = false;
  assert.match(probe(disconnected).reason, /已连接/);

  const duplicatePanel = createWorld();
  duplicatePanel.panels.push(new FakeElement("section", { id: "detailPanel" }));
  assert.match(probe(duplicatePanel).reason, /#detailPanel 必须唯一/);

  const duplicateList = createWorld();
  duplicateList.lists.push(new FakeElement("div", { id: "detailList" }));
  assert.match(probe(duplicateList).reason, /#detailList 必须唯一/);

  const hidden = createWorld();
  hidden.list.hidden = true;
  assert.match(probe(hidden).reason, /hidden/);

  const wrongParent = createWorld();
  wrongParent.row.className = "not-a-row";
  assert.match(probe(wrongParent).reason, /\.bar-row/);
});

test("零面积、dpr、transform、zoom、自绘背景与边框均拒绝", () => {
  const zeroArea = createWorld();
  setRect(zeroArea.fill, 21, 91, 0, 10);
  assert.match(probe(zeroArea).reason, /面积为零/);

  const highDpr = createWorld();
  highDpr.window.devicePixelRatio = 2;
  assert.match(probe(highDpr).reason, /dpr 必须为 1/);

  const transformedTrack = createWorld();
  transformedTrack.track._style.transform = "matrix(1, 0, 0, 1, 2, 0)";
  assert.match(probe(transformedTrack).reason, /transform=/);

  const zoomedBody = createWorld();
  zoomedBody.body._style.zoom = "1.25";
  assert.match(probe(zoomedBody).reason, /zoom=/);

  const gradientFill = createWorld();
  gradientFill.fill._style.backgroundImage = "linear-gradient(90deg, red, blue)";
  assert.match(probe(gradientFill).reason, /background-image/);

  const borderedFill = createWorld();
  borderedFill.fill._style.borderTopWidth = "1px";
  assert.match(probe(borderedFill).reason, /自带边框/);

  const paddedFill = createWorld();
  paddedFill.fill._style.paddingLeft = "2px";
  assert.match(probe(paddedFill).reason, /自带 padding/);
});

test("独立 CSS translate/rotate 即使不进入 computed transform 也拒绝", () => {
  const translated = createWorld();
  translated.track._style.translate = "12px 0";
  assert.match(probe(translated).reason, /translate=/);

  const rotated = createWorld();
  rotated.track._style.rotate = "45deg";
  assert.match(probe(rotated).reason, /rotate=/);
});

test("滚动到视口外的行返回 unmeasured，不伪造 C3 可用几何", () => {
  const world = createWorld();
  setRect(world.list, 20, 100, 460, 100);
  world.list.scrollTop = 240;
  setRect(world.track, 20, 50, 460, 12);
  setRect(world.fill, 21, 51, 200, 10);

  const result = probe(world);
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /无可见面积|不可见/);
});

test("rowIndex 从实际直接行集合取得，且读取不修改 DOM/CSS/滚动", () => {
  const world = createWorld();
  const extraRow = new FakeElement("div", {
    className: "bar-row",
    rect: { x: 20, y: 30, width: 460, height: 20 },
  });
  extraRow.append(
    new FakeElement("div", {
      className: "bar-label",
      rect: { x: 20, y: 30, width: 460, height: 20 },
    }),
  );
  extraRow.parentElement = world.list;
  world.list.children.unshift(extraRow);
  world.list.scrollTop = 17;
  world.window.scrollY = 23;

  const fillRect = { ...world.fill._rect };
  const fillStyle = { ...world.fill._style };
  const listScroll = world.list.scrollTop;
  const windowScroll = world.window.scrollY;
  const result = probe(world);

  assert.equal(result.status, "observed");
  assert.equal(result.rowIndex, 1);
  assert.equal(result.scroll.list.top, 17);
  assert.equal(result.scroll.window.y, 23);
  assert.deepEqual(world.fill._rect, fillRect);
  assert.deepEqual(world.fill._style, fillStyle);
  assert.equal(world.list.scrollTop, listScroll);
  assert.equal(world.window.scrollY, windowScroll);
  assert.equal(result.spotlight.active, true);
});

test("999px track 减 1px border 得到胶囊 innerRect/innerRadius", () => {
  const world = createWorld();
  setRadii(world.track, "999px");

  const result = probe(world);
  assert.equal(result.status, "observed");
  const shape = result.clipShapes.find((item) => item.source.includes("bar-track"));
  assert.ok(shape);
  assert.deepEqual(shape.outerRect, { x: 20, y: 90, width: 460, height: 12 });
  assert.deepEqual(shape.innerRect, { x: 21, y: 91, width: 458, height: 10 });
  assert.equal(shape.cssRadius, 999);
  assert.equal(shape.normalizedOuterRadius, 6);
  assert.equal(shape.radius, 5);
  assert.deepEqual(shape.border, { top: 1, right: 1, bottom: 1, left: 1 });
  assert.deepEqual(shape.rawCorners, {
    topLeft: "999px",
    topRight: "999px",
    bottomRight: "999px",
    bottomLeft: "999px",
  });
  assert.deepEqual(shape.rect, shape.innerRect);
  assert.equal(typeof shape.source, "string");
});

test("panel 21px 圆角减 1px border 得到 20px innerRadius", () => {
  const world = createWorld();
  setRadii(world.panel, "21px");
  for (const property of ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]) {
    world.panel._style[property] = "1px";
  }

  const result = probe(world);
  assert.equal(result.status, "observed");
  const shape = result.clipShapes.find((item) => item.source.includes("#detailPanel"));
  assert.ok(shape);
  assert.deepEqual(shape.outerRect, { x: 10, y: 10, width: 500, height: 400 });
  assert.deepEqual(shape.innerRect, { x: 11, y: 11, width: 498, height: 398 });
  assert.equal(shape.normalizedOuterRadius, 21);
  assert.equal(shape.radius, 20);
});

test("小数外框与 border 保留为精确 innerRect，不用整数 client 冒充", () => {
  const world = createWorld();
  setRect(world.track, 20.25, 90.5, 460.5, 12.25);
  setRadii(world.track, "999px");
  for (const property of ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]) {
    world.track._style[property] = "0.5px";
  }
  setRect(world.fill, 21, 91, 200, 10);

  const result = probe(world);
  assert.equal(result.status, "observed");
  const shape = result.clipShapes.find((item) => item.source.includes("bar-track"));
  assert.ok(shape);
  assert.deepEqual(shape.innerRect, { x: 20.75, y: 91, width: 459.5, height: 11.25 });
  assert.equal(shape.normalizedOuterRadius, 6.125);
  assert.equal(shape.radius, 5.625);
});

test("非 uniform border/圆角、混合轴 overflow 无法证明时 unmeasured", () => {
  const nonUniformBorder = createWorld();
  nonUniformBorder.track._style.borderRightWidth = "2px";
  const borderResult = probe(nonUniformBorder);
  assert.equal(borderResult.status, "unmeasured");
  assert.match(borderResult.reason, /等厚/);

  const percentageAncestor = createWorld();
  setRadii(percentageAncestor.panel, "50%");
  const percentageResult = probe(percentageAncestor);
  assert.equal(percentageResult.status, "unmeasured");
  assert.match(percentageResult.reason, /圆角/);

  const mixedAxis = createWorld();
  mixedAxis.list._style.overflowX = "auto";
  mixedAxis.list._style.overflowY = "visible";
  setRadii(mixedAxis.list, "10px");
  const mixedResult = probe(mixedAxis);
  assert.equal(mixedResult.status, "unmeasured");
  assert.match(mixedResult.reason, /混合轴 overflow/);
});

test("无裁切祖先不凭空增加 clipShapes", () => {
  const world = createWorld();
  world.panel._style.overflowX = "visible";
  world.panel._style.overflowY = "visible";
  world.list._style.overflowX = "visible";
  world.list._style.overflowY = "visible";

  const result = probe(world);
  assert.equal(result.status, "observed");
  assert.equal(result.clipShapes.length, 2);
  assert.match(result.clipShapes[0].source, /bar-fill/);
  assert.match(result.clipShapes[1].source, /bar-track/);
  assert.equal(
    result.clipShapes.some((shape) => shape.source.includes("bar-row")),
    false,
  );
});

/**
 * 详情条形 DOM 几何读取（M5.2.P-C4）。
 *
 * 只读取，不修改 DOM/CSS/滚动/焦点/鼠标，也不创建浏览器或采样像素。
 * `observed` 只表示几何读取成功，不表示图形安全、可见颜色正确或对比度通过。
 *
 * shortcut: 仅支持 dpr=1、无 transform/zoom 的 CSS 像素坐标；真实取景和
 * 聚光态取样仍需后续浏览器捕获卡校准。
 */
export function probeDetailBarGeometry(fill) {
  function fail(reason) {
    return { status: "unmeasured", reason };
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function readPx(raw) {
    const text = String(raw ?? "").trim();
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px)?$/i.exec(text);
    if (!match) return Number.NaN;
    if (!match[2] && Number(match[1]) !== 0) return Number.NaN;
    return Number(match[1]);
  }

  function lengthFrom(css, property) {
    const raw = css?.[property];
    if (raw === undefined || raw === null || raw === "") return 0;
    return readPx(raw);
  }

  function rectFrom(source) {
    if (!source) return null;
    const rect = {
      x: Number(source.left ?? source.x),
      y: Number(source.top ?? source.y),
      width: Number(source.width),
      height: Number(source.height),
    };
    if (![rect.x, rect.y, rect.width, rect.height].every(finite)) return null;
    if (rect.width < 0 || rect.height < 0) return null;
    return rect;
  }

  function describe(node) {
    const tag = String(node?.tagName || "element").toLowerCase();
    const id = node?.id ? `#${node.id}` : "";
    const classes = String(node?.className || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((name) => `.${name}`)
      .join("");
    return `${tag}${id}${classes}`;
  }

  function styleOf(node) {
    return typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
  }

  function parseRadius(raw) {
    const parts = String(raw ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length < 1 || parts.length > 2) return null;
    const horizontal = readPx(parts[0]);
    const vertical = parts.length === 2 ? readPx(parts[1]) : horizontal;
    if (!finite(horizontal) || !finite(vertical) || horizontal < 0 || vertical < 0) return null;
    if (horizontal !== vertical) return null;
    return horizontal;
  }

  function rawCornersOf(css) {
    return {
      topLeft: String(css?.borderTopLeftRadius ?? ""),
      topRight: String(css?.borderTopRightRadius ?? ""),
      bottomRight: String(css?.borderBottomRightRadius ?? ""),
      bottomLeft: String(css?.borderBottomLeftRadius ?? ""),
    };
  }

  /** 将 border-box 形状归一化为 border→padding 内框；不猜百分比/椭圆/非等厚值。 */
  function buildClipShape(source, outerRect, css) {
    const rawCorners = rawCornersOf(css);
    const radii = Object.values(rawCorners).map(parseRadius);
    if (radii.some((value) => value === null) || !radii.every((value) => value === radii[0])) {
      return { reason: `${source} 圆角只支持四角一致的非负有限 px` };
    }
    const cssRadius = radii[0];
    const border = {
      top: lengthFrom(css, "borderTopWidth"),
      right: lengthFrom(css, "borderRightWidth"),
      bottom: lengthFrom(css, "borderBottomWidth"),
      left: lengthFrom(css, "borderLeftWidth"),
    };
    if (!Object.values(border).every(finite) || Object.values(border).some((value) => value < 0)) {
      return { reason: `${source} border 非有限或为负` };
    }
    if (!Object.values(border).every((value) => value === border.top)) {
      return { reason: `${source} border 四边必须等厚（收到 ${JSON.stringify(border)}）` };
    }
    const innerRect = {
      x: outerRect.x + border.left,
      y: outerRect.y + border.top,
      width: outerRect.width - border.left - border.right,
      height: outerRect.height - border.top - border.bottom,
    };
    if (!(innerRect.width > 0) || !(innerRect.height > 0)) {
      return { reason: `${source} border→padding 内框面积为零` };
    }
    const normalizedOuterRadius = Math.min(cssRadius, outerRect.width / 2, outerRect.height / 2);
    const radius = Math.max(0, normalizedOuterRadius - border.top);
    return {
      shape: {
        source,
        rect: { ...innerRect },
        radius,
        rawCorners,
        border,
        outerRect: { ...outerRect },
        innerRect: { ...innerRect },
        cssRadius,
        normalizedOuterRadius,
      },
    };
  }

  function scaleIsOne(raw) {
    if (raw === undefined || raw === null || raw === "" || raw === "none") return true;
    const parts = String(raw).trim().split(/\s+/).map(Number);
    return parts.length > 0 && parts.every((value) => finite(value) && value === 1);
  }

  function zoomIsOne(raw) {
    if (raw === undefined || raw === null || raw === "" || raw === "normal") return true;
    return Number(raw) === 1;
  }

  function unsupportedTransform(node) {
    const css = styleOf(node);
    if (!css) return `无法读取 ${describe(node)} 的 computed style`;
    if (css.transform && css.transform !== "none") {
      return `${describe(node)} transform=${css.transform}`;
    }
    if (css.translate && css.translate !== "none") {
      return `${describe(node)} translate=${css.translate}`;
    }
    if (css.rotate && css.rotate !== "none") {
      return `${describe(node)} rotate=${css.rotate}`;
    }
    if (!zoomIsOne(css.zoom)) {
      return `${describe(node)} zoom=${css.zoom}`;
    }
    if (!scaleIsOne(css.scale)) {
      return `${describe(node)} scale=${css.scale}`;
    }
    return "";
  }

  function clientRect(node, sourceRect, clipsX, clipsY) {
    const css = styleOf(node);
    if (!css) return null;
    const left = lengthFrom(css, "borderLeftWidth");
    const right = lengthFrom(css, "borderRightWidth");
    const top = lengthFrom(css, "borderTopWidth");
    const bottom = lengthFrom(css, "borderBottomWidth");
    if (![left, right, top, bottom].every(finite) || [left, right, top, bottom].some((value) => value < 0)) {
      return null;
    }
    const box = {
      x: sourceRect.x + left,
      y: sourceRect.y + top,
      width: sourceRect.width - left - right,
      height: sourceRect.height - top - bottom,
    };
    if (clipsX) {
      const clientWidth = Number(node.clientWidth);
      if (!finite(clientWidth) || clientWidth < 0) {
        return { reason: `无法读取 ${describe(node)} clientWidth` };
      }
      if (clientWidth > box.width + 0.5 || box.width - clientWidth > 0.5) {
        return {
          reason: `${describe(node)} clientWidth=${clientWidth} 与 fractional padding box=${box.width} 不匹配，存在滚动条或 client 区域缩小`,
        };
      }
    }
    if (clipsY) {
      const clientHeight = Number(node.clientHeight);
      if (!finite(clientHeight) || clientHeight < 0) {
        return { reason: `无法读取 ${describe(node)} clientHeight` };
      }
      if (clientHeight > box.height + 0.5 || box.height - clientHeight > 0.5) {
        return {
          reason: `${describe(node)} clientHeight=${clientHeight} 与 fractional padding box=${box.height} 不匹配，存在滚动条或 client 区域缩小`,
        };
      }
    }
    return { box };
  }

  if (fill?.nodeType !== 1 || !fill.isConnected) {
    return fail("fill 不是已连接的 DOM 元素");
  }
  if (typeof fill.matches !== "function" || !fill.matches(".bar-fill")) {
    return fail("fill 必须匹配 .bar-fill");
  }
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return fail("缺少 document.querySelectorAll");
  }
  if (typeof window === "undefined") {
    return fail("缺少 window");
  }

  const panels = document.querySelectorAll("#detailPanel");
  const lists = document.querySelectorAll("#detailList");
  if (panels.length !== 1) {
    return fail(`#detailPanel 必须唯一（收到 ${panels.length} 个）`);
  }
  if (lists.length !== 1) {
    return fail(`#detailList 必须唯一（收到 ${lists.length} 个）`);
  }

  const panel = panels[0];
  const list = lists[0];
  const track = fill.parentElement;
  const row = track?.parentElement;
  if (!track || !row || typeof track.matches !== "function" || typeof row.matches !== "function") {
    return fail("fill 缺少 .bar-track / .bar-row 直接祖先");
  }
  if (!track.matches(".bar-track")) {
    return fail("fill 的直接父节点必须匹配 .bar-track");
  }
  if (!row.matches(".bar-row")) {
    return fail(".bar-track 的直接父节点必须匹配 .bar-row");
  }
  if (row.parentElement !== list) {
    return fail(".bar-row 必须直接位于 #detailList");
  }
  if (list.parentElement !== panel) {
    return fail("#detailList 必须直接位于 #detailPanel");
  }
  if (list.hasAttribute?.("hidden") || list.hidden === true) {
    return fail("#detailList 处于 hidden 状态");
  }

  const fillCss = styleOf(fill);
  if (!fillCss) {
    return fail("无法读取 fill computed style");
  }
  if (fillCss.display === "none" || fillCss.visibility !== "visible") {
    return fail("fill 不可见（display/visibility）");
  }
  if (fillCss.opacity !== undefined && fillCss.opacity !== "" && Number(fillCss.opacity) === 0) {
    return fail("fill 不可见（opacity=0）");
  }

  const fillRect = rectFrom(fill.getBoundingClientRect?.());
  if (!fillRect || !(fillRect.width > 0) || !(fillRect.height > 0)) {
    return fail("fillRect 非有限或面积为零");
  }

  for (const property of ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]) {
    const value = lengthFrom(fillCss, property);
    if (!finite(value) || value < 0) return fail(`无法读取 fill ${property}`);
    if (value > 0) return fail(`fill 自带边框（${property}=${value}px）`);
  }
  for (const property of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
    const value = lengthFrom(fillCss, property);
    if (!finite(value) || value < 0) return fail(`无法读取 fill ${property}`);
    if (value > 0) return fail(`fill 自带 padding（${property}=${value}px）`);
  }
  if (fillCss.backgroundImage && fillCss.backgroundImage !== "none") {
    return fail(`fill 自身 background-image=${fillCss.backgroundImage}`);
  }

  for (let node = fill; node; node = node.parentElement) {
    const reason = unsupportedTransform(node);
    if (reason) return fail(`不支持的 CSS 像素变换：${reason}`);
  }

  const rawRadii = {
    topLeft: String(fillCss.borderTopLeftRadius ?? ""),
    topRight: String(fillCss.borderTopRightRadius ?? ""),
    bottomRight: String(fillCss.borderBottomRightRadius ?? ""),
    bottomLeft: String(fillCss.borderBottomLeftRadius ?? ""),
  };
  const radii = Object.values(rawRadii).map(parseRadius);
  if (radii.some((value) => value === null)) {
    return fail("圆角只支持四角一致的非负有限 px");
  }
  if (!radii.every((value) => value === radii[0])) {
    return fail("圆角只支持四角一致的非负有限 px");
  }
  const cssRadius = radii[0];
  const radius = Math.min(cssRadius, fillRect.width / 2, fillRect.height / 2);
  if (!finite(radius) || radius < 0) {
    return fail("归一化圆角非有限或为负");
  }
  const clipShapes = [
    {
      source: describe(fill),
      rect: { ...fillRect },
      radius,
      rawCorners: rawRadii,
      border: { top: 0, right: 0, bottom: 0, left: 0 },
      outerRect: { ...fillRect },
      innerRect: { ...fillRect },
      cssRadius,
      normalizedOuterRadius: radius,
    },
  ];

  const trackCss = styleOf(track);
  const trackRect = rectFrom(track.getBoundingClientRect?.());
  if (!trackCss || !trackRect || !(trackRect.width > 0) || !(trackRect.height > 0)) {
    return fail("bar-track 几何非有限或面积为零");
  }
  const trackLengths = {};
  for (const property of [
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
  ]) {
    const value = lengthFrom(trackCss, property);
    if (!finite(value) || value < 0) return fail(`无法读取 bar-track ${property}`);
    trackLengths[property] = value;
  }
  const trackContentRect = {
    x: trackRect.x + trackLengths.borderLeftWidth + trackLengths.paddingLeft,
    y: trackRect.y + trackLengths.borderTopWidth + trackLengths.paddingTop,
    width:
      trackRect.width -
      trackLengths.borderLeftWidth -
      trackLengths.borderRightWidth -
      trackLengths.paddingLeft -
      trackLengths.paddingRight,
    height:
      trackRect.height -
      trackLengths.borderTopWidth -
      trackLengths.borderBottomWidth -
      trackLengths.paddingTop -
      trackLengths.paddingBottom,
  };
  if (!(trackContentRect.width > 0) || !(trackContentRect.height > 0)) {
    return fail("bar-track 内容框面积为零");
  }
  const trackShape = buildClipShape(describe(track), trackRect, trackCss);
  if (trackShape.reason) return fail(`bar-track shape 无法证明：${trackShape.reason}`);
  if (trackCss.overflowX !== trackCss.overflowY && trackShape.shape.normalizedOuterRadius > 0) {
    return fail("bar-track 混合轴 overflow 且圆角无法证明");
  }
  clipShapes.push(trackShape.shape);

  const viewportWidth = Number(window.innerWidth);
  const viewportHeight = Number(window.innerHeight);
  const dpr = Number(window.devicePixelRatio);
  if (!finite(viewportWidth) || viewportWidth <= 0 || !finite(viewportHeight) || viewportHeight <= 0) {
    return fail("viewport 尺寸非有限或为零");
  }
  if (!finite(dpr) || dpr !== 1) {
    return fail(`dpr 必须为 1（收到 ${String(window.devicePixelRatio)}）`);
  }
  const visualScale = Number(window.visualViewport?.scale);
  if (finite(visualScale) && visualScale !== 1) {
    return fail(`visualViewport.scale 必须为 1（收到 ${visualScale}）`);
  }

  let visible = { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
  const clipSources = [
    {
      source: "viewport",
      kind: "viewport",
      box: { ...visible },
      overflowX: "clip",
      overflowY: "clip",
    },
  ];
  const clipNodes = [];

  function applyClip(source, kind, box, clipsX, clipsY, overflowX = "clip", overflowY = "clip") {
    const next = {
      x: clipsX ? Math.max(visible.x, box.x) : visible.x,
      y: clipsY ? Math.max(visible.y, box.y) : visible.y,
      width: visible.width,
      height: visible.height,
    };
    if (clipsX) {
      next.width = Math.min(visible.x + visible.width, box.x + box.width) - next.x;
    }
    if (clipsY) {
      next.height = Math.min(visible.y + visible.height, box.y + box.height) - next.y;
    }
    visible = next;
    clipSources.push({
      source,
      kind,
      box: { ...box },
      overflowX,
      overflowY,
      clipsX,
      clipsY,
    });
  }

  applyClip("bar-track content", "track-content", trackContentRect, true, true);
  for (let node = track.parentElement; node; node = node.parentElement) {
    const css = styleOf(node);
    if (!css) return fail(`无法读取祖先 ${describe(node)} 的 computed style`);
    const clipsX = css.overflowX !== "visible";
    const clipsY = css.overflowY !== "visible";
    if (!clipsX && !clipsY) continue;
    const sourceRect = rectFrom(node.getBoundingClientRect?.());
    if (!sourceRect) return fail(`祖先 ${describe(node)} 几何非有限`);
    const client = clientRect(node, sourceRect, clipsX, clipsY);
    if (!client?.box) {
      return fail(client?.reason || `无法读取祖先 ${describe(node)} client 区域`);
    }
    if (client.box.width < 0 || client.box.height < 0) {
      return fail(`祖先 ${describe(node)} client 区域为负`);
    }
    const shape = buildClipShape(describe(node), sourceRect, css);
    if (shape.reason) return fail(`裁切祖先 shape 无法证明：${shape.reason}`);
    if (clipsX !== clipsY && shape.shape.normalizedOuterRadius > 0) {
      return fail(`祖先 ${describe(node)} 混合轴 overflow 且圆角无法证明`);
    }
    clipNodes.push(node);
    clipShapes.push(shape.shape);
    applyClip(describe(node), "overflow-ancestor", client.box, clipsX, clipsY, css.overflowX, css.overflowY);
  }

  if (!(visible.width > 0) || !(visible.height > 0)) {
    return fail("viewport、track 内容框与 overflow 祖先裁切后无可见面积");
  }
  const overlapWidth =
    Math.min(fillRect.x + fillRect.width, visible.x + visible.width) - Math.max(fillRect.x, visible.x);
  const overlapHeight =
    Math.min(fillRect.y + fillRect.height, visible.y + visible.height) - Math.max(fillRect.y, visible.y);
  if (!(overlapWidth > 0) || !(overlapHeight > 0)) {
    return fail("fill 在裁切后不可见");
  }

  const directRows = [];
  for (const child of Array.from(list.children || [])) {
    if (typeof child.matches === "function" && child.matches(".bar-row")) directRows.push(child);
  }
  const rowIndex = directRows.indexOf(row);
  if (rowIndex < 0) {
    return fail(".bar-row 不在 #detailList 的实际直接行集合中");
  }

  function optionalNumber(value) {
    return finite(value) ? value : null;
  }

  function stackSnapshot(node) {
    const css = styleOf(node);
    if (!css) return null;
    const snapshot = { source: describe(node) };
    for (const property of [
      "position",
      "zIndex",
      "isolation",
      "display",
      "visibility",
      "opacity",
      "transform",
      "filter",
      "mixBlendMode",
    ]) {
      if (typeof css[property] !== "string") return null;
      snapshot[property] = css[property];
    }
    return snapshot;
  }

  const diagnosticNodes = [];
  for (const node of [track, row, list, panel, ...clipNodes]) {
    if (node && !diagnosticNodes.includes(node)) diagnosticNodes.push(node);
  }
  const ancestors = diagnosticNodes.map((node) => {
    const css = styleOf(node);
    const rect = rectFrom(node.getBoundingClientRect?.());
    return {
      source: describe(node),
      overflowX: css?.overflowX ?? null,
      overflowY: css?.overflowY ?? null,
      borderRadius: css?.borderRadius ?? null,
      backgroundImage: css?.backgroundImage ?? null,
      boxShadow: css?.boxShadow ?? null,
      transform: css?.transform ?? null,
      zoom: css?.zoom ?? null,
      rect,
    };
  });

  const headings = Array.from(panel.children || []).filter(
    (node) => typeof node.matches === "function" && node.matches(".panel-heading"),
  );
  if (headings.length !== 1) return fail(`#detailPanel 的 .panel-heading 必须唯一（收到 ${headings.length} 个）`);
  const heading = headings[0];
  const labelNodes = [];
  for (const directRow of directRows) {
    const labels = Array.from(directRow.children || []).filter(
      (node) => typeof node.matches === "function" && node.matches(".bar-label"),
    );
    if (labels.length !== 1) return fail(`每个 .bar-row 的 .bar-label 必须唯一（收到 ${labels.length} 个）`);
    labelNodes.push(labels[0]);
  }

  const activeHosts = Array.from(document.querySelectorAll("[data-spotlight-active]"));
  const activeHostCount = activeHosts.length;
  const activeHostIsPanel = activeHostCount === 1 && activeHosts[0] === panel;
  const active = panel.hasAttribute?.("data-spotlight-active") ?? false;
  if (!(activeHostCount === 0 || activeHostIsPanel) || active !== activeHostIsPanel) {
    return fail(`detail spotlight active host 必须为空或唯一 #detailPanel（收到 ${activeHostCount} 个）`);
  }

  let pseudo;
  try {
    pseudo = getComputedStyle(panel, "::after");
  } catch {
    return fail("无法读取 #detailPanel::after computed style");
  }
  if (!pseudo) return fail("缺少 #detailPanel::after computed style");
  const pseudoSnapshot = {
    content: pseudo.content,
    position: pseudo.position,
    inset: {
      top: pseudo.top,
      right: pseudo.right,
      bottom: pseudo.bottom,
      left: pseudo.left,
    },
    opacity: pseudo.opacity,
    pointerEvents: pseudo.pointerEvents,
    maskSize: pseudo.maskSize,
    maskRepeat: pseudo.maskRepeat,
  };
  for (const value of [
    pseudoSnapshot.content,
    pseudoSnapshot.position,
    pseudoSnapshot.inset.top,
    pseudoSnapshot.inset.right,
    pseudoSnapshot.inset.bottom,
    pseudoSnapshot.inset.left,
    pseudoSnapshot.opacity,
    pseudoSnapshot.pointerEvents,
    pseudoSnapshot.maskSize,
    pseudoSnapshot.maskRepeat,
    pseudo.backgroundImage,
    pseudo.maskImage,
    pseudo.zIndex,
  ]) {
    if (typeof value !== "string") return fail("缺少 #detailPanel::after 聚光字段");
  }

  const hostCss = styleOf(panel);
  if (!hostCss || typeof hostCss.isolation !== "string" || typeof hostCss.position !== "string") {
    return fail("缺少 #detailPanel host isolation/position 字段");
  }
  const inlineStyle = panel.style;
  if (!inlineStyle || typeof inlineStyle.getPropertyValue !== "function") {
    return fail("无法读取 #detailPanel spotlight CSS 变量");
  }
  const readVariable = (name) => {
    const value = inlineStyle.getPropertyValue(name);
    return typeof value === "string" ? value : null;
  };
  const x = readVariable("--spotlight-x");
  const y = readVariable("--spotlight-y");
  const radiusVariable = readVariable("--spotlight-radius");
  const mask = readVariable("--spotlight-mask");
  if ([x, y, radiusVariable, mask].some((value) => value === null)) {
    return fail("缺少 #detailPanel spotlight CSS 变量");
  }

  const stack = {
    heading: stackSnapshot(heading),
    labels: labelNodes.map(stackSnapshot),
    fill: stackSnapshot(fill),
    track: stackSnapshot(track),
    list: stackSnapshot(list),
    row: stackSnapshot(row),
  };
  if (
    !stack.heading ||
    stack.labels.some((snapshot) => !snapshot) ||
    !stack.fill ||
    !stack.track ||
    !stack.list ||
    !stack.row
  ) {
    return fail("缺少 detail spotlight stack computed 字段");
  }
  const spotlight = {
    active,
    backgroundImage: pseudo.backgroundImage,
    maskImage: pseudo.maskImage,
    zIndex: pseudo.zIndex,
    activeHostCount,
    activeHostIsPanel,
    pseudo: pseudoSnapshot,
    host: { isolation: hostCss.isolation, position: hostCss.position },
    x,
    y,
    radius: radiusVariable,
    mask,
    stack,
  };

  return {
    status: "observed",
    fillRect,
    visibleRect: visible,
    radius,
    cssRadius,
    rawRadii,
    rowIndex,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      dpr,
      visualScale: finite(visualScale) ? visualScale : null,
    },
    scroll: {
      window: {
        x: optionalNumber(window.scrollX ?? window.pageXOffset),
        y: optionalNumber(window.scrollY ?? window.pageYOffset),
      },
      list: {
        left: optionalNumber(list.scrollLeft),
        top: optionalNumber(list.scrollTop),
        width: optionalNumber(list.scrollWidth),
        height: optionalNumber(list.scrollHeight),
        clientWidth: optionalNumber(list.clientWidth),
        clientHeight: optionalNumber(list.clientHeight),
      },
    },
    structure: {
      detailPanel: describe(panel),
      detailList: describe(list),
      row: describe(row),
      track: describe(track),
      fill: describe(fill),
    },
    trackContentRect,
    clipShapes,
    clipSources,
    ancestors,
    spotlight,
  };
}

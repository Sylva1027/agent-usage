/**
 * Detail bar 填色隔离的事务原语（M5.2.P-C7）。
 *
 * 两个导出都是自包含的浏览器侧函数，供 ElementHandle.evaluate 直接求值：
 * 只引用参数和页面全局对象，不依赖模块作用域。本卡片只做 paint 隐藏/恢复，
 * 不做几何、截图、采样或像素比较。
 *
 * shortcut: inactive 继续只支持纯背景 fill；active 仅准入唯一
 * #detailPanel 当前 CSS 明确聚光形态。C9 active 拒绝仍由消费者保留。
 */

export function beginDetailBarPaintHide(fill) {
  const STASH_KEY = "__codexSkinDetailBarPaintHideV1__";
  const TOKEN = "detail-bar-paint-hide-v1";
  const reject = (reason) => ({ status: "rejected", reason });
  const px = (value) => Number.parseFloat(String(value ?? ""));
  const strictPx = (value) => {
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)px$/i.exec(String(value ?? "").trim());
    return match ? Number(match[1]) : Number.NaN;
  };

  if (fill?.nodeType !== 1 || fill.isConnected !== true) return reject("fill 不是已连接的 DOM 元素");
  if (typeof fill.matches !== "function" || !fill.matches(".bar-fill")) return reject("fill 必须匹配 .bar-fill");
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") {
    return reject("缺少 document.querySelectorAll");
  }
  if (typeof getComputedStyle !== "function") return reject("缺少 getComputedStyle");

  const panels = document.querySelectorAll("#detailPanel");
  const lists = document.querySelectorAll("#detailList");
  if (panels.length !== 1) return reject(`#detailPanel 必须唯一（收到 ${panels.length} 个）`);
  if (lists.length !== 1) return reject(`#detailList 必须唯一（收到 ${lists.length} 个）`);

  const panel = panels[0];
  const list = lists[0];
  const track = fill.parentElement;
  const row = track?.parentElement;
  if (!track || !row || typeof track.matches !== "function" || typeof row.matches !== "function") {
    return reject("fill 缺少 .bar-track / .bar-row 直接祖先");
  }
  if (!track.matches(".bar-track")) return reject("fill 的直接父节点必须匹配 .bar-track");
  if (!row.matches(".bar-row")) return reject(".bar-track 的直接父节点必须匹配 .bar-row");
  if (row.parentElement !== list) return reject(".bar-row 必须直接位于 #detailList");
  if (list.parentElement !== panel) return reject("#detailList 必须直接位于 #detailPanel");
  if (list.hasAttribute?.("hidden") || list.hidden === true) return reject("#detailList 处于 hidden 状态");

  const readSpotlight = () => {
    const activeHosts = Array.from(document.querySelectorAll("[data-spotlight-active]"));
    const currentPanels = Array.from(document.querySelectorAll("#detailPanel"));
    const currentLists = Array.from(document.querySelectorAll("#detailList"));
    const hostCss = getComputedStyle(panel);
    const pseudo = getComputedStyle(panel, "::after");
    const styleFields = (css, properties) =>
      Object.fromEntries(
        properties.map((property) => [property, typeof css?.[property] === "string" ? css[property] : null]),
      );
    const describeNode = (node) => {
      const tag = String(node?.tagName || "element").toLowerCase();
      const id = node?.id ? `#${node.id}` : "";
      const classes = String(node?.className || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => `.${name}`)
        .join("");
      return `${tag}${id}${classes}`;
    };
    const chainNode = (node) => ({ connected: node?.isConnected === true, source: describeNode(node) });
    const readVariable = (name) => {
      const value = panel.style?.getPropertyValue?.(name);
      return typeof value === "string" ? value : null;
    };
    return {
      activeHostCount: activeHosts.length,
      activeHostIsPanel: activeHosts.length === 1 && activeHosts[0] === panel,
      chain: {
        panelCount: currentPanels.length,
        listCount: currentLists.length,
        panelSame: currentPanels.length === 1 && currentPanels[0] === panel,
        listSame: currentLists.length === 1 && currentLists[0] === list,
        listParentSame: list.parentElement === panel,
        rowParentSame: row.parentElement === list,
        trackParentSame: track.parentElement === row,
        fillParentSame: fill.parentElement === track,
        panel: chainNode(panel),
        list: chainNode(list),
        row: chainNode(row),
        track: chainNode(track),
        fill: chainNode(fill),
      },
      host: styleFields(hostCss, [
        "isolation",
        "position",
        "display",
        "visibility",
        "opacity",
        "backgroundColor",
        "backgroundImage",
        "boxShadow",
        "transform",
        "filter",
        "mixBlendMode",
        "zIndex",
      ]),
      pseudo: styleFields(pseudo, [
        "content",
        "position",
        "top",
        "right",
        "bottom",
        "left",
        "opacity",
        "pointerEvents",
        "zIndex",
        "backgroundImage",
        "maskImage",
        "maskSize",
        "maskRepeat",
        "transitionProperty",
        "transitionDuration",
        "mixBlendMode",
        "filter",
      ]),
      variables: {
        x: readVariable("--spotlight-x"),
        y: readVariable("--spotlight-y"),
        radius: readVariable("--spotlight-radius"),
        mask: readVariable("--spotlight-mask"),
      },
    };
  };

  const activeHosts = Array.from(document.querySelectorAll("[data-spotlight-active]"));
  const panelClaimsActive = panel.hasAttribute?.("data-spotlight-active") ?? false;
  let spotlight = null;
  if (activeHosts.length !== 0 || panelClaimsActive) {
    if (activeHosts.length !== 1 || activeHosts[0] !== panel || panelClaimsActive !== true) {
      return reject("spotlight-active: active host 必须唯一且为 #detailPanel");
    }
    let snapshot;
    try {
      snapshot = readSpotlight();
    } catch (error) {
      return reject(`spotlight-active: 无法读取聚光快照：${error instanceof Error ? error.message : String(error)}`);
    }
    const chain = snapshot.chain;
    if (
      snapshot.activeHostCount !== 1 ||
      snapshot.activeHostIsPanel !== true ||
      chain.panelCount !== 1 ||
      chain.listCount !== 1 ||
      chain.panelSame !== true ||
      chain.listSame !== true ||
      chain.listParentSame !== true ||
      chain.rowParentSame !== true ||
      chain.trackParentSame !== true ||
      chain.fillParentSame !== true ||
      [chain.panel, chain.list, chain.row, chain.track, chain.fill].some((node) => node.connected !== true)
    ) {
      return reject("spotlight-active: host 链不是唯一且连通的 #detailPanel/#detailList/.bar-row/.bar-track/.bar-fill");
    }
    const pseudo = snapshot.pseudo;
    const host = snapshot.host;
    const x = strictPx(snapshot.variables.x);
    const y = strictPx(snapshot.variables.y);
    const radius = strictPx(snapshot.variables.radius);
    const fourEdgesZero = ["top", "right", "bottom", "left"].every((side) => strictPx(pseudo[side]) === 0);
    const emptyContent = pseudo.content === '""' || pseudo.content === "";
    if (
      host.isolation !== "isolate" ||
      !emptyContent ||
      pseudo.position !== "absolute" ||
      !fourEdgesZero ||
      pseudo.opacity !== "1" ||
      pseudo.pointerEvents !== "none" ||
      pseudo.zIndex !== "0" ||
      typeof pseudo.backgroundImage !== "string" ||
      !/radial-gradient\(/i.test(pseudo.backgroundImage) ||
      typeof pseudo.maskImage !== "string" ||
      pseudo.maskImage === "" ||
      pseudo.maskImage === "none" ||
      typeof pseudo.maskSize !== "string" ||
      pseudo.maskSize === "" ||
      typeof pseudo.maskRepeat !== "string" ||
      pseudo.maskRepeat === "" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      typeof snapshot.variables.mask !== "string" ||
      snapshot.variables.mask === "" ||
      snapshot.variables.mask === "none"
    ) {
      return reject("spotlight-active: 聚光 computed/变量不是当前 CSS 明确形态");
    }
    spotlight = {
      nodes: { panel, list, row, track, fill },
      snapshot,
      read: readSpotlight,
    };
  }

  const css = getComputedStyle(fill);
  if (!css) return reject("无法读取 fill computed style");
  if (css.boxShadow && css.boxShadow !== "none") return reject(`fill 自带 shadow：${css.boxShadow}`);
  if (css.backgroundImage && css.backgroundImage !== "none") {
    return reject(`fill 自带 background-image：${css.backgroundImage}`);
  }
  for (const property of ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"]) {
    const value = px(css[property]);
    if (!Number.isFinite(value) || value < 0) return reject(`无法读取 fill ${property}`);
    if (value > 0) return reject(`fill 自带边框（${property}=${css[property]}）`);
  }
  for (const property of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]) {
    const value = px(css[property]);
    if (!Number.isFinite(value) || value < 0) return reject(`无法读取 fill ${property}`);
    if (value > 0) return reject(`fill 自带 padding（${property}=${css[property]}）`);
  }
  if (css.filter && css.filter !== "none") return reject(`fill 自带 filter：${css.filter}`);
  if (css.backdropFilter && css.backdropFilter !== "none") {
    return reject(`fill 自带 backdrop-filter：${css.backdropFilter}`);
  }
  if (css.maskImage && css.maskImage !== "none") return reject(`fill 自带 mask：${css.maskImage}`);
  if (css.mixBlendMode && css.mixBlendMode !== "normal") {
    return reject(`fill 自带 blend：${css.mixBlendMode}`);
  }
  for (const pseudo of ["::before", "::after"]) {
    const pseudoCss = getComputedStyle(fill, pseudo);
    if (!pseudoCss) return reject(`无法读取 fill ${pseudo} computed style`);
    const content = String(pseudoCss.content ?? "").trim();
    if (content !== "" && content !== "none" && content !== "normal") {
      return reject(`fill 自带 ${pseudo} 内容：${content}`);
    }
    if (pseudoCss.backgroundImage && pseudoCss.backgroundImage !== "none") {
      return reject(`fill 自带 ${pseudo} background-image：${pseudoCss.backgroundImage}`);
    }
  }

  const active = globalThis[STASH_KEY];
  if (active) return reject(active.fill === fill ? "already-hidden" : "another-fill-active");

  const style = fill.style;
  if (!style || typeof style.setProperty !== "function" || typeof style.getPropertyValue !== "function") {
    return reject("fill 缺少可写 inline style");
  }
  const hadStyle = fill.hasAttribute("style");
  const value = style.getPropertyValue("background-color");
  const priority = style.getPropertyPriority("background-color");
  const unrelated = [];
  for (const name of Array.from(style)) {
    if (name === "background-color") continue;
    unrelated.push([name, style.getPropertyValue(name), style.getPropertyPriority(name)]);
  }
  const stash = { token: TOKEN, fill, hadStyle, value, priority, unrelated, spotlight };

  const rollback = () => {
    if (stash.value) style.setProperty("background-color", stash.value, stash.priority);
    else style.removeProperty("background-color");
    if (!stash.hadStyle && style.length === 0 && fill.hasAttribute("style")) fill.removeAttribute("style");
  };
  const rollbackAndVerify = () => {
    rollback();
    const restoredValue = style.getPropertyValue("background-color");
    const restoredPriority = style.getPropertyPriority("background-color");
    if (restoredValue !== stash.value || restoredPriority !== stash.priority) {
      throw new Error(
        `detail bar paint 回滚校验不一致：期望 "${stash.value}"/"${stash.priority}"，实际 "${restoredValue}"/"${restoredPriority}"`,
      );
    }
    if (!stash.hadStyle && style.length === 0 && fill.hasAttribute("style")) {
      throw new Error("detail bar paint 回滚后未移除空 style 属性");
    }
  };

  globalThis[STASH_KEY] = stash;
  try {
    style.setProperty("background-color", "transparent", "important");
  } catch (error) {
    try {
      rollbackAndVerify();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "detail bar paint 隐藏写入失败且回滚失败");
    }
    delete globalThis[STASH_KEY];
    throw new Error("detail bar paint 隐藏写入失败", { cause: error });
  }
  if (
    style.getPropertyValue("background-color") !== "transparent" ||
    style.getPropertyPriority("background-color") !== "important"
  ) {
    try {
      rollbackAndVerify();
    } catch (rollbackError) {
      throw new AggregateError([rollbackError], "detail bar paint 隐藏校验失败且回滚失败");
    }
    delete globalThis[STASH_KEY];
    throw new Error("detail bar paint 隐藏写入后校验不一致");
  }
  return {
    status: "hidden",
    token: TOKEN,
    background: { hadStyle, value, priority },
    unrelatedCount: unrelated.length,
    ...(spotlight
      ? {
          spotlight: {
            status: "observed",
            activeHostCount: spotlight.snapshot.activeHostCount,
            activeHostIsPanel: spotlight.snapshot.activeHostIsPanel,
          },
        }
      : {}),
  };
}

export function restoreDetailBarPaintHide(fill) {
  const STASH_KEY = "__codexSkinDetailBarPaintHideV1__";
  const TOKEN = "detail-bar-paint-hide-v1";
  const reject = (reason) => ({ status: "rejected", reason });
  const diffSnapshot = (before, after, path, pollution) => {
    if (Object.is(before, after)) return;
    if (
      before === null ||
      after === null ||
      typeof before !== "object" ||
      typeof after !== "object" ||
      Array.isArray(before) !== Array.isArray(after)
    ) {
      pollution.push({ name: path, before: before ?? null, after: after ?? null });
      return;
    }
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) {
        pollution.push({ name: `${path}.${key}`, before: before[key] ?? null, after: after[key] ?? null });
      } else {
        diffSnapshot(before[key], after[key], `${path}.${key}`, pollution);
      }
    }
  };

  if (fill?.nodeType !== 1) return reject("fill 必须是 DOM 元素");
  const stash = globalThis[STASH_KEY];
  if (!stash) return { status: "restored", changed: false, background: null, pollution: [] };
  if (stash.token !== TOKEN) return reject("stash-token-invalid");
  if (stash.fill !== fill) return reject("wrong-fill");

  const style = fill.style;
  if (!style || typeof style.setProperty !== "function" || typeof style.removeProperty !== "function") {
    return reject("fill 缺少可写 inline style");
  }

  const key = (value, priority) => `${value}\u0000${priority}`;
  const before = new Map(stash.unrelated.map(([name, value, priority]) => [name, key(value, priority)]));
  const after = new Map();
  for (const name of Array.from(style)) {
    if (name === "background-color") continue;
    after.set(name, key(style.getPropertyValue(name), style.getPropertyPriority(name)));
  }
  const pollution = [];
  for (const [name, value] of before) {
    if (after.get(name) !== value) pollution.push({ name, before: value, after: after.get(name) ?? null });
  }
  for (const [name, value] of after) {
    if (!before.has(name)) pollution.push({ name, before: null, after: value });
  }

  try {
    if (stash.value) style.setProperty("background-color", stash.value, stash.priority);
    else style.removeProperty("background-color");
    if (!stash.hadStyle && style.length === 0 && fill.hasAttribute("style")) fill.removeAttribute("style");
  } catch (error) {
    throw new Error("detail bar paint 恢复失败，stash 保留以便重试", { cause: error });
  }

  const value = style.getPropertyValue("background-color");
  const priority = style.getPropertyPriority("background-color");
  if (value !== stash.value || priority !== (stash.value ? stash.priority : "")) {
    throw new Error(
      `detail bar paint 恢复校验不一致：期望 "${stash.value}"/"${stash.priority}"，实际 "${value}"/"${priority}"`,
    );
  }
  if (!stash.hadStyle && style.length === 0 && fill.hasAttribute("style")) {
    throw new Error("detail bar paint 恢复后未移除空 style 属性");
  }
  const spotlightPollution = [];
  if (stash.spotlight) {
    let current;
    try {
      current = stash.spotlight.read();
    } catch (error) {
      throw new Error("detail bar spotlight 恢复验证失败，stash 保留以便重试", { cause: error });
    }
    diffSnapshot(stash.spotlight.snapshot, current, "spotlight", spotlightPollution);
    pollution.push(...spotlightPollution);
  }
  delete globalThis[STASH_KEY];
  return {
    status: pollution.length === 0 ? "restored" : "restored-with-pollution",
    changed: true,
    background: { hadStyle: stash.hadStyle, value: stash.value, priority: stash.priority },
    pollution,
    ...(stash.spotlight
      ? {
          spotlight: {
            verified: spotlightPollution.length === 0,
            pollution: spotlightPollution,
          },
        }
      : {}),
  };
}

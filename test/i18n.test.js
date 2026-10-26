import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalRecentValue,
  displayRecentValue,
  formatLocalDateTime,
  getLocale,
  initializeLocale,
  localeFromLanguages,
  localizeQuotaReason,
  localizeServerError,
  localizeText,
  preferredLocale,
  setLocale,
} from "../public/i18n.js";
import {
  formatTimelineTooltip,
  formatUsageTooltip,
  rangeLabel,
  renderBarListHtml,
  renderComparisonHtml,
  renderCostDetailHtml,
  renderDatePickerHtml,
  renderHomesHtml,
  renderPeriodComparisonTableHtml,
  renderSourceOptionsHtml,
} from "../public/app.js";

function untranslatedUiFragments(markup) {
  const fragments = [];
  for (const match of String(markup).matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</gu)) {
    const text = match[1].trim();
    if (text && /[\u3400-\u9fff]/u.test(localizeText(text, "en-US"))) fragments.push(text);
  }
  for (const match of String(markup).matchAll(/(?:aria-label|title|placeholder)="([^"]*[\u3400-\u9fff][^"]*)"/gu)) {
    if (/[\u3400-\u9fff]/u.test(localizeText(match[1], "en-US"))) fragments.push(match[1]);
  }
  return fragments;
}

test("browser language sets the first locale and a saved choice takes precedence", () => {
  assert.equal(localeFromLanguages(["zh-TW", "en-US"]), "zh-CN");
  assert.equal(localeFromLanguages(["en-GB", "zh-CN"]), "en-US");
  assert.equal(localeFromLanguages(["fr-FR"]), "en-US");
  assert.equal(preferredLocale({ getItem: () => "zh-CN" }, ["en-US"]), "zh-CN");
  assert.equal(
    preferredLocale(
      {
        getItem: () => {
          throw new Error("denied");
        },
      },
      ["en-US"],
    ),
    "en-US",
  );
  setLocale("en-US", { persist: false });
  assert.equal(getLocale(), "en-US");
  setLocale("zh-CN", { persist: false });
});

test("English recent ranges preserve the existing Chinese request values", () => {
  assert.equal(canonicalRecentValue("1 day"), "1天");
  assert.equal(canonicalRecentValue("2 weeks"), "2周");
  assert.equal(canonicalRecentValue("3 months"), "3个月");
  assert.equal(canonicalRecentValue("6 months"), "半年");
  assert.equal(canonicalRecentValue("1 year"), "一年");
  assert.equal(canonicalRecentValue("2"), "2天");
  assert.equal(canonicalRecentValue("tomorrow"), null);
  assert.equal(displayRecentValue("半年", "en-US"), "6 months");
  assert.equal(displayRecentValue("3个月", "en-US"), "3 months");
});

test("provider fallback copy stays distinct in both locales", () => {
  assert.equal(localizeText("provider 未知", "en-US"), "Provider unknown");
  assert.equal(localizeText("provider 信息不可用", "en-US"), "Provider information unavailable");
  assert.equal(localizeText("provider 未知", "zh-CN"), "provider 未知");
  assert.notEqual(localizeText("provider 未知", "en-US"), localizeText("provider 信息不可用", "en-US"));
});

test("ranking reference copy stays explainable in both locales", () => {
  assert.equal(localizeText("参考行", "en-US"), "Reference row");
  assert.equal(localizeText("计量条件未验证", "en-US"), "Metering conditions unverified");
  assert.equal(localizeText("排名信息不可用", "en-US"), "Ranking information unavailable");
  assert.match(
    localizeText("满足当前计量条件的历史样本排序；分隔线以下为参考读数。", "en-US"),
    /current metering conditions.*references/i,
  );
});

test("sample dates, units, and the p90 percentile are explicit in both locales", () => {
  assert.equal(localizeText("样本日期", "en-US"), "Sample date");
  assert.equal(localizeText("样本日期范围", "en-US"), "Sample date range");
  assert.equal(localizeText("样本日期不可用", "en-US"), "Sample dates unavailable");
  assert.equal(localizeText("回合", "en-US"), "turn");
  assert.equal(localizeText("消息", "en-US"), "message");
  assert.equal(localizeText("混合样本", "en-US"), "mixed sample");
  assert.equal(localizeText("样本日期", "zh-CN"), "样本日期");
  assert.match(
    localizeText("p90 是第 90 百分位，不是最快 10% 的平均值，也不是速度上限。", "en-US"),
    /90th percentile.*not the average of the fastest 10%.*not a speed ceiling/i,
  );
});

test("Codex timing coverage labels and unavailable states stay explicit in both locales", () => {
  assert.equal(localizeText("Codex 计时覆盖", "en-US"), "Codex timing coverage");
  assert.equal(localizeText("候选采样覆盖率", "en-US"), "Candidate sampling coverage");
  assert.equal(localizeText("已记录输出覆盖率", "en-US"), "Recorded-output coverage");
  assert.equal(localizeText("没有适用的 Codex 来源。", "en-US"), "No applicable Codex source.");
  assert.equal(
    localizeText("此响应未提供 Codex 计时覆盖信息。", "en-US"),
    "This response does not include Codex timing coverage.",
  );
  assert.equal(localizeText("本范围没有 Codex 候选。", "en-US"), "No Codex candidates in this range.");
  assert.equal(localizeText("缺失或无效时长", "en-US"), "Missing or invalid duration");
  assert.equal(localizeText("进行中", "en-US"), "In progress");
  assert.match(
    localizeText("性能索引正在重建，覆盖信息不可用。", "en-US"),
    /rebuilding.*coverage information is unavailable/i,
  );
  assert.match(
    localizeText("部分来源降级，覆盖保留已发布的健康数据。", "en-US"),
    /degraded.*last published healthy data/i,
  );
  assert.match(localizeText("全历史、无法定位日期的记录", "en-US"), /all-history records.*cannot be placed in time/i);
});

test("translated dashboard copy preserves cost and limit semantics", () => {
  assert.equal(localizeText("总花销", "en-US"), "Estimated Cost");
  assert.equal(localizeText("缓存读取", "en-US"), "Cache Hit");
  assert.equal(localizeText("本周限额", "en-US"), "Weekly Limit");
  assert.equal(localizeText("本周", "en-US"), "This Week");
  assert.equal(localizeText("总花销", "zh-CN"), "总花销");
  assert.match(localizeText("当前范围为今日；点击切换到 5 小时限额", "en-US"), /Current range: Today.*5-Hour Limit/);
  assert.equal(
    localizeQuotaReason({ reasonCode: "waiting", reason: "等待新的限额记录" }, "en-US"),
    "Waiting for a new limit record.",
  );
  assert.equal(
    localizeServerError({ code: "INVALID_IMPORT_DIRECTORY", error: "中文原因" }, 400, "en-US"),
    "Choose a Codex, ZCode, or DSH home directory, an OpenCode data directory, a Claude Code home, a WorkBuddy home, or a project with a usage log.",
  );
});

test("every static dashboard label and accessible attribute has an English form", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const untranslated = [];
  for (const match of html.matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</gu)) {
    const text = match[1].trim();
    if (text && text !== "文" && /[\u3400-\u9fff]/u.test(localizeText(text, "en-US"))) untranslated.push(text);
  }
  for (const match of html.matchAll(/(?:aria-label|title|placeholder)="([^"]*[\u3400-\u9fff][^"]*)"/gu)) {
    if (/[\u3400-\u9fff]/u.test(localizeText(match[1], "en-US"))) untranslated.push(match[1]);
  }
  assert.deepEqual(untranslated, []);
});

test("dynamic dashboard views have English copy for their rendered labels", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  setLocale("en-US", { persist: false });
  try {
    const usage = { total: 100, input: 80, cached: 20, output: 20, reasoning: 4 };
    const home = {
      id: "home-1",
      label: "Codex home",
      path: "/tmp/codex",
      kind: "main",
      status: "active",
      eventCount: 4,
      sessionCount: 2,
      imported: true,
    };
    const comparison = {
      label: "较昨日",
      previousRange: { start: "2026-09-25", end: "2026-09-25" },
      previousTotals: { total: 50 },
      previousSessionCount: 2,
      totalDelta: 50,
      percentChange: 100,
      averageDelta: 25,
      averagePercentChange: 50,
    };
    const period = { total: 100, input: 80, cached: 20, output: 20, reasoning: 4 };
    const pieces = [
      renderDatePickerHtml({ viewDate: new Date(2026, 8, 1) }),
      renderBarListHtml([{ name: "CLI", total: usage }]),
      renderCostDetailHtml([{ name: "gpt-6-sol", totalUsd: 1.23 }]),
      renderComparisonHtml(comparison),
      renderComparisonHtml({ label: "暂无对比", previousRange: null }),
      renderPeriodComparisonTableHtml([{ key: "gpt-6-sol", name: "gpt-6-sol", periods: { today: period } }], {
        expanded: { kind: "model", key: "gpt-6-sol", period: "today" },
        totals: { today: period },
        sort: { period: "today", direction: "asc", showIndicator: true },
      }),
      renderHomesHtml([home], { canModify: true, excludedIds: [home.id] }),
      renderSourceOptionsHtml([home]),
      formatUsageTooltip({ name: "CLI", total: usage, count: 4, sessions: 2 }),
      formatTimelineTooltip(
        { name: "2026-09-26", total: usage, models: [{ name: "gpt-6-sol", total: usage }] },
        "model",
      ),
      formatTimelineTooltip(
        {
          name: "2026-09-26",
          total: usage,
          pricedTokens: 100,
          costByModel: { "gpt-6-sol": { totalUsd: 1.23, currency: "USD" } },
        },
        "cost",
      ),
      `<p>${rangeLabel({ range: { preset: "today", start: "2026-09-26", end: "2026-09-26" } })}</p>`,
    ];
    assert.deepEqual(pieces.flatMap(untranslatedUiFragments), []);
  } finally {
    setLocale("zh-CN", { persist: false });
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

// ---------------------------------------------------------------------------
// Minimal DOM fixture for the translation observer. `node --test` has no DOM, so
// only the pieces `public/i18n.js` touches are implemented: the selectors used by
// `closest()` and the skip lists, text/attribute/child-list writes as
// MutationRecords, a MutationObserver that delivers records through a microtask,
// and visit counters that prove the observer walks only the mutated subtree.
// ---------------------------------------------------------------------------

const SIMPLE_SELECTOR = /^([a-zA-Z][\w-]*)|^\.([\w-]+)|^\[([\w-]+)\]/;
const OBSERVER_OPTIONS = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["aria-label", "title", "placeholder"],
};

const fixtureState = { probe: null, registrations: [], body: null };
let observerHandle = null;

function matchesSimple(node, selector) {
  if (node?.nodeType !== 1) return false;
  let rest = selector;
  while (rest) {
    const match = SIMPLE_SELECTOR.exec(rest);
    if (!match) return false;
    if (match[1]) {
      if (node.tagName !== match[1].toUpperCase()) return false;
    } else if (match[2]) {
      if (!(node.getAttribute("class") || "").split(/\s+/).includes(match[2])) return false;
    } else if (!node.hasAttribute(match[3])) {
      return false;
    }
    rest = rest.slice(match[0].length);
  }
  return true;
}

function matchesSelector(node, selector) {
  if (node.nodeType !== 1) return false;
  return String(selector)
    .split(",")
    .some((group) => {
      const parts = group.trim().split(/\s+/);
      let current = node;
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        while (current && !matchesSimple(current, parts[index])) current = current.parentNode;
        if (!current) return false;
        if (index > 0) current = current.parentNode;
      }
      return true;
    });
}

function countFixtureChange() {
  const probe = fixtureState.probe;
  if (probe) probe.changes[probe.mode] += 1;
}

function notifyMutation(target, record) {
  if (fixtureState.registrations.length === 0) return;
  fixtureState.probe.records += 1;
  for (const registration of fixtureState.registrations) {
    const { observer, target: observed, options } = registration;
    let scope = target;
    let observedHere = false;
    while (scope) {
      if (scope === observed) {
        observedHere = true;
        break;
      }
      scope = scope.parentNode;
    }
    if (!observedHere) continue;
    if (record.type === "childList" && !options.childList) continue;
    if (record.type === "characterData" && !options.characterData) continue;
    if (record.type === "attributes") {
      if (!options.attributes) continue;
      if (options.attributeFilter && !options.attributeFilter.includes(record.attributeName)) continue;
    }
    observer.queue.push({ ...record, target });
    scheduleDelivery(observer);
  }
}

function scheduleDelivery(observer) {
  if (observer.delivering) return;
  observer.delivering = true;
  queueMicrotask(() => {
    observer.delivering = false;
    const records = observer.queue.splice(0, observer.queue.length);
    if (records.length === 0) return;
    fixtureState.probe.callbacks += 1;
    observer.callback(records);
  });
}

class MiniMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.queue = [];
    this.delivering = false;
  }
  observe(target, options) {
    fixtureState.registrations.push({ observer: this, target, options });
  }
  disconnect() {
    fixtureState.registrations = fixtureState.registrations.filter((entry) => entry.observer !== this);
  }
}

class MiniNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    const parent = this.parentNode;
    // `translateTextNode` starts here, so this getter counts visited text nodes; the
    // delivered observer's "already translated?" check reads nodeValue and must not count.
    if (this.nodeType === 3 && fixtureState.probe) fixtureState.probe.textVisits += 1;
    return parent && parent.nodeType === 1 ? parent : null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.nodeType === 9;
  }
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }
}

class MiniText extends MiniNode {
  constructor(value) {
    super(3);
    this.value = String(value);
  }
  get nodeValue() {
    return this.value;
  }
  set nodeValue(next) {
    const value = String(next);
    if (value !== this.value) countFixtureChange();
    this.value = value;
    notifyMutation(this, { type: "characterData" });
  }
}

class MiniElement extends MiniNode {
  constructor(tagName, attributes = {}) {
    super(1);
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) {
      this.attributes.set(name, String(value));
      if (name === "data-i18n-en") this.dataset.i18nEn = String(value);
    }
  }
  matches(selector) {
    fixtureState.probe.elementVisits += 1;
    if (this === fixtureState.body) fixtureState.probe.bodyVisits += 1;
    return matchesSelector(this, selector);
  }
  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (matchesSelector(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    const next = String(value);
    if (this.attributes.get(name) !== next) countFixtureChange();
    this.attributes.set(name, next);
    if (name === "data-i18n-en") this.dataset.i18nEn = next;
    notifyMutation(this, { type: "attributes", attributeName: name });
  }
  removeAttribute(name) {
    if (!this.attributes.has(name)) return;
    this.attributes.delete(name);
    if (name === "data-i18n-en") delete this.dataset.i18nEn;
    notifyMutation(this, { type: "attributes", attributeName: name });
  }
}

class MiniDocument extends MiniNode {
  constructor(body) {
    super(9);
    this.body = body;
    this.documentElement = new MiniElement("html");
  }
}

function createFixture({ rows = 40 } = {}) {
  fixtureState.probe = {
    elementVisits: 0,
    textVisits: 0,
    bodyVisits: 0,
    records: 0,
    callbacks: 0,
    changes: { app: 0, drain: 0 },
    mode: "app",
  };
  fixtureState.registrations = [];

  const build = (tagName, attributes = {}, children = []) => {
    const node = new MiniElement(tagName, attributes);
    for (const child of children) {
      const childNode = typeof child === "string" ? new MiniText(child) : child;
      childNode.parentNode = node;
      node.childNodes.push(childNode);
    }
    return node;
  };

  const homePathText = new MiniText("C:\\Users\\Silver\\.codex");
  const homeLabelText = new MiniText("Codex home");
  const userDataText = new MiniText("通义千问");
  const dataI18nEn = new MiniText("本周");
  const scriptText = new MiniText("const 计数 = 1;");
  const preText = new MiniText("保留 代码");
  const skipText = new MiniText("不翻译这段");
  const changedText = new MiniText("总花销");
  const ariaTarget = build("button", { "aria-label": "切换主题", title: "切换语言" }, ["开"]);
  const input = build("input", { placeholder: "请输入目录路径。" });
  const rowElements = [];
  for (let index = 0; index < rows; index += 1) {
    rowElements.push(
      build("div", { class: "row" }, [
        build("span", { class: "cell" }, ["模型"]),
        build("span", { class: "cell" }, [index === 0 ? changedText : new MiniText("费用")]),
        build("span", { class: "cell" }, ["缓存读取"]),
        build("span", { class: "comparison-row-label", title: "gpt-6-sol" }, ["gpt-6-sol"]),
      ]),
    );
  }
  const dynamic = build("div", { id: "dynamic" });
  const body = build("body", {}, [
    build("header", {}, [build("h1", {}, ["总花销"]), ariaTarget, input]),
    build("div", { class: "home-label" }, [build("strong", {}, [homeLabelText])]),
    build("div", { class: "home-path", title: "C:\\Users\\Silver\\.codex" }, [homePathText]),
    build("span", { class: "pricing-model-name" }, [userDataText]),
    build("span", { "data-preset": "week", "data-i18n-en": "This Week" }, [dataI18nEn]),
    build("script", {}, [scriptText]),
    build("pre", {}, [preText]),
    build("span", { "data-i18n-skip": "" }, [skipText]),
    build("div", { id: "table" }, rowElements),
    dynamic,
  ]);
  const documentNode = new MiniDocument(body);
  body.parentNode = documentNode;
  fixtureState.body = body;
  return {
    document: documentNode,
    body,
    build,
    dynamic,
    changedText,
    ariaTarget,
    input,
    dataI18nEn,
    homePathText,
    homeLabelText,
    scriptText,
    preText,
    skipText,
    userDataText,
  };
}

function replaceChildren(parent, children) {
  const removed = parent.childNodes.splice(0, parent.childNodes.length);
  for (const node of removed) node.parentNode = null;
  for (const node of children) {
    node.parentNode = parent;
    parent.childNodes.push(node);
  }
  notifyMutation(parent, { type: "childList", addedNodes: children, removedNodes: removed });
}

function writeSilently(textNode, value) {
  textNode.value = String(value);
}

function emitRecords(observer, records) {
  for (const record of records) observer.queue.push(record);
  scheduleDelivery(observer);
}

function serialize(node) {
  if (node.nodeType === 3) return node.value;
  const attributes = [...node.attributes.entries()]
    .map(([name, value]) => ` ${name}="${value}"`)
    .sort()
    .join("");
  return `<${node.tagName}${attributes}>${node.childNodes.map(serialize).join("")}</${node.tagName}>`;
}

function textOf(node) {
  if (node.nodeType === 3) return node.value;
  return node.childNodes.map(textOf).join("");
}

async function drainFixture(limit = 20) {
  const probe = fixtureState.probe;
  const previousMode = probe.mode;
  probe.mode = "drain";
  let rounds = 0;
  try {
    for (let index = 0; index < limit; index += 1) {
      const callbacks = probe.callbacks;
      const changes = probe.changes.drain;
      const visits = probe.elementVisits + probe.textVisits;
      await new Promise((resolve) => setImmediate(resolve));
      rounds += 1;
      if (
        probe.callbacks === callbacks &&
        probe.changes.drain === changes &&
        probe.elementVisits + probe.textVisits === visits
      )
        break;
    }
  } finally {
    probe.mode = previousMode;
  }
  return rounds;
}

function installDomGlobals(documentNode) {
  const previous = {
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    localStorage: globalThis.localStorage,
  };
  globalThis.document = documentNode;
  globalThis.MutationObserver = MiniMutationObserver;
  globalThis.localStorage = {
    getItem: (key) => (key === "codexUsageLocale" ? "zh-CN" : null),
    setItem() {},
  };
  return previous;
}

function restoreDomGlobals(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
}

function attachObserver(body) {
  if (observerHandle) {
    setLocale("zh-CN", { persist: false });
    observerHandle.observe(body, OBSERVER_OPTIONS);
    return;
  }
  initializeLocale();
  observerHandle = fixtureState.registrations[0].observer;
}

test("formatLocalDateTime reuses one formatter per locale without changing its output", () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  const samples = [
    new Date(Date.UTC(2026, 8, 26, 13, 5, 7)),
    new Date(Date.UTC(2000, 0, 1, 0, 0, 0)),
    "2026-09-26T13:05:07.000Z",
    0,
    null,
    "not-a-date",
    new Date(Number.NaN),
    undefined,
  ];
  const reference = (value, locale) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return localizeText("未知时间", locale);
    return new OriginalDateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  };
  const expected = samples.flatMap((sample) => ["zh-CN", "en-US"].map((locale) => reference(sample, locale)));

  let constructions = 0;
  let afterFirstPass = 0;
  class CountingDateTimeFormat extends OriginalDateTimeFormat {
    constructor(...args) {
      super(...args);
      constructions += 1;
    }
  }
  let actual;
  try {
    globalThis.Intl.DateTimeFormat = CountingDateTimeFormat;
    actual = samples.flatMap((sample) => ["zh-CN", "en-US"].map((locale) => formatLocalDateTime(sample, locale)));
    afterFirstPass = constructions;
    for (let index = 0; index < 20; index += 1) {
      formatLocalDateTime(samples[0], "en-US");
      localizeText("2026年09月", "en-US");
    }
  } finally {
    globalThis.Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
  assert.deepEqual(actual, expected);
  assert.ok(afterFirstPass <= 2, `expected at most two clock formatters, built ${afterFirstPass}`);
  assert.equal(
    constructions,
    afterFirstPass + 1,
    "repeated calls must reuse cached formatters (only the month formatter is new)",
  );
});

test("the observer walks the mutated subtree and still restores the whole page", async () => {
  const fixture = createFixture({ rows: 40 });
  const previous = installDomGlobals(fixture.document);
  try {
    attachObserver(fixture.body);
    await drainFixture();
    assert.equal(getLocale(), "zh-CN");
    assert.equal(fixtureState.probe.bodyVisits, 1, "initializeLocale performs one whole-page pass");
    const chineseSnapshot = serialize(fixture.body);
    const pageVisits = fixtureState.probe.elementVisits + fixtureState.probe.textVisits;
    assert.ok(pageVisits > 200, `fixture must be large enough to measure (${pageVisits} visits)`);
    assert.equal(textOf(fixture.dataI18nEn), "本周");

    // 1. language switch: still one whole-page restore/translation pass
    setLocale("en-US", { persist: false });
    assert.equal(fixtureState.probe.bodyVisits, 2);
    fixtureState.probe.bodyVisits = 0;
    await drainFixture();
    assert.equal(
      fixtureState.probe.bodyVisits,
      0,
      "the observer must not repeat the whole-page pass for its own writes",
    );
    const englishSnapshot = serialize(fixture.body);
    assert.equal(textOf(fixture.dataI18nEn), "This Week");
    assert.equal(fixture.ariaTarget.getAttribute("aria-label"), "Switch Theme");
    assert.equal(fixture.input.getAttribute("placeholder"), "Enter a directory path.");
    assert.equal(fixture.homePathText.value, "C:\\Users\\Silver\\.codex");
    assert.equal(fixture.homeLabelText.value, "Codex home");
    assert.equal(fixture.userDataText.value, "通义千问", "user data must stay untranslated");
    assert.equal(fixture.scriptText.value, "const 计数 = 1;");
    assert.equal(fixture.preText.value, "保留 代码");
    assert.equal(fixture.skipText.value, "不翻译这段");

    // 2. en → zh → en round trip is byte identical in both directions
    setLocale("zh-CN", { persist: false });
    await drainFixture();
    assert.equal(serialize(fixture.body), chineseSnapshot, "English → Chinese must restore the page byte for byte");
    assert.equal(textOf(fixture.dataI18nEn), "本周");
    setLocale("en-US", { persist: false });
    await drainFixture();
    assert.equal(serialize(fixture.body), englishSnapshot, "Chinese → English must reproduce the page byte for byte");

    // 3. one app-style batch: subtree insert + in-place text + attribute writes
    fixtureState.probe.elementVisits = 0;
    fixtureState.probe.textVisits = 0;
    fixtureState.probe.bodyVisits = 0;
    fixtureState.probe.changes.drain = 0;
    fixtureState.probe.mode = "app";
    const inserted = [0, 1, 2].map(() =>
      fixture.build("div", { class: "row" }, [
        fixture.build("span", { class: "cell" }, ["模型"]),
        fixture.build("span", { class: "cell" }, ["费用"]),
        fixture.build("span", { class: "cell" }, ["缓存读取"]),
        fixture.build("input", { placeholder: "请输入目录路径。" }),
      ]),
    );
    replaceChildren(fixture.dynamic, inserted);
    fixture.changedText.nodeValue = "费用";
    fixture.ariaTarget.setAttribute("aria-label", "缓存读取");
    fixture.input.setAttribute("placeholder", "切换语言");
    fixtureState.probe.mode = "drain";
    const batchRounds = await drainFixture();
    const batchVisits = fixtureState.probe.elementVisits + fixtureState.probe.textVisits;
    assert.equal(fixtureState.probe.bodyVisits, 0, "a classified batch must not walk document.body");
    assert.ok(batchVisits < pageVisits / 4, `subtree pass visited ${batchVisits} vs whole page ${pageVisits}`);
    assert.ok(batchRounds <= 4, `observer settled in ${batchRounds} rounds`);
    assert.equal(textOf(fixture.dynamic.childNodes[0]), "ModelsCostCache Hit");
    assert.equal(fixture.dynamic.childNodes[0].childNodes[3].getAttribute("placeholder"), "Enter a directory path.");
    assert.equal(fixture.changedText.value, "Cost");
    assert.equal(fixture.ariaTarget.getAttribute("aria-label"), "Cache Hit");
    assert.equal(fixture.input.getAttribute("placeholder"), "Switch Language");

    // 4. no self-exciting loop: the observer stops re-firing on its own writes
    const idleCallbacks = fixtureState.probe.callbacks;
    const idleChanges = fixtureState.probe.changes.drain;
    const idleVisits = fixtureState.probe.elementVisits + fixtureState.probe.textVisits;
    const idleRounds = await drainFixture();
    assert.equal(fixtureState.probe.callbacks, idleCallbacks, "observer must not keep re-translating the same content");
    assert.equal(fixtureState.probe.changes.drain, idleChanges);
    assert.equal(fixtureState.probe.elementVisits + fixtureState.probe.textVisits, idleVisits);
    assert.equal(idleRounds, 1);

    // 5. zh restores the dynamic batch to the sources the app wrote last
    setLocale("zh-CN", { persist: false });
    await drainFixture();
    assert.equal(fixture.changedText.value, "费用");
    assert.equal(fixture.ariaTarget.getAttribute("aria-label"), "缓存读取");
    assert.equal(fixture.input.getAttribute("placeholder"), "切换语言");
    assert.equal(textOf(fixture.dynamic.childNodes[0]), "模型费用缓存读取");
    assert.equal(fixture.dynamic.childNodes[0].childNodes[3].getAttribute("placeholder"), "请输入目录路径。");
    assert.equal(textOf(fixture.dataI18nEn), "本周");
    assert.equal(fixture.userDataText.value, "通义千问");

    // 6. app.js writes a few attributes already localized; that pattern must keep its
    //    pre-existing recovery semantics (a pre-localized value is kept as the source).
    fixture.ariaTarget.setAttribute("aria-label", "New record");
    await drainFixture();
    assert.equal(fixture.ariaTarget.getAttribute("aria-label"), "New record");
    setLocale("zh-CN", { persist: false });
    await drainFixture();
    assert.equal(fixture.ariaTarget.getAttribute("aria-label"), "New record");
  } finally {
    setLocale("zh-CN", { persist: false });
    restoreDomGlobals(previous);
  }
});

test("unclassifiable or oversized mutation batches fall back to a whole-page translation", async () => {
  const fixture = createFixture({ rows: 4 });
  const previous = installDomGlobals(fixture.document);
  try {
    attachObserver(fixture.body);
    await drainFixture();
    setLocale("en-US", { persist: false });
    await drainFixture();
    assert.equal(textOf(fixture.changedText), "Estimated Cost");

    // a) a mutation record the observer cannot localize must not be skipped
    writeSilently(fixture.changedText, "缓存读取");
    fixtureState.probe.bodyVisits = 0;
    emitRecords(observerHandle, [{ type: "unclassifiable-record", target: fixture.body }]);
    await drainFixture();
    assert.equal(fixtureState.probe.bodyVisits, 1, "unknown records must fall back to the whole page");
    assert.equal(fixture.changedText.value, "Cache Hit", "the fallback pass must translate the missed write");

    // b) more distinct subtrees than the guard in one batch must also fall back
    const many = [];
    for (let index = 0; index < 513; index += 1) many.push(fixture.build("span", { class: "cell" }, ["Models"]));
    replaceChildren(fixture.dynamic, many);
    await drainFixture();
    writeSilently(fixture.changedText, "缓存读取");
    fixtureState.probe.bodyVisits = 0;
    emitRecords(
      observerHandle,
      many.map((node) => ({ type: "childList", target: fixture.dynamic, addedNodes: [node], removedNodes: [] })),
    );
    await drainFixture();
    assert.equal(fixtureState.probe.bodyVisits, 1, "more roots than the guard must fall back to the whole page");
    assert.equal(fixture.changedText.value, "Cache Hit", "the fallback pass must still cover the missed write");
    assert.equal(textOf(fixture.dynamic.childNodes[512]), "Models");

    // c) detached subtrees are skipped; connecting them later applies the skip rules
    const control = fixture.build("div", {}, ["总花销"]);
    replaceChildren(fixture.dynamic, [control]);
    await drainFixture();
    assert.equal(textOf(control), "Estimated Cost");

    const detached = fixture.build("div", { class: "home-path" }, ["总花销"]);
    fixtureState.probe.bodyVisits = 0;
    fixtureState.probe.translatePageCalls = 0;
    emitRecords(observerHandle, [
      { type: "childList", target: fixture.dynamic, addedNodes: [detached], removedNodes: [] },
    ]);
    await drainFixture();
    assert.equal(fixtureState.probe.bodyVisits, 0, "a detached subtree must not trigger a whole-page pass");
    assert.equal(fixtureState.probe.translatePageCalls, 0, "a detached subtree must not be translated yet");
    assert.equal(textOf(detached), "总花销");

    const wrapper = fixture.build("div", {}, []);
    replaceChildren(fixture.dynamic, [wrapper]);
    await drainFixture();
    replaceChildren(wrapper, [detached]);
    await drainFixture();
    assert.equal(textOf(detached), "总花销", "the user-data rule applies once the subtree is connected");
  } finally {
    setLocale("zh-CN", { persist: false });
    restoreDomGlobals(previous);
  }
});

test("目录提示文案在两种语言里都包含 WorkBuddy", () => {
  const emptyState = "没有发现 Codex、ZCode、DSH、OpenCode、Claude Code 或 WorkBuddy 目录";
  const english = localizeText(emptyState, "en-US");
  assert.match(english, /WorkBuddy/);
  assert.equal(localizeText(emptyState, "zh-CN"), emptyState);

  const reason =
    "目录需要是 Codex home、ZCode home、DSH home、OpenCode 数据目录、Claude Code home、WorkBuddy home，或包含 .codex-usage/usage.jsonl";
  const reasonEn = localizeText(reason, "en-US");
  assert.match(reasonEn, /WorkBuddy home/);
  assert.notEqual(reasonEn, reason, "英文文案必须真的翻译过，而不是原样返回中文");
});

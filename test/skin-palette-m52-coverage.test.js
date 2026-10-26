import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  renderBarListHtml,
  renderCostDetailHtml,
  renderHomesHtml,
  renderPricingSourceLinksHtml,
  renderSourceOptionsHtml,
  renderTimelineLegendHtml,
} from "../public/app.js";
import {
  assertRoleSelectorsByState,
  hashRoleInputs,
  sha256Canonical,
  validatePolicy,
} from "../scripts/skin-palette/contracts.mjs";
import { BASE_COLORS, ROLE_CATALOG, ROLES_VERSION, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";
import { describeMatrixCoverage, STATE_MATRIX_GROUPS } from "../scripts/skin-palette/capture.mjs";
import { evaluatePalette } from "../scripts/skin-palette/evaluate.mjs";
import { derivePaletteDeclarationsFromTokens } from "../public/skins.js";
import { compositeSrgb, contrastRatio, hexToSrgb } from "../scripts/skin-palette/color-math.mjs";

const EXPECTED_PANEL_CERAMIC_BG = {
  kind: "linear-gradient",
  angle: 135,
  stops: [
    { offset: 0, color: { kind: "var", name: "--ceramic-top" } },
    { offset: 0.45, color: { kind: "var", name: "--neo-surface" } },
    { offset: 1, color: { kind: "var", name: "--ceramic-bottom" } },
  ],
};

const EXPECTED_GROUP_CERAMIC_BG = {
  kind: "linear-gradient",
  angle: 135,
  stops: [
    { offset: 0, color: { kind: "var", name: "--ceramic-top" } },
    { offset: 0.55, color: { kind: "var", name: "--neo-surface" } },
    { offset: 1, color: { kind: "var", name: "--ceramic-bottom" } },
  ],
};

const EXPECTED_MINI_CERAMIC_BG = {
  kind: "linear-gradient",
  angle: 145,
  stops: [
    { offset: 0, color: { kind: "var", name: "--ceramic-top" } },
    { offset: 1, color: { kind: "var", name: "--ceramic-bottom" } },
  ],
};

const EXPECTED_CERAMIC_WELL_BG = {
  kind: "solid",
  color: { kind: "var", name: "--ceramic-well" },
};

// Fixed regression fixture copied from existing candidate chatgpt-a-882d4d09111f
// (m5-2-pilot-r2); tests must not read transient validation evidence.
const A48_FIRST_CANDIDATE_TOKENS = Object.freeze({
  light: Object.freeze({
    accent: "#3252AD",
    chartText: "#4A505A",
    controlBackground: "#F0F6FF",
    controlBorder: "#E2E6ED",
    controlText: "#1A1F28",
    pageBackground: "#E2ECFC",
    panelBackground: "#F0F6FF",
    panelBorder: "#E2E6ED",
    panelHighlight: "#FCFDFF",
    panelShadow: "#B0B8C4",
    textPrimary: "#1A1F28",
    textSecondary: "#434343",
  }),
  dark: Object.freeze({
    accent: "#96B6FF",
    chartText: "#B0B8C3",
    controlBackground: "#21252D",
    controlBorder: "#2C2F34",
    controlText: "#E8EFFB",
    pageBackground: "#141B26",
    panelBackground: "#21252D",
    panelBorder: "#2C2F34",
    panelHighlight: "#37393D",
    panelShadow: "#010308",
    textPrimary: "#E8EFFB",
    textSecondary: "#B0B8C3",
  }),
});

test("B2-1：详情面板行名称与数值角色精确登记、双向状态镜像与版本同步", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);

  const roleIds = ROLE_CATALOG.map((role) => role.id);
  assert.equal(new Set(roleIds).size, roleIds.length, "ROLE_CATALOG 角色 id 必须唯一");

  const nameRole = ROLE_CATALOG.find((role) => role.id === "panel.detail-bar-name");
  const valueRole = ROLE_CATALOG.find((role) => role.id === "panel.detail-bar-value");
  const modelBarRole = ROLE_CATALOG.find((role) => role.id === "chart.model-bar");
  assert.ok(nameRole, "缺少 panel.detail-bar-name 角色");
  assert.ok(valueRole, "缺少 panel.detail-bar-value 角色");
  assert.ok(modelBarRole, "缺少 chart.model-bar 角色");

  assert.equal(nameRole.kind, "text");
  assert.equal(valueRole.kind, "text");
  assert.equal(nameRole.required, true);
  assert.equal(valueRole.required, true);
  assert.equal(nameRole.threshold, 4.5);
  assert.equal(valueRole.threshold, 4.5);

  assert.equal(nameRole.selector, "#detailList .bar-row > .bar-label > .bar-name");
  assert.equal(valueRole.selector, "#detailList .bar-row > .bar-label > .bar-value");
  assert.notEqual(nameRole.selector, valueRole.selector);
  for (const role of [nameRole, valueRole]) {
    assert.doesNotMatch(role.selector, /\.bar-fill|\.bar-track/);
  }
  assert.deepEqual(nameRole.selectorsByState, {
    "dashboard-default": "#detailList .bar-row > .bar-label > .bar-name",
    "dense-data": "#detailList .bar-row > .bar-label > .bar-name",
    "spotlight-detail-bars":
      "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-name:not(:empty)",
  });
  assert.deepEqual(valueRole.selectorsByState, {
    "dashboard-default": "#detailList .bar-row > .bar-label > .bar-value",
    "dense-data": "#detailList .bar-row > .bar-label > .bar-value",
    "spotlight-detail-bars":
      "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-value:not(:empty)",
  });
  assert.equal(modelBarRole.kind, "graphic");
  assert.equal(modelBarRole.required, false);
  assert.equal(modelBarRole.selector, ".bar-fill");

  assert.deepEqual(nameRole.foreground, { kind: "var", name: "--ink" });
  assert.deepEqual(valueRole.foreground, { kind: "var", name: "--muted" });
  assert.notDeepEqual(nameRole.foreground, valueRole.foreground);
  assert.deepEqual(nameRole.background, EXPECTED_PANEL_CERAMIC_BG);
  assert.deepEqual(valueRole.background, EXPECTED_PANEL_CERAMIC_BG);

  const expectedStates = ["dashboard-default", "dense-data", "spotlight-detail-bars"];
  assert.deepEqual(nameRole.states, expectedStates);
  assert.deepEqual(valueRole.states, expectedStates);

  for (const role of [nameRole, valueRole]) {
    const mirroredStates = STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(role.id)).map(
      (state) => state.id,
    );
    assert.deepEqual(mirroredStates, expectedStates);
    assert.match(role.applicability, /token.*cost.*共用同一叶节点/);
    assert.match(role.applicability, /待实机核验/);
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderBarListHtml"));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderCostDetailHtml"));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css"));
  }

  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
  assert.equal(
    hashRoleInputs(),
    sha256Canonical({
      version: ROLES_VERSION,
      roles: ROLE_CATALOG,
      states: STATE_CATALOG,
      baseColors: BASE_COLORS,
    }),
  );
});

test("B2-1：renderBarListHtml 与 renderCostDetailHtml 共用 .bar-name/.bar-value 叶节点，空数据渲染 .empty", () => {
  const channelHtml = renderBarListHtml([{ name: "Codex CLI", total: { total: 1_250_000 } }]);
  assert.match(channelHtml, /<div class="bar-row"[^>]*>[\s\S]*<div class="bar-label">/);
  assert.match(channelHtml, /<span class="bar-name" title="Codex CLI">Codex CLI<\/span>/);
  assert.match(channelHtml, /<span class="bar-value" title="[^"]+">1\.25M<\/span>/);

  const modelHtml = renderBarListHtml([{ name: "gpt-5.2-codex", total: { total: 3_400_000 } }], null, {
    modelNames: true,
  });
  assert.match(modelHtml, /<span class="bar-name" title="[^"]+">[^<]+<\/span>/);
  assert.match(modelHtml, /<span class="bar-value" title="[^"]+">3\.40M<\/span>/);

  const costHtml = renderCostDetailHtml(
    [{ name: "gpt-5.2-codex", totalUsd: 12.34, currency: "USD" }],
    new Map([["gpt-5.2-codex", "#007d91"]]),
  );
  assert.match(costHtml, /<div class="bar-row"[^>]*>[\s\S]*<div class="bar-label">/);
  assert.match(costHtml, /<span class="bar-name" title="[^"]+">[^<]+<\/span>/);
  assert.match(costHtml, /<span class="bar-value" title="\$12\.34">\$12\.34<\/span>/);

  const emptyBarHtml = renderBarListHtml([]);
  assert.match(emptyBarHtml, /^<div class="empty">[^<]+<\/div>$/);
  assert.doesNotMatch(emptyBarHtml, /bar-name|bar-value|bar-row/);

  const emptyCostHtml = renderCostDetailHtml([]);
  assert.match(emptyCostHtml, /^<div class="empty">[^<]+<\/div>$/);
  assert.doesNotMatch(emptyCostHtml, /bar-name|bar-value|bar-row/);
});

test("B2-2：来源弹窗非排除普通行 ink/muted 两角色精确登记、叶选择器边界与 dialog-import-open 双向镜像", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);

  const roleIds = ROLE_CATALOG.map((role) => role.id);
  assert.equal(new Set(roleIds).size, roleIds.length, "ROLE_CATALOG 角色 id 必须唯一");

  const textRole = ROLE_CATALOG.find((role) => role.id === "dialog.source-option-text");
  const mutedRole = ROLE_CATALOG.find((role) => role.id === "dialog.source-option-muted");
  const excludedRole = ROLE_CATALOG.find((role) => role.id === "status.home-excluded");
  const importOpen = STATE_CATALOG.find((state) => state.id === "dialog-import-open");
  const importExcluded = STATE_CATALOG.find((state) => state.id === "dialog-import-source-excluded");
  assert.ok(textRole, "缺少 dialog.source-option-text 角色");
  assert.ok(mutedRole, "缺少 dialog.source-option-muted 角色");
  assert.ok(excludedRole, "缺少 status.home-excluded 角色");
  assert.ok(importOpen, "缺少 dialog-import-open 状态");
  assert.ok(importExcluded, "缺少 dialog-import-source-excluded 状态");

  const expectedTextSelector =
    "#sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-label > strong";
  const expectedMutedSelector =
    "#sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-label > .home-kind, #sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-path";

  assert.equal(textRole.selector, expectedTextSelector);
  assert.equal(mutedRole.selector, expectedMutedSelector);
  assert.doesNotMatch(textRole.selector, /\.source-option-path|\.home-kind|\.home-excluded/);
  assert.match(mutedRole.selector, /\.source-option-path/);

  for (const role of [textRole, mutedRole]) {
    const branches = role.selector.split(",").map((part) => part.trim());
    for (const branch of branches) {
      assert.match(branch, /^#sourcePicker \.source-option:not\(\.excluded\) > \.source-option-text > /);
      assert.doesNotMatch(branch, />\s*\.source-option-(text|label|meta)\s*$/);
    }
    assert.equal(role.kind, "text");
    assert.equal(role.required, true);
    assert.equal(role.threshold, 4.5);
    assert.deepEqual(role.background, EXPECTED_CERAMIC_WELL_BG);
    assert.deepEqual(role.states, ["dialog-import-open"]);
    assert.equal(role.selectorsByState, undefined);
    const mirroredStates = STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(role.id)).map(
      (state) => state.id,
    );
    assert.deepEqual(mirroredStates, ["dialog-import-open"]);
    assert.equal(importExcluded.expectedRoleIds.includes(role.id), false);
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderSourceOptionsHtml"));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("--ceramic-well")));
  }

  assert.deepEqual(textRole.foreground, { kind: "var", name: "--ink" });
  assert.deepEqual(mutedRole.foreground, { kind: "var", name: "--muted" });
  assert.notDeepEqual(textRole.foreground, mutedRole.foreground);
  assert.equal(
    importOpen.expectedRoleIds.filter((id) => id === "dialog.source-option-text").length,
    1,
    "dialog-import-open.expectedRoleIds 仅登记一次 dialog.source-option-text",
  );
  assert.equal(
    importOpen.expectedRoleIds.filter((id) => id === "dialog.source-option-muted").length,
    1,
    "dialog-import-open.expectedRoleIds 仅登记一次 dialog.source-option-muted",
  );

  // status.home-excluded 保持原有契约未变
  assert.equal(excludedRole.selector, "#sourcePicker .home-excluded");
  assert.deepEqual(excludedRole.states, ["dialog-import-source-excluded"]);
  assert.deepEqual(excludedRole.foreground, { kind: "var", name: "--red" });
  assert.deepEqual(excludedRole.background, EXPECTED_CERAMIC_WELL_BG);

  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B2-2：renderSourceOptionsHtml 普通行、排除行与空来源列表的真实叶节点结构", () => {
  const html = renderSourceOptionsHtml(
    [
      {
        id: "codex-main",
        label: "主目录",
        kind: "main",
        status: "active",
        eventCount: 120,
        sessionCount: 5,
        path: "/Users/dev/.codex",
      },
      {
        id: "zcode-imported",
        label: "ZCode备份",
        kind: "zcode",
        status: "no-events",
        eventCount: 0,
        sessionCount: 0,
        path: "/Users/dev/.zcode",
      },
    ],
    ["zcode-imported"],
  );

  assert.match(
    html,
    /<label class="source-option">\s*<input type="checkbox" data-source-id="codex-main" checked \/>\s*<span class="source-option-text">\s*<span class="source-option-label"><strong>主目录<\/strong><span class="home-kind">codex<\/span><\/span>\s*<span class="source-option-path" title="\/Users\/dev\/\.codex">\/Users\/dev\/\.codex<\/span>\s*<\/span>\s*<\/label>/,
  );
  assert.match(
    html,
    /<label class="source-option excluded">\s*<input type="checkbox" data-source-id="zcode-imported" \/>\s*<span class="source-option-text">\s*<span class="source-option-label"><strong>ZCode备份<\/strong><span class="home-kind">zcode<\/span><\/span>\s*<span class="source-option-meta"><span class="home-excluded">不计入统计<\/span><\/span>\s*<span class="source-option-path" title="\/Users\/dev\/\.zcode">\/Users\/dev\/\.zcode<\/span>\s*<\/span>\s*<\/label>/,
  );

  const emptyHtml = renderSourceOptionsHtml([], []);
  assert.equal(emptyHtml, '<div class="empty">没有可统计的来源</div>');
});

test("B7-2：排除来源必要文字只登记真实名称与路径叶节点并镜像到既有排除状态", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const name = ROLE_CATALOG.find((role) => role.id === "dialog.source-excluded-name");
  const path = ROLE_CATALOG.find((role) => role.id === "dialog.source-excluded-path");
  const badge = ROLE_CATALOG.find((role) => role.id === "status.home-excluded");
  const excludedState = STATE_CATALOG.find((state) => state.id === "dialog-import-source-excluded");

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.ok(name);
  assert.ok(path);
  assert.ok(badge);
  assert.ok(excludedState);
  assert.equal(
    name.selector,
    "#sourcePicker .source-option.excluded > .source-option-text > .source-option-label > strong",
  );
  assert.equal(path.selector, "#sourcePicker .source-option.excluded > .source-option-text > .source-option-path");
  assert.deepEqual(name.foreground, { kind: "alpha", color: { kind: "var", name: "--ink" }, alpha: 0.75 });
  assert.deepEqual(path.foreground, { kind: "alpha", color: { kind: "var", name: "--muted" }, alpha: 0.75 });
  for (const role of [name, path]) {
    assert.equal(role.kind, "text");
    assert.equal(role.required, true);
    assert.equal(role.threshold, 4.5);
    assert.deepEqual(role.background, EXPECTED_CERAMIC_WELL_BG);
    assert.deepEqual(role.states, ["dialog-import-source-excluded"]);
    assert.equal(role.selectorsByState, undefined);
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderSourceOptionsHtml"));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("opacity")));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("--ceramic-well")));
    assert.deepEqual(
      STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(role.id)).map((state) => state.id),
      ["dialog-import-source-excluded"],
    );
  }
  assert.deepEqual(excludedState.expectedRoleIds, [
    "status.home-excluded",
    "dialog.source-excluded-name",
    "dialog.source-excluded-path",
  ]);
  assert.equal(badge.selector, "#sourcePicker .home-excluded");
  assert.deepEqual(badge.states, ["dialog-import-source-excluded"]);
  assert.deepEqual(badge.foreground, { kind: "var", name: "--red" });
  assert.match(badge.applicability, /全强度/);

  const html = renderSourceOptionsHtml(
    [
      {
        id: "excluded",
        label: "Excluded <name>",
        kind: "codex",
        status: "active",
        eventCount: 1,
        sessionCount: 1,
        path: "/tmp/a&b",
      },
    ],
    ["excluded"],
  );
  assert.match(html, /<label class="source-option excluded">/);
  assert.match(html, /<span class="source-option-label"><strong>Excluded &lt;name&gt;<\/strong>/);
  assert.match(html, /<span class="source-option-path" title="\/tmp\/a&amp;b">\/tmp\/a&amp;b<\/span>/);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B10：主页排除名称与路径绑定独立状态、真实转义叶节点和自身透明度", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const name = ROLE_CATALOG.find((role) => role.id === "home.excluded-name");
  const path = ROLE_CATALOG.find((role) => role.id === "home.excluded-path");
  const state = STATE_CATALOG.find((item) => item.id === "home-source-excluded");
  const reason = ROLE_CATALOG.find((role) => role.id === "status.home-reason");
  const reasonState = STATE_CATALOG.find((item) => item.id === "home-list-reason");

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.ok(name);
  assert.ok(path);
  assert.ok(state);
  assert.equal(name.selector, "#homeList .home-row.excluded > .home-label > strong");
  assert.equal(path.selector, "#homeList .home-row.excluded > .home-path");
  for (const role of [name, path]) {
    assert.equal(role.kind, "text");
    assert.deepEqual(role.foreground, { kind: "alpha", color: { kind: "var", name: "--ink" }, alpha: 0.75 });
    assert.deepEqual(role.background, EXPECTED_CERAMIC_WELL_BG);
    assert.equal(role.required, true);
    assert.equal(role.threshold, 4.5);
    assert.deepEqual(role.states, ["home-source-excluded"]);
    assert.equal(role.selectorsByState, undefined);
    assert.match(role.applicability, /opacity 0\.75.*foreground alpha.*登记不代表实测/);
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderHomesHtml"));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("opacity")));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("--ceramic-well")));
    assert.deepEqual(
      STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(role.id)).map((item) => item.id),
      ["home-source-excluded"],
    );
  }
  assert.deepEqual(state.expectedRoleIds, ["home.excluded-name", "home.excluded-path"]);
  assert.deepEqual(state.steps, [{ action: "click", selector: "#addImportButton" }]);
  assert.deepEqual(state.ready, {
    kind: "visible",
    selector: "body:has(#importDialog[hidden]) #homeList .home-row.excluded",
    description: "导入弹窗已关闭且主页来源排除行可见",
  });
  assert.deepEqual(state.restore, [{ action: "click", selector: "#cancelImportButton" }]);
  assert.match(state.note, /专用 S3 handler/);
  assert.match(state.note, /运行时 sourceId/);
  assert.match(state.note, /唯一完整路径/);
  assert.deepEqual(reason.states, ["home-list-reason"]);
  assert.deepEqual(reasonState.expectedRoleIds, ["status.home-reason", "home.remove"]);

  const html = renderHomesHtml(
    [
      {
        id: "home-1",
        label: "Home <name>",
        type: "main",
        status: "active",
        path: "/home/a&b",
        eventCount: 1,
        sessionCount: 1,
      },
    ],
    { excludedIds: ["home-1"] },
  );
  assert.match(html, /<div class="home-row excluded">/);
  assert.match(html, /<div class="home-label">\s*<strong>Home &lt;name&gt;<\/strong>/);
  assert.match(html, /<div class="home-path" title="\/home\/a&amp;b">\/home\/a&amp;b<\/div>/);
  assert.doesNotMatch(html, /data-source-id=/);

  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const excludedTextRule = css.match(
    /\.home-row\.excluded \.home-label strong,\s*\.home-row\.excluded \.home-path\s*\{([^}]*)\}/,
  );
  assert.ok(excludedTextRule, "缺少主页排除名称/路径自身透明度规则");
  assert.match(excludedTextRule[1], /^\s*opacity:\s*0\.75;\s*$/);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B13：主页导入目录移除按钮在 home-list-reason 中按必要文字角色测量", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const role = ROLE_CATALOG.find((item) => item.id === "home.remove");
  const state = STATE_CATALOG.find((item) => item.id === "home-list-reason");

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.ok(role);
  assert.equal(role.kind, "text");
  assert.equal(role.selector, "#homeList .home-remove:enabled");
  assert.deepEqual(role.states, ["home-list-reason"]);
  assert.deepEqual(role.foreground, { kind: "var", name: "--ink" });
  assert.deepEqual(role.background, EXPECTED_MINI_CERAMIC_BG);
  assert.equal(role.threshold, 4.5);
  assert.equal(role.required, true);
  assert.deepEqual(state.expectedRoleIds, ["status.home-reason", role.id]);
  assert.deepEqual(
    STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(role.id)).map((item) => item.id),
    role.states,
  );
  assert.ok(role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderHomesHtml"));
  assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol === ".home-remove"));
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);

  const home = {
    label: "Imported project",
    kind: "project-log",
    path: "/tmp/project&one",
    status: "active",
    imported: true,
  };
  const render = (canModify, imported) => renderHomesHtml([{ ...home, imported }], { canModify });
  assert.match(render(true, true), /class="home-remove"[^>]*data-import-action="remove"/);
  assert.doesNotMatch(render(false, true), /class="home-remove"/);
  assert.doesNotMatch(render(true, false), /class="home-remove"/);
  assert.doesNotMatch(render(false, false), /class="home-remove"/);
});

test("B3-3：自动刷新标题与凹槽两角色精确登记、叶节点边界与 dashboard-default 双向镜像", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);

  const roleIds = ROLE_CATALOG.map((role) => role.id);
  assert.equal(new Set(roleIds).size, roleIds.length, "ROLE_CATALOG 角色 id 必须唯一");

  const textRole = ROLE_CATALOG.find((role) => role.id === "toolbar.autorefresh-text");
  const mutedRole = ROLE_CATALOG.find((role) => role.id === "toolbar.autorefresh-muted");
  const dashboard = STATE_CATALOG.find((state) => state.id === "dashboard-default");
  assert.ok(textRole, "缺少 toolbar.autorefresh-text 角色");
  assert.ok(mutedRole, "缺少 toolbar.autorefresh-muted 角色");
  assert.ok(dashboard, "缺少 dashboard-default 状态");

  assert.equal(textRole.selector, "#lastSuccessfulCheck");
  assert.equal(mutedRole.selector, "#autoRefreshStatus .auto-refresh-label, #autoRefreshInterval");
  assert.notEqual(textRole.selector, mutedRole.selector);

  // 叶节点边界：不得混入开关按钮/spinner/错误行/时区组合控件或凹槽与标题父容器
  for (const role of [textRole, mutedRole]) {
    assert.doesNotMatch(
      role.selector,
      /AutoRefreshToggle|Spinner|autoRefreshError|calendarZone|auto-refresh-heading|auto-refresh-well/,
    );
    assert.equal(role.kind, "text");
    assert.equal(role.required, true);
    assert.equal(role.threshold, 4.5);
    assert.deepEqual(role.states, ["dashboard-default"]);
    assert.equal(role.selectorsByState, undefined);
    const mirroredStates = STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(role.id)).map(
      (state) => state.id,
    );
    assert.deepEqual(mirroredStates, ["dashboard-default"]);
    assert.match(role.applicability, /待实机核验/);
    assert.doesNotMatch(role.applicability, /已实测/);
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/index.html"));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css"));
  }

  assert.deepEqual(textRole.background, EXPECTED_CERAMIC_WELL_BG);
  assert.deepEqual(mutedRole.background, EXPECTED_GROUP_CERAMIC_BG);
  assert.deepEqual(textRole.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(mutedRole.foreground, { kind: "var", name: "--muted" });
  assert.ok(
    textRole.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderAutoRefreshControls"),
  );
  assert.equal(
    dashboard.expectedRoleIds.filter((id) => id === "toolbar.autorefresh-text").length,
    1,
    "dashboard-default.expectedRoleIds 仅登记一次 toolbar.autorefresh-text",
  );
  assert.equal(
    dashboard.expectedRoleIds.filter((id) => id === "toolbar.autorefresh-muted").length,
    1,
    "dashboard-default.expectedRoleIds 仅登记一次 toolbar.autorefresh-muted",
  );

  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B3-3：真实 index/app/CSS 的自动刷新标题与凹槽文本叶节点及色源结构", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

  // 三个目标节点都是无子元素的 span 叶节点，且在真实文档中各自唯一
  for (const pattern of [
    /<span id="autoRefreshInterval">[^<]*<\/span>/,
    /<span class="auto-refresh-label">[^<]*<\/span>/,
    /<span id="lastSuccessfulCheck">[^<]*<\/span>/,
  ]) {
    const matches = html.match(new RegExp(pattern.source, "g"));
    assert.equal(matches?.length, 1, `index.html 应恰有一个叶节点：${String(pattern)}`);
  }

  // 三个叶节点都位于同一个刷新框，标题和间隔位于凹槽之前。
  const statusAt = html.indexOf('id="autoRefreshStatus"');
  const errorAt = html.indexOf('id="autoRefreshError"');
  const targets = [
    ["#autoRefreshInterval", html.indexOf('id="autoRefreshInterval"')],
    [".auto-refresh-label", html.indexOf('class="auto-refresh-label"')],
    ["#lastSuccessfulCheck", html.indexOf('id="lastSuccessfulCheck"')],
  ];
  assert.ok(statusAt >= 0 && errorAt > statusAt, "index.html 缺少 #autoRefreshStatus 或 #autoRefreshError");
  for (const [name, at] of targets) {
    assert.ok(at > statusAt && at < errorAt, `${name} 必须位于 #autoRefreshStatus 内且早于 #autoRefreshError`);
  }
  const wellAt = html.indexOf('class="auto-refresh-well"');
  assert.ok(targets[0][1] < wellAt && targets[1][1] < wellAt && targets[2][1] > wellAt);

  // app 文字更新点：间隔数值与上次检查时间由 renderAutoRefreshControls 写 textContent
  assert.match(app, /querySelector\("#autoRefreshInterval"\)\.textContent/);
  assert.match(app, /querySelector\("#lastSuccessfulCheck"\)\.textContent/);

  // 标签与数值继承控件文字色；实际承载面分别由上述两个角色登记。
  assert.match(css, /\.auto-refresh-label\s*\{[^}]*color:\s*var\(--muted\)/);
  assert.doesNotMatch(css, /#autoRefreshInterval[^{}]*\{[^}]*\bcolor\s*:/);
  assert.doesNotMatch(css, /#lastSuccessfulCheck[^{}]*\{[^}]*\bcolor\s*:/);
  assert.match(css, /body\s*\{[^}]*color:\s*var\(--ink\)/);
  assert.match(css, /\.auto-refresh-well\s*\{[^}]*background:\s*var\(--ceramic-well\)/);
});

test("B3-4：图例名称叶节点角色与面板标题辅助说明扩展的精确登记", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);

  const roleIds = ROLE_CATALOG.map((role) => role.id);
  assert.equal(new Set(roleIds).size, roleIds.length, "ROLE_CATALOG 角色 id 必须唯一");

  const legendRole = ROLE_CATALOG.find((role) => role.id === "chart.legend-label");
  const swatchRole = ROLE_CATALOG.find((role) => role.id === "chart.legend-swatch");
  const headingRole = ROLE_CATALOG.find((role) => role.id === "panel.heading-label");
  const dashboard = STATE_CATALOG.find((state) => state.id === "dashboard-default");
  const dense = STATE_CATALOG.find((state) => state.id === "dense-data");
  assert.ok(legendRole, "缺少 chart.legend-label 角色");
  assert.ok(swatchRole, "缺少 chart.legend-swatch 角色");
  assert.ok(headingRole, "缺少 panel.heading-label 角色");

  // 图例名称：精确叶 selector，排除父容器与相邻色块
  assert.equal(
    legendRole.selector,
    "#timelineLegend:not([hidden]) > .timeline-legend-item > span:not(.timeline-legend-swatch)",
  );
  assert.equal(legendRole.selector.split(",").length, 1);
  assert.doesNotMatch(legendRole.selector, /^#timelineLegend$/);
  assert.doesNotMatch(legendRole.selector, /\.timeline-legend-item\s*$/);
  assert.match(legendRole.selector, /:not\(\.timeline-legend-swatch\)/);
  assert.equal(legendRole.kind, "text");
  assert.equal(legendRole.required, true);
  assert.equal(legendRole.threshold, 4.5);
  assert.deepEqual(legendRole.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(legendRole.background, EXPECTED_PANEL_CERAMIC_BG);
  assert.deepEqual(legendRole.states, ["dashboard-default", "dense-data"]);
  assert.equal(legendRole.selectorsByState, undefined);
  assert.match(legendRole.applicability, /渠道.*模型.*花销/);
  assert.match(legendRole.applicability, /待实机核验/);
  assert.doesNotMatch(legendRole.applicability, /已实测/);
  assert.ok(
    legendRole.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderTimelineLegendHtml"),
  );
  assert.ok(legendRole.sourceRefs.some((ref) => ref.file === "public/index.html" && ref.symbol === "#timelineLegend"));
  assert.ok(legendRole.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("--muted")));
  const legendMirror = STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(legendRole.id)).map(
    (state) => state.id,
  );
  assert.deepEqual(legendMirror, ["dashboard-default", "dense-data"]);
  assert.equal(dashboard.expectedRoleIds.filter((id) => id === legendRole.id).length, 1);
  assert.equal(dense.expectedRoleIds.filter((id) => id === legendRole.id).length, 1);

  // 原色块角色语义保持
  assert.equal(swatchRole.kind, "graphic");
  assert.equal(swatchRole.selector, ".timeline-legend-swatch");
  assert.deepEqual(swatchRole.states, ["dense-data"]);
  assert.equal(swatchRole.threshold, 3);
  assert.equal(swatchRole.required, true);

  // 原始 selector 保持；两个新增状态分别限定时间分布与详情面板宿主
  const headingBranches = headingRole.selector.split(",").map((branch) => branch.trim());
  assert.deepEqual(headingBranches, [".panel-heading span"]);
  assert.deepEqual(headingRole.states, ["dashboard-default", "spotlight-timeline-heading", "spotlight-detail-bars"]);
  assert.deepEqual(headingRole.selectorsByState, {
    "dashboard-default": ".panel-heading span",
    "spotlight-timeline-heading":
      ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #rangeLabel",
    "spotlight-detail-bars": "#detailPanel[data-spotlight-active] > .panel-heading > #detailModeLabel:not(:empty)",
  });
  assert.deepEqual(headingRole.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(headingRole.background, EXPECTED_PANEL_CERAMIC_BG);
  assert.equal(headingRole.required, true);
  assert.equal(headingRole.threshold, 4.5);
  assert.equal(headingRole.kind, "text");
  const headingMirror = STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(headingRole.id)).map(
    (state) => state.id,
  );
  assert.deepEqual(headingMirror, ["dashboard-default", "spotlight-timeline-heading", "spotlight-detail-bars"]);
  assert.ok(
    headingRole.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol === ".panel-heading span"),
  );

  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B3-4：renderTimelineLegendHtml 三模式名称叶节点，表头不再插入统计截止说明", () => {
  // channel：显式颜色 Map，输出真实名称叶 span（与色块兄弟节点分离）
  const channelHtml = renderTimelineLegendHtml(
    { timeline: [{ channels: [{ name: "Codex CLI", total: { total: 1200 } }] }] },
    "channel",
    new Map([["Codex CLI", "#007d91"]]),
    new Map(),
  );
  assert.equal(
    channelHtml,
    '<span class="timeline-legend-item" role="listitem"><span class="timeline-legend-swatch" style="background:#007d91"></span><span title="Codex CLI">Codex CLI</span></span>',
  );

  // model：显示名走 displayModelName（小写），颜色走显式 Map 避免 document 默认路径
  const modelHtml = renderTimelineLegendHtml(
    { timeline: [{ models: [{ name: "gpt-5.2-codex", total: { total: 500 } }] }] },
    "model",
    new Map(),
    new Map([["gpt-5.2-codex", "#007d91"]]),
  );
  assert.match(
    modelHtml,
    /<span class="timeline-legend-swatch" style="background:#007d91"><\/span><span title="gpt-5\.2-codex">gpt-5\.2-codex<\/span>/,
  );

  // cost：金额来源 costByModel，名称同为叶 span
  const costHtml = renderTimelineLegendHtml(
    { timeline: [{ costByModel: { "gpt-5.2-codex": { totalUsd: 3.5 } } }] },
    "cost",
    new Map(),
    new Map([["gpt-5.2-codex", "#007d91"]]),
  );
  assert.match(costHtml, /<span title="gpt-5\.2-codex">gpt-5\.2-codex<\/span>/);
  assert.doesNotMatch(costHtml, /bar-name|bar-value/);

  // 转义名称（channel 走原始名 escapeHtml）
  const escapedHtml = renderTimelineLegendHtml(
    { timeline: [{ channels: [{ name: "a<b&c", total: { total: 1 } }] }] },
    "channel",
    new Map([["a<b&c", "#007d91"]]),
    new Map(),
  );
  assert.match(escapedHtml, /<span title="a&lt;b&amp;c">a&lt;b&amp;c<\/span>/);
  assert.doesNotMatch(escapedHtml, /<b&c/);

  // 空系列与零值系列都不产生叶节点
  assert.equal(renderTimelineLegendHtml({ timeline: [] }, "channel", new Map(), new Map()), "");
  assert.equal(
    renderTimelineLegendHtml(
      { timeline: [{ channels: [{ name: "zero", total: { total: 0 } }] }] },
      "channel",
      new Map([["zero", "#007d91"]]),
      new Map(),
    ),
    "",
  );

  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(html + app + css, /comparison-as-of|asOfText/);
});

test("B4-3：范围标签作为普通必要文字精确登记并镜像到 dashboard-default", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const role = ROLE_CATALOG.find((item) => item.id === "toolbar.range-label");
  const dashboard = STATE_CATALOG.find((item) => item.id === "dashboard-default");

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.equal(ROLE_CATALOG.filter((item) => item.id === "toolbar.range-label").length, 1);
  assert.ok(role, "缺少 toolbar.range-label 角色");
  assert.equal(role.kind, "text");
  assert.equal(role.selector, ".toolbar > .range-controls > .range-heading > span");
  assert.deepEqual(role.states, ["dashboard-default"]);
  assert.equal(role.selectorsByState, undefined);
  assert.deepEqual(role.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(role.background, EXPECTED_GROUP_CERAMIC_BG);
  assert.equal(role.threshold, 4.5);
  assert.equal(role.required, true);
  assert.match(role.applicability, /普通范围组标题.*必要文字/);
  assert.match(role.applicability, /待实机核验/);
  assert.ok(role.sourceRefs.some((ref) => ref.file === "public/index.html" && ref.line === 72));
  assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.line === 145));
  assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.line === 614));
  assert.equal(dashboard.expectedRoleIds.filter((id) => id === role.id).length, 1);
  assert.deepEqual(
    STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(role.id)).map((state) => state.id),
    ["dashboard-default"],
  );

  assert.match(
    html,
    /<div class="control-group range-controls">\s*<div class="range-heading">\s*<span>范围<\/span>\s*<\/div>\s*<div class="segmented" id="presetButtons">/,
  );
  assert.match(css, /\.control-group span,\s*label\s*\{[^}]*color:\s*var\(--muted\)[^}]*font-size:\s*13px/);
  const groupRule = css.match(/\.toolbar > \.control-group\s*\{([^}]*)\}/);
  assert.ok(groupRule, "缺少 toolbar control-group 表面规则");
  assert.match(
    groupRule[1],
    /background:\s*linear-gradient\(135deg,\s*var\(--ceramic-top\),\s*var\(--neo-surface\)\s*55%,\s*var\(--ceramic-bottom\)\)/,
  );
  assert.match(groupRule[1], /box-shadow:\s*var\(--neo-raised\)/);
  const toolbarReset = css.match(
    /\.toolbar\s*\{\s*padding:\s*0;\s*border:\s*0;\s*border-radius:\s*0;\s*background:\s*transparent;\s*box-shadow:\s*none;/,
  );
  assert.ok(toolbarReset, "后半段仍将 toolbar 本身恢复为透明、无阴影");
  assert.ok(groupRule.index < toolbarReset.index, "control-group 凸起表面早于 toolbar 透明重置");
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B5-2/B15：总 tokens 标签与数值聚光态在角色、状态与 S6 矩阵中双向接线", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const stateId = "spotlight-metric-label";
  const labelSelector = ".metric:has(> #totalTokens) > span:not(.metric-new)";
  const valueSelector = ".metric:has(> #totalTokens) > #totalTokens";
  const role = ROLE_CATALOG.find((item) => item.id === "panel.metric-label");
  const valueRole = ROLE_CATALOG.find((item) => item.id === "panel.metric-value");
  const dashboard = STATE_CATALOG.find((item) => item.id === "dashboard-default");
  const state = STATE_CATALOG.find((item) => item.id === stateId);
  const s6 = STATE_MATRIX_GROUPS.find((group) => group.id === "S6");
  const unit = s6?.units.find((item) => item.id === stateId);

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.equal(STATE_CATALOG.filter((item) => item.id === stateId).length, 1);
  assert.ok(role);
  assert.ok(valueRole);
  assert.ok(dashboard);
  assert.ok(state);
  assert.equal(role.selector, ".metric span");
  assert.deepEqual(role.states, ["dashboard-default", stateId]);
  assert.deepEqual(role.selectorsByState, {
    "dashboard-default": ".metric span",
    [stateId]: labelSelector,
  });
  assert.deepEqual(role.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(role.background, EXPECTED_PANEL_CERAMIC_BG);
  assert.equal(role.threshold, 4.5);
  assert.equal(role.required, true);
  assert.deepEqual(
    STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(role.id)).map((item) => item.id),
    role.states,
  );
  assert.equal(valueRole.kind, "text");
  assert.equal(valueRole.selector, ".metric strong");
  assert.deepEqual(valueRole.states, ["dashboard-default", stateId]);
  assert.deepEqual(valueRole.selectorsByState, {
    "dashboard-default": ".metric strong",
    [stateId]: valueSelector,
  });
  assert.deepEqual(valueRole.foreground, { kind: "var", name: "--ink" });
  assert.deepEqual(valueRole.background, EXPECTED_CERAMIC_WELL_BG);
  assert.equal(valueRole.threshold, 4.5);
  assert.equal(valueRole.required, true);
  assert.deepEqual(
    STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(valueRole.id)).map((item) => item.id),
    valueRole.states,
  );
  assert.ok(dashboard.expectedRoleIds.includes(valueRole.id));
  assert.equal(state.label, "总 tokens 卡同宿主普通标签与数值聚光态");
  assert.deepEqual(state.steps, [
    { action: "hover", selector: ".metric:has(> #totalTokens) > span:not(.metric-new):not([hidden])" },
  ]);
  assert.equal(state.ready.kind, "spotlightHost");
  assert.equal(
    state.ready.selector,
    ".shell .metric[data-spotlight-active]:has(> #totalTokens):has(> span:not(.metric-new):not([hidden]):not(:empty))",
  );
  assert.deepEqual(state.restore, [{ action: "setSpotlight", value: "off" }]);
  assert.deepEqual(state.expectedRoleIds, ["panel.metric-label", "panel.metric-value"]);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);

  assert.deepEqual(
    s6?.units.map((item) => item.id),
    [
      "characters-off",
      "characters-100",
      "spotlight-on",
      "spotlight-on-characters-100",
      "spotlight-language-selected",
      stateId,
      "spotlight-timeline-heading",
      "spotlight-detail-bars",
      "spotlight-detail-fill",
    ],
  );
  assert.ok(unit);
  assert.deepEqual(unit, {
    id: stateId,
    kind: "catalog",
    stateId,
    clipSelector: ".metric:has(> #totalTokens)",
    preserveTriggerViewport: true,
    preSteps: [
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
      { action: "setSpotlight", value: "off" },
    ],
  });
  assert.deepEqual(describeMatrixCoverage(["S6"]).get(stateId), [stateId]);
});

test("C45：语言按钮普通背景对齐迷你凸起面，zh-CN 选中叶进入独立聚光文字角色", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const stateId = "spotlight-language-selected";
  const ordinary = ROLE_CATALOG.find((item) => item.id === "toggle.language-selected");
  const role = ROLE_CATALOG.find((item) => item.id === "spotlight.language-selected");
  const state = STATE_CATALOG.find((item) => item.id === stateId);
  const s6 = STATE_MATRIX_GROUPS.find((group) => group.id === "S6");
  const unit = s6?.units.find((item) => item.id === stateId);
  const selectedSelector =
    ".shell #languageToggle[data-spotlight-active][aria-pressed='false'] > [data-language='zh-CN'].is-selected:not(:empty)";
  const readySelector =
    ".shell #languageToggle[data-spotlight-active][aria-pressed='false']:has(> [data-language='zh-CN'].is-selected:not(:empty)):has(> [data-language='en-US']:not(.is-selected):not(:empty))";

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.ok(ordinary);
  assert.ok(role);
  assert.ok(state);
  assert.ok(unit);

  assert.equal(ordinary.selector, ".language-toggle > .is-selected");
  assert.deepEqual(ordinary.states, ["dashboard-default"]);
  assert.deepEqual(ordinary.background, EXPECTED_MINI_CERAMIC_BG);
  assert.deepEqual(ordinary.foreground, { kind: "var", name: "--toggle-selected" });
  assert.equal(ordinary.threshold, 4.5);
  assert.equal(ordinary.required, true);
  assert.ok(ordinary.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.line === 2908));

  assert.equal(role.kind, "text");
  assert.equal(role.selector, selectedSelector);
  assert.deepEqual(role.states, [stateId]);
  assert.deepEqual(role.foreground, { kind: "var", name: "--toggle-selected" });
  assert.equal(role.background.kind, "layered");
  assert.equal(role.background.browserRequired, true);
  assert.match(role.background.description, /145.*radial.*22%/);
  assert.equal(role.threshold, 4.5);
  assert.equal(role.required, true);
  assert.match(role.applicability, /aria-label 不替代视觉语言指示/);
  assert.match(role.applicability, /en-US.*同一必要作用/);
  assert.deepEqual(
    STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(role.id)).map((item) => item.id),
    role.states,
  );

  assert.deepEqual(state, {
    id: stateId,
    label: "语言按钮选中项聚光态（zh-CN）",
    steps: [
      { action: "hover", selector: "#languageToggle[aria-pressed='false'] > [data-language='zh-CN'].is-selected" },
    ],
    ready: {
      kind: "spotlightHost",
      selector: readySelector,
      description: "唯一 languageToggle 凸起宿主激活，zh-CN 选中叶与非选中 en-US 叶身份同时成立",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["spotlight.language-selected"],
    note: "只 hover 严格选中的 zh-CN 叶；不点击按钮，不切换 locale",
  });
  assert.equal(
    state.steps.some((step) => step.action === "click"),
    false,
  );
  assert.deepEqual(unit, {
    id: stateId,
    kind: "catalog",
    stateId,
    clipSelector: "#languageToggle",
    preserveTriggerViewport: true,
    preSteps: [{ action: "setSpotlight", value: "off" }],
  });
  assert.deepEqual(describeMatrixCoverage(["S6"]).get(stateId), [stateId]);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("A11：时间分布标题与范围说明共享宿主聚光状态，详情行保持分离", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const stateId = "spotlight-timeline-heading";
  const state = STATE_CATALOG.find((item) => item.id === stateId);
  const title = ROLE_CATALOG.find((item) => item.id === "panel.section-title");
  const heading = ROLE_CATALOG.find((item) => item.id === "panel.heading-label");
  const detailName = ROLE_CATALOG.find((item) => item.id === "panel.detail-bar-name");
  const detailValue = ROLE_CATALOG.find((item) => item.id === "panel.detail-bar-value");

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.equal(STATE_CATALOG.filter((item) => item.id === stateId).length, 1);
  assert.ok(state);
  assert.deepEqual(state, {
    id: stateId,
    label: "时间分布卡标题与范围说明聚光态",
    steps: [{ action: "hover", selector: "#timelinePanelTitle" }],
    ready: {
      kind: "spotlightHost",
      selector:
        ".shell .chart-panel[data-spotlight-active]:has(> .timeline-heading > .timeline-title > #timelinePanelTitle:not(:empty)):has(> .timeline-heading > .timeline-title > #rangeLabel:not(:empty))",
      description: "唯一图表面板活动且两叶非空",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["panel.section-title", "panel.heading-label"],
    note: "标题与范围说明共用图表面板宿主；实际叠加底色须 M3 验证，详情宿主不在本状态",
  });

  assert.ok(title);
  assert.ok(heading);
  assert.ok(detailName);
  assert.ok(detailValue);
  assert.equal(title.selector, ".panel-heading h2");
  assert.equal(heading.selector, ".panel-heading span");
  assert.deepEqual(title.states, ["dashboard-default", stateId, "spotlight-detail-bars"]);
  assert.deepEqual(heading.states, ["dashboard-default", stateId, "spotlight-detail-bars"]);
  assert.deepEqual(title.selectorsByState, {
    "dashboard-default": ".panel-heading h2",
    [stateId]: ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #timelinePanelTitle",
    "spotlight-detail-bars": "#detailPanel[data-spotlight-active] > .panel-heading > #detailPanelTitle:not(:empty)",
  });
  assert.deepEqual(heading.selectorsByState, {
    "dashboard-default": ".panel-heading span",
    [stateId]: ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #rangeLabel",
    "spotlight-detail-bars": "#detailPanel[data-spotlight-active] > .panel-heading > #detailModeLabel:not(:empty)",
  });

  for (const role of [title, heading]) {
    assert.equal(role.kind, "text");
    assert.deepEqual(role.background, EXPECTED_PANEL_CERAMIC_BG);
    assert.equal(role.threshold, 4.5);
    assert.equal(role.required, true);
    assert.deepEqual(
      STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(role.id)).map((item) => item.id),
      role.states,
    );
  }
  assert.deepEqual(title.foreground, { kind: "var", name: "--ink" });
  assert.deepEqual(heading.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(detailName.states, ["dashboard-default", "dense-data", "spotlight-detail-bars"]);
  assert.deepEqual(detailValue.states, ["dashboard-default", "dense-data", "spotlight-detail-bars"]);
  assert.equal(state.expectedRoleIds.includes(detailName.id), false);
  assert.equal(state.expectedRoleIds.includes(detailValue.id), false);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("A17：详情文字聚光态复用四个必需角色并绑定独立详情宿主", () => {
  const stateId = "spotlight-detail-bars";
  const state = STATE_CATALOG.find((item) => item.id === stateId);
  const title = ROLE_CATALOG.find((item) => item.id === "panel.section-title");
  const heading = ROLE_CATALOG.find((item) => item.id === "panel.heading-label");
  const name = ROLE_CATALOG.find((item) => item.id === "panel.detail-bar-name");
  const value = ROLE_CATALOG.find((item) => item.id === "panel.detail-bar-value");
  const s6 = STATE_MATRIX_GROUPS.find((group) => group.id === "S6");
  const readySelector =
    ".shell #detailPanel[data-spotlight-active]:has(> .panel-heading > #detailPanelTitle:not(:empty)):has(> .panel-heading > #detailModeLabel:not(:empty)):has(> #detailList:not([hidden]) > .bar-row > .bar-label > .bar-name:not(:empty) + .bar-value:not(:empty))";

  assert.equal(STATE_CATALOG.length, 41);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.ok(state);
  assert.ok(title);
  assert.ok(heading);
  assert.ok(name);
  assert.ok(value);
  assert.ok(s6);
  const roleIds = [title.id, heading.id, name.id, value.id];
  assert.deepEqual(state, {
    id: stateId,
    label: "详情面板名称与数值聚光态（全部范围、按渠道）",
    steps: [{ action: "hover", selector: "#detailList > .bar-row:first-child > .bar-label > .bar-name" }],
    ready: {
      kind: "spotlightHost",
      selector: readySelector,
      description:
        "捕获前置固定全部范围与按渠道；详情面板为唯一活动宿主，标题、模式及同一 bar-label 的相邻名称和值非空",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["panel.section-title", "panel.heading-label", "panel.detail-bar-name", "panel.detail-bar-value"],
  });
  assert.deepEqual(roleIds, state.expectedRoleIds);
  for (const role of [title, heading, name, value]) {
    assert.ok(role.states.includes(stateId));
    assert.ok(state.expectedRoleIds.includes(role.id));
    assert.deepEqual(
      STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(role.id)).map((item) => item.id),
      role.states,
    );
  }
  assert.equal(
    name.selectorsByState[stateId],
    "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-name:not(:empty)",
  );
  assert.equal(
    value.selectorsByState[stateId],
    "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-value:not(:empty)",
  );
  assert.deepEqual(
    s6.units.map((item) => item.id),
    [
      "characters-off",
      "characters-100",
      "spotlight-on",
      "spotlight-on-characters-100",
      "spotlight-language-selected",
      "spotlight-metric-label",
      "spotlight-timeline-heading",
      stateId,
      "spotlight-detail-fill",
    ],
  );
  assert.match(readySelector, /\.bar-name:not\(:empty\) \+ \.bar-value:not\(:empty\)/);
  assert.deepEqual(describeMatrixCoverage(["S6"]).get(stateId), [stateId]);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B20：估价说明直接展示，保留真实链接渲染与独立取证单元", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const noteText = ROLE_CATALOG.find((role) => role.id === "cost.note-text");
  const noteLink = ROLE_CATALOG.find((role) => role.id === "cost.note-link");
  const dashboard = STATE_CATALOG.find((state) => state.id === "dashboard-default");
  const details = STATE_CATALOG.find((state) => state.id === "cost-details-open");

  assert.equal(ROLES_VERSION, 41);
  assert.equal(policy.versions.roles, 41);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ROLE_CATALOG.length, 77);
  assert.equal(STATE_CATALOG.length, 41);
  assert.ok(noteText);
  assert.ok(noteLink);
  assert.deepEqual(details.expectedRoleIds, ["cost.note-text", "cost.note-link"]);
  assert.deepEqual(details.steps, [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }]);
  assert.equal(details.ready.selector, "#costEstimateNote p");
  assert.deepEqual(details.restore, []);
  assert.equal(noteText.selector, "#costEstimateNote > p, #costEstimateNote li");
  assert.equal(noteLink.selector, "#costEstimateNote a");
  assert.doesNotMatch(noteText.selector, /#costEstimateNote a(?:$|\s|,)/);
  assert.equal(noteText.selectorsByState, undefined);
  assert.equal(noteLink.selectorsByState, undefined);

  for (const role of [noteText, noteLink]) {
    assert.equal(role.kind, "text");
    assert.deepEqual(role.states, ["cost-details-open"]);
    assert.deepEqual(role.background, EXPECTED_CERAMIC_WELL_BG);
    assert.equal(role.threshold, 4.5);
    assert.equal(role.required, true);
    assert.equal(dashboard.expectedRoleIds.includes(role.id), false);
    assert.equal(details.expectedRoleIds.filter((id) => id === role.id).length, 1);
    assert.deepEqual(
      STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(role.id)).map((state) => state.id),
      ["cost-details-open"],
    );
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderCostMetrics"));
    assert.ok(
      role.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderPricingSourceLinksHtml"),
    );
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.line === 952));
    assert.ok(role.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.line === 3105));
  }
  assert.deepEqual(noteText.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(noteLink.foreground, { kind: "computed", property: "color" });
  assert.match(noteText.applicability, /自身文字范围.*链接文字由 cost\.note-link 独立登记/);
  assert.match(noteText.applicability, /B18.*own-text range.*空范围.*不得记为 PASS/);
  assert.match(noteText.applicability, /估价不可用.*div.*未被本角色覆盖/);
  assert.match(noteLink.applicability, /浏览器实际文字前景.*browser-required、ratio=null/);
  assert.match(noteLink.applicability, /不得用父级 --muted 替代/);
  assert.match(noteLink.applicability, /下划线与 :visited.*尚未验收/);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);

  const html = renderPricingSourceLinksHtml(
    ["https://platform.claude.com/pricing", "https://developers.openai.com/api/docs/pricing"],
    ["USD"],
  );
  assert.equal((html.match(/<a href=/g) ?? []).length, 2);
  assert.match(
    html,
    /<a href="https:\/\/platform\.claude\.com\/pricing" target="_blank" rel="noopener noreferrer">Anthropic 定价<\/a>/,
  );
  assert.match(
    html,
    /<a href="https:\/\/developers\.openai\.com\/api\/docs\/pricing" target="_blank" rel="noopener noreferrer">OpenAI 价格表<\/a>/,
  );
  assert.doesNotMatch(html, /\bstyle\s*=|color\s*:/i);
});

test("A48：首候选历史 0.55 声明回归——旧声明 PASS 与 A48 修正后 FAIL", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

  const targetIds = [
    "input.value",
    "input.placeholder",
    "home.excluded-name",
    "home.excluded-path",
    "dialog.source-excluded-name",
    "dialog.source-excluded-path",
  ];
  const currentRoles = new Map(
    ROLE_CATALOG.filter((role) => targetIds.includes(role.id)).map((role) => [role.id, role]),
  );
  for (const id of targetIds) assert.ok(currentRoles.has(id), `缺少 A48 角色 ${id}`);

  const historicalExcludedForegrounds = new Map([
    ["home.excluded-name", { kind: "alpha", color: { kind: "var", name: "--ink" }, alpha: 0.55 }],
    ["home.excluded-path", { kind: "alpha", color: { kind: "var", name: "--ink" }, alpha: 0.55 }],
    ["dialog.source-excluded-name", { kind: "alpha", color: { kind: "var", name: "--ink" }, alpha: 0.55 }],
    ["dialog.source-excluded-path", { kind: "alpha", color: { kind: "var", name: "--muted" }, alpha: 0.55 }],
  ]);
  const historicalRoles = new Map(
    [...currentRoles].map(([id, role]) => [
      id,
      {
        ...role,
        foreground:
          id === "input.value" || id === "input.placeholder" ? role.foreground : historicalExcludedForegrounds.get(id),
        background: EXPECTED_CERAMIC_WELL_BG,
      },
    ]),
  );

  const legacyCatalog = [...historicalRoles.values()].map((role) => ({
    ...role,
    foreground: role.id === "input.value" || role.id === "input.placeholder" ? role.foreground : role.foreground.color,
    background:
      role.id === "input.value" || role.id === "input.placeholder"
        ? { kind: "solid", color: { kind: "var", name: "--control" } }
        : role.background,
  }));
  const evaluate = (mode, roleCatalog) =>
    evaluatePalette({
      skinId: "chatgpt",
      mode,
      tokens: A48_FIRST_CANDIDATE_TOKENS[mode],
      roleCatalog,
      policy,
    });

  const legacyLight = evaluate("light", legacyCatalog);
  for (const entry of legacyLight.entries) assert.equal(entry.status, "pass", `${entry.roleId} 旧声明应为 PASS`);

  const light = evaluate("light", [...historicalRoles.values()]);
  const lightById = new Map(light.entries.map((entry) => [entry.roleId, entry]));
  for (const id of targetIds.slice(1)) assert.equal(lightById.get(id).status, "fail", `${id} 新声明应静态 FAIL`);

  const lightDecl = new Map(derivePaletteDeclarationsFromTokens(A48_FIRST_CANDIDATE_TOKENS.light, "light"));
  const lightWell = hexToSrgb(lightDecl.get("--ceramic-well"));
  const lightInk = hexToSrgb(lightDecl.get("--ink"));
  const lightMuted = hexToSrgb(lightDecl.get("--muted"));
  assert.equal(lightDecl.get("--ceramic-well").toUpperCase(), "#D7E1F0");
  assert.equal(
    lightById.get("input.placeholder").ratio,
    contrastRatio(compositeSrgb(lightMuted, 0.76, lightWell), lightWell),
  );
  assert.equal(
    lightById.get("home.excluded-name").ratio,
    contrastRatio(compositeSrgb(lightInk, 0.55, lightWell), lightWell),
  );
  assert.equal(
    lightById.get("home.excluded-path").ratio,
    contrastRatio(compositeSrgb(lightInk, 0.55, lightWell), lightWell),
  );
  assert.equal(
    lightById.get("dialog.source-excluded-name").ratio,
    contrastRatio(compositeSrgb(lightInk, 0.55, lightWell), lightWell),
  );
  assert.equal(
    lightById.get("dialog.source-excluded-path").ratio,
    contrastRatio(compositeSrgb(lightMuted, 0.55, lightWell), lightWell),
  );

  const dark = evaluate("dark", [...historicalRoles.values()]);
  const darkById = new Map(dark.entries.map((entry) => [entry.roleId, entry]));
  const darkDecl = new Map(derivePaletteDeclarationsFromTokens(A48_FIRST_CANDIDATE_TOKENS.dark, "dark"));
  const darkWell = hexToSrgb(darkDecl.get("--ceramic-well"));
  const darkMuted = hexToSrgb(darkDecl.get("--muted"));
  assert.equal(darkById.get("dialog.source-excluded-name").status, "pass");
  assert.equal(darkById.get("dialog.source-excluded-path").status, "fail");
  assert.equal(
    darkById.get("dialog.source-excluded-path").ratio,
    contrastRatio(compositeSrgb(darkMuted, 0.55, darkWell), darkWell),
  );
});

test("A51：排除叶当前 0.75 CSS 与角色 alpha、对比度公式一致", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  const sourceRule = css.match(
    /\.source-option\.excluded \.source-option-label strong,\s*\.source-option\.excluded \.source-option-path\s*\{([^}]*)\}/,
  );
  const homeRule = css.match(
    /\.home-row\.excluded \.home-label strong,\s*\.home-row\.excluded \.home-path\s*\{([^}]*)\}/,
  );
  assert.ok(sourceRule, "缺少来源弹窗排除行名称/路径透明度规则");
  assert.ok(homeRule, "缺少主页排除行名称/路径透明度规则");
  assert.match(sourceRule[1], /^\s*opacity:\s*0\.75;\s*$/);
  assert.match(homeRule[1], /^\s*opacity:\s*0\.75;\s*$/);
  assert.match(css, /button:disabled\s*\{[^}]*opacity:\s*0\.55;/);
  assert.match(css, /\.date-picker-clear:disabled\s*\{[^}]*opacity:\s*0\.55;/);
  assert.equal((css.match(/opacity:\s*0\.55;/g) ?? []).length, 2, "排除叶改值不得顺手改动其它 0.55");
  assert.equal((css.match(/opacity:\s*0\.75;/g) ?? []).length, 2, "仅两条排除叶规则应使用 0.75");

  const roles = new Map(
    ROLE_CATALOG.filter((role) =>
      [
        "home.excluded-name",
        "home.excluded-path",
        "dialog.source-excluded-name",
        "dialog.source-excluded-path",
      ].includes(role.id),
    ).map((role) => [role.id, role]),
  );
  for (const id of ["home.excluded-name", "home.excluded-path"]) {
    assert.equal(roles.get(id).foreground.alpha, 0.75);
    assert.equal(roles.get(id).threshold, 4.5);
  }
  for (const id of ["dialog.source-excluded-name", "dialog.source-excluded-path"]) {
    assert.equal(roles.get(id).foreground.alpha, 0.75);
    assert.equal(roles.get(id).threshold, 4.5);
  }
  assert.deepEqual(ROLE_CATALOG.find((role) => role.id === "status.home-excluded").foreground, {
    kind: "var",
    name: "--red",
  });

  const evaluate = (mode) =>
    evaluatePalette({
      skinId: "chatgpt",
      mode,
      tokens: A48_FIRST_CANDIDATE_TOKENS[mode],
      roleCatalog: ROLE_CATALOG,
      policy,
    });
  const assertFormula = (mode, inkOrMutedByRole) => {
    const result = evaluate(mode);
    const byId = new Map(result.entries.map((entry) => [entry.roleId, entry]));
    const declarations = new Map(derivePaletteDeclarationsFromTokens(A48_FIRST_CANDIDATE_TOKENS[mode], mode));
    const well = hexToSrgb(declarations.get("--ceramic-well"));
    for (const [id, token] of Object.entries(inkOrMutedByRole)) {
      const foreground = hexToSrgb(declarations.get(token));
      const role = roles.get(id);
      assert.equal(byId.get(id).ratio, contrastRatio(compositeSrgb(foreground, role.foreground.alpha, well), well));
    }
  };
  assertFormula("light", {
    "home.excluded-name": "--ink",
    "home.excluded-path": "--ink",
    "dialog.source-excluded-name": "--ink",
    "dialog.source-excluded-path": "--muted",
  });
  assertFormula("dark", {
    "home.excluded-name": "--ink",
    "home.excluded-path": "--ink",
    "dialog.source-excluded-name": "--ink",
    "dialog.source-excluded-path": "--muted",
  });
});

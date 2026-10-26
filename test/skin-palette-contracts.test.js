/**
 * M0.3 契约验收测试（node --test）。
 *
 * 覆盖总计划要求：多/少 token、alpha HEX、非法模式、未知皮肤、半套候选、
 * 选择缺一套、重复候选 ID、摘要错配、数组排序不被改变、对象键顺序不影响摘要、
 * 候选里的时间字段被拒绝。只验证 JSON 能 parse 不算完成——所有用例都打到
 * 具体校验器与其错误路径。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODES,
  SCHEMA_VERSION,
  SKIN_IDS,
  VARIANTS,
  assertRoleSelectorsByState,
  canonicalJson,
  collectSourceHashes,
  hashCandidate,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
  validateAssessment,
  validateCandidate,
  validateCandidateSet,
  validateFailureRecord,
  validatePolicy,
  validateProfiles,
  validateSelections,
  validateTokens,
} from "../scripts/skin-palette/contracts.mjs";
import { BASE_COLORS, ROLE_CATALOG, ROLES_VERSION, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";
import { evaluatePalette } from "../scripts/skin-palette/evaluate.mjs";

function makeTokens(overrides = {}, removals = []) {
  const tokens = {
    pageBackground: "#B9C9EE",
    panelBackground: "#DCE4F7",
    panelBorder: "#DCE4F7",
    panelHighlight: "#F3F6FC",
    panelShadow: "#71699F",
    textPrimary: "#52407D",
    textSecondary: "#807EB0",
    accent: "#3870FF",
    controlBackground: "#DCE4F7",
    controlBorder: "#DCE4F7",
    controlText: "#52407D",
    chartText: "#807EB0",
  };
  for (const key of removals) delete tokens[key];
  return { ...tokens, ...overrides };
}

const makeProfile = () => ({ surfaceHue: 220, accentHue: 223, key: "high", temperature: "cool" });

function makeCandidate({ skinId = "chatgpt", variant = "a", tokensLight, tokensDark, extra = {} } = {}) {
  const profileSnapshot = { ...makeProfile(), surfaceHue: 220 + SKIN_IDS.indexOf(skinId) };
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    id: "",
    skinId,
    variant,
    profileVersion: SCHEMA_VERSION,
    profileSnapshot,
    profileHash: sha256Canonical(profileSnapshot),
    policyHash: "a".repeat(64),
    derivationHash: "b".repeat(64),
    seed: "palette-redesign-v1",
    style: { title: "试点配方", rationale: "表面冷调、accent 锚定代表色", identitySource: "官方代表色 #3870ff" },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light: tokensLight ?? makeTokens(), dark: tokensDark ?? makeTokens() },
    ...extra,
  };
  candidate.candidateHash = hashCandidate(candidate);
  candidate.id = `${skinId}-${variant}-${candidate.candidateHash.slice(0, 12)}`;
  return candidate;
}

function makeSet({ skinIds = SKIN_IDS, extra = {} } = {}) {
  const candidates = [];
  for (const skinId of skinIds) {
    for (const variant of VARIANTS) {
      candidates.push(makeCandidate({ skinId, variant }));
    }
  }
  const set = {
    schemaVersion: SCHEMA_VERSION,
    inputHashes: {
      profiles: "c".repeat(64),
      policy: "d".repeat(64),
      roles: hashRoleInputs(),
      derivation: "e".repeat(64),
    },
    candidates,
    rejected: [],
    ...extra,
  };
  set.candidateSetHash = hashCandidateSet(set);
  return set;
}

function makeSelections({ dropSkin = null } = {}) {
  const set = makeSet();
  const choices = {};
  for (const skinId of SKIN_IDS) {
    if (skinId === dropSkin) continue;
    const candidate = set.candidates.find((item) => item.skinId === skinId && item.variant === "a");
    choices[skinId] = { candidateId: candidate.id, candidateHash: candidate.candidateHash };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    candidateSetHash: set.candidateSetHash,
    assessmentHash: "f".repeat(64),
    choices,
    decisionSource: "2026-10-03 用户消息「就用这批里的 A 版」",
    recordedAt: "2026-10-03T12:00:00.000Z",
  };
}

const makeMeasurement = (overrides = {}) => ({
  candidateId: "chatgpt-a-000000000000",
  mode: "light",
  roleId: "panel.metric-value",
  stateId: "dashboard-default",
  result: "pass",
  ratio: 7.4,
  threshold: 4.5,
  method: "fast-contrast",
  evidence: "scripts/skin-palette/roles.mjs#panel.metric-value",
  reason: "",
  ...overrides,
});

const makeAssessment = (overrides = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  candidateId: "chatgpt-a-000000000000",
  candidateHash: "a".repeat(64),
  fast: [makeMeasurement()],
  browser: [],
  visual: { reviewed: true, verdict: "pass", notes: "原尺寸截图已过目" },
  readiness: "ready",
  failures: [],
  unmeasured: [],
  diagnostics: {},
  ...overrides,
});

test("契约常量：十套 ID 排除 classic、模式与变体固定", () => {
  assert.equal(SKIN_IDS.length, 10);
  assert.ok(!SKIN_IDS.includes("classic"));
  assert.deepEqual(MODES, ["light", "dark"]);
  assert.deepEqual(VARIANTS, ["a", "b", "c"]);
  assert.equal(SCHEMA_VERSION, 1);
});

test("canonicalJson：对象键顺序不影响摘要，数组保持原序", () => {
  assert.equal(sha256Canonical({ a: 1, b: { x: 1, y: 2 } }), sha256Canonical({ b: { y: 2, x: 1 }, a: 1 }));
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.notEqual(sha256Canonical([1, 2, 3]), sha256Canonical([3, 2, 1]));
});

test("canonicalJson：拒绝 NaN/Infinity/undefined/循环/非 JSON 类型/稀疏数组", () => {
  assert.throws(() => canonicalJson({ v: Number.NaN }), /非 JSON 数值/);
  assert.throws(() => canonicalJson({ v: Number.POSITIVE_INFINITY }), /非 JSON 数值/);
  assert.throws(() => canonicalJson({ a: undefined }), /undefined/);
  assert.throws(() => canonicalJson({ v: () => 1 }), /不支持的类型/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => canonicalJson(circular), /循环引用/);
  assert.throws(() => canonicalJson({ v: new Date(0) }), /非 JSON 对象类型/);
  assert.throws(() => canonicalJson({ v: new Map() }), /非 JSON 对象类型/);
  const sparse = new Array(3);
  sparse[0] = 1;
  sparse[2] = 3;
  assert.throws(() => canonicalJson({ v: sparse }), /稀疏数组/);
});

test("validateTokens：多余 token、缺失 token、alpha HEX、小写 hex 全部拒绝", () => {
  const extra = validateTokens({ ...makeTokens(), chartSeries: "#123456" });
  assert.equal(extra.valid, false);
  assert.ok(extra.errors.some((e) => e.path === "chartSeries" && e.code === "extra"));

  const missing = validateTokens(makeTokens({}, ["accent"]));
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.path === "accent" && e.code === "format"));

  const alpha = validateTokens(makeTokens({ accent: "#3870FFAA" }));
  assert.equal(alpha.valid, false);
  assert.ok(alpha.errors.some((e) => e.path === "accent"));

  const lowercase = validateTokens(makeTokens({ accent: "#3870ff" }));
  assert.equal(lowercase.valid, false);

  assert.equal(validateTokens(makeTokens()).valid, true);
});

test("validateTokens：路径前缀透传（供候选校验定位 modes.light.*）", () => {
  const result = validateTokens(makeTokens({}, ["accent"]), "modes.light");
  assert.ok(result.errors.some((e) => e.path === "modes.light.accent"));
});

test("validateCandidate：合法候选通过，profileHash/candidateHash/id 三者自洽", () => {
  const candidate = makeCandidate();
  const result = validateCandidate(candidate);
  assert.deepEqual(result.errors, [], `意外错误：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  assert.equal(result.valid, true);
});

test("validateCandidate：未知皮肤、非法变体、非法模式被拒绝", () => {
  const unknownSkin = validateCandidate(makeCandidate({ skinId: "foo" }));
  assert.ok(unknownSkin.errors.some((e) => e.path === "skinId" && e.code === "unknown"));

  const badVariant = validateCandidate(makeCandidate({ variant: "d" }));
  assert.ok(badVariant.errors.some((e) => e.path === "variant" && e.code === "unknown"));

  const extraMode = validateCandidate(
    makeCandidate({ extra: { modes: { light: makeTokens(), dark: makeTokens(), noon: makeTokens() } } }),
  );
  assert.ok(extraMode.errors.some((e) => e.path === "modes.noon" && e.code === "unknown"));

  const halfModes = validateCandidate(makeCandidate({ extra: { modes: { light: makeTokens() } } }));
  assert.ok(halfModes.errors.some((e) => e.path === "modes.dark" && e.code === "missing"));
});

test("validateCandidate：候选里的时间字段被拒绝（顶层与嵌套）", () => {
  const top = validateCandidate(makeCandidate({ extra: { generatedAt: "2026-10-03T00:00:00Z" } }));
  assert.ok(top.errors.some((e) => e.path === "generatedAt" && e.code === "forbidden"));

  const nested = validateCandidate(
    makeCandidate({ extra: { parameters: { light: { fetchedAt: "2026-10-03" }, dark: {}, search: {} } } }),
  );
  assert.ok(nested.errors.some((e) => e.path === "parameters.light.fetchedAt" && e.code === "forbidden"));
});

test("validateCandidate：profileHash / candidateHash / id 摘要错配被拒绝", () => {
  const badProfileHash = validateCandidate(makeCandidate({ extra: { profileHash: "f".repeat(64) } }));
  assert.ok(badProfileHash.errors.some((e) => e.path === "profileHash" && e.code === "mismatch"));

  const candidate = makeCandidate();
  const badHash = validateCandidate({ ...candidate, candidateHash: "f".repeat(64) });
  assert.ok(badHash.errors.some((e) => e.path === "candidateHash" && e.code === "mismatch"));

  const badId = validateCandidate({ ...candidate, id: "chatgpt-a-000000000000" });
  assert.ok(badId.errors.some((e) => e.path === "id" && e.code === "mismatch"));

  const malformedId = validateCandidate({ ...candidate, id: "nope" });
  assert.ok(malformedId.errors.some((e) => e.path === "id" && e.code === "format"));
});

test("validateCandidateSet：完整十套 × a/b/c 通过", () => {
  const result = validateCandidateSet(makeSet());
  assert.deepEqual(result.errors, [], result.errors.map((e) => `${e.path} ${e.message}`).join("; "));
  assert.equal(result.valid, true);
});

test("validateCandidateSet：半套候选（缺一套皮肤）拒绝", () => {
  const skinIds = SKIN_IDS.filter((id) => id !== "deepseek");
  const result = validateCandidateSet(makeSet({ skinIds }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "missing" && e.message.includes("deepseek-a")));
});

test("validateCandidateSet：重复候选 ID 拒绝", () => {
  const set = makeSet();
  set.candidates = [...set.candidates, structuredClone(set.candidates[0])];
  const result = validateCandidateSet(set);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "duplicate"));
});

test("validateCandidateSet：数组顺序改变（非注册序）拒绝", () => {
  const set = makeSet();
  const swapped = [...set.candidates];
  const first = swapped[0];
  swapped[0] = swapped[1];
  swapped[1] = first;
  const result = validateCandidateSet({ ...set, candidates: swapped });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.code === "order"));
});

test("validateCandidateSet：inputHashes.roles 摘要错配拒绝（角色清单变更使旧评审失效）", () => {
  const set = makeSet();
  const result = validateCandidateSet({
    ...set,
    inputHashes: { ...set.inputHashes, roles: "e".repeat(64) },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "inputHashes.roles" && e.code === "mismatch"));
});

test("validateCandidateSet：candidateSetHash 摘要错配拒绝", () => {
  const set = makeSet();
  const result = validateCandidateSet({ ...set, candidateSetHash: "f".repeat(64) });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "candidateSetHash" && e.code === "mismatch"));
});

test("validateCandidateSet：rejected 记录形状生效，去重记录必须带 D_OK 距离", () => {
  const badSet = makeSet();
  badSet.rejected = [
    {
      code: "DUPLICATE_CANDIDATE",
      skinId: "chatgpt",
      pair: "light+dark",
      variant: "b",
      roleIds: [],
      attemptedRanges: [],
      worstRatio: null,
      threshold: null,
      message: "与另一候选过近",
    },
  ];
  const badResult = validateCandidateSet({ ...badSet });
  assert.equal(badResult.valid, false);
  assert.ok(
    badResult.errors.some((e) => e.path.startsWith("rejected[0]") && (e.code === "missing" || e.code === "format")),
  );

  const goodSet = makeSet();
  goodSet.rejected = [
    {
      code: "DUPLICATE_CANDIDATE",
      skinId: "chatgpt",
      pair: "light+dark",
      variant: "b",
      roleIds: [],
      attemptedRanges: [],
      worstRatio: null,
      threshold: null,
      message: "与 chatgpt-a 的 D_OK 距离过近，已并入同一配方",
      relatedCandidateId: "chatgpt-a-000000000000",
      distances: [0.41, 0.37],
    },
  ];
  goodSet.candidateSetHash = hashCandidateSet(goodSet);
  assert.equal(validateCandidateSet({ ...goodSet }).valid, true);
});

test("validateSelections：合法通过；缺一套、未知皮肤拒绝", () => {
  assert.equal(validateSelections(makeSelections()).valid, true);

  const missing = validateSelections(makeSelections({ dropSkin: "mimo" }));
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.path === "choices.mimo" && e.code === "missing"));

  const withUnknown = makeSelections();
  withUnknown.choices.foo = { candidateId: "chatgpt-a-000000000000", candidateHash: "a".repeat(64) };
  const unknown = validateSelections(withUnknown);
  assert.ok(unknown.errors.some((e) => e.path === "choices.foo" && e.code === "unknown"));
});

test("validateAssessment：ready 合法；出现失败必须 rejected；缺测必须 incomplete", () => {
  assert.equal(validateAssessment(makeAssessment()).valid, true);

  const failed = validateAssessment(
    makeAssessment({
      fast: [makeMeasurement({ result: "fail", ratio: 2.1, threshold: 4.5 })],
      failures: [makeMeasurement({ result: "fail", ratio: 2.1, threshold: 4.5 })],
      readiness: "rejected",
      visual: { reviewed: true, verdict: "pass", notes: "" },
    }),
  );
  assert.equal(failed.valid, true);

  const gap = validateAssessment(
    makeAssessment({
      fast: [makeMeasurement({ result: "unmeasured", ratio: null, reason: "环境不可用" })],
      unmeasured: [makeMeasurement({ result: "unmeasured", ratio: null, reason: "环境不可用" })],
      readiness: "incomplete",
      visual: { reviewed: true, verdict: "pass", notes: "" },
    }),
  );
  assert.equal(gap.valid, true);

  const wrongReadiness = validateAssessment(
    makeAssessment({
      fast: [makeMeasurement({ result: "fail", ratio: 2.1, threshold: 4.5 })],
      failures: [makeMeasurement({ result: "fail", ratio: 2.1, threshold: 4.5 })],
      readiness: "ready",
    }),
  );
  assert.equal(wrongReadiness.valid, false);
  assert.ok(wrongReadiness.errors.some((e) => e.path === "readiness" && e.code === "mismatch"));

  const staleReady = validateAssessment(
    makeAssessment({
      unmeasured: [makeMeasurement({ result: "unmeasured", ratio: null, reason: "浏览器环境不可用" })],
    }),
  );
  assert.equal(staleReady.valid, false);
  assert.ok(staleReady.errors.some((e) => e.path === "readiness" && e.code === "mismatch"));
});

test("validateAssessment：非法 mode、未知角色、unmeasured 带 ratio 拒绝", () => {
  const badMode = validateAssessment(makeAssessment({ fast: [makeMeasurement({ mode: "noon" })] }));
  assert.ok(badMode.errors.some((e) => e.path === "fast[0].mode" && e.code === "unknown"));

  const badRole = validateAssessment(makeAssessment({ fast: [makeMeasurement({ roleId: "made.up.role" })] }));
  assert.ok(badRole.errors.some((e) => e.path === "fast[0].roleId" && e.code === "unknown"));

  const badRatio = validateAssessment(
    makeAssessment({
      fast: [makeMeasurement({ result: "unmeasured", ratio: 3, reason: "缺测却给了比值" })],
      readiness: "incomplete",
    }),
  );
  assert.ok(badRatio.errors.some((e) => e.path === "fast[0].ratio" && e.code === "format"));

  const nanThreshold = validateAssessment(makeAssessment({ fast: [makeMeasurement({ threshold: Number.NaN })] }));
  assert.equal(nanThreshold.valid, false);
  assert.ok(nanThreshold.errors.some((e) => e.path === "fast[0].threshold" && e.code === "format"));
});

test("validateProfiles：信封校验——未知皮肤与缺失皮肤", () => {
  const profiles = {};
  for (const skinId of SKIN_IDS) profiles[skinId] = makeProfile();
  assert.equal(validateProfiles(profiles).valid, true);

  const unknown = validateProfiles({ ...profiles, foo: makeProfile() });
  assert.ok(unknown.errors.some((e) => e.path === "foo" && e.code === "unknown"));

  const { mimo: _mimo, ...rest } = profiles;
  const missing = validateProfiles(rest);
  assert.ok(missing.errors.some((e) => e.path === "mimo" && e.code === "missing"));
});

test("validatePolicy：仓库 policy.json 通过；篡改阈值拒绝", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(validatePolicy(policy).valid, true);

  const tampered = { ...policy, readability: { ...policy.readability, bodyTextMin: 4 } };
  assert.equal(validatePolicy(tampered).valid, false);
});

test("collectSourceHashes：结果稳定，缺失文件抛错", () => {
  const paths = [
    fileURLToPath(new URL("../public/skins.js", import.meta.url)),
    fileURLToPath(new URL("../scripts/skin-palette/roles.mjs", import.meta.url)),
  ];
  const first = collectSourceHashes(paths);
  const second = collectSourceHashes(paths);
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first).length, 2);
  for (const digest of Object.values(first)) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.throws(() => collectSourceHashes(["Z:/definitely/missing/file.js"]));
});

test("hashRoleInputs：清单未变时摘要稳定，与 candidateSet 的 inputHashes.roles 呼应", () => {
  assert.match(hashRoleInputs(), /^[0-9a-f]{64}$/);
  const set = makeSet();
  assert.equal(set.inputHashes.roles, hashRoleInputs());
});

test("validateCandidate：id 缺失被拒绝（复核漏洞——此前缺失时校验被整体跳过）", () => {
  const candidate = makeCandidate();
  delete candidate.id;
  const result = validateCandidate(candidate);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "id" && e.code === "missing"));
});

test("validateCandidateSet：candidateSetHash 缺失被拒绝（复核漏洞）", () => {
  const set = makeSet();
  delete set.candidateSetHash;
  const result = validateCandidateSet(set);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "candidateSetHash" && e.code === "format"));
});

test("validateFailureRecord：worstRatio/threshold 只接受有限数值或 null", () => {
  const base = {
    code: "UNSATISFIABLE",
    skinId: "chatgpt",
    mode: "light",
    variant: "a",
    roleIds: [],
    attemptedRanges: [],
    worstRatio: Number.NaN,
    threshold: 4.5,
    message: "无法满足阈值：固定色对凹槽背景不可达，交 M1.4 受限分支处理",
  };
  const worst = validateFailureRecord(base);
  assert.equal(worst.valid, false);
  assert.ok(worst.errors.some((e) => e.path === "worstRatio" && e.code === "format"));

  const threshold = validateFailureRecord({
    ...base,
    worstRatio: null,
    threshold: Number.NaN,
    message: "无法满足阈值：固定色对凹槽背景不可达，交 M1.4 受限分支处理",
  });
  assert.equal(threshold.valid, false);
  assert.ok(threshold.errors.some((e) => e.path === "threshold" && e.code === "format"));
});

test("BASE_COLORS 只登记被角色引用的固定色（v2 复核更正）", () => {
  const referenced = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.name === "string" && node.name.startsWith("--")) referenced.add(node.name);
    for (const child of Object.values(node)) walk(child);
  };
  for (const role of ROLE_CATALOG) walk(role);
  for (const branch of Object.keys(BASE_COLORS)) {
    for (const mode of Object.keys(BASE_COLORS[branch])) {
      for (const name of Object.keys(BASE_COLORS[branch][mode])) {
        assert.ok(referenced.has(name), `${branch}.${mode} 的 ${name} 未被任何角色引用`);
      }
      assert.ok(
        !("--toggle-selected" in BASE_COLORS[branch][mode]),
        `${branch}.${mode} 不应登记 --toggle-selected（styles.css 后半段覆盖为 var(--blue)，随强调色联动）`,
      );
      assert.ok(!("--gold" in BASE_COLORS[branch][mode]), `${branch}.${mode} 不应登记 --gold（零角色引用）`);
      assert.ok(
        !("--toggle-muted" in BASE_COLORS[branch][mode]),
        `${branch}.${mode} 不应登记 --toggle-muted（零角色引用）`,
      );
    }
  }
});

test("复核点名的双向引用闭合：role.states 与 state.expectedRoleIds 互为镜像且无空状态角色", () => {
  const roleIds = new Set(ROLE_CATALOG.map((role) => role.id));
  const stateIds = new Set(STATE_CATALOG.map((state) => state.id));
  for (const state of STATE_CATALOG) {
    for (const roleId of state.expectedRoleIds) {
      assert.ok(roleIds.has(roleId), `状态 ${state.id} 引用未知角色 ${roleId}`);
      const role = ROLE_CATALOG.find((item) => item.id === roleId);
      assert.ok(
        role.states.includes(state.id),
        `状态 ${state.id}.expectedRoleIds 含 ${roleId}，但该角色 states 未回指`,
      );
    }
  }
  for (const role of ROLE_CATALOG) {
    for (const stateId of role.states) {
      assert.ok(stateIds.has(stateId), `角色 ${role.id} 引用未知状态 ${stateId}`);
      const state = STATE_CATALOG.find((item) => item.id === stateId);
      assert.ok(
        state.expectedRoleIds.includes(role.id),
        `角色 ${role.id}.states 含 ${stateId}，但该状态 expectedRoleIds 未回指`,
      );
    }
    assert.ok(role.states.length > 0, `角色 ${role.id} 的 states 为空——每个角色必须有至少一个可测状态或明确的覆盖状态`);
  }
});

test("复核点名的新状态入目录，且关键状态落实非零就绪与固定日期", () => {
  const stateIds = STATE_CATALOG.map((state) => state.id);
  for (const id of [
    "input-focus",
    "empty-range",
    "autorefresh-error",
    "skin-previews-visual",
    "bar-fill-visual",
    "timeline-range-warning",
    "home-source-excluded",
  ]) {
    assert.ok(stateIds.includes(id), `缺少复核要求的状态 ${id}`);
  }
  const dashboard = STATE_CATALOG.find((state) => state.id === "dashboard-default");
  assert.equal(dashboard.ready.kind, "nonZeroText", "仅数 .metric strong 元素不能证明非零，就绪条件须解析文本数值");
  const calendar = STATE_CATALOG.find((state) => state.id === "calendar-range");
  assert.match(JSON.stringify(calendar.steps), /2026-09-26/);
  assert.match(JSON.stringify(calendar.steps), /2026-09-28/);
  assert.match(calendar.ready.selector, /range-end/, "终点日带 range-end 才算就绪");
});

test("D5：自动刷新开启态独立于看板基线，并同步角色身份版本", () => {
  const role = ROLE_CATALOG.find((item) => item.id === "toggle.autorefresh-on");
  const dashboard = STATE_CATALOG.find((item) => item.id === "dashboard-default");
  const on = STATE_CATALOG.find((item) => item.id === "autorefresh-on");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const selector = '#autoRefreshToggle[aria-pressed="true"]';

  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(role.selector, selector);
  assert.deepEqual(role.states, ["autorefresh-on"]);
  assert.equal(role.required, true);
  assert.equal(role.threshold, 4.5);
  assert.ok(!dashboard.expectedRoleIds.includes(role.id));
  assert.deepEqual(on.expectedRoleIds, [role.id]);
  assert.deepEqual(on.steps, [
    { action: "click", selector: '#presetButtons button[data-preset="all"]' },
    { action: "ensureClick", selector: "#autoRefreshToggle", until: selector },
  ]);
  assert.deepEqual(on.ready, {
    kind: "matches",
    selector,
    description: "自动刷新开关 aria-pressed=true",
  });
  assert.deepEqual(on.restore, []);
  assert.equal(hashRoleInputs().length, 64);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);

  const stalePolicy = { ...policy, versions: { ...policy.versions, roles: 12 } };
  const staleResult = validatePolicy(stalePolicy);
  assert.equal(staleResult.valid, false);
  assert.ok(staleResult.errors.some((item) => item.path === "versions.roles" && item.code === "mismatch"));
});

test("D12-A1：来源排除角色注册与 ceramic well 表面一致，测量状态留给 A2 接线", () => {
  const excluded = ROLE_CATALOG.find((role) => role.id === "status.home-excluded");
  const excludedName = ROLE_CATALOG.find((role) => role.id === "dialog.source-excluded-name");
  const excludedPath = ROLE_CATALOG.find((role) => role.id === "dialog.source-excluded-path");
  const reason = ROLE_CATALOG.find((role) => role.id === "status.home-reason");
  const importOpen = STATE_CATALOG.find((state) => state.id === "dialog-import-open");
  const excludedState = STATE_CATALOG.find((state) => state.id === "dialog-import-source-excluded");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(excluded.selector, "#sourcePicker .home-excluded");
  assert.deepEqual(excluded.states, ["dialog-import-source-excluded"]);
  assert.deepEqual(excluded.foreground, { kind: "var", name: "--red" });
  assert.deepEqual(excluded.background, { kind: "solid", color: { kind: "var", name: "--ceramic-well" } });
  assert.equal(excluded.threshold, 4.5);
  assert.equal(excluded.required, true);
  assert.match(excluded.applicability, /#sourcePicker.*全强度.*--ceramic-well.*内阴影/);
  assert.ok(excludedName);
  assert.ok(excludedPath);
  assert.deepEqual(excludedName.states, ["dialog-import-source-excluded"]);
  assert.deepEqual(excludedPath.states, ["dialog-import-source-excluded"]);
  assert.deepEqual(excluded.sourceRefs, [
    { file: "public/styles.css", symbol: ".home-excluded", line: 2033 },
    { file: "public/styles.css", symbol: ".source-picker", line: 3115 },
  ]);
  assert.deepEqual(importOpen.expectedRoleIds, [
    "dialog.copy",
    "input.value",
    "button.primary",
    "button.secondary",
    "dialog.source-option-text",
    "dialog.source-option-muted",
  ]);
  assert.equal(STATE_CATALOG[STATE_CATALOG.indexOf(importOpen) + 1], excludedState);
  assert.deepEqual(excludedState, {
    id: "dialog-import-source-excluded",
    label: "导入弹窗来源排除标记",
    steps: [{ action: "click", selector: "#addImportButton" }],
    ready: {
      kind: "visible",
      selector: "#sourcePicker .home-excluded",
      description: "来源筛选排除标记可见",
    },
    restore: [{ action: "click", selector: "#cancelImportButton" }],
    expectedRoleIds: ["status.home-excluded", "dialog.source-excluded-name", "dialog.source-excluded-path"],
    note: "S3 专用生命周期在来源排除期间取证和测量，再恢复来源及关闭弹窗；本卡仅离线验证时序，实际捕获与测量仍待后续验收。",
  });
  assert.equal(reason.selector, "#homeList .home-reason");
  assert.deepEqual(reason.states, ["home-list-reason"]);
  assert.equal(sha256Canonical(reason), "f4302f24064a4424953aa2e6b6a6f56f49cae137b9f9a513a2490d1b02429d87");
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);

  const staleRoles15 = { ...policy, versions: { ...policy.versions, roles: 15 } };
  const staleResult = validatePolicy(staleRoles15);
  assert.equal(staleResult.valid, false);
  assert.ok(staleResult.errors.some((item) => item.path === "versions.roles" && item.code === "mismatch"));
});

test("D14：已保存不可用来源原因在主页面关闭弹窗状态单独测量", () => {
  const reason = ROLE_CATALOG.find((role) => role.id === "status.home-reason");
  const remove = ROLE_CATALOG.find((role) => role.id === "home.remove");
  const state = STATE_CATALOG.find((item) => item.id === "home-list-reason");
  const importOpen = STATE_CATALOG.find((item) => item.id === "dialog-import-open");
  const importError = STATE_CATALOG.find((item) => item.id === "dialog-import-error");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const allPreset = '#presetButtons button[data-preset="all"]';

  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(reason.selector, "#homeList .home-reason");
  assert.deepEqual(reason.states, ["home-list-reason"]);
  assert.deepEqual(reason.foreground, { kind: "var", name: "--red" });
  assert.deepEqual(reason.background, { kind: "solid", color: { kind: "var", name: "--ceramic-well" } });
  assert.equal(reason.required, true);
  assert.equal(reason.threshold, 4.5);
  assert.deepEqual(reason.sourceRefs, [
    { file: "public/app.js", symbol: "renderHomesHtml", line: 2878 },
    { file: "public/styles.css", symbol: ".home-reason", line: 1855 },
    { file: "public/styles.css", symbol: ".home-list", line: 3108 },
  ]);
  assert.deepEqual(importOpen.expectedRoleIds, [
    "dialog.copy",
    "input.value",
    "button.primary",
    "button.secondary",
    "dialog.source-option-text",
    "dialog.source-option-muted",
  ]);
  assert.equal(STATE_CATALOG.indexOf(state), STATE_CATALOG.indexOf(importError) + 1);
  assert.deepEqual(state.steps, [{ action: "click", selector: allPreset }]);
  assert.deepEqual(state.ready, {
    kind: "visible",
    selector: "body:not(:has(#importDialog:not([hidden]))) #homeList .home-reason",
    description: "主页面来源原因可见且导入弹窗关闭",
  });
  assert.deepEqual(state.restore, [{ action: "click", selector: allPreset }]);
  assert.deepEqual(state.expectedRoleIds, [reason.id, remove.id]);
  assert.deepEqual(reason.states, [state.id]);
  assert.deepEqual(remove.states, [state.id]);
  assert.match(reason.applicability, /已保存导入.*不可用原因.*来源列表.*导入弹窗关闭/);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);

  const oldPolicy = { ...policy, versions: { ...policy.versions, roles: 16 } };
  const oldResult = validatePolicy(oldPolicy);
  assert.equal(oldResult.valid, false);
  assert.ok(oldResult.errors.some((item) => item.path === "versions.roles" && item.code === "mismatch"));
});

test("D8s5-warning：超长时间线告警独立于看板基线，角色镜像与身份版本同步", () => {
  const role = ROLE_CATALOG.find((item) => item.id === "warning.timeline-range");
  const dashboard = STATE_CATALOG.find((item) => item.id === "dashboard-default");
  const warning = STATE_CATALOG.find((item) => item.id === "timeline-range-warning");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

  assert.equal(role.kind, "text");
  assert.equal(role.selector, ".timeline-range-warning");
  assert.equal(role.threshold, 4.5);
  assert.equal(role.required, true);
  assert.deepEqual(role.states, ["timeline-range-warning"]);
  assert.ok(!dashboard.expectedRoleIds.includes(role.id));
  assert.deepEqual(warning.expectedRoleIds, [role.id]);
  assert.deepEqual(warning.steps, [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }]);
  assert.deepEqual(warning.ready, {
    kind: "matches",
    selector: "#timelineRangeWarning:not([hidden])",
    description: "超过 2000 个时间线槽位的提示可见；数据未被截断",
  });
  assert.deepEqual(warning.restore, [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }]);
  assert.match(role.applicability, /2000.*不截断/);
  assert.equal(policy.versions.roles, ROLES_VERSION);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("B20：公开 evaluatePalette 将来源链接文字保留为浏览器必测且不产生 PASS", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const linkRole = ROLE_CATALOG.find((role) => role.id === "cost.note-link");
  assert.ok(linkRole);

  const result = evaluatePalette({
    skinId: "chatgpt",
    mode: "light",
    tokens: makeTokens(),
    roleCatalog: [linkRole],
    policy,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].roleId, "cost.note-link");
  assert.equal(result.entries[0].status, "browser-required");
  assert.equal(result.entries[0].ratio, null);
  assert.notEqual(result.entries[0].status, "pass");
  assert.deepEqual(result.summary.counts, { pass: 0, fail: 0, unmeasured: 0, browserRequired: 1 });
});

test("D7d：日历选区与闭层上行摘要分离，其余两个日期角色保持固定状态", () => {
  const role = (id) => ROLE_CATALOG.find((item) => item.id === id);
  const state = (id) => STATE_CATALOG.find((item) => item.id === id);
  const dashboard = state("dashboard-default");
  const calendar = state("calendar-range");
  const trendUp = state("comparison-trend-up");
  const trendDown = state("comparison-trend-down");
  const sameDay = state("calendar-same-day");

  assert.deepEqual(role("summary.trend-up").states, ["comparison-trend-up"]);
  assert.deepEqual(role("summary.trend-down").states, ["comparison-trend-down"]);
  assert.deepEqual(role("calendar.day-range-both").states, ["calendar-same-day"]);
  assert.ok(!dashboard.expectedRoleIds.includes("summary.trend-up"));
  assert.ok(!dashboard.expectedRoleIds.includes("summary.trend-down"));
  assert.ok(!calendar.expectedRoleIds.includes("summary.trend-up"));
  assert.ok(!calendar.expectedRoleIds.includes("calendar.day-range-both"));
  assert.match(calendar.ready.selector, /2026-09-28.*range-end/);
  assert.doesNotMatch(calendar.ready.selector, /comparison-item\.up/);
  assert.deepEqual(
    trendUp.steps.filter((step) => step.selector?.startsWith(".date-picker-day")).map((step) => step.selector),
    ['.date-picker-day[data-date="2026-09-26"]', '.date-picker-day[data-date="2026-09-28"]'],
  );
  assert.equal(
    trendUp.ready.selector,
    'body:has(#dateRangeButton[aria-expanded="false"]):has(#comparisonSummary .comparison-item.up strong)',
  );
  assert.equal(trendUp.expectedRoleIds.includes("summary.trend-up"), true);
  assert.deepEqual(trendUp.restore, [
    { action: "click", selector: "[data-date-picker-clear]" },
    { action: "click", selector: "#dateRangeButton" },
  ]);
  assert.match(trendDown.ready.selector, /^#comparisonSummary \.comparison-item\.down strong$/);
  assert.equal(trendDown.expectedRoleIds.includes("summary.trend-down"), true);
  assert.match(sameDay.ready.selector, /2026-09-28.*range-start\.range-end/);
  assert.equal(sameDay.expectedRoleIds.includes("calendar.day-range-both"), true);

  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(policy.versions.roles, ROLES_VERSION);
});

test("D8b-sort：排序角色只在 comparison-sort-active 状态测量", () => {
  const role = ROLE_CATALOG.find((item) => item.id === "indicator.sort");
  const dashboard = STATE_CATALOG.find((state) => state.id === "dashboard-default");
  const active = STATE_CATALOG.find((state) => state.id === "comparison-sort-active");
  const presetSelector = '#presetButtons button[data-preset="all"]';
  const sortSelector = '#modelComparisonTable [data-comparison-sort][data-period="today"]';

  assert.equal(role.kind, "text");
  assert.equal(role.selector, ".comparison-sort-indicator");
  assert.equal(role.threshold, 4.5);
  assert.equal(role.required, true);
  assert.deepEqual(role.states, ["comparison-sort-active"]);
  assert.ok(!dashboard.expectedRoleIds.includes("indicator.sort"));
  assert.deepEqual(active.expectedRoleIds, ["indicator.sort"]);
  assert.deepEqual(active.steps, [
    { action: "click", selector: presetSelector },
    { action: "click", selector: sortSelector },
  ]);
  assert.deepEqual(active.ready, {
    kind: "matches",
    selector: "#modelComparisonTable .comparison-sort-indicator:not([hidden])",
    description: "模型表格今日列排序箭头可见",
  });
  assert.deepEqual(active.restore, [
    { action: "click", selector: sortSelector },
    { action: "click", selector: sortSelector },
  ]);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(policy.versions.roles, ROLES_VERSION);
});

test("D8e-badge：记录徽标按必要图形分类并固定测量状态", () => {
  const role = ROLE_CATALOG.find((item) => item.id === "badge.record");
  const dashboard = STATE_CATALOG.find((item) => item.id === "dashboard-default");
  const visible = STATE_CATALOG.find((item) => item.id === "metric-record-visible");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(policy.readability.necessaryGraphicMin, 3);
  assert.equal(role.kind, "graphic");
  assert.equal(role.selector, ".metric-new");
  assert.equal(role.threshold, 3);
  assert.equal(role.required, true);
  assert.equal(role.foreground, null);
  assert.deepEqual(role.background, ROLE_CATALOG.find((item) => item.id === "panel.metric-label").background);
  assert.deepEqual(role.states, ["metric-record-visible"]);
  assert.ok(!dashboard.expectedRoleIds.includes(role.id));
  assert.match(role.applicability, /清空文字.*role=img.*7×7px.*computed background-color.*光晕不计入/);
  assert.deepEqual(
    role.sourceRefs.map(({ file }) => file),
    ["public/app.js", "public/styles.css"],
  );

  assert.deepEqual(visible.expectedRoleIds, ["badge.record"]);
  assert.deepEqual(
    visible.steps.filter((step) => step.selector?.startsWith(".date-picker-day")).map((step) => step.selector),
    ['.date-picker-day[data-date="2026-09-28"]', '.date-picker-day[data-date="2026-10-04"]'],
  );
  assert.equal(visible.ready.kind, "matches");
  assert.equal(
    visible.ready.selector,
    'body:has(#dateRangeButton[aria-expanded="false"]) .metric:has(#totalTokens) .metric-new:not([hidden])',
  );
  assert.deepEqual(visible.restore, [
    { action: "click", selector: "[data-date-picker-clear]" },
    { action: "click", selector: "#dateRangeButton" },
    { action: "click", selector: '#presetButtons button[data-preset="all"]' },
  ]);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});
test("E1a：输入角色按状态精确选目标，状态镜像和版本摘要同步", () => {
  const inputValue = ROLE_CATALOG.find((role) => role.id === "input.value");
  const placeholder = ROLE_CATALOG.find((role) => role.id === "input.placeholder");
  assert.deepEqual(inputValue.states, ["pricing-input-filled", "dialog-import-open"]);
  assert.deepEqual(inputValue.selectorsByState, {
    "dialog-import-open": "#importPath",
    "pricing-input-filled": "#pricingSearch, #usdToCnyRate",
  });
  assert.equal(inputValue.selector, "#importPath, #pricingSearch, #usdToCnyRate");
  assert.doesNotMatch(inputValue.selector, /checkbox|select/);

  assert.deepEqual(placeholder.states, ["dashboard-default", "dialog-pricing-open", "input-focus"]);
  assert.deepEqual(placeholder.selectorsByState, {
    "dashboard-default": ":is(#modelComparisonSearch, #repositoryComparisonSearch)::placeholder",
    "dialog-pricing-open": "#pricingSearch::placeholder",
    "input-focus": "#pricingSearch::placeholder",
  });
  assert.equal(
    placeholder.selector,
    ":is(#modelComparisonSearch, #repositoryComparisonSearch, #pricingSearch)::placeholder",
  );
  assert.equal(
    STATE_CATALOG.find((state) => state.id === "dashboard-default").expectedRoleIds.includes(placeholder.id),
    true,
  );
  assert.equal(
    STATE_CATALOG.find((state) => state.id === "dialog-import-open").expectedRoleIds.includes(placeholder.id),
    false,
  );
  assert.doesNotThrow(() => assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG));
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(policy.versions.roles, ROLES_VERSION);
});

test("D6b3：chart.axis-line 是必要 graphic 角色，两个状态镜像且 policy 版本同步", () => {
  const axisLine = ROLE_CATALOG.find((role) => role.id === "chart.axis-line");
  assert.equal(axisLine.kind, "graphic");
  assert.equal(axisLine.selector, null);
  assert.match(axisLine.canvasOp, /ctx\.strokeStyle = chartLine/);
  assert.match(axisLine.canvasOp, /axisPath 三点/);
  assert.deepEqual(axisLine.states, ["dashboard-default", "dense-data"]);
  assert.deepEqual(axisLine.foreground, { kind: "var", name: "--chart-line" });
  assert.equal(axisLine.background.kind, "canvas");
  assert.equal(axisLine.background.canvasSelector, "#timelineChart");
  assert.match(axisLine.background.description, /--ceramic-well/);
  assert.doesNotMatch(axisLine.background.description, /--neo-surface/);
  assert.equal(axisLine.threshold, 3);
  assert.equal(axisLine.required, true);
  for (const stateId of axisLine.states) {
    assert.ok(STATE_CATALOG.find((state) => state.id === stateId).expectedRoleIds.includes(axisLine.id));
  }
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(policy.versions.roles, ROLES_VERSION);
});

test("D7：次按钮与日历清除只登记当前可操作范围", () => {
  const role = (id) => ROLE_CATALOG.find((item) => item.id === id);
  const state = (id) => STATE_CATALOG.find((item) => item.id === id);
  const secondary = role("button.secondary");
  const clear = role("button.calendar-clear");
  const outsideMonth = role("calendar.day-outside");
  const primary = role("button.primary");
  const expectedSecondarySelectors = {
    "dashboard-default": ".panel-action:enabled, .segmented > button:enabled",
    "button-hover": "#addImportButton:hover",
    "menu-recent-open": "#recentRangeMenu:not([hidden]) button:enabled",
    "dialog-import-open":
      "#importDialog:not([hidden]) #cancelImportButton:enabled, #importDialog:not([hidden]) #pickImportDirectoryButton:enabled",
    "dialog-pricing-open":
      "#pricingDialog:not([hidden]) #cancelPricingButton:enabled, #pricingDialog:not([hidden]) .panel-action:enabled, #pricingDialog:not([hidden]) .segmented > button:enabled",
  };
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(
    secondary.selector,
    ".dialog-actions button:not([type=submit]):enabled, .path-picker button:enabled, .panel-action:enabled, .segmented > button:enabled, .recent-range-menu button:enabled",
  );
  assert.deepEqual(secondary.states, [
    "dashboard-default",
    "button-hover",
    "dialog-import-open",
    "dialog-pricing-open",
    "menu-recent-open",
  ]);
  assert.deepEqual(secondary.selectorsByState, expectedSecondarySelectors);
  assert.equal(secondary.threshold, 4.5);
  assert.equal(secondary.required, true);
  assert.deepEqual(state("button-hover").expectedRoleIds, ["button.secondary", "button.hover-border"]);
  assert.equal(role("button.hover-border").threshold, null);
  assert.equal(role("button.hover-border").required, false);
  // C6-B接受的v19输入必须失效，不能把旧评审重写成v20。
  const staleHoverSet = makeSet();
  staleHoverSet.inputHashes.roles = "6c4025d93ebf558c76be00ea6adc3d4c3266219203ac8107dc139ba5f28fb598";
  staleHoverSet.candidateSetHash = hashCandidateSet(staleHoverSet);
  const staleHoverValidation = validateCandidateSet(staleHoverSet);
  assert.equal(staleHoverValidation.valid, false);
  assert.ok(staleHoverValidation.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
  assert.deepEqual(
    STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(secondary.id))
      .map((item) => item.id)
      .sort(),
    [...secondary.states].sort(),
  );
  assert.equal(primary.selector, "#submitImportButton, #savePricingButton");
  assert.deepEqual(primary.states, ["dialog-import-open", "dialog-pricing-open"]);

  assert.equal(clear.selector, ".date-picker-clear:enabled");
  assert.deepEqual(clear.states, ["calendar-range"]);
  assert.equal(clear.required, true);
  assert.equal(clear.threshold, 4.5);
  assert.equal(state("calendar-open").expectedRoleIds.includes(clear.id), false);
  assert.equal(state("calendar-range").expectedRoleIds.includes(clear.id), true);
  assert.deepEqual(
    STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(clear.id)).map((item) => item.id),
    clear.states,
  );

  assert.equal(outsideMonth.selector, ".date-picker-day.outside-month");
  assert.deepEqual(outsideMonth.states, ["calendar-open"]);
  assert.deepEqual(outsideMonth.foreground, { kind: "var", name: "--muted" });
  assert.equal(outsideMonth.required, true);
  assert.equal(outsideMonth.threshold, 4.5);
  assert.equal(
    outsideMonth.applicability,
    "相邻月仍可点击，信息必要；直接使用 --muted 前景，不使用整按钮透明度，仍按 4.5 实测",
  );

  const stalePolicy = { ...policy, versions: { ...policy.versions, roles: 14 } };
  const staleResult = validatePolicy(stalePolicy);
  assert.equal(staleResult.valid, false);
  assert.ok(staleResult.errors.some((item) => item.path === "versions.roles" && item.code === "mismatch"));
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("D17：主页面来源行文字分为 ink 与 muted 两个同表面角色", () => {
  const role = (id) => ROLE_CATALOG.find((item) => item.id === id);
  const ink = role("page.body-text");
  const muted = role("page.body-muted");
  const dashboard = STATE_CATALOG.find((state) => state.id === "dashboard-default");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const expectedInkSelector =
    "#homeList .home-row:not(.excluded) > .home-label > strong, #homeList .home-row:not(.excluded) > .home-path";
  const expectedMutedSelector = "#homeList .home-row:not(.excluded) > .home-label > .home-kind";

  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(ink.selector, expectedInkSelector);
  assert.equal(muted.selector, expectedMutedSelector);
  assert.deepEqual(ink.foreground, { kind: "var", name: "--ink" });
  assert.deepEqual(muted.foreground, { kind: "var", name: "--muted" });
  assert.deepEqual(ink.background, { kind: "solid", color: { kind: "var", name: "--ceramic-well" } });
  assert.deepEqual(muted.background, ink.background);

  for (const textRole of [ink, muted]) {
    assert.deepEqual(textRole.states, ["dashboard-default"]);
    assert.equal(textRole.required, true);
    assert.equal(textRole.threshold, 4.5);
    assert.ok(dashboard.expectedRoleIds.includes(textRole.id));
    assert.ok(textRole.sourceRefs.some((ref) => ref.file === "public/app.js" && ref.symbol === "renderHomesHtml"));
    assert.ok(
      textRole.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("--ceramic-well")),
    );
    assert.deepEqual(
      STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(textRole.id)).map((state) => state.id),
      textRole.states,
    );
  }
  assert.equal(ink.applicability, "仅主页面非排除来源行的 --ink 普通文字；不作为全站兜底");
  assert.equal(muted.applicability, "仅主页面非排除来源行的 --muted 类型文字；不包括排除标记");
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("E1a：角色目录校验拒绝缺映射、额外/未知状态、空 selector 和不对称引用", () => {
  const cloneDirectory = () => ({
    roles: ROLE_CATALOG.map((role) => ({
      ...role,
      states: [...role.states],
      ...(role.selectorsByState ? { selectorsByState: { ...role.selectorsByState } } : {}),
    })),
    states: STATE_CATALOG.map((state) => ({ ...state, expectedRoleIds: [...state.expectedRoleIds] })),
  });

  const missingMap = cloneDirectory();
  delete missingMap.roles.find((role) => role.id === "input.placeholder").selectorsByState;
  assert.throws(() => assertRoleSelectorsByState(missingMap.roles, missingMap.states), TypeError);

  const arrayMap = cloneDirectory();
  arrayMap.roles.find((role) => role.id === "input.placeholder").selectorsByState = ["#search::placeholder"];
  assert.throws(() => assertRoleSelectorsByState(arrayMap.roles, arrayMap.states), /必须是普通对象/);

  const extraState = cloneDirectory();
  extraState.roles.find((role) => role.id === "input.placeholder").selectorsByState["dense-data"] =
    "#search::placeholder";
  assert.throws(
    () => assertRoleSelectorsByState(extraState.roles, extraState.states),
    /状态键必须与 role\.states 完全一致/,
  );

  const unknownState = cloneDirectory();
  const unknownRole = unknownState.roles.find((role) => role.id === "input.placeholder");
  unknownRole.states.push("not-in-catalog");
  unknownRole.selectorsByState["not-in-catalog"] = "#search::placeholder";
  assert.throws(() => assertRoleSelectorsByState(unknownState.roles, unknownState.states), /未知状态/);

  const blankSelector = cloneDirectory();
  blankSelector.roles.find((role) => role.id === "input.placeholder").selectorsByState["dashboard-default"] = "  ";
  assert.throws(() => assertRoleSelectorsByState(blankSelector.roles, blankSelector.states), /非空 selector/);

  const missingMirror = cloneDirectory();
  missingMirror.states.find((state) => state.id === "dashboard-default").expectedRoleIds = missingMirror.states
    .find((state) => state.id === "dashboard-default")
    .expectedRoleIds.filter((roleId) => roleId !== "input.placeholder");
  assert.throws(() => assertRoleSelectorsByState(missingMirror.roles, missingMirror.states), /expectedRoleIds 缺少/);

  const extraReverse = cloneDirectory();
  extraReverse.states.find((state) => state.id === "dialog-import-open").expectedRoleIds.push("input.placeholder");
  assert.throws(() => assertRoleSelectorsByState(extraReverse.roles, extraReverse.states), /不互为镜像/);
});

test("E1a：roles v2 摘要的候选集被当前 v10 输入摘要拒绝", () => {
  const candidateSet = makeSet();
  candidateSet.inputHashes.roles = "c94fa9385b6d12d62bf139483d5ba368b7c7791fd5aa817ae63bcbf7c6697c72";
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const result = validateCandidateSet(candidateSet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
});

test("D6b3：旧 T4 roles v3 摘要的候选集被当前 v10 输入摘要拒绝", () => {
  const candidateSet = makeSet();
  candidateSet.inputHashes.roles = "7da23eb221d4306712e56eb6a427a094543ac37e567b1c306f79ae0f3aa8728d";
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const result = validateCandidateSet(candidateSet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
});

test("D7b：旧 roles v4 摘要的候选集被当前 v10 输入摘要拒绝", () => {
  const candidateSet = makeSet();
  candidateSet.inputHashes.roles = "d7895a5e8d93a09bd1bea4f6ff2e15ea7e02a4fafb1f8a5bdb1354a31fc0d446";
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const result = validateCandidateSet(candidateSet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
});

test("D7d：旧 roles v5 摘要的候选集被当前 v10 输入摘要拒绝", () => {
  const candidateSet = makeSet();
  candidateSet.inputHashes.roles = "33bbde3af6b448bbdedb421e4ec1ea7ba9929b58fe0ac13ce8ed08f7190b97c5";
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const result = validateCandidateSet(candidateSet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
});

test("D8b-sort：旧 roles v6 摘要的候选集被当前 v10 输入摘要拒绝", () => {
  const candidateSet = makeSet();
  candidateSet.inputHashes.roles = "98e25129ec27059e610794b9bf434cbf9ab8688f63df88986e1a9c3790ee23ca";
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const result = validateCandidateSet(candidateSet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
});

test("D8e-badge：旧 roles v7 摘要候选集被当前 v10 输入摘要拒绝", () => {
  const candidateSet = makeSet();
  candidateSet.inputHashes.roles = "ed29554eedc9a8b87d390b787174c306513980f3cde00836759a19d9e5dfb55f";
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const result = validateCandidateSet(candidateSet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
});

test("D8h-ready-fix：旧 roles v8 摘要候选集被当前 v10 输入摘要拒绝", () => {
  const candidateSet = makeSet();
  candidateSet.inputHashes.roles = "bc50e942c869632072fac3dc3db386830540bfdc882596f7feaf50447b1cdac4";
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const result = validateCandidateSet(candidateSet);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((item) => item.path === "inputHashes.roles" && item.code === "mismatch"));
});

test("hashRoleInputs 覆盖 BASE_COLORS：固定色变更同样使旧评审失效", () => {
  assert.notEqual(
    hashRoleInputs(),
    sha256Canonical({ version: ROLES_VERSION, roles: ROLE_CATALOG, states: STATE_CATALOG }),
  );
});

test("validateCandidate：绝对路径（UNC 与 POSIX）在字符串字段被拒绝", () => {
  const unc = makeCandidate();
  unc.style.identitySource = "\\\\server\\share\\palette.json";
  const uncResult = validateCandidate(unc);
  assert.ok(uncResult.errors.some((e) => e.path === "style.identitySource" && e.code === "forbidden"));

  const posix = makeCandidate();
  posix.style.identitySource = "/var/lib/palette.json";
  const posixResult = validateCandidate(posix);
  assert.ok(posixResult.errors.some((e) => e.path === "style.identitySource" && e.code === "forbidden"));
});

test("validateFailureRecord：skinId/variant 字段必须存在（成对失败可为 null）", () => {
  const base = {
    code: "UNSATISFIABLE",
    mode: "light",
    roleIds: [],
    attemptedRanges: [],
    worstRatio: null,
    threshold: null,
    message: "无法满足阈值：固定色对凹槽背景不可达，交 M1.4 受限分支处理",
  };
  const noSkin = validateFailureRecord(base);
  assert.equal(noSkin.valid, false);
  assert.ok(noSkin.errors.some((e) => e.path === "skinId" && e.code === "missing"));

  const noVariant = validateFailureRecord({ ...base, skinId: "chatgpt" });
  assert.ok(noVariant.errors.some((e) => e.path === "variant" && e.code === "missing"));

  const nullPair = validateFailureRecord({ ...base, skinId: null, variant: null });
  assert.ok(!nullPair.errors.some((e) => e.path === "skinId" && e.code === "missing"));
  assert.ok(!nullPair.errors.some((e) => e.path === "variant" && e.code === "missing"));
});

test("validateProfiles：空对象 profile 拒绝（复核漏洞——此前 {} 被当作合法 profile）", () => {
  const profiles = {};
  for (const skinId of SKIN_IDS) profiles[skinId] = {};
  const result = validateProfiles(profiles);
  assert.equal(result.valid, false);
  for (const skinId of SKIN_IDS) {
    assert.ok(result.errors.some((e) => e.path === skinId && e.code === "empty"));
  }
});

test("validatePolicy：versions.roles 与 ROLES_VERSION 脱钩拒绝（清单一致性）", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(policy.versions.roles, ROLES_VERSION);
  const stale = { ...policy, versions: { ...policy.versions, roles: ROLES_VERSION - 1 } };
  const result = validatePolicy(stale);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path === "versions.roles" && e.code === "mismatch"));
});

test("D21-C2：焦点角色绑定真实两目标与自然 Tab 就绪契约，不改变 required/3 口径", () => {
  const focus = ROLE_CATALOG.find((role) => role.id === "focus.outline");
  const keyboard = STATE_CATALOG.find((state) => state.id === "keyboard-focus");
  const input = STATE_CATALOG.find((state) => state.id === "input-focus");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(policy.versions.fixture, 3);
  assert.equal(validatePolicy(policy).valid, true);
  assert.equal(focus.kind, "graphic");
  assert.equal(focus.selector, "#addImportButton, #pricingSearch");
  assert.deepEqual(focus.states, ["keyboard-focus", "input-focus"]);
  assert.deepEqual(focus.selectorsByState, { "keyboard-focus": "#addImportButton", "input-focus": "#pricingSearch" });
  assert.equal(focus.required, true);
  assert.equal(focus.threshold, 3);
  assert.deepEqual(focus.foreground, { kind: "var", name: "--blue" });
  assert.deepEqual(focus.background, {
    kind: "linear-gradient",
    angle: 135,
    stops: [
      { offset: 0, color: { kind: "var", name: "--ceramic-top" } },
      { offset: 0.55, color: { kind: "var", name: "--neo-surface" } },
      { offset: 1, color: { kind: "var", name: "--ceramic-bottom" } },
    ],
  });
  assert.deepEqual(
    STATE_CATALOG.filter((state) => state.expectedRoleIds.includes(focus.id)).map((state) => state.id),
    focus.states,
  );
  assert.deepEqual(keyboard.expectedRoleIds, ["focus.outline"]);
  assert.deepEqual(input.expectedRoleIds, ["input.placeholder", "focus.outline"]);
  assert.deepEqual(keyboard.ready, {
    kind: "matches",
    selector: "#addImportButton:focus-visible",
    description: "自然 Tab 命中目录按钮，焦点环可见",
  });
  assert.deepEqual(input.ready, {
    kind: "matches",
    selector: "#pricingSearch:focus-visible",
    description: "自然 Tab 命中计价搜索框，焦点环可见",
  });
  assert.deepEqual(
    keyboard.steps.map(({ note: _note, ...step }) => step),
    [{ action: "focus", selector: "#addImportButton" }],
  );
  assert.deepEqual(
    input.steps.map(({ note: _note, ...step }) => step),
    [
      { action: "click", selector: "#updatePricingButton" },
      { action: "focus", selector: "#pricingSearch" },
    ],
  );
  assert.deepEqual(keyboard.restore, [{ action: "focus", selector: "body" }]);
  assert.deepEqual(input.restore, [{ action: "click", selector: "#cancelPricingButton" }]);
  for (const state of [keyboard, input]) {
    const note = state.steps.find((step) => step.action === "focus").note;
    assert.match(note, /自然 Tab.*循环命中/);
    assert.match(note, /已聚焦.*不等于键盘可达/);
    assert.match(note, /capture 严格 Tab 实现待后续卡/);
  }
  assert.match(focus.applicability, /computed outline.*原地背景/);
  assert.match(focus.applicability, /outline:0.*仍待核验/);
  for (const selector of ["#addImportButton", "#pricingSearch"]) {
    assert.ok(focus.sourceRefs.some((ref) => ref.file === "public/index.html" && ref.symbol === selector));
  }
  assert.ok(
    focus.sourceRefs.some((ref) => ref.file === "public/styles.css" && ref.symbol.includes("全局 2px 实线与 offset3")),
  );
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("A31：冗余详情条形填充与无 tooltip 聚光态双向接线", () => {
  const role = ROLE_CATALOG.find((item) => item.id === "chart.detail-fill");
  const state = STATE_CATALOG.find((item) => item.id === "spotlight-detail-fill");
  const dashboard = STATE_CATALOG.find((item) => item.id === "dashboard-default");
  const oldState = STATE_CATALOG.find((item) => item.id === "spotlight-detail-bars");
  const oldRole = ROLE_CATALOG.find((item) => item.id === "chart.model-bar");
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

  assert.equal(policy.versions.roles, ROLES_VERSION);
  assert.equal(validatePolicy(policy).valid, true);

  assert.deepEqual(role, {
    id: "chart.detail-fill",
    kind: "graphic",
    selector: "#detailPanel #detailList > .bar-row > .bar-track > .bar-fill",
    states: ["dashboard-default", "spotlight-detail-fill"],
    foreground: null,
    background: { kind: "solid", color: { kind: "var", name: "--track" } },
    threshold: null,
    required: false,
    applicability:
      "冗余图形：详情面板每条同时有可见名称和数值，条形只表达相对用量，按 chart.model-bar 同一原则不单独套图形比值；普通与聚光状态仍保留视觉检查，不并入旧 chart.model-bar，也不得推广到时间线、图例、坐标或无等价可见文字的图形。",
    sourceRefs: [
      { file: "public/app.js", symbol: "renderBarListHtml：.bar-track > .bar-fill 内联填充", line: 1588 },
      { file: "public/styles.css", symbol: ".bar-track background: var(--track)", line: 1874 },
      { file: "public/styles.css", symbol: ".bar-fill 默认 linear-gradient", line: 1878 },
      { file: "public/styles.css", symbol: "亮色 ceramic 的 --track 映射到 --ceramic-well", line: 2770 },
      { file: "public/styles.css", symbol: "深色 ceramic 的 --track 映射到 --ceramic-well", line: 2794 },
      { file: "public/styles.css", symbol: ".detail-panel .bar-track 高度 4/3", line: 3086 },
    ],
  });
  assert.ok(dashboard.expectedRoleIds.includes(role.id));
  assert.deepEqual(state.steps, [{ action: "hover", selector: "#detailPanel > .panel-heading" }]);
  assert.equal(state.ready.kind, "spotlightHost");
  assert.match(state.ready.selector, /^body:has\(#usageTooltip\[hidden\]\) /);
  assert.match(state.ready.selector, /\.bar-row:nth-child\(1\) > \.bar-track > \.bar-fill/);
  assert.match(state.ready.selector, /\.bar-row:nth-child\(2\) > \.bar-track > \.bar-fill/);
  assert.doesNotMatch(state.ready.selector, /:has\([^)]*:has\(/);
  assert.deepEqual(state.restore, [{ action: "setSpotlight", value: "off" }]);
  assert.deepEqual(state.expectedRoleIds, [role.id]);
  assert.deepEqual(
    STATE_CATALOG.filter((item) => item.expectedRoleIds.includes(role.id)).map((item) => item.id),
    role.states,
  );
  assert.equal(oldState.expectedRoleIds.includes(role.id), false);
  assert.equal(oldRole.required, false);
  assert.equal(oldRole.threshold, null);
  assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);
});

test("A31 回归：仅冗余详情条形与聚光装饰退出数值门槛，必要文字和图形保持原约束", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
  const roleIds = [
    "spotlight.tinted-surface",
    "chart.detail-fill",
    "panel.section-title",
    "panel.detail-bar-name",
    "focus.outline",
    "chart.timeline-segment",
    "chart.legend-swatch",
  ];
  const roles = roleIds.map((id) => ROLE_CATALOG.find((role) => role.id === id));
  const result = evaluatePalette({
    skinId: "chatgpt",
    mode: "light",
    tokens: makeTokens(),
    roleCatalog: roles,
    policy,
  });
  const byId = new Map(result.entries.map((entry) => [entry.roleId, entry]));

  for (const id of ["spotlight.tinted-surface", "chart.detail-fill"]) {
    assert.equal(byId.get(id).required, false);
    assert.equal(byId.get(id).threshold, null);
    assert.equal(byId.get(id).status, "unmeasured");
    assert.equal(byId.get(id).method, "not-applicable");
    assert.equal(byId.get(id).ratio, null);
  }
  for (const id of ["panel.section-title", "panel.detail-bar-name"]) {
    assert.equal(byId.get(id).required, true);
    assert.equal(byId.get(id).threshold, 4.5);
    assert.ok(byId.get(id).status === "pass" || byId.get(id).status === "fail");
  }
  assert.equal(byId.get("focus.outline").required, true);
  assert.equal(byId.get("focus.outline").threshold, 3);
  for (const id of ["chart.timeline-segment", "chart.legend-swatch"]) {
    assert.equal(byId.get(id).required, true);
    assert.equal(byId.get(id).threshold, 3);
    assert.notEqual(byId.get(id).method, "not-applicable");
  }
});

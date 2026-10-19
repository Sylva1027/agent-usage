/**
 * M0.3 数据契约、政策与失败记录（皮肤配色重设 · 总计划 2026-10-03）
 * ============================================================================
 *
 * 各模块（M2 求解、M3 检查、M4 预览/报告、M5 批次、M6 接入）交换的对象、
 * 摘要与失败出口统一在这里定义；任何 agent 不得自造另一种 JSON 形状。
 * 接口冲突时先修本契约（递增 SCHEMA_VERSION），再改实现。
 *
 * 摘要规范：canonicalJson(value) 递归排序对象键（数组保持原序）、拒绝
 * NaN/Infinity/undefined/循环/非 JSON 类型；sha256Canonical 对 UTF-8 字节取
 * SHA-256。落盘规范 = canonicalJson 输出 + 一个末尾换行（UTF-8、无缩进）。
 * 摘要只吃可复现数据：运行时间、机器绝对路径、截图与评审结论放
 * run.json / assessments.json / selections.json，不进入候选 JSON。
 *
 * 生产 token 键从 public/skins.js 读取（PALETTE_TOKEN_KEYS），不另维护
 * 可漂移列表；十套 ID 同样取自注册表并排除 classic。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CLASSIC_SKIN_ID, PALETTE_TOKEN_KEYS, listSkinIds } from "../../public/skins.js";
import { BASE_COLORS, ROLE_CATALOG, ROLES_VERSION, STATE_CATALOG } from "./roles.mjs";

export const SCHEMA_VERSION = 1;

/** 十套角色皮肤（注册表顺序，排除 classic）。classic 是回归对象，不参与候选。 */
export const SKIN_IDS = Object.freeze(listSkinIds().filter((id) => id !== CLASSIC_SKIN_ID));
export const MODES = Object.freeze(["light", "dark"]);
export const VARIANTS = Object.freeze(["a", "b", "c"]);

/** 候选 token 只收不透明 #RRGGBB（大写）。alpha/小写/短写都在生产宽松通道里，不进候选。 */
const HEX_TOKEN_PATTERN = /^#[0-9A-F]{6}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[a-z0-9]+-(a|b|c)-[0-9a-f]{12}$/;
/** 候选 JSON 里禁止出现的时间键（运行时间属 run.json / assessments.json / selections.json）。 */
const TIME_KEY_PATTERN = /At$|^(timestamp|time|date|generatedAt|recordedAt|createdAt|updatedAt|asOf)$/;
/** 机器绝对路径启发式：盘符或 *nix 用户/临时目录前缀。 */
// 机器绝对路径：Windows 盘符、UNC（\\server\share）、任意 POSIX 绝对路径（/...）。
// 候选是可复现数据，不应携带这类路径；URL（https://…）不以 / 开头，不受影响。
const ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]|^\\\\|^\//;

const ROLE_IDS = Object.freeze(new Set(ROLE_CATALOG.map((role) => role.id)));
const STATE_IDS = Object.freeze(new Set(STATE_CATALOG.map((state) => state.id)));
const FAILURE_CODES = Object.freeze(
  new Set([
    "INVALID_INPUT",
    "UNSATISFIABLE",
    "CONTRACT_CONFLICT",
    "SEARCH_BUDGET_EXCEEDED",
    "ENVIRONMENT_BLOCKED",
    "STALE_EVIDENCE",
    "DUPLICATE_CANDIDATE",
  ]),
);
const RESULT_VALUES = Object.freeze(new Set(["pass", "fail", "unmeasured", "not-applicable"]));
const READINESS_VALUES = Object.freeze(new Set(["ready", "rejected", "incomplete"]));

/** 校验错误：path 为字段路径（如 "modes.dark.accent"），code 为机器可读原因。 */
const error = (path, code, message) => ({ path, code, message });

/** Fail fast if the two input-role maps drift from their declared state coverage. */
export function assertRoleSelectorsByState(roleCatalog, stateCatalog) {
  const rolesById = new Map(roleCatalog.map((role) => [role.id, role]));
  const statesById = new Map(stateCatalog.map((state) => [state.id, state]));
  for (const roleId of ["input.value", "input.placeholder"]) {
    const role = rolesById.get(roleId);
    if (!role) throw new TypeError(`角色目录缺少 ${roleId}`);
    const selectors = role.selectorsByState;
    if (
      !selectors ||
      typeof selectors !== "object" ||
      Array.isArray(selectors) ||
      Object.getPrototypeOf(selectors) !== Object.prototype
    ) {
      throw new TypeError(`${roleId}.selectorsByState 必须是普通对象`);
    }
    if (!Array.isArray(role.states) || new Set(role.states).size !== role.states.length) {
      throw new TypeError(`${roleId}.states 必须是无重复状态 ID 的数组`);
    }
    const selectorStateIds = Object.keys(selectors);
    if (
      selectorStateIds.length !== role.states.length ||
      selectorStateIds.some((stateId) => !role.states.includes(stateId))
    ) {
      throw new TypeError(`${roleId}.selectorsByState 状态键必须与 role.states 完全一致`);
    }
    for (const stateId of role.states) {
      const state = statesById.get(stateId);
      if (!state) throw new TypeError(`${roleId} 引用了未知状态 ${stateId}`);
      if (typeof selectors[stateId] !== "string" || !selectors[stateId].trim()) {
        throw new TypeError(`${roleId}.selectorsByState.${stateId} 必须是非空 selector`);
      }
      if (!Array.isArray(state.expectedRoleIds) || !state.expectedRoleIds.includes(roleId)) {
        throw new TypeError(`${stateId}.expectedRoleIds 缺少 ${roleId}`);
      }
    }
    for (const state of stateCatalog) {
      if (state.expectedRoleIds?.includes(roleId) && !role.states.includes(state.id)) {
        throw new TypeError(`${state.id}.expectedRoleIds 与 ${roleId}.states 不互为镜像`);
      }
    }
  }
}

assertRoleSelectorsByState(ROLE_CATALOG, STATE_CATALOG);

// ---------------------------------------------------------------------------
// canonical JSON 与摘要
// ---------------------------------------------------------------------------

export function canonicalJson(value) {
  const onPath = new WeakSet();
  const walk = (node, path) => {
    if (node === null) return null;
    const type = typeof node;
    if (type === "string" || type === "boolean") return node;
    if (type === "number") {
      if (!Number.isFinite(node)) throw new TypeError(`canonicalJson: 非 JSON 数值（${path}）`);
      return node;
    }
    if (type !== "object") {
      throw new TypeError(`canonicalJson: 不支持的类型 ${type}（${path}）`);
    }
    // 只拦截"当前递归路径"上的重入：跨条目共享的冻结对象（DAG）是合法的。
    if (onPath.has(node)) throw new TypeError(`canonicalJson: 循环引用（${path}）`);
    onPath.add(node);
    if (Array.isArray(node)) {
      const out = [];
      for (let index = 0; index < node.length; index += 1) {
        if (!(index in node)) throw new TypeError(`canonicalJson: 稀疏数组（${path}[${index}]）`);
        out.push(walk(node[index], `${path}[${index}]`));
      }
      onPath.delete(node);
      return out;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: 非 JSON 对象类型（${path}，如 Date/Map/类实例）`);
    }
    const out = {};
    for (const key of Object.keys(node).sort()) {
      const child = node[key];
      if (child === undefined) throw new TypeError(`canonicalJson: undefined 值（${path}.${key}）`);
      out[key] = walk(child, `${path}.${key}`);
    }
    onPath.delete(node);
    return out;
  };
  return JSON.stringify(walk(value, "$"));
}

export function sha256Canonical(value) {
  return createHash("sha256")
    .update(Buffer.from(canonicalJson(value), "utf8"))
    .digest("hex");
}

/** 落盘规范：canonicalJson 输出 + 一个末尾换行；CLI 写候选/汇总时必须使用。 */
export function canonicalFileContent(value) {
  return `${canonicalJson(value)}\n`;
}

/**
 * 候选内容摘要：排除自引用字段 id / candidateHash（总计划 §4.1）。
 * id 本身由该摘要前 12 位派生（`${skinId}-${variant}-${hash12}`）。
 */
export function hashCandidate(candidate) {
  const { id: _id, candidateHash: _candidateHash, ...content } = candidate;
  return sha256Canonical(content);
}

/** 候选集摘要：排除自身 candidateSetHash。 */
export function hashCandidateSet(candidateSet) {
  const { candidateSetHash: _candidateSetHash, ...content } = candidateSet;
  return sha256Canonical(content);
}

/** 角色清单输入摘要（CandidateSet.inputHashes.roles）：清单或状态目录变动即失效。 */
export function hashRoleInputs() {
  return sha256Canonical({
    version: ROLES_VERSION,
    roles: ROLE_CATALOG,
    states: STATE_CATALOG,
    baseColors: BASE_COLORS,
  });
}

/** 收集文件原始字节的 SHA-256（运行证据用；候选摘要不走这里）。缺失即抛错。 */
export function collectSourceHashes(paths, readFile) {
  const read = readFile ?? ((path) => readFileSync(path));
  const out = {};
  for (const path of paths) {
    out[path] = createHash("sha256").update(read(path)).digest("hex");
  }
  return out;
}

// ---------------------------------------------------------------------------
// 校验器（返回 { valid, errors }；errors 元素含 path / code / message）
// ---------------------------------------------------------------------------

const walkForTimeAndPaths = (node, path, errors) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      walkForTimeAndPaths(item, `${path}[${index}]`, errors);
    });
    return;
  }
  for (const key of Object.keys(node)) {
    const childPath = path ? `${path}.${key}` : key;
    if (TIME_KEY_PATTERN.test(key)) {
      errors.push(
        error(childPath, "forbidden", `候选数据不得携带时间字段 "${key}"（运行时间放 run.json / assessments.json）`),
      );
    }
    const value = node[key];
    if (typeof value === "string" && ABSOLUTE_PATH_PATTERN.test(value)) {
      errors.push(error(childPath, "forbidden", `候选数据不得携带机器绝对路径（${key}）`));
    }
    walkForTimeAndPaths(value, childPath, errors);
  }
};

export function validateTokens(value, pathPrefix = "") {
  const errors = [];
  const at = (key) => (pathPrefix ? `${pathPrefix}.${key}` : key);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: [error(pathPrefix || "$", "shape", "tokens 必须是对象")] };
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!PALETTE_TOKEN_KEYS.includes(key)) {
      errors.push(error(at(key), "extra", `未知 token "${key}"（只允许 PALETTE_TOKEN_KEYS 的 12 个键）`));
    }
  }
  for (const key of PALETTE_TOKEN_KEYS) {
    const tokenValue = value[key];
    if (typeof tokenValue !== "string" || !HEX_TOKEN_PATTERN.test(tokenValue)) {
      errors.push(error(at(key), "format", `token "${key}" 必须是 #RRGGBB（大写、不透明，禁止 alpha/短写/小写）`));
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * profiles 的字段与单位以 M5.1 为准；本版只锁信封：恰好十套 ID 的
 * plain-object 映射，每套 profile 为可 JSON 化的非空对象（无时间字段）。
 */
export function validateProfiles(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: [error("$", "shape", "profiles 必须是 { [skinId]: profile } 映射")] };
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!SKIN_IDS.includes(key)) errors.push(error(key, "unknown", `未知皮肤 "${key}"`));
  }
  for (const skinId of SKIN_IDS) {
    const profile = value[skinId];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      errors.push(error(skinId, "missing", `缺少皮肤 "${skinId}" 的 profile`));
      continue;
    }
    if (Object.keys(profile).length === 0) {
      errors.push(error(skinId, "empty", "profile 不能是空对象（字段细则待 M5.1，但至少要有一个字段）"));
      continue;
    }
    const probe = walkForTimeAndPathsProbe(profile);
    if (probe) errors.push(error(`${skinId}.${probe.path}`, "forbidden", probe.message));
  }
  return { valid: errors.length === 0, errors };
}

const walkForTimeAndPathsProbe = (value) => {
  const errors = [];
  walkForTimeAndPaths(value, "$", errors);
  return errors[0] ?? null;
};

function validateMeasurement(value, path, errors) {
  if (!value || typeof value !== "object") {
    errors.push(error(path, "shape", "测量记录必须是对象"));
    return;
  }
  for (const field of [
    "candidateId",
    "mode",
    "roleId",
    "stateId",
    "result",
    "ratio",
    "threshold",
    "method",
    "evidence",
    "reason",
  ]) {
    if (!(field in value)) errors.push(error(`${path}.${field}`, "missing", "测量记录缺少字段"));
  }
  if (typeof value.candidateId !== "string" || !value.candidateId) {
    errors.push(error(`${path}.candidateId`, "format", "candidateId 必须为非空字符串"));
  }
  if (!MODES.includes(value.mode)) errors.push(error(`${path}.mode`, "unknown", `非法 mode "${value.mode}"`));
  if (typeof value.roleId !== "string" || !ROLE_IDS.has(value.roleId)) {
    errors.push(error(`${path}.roleId`, "unknown", `未知角色 "${value.roleId}"`));
  }
  if (value.stateId !== null && (typeof value.stateId !== "string" || !STATE_IDS.has(value.stateId))) {
    errors.push(error(`${path}.stateId`, "unknown", `未知状态 "${value.stateId}"（手工测量可用 null）`));
  }
  if (!RESULT_VALUES.has(value.result))
    errors.push(error(`${path}.result`, "unknown", `非法 result "${value.result}"`));
  if (value.result === "pass" || value.result === "fail") {
    if (typeof value.ratio !== "number" || !Number.isFinite(value.ratio)) {
      errors.push(error(`${path}.ratio`, "format", "pass/fail 必须带有限 ratio（比较不得先四舍五入）"));
    }
    if (typeof value.threshold !== "number" || !Number.isFinite(value.threshold)) {
      errors.push(error(`${path}.threshold`, "format", "pass/fail 必须带有限阈值"));
    }
  } else if (value.ratio !== null) {
    errors.push(error(`${path}.ratio`, "format", "unmeasured/not-applicable 的 ratio 必须为 null 并在 reason 解释"));
  }
  if (typeof value.method !== "string" || !value.method) errors.push(error(`${path}.method`, "format", "method 必填"));
  if (typeof value.evidence !== "string" || !value.evidence)
    errors.push(error(`${path}.evidence`, "format", "evidence 必填"));
  if (typeof value.reason !== "string")
    errors.push(error(`${path}.reason`, "format", "reason 必须为字符串（可为空串）"));
}

export function validateAssessment(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { valid: false, errors: [error("$", "shape", "assessment 必须是对象")] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) errors.push(error("schemaVersion", "mismatch", "schemaVersion 必须为 1"));
  for (const field of ["candidateId", "candidateHash"]) {
    if (typeof value[field] !== "string" || !value[field]) errors.push(error(field, "missing", `缺少 ${field}`));
  }
  if (typeof value.candidateHash === "string" && !SHA256_PATTERN.test(value.candidateHash)) {
    errors.push(error("candidateHash", "format", "candidateHash 必须是 64 位小写 hex"));
  }
  for (const field of ["fast", "browser"]) {
    const list = value[field];
    if (!Array.isArray(list)) {
      errors.push(error(field, "shape", `${field} 必须是测量记录数组`));
      continue;
    }
    list.forEach((record, index) => {
      validateMeasurement(record, `${field}[${index}]`, errors);
    });
  }
  const visual = value.visual;
  if (!visual || typeof visual !== "object") {
    errors.push(error("visual", "shape", "visual 必须是 { reviewed, verdict, notes }"));
  } else {
    if (typeof visual.reviewed !== "boolean") errors.push(error("visual.reviewed", "format", "reviewed 必须为布尔"));
    if (visual.verdict !== null && visual.verdict !== "pass" && visual.verdict !== "fail") {
      errors.push(error("visual.verdict", "unknown", "verdict 只能是 pass / fail / null"));
    }
    if (typeof visual.notes !== "string") errors.push(error("visual.notes", "format", "notes 必须为字符串"));
  }
  if (!READINESS_VALUES.has(value.readiness)) {
    errors.push(error("readiness", "unknown", `非法 readiness "${value.readiness}"`));
  }
  for (const field of ["failures", "unmeasured"]) {
    const list = value[field];
    if (!Array.isArray(list)) {
      errors.push(error(field, "shape", `${field} 必须是数组`));
      continue;
    }
    list.forEach((record, index) => {
      validateMeasurement(record, `${field}[${index}]`, errors);
      if (Array.isArray(list) && list[index] && list[index].result !== (field === "failures" ? "fail" : "unmeasured")) {
        errors.push(
          error(
            `${field}[${index}].result`,
            "mismatch",
            `${field} 中的记录 result 必须是 ${field === "failures" ? "fail" : "unmeasured"}`,
          ),
        );
      }
    });
  }
  if (!value.diagnostics || typeof value.diagnostics !== "object") {
    errors.push(error("diagnostics", "shape", "diagnostics 必须是对象（可为空对象）"));
  }
  if (errors.length === 0) {
    const hasFailure =
      value.failures.length > 0 ||
      [...value.fast, ...value.browser].some((record) => record.result === "fail") ||
      visual.verdict === "fail";
    const hasGap =
      value.unmeasured.length > 0 || [...value.fast, ...value.browser].some((record) => record.result === "unmeasured");
    if (hasFailure && value.readiness !== "rejected") {
      errors.push(error("readiness", "mismatch", "存在必要角色失败时 readiness 必须是 rejected"));
    }
    if (!hasFailure && hasGap && value.readiness !== "incomplete") {
      errors.push(error("readiness", "mismatch", "存在缺测时 readiness 必须是 incomplete"));
    }
    if (!hasFailure && !hasGap && (value.readiness !== "ready" || visual.reviewed !== true)) {
      if (value.readiness !== "incomplete") {
        errors.push(error("readiness", "mismatch", "无失败无缺测但视觉初筛未完成时 readiness 必须是 incomplete"));
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateCandidate(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { valid: false, errors: [error("$", "shape", "candidate 必须是对象")] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) errors.push(error("schemaVersion", "mismatch", "schemaVersion 必须为 1"));
  if (!SKIN_IDS.includes(value.skinId)) errors.push(error("skinId", "unknown", `未知皮肤 "${value.skinId}"`));
  if (!VARIANTS.includes(value.variant)) errors.push(error("variant", "unknown", `非法变体 "${value.variant}"`));
  if (value.profileVersion !== SCHEMA_VERSION)
    errors.push(error("profileVersion", "mismatch", "profileVersion 必须为 1"));
  if (!value.profileSnapshot || typeof value.profileSnapshot !== "object" || Array.isArray(value.profileSnapshot)) {
    errors.push(error("profileSnapshot", "shape", "profileSnapshot 必须是该皮肤完整配方的对象"));
  }
  for (const field of ["profileHash", "policyHash", "derivationHash", "candidateHash"]) {
    const digest = value[field];
    if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
      errors.push(error(field, "format", `${field} 必须是 64 位小写 hex`));
    }
  }
  if (typeof value.seed !== "string" || !value.seed)
    errors.push(error("seed", "missing", "seed 必填（本版固定 palette-redesign-v1）"));
  const style = value.style;
  if (!style || typeof style !== "object") {
    errors.push(error("style", "shape", "style 必须是 { title, rationale, identitySource }"));
  } else {
    for (const field of ["title", "rationale", "identitySource"]) {
      if (typeof style[field] !== "string" || !style[field])
        errors.push(error(`style.${field}`, "missing", `style.${field} 必填`));
    }
  }
  const parameters = value.parameters;
  if (!parameters || typeof parameters !== "object") {
    errors.push(error("parameters", "shape", "parameters 必须是 { light, dark, search }"));
  } else {
    for (const field of ["light", "dark", "search"]) {
      if (!parameters[field] || typeof parameters[field] !== "object") {
        errors.push(error(`parameters.${field}`, "missing", `parameters.${field} 必须是对象`));
      }
    }
  }
  const modes = value.modes;
  if (!modes || typeof modes !== "object") {
    errors.push(error("modes", "shape", "modes 必须是 { light, dark }"));
  } else {
    for (const key of Object.keys(modes)) {
      if (!MODES.includes(key)) errors.push(error(`modes.${key}`, "unknown", `非法 mode "${key}"`));
    }
    for (const mode of MODES) {
      if (modes[mode]) {
        const tokens = validateTokens(modes[mode], `modes.${mode}`);
        errors.push(...tokens.errors);
      } else if (!errors.some((e) => e.path === "modes")) {
        errors.push(error(`modes.${mode}`, "missing", `缺少 ${mode} 模式 token（半套候选不接受）`));
      }
    }
  }
  walkForTimeAndPaths(value, "", errors);
  if (errors.length === 0 && typeof value.profileHash === "string" && value.profileSnapshot) {
    const expectedProfileHash = sha256Canonical(value.profileSnapshot);
    if (value.profileHash !== expectedProfileHash) {
      errors.push(error("profileHash", "mismatch", "profileHash 与 profileSnapshot 摘要不一致"));
    }
  }
  if (errors.length === 0 && typeof value.candidateHash === "string") {
    const expectedHash = hashCandidate(value);
    if (value.candidateHash !== expectedHash) {
      errors.push(error("candidateHash", "mismatch", "candidateHash 与候选内容摘要不一致"));
    } else if (typeof value.id === "string" && SKIN_IDS.includes(value.skinId) && VARIANTS.includes(value.variant)) {
      const expectedId = `${value.skinId}-${value.variant}-${expectedHash.slice(0, 12)}`;
      if (value.id !== expectedId) {
        errors.push(
          error(
            "id",
            "mismatch",
            `id 应为 "${expectedId}"（${value.skinId}-${variantLabel(value.variant)}-<hash前12位>）`,
          ),
        );
      }
    }
  }
  if (typeof value.id !== "string" || !value.id) {
    errors.push(error("id", "missing", "id 必填（<skinId>-<variant>-<hash前12位>）"));
  } else if (!CANDIDATE_ID_PATTERN.test(value.id)) {
    errors.push(error("id", "format", 'id 形状必须为 "<skinId>-<variant>-<hash前12位>"'));
  }
  return { valid: errors.length === 0, errors };
}

const variantLabel = (variant) => variant;

export function validateFailureRecord(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { valid: false, errors: [error("$", "shape", "FailureRecord 必须是对象")] };
  }
  if (!FAILURE_CODES.has(value.code)) errors.push(error("code", "unknown", `非法失败码 "${value.code}"`));
  if (!("skinId" in value)) {
    errors.push(error("skinId", "missing", "skinId 字段必须存在（成对失败可为 null）"));
  } else if (value.skinId !== null && !SKIN_IDS.includes(value.skinId)) {
    errors.push(error("skinId", "unknown", `未知皮肤 "${value.skinId}"`));
  }
  const hasMode = value.mode === "light" || value.mode === "dark";
  const hasPair = typeof value.pair === "string" && value.pair.length > 0;
  if (hasMode === hasPair) {
    errors.push(error("mode/pair", "shape", "必须恰好给出 mode（单模式失败）或 pair（浅深成对失败）之一"));
  }
  if (!("variant" in value)) {
    errors.push(error("variant", "missing", "variant 字段必须存在（可为 null）"));
  } else if (value.variant !== null && !VARIANTS.includes(value.variant)) {
    errors.push(error("variant", "unknown", `非法变体 "${value.variant}"`));
  }
  if (!Array.isArray(value.roleIds)) {
    errors.push(error("roleIds", "shape", "roleIds 必须是数组（可为空）"));
  } else {
    for (const roleId of value.roleIds) {
      if (!ROLE_IDS.has(roleId)) errors.push(error("roleIds", "unknown", `未知角色 "${roleId}"`));
    }
  }
  if (!Array.isArray(value.attemptedRanges)) {
    errors.push(error("attemptedRanges", "shape", "attemptedRanges 必须是数组（可为空）"));
  }
  if (value.worstRatio !== null && (typeof value.worstRatio !== "number" || !Number.isFinite(value.worstRatio))) {
    errors.push(error("worstRatio", "format", "worstRatio 必须是有限数值或 null（null 时 message 必须解释原因）"));
  }
  if (value.worstRatio === null && (typeof value.message !== "string" || value.message.length < 8)) {
    errors.push(error("message", "format", "worstRatio 为 null 时 message 必须解释原因"));
  }
  if (value.threshold !== null && (typeof value.threshold !== "number" || !Number.isFinite(value.threshold))) {
    errors.push(error("threshold", "format", "threshold 必须是有限数值或 null"));
  }
  if (typeof value.message !== "string" || !value.message) errors.push(error("message", "missing", "message 必填"));
  if (value.code === "DUPLICATE_CANDIDATE") {
    if (typeof value.relatedCandidateId !== "string" || !value.relatedCandidateId) {
      errors.push(error("relatedCandidateId", "missing", "去重记录必须给出 relatedCandidateId"));
    }
    if (
      !Array.isArray(value.distances) ||
      !value.distances.length ||
      !value.distances.every((d) => typeof d === "number" && Number.isFinite(d))
    ) {
      errors.push(error("distances", "format", "去重记录必须给出非空 D_OK 距离数组（不得用对比度冒充色差）"));
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateCandidateSet(value, options = {}) {
  const errors = [];
  const expectedSkinIds = options.expectedSkinIds ?? SKIN_IDS;
  if (!value || typeof value !== "object") {
    return { valid: false, errors: [error("$", "shape", "candidateSet 必须是对象")] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) errors.push(error("schemaVersion", "mismatch", "schemaVersion 必须为 1"));
  const inputHashes = value.inputHashes;
  if (!inputHashes || typeof inputHashes !== "object") {
    errors.push(error("inputHashes", "shape", "inputHashes 必须是 { profiles, policy, roles, derivation }"));
  } else {
    for (const field of ["profiles", "policy", "derivation"]) {
      if (typeof inputHashes[field] !== "string" || !SHA256_PATTERN.test(inputHashes[field] ?? "")) {
        errors.push(error(`inputHashes.${field}`, "format", "必须是 64 位小写 hex"));
      }
    }
    if (typeof inputHashes.roles !== "string" || !SHA256_PATTERN.test(inputHashes.roles ?? "")) {
      errors.push(error("inputHashes.roles", "format", "必须是 64 位小写 hex"));
    } else if (inputHashes.roles !== hashRoleInputs()) {
      errors.push(error("inputHashes.roles", "mismatch", "roles 摘要与当前角色清单不一致（清单已变更，旧评审失效）"));
    }
  }
  const candidates = value.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    errors.push(error("candidates", "shape", "candidates 必须是非空数组"));
  } else {
    const seenIds = new Set();
    const seenPairs = new Set();
    const orderIndex = new Map(SKIN_IDS.map((id, index) => [id, index]));
    let previousRank = -1;
    candidates.forEach((candidate, index) => {
      const result = validateCandidate(candidate);
      if (!result.valid) {
        for (const e of result.errors) errors.push(error(`candidates[${index}].${e.path}`, e.code, e.message));
      }
      if (candidate && typeof candidate === "object") {
        if (seenIds.has(candidate.id))
          errors.push(error(`candidates[${index}].id`, "duplicate", `候选 id 重复 "${candidate.id}"`));
        seenIds.add(candidate.id);
        const pairKey = `${candidate.skinId}/${candidate.variant}`;
        if (seenPairs.has(pairKey)) errors.push(error(`candidates[${index}]`, "duplicate", `候选组合重复 ${pairKey}`));
        seenPairs.add(pairKey);
        const skinRank = orderIndex.get(candidate.skinId);
        const variantRank = VARIANTS.indexOf(candidate.variant);
        const rank = skinRank === undefined ? Number.NaN : skinRank * VARIANTS.length + variantRank;
        if (!Number.isNaN(rank)) {
          if (rank <= previousRank) {
            errors.push(error(`candidates[${index}]`, "order", "候选必须按注册顺序再按 a/b/c 排列"));
          }
          previousRank = rank;
        }
      }
    });
    for (const skinId of expectedSkinIds) {
      for (const variant of VARIANTS) {
        if (!seenPairs.has(`${skinId}/${variant}`)) {
          errors.push(error("candidates", "missing", `缺少 ${skinId}-${variant}（半套候选不接受）`));
        }
      }
    }
  }
  const rejected = value.rejected;
  if (!Array.isArray(rejected)) {
    errors.push(error("rejected", "shape", "rejected 必须是 FailureRecord 数组（可为空数组）"));
  } else {
    rejected.forEach((record, index) => {
      const result = validateFailureRecord(record);
      if (!result.valid) {
        for (const e of result.errors) errors.push(error(`rejected[${index}].${e.path}`, e.code, e.message));
      }
    });
  }
  if (typeof value.candidateSetHash !== "string" || !SHA256_PATTERN.test(value.candidateSetHash)) {
    errors.push(error("candidateSetHash", "format", "candidateSetHash 必填且为 64 位小写 hex"));
  } else if (errors.length === 0 && value.candidateSetHash !== hashCandidateSet(value)) {
    errors.push(error("candidateSetHash", "mismatch", "candidateSetHash 与候选集内容摘要不一致"));
  }
  return { valid: errors.length === 0, errors };
}

export function validateSelections(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { valid: false, errors: [error("$", "shape", "selections 必须是对象")] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) errors.push(error("schemaVersion", "mismatch", "schemaVersion 必须为 1"));
  for (const field of ["candidateSetHash", "assessmentHash"]) {
    const digest = value[field];
    if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
      errors.push(error(field, "format", `${field} 必须是 64 位小写 hex`));
    }
  }
  const choices = value.choices;
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) {
    errors.push(error("choices", "shape", "choices 必须是 { [skinId]: { candidateId, candidateHash } }"));
  } else {
    for (const skinId of Object.keys(choices)) {
      if (!SKIN_IDS.includes(skinId)) errors.push(error(`choices.${skinId}`, "unknown", `未知皮肤 "${skinId}"`));
    }
    for (const skinId of SKIN_IDS) {
      const choice = choices[skinId];
      if (!choice || typeof choice !== "object") {
        errors.push(error(`choices.${skinId}`, "missing", `缺少皮肤 "${skinId}" 的选择（不可拆取浅深、不可缺一套）`));
        continue;
      }
      if (typeof choice.candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(choice.candidateId)) {
        errors.push(error(`choices.${skinId}.candidateId`, "format", "candidateId 形状非法"));
      }
      if (typeof choice.candidateHash !== "string" || !SHA256_PATTERN.test(choice.candidateHash)) {
        errors.push(error(`choices.${skinId}.candidateHash`, "format", "candidateHash 必须是 64 位小写 hex"));
      }
    }
  }
  if (typeof value.decisionSource !== "string" || !value.decisionSource) {
    errors.push(error("decisionSource", "missing", "decisionSource 必填（用户消息日期与摘录；代选授权记录原话）"));
  }
  if (typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) {
    errors.push(error("recordedAt", "format", "recordedAt 必须是可解析的时间戳（本字段属选择记录，允许携带时间）"));
  }
  return { valid: errors.length === 0, errors };
}

/** policy.json 形状校验（阈值/预算/版本字段存在且合法；口径本身由总计划 §5 固定）。 */
export function validatePolicy(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { valid: false, errors: [error("$", "shape", "policy 必须是对象")] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) errors.push(error("schemaVersion", "mismatch", "schemaVersion 必须为 1"));
  const readability = value.readability;
  if (
    readability?.bodyTextMin !== 4.5 ||
    readability.primaryTextPreferred !== 7 ||
    readability.necessaryGraphicMin !== 3
  ) {
    errors.push(
      error(
        "readability",
        "mismatch",
        "readability 必须为 bodyTextMin 4.5 / primaryTextPreferred 7 / necessaryGraphicMin 3",
      ),
    );
  }
  const solver = value.solver;
  if (solver?.bodyTextTarget !== 4.7 || solver.primaryTextTarget !== 7.2) {
    errors.push(error("solver", "mismatch", "solver 必须为 bodyTextTarget 4.7 / primaryTextTarget 7.2"));
  }
  const budget = value.searchBudget;
  if (
    budget?.maxTrialsPerTokenPerRound !== 1024 ||
    budget.maxCouplingRounds !== 4 ||
    budget.maxBackgroundAttemptsPerVariant !== 3
  ) {
    errors.push(error("searchBudget", "mismatch", "searchBudget 必须为 1024 / 4 / 3"));
  }
  if (value.srgbGamutEpsilon !== 1e-7)
    errors.push(error("srgbGamutEpsilon", "mismatch", "srgbGamutEpsilon 必须为 1e-7"));
  if (value.colourDistance?.version !== "oklab-distance-v1") {
    errors.push(error("colourDistance.version", "mismatch", 'colourDistance.version 必须为 "oklab-distance-v1"'));
  }
  const versions = value.versions;
  if (!versions || typeof versions !== "object") {
    errors.push(error("versions", "shape", "versions 必须是 { roles, colourMath, fixture }"));
  } else {
    for (const field of ["roles", "colourMath", "fixture"]) {
      if (!Number.isInteger(versions[field]) || versions[field] < 1) {
        errors.push(error(`versions.${field}`, "format", `versions.${field} 必须为正整数`));
      }
    }
    if (versions.roles !== ROLES_VERSION) {
      errors.push(
        error(
          "versions.roles",
          "mismatch",
          `versions.roles 必须与 roles.mjs 的 ROLES_VERSION（当前 ${ROLES_VERSION}）一致`,
        ),
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

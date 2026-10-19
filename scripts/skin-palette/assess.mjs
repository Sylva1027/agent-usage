/**
 * M3.4 门禁、视觉初筛与证据过期（card: M3-readability-and-difference-checks.md）。
 *
 * `assessCandidate({ candidate, fastChecks, browserChecks, visualReview, run })`
 * → M0 约定的 Assessment。本模块只汇总**已有证据**：缺项保持缺项（readiness 退
 * incomplete 并注明缺什么），不把缺失补成通过，也不用一个总分代替阅读验收。
 *
 * 固定输入形状：
 *   candidate      M0 候选（validateCandidate 自校，含哈希自洽）
 *   fastChecks     M3.1 产物 `{ light, dark }`（各 `{ entries, summary }`，经
 *                  `fastResultToRecords` 适配）或**已经是** M0 测量记录数组
 *   browserChecks  M3.2 产物（`measureBrowserRoles` 返回值或其 records 数组，
 *                  可多条）或 M0 测量记录数组
 *   visualReview   visual-review.json 的记录（必填项见 VISUAL_REVIEW_ITEMS）；
 *                  缺省 = 未评审（readiness 因此 incomplete，**绝不自动填 accept**）
 *   run            证据出处：policy、当前 inputHashes、fixture、可选 recorded* 与总集
 *
 * 判定口径（卡面固定 + M0 validateAssessment 一致性）：
 *   - 任一必要角色 fail → `rejected`（视觉 reject 同样 rejected，且失败优先）
 *   - 缺角色/缺状态、fast approximate 待浏览器确认、视觉未评审、**出处不齐**、来源摘要
 *     或 fixture 版本不符 → `incomplete`，注明 `STALE_EVIDENCE` / `无法核验：` 或缺什么对象
 *   - 所有必要项都有有效 pass（或合法 not-applicable）且代理视觉初筛接受 → `ready`
 *   - 相同角色多条有效证据取最差比值；方法差异逐条记进 diagnostics
 *   - 7:1 是主文字优选：4.5—7 之间可以 ready，但读数必须显示余量；本模块不改写阈值
 *
 * 六条与卡面的执行口径（交接文档逐条说明理由；1—3 首轮定稿，4—6 复核更正后新增）：
 *   1. fast 的 `browserRequired` 与 `approximate` 都不产生"可门禁"的通过：browserRequired
 *      只留路由信息（diagnostics.coverage.fastDeferred）；approximate 记录照常落桶，但不进
 *      覆盖判读——近似读数压不过浏览器实测，通过不靠它、失败也不因它翻案。同时 M0 契约规定
 *      "任何 fail 记录都必须 rejected"，因此近似失败同样挡下评审（待浏览器实测复核），
 *      method 尾缀 `:approximate` 可分辨来源，blockers 里单独说明是哪一种失败。
 *   2. **只有 fast 桶能用 stateId=null 覆盖该模式全部状态**（快速路量的是声明色，与状态
 *      无关）。浏览器记录必须带状态锚点：stateId=null 的实测（M3.2 的 null 模式是把整份
 *      目录在页面当前状态下量一遍）证明不了"各状态都测过"，照常记账、照常参与失败/重复
 *      判定，但不进覆盖网格，并单独在 blockers 与 coverage.unanchoredBrowser 点名。
 *   3. 手工补测记进 `diagnostics.manualSupplement` 供人追溯，不进 fast/browser：
 *      M0 契约下 unmeasured 必判 incomplete，把人工数值塞进机器桶会破坏"机器门禁与
 *      人工初筛可分辨"。
 *   4. **阈值与判读都必须自证**：pass/fail 记录的阈值必须等于角色目录阈值（拿图形阈值 3
 *      判正文、或自造阈值都直接抛错），且 result 必须与全精度 ratio/阈值一致（4.499 对
 *      4.5 是 fail，不允许先四舍五入再改判）。
 *   5. **出处不齐即 incomplete**：candidateSet / recordedInputHashes / sourceHashes /
 *      recordedSourceHashes / fixture 缺任何一件都证明不了"证据属于当前版本"，无法核验，
 *      不能 ready；齐全但不一致才是 `STALE_EVIDENCE`。
 *   6. **阈值-less 角色（装饰/字标/图形例外）的 unmeasured 转成带理由的 not-applicable**：
 *      M3.1 对这类角色报 unmeasured 的语义是"不读数"，照搬进机器桶会把合法例外变成永久
 *      缺测、堵死 ready。有阈值却测不到的真正缺测保持 unmeasured。
 */

import {
  MODES,
  SCHEMA_VERSION,
  canonicalJson,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
  validateAssessment,
  validateCandidate,
  validatePolicy,
} from "./contracts.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "./roles.mjs";
import { assertDiagnosticsCarryNoVerdict, diagnoseCandidates } from "./diagnostics.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** 视觉初筛的两种身份：代理预筛与用户结论必须可分辨（卡面"用户选择与代理 ready 分离"）。 */
export const VISUAL_BY = Object.freeze(["proxy", "user"]);
export const VISUAL_VERDICTS = Object.freeze(["accept", "reject", "pending"]);

/** visual-review.json 的八个必填项（卡面原文顺序）。缺一项即不是一份完整初筛记录。 */
export const VISUAL_REVIEW_ITEMS = Object.freeze([
  { id: "logotype-legible", label: "字标可辨" },
  { id: "body-text-comfortable", label: "普通文字不刺眼" },
  { id: "ceramic-relief-consistent", label: "陶瓷凹凸可见且光源一致" },
  { id: "mode-identity-consistent", label: "浅深身份一致" },
  { id: "character-levels-unobstructed", label: "角色关闭/50%/100% 未遮挡必要阅读" },
  { id: "spotlight-not-overwhelming", label: "聚光未使文字淹没" },
  { id: "nearest-neighbour-distinguishable", label: "最近邻区别可解释" },
  { id: "no-geometry-workaround", label: "没有通过几何变更掩盖颜色问题" },
]);

/**
 * fast 近似结果的标记后缀。M0 测量记录契约字段固定（不多加字段——contracts.mjs
 * 属 M0，M3 不改契约），近似性因此编码进 `method`；生产者（fastResultToRecords）
 * 与消费者（本文件）共用这一个常量，不存在两处漂移。
 */
export const APPROXIMATE_METHOD_SUFFIX = ":approximate";

/** 证据产出时必须留下的四个输入摘要字段（少一个就证明不了证据属于当前版本）。 */
export const RECORDED_INPUT_FIELDS = Object.freeze(["profiles", "policy", "roles", "derivation"]);

/**
 * 本门禁的 26 项源文件依赖（出处核验的最小覆盖集）：分两段，两段都不可省。
 * ① 实际加载的页面/颜色文件——实测量的是浏览器里真正渲染出来的东西。总计划 4.1
 *    （第 155 行）点名"至少包含 public/index.html / skin-palettes.js / styles.css /
 *    app.js / app-state.js / skin-ui.js / skin-picker.js"，并要求"任一影响该候选颜色、
 *    背景或测量口径的依赖变化后，旧评审须重跑"——所以这句"至少"也把同一类依赖纳进来：
 *    `public/skins.css` 由 index.html（第 34 行）加载，装的是逐皮肤的颜色/渐变/透明度
 *    规则，是核验范围内的事实依赖，不是可选装饰。
 * ② 派生源与工具链——影响角色清单、阈值、比值计算、快读、实测、诊断与本判定的
 *    M0/M3 模块，连同派生源 public/skins.js。思路与 M2.4 的 `TOOLCHAIN_SOURCE_PATHS`
 *    相同——新增依赖文件必须同步改这里，否则该文件的改动不被核验。
 */
export const REQUIRED_SOURCE_FILES = Object.freeze([
  "public/index.html",
  "public/styles.css",
  "public/skins.css",
  "public/skin-palettes.js",
  "public/app.js",
  "public/app-state.js",
  "public/timeline-utils.js",
  "public/skin-ui.js",
  "public/skin-picker.js",
  "public/skins.js",
  "scripts/skin-palette/roles.mjs",
  "scripts/skin-palette/policy.json",
  "scripts/skin-palette/contracts.mjs",
  "scripts/skin-palette/color-math.mjs",
  "scripts/skin-palette/evaluate.mjs",
  "scripts/skin-palette/browser-measure.mjs",
  "scripts/skin-palette/focus-outline-pixels.mjs",
  "scripts/skin-palette/focus-outline-browser.mjs",
  "scripts/skin-palette/detail-bar-capture.mjs",
  "scripts/skin-palette/detail-bar-frame-analysis.mjs",
  "scripts/skin-palette/detail-bar-pixels.mjs",
  "scripts/skin-palette/detail-bar-browser.mjs",
  "scripts/skin-palette/detail-bar-hit-browser.mjs",
  "scripts/skin-palette/detail-bar-paint-browser.mjs",
  "scripts/skin-palette/diagnostics.mjs",
  "scripts/skin-palette/assess.mjs",
]);

/** 手工补测的必填注解（卡面：角色、状态、取样位置、前景/背景数值、计算方法和证据）。 */
const SUPPLEMENT_FIELDS = Object.freeze([
  "roleId",
  "stateId",
  "position",
  "foreground",
  "background",
  "method",
  "evidence",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`assessCandidate: ${name} 必须是非空字符串`);
  }
  return value;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`assessCandidate: ${name} 必须是对象`);
  }
  return value;
}

const ROLE_BY_ID = new Map(ROLE_CATALOG.map((role) => [role.id, role]));
const STATE_ID_SET = new Set(STATE_CATALOG.map((state) => state.id));

/**
 * 记录自检：借 validateAssessment 的信封走 M0 validateMeasurement 逐条校验，
 * 另外核对两件 M0 管不到、但门禁必须管的事：
 *   ① 阈值必须等于角色目录里的阈值（不能拿图形阈值 3 去判正文，也不能自造阈值）；
 *   ② pass/fail 必须与全精度 ratio/阈值一致（4.499 对 4.5 是 fail，不允许先四舍五入
 *      再改判，也不允许 ratio 3.1 对阈值 3 却记 pass 来骗过必要图形检查）。
 */
function assertRecordsConform(records) {
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) {
        throw new TypeError(
          `assessCandidate: 测量记录 ${record.roleId} 的字段 ${key} 是 undefined（字段要么给值，要么不要这个键）`,
        );
      }
    }
    const role = ROLE_BY_ID.get(record.roleId);
    if (role === undefined) continue;
    if (record.result === "pass" || record.result === "fail") {
      if (role.threshold === null) {
        throw new TypeError(
          `assessCandidate: 角色 ${record.roleId} 无阅读阈值，不得产出 ${record.result}（阈值-less 角色只能 not-applicable）`,
        );
      }
      if (record.threshold !== role.threshold) {
        throw new TypeError(
          `assessCandidate: 记录 ${record.roleId} @ ${record.stateId} 的阈值 ${record.threshold} 与角色目录阈值 ${role.threshold} 不一致（阈值只有角色目录一个出处）`,
        );
      }
      if (typeof record.ratio !== "number" || !Number.isFinite(record.ratio)) {
        throw new TypeError(`assessCandidate: 记录 ${record.roleId} @ ${record.stateId} 的 ratio 必须是有限数`);
      }
      const shouldPass = record.ratio >= record.threshold;
      if (shouldPass !== (record.result === "pass")) {
        throw new TypeError(
          `assessCandidate: 记录 ${record.roleId} @ ${record.stateId} 的 result=${record.result} 与全精度比值 ${record.ratio} / 阈值 ${record.threshold} 不一致（比较不得先四舍五入）`,
        );
      }
    }
  }
  const failures = records.filter((record) => record.result === "fail");
  const unmeasured = records.filter((record) => record.result === "unmeasured");
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    candidateId: records[0]?.candidateId ?? "assess-draft",
    candidateHash: "0".repeat(64),
    fast: records,
    browser: [],
    visual: { reviewed: false, verdict: null, notes: "" },
    // 信封只校验记录本身：有失败记 rejected，其余一律 incomplete（视觉未评审）
    readiness: failures.length > 0 ? "rejected" : "incomplete",
    failures,
    unmeasured,
    diagnostics: {},
  };
  const result = validateAssessment(envelope);
  if (!result.valid) {
    const first = result.errors[0];
    throw new TypeError(`assessCandidate: 测量记录不合 M0 契约（${first.path} ${first.code}：${first.message}）`);
  }
}

/** M3.1 的 `{ entries, summary }` → M0 测量记录 + 被路由到浏览器的角色清单。 */
export function fastResultToRecords({ candidateId, mode, stateId = null, fastResult } = {}) {
  assertNonEmptyString(candidateId, "candidateId");
  if (!MODES.includes(mode)) {
    throw new TypeError(`assessCandidate: 非法 mode "${mode}"（fastResultToRecords）`);
  }
  if (stateId !== null && (typeof stateId !== "string" || !STATE_ID_SET.has(stateId))) {
    throw new TypeError(`assessCandidate: 未知 stateId "${stateId}"（fastResultToRecords，null 表示与状态无关）`);
  }
  assertPlainObject(fastResult, "fastResult");
  if (!Array.isArray(fastResult.entries)) {
    throw new TypeError("assessCandidate: fastResult.entries 必须是数组");
  }
  const records = [];
  const deferred = [];
  for (const entry of fastResult.entries) {
    assertPlainObject(entry, "fastResult.entries[]");
    assertNonEmptyString(entry.roleId, "fastResult.entries[].roleId");
    if (!ROLE_BY_ID.has(entry.roleId)) {
      throw new TypeError(`assessCandidate: 未知角色 "${entry.roleId}"（不在 M0 角色目录）`);
    }
    const approximate = entry.approximate === true;
    const base = {
      candidateId,
      mode,
      roleId: entry.roleId,
      stateId,
      threshold: typeof entry.threshold === "number" && Number.isFinite(entry.threshold) ? entry.threshold : null,
      method: approximate ? `${entry.method}${APPROXIMATE_METHOD_SUFFIX}` : entry.method,
      evidence: JSON.stringify({
        kind: "fast",
        status: entry.status,
        method: entry.method,
        methodDetail: entry.methodDetail ?? null,
        approximate,
        effectiveForeground: entry.effectiveForeground ?? null,
        effectiveBackground: entry.effectiveBackground ?? null,
        foregroundTokens: entry.foregroundTokens ?? [],
        backgroundTokens: entry.backgroundTokens ?? [],
        worstSample: entry.worstSample ?? null,
        sourceRefs: entry.sourceRefs ?? [],
      }),
    };
    if (entry.status === "browser-required") {
      // 路由信息不是证据：留着告诉读者"这一项等浏览器实测"，缺项由覆盖检查记账
      deferred.push({ mode, roleId: entry.roleId, methodDetail: entry.methodDetail ?? null });
    } else if (entry.status === "pass" || entry.status === "fail") {
      records.push({
        ...base,
        result: entry.status,
        ratio: entry.ratio,
        reason: approximate
          ? `快速近似值 ${entry.ratio}（${entry.methodDetail ?? entry.method}），最终需浏览器确认`
          : "",
      });
    } else if (entry.status === "unmeasured") {
      // 阈值-less 角色（装饰/字标/图形例外）本来就无可读比值：M3.1 报 unmeasured 是
      // "这一项不读数"，不是"没测到"。照搬进机器桶会把合法例外变成永久缺测、堵死 ready，
      // 因此按角色目录转成带理由的 not-applicable；真正缺测（有阈值却测不到）保持 unmeasured。
      const role = ROLE_BY_ID.get(entry.roleId);
      const detail =
        typeof entry.methodDetail === "string" && entry.methodDetail.trim().length > 0
          ? entry.methodDetail.trim()
          : entry.method;
      if (role?.kind !== undefined && role.threshold === null) {
        records.push({
          ...base,
          result: "not-applicable",
          ratio: null,
          reason:
            `${role.kind} 角色无阅读阈值（${detail}），按例外记账；` +
            `视觉结论只认 visual-review 的对应项，不计入正文 PASS。`,
        });
      } else {
        records.push({ ...base, result: "unmeasured", ratio: null, reason: entry.methodDetail ?? "" });
      }
    } else {
      throw new TypeError(`assessCandidate: 未知 fast 状态 "${entry.status}"（角色 ${entry.roleId}）`);
    }
  }
  return { records, deferred };
}

function normalizeFastChecks(fastChecks, candidate) {
  if (fastChecks === undefined || fastChecks === null) return { records: [], deferred: [] };
  if (Array.isArray(fastChecks)) return { records: fastChecks, deferred: [] };
  assertPlainObject(fastChecks, "fastChecks");
  const records = [];
  const deferred = [];
  for (const mode of MODES) {
    const modeResult = fastChecks[mode];
    if (modeResult === undefined || modeResult === null) continue;
    const adapted = fastResultToRecords({
      candidateId: candidate.id,
      mode,
      stateId: fastChecks.stateId ?? null,
      fastResult: modeResult,
    });
    records.push(...adapted.records);
    deferred.push(...adapted.deferred);
  }
  return { records, deferred };
}

function normalizeBrowserChecks(browserChecks) {
  if (browserChecks === undefined || browserChecks === null) return [];
  if (Array.isArray(browserChecks)) {
    const records = [];
    for (const item of browserChecks) {
      if (item && typeof item === "object" && Array.isArray(item.records)) records.push(...item.records);
      else records.push(item);
    }
    return records;
  }
  assertPlainObject(browserChecks, "browserChecks");
  if (Array.isArray(browserChecks.records)) return [...browserChecks.records];
  throw new TypeError("assessCandidate: browserChecks 必须是记录数组或含 records 的 M3.2 返回值");
}

function normalizeVisualReview(visualReview) {
  const pending = {
    provided: false,
    reviewer: null,
    by: null,
    verdict: "pending",
    items: [],
    screenshots: [],
    notes: "未提供视觉初筛记录",
    supplement: [],
    reviewedAt: null,
  };
  if (visualReview === undefined || visualReview === null) return pending;
  assertPlainObject(visualReview, "visualReview");
  assertNonEmptyString(visualReview.reviewer, "visualReview.reviewer");
  if (!VISUAL_BY.includes(visualReview.by)) {
    throw new TypeError(
      `assessCandidate: visualReview.by 必须是 ${VISUAL_BY.join(" / ")}（用户选择与代理初筛必须可分辨）`,
    );
  }
  if (!VISUAL_VERDICTS.includes(visualReview.verdict)) {
    throw new TypeError(`assessCandidate: visualReview.verdict 必须是 ${VISUAL_VERDICTS.join(" / ")}`);
  }
  if (typeof visualReview.notes !== "string") {
    throw new TypeError("assessCandidate: visualReview.notes 必须是字符串");
  }
  if (!Array.isArray(visualReview.items)) {
    throw new TypeError("assessCandidate: visualReview.items 必须是数组（八个必填项）");
  }
  const items = [];
  const seen = new Set();
  for (const item of visualReview.items) {
    assertPlainObject(item, "visualReview.items[]");
    assertNonEmptyString(item.id, "visualReview.items[].id");
    if (!VISUAL_REVIEW_ITEMS.some((known) => known.id === item.id)) {
      throw new TypeError(`assessCandidate: 未知视觉项 "${item.id}"`);
    }
    if (seen.has(item.id)) {
      throw new TypeError(`assessCandidate: 视觉项重复 "${item.id}"`);
    }
    seen.add(item.id);
    if (!VISUAL_VERDICTS.includes(item.verdict)) {
      throw new TypeError(`assessCandidate: 视觉项 ${item.id} 的 verdict 必须是 ${VISUAL_VERDICTS.join(" / ")}`);
    }
    if (typeof item.notes !== "string" || item.notes.trim().length === 0) {
      throw new TypeError(`assessCandidate: 视觉项 ${item.id} 必须写意见（notes 不允许空）`);
    }
    if (!Array.isArray(item.screenshots)) {
      throw new TypeError(`assessCandidate: 视觉项 ${item.id} 的 screenshots 必须是数组`);
    }
    for (const screenshot of item.screenshots) assertNonEmptyString(screenshot, `视觉项 ${item.id} 的截图路径`);
    if (item.verdict !== "pending" && item.screenshots.length === 0) {
      // 卡面：评审者必须实际查看原尺寸图片——accept/reject 不能不附截图
      throw new TypeError(`assessCandidate: 视觉项 ${item.id} 判 ${item.verdict} 必须记录截图路径`);
    }
    items.push({ id: item.id, outcome: item.verdict, notes: item.notes, screenshots: [...item.screenshots] });
  }
  for (const known of VISUAL_REVIEW_ITEMS) {
    if (!seen.has(known.id)) {
      throw new TypeError(`assessCandidate: visual-review 缺少必填项 "${known.id}"（${known.label}）`);
    }
  }
  const derived = items.some((item) => item.outcome === "reject")
    ? "reject"
    : items.every((item) => item.outcome === "accept")
      ? "accept"
      : "pending";
  if (visualReview.verdict !== derived) {
    throw new TypeError(
      `assessCandidate: visualReview.verdict（${visualReview.verdict}）与八项聚合结果（${derived}）不一致`,
    );
  }
  if (visualReview.reviewedAt !== undefined && visualReview.reviewedAt !== null) {
    assertNonEmptyString(visualReview.reviewedAt, "visualReview.reviewedAt");
  }
  return {
    provided: true,
    reviewer: visualReview.reviewer,
    by: visualReview.by,
    verdict: derived,
    items,
    screenshots: Array.isArray(visualReview.screenshots) ? [...visualReview.screenshots] : [],
    notes: visualReview.notes,
    supplement: normalizeSupplement(visualReview.supplement),
    reviewedAt: visualReview.reviewedAt ?? null,
  };
}

function normalizeSupplement(supplement) {
  if (supplement === undefined || supplement === null) return [];
  if (!Array.isArray(supplement)) {
    throw new TypeError("assessCandidate: visualReview.supplement 必须是数组");
  }
  return supplement.map((entry, index) => {
    assertPlainObject(entry, `visualReview.supplement[${index}]`);
    for (const field of SUPPLEMENT_FIELDS) {
      if (!(field in entry)) {
        throw new TypeError(
          `assessCandidate: 手工补测 supplement[${index}] 缺少 ${field}（必须注明角色、状态、取样位置、前景/背景数值、计算方法和证据）`,
        );
      }
    }
    assertNonEmptyString(entry.roleId, `supplement[${index}].roleId`);
    if (!ROLE_BY_ID.has(entry.roleId)) {
      throw new TypeError(`assessCandidate: supplement[${index}].roleId 不在 M0 角色目录（${entry.roleId}）`);
    }
    if (entry.stateId !== null && (typeof entry.stateId !== "string" || !STATE_ID_SET.has(entry.stateId))) {
      throw new TypeError(`assessCandidate: supplement[${index}].stateId 必须是已知状态或 null`);
    }
    for (const field of ["position", "foreground", "background", "method", "evidence"]) {
      if (typeof entry[field] !== "string" || entry[field].trim().length === 0) {
        throw new TypeError(`assessCandidate: supplement[${index}].${field} 必须是非空字符串（空白不算注明）`);
      }
    }
    if (entry.ratio !== undefined && entry.ratio !== null) {
      if (typeof entry.ratio !== "number" || !Number.isFinite(entry.ratio)) {
        throw new TypeError(`assessCandidate: supplement[${index}].ratio 必须是有限数（定性意见不得冒充数值）`);
      }
    }
    return {
      roleId: entry.roleId,
      stateId: entry.stateId ?? null,
      position: entry.position,
      foreground: entry.foreground,
      background: entry.background,
      method: entry.method,
      evidence: entry.evidence,
      ratio: entry.ratio ?? null,
      threshold: typeof entry.threshold === "number" ? entry.threshold : null,
    };
  });
}

function normalizeRun(run, candidate) {
  assertPlainObject(run, "run");
  const policy = run.policy;
  const policyCheck = validatePolicy(policy);
  if (!policyCheck.valid) {
    const first = policyCheck.errors[0];
    throw new TypeError(`assessCandidate: run.policy 未过 M0 契约（${first.path} ${first.code}：${first.message}）`);
  }
  assertPlainObject(run.inputHashes, "run.inputHashes");
  for (const field of ["profiles", "policy", "roles", "derivation"]) {
    if (!isSha256(run.inputHashes[field])) {
      throw new TypeError(`assessCandidate: run.inputHashes.${field} 必须是 64 位小写 hex`);
    }
  }
  const normalizeHashMap = (value, name) => {
    if (value === undefined || value === null) return null;
    assertPlainObject(value, name);
    const map = {};
    for (const [key, digest] of Object.entries(value)) {
      if (!isSha256(digest)) {
        throw new TypeError(`assessCandidate: ${name}.${key} 必须是 64 位小写 hex`);
      }
      map[key] = digest;
    }
    return map;
  };
  const normalizeFixture = (value, name) => {
    if (value === undefined || value === null) return null;
    assertPlainObject(value, name);
    if (!Number.isInteger(value.version) || value.version < 1) {
      throw new TypeError(`assessCandidate: ${name}.version 必须是正整数`);
    }
    return { version: value.version, note: typeof value.note === "string" ? value.note : "" };
  };
  const candidateSet =
    run.candidateSet === undefined || run.candidateSet === null
      ? null
      : assertPlainObject(run.candidateSet, "run.candidateSet");
  if (run.candidateSetHash !== undefined && run.candidateSetHash !== null) {
    if (!isSha256(run.candidateSetHash)) {
      throw new TypeError("assessCandidate: run.candidateSetHash 必须是 64 位小写 hex");
    }
    if (candidateSet && hashCandidateSet(candidateSet) !== run.candidateSetHash) {
      throw new TypeError("assessCandidate: run.candidateSetHash 与 run.candidateSet 摘要不一致");
    }
  }
  return {
    policy,
    policyHash: sha256Canonical(policy),
    inputHashes: { ...run.inputHashes },
    recordedInputHashes: normalizeHashMap(run.recordedInputHashes, "run.recordedInputHashes"),
    sourceHashes: normalizeHashMap(run.sourceHashes, "run.sourceHashes"),
    recordedSourceHashes: normalizeHashMap(run.recordedSourceHashes, "run.recordedSourceHashes"),
    fixture: normalizeFixture(run.fixture, "run.fixture"),
    recordedFixture: normalizeFixture(run.recordedFixture, "run.recordedFixture"),
    candidateSet,
    candidateSetHash: run.candidateSetHash ?? null,
    candidateId: candidate.id,
  };
}

/**
 * 出处核验的"缺件"清单：空对象、缺字段都不算已核验。
 * 每条都让 readiness 退回 incomplete——缺件时无法证明证据属于当前版本，而不是"看起来没问题"。
 */
function collectMissingProvenance(run) {
  const missing = [];
  if (!run.candidateSet) missing.push("candidateSet（未提供证据所属总集，无法核对配方摘要）");
  if (run.recordedInputHashes === null) {
    missing.push("recordedInputHashes（未提供证据产出时的输入摘要）");
  } else {
    const absent = RECORDED_INPUT_FIELDS.filter((field) => typeof run.recordedInputHashes?.[field] !== "string");
    if (absent.length > 0) {
      missing.push(`recordedInputHashes（缺 ${absent.join(" / ")}，空对象不算已核验）`);
    }
  }
  const sourceLabels = {
    sourceHashes: "当前源文件摘要",
    recordedSourceHashes: "证据产出时的源文件摘要",
  };
  for (const field of ["sourceHashes", "recordedSourceHashes"]) {
    const map = run[field];
    if (map === null) {
      missing.push(`${field}（未提供${sourceLabels[field]}）`);
      continue;
    }
    const absent = REQUIRED_SOURCE_FILES.filter((file) => typeof map[file] !== "string");
    if (absent.length > 0) {
      missing.push(`${field}（缺 ${absent.join(" / ")} 的摘要，${sourceLabels[field]}必须覆盖门禁依赖的全部文件）`);
    }
  }
  if (run.fixture === null) missing.push("fixture（未提供 fixture 版本，无法核对测试夹具版本）");
  if (run.recordedFixture === null)
    missing.push("recordedFixture（未提供证据产出时的 fixture 版本，无法证明夹具版本未变）");
  return missing;
}

/** 证据过期检查：返回 stale 列表；空数组 = 出处与当前一致。 */
function collectStaleEvidence(run, candidate) {
  const stale = [];
  const push = (object, detail) => stale.push({ object, detail });
  if (candidate.policyHash !== run.policyHash) {
    push("policy", `候选按 policy 摘要 ${candidate.policyHash} 求解，当前为 ${run.policyHash}`);
  }
  if (run.inputHashes.policy !== run.policyHash) {
    push("policy", `run.inputHashes.policy（${run.inputHashes.policy}）与 run.policy 摘要不一致`);
  }
  if (candidate.derivationHash !== run.inputHashes.derivation) {
    push("derivation", `候选 derivationHash ${candidate.derivationHash}，当前 ${run.inputHashes.derivation}`);
  }
  if (run.inputHashes.roles !== hashRoleInputs()) {
    push(
      "roles",
      `run.inputHashes.roles（${run.inputHashes.roles}）与当前角色清单摘要 ${hashRoleInputs()} 不一致（清单已变更，旧评审失效）`,
    );
  }
  if (run.recordedInputHashes) {
    for (const field of ["profiles", "policy", "roles", "derivation"]) {
      const recorded = run.recordedInputHashes[field];
      if (recorded === undefined) continue;
      if (recorded !== run.inputHashes[field]) {
        push(field, `证据产出时 ${field} 摘要 ${recorded}，当前 ${run.inputHashes[field]}`);
      }
    }
  }
  if (run.recordedSourceHashes) {
    const current = run.sourceHashes ?? {};
    for (const [file, digest] of Object.entries(run.recordedSourceHashes)) {
      if (current[file] === undefined) {
        push("sources", `证据产出时记录了 ${file}，当前未提供该文件摘要`);
      } else if (current[file] !== digest) {
        push("sources", `${file} 摘要由 ${digest} 变为 ${current[file]}`);
      }
    }
    for (const file of Object.keys(current)) {
      if (run.recordedSourceHashes[file] === undefined) {
        push("sources", `当前存在 ${file}，证据产出时未记录（无法证明证据来自该版本）`);
      }
    }
  }
  if (run.recordedFixture && run.fixture && run.recordedFixture.version !== run.fixture.version) {
    push("fixture", `证据产出时 fixture 版本 ${run.recordedFixture.version}，当前 ${run.fixture.version}`);
  }
  if (run.fixture && run.fixture.version !== run.policy.versions.fixture) {
    push(
      "fixture",
      `fixture 版本 ${run.fixture.version} 与 policy.versions.fixture（${run.policy.versions.fixture}）不一致`,
    );
  }
  if (run.candidateSet) {
    const setInputHashes = run.candidateSet.inputHashes;
    if (setInputHashes && typeof setInputHashes === "object") {
      for (const field of ["profiles", "policy", "roles", "derivation"]) {
        const digest = setInputHashes[field];
        if (typeof digest !== "string") continue;
        if (digest !== run.inputHashes[field]) {
          push(field, `证据所属总集的 ${field} 摘要 ${digest}，当前 ${run.inputHashes[field]}`);
        }
      }
    }
    const candidates = Array.isArray(run.candidateSet.candidates) ? run.candidateSet.candidates : [];
    const match = candidates.find((entry) => entry && entry.id === candidate.id);
    if (!match) {
      push("candidateSet", `候选 ${candidate.id} 不在证据所属总集中`);
    } else if (canonicalJson(match) !== canonicalJson(candidate)) {
      push("candidateSet", `候选 ${candidate.id} 与总集条目不一致（token 或哈希已被改动）`);
    }
  }
  return stale;
}

const groupKeyOf = (mode, roleId, stateId) => `${mode}|${roleId}|${stateId ?? "-"}`;

const byRatioAsc = (left, right) => {
  const leftRatio = typeof left.ratio === "number" ? left.ratio : Number.POSITIVE_INFINITY;
  const rightRatio = typeof right.ratio === "number" ? right.ratio : Number.POSITIVE_INFINITY;
  if (leftRatio !== rightRatio) return leftRatio - rightRatio;
  return 0;
};

/** 同一 (mode, roleId, stateId) 的多条记录合成一条判读：失败优先，其次取最差比值。 */
function mergeGroup(records) {
  const fails = records.filter((record) => record.result === "fail").sort(byRatioAsc);
  if (fails.length > 0) return { result: "fail", record: fails[0], records };
  const passes = records.filter((record) => record.result === "pass").sort(byRatioAsc);
  if (passes.length > 0) return { result: "pass", record: passes[0], records };
  if (records.some((record) => record.result === "unmeasured")) {
    return { result: "unmeasured", record: records.find((record) => record.result === "unmeasured"), records };
  }
  if (records.some((record) => record.result === "not-applicable")) {
    return {
      result: "not-applicable",
      record: records.find((record) => record.result === "not-applicable"),
      records,
    };
  }
  return { result: "none", record: null, records };
}

const isApproximate = (record) =>
  typeof record.method === "string" && record.method.endsWith(APPROXIMATE_METHOD_SUFFIX);
/** 近似记录只是数据；判读只用非近似记录，近似永远进不了结论。 */
const verdictRecordsOf = (group) => group.records.filter((record) => !isApproximate(record));
const verdictOf = (group) => {
  const records = verdictRecordsOf(group);
  if (records.some((record) => record.result === "fail")) return "fail";
  if (records.some((record) => record.result === "pass")) return "pass";
  return null;
};
/**
 * 覆盖与合并：逐个 (mode, role, state) 找有效证据。
 * 带 stateId 的记录只覆盖自己的状态；stateId 为 null 的记录覆盖该模式全部状态（含近似记录，
 * 但近似不产判读）。
 */
function resolveCoverage(records) {
  const groups = new Map();
  for (const record of records) {
    const key = groupKeyOf(record.mode, record.roleId, record.stateId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const merged = new Map();
  for (const [key, groupRecords] of groups) {
    merged.set(key, mergeGroup(groupRecords));
  }

  const pairs = [];
  const gaps = [];
  const provisional = [];
  const uncoveredDecorative = [];
  for (const mode of MODES) {
    for (const role of ROLE_CATALOG) {
      for (const stateId of role.states) {
        const exact = merged.get(groupKeyOf(mode, role.id, stateId)) ?? null;
        const stateFree = merged.get(groupKeyOf(mode, role.id, null)) ?? null;
        // 候选证据 = 本状态的记录 + 与本状态无关（stateId 为 null）的记录，两组都可能覆盖此单元
        const candidates = [];
        if (exact !== null) candidates.push(exact);
        if (stateFree !== null && stateFree !== exact) candidates.push(stateFree);
        // 判读只用非近似记录；只剩近似 pass/fail 的进 approximateOnly，只作数据不作结论
        const usable = candidates.filter((group) => verdictOf(group) !== null);
        const approximateOnly = candidates.filter(
          (group) => verdictOf(group) === null && (group.result === "pass" || group.result === "fail"),
        );
        // not-applicable / unmeasured 判读取本状态那组，缺省才退回与本状态无关那组
        const advisory = exact ?? stateFree;
        const entry = {
          mode,
          roleId: role.id,
          stateId,
          required: role.required === true,
          threshold: typeof role.threshold === "number" ? role.threshold : null,
          exact,
          stateFree,
          covering: usable,
        };
        if (usable.length > 0) {
          const judged = usable.map((group) => ({ group, verdict: verdictOf(group) }));
          entry.verdict = judged.some((item) => item.verdict === "fail") ? "fail" : "pass";
          const wanted = entry.verdict === "fail" ? "fail" : "pass";
          entry.worst = judged
            .filter((item) => item.verdict === wanted)
            .flatMap((item) => verdictRecordsOf(item.group))
            .filter((record) => record.result === wanted)
            .sort(byRatioAsc)[0];
          entry.methods = judged.flatMap((item) => verdictRecordsOf(item.group).map((record) => record.method));
        } else if (approximateOnly.length > 0) {
          // 只有 approximate 证据：留数据，但"最终需浏览器确认"，不单独 ready
          entry.verdict = "provisional";
          entry.worst = approximateOnly.map((group) => group.record).sort(byRatioAsc)[0];
          entry.methods = approximateOnly.flatMap((group) => group.records.map((record) => record.method));
          provisional.push({
            mode,
            roleId: role.id,
            stateId,
            ratio: entry.worst?.ratio ?? null,
            threshold: entry.threshold,
            reason: "快速近似值待浏览器确认（linear-gradient 中间样本不是最终结论）",
          });
        } else if (advisory !== null && advisory.result === "not-applicable") {
          const reason = typeof advisory.record?.reason === "string" ? advisory.record.reason.trim() : "";
          if (reason.length === 0) {
            entry.verdict = "illegal-exception";
            gaps.push({
              mode,
              roleId: role.id,
              stateId,
              reason: "例外（not-applicable）缺理由（卡面：例外必须注明为什么不适用）",
            });
          } else if (role.required === true) {
            entry.verdict = "illegal-exception";
            gaps.push({ mode, roleId: role.id, stateId, reason: "必要角色不得以 not-applicable 免责" });
          } else {
            entry.verdict = "not-applicable";
            entry.worst = advisory.record;
            entry.methods = advisory.records.map((record) => record.method);
          }
        } else if (advisory !== null && advisory.result === "unmeasured") {
          entry.verdict = "unmeasured";
          entry.worst = advisory.record;
          entry.methods = advisory.records.map((record) => record.method);
          if (role.required === true) {
            gaps.push({
              mode,
              roleId: role.id,
              stateId,
              reason: advisory.record?.reason ? `缺测：${advisory.record.reason}` : "缺测：无有效证据",
            });
          } else {
            uncoveredDecorative.push({ mode, roleId: role.id, stateId, reason: advisory.record?.reason ?? "缺测" });
          }
        } else {
          entry.verdict = "missing";
          if (role.required === true) {
            gaps.push({ mode, roleId: role.id, stateId, reason: "没有任何测量记录（缺证据，不按通过处理）" });
          } else {
            uncoveredDecorative.push({ mode, roleId: role.id, stateId, reason: "没有任何测量记录" });
          }
        }
        pairs.push(entry);
      }
    }
  }
  return { pairs, gaps, provisional, uncoveredDecorative };
}

/** 逐条读数：比值、阈值、余量、7:1 优选是否达到。阈值一律取自角色目录，不重写。 */
function buildReading(pairs, policy) {
  // 主文字（kind=text）才有 7:1 优选；图形/装饰只按自身阈值判，不套优选值
  const preferredOf = (roleId) => {
    const role = ROLE_BY_ID.get(roleId);
    if (role?.kind !== "text") return null;
    return policy.readability.primaryTextPreferred;
  };
  const entries = [];
  for (const pair of pairs) {
    if (pair.verdict !== "pass" && pair.verdict !== "fail") continue;
    const record = pair.worst;
    if (!record || typeof record.ratio !== "number") continue;
    const preferred = preferredOf(pair.roleId);
    entries.push({
      mode: pair.mode,
      roleId: pair.roleId,
      stateId: pair.stateId,
      ratio: record.ratio,
      threshold: pair.threshold,
      result: pair.verdict,
      headroom: record.ratio / (pair.threshold ?? 1),
      preferred,
      preferredHeadroom: preferred === null ? null : record.ratio / preferred,
      preferredMet: preferred === null ? null : record.ratio >= preferred,
      worstSample: record.method,
    });
  }
  const worst = entries.reduce((best, entry) => (best === null || entry.headroom < best.headroom ? entry : best), null);
  return {
    bodyTextMin: policy.readability.bodyTextMin,
    primaryTextPreferred: policy.readability.primaryTextPreferred,
    necessaryGraphicMin: policy.readability.necessaryGraphicMin,
    entries,
    worst,
    preferredShortfalls: entries.filter((entry) => entry.preferredMet === false),
    note: "余量 = ratio / threshold；主文字优选 7:1 未达到但仍达 4.5 的可 ready，此处逐条显示差距。阈值不被改写成 3。",
  };
}

function buildMethodDifferences(pairs) {
  const byRole = new Map();
  for (const pair of pairs) {
    const key = `${pair.mode}|${pair.roleId}`;
    if (!byRole.has(key)) byRole.set(key, []);
    byRole.get(key).push(pair);
  }
  const differences = [];
  for (const list of byRole.values()) {
    const methods = new Set();
    const samples = [];
    for (const pair of list) {
      for (const record of pair.exact?.records ?? []) {
        methods.add(record.method);
        samples.push({ stateId: pair.stateId, method: record.method, result: record.result, ratio: record.ratio });
      }
      for (const record of pair.stateFree?.records ?? []) {
        if (pair.stateFree === pair.exact) continue;
        methods.add(record.method);
        samples.push({ stateId: null, method: record.method, result: record.result, ratio: record.ratio });
      }
    }
    if (methods.size > 1)
      differences.push({ mode: list[0].mode, roleId: list[0].roleId, methods: [...methods], samples });
  }
  return differences;
}

function findDuplicates(records) {
  const seen = new Map();
  const duplicates = [];
  for (const record of records) {
    const key = canonicalJson(record);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0)
      duplicates.push({
        mode: record.mode,
        roleId: record.roleId,
        stateId: record.stateId,
        method: record.method,
        times: count + 1,
      });
  }
  return duplicates;
}

/**
 * M3.4 门禁：把候选与已有证据汇总成 M0 Assessment。
 * 只汇总、不生成：缺项保持缺项，超期证据记 STALE_EVIDENCE，视觉初筛绝不自动接受。
 */
export function assessCandidate({ candidate, fastChecks, browserChecks, visualReview, run } = {}) {
  // ---- 1. 输入形状与自校验 ----
  assertPlainObject(candidate, "candidate");
  const candidateCheck = validateCandidate(candidate);
  if (!candidateCheck.valid) {
    const first = candidateCheck.errors[0];
    throw new TypeError(
      `assessCandidate: 候选不合 M0 契约（candidates.${first.path} ${first.code}：${first.message}）`,
    );
  }
  const normalizedRun = normalizeRun(run, candidate);
  const normalizedVisual = normalizeVisualReview(visualReview);
  const fast = normalizeFastChecks(fastChecks, candidate);
  const browserRecords = normalizeBrowserChecks(browserChecks);

  // 浏览器记录必须带状态锚点：stateId 为 null 的实测无法证明"各状态都测过"
  // （M3.2 的 null 模式是把整份角色目录在页面当前状态下量一遍，是诊断便道，不是逐状态证据）。
  // 这类记录照常记账、照常参与失败/重复判定，但不进覆盖网格。
  const unanchoredBrowser = browserRecords.filter((record) => record.stateId === null);
  const anchoredBrowser = browserRecords.filter((record) => record.stateId !== null);
  const allRecords = [...fast.records, ...browserRecords];
  for (const record of allRecords) {
    if (record.candidateId !== candidate.id) {
      throw new TypeError(
        `assessCandidate: 记录 candidateId（${record.candidateId}）与候选（${candidate.id}）不一致，不能混入别人的证据`,
      );
    }
  }
  assertRecordsConform(allRecords);

  // ---- 2. 证据出处（缺核验信息、过期都算 incomplete；过期注明 STALE_EVIDENCE）----
  const stale = collectStaleEvidence(normalizedRun, candidate);
  // 出处不齐就证明不了"证据属于当前版本"：ready 前必须把这些对象补齐，不是留个字样。
  // 空对象/缺字段同样算缺件——"给个 {}"不等于"核验过"。
  const unverified = collectMissingProvenance(normalizedRun);

  // ---- 3. 覆盖、合并与读数（只有带锚点的记录参与覆盖）----
  const { pairs, gaps, provisional, uncoveredDecorative } = resolveCoverage([...fast.records, ...anchoredBrowser]);
  const reading = buildReading(pairs, normalizedRun.policy);
  // failures = 全部有效失败记录（含无状态锚点的）：锚点决定"能不能证明覆盖"，
  // 不决定"这条失败算不算数"。M0 契约按"任何 fail 记录"要求 rejected；
  // method 尾缀 ":approximate" 可分辨来源，blockers 里单独说明是哪一种失败。
  const failureRecords = allRecords
    .filter((record) => record.result === "fail")
    .filter((record, index, all) => all.findIndex((other) => canonicalJson(other) === canonicalJson(record)) === index);
  const measuredFailures = failureRecords.filter((record) => !isApproximate(record));
  const approximateFailures = failureRecords.filter((record) => isApproximate(record));
  const unmeasuredRecords = allRecords.filter((record) => record.result === "unmeasured");
  const duplicates = findDuplicates(allRecords);
  const methodDifferences = buildMethodDifferences(pairs);

  // ---- 4. readiness（失败优先；缺测/未评审/过期一律 incomplete）----
  const visualVerdict =
    normalizedVisual.verdict === "accept" ? "pass" : normalizedVisual.verdict === "reject" ? "fail" : null;
  const visual = {
    reviewed: normalizedVisual.provided && normalizedVisual.verdict !== "pending",
    verdict: visualVerdict,
    notes: normalizedVisual.notes,
  };
  const blockers = [];
  if (measuredFailures.length > 0) blockers.push(`${measuredFailures.length} 条角色失败（浏览器实测或确定性快读）`);
  if (approximateFailures.length > 0) {
    blockers.push(
      `${approximateFailures.length} 条快速近似失败（linear-gradient 中间样本，待浏览器确认，先按失败挡下）`,
    );
  }
  if (visual.verdict === "fail") blockers.push("视觉初筛拒绝");
  for (const gap of gaps) blockers.push(`缺证据：${gap.mode} ${gap.roleId} @ ${gap.stateId}（${gap.reason}）`);
  for (const item of provisional) blockers.push(`待浏览器确认：${item.mode} ${item.roleId} @ ${item.stateId}`);
  for (const item of stale) blockers.push(`STALE_EVIDENCE：${item.object} ${item.detail}`);
  for (const item of unverified) blockers.push(`无法核验：${item}`);
  if (unanchoredBrowser.length > 0) {
    blockers.push(
      `${unanchoredBrowser.length} 条浏览器记录没有状态锚点（stateId 为 null），不能证明各状态已实测，按缺证据处理`,
    );
  }
  if (unmeasuredRecords.length > 0)
    blockers.push(`${unmeasuredRecords.length} 条缺测记录（未测到的绘制/节点不按通过处理）`);
  if (!visual.reviewed) blockers.push("视觉初筛未完成（未提供记录或仍有 pending 项）");
  // 与 M0 契约同口径：有失败 → rejected；无失败但有缺口 → incomplete；二者皆无且初筛通过 → ready
  const readiness =
    failureRecords.length > 0 || visual.verdict === "fail"
      ? "rejected"
      : blockers.length === 0
        ? "ready"
        : "incomplete";

  // ---- 5. diagnostics：只挂数据，不挂判定 ----
  const identityCandidates = normalizedRun.candidateSet?.candidates ?? [candidate];
  const diagnosticsTree = diagnoseCandidates({ candidates: identityCandidates });
  for (const offenders of [
    assertDiagnosticsCarryNoVerdict({ material: diagnosticsTree.material, identity: diagnosticsTree.identity }),
  ]) {
    if (offenders.length > 0) {
      throw new TypeError(
        `assessCandidate: 诊断树出现判定键（${offenders.join(", ")}），材质/差异数据不得冒充阅读结论`,
      );
    }
  }
  const diagnostics = {
    gate: {
      machineOnly: true,
      blockers: [...blockers],
      failureCounts: { measured: measuredFailures.length, approximate: approximateFailures.length },
      note:
        "readiness=ready 只表示机器门禁（fast/browser）与代理视觉初筛通过；用户选择记录在 selections.json" +
        "（decisionSource），本评估不代填、也不以材质或差异距离抵消任何文字失败。" +
        "近似读数（method 尾缀 :approximate）不产通过结论，其失败同样挡下评审，待浏览器实测复核。",
    },
    coverage: {
      expectedPairs: pairs.length,
      requiredPairs: pairs.filter((pair) => pair.required).length,
      // 逐单元判读的直方图（数据），不是总分、也不是阅读结论
      verdictCounts: pairs.reduce((counts, pair) => {
        counts[pair.verdict] = (counts[pair.verdict] ?? 0) + 1;
        return counts;
      }, {}),
      gaps,
      provisional,
      uncoveredDecorative,
      fastDeferred: fast.deferred,
      // 无状态锚点的浏览器实测：记账但不进覆盖网格（否则"整份目录在当前状态量一遍"
      // 会被读成"每个状态都测过了"）
      unanchoredBrowser: unanchoredBrowser.map((record) => ({
        mode: record.mode,
        roleId: record.roleId,
        method: record.method,
        reason: typeof record.reason === "string" ? record.reason : "",
      })),
    },
    reading,
    methodDifferences,
    duplicates,
    exceptions: {
      notApplicable: pairs
        .filter((pair) => pair.verdict === "not-applicable")
        .map((pair) => ({ mode: pair.mode, roleId: pair.roleId, stateId: pair.stateId })),
      missingReason: gaps.filter((gap) => gap.reason.includes("缺理由")),
    },
    evidence: {
      stale,
      verified: ["candidate", "policy", "roles", "derivation"],
      unverified,
      inputHashes: normalizedRun.inputHashes,
      policyHash: normalizedRun.policyHash,
      candidateSetHash: normalizedRun.candidateSetHash,
      fixture: normalizedRun.fixture,
      recordedFixture: normalizedRun.recordedFixture,
    },
    visualReview: {
      provided: normalizedVisual.provided,
      reviewer: normalizedVisual.reviewer,
      by: normalizedVisual.by,
      items: normalizedVisual.items,
      screenshots: normalizedVisual.screenshots,
      reviewedAt: normalizedVisual.reviewedAt,
    },
    manualSupplement: normalizedVisual.supplement,
    material: diagnosticsTree.material,
    identity: diagnosticsTree.identity,
    identitySource: normalizedRun.candidateSet ? "run.candidateSet" : "single-candidate",
  };

  // 输出深冻前先把引用输入的记录复制出来：调用方传进来的失败/缺测记录不能被
  // 连带冻住（调用方可能还要复用同一批记录跑别的候选）。
  const assessment = deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    fast: deepFreeze(fast.records.map((record) => ({ ...record }))),
    browser: deepFreeze(browserRecords.map((record) => ({ ...record }))),
    visual,
    readiness,
    failures: deepFreeze(failureRecords.map((record) => ({ ...record }))),
    unmeasured: deepFreeze(unmeasuredRecords.map((record) => ({ ...record }))),
    diagnostics,
  });

  const finalCheck = validateAssessment(assessment);
  if (!finalCheck.valid) {
    const first = finalCheck.errors[0];
    throw new TypeError(
      `assessCandidate: 产出的 Assessment 未过 M0 自检（${first.path} ${first.code}：${first.message}）`,
    );
  }
  return assessment;
}

export default assessCandidate;

/**
 * M2.3 浅深配对、去重与可复现候选：配方 → 注册序 × a/b/c 的成对候选与失败记录。
 * 纯函数——不读 DOM、不取当前时间、不碰随机、不读写任何文件；全部外部内容经
 * 显式入参进入（含 derivationHash，见下）。M2.1 固定模板数学与 M2.2 有界求解
 * 之外，本模块不发明第二份颜色或角色逻辑。
 *
 * generateCandidates({ profiles, skinIds, seed, policy, roleCatalog, evaluatePalette, derivationHash })
 *
 * 与卡面的三处显式边界（详见 M2.3 交接）：
 *   1. evaluatePalette 为注入参数（M2.2 确立的边界；卡面签名成文早于该裁定）——
 *      M3.1 落地前由调用方注入人造/快速实现，M2.4 CLI 与 M5 批次传入真件。
 *   2. derivationHash 为显式入参（总计划 §4.1 要求候选摘要覆盖 public/skins.js
 *      的当前文件内容）：本模块保持纯函数不读任何文件，由调用方（M2.4 CLI）经
 *      contracts.collectSourceHashes 计算后传入；非 64 位小写 hex 即拒绝。
 *   3. 近重复去重用统一规则：同皮肤两候选的六样本（page/panel/accent × 浅深）D_OK
 *      全部 < 2.0（首版工具阈值）即去重，保留"阅读余量"更高者、并列按 a/b/c 先序。
 *      卡面"完全相同的 24 token 只保留排序最前"是其特例：token 全同 → 距离全 0 →
 *      必然命中本规则，且余量必相等 → 并列 → 保留先序者，与卡面语义一致。
 *
 * 输入不可变约定：profileSnapshot 经 canonicalJson 往返深拷贝（顺带拒绝非 JSON
 * 安全值），deepFreeze 只冻结拷贝，调用方配方对象（含嵌套字段）不被冻结、可继续修改。
 *
 * 阅读余量（首版口径）：最终 HEX 重查记录中必要且已判定（pass/fail）角色的
 * ratio/threshold 最小值，跨浅深两模式取最小；无可计角色为 null（去重比较时视为
 * 最低）。最终重查由 M2.2 runEvaluator 契约校验入口完成——与求解期同一份消费实现。
 *
 * 失败出口：求解失败逐模式记 UNSATISFIABLE / CONTRACT_CONFLICT /
 * SEARCH_BUDGET_EXCEEDED，角色证据取失败记录各来源（fixedRoles / failingRoles /
 * 无解与预算出口的 roleEvidence）按角色归并后的已观测最高比值——首轮换组从未
 * 走到轮末重查、预算耗尽中断同样留档失败角色与比值（总计划 §5）。
 * SEARCH_BUDGET_EXCEEDED 附的是耗尽前已观测的部分证据：预算耗尽即整组循环停止
 * （不以新预算尝试后续组），消息明示搜索未完成、不作最高可达论断；耗尽前无
 * 仍不满足角色时为 null。
 * 最终重查未复现求解期证据（确定性评估器下不可达，防有状态评估器的兜底）记
 * STALE_EVIDENCE；去重移除记 DUPLICATE_CANDIDATE（含关联 ID 与六项 D_OK 距离）。
 * 全部候选缺失（明确冲突输出）时 candidates 为空数组——M2.4 CLI 以退出码 2 表达，
 * 本模块不虚构候选兜底。
 *
 * 集合级自检用 validateCandidateSet(set, { expectedSkinIds: [] })：M0.3 的
 * "expectedSkinIds × a/b/c 全配对"完整性检查与 M2.3 去重/失败语义冲突（去重后
 * 每皮肤可 <3 个候选），该检查属 M0 契约文件、非本卡允许文件——M2 阶段跳过它并
 * 保留其余全部校验（顺序/唯一/哈希/角色清单一致性），冲突须由契约所有方修订。
 */

import {
  MODES,
  SKIN_IDS,
  VARIANTS,
  canonicalJson,
  hashCandidate,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
  validateCandidate,
  validateCandidateSet,
  validateFailureRecord,
} from "./contracts.mjs";
import { hexToSrgb, okDistance, srgbToOklab } from "./color-math.mjs";
import { SOLVE_STATUS, runEvaluator, solveModeForegrounds } from "./solver.mjs";
import { buildSurfaceTemplates } from "./templates.mjs";

/** derivationHash 摘要格式：SHA-256 hex（与 contracts 全部摘要字段同口径）。 */
const DERIVATION_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** 近重复阈值：六样本 D_OK 全部低于该值才判近重复。首版工具规则，非色差普适定理。 */
const NEAR_DUPLICATE_D_OK_LIMIT = 2.0;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`generateCandidates: ${name} 必须是非空字符串`);
  }
  return value;
}

/** 阅读余量：必要已判定角色的 ratio/threshold 最小值；无可计角色为 null。 */
function readingMarginOf(entries) {
  let margin = null;
  for (const entry of entries) {
    if (!entry.required) continue;
    if (entry.status !== "pass" && entry.status !== "fail") continue;
    if (typeof entry.threshold !== "number" || entry.threshold <= 0) continue;
    const headroom = entry.ratio / entry.threshold;
    if (margin === null || headroom < margin) margin = headroom;
  }
  return margin;
}

const SIX_SAMPLE_KEYS = Object.freeze([
  { mode: "light", token: "pageBackground" },
  { mode: "light", token: "panelBackground" },
  { mode: "light", token: "accent" },
  { mode: "dark", token: "pageBackground" },
  { mode: "dark", token: "panelBackground" },
  { mode: "dark", token: "accent" },
]);

function sixDistances(candidateA, candidateB) {
  return SIX_SAMPLE_KEYS.map(({ mode, token }) =>
    okDistance(
      srgbToOklab(hexToSrgb(candidateA.modes[mode][token])),
      srgbToOklab(hexToSrgb(candidateB.modes[mode][token])),
    ),
  );
}

function isNearDuplicate(candidateA, candidateB) {
  return sixDistances(candidateA, candidateB).every((distance) => distance < NEAR_DUPLICATE_D_OK_LIMIT);
}

/** 同皮肤去重：近似重复（含完全相同）保留阅读余量更高者，并列按生成先序。 */
function dedupeVariantItems(items) {
  const survivors = [];
  const duplicates = [];
  for (const item of items) {
    const current = item;
    for (;;) {
      let found = null;
      for (const kept of survivors) {
        if (canonicalJson(current.candidate.modes) === canonicalJson(kept.candidate.modes)) {
          found = { kept, distances: [0, 0, 0, 0, 0, 0] };
          break;
        }
        if (isNearDuplicate(current.candidate, kept.candidate)) {
          found = { kept, distances: sixDistances(current.candidate, kept.candidate) };
          break;
        }
      }
      if (!found) {
        survivors.push(current);
        break;
      }
      const currentBetter =
        current.margin !== null && (found.kept.margin === null || current.margin > found.kept.margin);
      if (!currentBetter) {
        duplicates.push(duplicateRecord(current, found.kept, found.distances));
        break;
      }
      survivors.splice(survivors.indexOf(found.kept), 1);
      duplicates.push(duplicateRecord(found.kept, current, found.distances));
    }
  }
  return { survivors, duplicates };
}

function duplicateRecord(removed, kept, distances) {
  const tied = removed.margin === kept.margin;
  return {
    code: "DUPLICATE_CANDIDATE",
    skinId: removed.candidate.skinId,
    pair: "light+dark",
    variant: removed.candidate.variant,
    roleIds: [],
    attemptedRanges: [],
    worstRatio: null,
    threshold: null,
    message:
      `近重复（nearDuplicate）：与 ${kept.candidate.id} 的六样本 D_OK 全部 < ${NEAR_DUPLICATE_D_OK_LIMIT}` +
      `（首版去重阈值）；保留阅读余量更高者${tied ? "，余量并列按 a/b/c 先序" : ""}`,
    relatedCandidateId: kept.candidate.id,
    distances,
  };
}

/**
 * 求解失败 → 逐模式 FailureRecord（两模式皆败产生两条，比成对合并更可追溯）。
 * 角色证据归并三个来源（fixedRoles 预检固定色 / failingRoles 轮末重查失败 /
 * roleEvidence 无解与预算出口的角色证据），按角色取搜索集内最高可达比值——首轮
 * 换组从未走到轮末重查、预算耗尽中断同样必须有失败角色与比值；worstRatio 取各
 * 角色最高中最差者（预算耗尽时 = 耗尽前已观测，非完整搜索集的最高可达，消息带
 * 限定）。
 */
function solveFailureRecord({ skinId, variant, mode, solve }) {
  const judged = [];
  for (const attempt of solve.attempts) {
    for (const role of attempt.fixedRoles ?? []) {
      judged.push({ roleId: role.roleId, ratio: role.ratio, threshold: role.threshold });
    }
    for (const role of attempt.failingRoles ?? []) {
      judged.push({ roleId: role.roleId, ratio: role.ratio, threshold: role.threshold });
    }
    for (const role of attempt.roleEvidence ?? []) {
      judged.push({ roleId: role.roleId, ratio: role.ratio, threshold: role.threshold });
    }
  }
  const bestByRole = new Map();
  for (const role of judged) {
    if (typeof role.ratio !== "number" || !Number.isFinite(role.ratio)) continue;
    const previous = bestByRole.get(role.roleId);
    if (!previous || role.ratio > previous.ratio) {
      bestByRole.set(role.roleId, { roleId: role.roleId, ratio: role.ratio, threshold: role.threshold });
    }
  }
  const merged = [...bestByRole.values()].sort((a, b) => (a.roleId < b.roleId ? -1 : a.roleId > b.roleId ? 1 : 0));
  const roleIds = merged.map((role) => role.roleId);
  let worstRatio = null;
  let threshold = null;
  for (const role of merged) {
    if (worstRatio === null || role.ratio < worstRatio) {
      worstRatio = role.ratio;
      threshold = role.threshold;
    }
  }
  const attemptedRanges = solve.attempts.map((attempt) => ({
    groupIndex: attempt.groupIndex,
    outcome: attempt.outcome,
    ...(attempt.round === undefined ? {} : { round: attempt.round }),
  }));
  const messages = {
    UNSATISFIABLE: `变体 ${variant} ${mode} 在本版允许的有限搜索集内未找到可行值（${solve.attempts.length} 个背景修正组均无解）；不伪称整个连续色域数学无解`,
    CONTRACT_CONFLICT: `变体 ${variant} ${mode} 固定色角色在全部修正组上都不可达（最高可达比值见 worstRatio）；不搜索与其无关的前景`,
    SEARCH_BUDGET_EXCEEDED: `变体 ${variant} ${mode} 搜索预算耗尽（不加轮数、不降门槛、不以新预算换组；耗尽即搜索未完成，已遇可行点也不得宣布成功）；角色与比值为耗尽前已观测证据，不作最高可达论断`,
  };
  return {
    code: solve.status,
    skinId,
    mode,
    variant,
    roleIds,
    attemptedRanges,
    worstRatio,
    threshold,
    message: messages[solve.status],
  };
}

function staleEvidenceRecord({ skinId, variant, mode, fails }) {
  const roleIds = fails.map((entry) => entry.roleId);
  let worstRatio = null;
  let threshold = null;
  for (const entry of fails) {
    if (worstRatio === null || entry.ratio < worstRatio) {
      worstRatio = entry.ratio;
      threshold = entry.threshold;
    }
  }
  return {
    code: "STALE_EVIDENCE",
    skinId,
    mode,
    variant,
    roleIds,
    attemptedRanges: [],
    worstRatio,
    threshold,
    message: `最终 HEX 重查未复现求解期证据（必要角色 ${roleIds.join("、")} 失败）；已知必要角色失败必须先修，不进入候选`,
  };
}

function modeParameters(item, variantTemplate, mode) {
  const { solve, entries } = item;
  const group = variantTemplate.modes[mode].corrections[solve.correctionGroupIndex];
  return {
    variant: {
      surfaceC: variantTemplate.surfaceC,
      surfaceCClamped: variantTemplate.surfaceCClamped,
      accentC: variantTemplate.accentC,
      pageLOffset: variantTemplate.pageLOffset[mode],
    },
    correctionGroupIndex: solve.correctionGroupIndex,
    pageL: group.pageL,
    requestedPageLOffset: group.requestedPageLOffset,
    pageLOffset: group.pageLOffset,
    offsetClamped: group.offsetClamped,
    lClamped: group.lClamped,
    gamut: group.gamut,
    foregroundSpecs: variantTemplate.modes[mode].foregrounds,
    solvedTokens: solve.solvedTokens,
    preferredContrastUnmet: solve.preferredContrastUnmet,
    roundsUsed: solve.roundsUsed,
    trialsByToken: solve.trials.byToken,
    unmeasuredRoles: solve.unmeasuredRoles,
    browserRequiredRoles: solve.browserRequiredRoles,
    finalUnmeasured: entries.filter((entry) => entry.status === "unmeasured").map((entry) => entry.roleId),
    finalBrowserRequired: entries.filter((entry) => entry.status === "browser-required").map((entry) => entry.roleId),
  };
}

const sumTrials = (solve) => Object.values(solve.trials.byToken).reduce((sum, used) => sum + used, 0);

function buildVariantItem({
  skinId,
  variant,
  profileSnapshot,
  variantTemplate,
  light,
  dark,
  seed,
  policy,
  derivationHash,
}) {
  const margin = [readingMarginOf(light.entries), readingMarginOf(dark.entries)].reduce(
    (best, value) => (value === null ? best : best === null ? value : Math.min(best, value)),
    null,
  );
  const profileStyle =
    profileSnapshot.style && typeof profileSnapshot.style === "object" ? profileSnapshot.style : null;
  const fallbackTitle = `${skinId} ${variantTemplate.label}`;
  const fallbackRationale =
    `变体 ${variant}（${variantTemplate.label}）：surfaceC ${variantTemplate.surfaceC}、accentC ${variantTemplate.accentC}、` +
    `pageL 偏移 light ${variantTemplate.pageLOffset.light} / dark ${variantTemplate.pageLOffset.dark}；` +
    `浅色用背景修正组 #${light.solve.correctionGroupIndex}、深色 #${dark.solve.correctionGroupIndex}。`;
  const base = {
    schemaVersion: 1,
    skinId,
    variant,
    profileVersion: 1,
    profileSnapshot,
    profileHash: sha256Canonical(profileSnapshot),
    policyHash: sha256Canonical(policy),
    derivationHash,
    seed,
    style: {
      title:
        profileStyle && typeof profileStyle.title === "string" && profileStyle.title
          ? profileStyle.title
          : fallbackTitle,
      rationale:
        profileStyle && typeof profileStyle.rationale === "string" && profileStyle.rationale
          ? profileStyle.rationale
          : fallbackRationale,
      identitySource: `${profileSnapshot.identityHex}`,
    },
    parameters: {
      light: modeParameters(light, variantTemplate, "light"),
      dark: modeParameters(dark, variantTemplate, "dark"),
      search: {
        budget: { ...policy.searchBudget },
        trials: { light: sumTrials(light.solve), dark: sumTrials(dark.solve) },
        preChecks: { light: light.solve.trials.preChecks, dark: dark.solve.trials.preChecks },
        roundChecks: { light: light.solve.trials.roundChecks, dark: dark.solve.trials.roundChecks },
        finalChecks: 2,
        readingMargin: margin,
      },
    },
    modes: { light: light.solve.tokens, dark: dark.solve.tokens },
  };
  const candidateHash = hashCandidate(base);
  const candidate = deepFreeze({
    ...base,
    id: `${skinId}-${variant}-${candidateHash.slice(0, 12)}`,
    candidateHash,
  });
  return { candidate, margin };
}

function selfValidate(candidateSet) {
  candidateSet.candidates.forEach((candidate, index) => {
    const verdict = validateCandidate(candidate);
    if (!verdict.valid) {
      const first = verdict.errors[0];
      throw new TypeError(
        `generateCandidates: 候选自检失败 candidates[${index}]（${first.path} ${first.code}）${first.message}`,
      );
    }
  });
  candidateSet.rejected.forEach((record, index) => {
    const verdict = validateFailureRecord(record);
    if (!verdict.valid) {
      const first = verdict.errors[0];
      throw new TypeError(
        `generateCandidates: 失败记录自检失败 rejected[${index}]（${first.path} ${first.code}）${first.message}`,
      );
    }
  });
  if (candidateSet.candidates.length === 0) return; // 全冲突输出：集合级校验要求的非空候选由 CLI 退出码 2 表达
  const verdict = validateCandidateSet(candidateSet, { expectedSkinIds: [] });
  if (!verdict.valid) {
    const first = verdict.errors[0];
    throw new TypeError(`generateCandidates: 候选集自检失败（${first.path} ${first.code}）${first.message}`);
  }
}

/**
 * 求解单个皮肤×变体的两个模式：两模式都完整（SOLVED 且最终重查无必要角色失败）
 * 才返回候选项；任一模式失败返回 null 并产出失败记录（写入 records）。
 */
function solveVariantPair({ skinId, variant, variantTemplate, records, state }) {
  const modes = {};
  const modeFailures = [];
  for (const mode of MODES) {
    const solve = solveModeForegrounds({
      skinId,
      mode,
      roleCatalog: state.roleCatalog,
      policy: state.policy,
      evaluatePalette: state.evaluatePalette,
      corrections: variantTemplate.modes[mode].corrections,
      foregrounds: variantTemplate.modes[mode].foregrounds,
    });
    if (solve.status !== SOLVE_STATUS.SOLVED) {
      modeFailures.push({ kind: "solve", mode, solve });
      continue;
    }
    const entries = runEvaluator(state.evaluatePalette, {
      skinId,
      mode,
      tokens: solve.tokens,
      roleCatalog: state.roleCatalog,
      policy: state.policy,
    });
    const fails = entries.filter((entry) => entry.required && entry.status === "fail");
    if (fails.length) {
      modeFailures.push({ kind: "stale", mode, fails });
      continue;
    }
    modes[mode] = { solve, entries };
  }
  if (modes.light === undefined || modes.dark === undefined) {
    for (const failure of modeFailures) {
      records.push(
        failure.kind === "stale"
          ? staleEvidenceRecord({ skinId, variant, mode: failure.mode, fails: failure.fails })
          : solveFailureRecord({ skinId, variant, mode: failure.mode, solve: failure.solve }),
      );
    }
    return null;
  }
  return { light: modes.light, dark: modes.dark };
}

/**
 * 生成成对候选：验证请求 ID 与配方 → 注册序 × a/b/c → 每变体浅深各求解、只有两
 * 模式完整才创建 Candidate → 最终 HEX 重查（快速检查）→ 同皮肤去重 → M0 摘要
 * 函数生成 id/hash → 自检 → 深冻结。同输入重复调用输出逐字相同。
 */
export function generateCandidates(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("generateCandidates: 需要 options 对象");
  }
  const { profiles, skinIds, seed, policy, roleCatalog, evaluatePalette, derivationHash } = options;
  if (typeof evaluatePalette !== "function") {
    throw new TypeError("generateCandidates: evaluatePalette 必须是函数（M3.1 evaluatePalette 或等价注入）");
  }
  if (roleCatalog === undefined || roleCatalog === null) {
    throw new TypeError("generateCandidates: roleCatalog 缺失");
  }
  assertNonEmptyString(seed, "seed");
  if (typeof derivationHash !== "string" || !DERIVATION_HASH_PATTERN.test(derivationHash)) {
    throw new TypeError(
      "generateCandidates: derivationHash 必须是 64 位小写 hex（public/skins.js 内容摘要，" +
        "由调用方经 contracts.collectSourceHashes 计算后显式传入）",
    );
  }
  if (!policy || typeof policy !== "object") {
    throw new TypeError("generateCandidates: policy 缺失");
  }
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new TypeError("generateCandidates: profiles 必须是 { [skinId]: profile } 映射");
  }
  if (!Array.isArray(skinIds) || skinIds.length === 0) {
    throw new TypeError("generateCandidates: skinIds 必须是非空数组");
  }
  const requested = new Set();
  for (const skinId of skinIds) {
    assertNonEmptyString(skinId, "skinIds 元素");
    if (requested.has(skinId)) {
      throw new TypeError(`generateCandidates: skinIds 重复 "${skinId}"`);
    }
    requested.add(skinId);
    if (!SKIN_IDS.includes(skinId)) {
      throw new TypeError(`generateCandidates: 未知皮肤 "${skinId}"（只接受注册表十套、排除 classic）`);
    }
    const profile = profiles[skinId];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new TypeError(`generateCandidates: 缺少皮肤 "${skinId}" 的配方（profile）`);
    }
  }
  // 生成顺序固定为注册表顺序（与请求顺序无关），候选输出顺序因此稳定
  const orderedSkinIds = SKIN_IDS.filter((skinId) => requested.has(skinId));

  const state = { policy, roleCatalog, evaluatePalette };
  const candidates = [];
  const rejected = [];
  for (const skinId of orderedSkinIds) {
    const profile = profiles[skinId];
    // 快照深拷贝：deepFreeze 只冻结拷贝，调用方配方（含嵌套字段）保持可变
    const profileSnapshot = JSON.parse(canonicalJson(profile));
    const template = buildSurfaceTemplates(profile);
    const variantItems = [];
    for (const variant of VARIANTS) {
      const variantTemplate = template.variants[variant];
      const pair = solveVariantPair({ skinId, variant, variantTemplate, records: rejected, state });
      if (pair === null) continue;
      variantItems.push(
        buildVariantItem({
          skinId,
          variant,
          profileSnapshot,
          variantTemplate,
          light: pair.light,
          dark: pair.dark,
          seed,
          policy,
          derivationHash,
        }),
      );
    }
    const { survivors, duplicates } = dedupeVariantItems(variantItems);
    candidates.push(...survivors.map((item) => item.candidate));
    rejected.push(...duplicates);
  }

  const profilesUsed = {};
  for (const skinId of orderedSkinIds) profilesUsed[skinId] = profiles[skinId];
  const candidateSet = {
    schemaVersion: 1,
    inputHashes: {
      profiles: sha256Canonical(profilesUsed),
      policy: sha256Canonical(policy),
      roles: hashRoleInputs(),
      derivation: derivationHash,
    },
    candidates,
    rejected,
  };
  const result = deepFreeze({ ...candidateSet, candidateSetHash: hashCandidateSet(candidateSet) });
  selfValidate(result);
  return result;
}

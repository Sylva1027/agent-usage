/**
 * M2.4 生成 CLI 与产物写入（唯一生成命令）
 * ============================================================================
 *
 * 固定命令（M2.4 卡面）：
 *   node scripts/skin-palette/generate-cli.mjs --skins chatgpt,grok \
 *     --seed palette-redesign-v1 --out docs/validation/2026-10-03-skin-palette-redesign/pilot-r1
 *
 * 参数固定为 --skins / --seed / --out；profiles、policy 默认读固定模块目录
 * （scripts/skin-palette/profiles.json 与 policy.json），需要覆盖时只接受显式
 * --profiles <path> / --policy <path> 并保存其内容摘要；未知参数报错。
 * --skins all = 注册表全部十套（排除 classic）。roles 无覆盖参数——角色清单属
 * M0 契约，本 CLI 只消费 ./roles.mjs。
 *
 * 行为（M2.4 卡面 + 总计划 §3/§4.1）：
 *   - 导入本模块不执行任何生成；只有直接运行（node generate-cli.mjs）进入 main。
 *   - 收集输入与源文件摘要：profiles/policy 文件原始字节 + 生成工具链各模块 +
 *     实际评估器模块（evaluate.mjs）+ public/skins.js，经
 *     contracts.collectSourceHashes 取 SHA-256；其中 public/skins.js 的摘要即
 *     derivationHash，传给 generateCandidates（§4.1 "候选摘要覆盖 skins.js 当前
 *     文件内容"语义由调用方保持）。评估器为显式注入（或自定义 loader）时无文件
 *     可考，run.json.evaluator 记 { source: "injected" }，来源留档由注入方负责。
 *   - policy 经 M0 契约校验（contracts.validatePolicy）后才参与生成，未过即输入
 *     错误退出 1；profiles 信封校验属 M5.1 所有方（见交接边界）。
 *   - 写 run.json / candidates.json：落盘规范 canonicalFileContent（canonicalJson
 *     + 末尾换行），先写临时文件再 rename；输出目录已存在结果时拒绝覆盖——每次
 *     完整新建目录；写入失败回滚本次运行已写的文件（半套结果不留盘、同目录重试
 *     可行，已有文件不受影响）。运行时间与机器绝对路径只进 run.json，候选 JSON
 *     保持同输入逐字相同。
 *   - 输出目录边界按词法路径与真实路径双重校验（junction/符号链接还原后仍必须在
 *     docs/validation/ 内），mkdir 之后再复检一次，检查不过不写任何文件。
 *   - 退出码：0 = 所有请求皮肤各 ≥2 组成对且无已知硬失败，表示**生成完成**，
 *     不表示浏览器或美观通过；1 = 输入或写入错误；2 = 某请求皮肤不足两组 /
 *     无解 / 预算冲突等硬失败（HARD_FAILURE_CODES），同时保存其他已完成结果与
 *     失败记录。输入校验先于任何写盘，失败不损坏已有文件。
 *   - 不执行 prepare，不改正式 palette/bootstrap，不启动真实服务，不访问网络。
 *
 * evaluatePalette 真件属 M3.1（scripts/skin-palette/evaluate.mjs）：显式注入
 * evaluate 时直接使用（测试与上层编排）；否则动态解析固定模块目录（可用
 * evaluateModulePath 覆盖目标，测试注入 fixture 用），缺失或无导出即输入错误
 * 退出 1——不造第二份评估实现。M3.1 落地前，直接运行本 CLI 会因默认
 * profiles.json（M5 产物）与检查器均未就绪而退出 1。
 */

import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SKIN_IDS, canonicalFileContent, collectSourceHashes, validatePolicy } from "./contracts.mjs";
import { generateCandidates } from "./generate.mjs";
import { ROLE_CATALOG } from "./roles.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MODULE_DIR = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PROFILES_PATH = path.join(MODULE_DIR, "profiles.json");
const DEFAULT_POLICY_PATH = path.join(MODULE_DIR, "policy.json");
const VALIDATION_ROOT = path.join(REPO_ROOT, "docs", "validation");
const SKINS_JS_PATH = path.join(REPO_ROOT, "public", "skins.js");
/** M3.1 评估器真件的固定位置（动态解析目标 + 源摘要对象）。 */
const EVALUATE_MODULE_PATH = path.join(MODULE_DIR, "evaluate.mjs");

/** 生成工具链：影响候选颜色与求解行为的模块，连同输入文件一起留源摘要。 */
const TOOLCHAIN_SOURCE_PATHS = Object.freeze(
  [
    "color-math.mjs",
    "contracts.mjs",
    "generate-cli.mjs",
    "generate.mjs",
    "roles.mjs",
    "solver.mjs",
    "templates.mjs",
  ].map((fileName) => path.join(MODULE_DIR, fileName)),
);

/** 已知硬失败（DUPLICATE_CANDIDATE 是去重处置不是失败；STALE_EVIDENCE 是兜底防线）。 */
export const HARD_FAILURE_CODES = Object.freeze([
  "UNSATISFIABLE",
  "CONTRACT_CONFLICT",
  "SEARCH_BUDGET_EXCEEDED",
  "STALE_EVIDENCE",
]);

export const GENERATE_EXIT_CODES = Object.freeze({
  ok: 0,
  input: 1,
  conflict: 2,
});

const KNOWN_FLAGS = Object.freeze(["--skins", "--seed", "--out", "--profiles", "--policy"]);
const RESULT_FILE_NAMES = Object.freeze(["candidates.json", "run.json"]);

export class GenerateCliError extends Error {
  constructor(code, exitCode, message) {
    super(message);
    this.name = "GenerateCliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * 解析固定参数：--skins / --seed / --out 必填，--profiles / --policy 可选覆盖。
 * 支持 "--flag value" 与 "--flag=value"；未知、重复、缺值（含 "--flag --next"
 * 这类把下一面名当值的写法）显式报错。
 */
export function parseGenerateArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    const equalIndex = token.indexOf("=");
    const flag = equalIndex === -1 ? token : token.slice(0, equalIndex);
    if (!KNOWN_FLAGS.includes(flag)) {
      throw new GenerateCliError(
        "UNKNOWN_ARGUMENT",
        GENERATE_EXIT_CODES.input,
        `未知参数 "${token}"；固定参数为 --skins/--seed/--out，可选覆盖为 --profiles/--policy。`,
      );
    }
    if (values.has(flag)) {
      throw new GenerateCliError("DUPLICATE_FLAG", GENERATE_EXIT_CODES.input, `参数 ${flag} 重复给出。`);
    }
    let value;
    if (equalIndex === -1) {
      value = argv[index + 1];
      index += 1;
      if (typeof value === "string" && value.startsWith("--")) value = undefined;
    } else {
      value = token.slice(equalIndex + 1);
    }
    if (value === undefined || value === "") {
      throw new GenerateCliError("MISSING_VALUE", GENERATE_EXIT_CODES.input, `${flag} 需要一个值。`);
    }
    values.set(flag, value);
  }

  const skinsValue = values.get("--skins");
  if (skinsValue === undefined) {
    throw new GenerateCliError(
      "MISSING_SKINS",
      GENERATE_EXIT_CODES.input,
      "--skins 必填：逗号分隔的注册表皮肤 ID，或 all（全部十套）。",
    );
  }
  let skins;
  if (skinsValue === "all") {
    skins = [...SKIN_IDS];
  } else {
    skins = skinsValue.split(",").map((skinId) => skinId.trim());
    for (const skinId of skins) {
      if (!skinId) {
        throw new GenerateCliError("EMPTY_SKIN", GENERATE_EXIT_CODES.input, `--skins 含空段："${skinsValue}"。`);
      }
      if (!SKIN_IDS.includes(skinId)) {
        throw new GenerateCliError(
          "UNKNOWN_SKIN",
          GENERATE_EXIT_CODES.input,
          `未知皮肤 "${skinId}"：--skins 只接受注册表十套（排除 classic）或 all。`,
        );
      }
    }
    if (new Set(skins).size !== skins.length) {
      throw new GenerateCliError(
        "DUPLICATE_SKIN",
        GENERATE_EXIT_CODES.input,
        `--skins 重复请求同一皮肤："${skinsValue}"。`,
      );
    }
  }

  const seed = values.get("--seed");
  if (seed === undefined) {
    throw new GenerateCliError("MISSING_SEED", GENERATE_EXIT_CODES.input, "--seed 必填：进入候选摘要的可复现种子。");
  }
  const out = values.get("--out");
  if (out === undefined) {
    throw new GenerateCliError(
      "MISSING_OUT",
      GENERATE_EXIT_CODES.input,
      "--out 必填：docs/validation/ 下的新输出目录。",
    );
  }
  return {
    skins,
    seed,
    out,
    profilesPath: values.get("--profiles"),
    policyPath: values.get("--policy"),
  };
}

/**
 * 真实路径解析：沿目录树向上找最深已存在祖先做 realpath（junction/符号链接在此
 * 还原为盘上真身），再拼回词法余段。目标不存在时余段保持词法形态（等 mkdir 后
 * 由 runGenerate 复检一次闭合窗口）。
 */
function resolveRealPath(target) {
  const lexical = path.resolve(target);
  const tail = [];
  let current = lexical;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return { real: realpathSync(current), tail };
}

/** 输出目录必须落在 docs/validation/<日期>-skin-palette-redesign/<runId>/（总计划 §3 证据输出根）。 */
export function resolveGenerateOutputDirectory(outputValue, { validationRoot = VALIDATION_ROOT } = {}) {
  if (!outputValue) {
    throw new GenerateCliError("MISSING_OUT", GENERATE_EXIT_CODES.input, "--out 必填。");
  }
  const resolved = path.resolve(outputValue);
  const root = path.resolve(validationRoot);
  // Windows 路径大小写不敏感，比较前先折叠，避免同一目录被误判在外面。
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  // 词法检查：拦住 ".." 上跳等盘面写法。
  const lexicalRelative = path.relative(fold(root), fold(resolved));
  if (!lexicalRelative || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    throw new GenerateCliError(
      "OUTPUT_OUTSIDE_VALIDATION",
      GENERATE_EXIT_CODES.input,
      "输出目录必须位于仓库 docs/validation/ 之内（总计划 §3）。",
    );
  }
  const segments = lexicalRelative.split(path.sep).filter(Boolean);
  if (segments.length < 2 || !/-skin-palette-redesign$/.test(segments[0])) {
    throw new GenerateCliError(
      "OUTPUT_NOT_SKIN_PALETTE_RUN",
      GENERATE_EXIT_CODES.input,
      "输出目录必须是 docs/validation/<日期>-skin-palette-redesign/<runId>/。",
    );
  }
  // 真实路径检查：junction/符号链接还原后的盘上真身也必须落在 validationRoot 之内。
  const { real: rootReal } = resolveRealPath(root);
  const { real, tail } = resolveRealPath(resolved);
  const effective = tail.length > 0 ? path.join(real, ...tail) : real;
  const realRelative = path.relative(fold(rootReal), fold(effective));
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new GenerateCliError(
      "OUTPUT_OUTSIDE_VALIDATION",
      GENERATE_EXIT_CODES.input,
      "输出目录经真实路径解析后落在 docs/validation/ 之外（junction/符号链接重定向？）。",
    );
  }
  return resolved;
}

/** 输出目录已存在生成结果即拒绝覆盖（每次完整运行新建目录，禁止覆盖上次结果）。 */
export function assertNoExistingResults(outDir, { exists = existsSync } = {}) {
  const present = RESULT_FILE_NAMES.filter((fileName) => exists(path.join(outDir, fileName)));
  if (present.length > 0) {
    throw new GenerateCliError(
      "RESULTS_EXIST",
      GENERATE_EXIT_CODES.input,
      `输出目录已存在生成结果（${present.join("、")}），拒绝覆盖；请改用新目录（每次完整运行新建目录）。`,
    );
  }
}

async function loadJsonObject(filePath, label, read) {
  let text;
  try {
    text = await read(filePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? (error.code ?? error.message) : String(error);
    throw new GenerateCliError(
      `${label.toUpperCase()}_UNREADABLE`,
      GENERATE_EXIT_CODES.input,
      `无法读取${label}文件 ${filePath}：${detail}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GenerateCliError(
      `${label.toUpperCase()}_INVALID_JSON`,
      GENERATE_EXIT_CODES.input,
      `${label}文件不是合法 JSON：${filePath}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GenerateCliError(
      `${label.toUpperCase()}_INVALID_JSON`,
      GENERATE_EXIT_CODES.input,
      `${label}文件顶层必须是对象：${filePath}`,
    );
  }
  return parsed;
}

/**
 * 显式注入优先；否则动态解析 M3.1 真件（固定模块目录），不造第二份评估实现。
 * 返回 { evaluatePalette, evaluatorPath }：evaluatorPath 为模块文件路径（进入源
 * 文件摘要）；显式注入 evaluate 或使用自定义 loader 时为 null（run.json 记
 * injected，来源留档由注入方负责）。
 */
async function resolveEvaluatePalette(evaluate, loadEvaluate, evaluateModulePath) {
  if (evaluate !== undefined) {
    if (typeof evaluate !== "function") {
      throw new GenerateCliError("EVALUATE_INVALID", GENERATE_EXIT_CODES.input, "注入的 evaluate 不是函数。");
    }
    return { evaluatePalette: evaluate, evaluatorPath: null };
  }
  let module;
  try {
    module = await loadEvaluate();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GenerateCliError(
      "EVALUATE_UNAVAILABLE",
      GENERATE_EXIT_CODES.input,
      `M3.1 检查器不可用：无法加载 ${evaluateModulePath}（${detail}）。`,
    );
  }
  const resolved = module?.evaluatePalette ?? module?.evaluate ?? module?.default;
  if (typeof resolved !== "function") {
    throw new GenerateCliError(
      "EVALUATE_UNAVAILABLE",
      GENERATE_EXIT_CODES.input,
      `${evaluateModulePath} 未导出 evaluatePalette 函数（M3.1 真件未落地或形状不符）。`,
    );
  }
  return { evaluatePalette: resolved, evaluatorPath: evaluateModulePath };
}

/**
 * 生成一次候选并落盘。参数经 parseGenerateArgs 校验；evaluate / loadEvaluate /
 * log / now / fs 家族可注入（测试与上层编排用，缺省走真实值）。
 * 返回 { exitCode, status, outDir, candidateSetHash, run }；错误抛 GenerateCliError。
 */
export async function runGenerate(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("runGenerate: 需要 options 对象");
  }
  const {
    skins,
    seed,
    out,
    profilesPath,
    policyPath,
    evaluate,
    loadEvaluate,
    evaluateModulePath = EVALUATE_MODULE_PATH,
    validationRoot = VALIDATION_ROOT,
    log = (line) => process.stdout.write(`${line}\n`),
    now = () => new Date().toISOString(),
    readFile: read = readFile,
    writeFile: write = writeFile,
    rename: renameFile = rename,
    unlink: unlinkFile = unlink,
    exists = existsSync,
    mkdir: makeDirectory = mkdir,
  } = options;

  const outDir = resolveGenerateOutputDirectory(out, { validationRoot });
  assertNoExistingResults(outDir, { exists });

  const profilesFile = profilesPath ?? DEFAULT_PROFILES_PATH;
  const policyFile = policyPath ?? DEFAULT_POLICY_PATH;
  const profiles = await loadJsonObject(profilesFile, "profiles", read);
  const policy = await loadJsonObject(policyFile, "policy", read);
  const policyVerdict = validatePolicy(policy);
  if (!policyVerdict.valid) {
    const detail = policyVerdict.errors
      .slice(0, 3)
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("；");
    throw new GenerateCliError(
      "POLICY_INVALID",
      GENERATE_EXIT_CODES.input,
      `policy 文件未过 M0 契约校验（${policyFile}）：${detail}`,
    );
  }
  // 注入 evaluate / 自定义 loader 时不假定固定模块路径；默认 loader 按可覆盖目标解析
  const usingDefaultLoader = loadEvaluate === undefined;
  const loader = loadEvaluate ?? (() => import(pathToFileURL(evaluateModulePath).href));
  const resolved = await resolveEvaluatePalette(evaluate, loader, evaluateModulePath);
  const evaluatePalette = resolved.evaluatePalette;
  const evaluatorPath = usingDefaultLoader ? resolved.evaluatorPath : null;

  const sourcePaths = [
    ...TOOLCHAIN_SOURCE_PATHS,
    ...(evaluatorPath !== null && !TOOLCHAIN_SOURCE_PATHS.includes(evaluatorPath) ? [evaluatorPath] : []),
    SKINS_JS_PATH,
    path.resolve(profilesFile),
    path.resolve(policyFile),
  ];
  const sourceHashes = collectSourceHashes(sourcePaths);
  const derivationHash = sourceHashes[SKINS_JS_PATH];
  if (!derivationHash) {
    throw new GenerateCliError("SOURCE_UNREADABLE", GENERATE_EXIT_CODES.input, `无法读取派生源 ${SKINS_JS_PATH}。`);
  }
  const evaluator = evaluatorPath
    ? { source: "module", path: evaluatorPath, sha256: sourceHashes[evaluatorPath] }
    : { source: "injected" };

  let candidateSet;
  try {
    candidateSet = generateCandidates({
      profiles,
      skinIds: skins,
      seed,
      policy,
      roleCatalog: ROLE_CATALOG,
      evaluatePalette,
      derivationHash,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GenerateCliError("GENERATION_INPUT", GENERATE_EXIT_CODES.input, `候选生成拒绝输入：${detail}`);
  }

  const countsBySkin = {};
  for (const skinId of skins) countsBySkin[skinId] = 0;
  for (const candidate of candidateSet.candidates) countsBySkin[candidate.skinId] += 1;
  const insufficientSkins = skins.filter((skinId) => countsBySkin[skinId] < 2);
  const hardFailures = candidateSet.rejected.filter((record) => HARD_FAILURE_CODES.includes(record.code));
  const status = insufficientSkins.length === 0 && hardFailures.length === 0 ? "ok" : "conflict";
  const exitCode = status === "ok" ? GENERATE_EXIT_CODES.ok : GENERATE_EXIT_CODES.conflict;

  const run = {
    schemaVersion: 1,
    kind: "skin-palette-generate",
    generatedAt: now(),
    status,
    command: {
      skins: [...skins],
      seed,
      out: outDir,
      profilesPath: path.resolve(profilesFile),
      policyPath: path.resolve(policyFile),
      profilesOverride: profilesPath !== undefined,
      policyOverride: policyPath !== undefined,
    },
    sourceHashes,
    derivationHash,
    evaluator,
    candidateSetHash: candidateSet.candidateSetHash,
    counts: {
      candidates: candidateSet.candidates.length,
      rejected: candidateSet.rejected.length,
      bySkin: countsBySkin,
    },
    insufficientSkins,
    hardFailures: hardFailures.map((record) => ({
      code: record.code,
      skinId: record.skinId,
      variant: record.variant,
      mode: record.mode,
    })),
    notes: [
      "退出码 0 表示生成完成，不表示浏览器或美观通过（M2.4 卡面）。",
      "候选尚待 M3 快速门禁复核、M4 浏览器实测与视觉评审。",
    ],
  };

  const createdFiles = [];
  const writeAtomic = async (filePath, content) => {
    const tempPath = `${filePath}.tmp-${process.pid}`;
    try {
      await write(tempPath, content, "utf8");
      await renameFile(tempPath, filePath);
      createdFiles.push(filePath);
    } catch (error) {
      await unlinkFile(tempPath).catch(() => {});
      throw error;
    }
  };
  try {
    await makeDirectory(outDir, { recursive: true });
    // mkdir 之后再复检一次真实路径：检查与创建之间目录树可能被 junction 重定向
    resolveGenerateOutputDirectory(outDir, { validationRoot });
    await writeAtomic(path.join(outDir, "candidates.json"), canonicalFileContent(candidateSet));
    await writeAtomic(path.join(outDir, "run.json"), canonicalFileContent(run));
  } catch (error) {
    // 回滚本次运行已写的文件：半套结果不留盘，同目录重试可行；此前已有的文件不动
    for (const filePath of createdFiles.reverse()) {
      await unlinkFile(filePath).catch(() => {});
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new GenerateCliError("WRITE_FAILED", GENERATE_EXIT_CODES.input, `写入输出目录失败（${outDir}）：${detail}`);
  }

  const failureNote = hardFailures.length > 0 ? `，硬失败 ${hardFailures.length} 条` : "";
  log(
    `skin-palette generate：请求 ${skins.length} 款（${skins.join(", ")}），候选 ${candidateSet.candidates.length} 条、拒绝 ${candidateSet.rejected.length} 条${failureNote}`,
  );
  for (const skinId of insufficientSkins) {
    log(`  冲突：皮肤 ${skinId} 候选不足两组（${countsBySkin[skinId]} 条）`);
  }
  for (const failure of run.hardFailures) {
    log(`  冲突：${failure.code} ${failure.skinId}/${failure.variant}/${failure.mode}`);
  }
  log(`写入 ${path.join(outDir, "run.json")}`);
  log(`写入 ${path.join(outDir, "candidates.json")}`);
  log(
    status === "ok"
      ? "生成完成（退出码 0）——不表示浏览器或美观通过；候选尚待 M3/M4 浏览器实测与视觉评审。"
      : "生成存在冲突（退出码 2）——已完成结果与失败记录已保存，尚待浏览器与视觉评审及后续处置。",
  );

  return { exitCode, status, outDir, candidateSetHash: candidateSet.candidateSetHash, run };
}

/** 仅直接运行时执行；导入本模块不产生任何副作用（M2.4 卡面）。 */
export async function main(argv = []) {
  try {
    const parsed = parseGenerateArgs(argv);
    const result = await runGenerate(parsed);
    process.exitCode = result.exitCode;
    return result;
  } catch (error) {
    if (error instanceof GenerateCliError) {
      process.stderr.write(`generate-cli: ${error.code}: ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
      process.stderr.write(`generate-cli: 意外错误：${detail}\n`);
      process.exitCode = GENERATE_EXIT_CODES.input;
    }
    return null;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main(process.argv.slice(2));
}

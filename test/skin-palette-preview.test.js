// M4.1 不可变候选预览服务（preview-server.mjs）验收测试。
// 固定接口 startCandidatePreview({ candidate, fixture, port = 0 })：
// 正式模式与产品一致、候选模块互不串值、API 有 fixture 数据、遍历拒绝、
// 坏候选启动前报错、生产文件全程只读、close 共享同一次真实关闭且不碰 fixture 生命周期。
// 复核更正（2026-10-05）回归：并行启动名额同步占用且失败可复用、候选启动边界快照、
// 超限请求收到明确 413 而非连接重置。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createServer, request as httpRequest } from "node:http";

import {
  sha256Canonical,
  hashCandidate,
  validateCandidate,
  collectSourceHashes,
} from "../scripts/skin-palette/contracts.mjs";
import {
  buildSkinBootstrapModuleSource,
  buildSkinPalettesModuleSource,
  startCandidatePreview,
} from "../scripts/skin-palette/preview-server.mjs";
import {
  SOURCE_FILES,
  MATRIX_UNTESTED,
  STATE_MATRIX_GROUPS,
  adaptRoleCatalogForMeasurement,
  assertCaptureOutputDir,
  buildPreferenceSeedSource,
  buildResourceBlockers,
  buildStateBlockers,
  buildStateReadyWaitSource,
  buildFixedMatrixFixtureBindings,
  buildMatrixCaptureSequences,
  classifyExpectedQuotaErrors,
  assertFixedMatrixFixtureBindings,
  closeCaptureMatrixResources,
  captureBaseline,
  captureOnlineFreezeRegression,
  captureStateMatrix,
  readCapturedUnitEvidence,
  CHARACTERS_READY_WAIT_SOURCE,
  buildCharactersReadySource,
  describeMatrixCoverage,
  diffPaletteDeclarations,
  parseMetricNumber,
  planMonthNavigation,
  planResume,
  resolveBrowserRuntime,
  resumeDigestsMatch,
} from "../scripts/skin-palette/capture.mjs";
import { REQUIRED_SOURCE_FILES } from "../scripts/skin-palette/assess.mjs";
import { ROLE_CATALOG, ROLES_VERSION, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";
import { SKIN_PALETTES } from "../public/skin-palettes.js";
import { derivePaletteDeclarationsFromTokens, paletteDeclarations } from "../public/skins.js";
import {
  FIXTURE_EVENT_COUNT,
  FIXTURE_TOTAL_TOKENS,
  createPaletteFixture,
  getPaletteFixtureHash,
  getTimelineWarningFixtureHash,
} from "../test-support/skin-palette-fixture.mjs";
import { makeCandidate, writeMatrixCapture } from "../test-support/skin-palette-review-evidence-fixture.mjs";

const POLICY = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
const PREVIEW_PROFILE = Object.freeze({
  identityHex: "#4F4971",
  surfaceH: 268,
  surfaceC: 0.028,
  pageL: { light: 0.93, dark: 0.17 },
  accentC: 0.1,
});

// 生产色源存的是小写 hex；M0 token 契约（validateTokens）要求大写 #RRGGBB，
// 候选一律经大写化后再进契约——运行时 normalizePalette 对两种大小写等价。
const productionTokens = (skinId, mode) =>
  Object.fromEntries(Object.entries(SKIN_PALETTES[skinId][mode]).map(([key, value]) => [key, value.toUpperCase()]));

function previewCandidate({
  skinId = "chatgpt",
  variant = "a",
  light = productionTokens("chatgpt", "light"),
  dark = productionTokens("chatgpt", "dark"),
  ...overrides
} = {}) {
  const base = {
    schemaVersion: 1,
    skinId,
    variant,
    profileVersion: 1,
    profileSnapshot: PREVIEW_PROFILE,
    profileHash: sha256Canonical(PREVIEW_PROFILE),
    policyHash: sha256Canonical(POLICY),
    derivationHash: "b".repeat(64),
    seed: "skin-palette-preview",
    style: { title: "预览候选", rationale: "预览服务验收", identitySource: "#4F4971" },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light: { ...light }, dark: { ...dark } },
  };
  const merged = { ...base, ...overrides };
  const candidateHash = hashCandidate(merged);
  const candidate = {
    ...merged,
    id: `${merged.skinId}-${merged.variant}-${candidateHash.slice(0, 12)}`,
    candidateHash,
  };
  const check = validateCandidate(candidate);
  assert.ok(check.valid, `预览候选必须过 M0 契约：${check.errors[0]?.message ?? "unknown"}`);
  return candidate;
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function importESMFromSource(source) {
  // data: URL 会被当作网络源限制 import 断言，这里写进系统临时目录再动态导入；
  // 文件名带随机后缀避免 ESM 模块缓存把两次导入折叠成同一实例。
  const directory = await mkdtemp(path.join(tmpdir(), "skin-palette-preview-module-"));
  try {
    const file = path.join(directory, "module.mjs");
    await writeFile(file, source, "utf8");
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 原样发送请求路径（不经 URL 规范化），返回 { status, body }——服务端遍历拒绝的真实线路。 */
function rawRequest(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: requestPath, method: "GET" });
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * 发送超大请求 body 且刻意不在收到响应前调用 end()：413 必须在 body 结束意图
 * 完成前就到达——"缓冲后检查"的实现永远等不到 end，只会在超时上暴露。
 * 收到响应后停止发送并正常收尾（真实 HTTP 客户端行为），避免服务器关闭连接时
 * 自己还在写而吃到连接重置。
 */
function postOversizedBody(port, requestPath, totalBytes) {
  return new Promise((resolve, reject) => {
    const megabyte = Buffer.alloc(1024 * 1024, 0x61);
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    let settled = false;
    let sawResponse = false;
    const finish = (settle) => {
      if (settled) return;
      settled = true;
      settle();
      request.destroy();
    };
    request.on("response", (response) => {
      sawResponse = true;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        finish(() => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.end();
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    let sent = 0;
    const pump = () => {
      if (sawResponse) return;
      while (sent < totalBytes) {
        sent += megabyte.length;
        if (!request.write(megabyte)) {
          request.once("drain", pump);
          return;
        }
      }
      // 到达总量后、收到响应前，保持请求不结束
    };
    pump();
  });
}

function extractBootstrapConfig(source) {
  const line = source.split("\n").find((text) => text.includes("const CONFIG ="));
  assert.ok(line, "bootstrap 源必须带 CONFIG 载荷");
  return JSON.parse(line.slice(line.indexOf("const CONFIG =") + "const CONFIG =".length).replace(/;\s*$/, ""));
}

test("正式模式（candidate=null）与当前产品一致：色源模块逐字相同、API 有 fixture 数据", async () => {
  const fixture = await createPaletteFixture();
  const preview = await startCandidatePreview({ candidate: null, fixture });
  try {
    for (const name of ["skin-palettes.js", "skin-bootstrap.js", "index.html"]) {
      const [served, onDisk] = await Promise.all([
        fetch(new URL(name, preview.url)).then((response) => response.text()),
        readFile(path.join("public", name), "utf8"),
      ]);
      assert.equal(served, onDisk, `${name} 在正式模式必须与生产文件逐字相同`);
    }
    const usage = await fetch(new URL("/api/usage", preview.url)).then((response) => response.json());
    assert.equal(usage.metadata.eventCount, FIXTURE_EVENT_COUNT, "实际 API 必须有 fixture 数据");
    assert.equal(usage.summary.totals.total, FIXTURE_TOTAL_TOKENS);
    const moduleResponse = await fetch(new URL("/skin-palettes.js", preview.url));
    assert.equal(moduleResponse.headers.get("cache-control"), "no-store");
  } finally {
    await preview.close();
    await fixture.close();
  }
});

test("候选模式替换对应皮肤、其他皮肤不变；扁平 token 形状与生产文件一致", async () => {
  const fixture = await createPaletteFixture();
  const candidate = previewCandidate({
    modes: {
      light: { ...productionTokens("chatgpt", "light"), accent: "#B000FF", pageBackground: "#010203" },
      dark: productionTokens("chatgpt", "dark"),
    },
  });
  const preview = await startCandidatePreview({ candidate, fixture });
  try {
    const moduleResponse = await fetch(new URL("/skin-palettes.js", preview.url));
    assert.equal(moduleResponse.headers.get("cache-control"), "no-store", "候选模块响应必须 no-store");
    const { SKIN_PALETTES: served } = await importESMFromSource(await moduleResponse.text());
    assert.equal(served.chatgpt.light.accent, "#B000FF", "覆盖皮肤必须用候选 token");
    assert.equal(served.chatgpt.light.pageBackground, "#010203");
    assert.equal(typeof served.chatgpt.light.pageBackground, "string", "必须是扁平 token，不包 { tokens: ... }");
    assert.deepEqual(served.chatgpt.dark, candidate.modes.dark);
    assert.deepEqual(served.claude, SKIN_PALETTES.claude, "其他皮肤必须保持正式值不变");
    assert.deepEqual(served.glm, SKIN_PALETTES.glm);

    const config = extractBootstrapConfig(
      await fetch(new URL("/skin-bootstrap.js", preview.url)).then((response) => response.text()),
    );
    const entry = config.registry.find((skin) => skin.id === "chatgpt");
    assert.deepEqual(
      entry.palette.light,
      JSON.parse(JSON.stringify(derivePaletteDeclarationsFromTokens(candidate.modes.light, "light"))),
      "首屏 bootstrap 必须与运行时模块配对（M1.1 同一派生路径）",
    );
    const untouched = config.registry.find((skin) => skin.id === "claude");
    assert.deepEqual(
      untouched.palette.light,
      JSON.parse(JSON.stringify(paletteDeclarations("claude", "light"))),
      "未覆盖皮肤的首屏声明保持正式值",
    );
  } finally {
    await preview.close();
    await fixture.close();
  }
});

test("两候选服务同时存活、颜色互不串值；共享 fixture 数据互不可见泄露", async () => {
  const fixture = await createPaletteFixture();
  const left = previewCandidate({
    modes: {
      light: { ...productionTokens("chatgpt", "light"), accent: "#0A0B0C" },
      dark: productionTokens("chatgpt", "dark"),
    },
  });
  const right = previewCandidate({
    modes: {
      light: { ...productionTokens("chatgpt", "light"), accent: "#FF0001" },
      dark: productionTokens("chatgpt", "dark"),
    },
  });
  const leftPreview = await startCandidatePreview({ candidate: left, fixture });
  const rightPreview = await startCandidatePreview({ candidate: right, fixture });
  try {
    const readAccent = async (preview) => {
      const { SKIN_PALETTES: served } = await importESMFromSource(
        await fetch(new URL("/skin-palettes.js", preview.url)).then((response) => response.text()),
      );
      return served.chatgpt.light.accent;
    };
    const [leftAccent, rightAccent] = await Promise.all([readAccent(leftPreview), readAccent(rightPreview)]);
    assert.equal(leftAccent, "#0A0B0C", "实例 A 必须只提供候选 A 的颜色");
    assert.equal(rightAccent, "#FF0001", "实例 B 必须只提供候选 B 的颜色");
    assert.notEqual(leftAccent, rightAccent);
    for (const preview of [leftPreview, rightPreview]) {
      const usage = await fetch(new URL("/api/usage", preview.url)).then((response) => response.json());
      assert.equal(usage.summary.totals.total, FIXTURE_TOTAL_TOKENS, "每个实例的 API 都有自己的 fixture 数据");
    }
  } finally {
    await leftPreview.close();
    await rightPreview.close();
    await fixture.close();
  }
});

test("候选在启动边界固定（复核更正）：启动期间修改调用方候选不影响服务，调用方对象不被冻结", async () => {
  const fixture = await createPaletteFixture();
  const candidate = previewCandidate({
    modes: {
      light: { ...productionTokens("chatgpt", "light"), accent: "#123456" },
      dark: productionTokens("chatgpt", "dark"),
    },
  });
  // 启动调用尚未 await 时就改动调用方候选（复核探针同款攻击面）
  const starting = startCandidatePreview({ candidate, fixture });
  candidate.modes.light.accent = "#010203";
  const preview = await starting;
  try {
    const servedSource = await fetch(new URL("/skin-palettes.js", preview.url)).then((response) => response.text());
    assert.ok(servedSource.includes(candidate.id), "候选身份仍取自启动边界快照（id/hash 不变）");
    const { SKIN_PALETTES: served } = await importESMFromSource(servedSource);
    assert.equal(served.chatgpt.light.accent, "#123456", "颜色必须来自快照，不是启动期间被改过的调用方对象");
    const config = extractBootstrapConfig(
      await fetch(new URL("/skin-bootstrap.js", preview.url)).then((response) => response.text()),
    );
    const entry = config.registry.find((skin) => skin.id === "chatgpt");
    const snapshotLight = { ...productionTokens("chatgpt", "light"), accent: "#123456" };
    assert.deepEqual(
      entry.palette.light,
      JSON.parse(JSON.stringify(derivePaletteDeclarationsFromTokens(snapshotLight, "light"))),
      "首屏与运行时必须来自同一份快照",
    );
    assert.equal(candidate.modes.light.accent, "#010203", "调用方对象仍归调用方（修改保持有效）");
    assert.equal(Object.isFrozen(candidate), false, "实现不得用冻结调用方对象代替快照");
  } finally {
    await preview.close();
    await fixture.close();
  }
});

test("快照不得洗白非法候选（复核更正二）：undefined 字段、稀疏数组、Date 一律拒绝，失败后名额可复用", async () => {
  const fixture = await createPaletteFixture();
  // 摘要记录在"洗白后"的内容上（复核探针同款）：只有被洗白的快照能通过
  // candidateHash 自洽，原始候选必然被 M0 契约拒绝——回归对"JSON.stringify 洗白"
  // 的旧实现才有牙。
  const corruptWith = (mutate) => {
    const candidate = previewCandidate();
    mutate(candidate);
    const launderedShape = JSON.parse(JSON.stringify(candidate));
    const hash = hashCandidate(launderedShape);
    for (const item of [candidate, launderedShape]) {
      item.candidateHash = hash;
      item.id = `${item.skinId}-${item.variant}-${hash.slice(0, 12)}`;
    }
    return candidate;
  };
  const rejectsOriginal = (candidate) => {
    try {
      return !validateCandidate(candidate).valid;
    } catch {
      return true; // M0 对 undefined/稀疏/Date 经 canonicalJson 抛错，同样算拒绝
    }
  };
  try {
    const sparse = new Array(3); // 刻意制造稀疏数组（空位会被 stringify 洗成 null）
    sparse[0] = 1;
    sparse[2] = 3;
    const cases = [
      [
        "undefined 字段",
        corruptWith((candidate) => {
          candidate.memo = undefined;
        }),
      ],
      [
        "稀疏数组",
        corruptWith((candidate) => {
          candidate.tags = sparse;
        }),
      ],
      [
        "Date",
        corruptWith((candidate) => {
          candidate.stamp = new Date(0);
        }),
      ],
    ];
    for (const [label, candidate] of cases) {
      assert.ok(rejectsOriginal(candidate), `${label}：原始候选必须先被 M0 契约拒绝（前提）`);
      let leaked = null;
      await assert
        .rejects(
          async () => {
            leaked = await startCandidatePreview({ candidate, fixture });
          },
          (error) => error instanceof TypeError && error.message.includes("快照失败"),
          `${label}：候选必须在快照阶段被拒绝，不得被序列化洗白`,
        )
        .finally(() => leaked?.close());
    }
    // 失败后名额可复用：干净候选照常启动并服务
    const preview = await startCandidatePreview({ candidate: previewCandidate(), fixture });
    try {
      const usage = await fetch(new URL("/api/usage", preview.url)).then((response) => response.json());
      assert.equal(usage.metadata.eventCount, FIXTURE_EVENT_COUNT, "被拒绝的候选不得占用名额");
    } finally {
      await preview.close();
    }
  } finally {
    await fixture.close();
  }
});

test("遍历路径与仓库外目录一律拒绝，白名单之外的类型不读", async () => {
  const fixture = await createPaletteFixture();
  const preview = await startCandidatePreview({ candidate: null, fixture });
  // 注意：fetch/URL 会把 %2e%2e 当点段在客户端规范化掉，永远到不了服务器；
  // 验收的是服务端对原始请求字节的拒绝，所以用 node:http 原样发送请求路径。
  const traversalTargets = [
    // 以下目标在包含关系校验缺失时会真实读到仓库文件（存在文件，能证明回归有牙）：
    "/..%2fpackage.json",
    "/..%2fsrc/server.js",
    "/assets/skins/light/..%2f..%2f..%2f..%2fsrc/server.js",
    "/..\\src\\server.js",
    // URL 解析器会把 %2e%2e 当点段规范化，这两条到不了处理器的路径参数里，
    // 仍保留作纵深防御记录（预期 403/404，vacuous 也无害）：
    "/%2e%2e/package.json",
    "/%2e%2e/%2e%2e/server.js",
  ];
  try {
    const { port } = new URL(preview.url);
    for (const target of traversalTargets) {
      const raw = await rawRequest(Number(port), target);
      assert.ok(raw.status === 403 || raw.status === 404, `${target} 必须被拒绝，实际 ${raw.status}`);
      assert.ok(!raw.body.includes("createUsageServer"), `${target} 不得泄露仓库文件内容`);
    }
    // 单次解码后是字面量文件名（public 下不存在），同样不得泄露
    const double = await rawRequest(Number(port), "/%252e%252e/server.js");
    assert.ok(double.status === 403 || double.status === 404);
    // 正常静态不受影响：webp 资产可读
    const asset = await fetch(new URL("/assets/skins/light/ChatGPT-lineart.webp", preview.url));
    assert.equal(asset.status, 200);
  } finally {
    await preview.close();
    await fixture.close();
  }
});

test("坏 candidate 与坏 fixture 在启动前报错，不监听任何端口", async () => {
  const fixture = await createPaletteFixture();
  try {
    await assert.rejects(
      () => startCandidatePreview({ candidate: { garbage: true }, fixture }),
      (error) => error instanceof TypeError && error.message.includes("M0 契约"),
    );
    // 测试构造器自带契约自检，所以这里先造好合法候选再破坏，让错误出自 startCandidatePreview
    const broken = previewCandidate();
    broken.derivationHash = "nothex";
    await assert.rejects(
      () => startCandidatePreview({ candidate: broken, fixture }),
      (error) => error instanceof TypeError && error.message.includes("candidates"),
    );
    await assert.rejects(
      () => startCandidatePreview({ candidate: undefined, fixture }),
      (error) => error instanceof TypeError && error.message.includes("M0 契约"),
      "只有显式 null 是正式模式，undefined 是非法输入",
    );
    await assert.rejects(
      () => startCandidatePreview({ candidate: null, fixture: {} }),
      (error) => error instanceof TypeError && error.message.includes("fixture"),
      "缺字段 fixture 会隐式回退用户主目录，必须启动前报错",
    );
    await assert.rejects(() => startCandidatePreview({ candidate: null, fixture, port: -1 }), TypeError);
    await assert.rejects(() => startCandidatePreview({ candidate: null, fixture, port: 1.5 }), TypeError);
  } finally {
    await fixture.close();
  }
});

test("close() 幂等、可重复调用；fixture 生命周期归调用方，服务关闭不删 fixture", async () => {
  const fixture = await createPaletteFixture();
  const preview = await startCandidatePreview({ candidate: null, fixture });
  const importStoreBefore = await readFile(fixture.importStoreFile, "utf8");
  await preview.close();
  await preview.close();
  await assert.rejects(() => fetch(preview.url), "关闭后端口必须不再接受请求");
  const importStoreAfter = await readFile(fixture.importStoreFile, "utf8");
  assert.equal(importStoreAfter, importStoreBefore, "服务关闭不得动 fixture 的存储文件");
  await fixture.close();
});

test("close 完成语义（复核更正）：重复/并发 close 等待同一次真实关闭，名额在关闭完成后才释放", async () => {
  const fixture = await createPaletteFixture();
  try {
    const preview = await startCandidatePreview({ candidate: null, fixture, maxConcurrent: 1 });
    const firstClose = preview.close();
    const secondClose = preview.close();
    assert.equal(firstClose, secondClose, "重复 close 必须返回同一个关闭 Promise");
    // 关闭动作尚未完成：名额不得提前释放（用 maxConcurrent:1 让全局名额在断言里可见）
    await assert.rejects(
      () => startCandidatePreview({ candidate: null, fixture, maxConcurrent: 1 }),
      (error) => error.message.includes("并发上限"),
      "close 未完成前名额必须仍被占用",
    );
    await Promise.all([firstClose, secondClose]);
    await assert.rejects(() => fetch(preview.url), "关闭完成后端口必须空出");
    const after = await startCandidatePreview({ candidate: null, fixture, maxConcurrent: 1 });
    try {
      const usage = await fetch(new URL("/api/usage", after.url)).then((response) => response.json());
      assert.equal(usage.metadata.eventCount, FIXTURE_EVENT_COUNT, "关闭完成后名额释放，新实例正常服务");
    } finally {
      await after.close();
    }
  } finally {
    await fixture.close();
  }
});

test("并发上限（复核更正）：并行三启动恰好两个成功，启动失败/关闭后名额可复用，硬上限不可放宽", async () => {
  const fixture = await createPaletteFixture();
  try {
    await assert.rejects(
      () => startCandidatePreview({ candidate: null, fixture, maxConcurrent: 3 }),
      (error) => error instanceof TypeError && error.message.includes("硬上限"),
      "任务卡硬上限 2 不能通过选项放宽",
    );
    // 名额必须在第一次 await 之前同步占用：三个并行启动只能活两个
    const attempts = await Promise.allSettled([
      startCandidatePreview({ candidate: null, fixture }),
      startCandidatePreview({ candidate: null, fixture }),
      startCandidatePreview({ candidate: null, fixture }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled").map((attempt) => attempt.value);
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    assert.equal(fulfilled.length, 2, "三个并行启动必须恰好成功两个");
    assert.equal(rejected.length, 1);
    assert.match(rejected[0]?.reason?.message ?? "", /并发上限/);

    // 启动失败（前端端口被占）不得泄漏名额：先腾出一个名额再制造监听失败
    await fulfilled[1].close();
    const occupied = createServer((_request, response) => response.end("occupied"));
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    await assert.rejects(
      () => startCandidatePreview({ candidate: null, fixture, port: occupied.address().port }),
      (error) => /EADDRINUSE|listen/.test(`${error?.code ?? ""}${error?.message ?? ""}`),
      "端口冲突必须表现为启动失败",
    );
    await new Promise((resolve) => occupied.close(resolve));

    // 失败实例没有占名额：关闭最后一个存活实例后还能连开两个
    await fulfilled[0].close();
    const retryFirst = await startCandidatePreview({ candidate: null, fixture });
    const retrySecond = await startCandidatePreview({ candidate: null, fixture });
    try {
      const usage = await fetch(new URL("/api/usage", retryFirst.url)).then((response) => response.json());
      assert.equal(usage.metadata.eventCount, FIXTURE_EVENT_COUNT, "腾出名额后的新实例必须正常服务");
    } finally {
      await Promise.all([retryFirst.close(), retrySecond.close()]);
    }
  } finally {
    await fixture.close();
  }
});

test("启动/关闭全程不写 public/skin-palettes.js 与 skin-bootstrap.js，源文件摘要不变", async () => {
  const watched = ["skin-palettes.js", "skin-bootstrap.js"];
  const before = {};
  for (const name of watched) {
    before[name] = sha256(await readFile(path.join("public", name)));
  }
  const fixture = await createPaletteFixture();
  const candidate = previewCandidate();
  const preview = await startCandidatePreview({ candidate, fixture });
  try {
    // 真正取用候选模块：如果有任何"写回生产文件"的捷径，这里就会改变摘要
    const served = await fetch(new URL("/skin-palettes.js", preview.url)).then((response) => response.text());
    assert.ok(served.includes(candidate.id), "候选模块必须由内存生成并带候选标识");
  } finally {
    await preview.close();
    await fixture.close();
  }
  for (const name of watched) {
    const after = sha256(await readFile(path.join("public", name)));
    assert.equal(after, before[name], `${name} 全程不得被改写`);
  }
});

test("代理保真：未知 API 走后端 404、POST 方法与 JSON 错误形状保持一致、查询串原样到达", async () => {
  const fixture = await createPaletteFixture();
  const preview = await startCandidatePreview({ candidate: null, fixture });
  try {
    const missing = await fetch(new URL("/api/definitely-not-a-route", preview.url));
    assert.equal(missing.status, 404, "未知 API 路径必须由后端应答");
    const shutdown = await fetch(new URL("/internal/shutdown", preview.url), { method: "POST" });
    assert.equal(shutdown.status, 403, "未带 shutdownToken 的内部路由必须由后端拒绝");
    assert.match(shutdown.headers.get("content-type") ?? "", /application\/json/);
    const usage = await fetch(new URL("/api/usage?detail=full", preview.url)).then((response) => response.json());
    assert.ok(Array.isArray(usage.report?.events), "查询串必须原样到达后端（detail=full 生效）");
    assert.equal(usage.report.events.length, FIXTURE_EVENT_COUNT);
    const summary = await fetch(new URL("/api/summary", preview.url)).then((response) => response.json());
    assert.equal(summary.summary.totals.total, FIXTURE_TOTAL_TOKENS);
  } finally {
    await preview.close();
    await fixture.close();
  }
});

test("超限请求（复核更正）：>10MB body 在发送结束前就收到明确 413，服务随后仍可用", async () => {
  const fixture = await createPaletteFixture();
  const preview = await startCandidatePreview({ candidate: null, fixture });
  try {
    const { port } = new URL(preview.url);
    const oversized = await Promise.race([
      postOversizedBody(Number(port), "/api/imports", 12 * 1024 * 1024),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("413 未在 body 结束前到达：疑似缓冲后检查而非丢弃模式")),
          15_000,
        );
        timer.unref?.();
      }),
    ]);
    assert.equal(oversized.status, 413, "超限必须拿到 HTTP 413，不能是连接重置");
    // 后续服务可用：超限处理不得拖垮实例
    const usage = await fetch(new URL("/api/usage", preview.url)).then((response) => response.json());
    assert.equal(usage.metadata.eventCount, FIXTURE_EVENT_COUNT, "超限之后实例必须继续正常服务");
  } finally {
    await preview.close();
    await fixture.close();
  }
});

test("内存生成器纯度：同一候选重复生成逐字相同，且不改写共享的生产模块对象", async () => {
  const candidate = previewCandidate();
  const productionSnapshot = JSON.stringify(SKIN_PALETTES.chatgpt);
  const first = buildSkinPalettesModuleSource(candidate);
  const second = buildSkinPalettesModuleSource(candidate);
  assert.equal(first, second, "生成必须纯净可复现");
  assert.equal(JSON.stringify(SKIN_PALETTES.chatgpt), productionSnapshot, "生产对象不得被改写");
  const bootstrapFirst = buildSkinBootstrapModuleSource(candidate);
  const bootstrapSecond = buildSkinBootstrapModuleSource(candidate);
  assert.equal(bootstrapFirst, bootstrapSecond);
  assert.ok(bootstrapFirst.includes("const CONFIG"), "bootstrap 生成走 M1.2 发射器");
});

// ---------------------------------------------------------------------------
// M4.2 首屏和基准截图（capture.mjs）
// ---------------------------------------------------------------------------

test("指标文本解析：分组数字、K/M/B/T 后缀、未渲染占位与垃圾输入", () => {
  assert.equal(parseMetricNumber("242,800"), 242800);
  assert.equal(parseMetricNumber("1,234"), 1234);
  assert.equal(parseMetricNumber("0.5M"), 500_000);
  assert.equal(parseMetricNumber("1.5K"), 1_500);
  assert.equal(parseMetricNumber("1.2B"), 1.2e9);
  assert.equal(parseMetricNumber("12"), 12);
  assert.equal(parseMetricNumber("0"), 0);
  assert.equal(parseMetricNumber("0.00M"), 0);
  assert.equal(parseMetricNumber("-"), null, "未渲染占位不得当作零值就绪");
  assert.equal(parseMetricNumber(""), null);
  assert.equal(parseMetricNumber("abc"), null);
  assert.equal(parseMetricNumber(null), null);
});

test("偏好播种：键空才写、重载不重写（不掩盖偏好恢复失败）、隐藏皮肤 ID 合法", () => {
  const source = buildPreferenceSeedSource({ theme: "dark", skinId: "grok" });
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  vm.runInNewContext(source, { localStorage });
  assert.equal(store.get("codexUsageTheme"), "dark");
  assert.deepEqual(JSON.parse(store.get("codexUsageSkinV1")), {
    version: 1,
    skinId: "grok",
    showCharacters: true,
    opacity: 0.5,
  });
  assert.equal(store.get("codexUsageAutoRefresh"), "off");
  // 重载：已有值一律保留——播种逻辑不得重写用户偏好
  store.set("codexUsageTheme", "light");
  store.set("codexUsageSkinV1", JSON.stringify({ version: 1, skinId: "kimi", showCharacters: false, opacity: 0.8 }));
  store.set("codexUsageAutoRefresh", "on");
  vm.runInNewContext(source, { localStorage });
  assert.equal(store.get("codexUsageTheme"), "light");
  assert.equal(JSON.parse(store.get("codexUsageSkinV1")).skinId, "kimi");
  assert.equal(store.get("codexUsageAutoRefresh"), "on");
  assert.throws(() => buildPreferenceSeedSource({ theme: "purple", skinId: "grok" }), TypeError);
  assert.throws(() => buildPreferenceSeedSource({ theme: "dark", skinId: "" }), TypeError);
});

test("声明对比：颜色大小写不敏感，missing/mismatch/unexpected 逐项报出", () => {
  const expected = [
    ["--bg", "#AABBCC"],
    ["--ink", "#10151A"],
    ["--ceramic-light", "rgba(243, 246, 252, 0.6)"],
  ];
  assert.deepEqual(
    diffPaletteDeclarations(expected, {
      "--bg": "#aabbcc",
      "--ink": "#10151A",
      "--ceramic-light": "rgba(243, 246, 252, 0.6)",
    }),
    [],
  );
  const diffs = diffPaletteDeclarations(expected, {
    "--bg": "#000000",
    "--ink": "#10151A",
    "--ceramic-light": "rgba(243, 246, 252, 0.6)",
    "--extra": "#ffffff",
  });
  assert.deepEqual(
    diffs.map((diff) => [diff.name, diff.kind]).sort(),
    [
      ["--bg", "mismatch"],
      ["--extra", "unexpected"],
    ].sort(),
  );
  const missing = diffPaletteDeclarations(expected, {
    "--ink": "#10151A",
    "--ceramic-light": "rgba(243, 246, 252, 0.6)",
  });
  assert.deepEqual(
    missing.map((diff) => [diff.name, diff.kind]),
    [["--bg", "missing"]],
  );
});

test("成功判定：被记录的错误类逐项阻断，无允许忽略清单", () => {
  const clean = {
    pageErrors: [],
    consoleErrors: [],
    requestFailed: [],
    resourceFailures: [],
    blockedExternal: [],
  };
  assert.deepEqual(
    buildResourceBlockers(clean, { moduleRequestCount: 1, charactersReady: true }),
    [],
    "干净记录不得产生阻断",
  );
  // 每个错误类单独出现都必须阻断（复核更正 1：错误只记账不阻断曾是成功判定缺陷）
  assert.ok(
    buildResourceBlockers(
      { ...clean, pageErrors: ["Uncaught TypeError: x"] },
      { moduleRequestCount: 1, charactersReady: true },
    ).some((blocker) => blocker.includes("未捕获异常") && blocker.includes("Uncaught TypeError: x")),
  );
  assert.ok(
    buildResourceBlockers(
      { ...clean, consoleErrors: ["Failed to load resource"] },
      { moduleRequestCount: 1, charactersReady: true },
    ).some((blocker) => blocker.includes("console 错误")),
  );
  assert.ok(
    buildResourceBlockers(
      { ...clean, requestFailed: [{ url: "u", error: "net::ERR_FAILED" }] },
      { moduleRequestCount: 1, charactersReady: true },
    ).some((blocker) => blocker.includes("请求失败") && blocker.includes("net::ERR_FAILED")),
  );
  assert.ok(
    buildResourceBlockers(
      { ...clean, resourceFailures: [{ url: "u", status: 404 }] },
      { moduleRequestCount: 1, charactersReady: true },
    ).some((blocker) => blocker.includes("≥400") && blocker.includes("404")),
  );
  assert.ok(
    buildResourceBlockers(clean, { moduleRequestCount: 0, charactersReady: true }).some((blocker) =>
      blocker.includes("模块请求未被捕获到"),
    ),
  );
  assert.ok(
    buildResourceBlockers(clean, { moduleRequestCount: 1, charactersReady: false }).some((blocker) =>
      blocker.includes("角色图片未全部解码"),
    ),
  );
  // blockedExternal 是设计行为（外网请求被主动阻断记账），不在阻断清单——但错误类
  // 全为空时它也不该被当成"允许忽略的错误"放行进 blockers 文案
  const withExternal = buildResourceBlockers(
    { ...clean, blockedExternal: ["https://example.com/x"] },
    { moduleRequestCount: 1, charactersReady: true },
  );
  assert.deepEqual(withExternal, []);
});

// 接线金丝雀：captureMode 内部必须走布尔等待源常量并重读最终状态。A 层探针测试
// 盖不到 captureMode 接线（复核更正 4 的坏表达式就藏在接线里），回退验证要求这里
// 对旧坏表达式的复原保持敏感
test("角色图片等待接线：captureMode 使用等待源常量，旧坏表达式不得回流", async () => {
  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  assert.ok(
    captureSource.includes("page.waitForFunction(CHARACTERS_READY_WAIT_SOURCE"),
    "captureMode 必须用 CHARACTERS_READY_WAIT_SOURCE 等待角色图片",
  );
  assert.ok(
    !/\(\$\{buildCharactersReadySource\(\)\}\)\(\)/.test(captureSource),
    "不得内联旧坏表达式（把已执行的 IIFE 返回对象再次当函数调用）",
  );
  assert.ok(
    /characters = await page\.evaluate\(buildCharactersReadySource\(\)\);/.test(captureSource),
    "等待后必须重读最终状态更新 readiness.characters",
  );
});

test("角色图片等待源：布尔判定语义，延迟就绪后翻真；探针对象报告最终状态", () => {
  const makeImage = (loaded) => ({
    getAttribute: (name) => (name === "src" ? "/skins/chatgpt/side.webp" : null),
    dataset: { loaded: loaded ? "1" : "0" },
    complete: loaded,
    naturalWidth: loaded ? 120 : 0,
  });
  const images = [makeImage(false), makeImage(false)];
  const sandbox = {
    document: { querySelectorAll: (selector) => (selector === "#skinCharacters img" ? images : []) },
  };
  // 等待源必须返回布尔且未就绪时为 false——旧实现把已执行的 IIFE 返回对象再次当
  // 函数调用，页内直接抛 TypeError（表现为"15 秒未就绪"）
  assert.equal(vm.runInNewContext(CHARACTERS_READY_WAIT_SOURCE, sandbox), false, "未解码时等待源必须保持 false");
  images[0] = makeImage(true);
  assert.equal(vm.runInNewContext(CHARACTERS_READY_WAIT_SOURCE, sandbox), false, "部分解码仍须等待");
  images[1] = makeImage(true);
  assert.equal(vm.runInNewContext(CHARACTERS_READY_WAIT_SOURCE, sandbox), true, "延迟解码完成后必须翻真");
  const probe = vm.runInNewContext(buildCharactersReadySource(), sandbox);
  // vm 对象跨 realm，deepStrictEqual 会因原型不同误报——逐字段断言
  assert.equal(probe.ready, true, "探针对象必须报告最终状态 ready");
  assert.equal(probe.total, 2);
  assert.equal(probe.loaded, 2);
  // 无装饰层不阻塞但说明原因
  const empty = vm.runInNewContext(buildCharactersReadySource(), {
    document: { querySelectorAll: () => [] },
  });
  assert.equal(empty.ready, true);
  assert.equal(empty.note, "no-decoration-layer");
});

test("源摘要覆盖 M3.4 必需集与捕获链路自身依赖（直接断言常量内容）", () => {
  const timelineFile = "public/timeline-utils.js";
  assert.equal(REQUIRED_SOURCE_FILES.length, 26);
  assert.equal(SOURCE_FILES.length, 31);
  assert.equal(new Set(REQUIRED_SOURCE_FILES).size, REQUIRED_SOURCE_FILES.length);
  assert.equal(new Set(SOURCE_FILES).size, SOURCE_FILES.length);
  const focusFiles = [
    "scripts/skin-palette/focus-outline-pixels.mjs",
    "scripts/skin-palette/focus-outline-browser.mjs",
  ];
  const detailFiles = [
    "scripts/skin-palette/detail-bar-capture.mjs",
    "scripts/skin-palette/detail-bar-frame-analysis.mjs",
    "scripts/skin-palette/detail-bar-pixels.mjs",
    "scripts/skin-palette/detail-bar-browser.mjs",
    "scripts/skin-palette/detail-bar-hit-browser.mjs",
    "scripts/skin-palette/detail-bar-paint-browser.mjs",
  ];
  for (const files of [REQUIRED_SOURCE_FILES, SOURCE_FILES]) {
    const browserIndex = files.indexOf("scripts/skin-palette/browser-measure.mjs");
    assert.deepEqual(files.slice(browserIndex + 1, browserIndex + 3), focusFiles);
  }
  for (const file of detailFiles) {
    for (const files of [REQUIRED_SOURCE_FILES, SOURCE_FILES]) {
      assert.equal(files.filter((entry) => entry === file).length, 1, `${file} 必须唯一登记`);
    }
  }
  assert.equal(REQUIRED_SOURCE_FILES.filter((file) => file === timelineFile).length, 1);
  assert.equal(SOURCE_FILES.filter((file) => file === timelineFile).length, 1);
  for (const file of REQUIRED_SOURCE_FILES) {
    assert.ok(SOURCE_FILES.includes(file), `源摘要必须覆盖 M3.4 必需文件 ${file}`);
  }
  const sourceHashes = collectSourceHashes(SOURCE_FILES, (relativePath) =>
    readFileSync(new URL(`../${relativePath}`, import.meta.url)),
  );
  for (const file of [...focusFiles, ...detailFiles]) {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.equal(
      sourceHashes[file],
      createHash("sha256").update(bytes).digest("hex"),
      `${file} must hash actual disk bytes`,
    );
  }
  assert.equal(
    sourceHashes[timelineFile],
    createHash("sha256")
      .update(readFileSync(new URL(`../${timelineFile}`, import.meta.url)))
      .digest("hex"),
    "capture 的真实原始字节集合必须登记当前 timeline-utils.js SHA-256",
  );
  for (const own of [
    "public/skin-bootstrap.js",
    "public/i18n.js",
    "scripts/skin-palette/bootstrap-source.mjs",
    "scripts/skin-palette/preview-server.mjs",
    "scripts/skin-palette/capture.mjs",
  ]) {
    assert.ok(SOURCE_FILES.includes(own), `源摘要必须覆盖捕获链路自身依赖 ${own}`);
  }
});

test("捕获输出目录：必须位于 docs/validation 下的空新目录，已有证据不覆盖", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-capture-dir-"));
  try {
    const okDir = path.join(sandbox, "docs", "validation", "run-a", "capture-1");
    const resolved = await assertCaptureOutputDir(okDir, sandbox);
    assert.equal(path.resolve(resolved), path.resolve(okDir));
    await assert.rejects(() => assertCaptureOutputDir(path.join(sandbox, "docs", "plans", "x"), sandbox), /必须位于/);
    await assert.rejects(() => assertCaptureOutputDir(path.join(sandbox, "src", "out"), sandbox), /必须位于/);
    await assert.rejects(
      () => assertCaptureOutputDir(path.join(sandbox, "docs", "validation"), sandbox),
      /必须位于/,
      "validation 根目录本身不能当捕获目录",
    );
    await writeFile(path.join(okDir, "existing.txt"), "x", "utf8");
    await assert.rejects(() => assertCaptureOutputDir(okDir, sandbox), /空的新目录/);

    // junction（目录连接点）指向校验根之外：词法看着合法，真实路径现形（复核更正 3）
    const outside = path.join(sandbox, "outside-real");
    await mkdir(outside, { recursive: true });
    const junction = path.join(sandbox, "docs", "validation", "jn");
    await symlink(outside, junction, "junction");
    await assert.rejects(
      () => assertCaptureOutputDir(junction, sandbox),
      /真实路径越出校验根/,
      "junction 本身当捕获目录必须被真实路径检查拦下",
    );
    await assert.rejects(
      () => assertCaptureOutputDir(path.join(junction, "capture"), sandbox),
      /真实路径越出校验根/,
      "junction 之下的新目录同样越界",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("captureBaseline 输入校验在启动任何服务之前报错，fixture 不被触碰", async () => {
  const fixture = await createPaletteFixture();
  try {
    const candidate = previewCandidate();
    await assert.rejects(() => captureBaseline({ fixture, outDir: "unused", modes: ["light", "light"] }), /modes/);
    await assert.rejects(() => captureBaseline({ fixture, outDir: "unused", modes: ["purple"] }), /未知模式/);
    await assert.rejects(() => captureBaseline({ fixture, outDir: "unused", candidate, skinId: "kimi" }), /不一致/);
    await assert.rejects(() => captureBaseline({ fixture, outDir: "unused", candidate: null, skinId: null }), /skinId/);
    await assert.rejects(
      () => captureBaseline({ fixture, outDir: "unused", candidate: null, skinId: "classic" }),
      /skinId/,
    );
  } finally {
    await fixture.close();
  }
});

test("S0 fullPage 接线结构断言（不执行浏览器或 fixture）", async () => {
  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  assert.match(
    captureSource,
    /import\s*\{[^}]*\bcaptureStableFullPage\b[^}]*\}\s*from\s*["']\.\/browser-measure\.mjs["']/,
  );
  assert.doesNotMatch(
    captureSource,
    /page\.screenshot\(\{[^}]*\bfullPage\s*:\s*true\b[^}]*\}\)/s,
    "capture.mjs 不得残留 raw fullPage 调用",
  );
  assert.equal(captureSource.match(/captureStableFullPage\(page\)/g)?.length, 1, "S0 只接入一次共享 helper");

  const callAt = captureSource.indexOf("const shot = await captureStableFullPage(page);");
  assert.notEqual(callAt, -1);
  const statusAt = captureSource.indexOf('const status = blockers.length === 0 ? "captured" : "failed";', callAt);
  assert.ok(statusAt > callAt, "S0 状态必须在截图异常加入 blockers 后判定");
  const baselineFlow = captureSource.slice(callAt, statusAt);
  assert.match(
    baselineFlow,
    /evidence\.baseline = await saveScreenshotBuffer\(path\.join\(outModeDir, "baseline\.png"\), shot\);/,
    "整页 Buffer 仍保存到原 baseline.png 附件路径",
  );
  assert.match(baselineFlow, /catch \(error\) \{\s*blockers\.push\(`基准整页截图失败：/, "helper 异常仍进入 blocker");
});

function pngDimensions(buffer) {
  assert.ok(buffer.length > 24, "PNG 过小，不是有效截图");
  assert.equal(buffer.readUInt32BE(0), 0x89504e47, "必须是 PNG 签名");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test("M4.2 真机捕获：一候选两模式首屏/运行时颜色一致，基准截图、测量与元数据齐备", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  const watched = ["skin-palettes.js", "skin-bootstrap.js"];
  const before = {};
  for (const name of watched) {
    before[name] = sha256(await readFile(path.join("public", name)));
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-capture-c1-"));
  try {
    const candidate = previewCandidate();
    // 复核更正 2 回归：入口同步快照后，调用方对象跨 await 的改动不得进入任何证据。
    // 篡改保持"合法候选"形态（改 token 后重算 candidateHash、重派生 id），复现复核
    // 场景：旧实现下服务会按篡改后的候选供色、capture.json 也会登记篡改后的 ID
    const originalId = candidate.id;
    const originalHash = candidate.candidateHash;
    const pending = captureBaseline({
      candidate,
      fixture,
      outDir: path.join(sandbox, "docs", "validation", "m42", "candidate"),
      rootDir: sandbox,
    });
    candidate.modes.dark.accent = "#010203";
    candidate.candidateHash = hashCandidate(candidate);
    candidate.id = `${candidate.skinId}-${candidate.variant}-${candidate.candidateHash.slice(0, 12)}`;
    const result = await pending;
    assert.notEqual(candidate.id, originalId, "篡改必须真实发生，否则本回归无证明力");
    assert.equal(result.skinId, "chatgpt");
    for (const mode of ["light", "dark"]) {
      const modeResult = result.modes[mode];
      assert.equal(
        modeResult.status,
        "captured",
        `${mode} 必须完整捕获；blockers: ${JSON.stringify(modeResult.blockers)}`,
      );
      assert.deepEqual(modeResult.errors.pageErrors, [], `${mode} 不得有页面错误`);
      assert.deepEqual(modeResult.errors.consoleErrors, [], `${mode} 不得有 console 错误`);
      assert.deepEqual(modeResult.errors.requestFailed, [], `${mode} 必要资源不得加载失败`);
      assert.deepEqual(modeResult.errors.resourceFailures, [], `${mode} 不得有 ≥400 响应`);
      assert.deepEqual(modeResult.errors.blockedExternal, [], `${mode} 不应出现外网请求尝试`);
      assert.equal(modeResult.moduleRequestCount, 1, "app.js 模块请求必须被扣住并放行恰好一次");
      assert.ok(modeResult.pricingRefreshInterceptions >= 1, "计价 refresh 必须被开发 route 拦截为无变化");
      assert.ok(modeResult.firstScreenMatches, `${mode} 首屏声明必须与 M1.1 派生一致`);
      assert.ok(modeResult.runtimeMatches, `${mode} 运行时声明必须与 M1.1 派生一致`);
      assert.ok(modeResult.firstScreenMatchesRuntime, `${mode} 首屏与运行时颜色必须配对`);
    }

    const firstLight = JSON.parse(await readFile(path.join(result.outDir, "light", "first-screen.json"), "utf8"));
    assert.equal(Object.keys(firstLight.actual).length, 20, "必须读取全部 20 项声明");
    assert.equal(firstLight.dataset.skin, "chatgpt");
    assert.equal(firstLight.dataset.theme, "light");
    assert.equal(firstLight.dataset.skinBootstrap, "1");
    assert.ok(firstLight.unrenderedMetrics > 0, "首屏必须拍到模块扣住状态（指标仍为占位符 '-'）");
    assert.ok(firstLight.stylesheets.includes("/styles.css"));
    assert.ok(firstLight.stylesheets.includes("/skins.css"));

    const colorsDark = JSON.parse(await readFile(path.join(result.outDir, "dark", "colors.json"), "utf8"));
    assert.equal(colorsDark.runtimeMatchesExpected, true);
    assert.equal(colorsDark.firstScreenMatchesRuntime, true);
    assert.equal(colorsDark.dataset.theme, "dark");
    assert.equal(colorsDark.dataset.skin, "chatgpt");

    const firstPng = await readFile(path.join(result.outDir, "light", "first-screen.png"));
    assert.deepEqual(pngDimensions(firstPng), { width: 1920, height: 1080 }, "首屏截图必须是基准视口原尺寸");
    const baselinePng = await readFile(path.join(result.outDir, "dark", "baseline.png"));
    const dims = pngDimensions(baselinePng);
    assert.equal(dims.width, 1920);
    assert.ok(dims.height >= 1080, "基准整页截图高度必须覆盖视口");
    assert.ok(baselinePng.length > 100_000, "基准整页截图必须是非平凡内容（真实非零页面）");

    const layout = JSON.parse(await readFile(path.join(result.outDir, "dark", "layout.json"), "utf8"));
    assert.ok(layout.elements.topbar.rect.height > 0, "topbar 几何必须真实");
    assert.ok(layout.elements.chart.rect.width > 0, "图表几何必须真实");
    assert.ok(layout.artwork.length >= 2, "角色 artwork（side/front）必须存在");
    assert.ok(layout.artwork.every((item) => item.rect && item.rect.width > 0));

    const checks = JSON.parse(await readFile(path.join(result.outDir, "light", "checks.json"), "utf8"));
    assert.equal(checks.stateId, "dashboard-default");
    assert.ok(Array.isArray(checks.records) && checks.records.length > 0, "M3 测量记录不得为空");
    for (const record of checks.records) {
      assert.equal(record.candidateId, originalId, "测量记录必须归属入口快照的候选（而非被篡改后的对象）");
    }
    assert.ok(checks.captureIndex.length > 0, "测量截图索引不得为空");

    const meta = JSON.parse(await readFile(path.join(result.outDir, "capture.json"), "utf8"));
    assert.equal(meta.candidate.id, originalId, "元数据必须登记入口快照的候选 ID");
    assert.equal(meta.candidate.candidateHash, originalHash, "元数据必须登记入口快照的候选哈希");
    for (const file of REQUIRED_SOURCE_FILES) {
      assert.ok(meta.sourceHashes[file], `运行证据摘要必须覆盖 M3.4 必需文件 ${file}`);
    }
    const timelineFile = "public/timeline-utils.js";
    assert.equal(
      meta.sourceHashes[timelineFile],
      createHash("sha256")
        .update(await readFile(new URL(`../${timelineFile}`, import.meta.url)))
        .digest("hex"),
      "捕获元数据必须绑定当前时间线源码的实际字节",
    );
    assert.equal(meta.fixtureHash, fixture.fixtureHash);
    assert.ok(meta.sourceHashes["public/app.js"], "运行证据必须覆盖实际加载的页面文件");
    assert.equal(meta.environment.viewport.width, 1920);
    assert.equal(meta.environment.viewport.height, 1080);

    for (const name of watched) {
      assert.equal(sha256(await readFile(path.join("public", name))), before[name], `${name} 全程不得被改写`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

test("M4.2 真机捕获：正式色源模式（candidate=null）保存皮肤旧颜色对照", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-capture-c2-"));
  try {
    const result = await captureBaseline({
      candidate: null,
      skinId: "chatgpt",
      fixture,
      outDir: path.join(sandbox, "docs", "validation", "m42", "production"),
      rootDir: sandbox,
      modes: ["light"],
      measureRoles: false,
    });
    assert.equal(result.modes.light.status, "captured", `blockers: ${JSON.stringify(result.modes.light.blockers)}`);
    const first = JSON.parse(await readFile(path.join(result.outDir, "light", "first-screen.json"), "utf8"));
    assert.equal(first.matches, true, "正式模式页面颜色必须与生产派生一致（对照基线可信）");
    assert.equal(first.dataset.skin, "chatgpt");
    const meta = JSON.parse(await readFile(path.join(result.outDir, "capture.json"), "utf8"));
    assert.equal(meta.candidate.production, true);
    assert.equal(meta.candidate.skinId, "chatgpt");
    assert.equal(
      existsSync(path.join(result.outDir, "light", "checks.json")),
      false,
      "measureRoles=false 时不产出测量文件",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------
// M4.3 状态矩阵与可恢复执行（capture.mjs）
// ---------------------------------------------------------------------------

const ALL_MATRIX_UNITS = STATE_MATRIX_GROUPS.flatMap((group) => group.units);
const matrixGroup = (id) => STATE_MATRIX_GROUPS.find((group) => group.id === id);

async function createCaptureMatrixEntryProbe({
  savedProgress = null,
  failures = {},
  outDir = "E:/docs/validation/probe-run",
  candidateSnapshot: candidateSnapshotOverride = null,
  readUnitEvidence = null,
  modeRunner = null,
} = {}) {
  const source = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const unitsStart = source.indexOf("function effectiveMatrixUnits(groupIds) {");
  const unitsEnd = source.indexOf("\n}\n\n/** 状态覆盖率", unitsStart) + 2;
  const entryStart = source.indexOf("export async function captureStateMatrix({");
  const entryEnd = source.indexOf("\n}\n\nfunction extractUsageTotalTokens", entryStart) + 2;
  assert.ok(unitsStart >= 0 && unitsEnd > unitsStart && entryStart >= 0 && entryEnd > entryStart);

  const baseFixture = { fixtureHash: getPaletteFixtureHash(), pickedPath: "base-picked-path" };
  const warningFixture = { fixtureHash: getTimelineWarningFixtureHash(), pickedPath: "warning-picked-path" };
  const candidateHash = "a".repeat(64);
  const candidateSnapshot = candidateSnapshotOverride ?? {
    id: `chatgpt-a-${candidateHash.slice(0, 12)}`,
    candidateHash,
    skinId: "chatgpt",
    variant: "a",
    profileHash: "b".repeat(64),
    policyHash: sha256Canonical(POLICY),
    derivationHash: "c".repeat(64),
  };
  const calls = { previews: [], previewCloses: [], browserLaunches: 0, writes: [], modeCalls: [] };
  const runtime = {
    executablePath: "stub-edge",
    chromium: {
      launch: async () => {
        calls.browserLaunches += 1;
        if (failures.browserStart) throw failures.browserStart;
        return {
          version: async () => "stub-browser",
          close: async () => {
            calls.previewCloses.push("browser");
            if (failures.browserClose) throw failures.browserClose;
          },
        };
      },
    },
  };
  const sandbox = {
    BASELINE_UNIT_ID: "baseline",
    BASELINE_STATE_ID: "dashboard-default",
    BASE_VIEWPORT: { width: 1920, height: 1080 },
    CAPTURE_MATRIX_KIND: "skin-palette-capture-matrix",
    DESKTOP_VIEWPORTS: [],
    JSON,
    MATRIX_RETRY_POLICY: { version: 1, maxAttemptsPerUnit: 2 },
    MATRIX_UNTESTED: [],
    MODES: ["light", "dark"],
    POLICY,
    PROGRESS_KIND: "skin-palette-capture-progress",
    REPO_ROOT: "E:/repo",
    SOURCE_FILES,
    STATE_BY_ID: new Map(STATE_CATALOG.map((state) => [state.id, state])),
    STATE_MATRIX_GROUPS,
    assertCaptureOutputDir: async (outDir) => outDir,
    assertFixedMatrixFixtureBindings,
    buildFixedMatrixFixtureBindings,
    captureStateMatrixMode: async (args) => {
      calls.modeCalls.push(args);
      if (failures.mode) throw failures.mode;
      if (modeRunner) return modeRunner(args);
      return { status: "incomplete", blockers: ["offline mode stub"], gaps: [], baseline: null, states: {} };
    },
    closeCaptureMatrixResources,
    collectSourceHashes: () => ({ "scripts/skin-palette/capture.mjs": "stub-source-hash" }),
    deriveExpectedPairs: () => ({ light: [], dark: [] }),
    describeMatrixCoverage: () => new Map(),
    describeResumeDigestDifferences: () => ["fixtureBindings"],
    existsSync: () => savedProgress !== null,
    getPaletteFixtureHash,
    getTimelineWarningFixtureHash,
    mkdir: async () => {},
    path,
    process,
    readCapturedBaselineEvidence: async () => {},
    readCapturedUnitEvidence: readUnitEvidence ?? (async () => ({ roleScopeGaps: [] })),
    readFile: async () => JSON.stringify(savedProgress),
    readFileSync: () => Buffer.alloc(0),
    resolveBrowserRuntime: async () => null,
    resumeDigestsMatch: (saved, current) =>
      resumeDigestsMatch(JSON.parse(JSON.stringify(saved)), JSON.parse(JSON.stringify(current))),
    sha256Canonical,
    snapshotCaptureCandidate: () => ({ productionMode: false, skinId: "chatgpt", candidateSnapshot }),
    startCandidatePreview: async ({ candidate, fixture, port }) => {
      const isWarning = fixture === warningFixture;
      const domain = isWarning ? "warning" : "base";
      calls.previews.push({ domain, candidate, fixture, port });
      if (isWarning && failures.warningPreviewStart) throw failures.warningPreviewStart;
      return {
        url: isWarning ? "http://warning.invalid/" : "http://base.invalid/",
        close: async () => {
          calls.previewCloses.push(domain);
          const failure = isWarning ? failures.warningPreviewClose : failures.basePreviewClose;
          if (failure) throw failure;
        },
      };
    },
    writeJson: async (file, data) => calls.writes.push({ file, data: JSON.parse(JSON.stringify(data)) }),
  };
  const functionSource = `${source.slice(unitsStart, unitsEnd)}\n${source.slice(entryStart, entryEnd).replace("export async function", "async function")}`;
  const captureStateMatrix = vm.runInNewContext(`${functionSource}\ncaptureStateMatrix`, sandbox);

  return {
    baseFixture,
    warningFixture,
    candidateSnapshot,
    calls,
    async run(overrides = {}) {
      return captureStateMatrix({
        candidate: candidateSnapshot,
        fixture: baseFixture,
        outDir,
        rootDir: "E:/repo",
        browserRuntime: runtime,
        modes: ["light"],
        groups: ["S0", "S8"],
        ...overrides,
      });
    },
  };
}

async function createCapturedMatrixResumeModeProbe() {
  const source = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function captureStateMatrixMode({");
  const end = source.indexOf("\n}\n\n/**\n * M4.3 状态矩阵与可恢复执行入口", start) + 2;
  assert.ok(start >= 0 && end > start, "probe must execute the actual captured-unit resume branch");
  const calls = { contexts: 0, baselines: 0 };
  const sandbox = {
    BASELINE_UNIT_ID: "baseline",
    MAX_MATRIX_ATTEMPTS_PER_UNIT: 2,
    POLICY,
    STATE_BY_ID: new Map(STATE_CATALOG.map((state) => [state.id, state])),
    buildMatrixCaptureSequences,
    createModeContext: async (args) => {
      calls.contexts += 1;
      return { ...args, close: async () => {} };
    },
    path,
    runBaselineCapture: async () => {
      calls.baselines += 1;
      return {
        status: "captured",
        blockers: [],
        moduleRequestCount: 0,
        pricingRefreshInterceptions: 0,
        firstScreenMatches: true,
        runtimeMatches: true,
        durationMs: 0,
        evidence: null,
      };
    },
    runStateUnit: async () => {
      throw new Error("resume synthetic gap test must skip captured units, not recapture");
    },
    writeUnitEvidence: async () => {
      throw new Error("resume synthetic gap test must preserve existing evidence");
    },
  };
  return { run: vm.runInNewContext(`${source.slice(start, end)}\ncaptureStateMatrixMode`, sandbox), calls };
}

test("D8u1：固定绑定覆盖完整组与指定子集，且结果不可变", () => {
  const baseHash = getPaletteFixtureHash();
  const warningHash = getTimelineWarningFixtureHash();
  const groups = STATE_MATRIX_GROUPS.map((group) => group.id);
  const originalGroups = [...groups];
  const bindings = buildFixedMatrixFixtureBindings({ groups, fixtureHash: baseHash, warningFixtureHash: warningHash });

  assert.deepEqual(Object.keys(bindings), groups);
  assert.deepEqual(bindings.S0, { fixtureKind: "base", fixtureHash: baseHash });
  assert.deepEqual(bindings.D, { fixtureKind: "base", fixtureHash: baseHash });
  assert.deepEqual(bindings.S8, { fixtureKind: "timeline-range-warning", fixtureHash: warningHash });
  assert.equal(Object.isFrozen(bindings), true);
  for (const binding of Object.values(bindings)) assert.equal(Object.isFrozen(binding), true);
  assert.deepEqual(groups, originalGroups);
  assert.equal(
    assertFixedMatrixFixtureBindings({ groups, fixtureHash: baseHash, fixtureBindings: bindings }),
    undefined,
  );

  const subset = ["D", "S8", "S0"];
  const subsetBindings = buildFixedMatrixFixtureBindings({
    groups: subset,
    fixtureHash: baseHash,
    warningFixtureHash: warningHash,
  });
  assert.deepEqual(Object.keys(subsetBindings), subset);
  assert.deepEqual(subsetBindings.S0, { fixtureKind: "base", fixtureHash: baseHash });
  assert.deepEqual(subsetBindings.D, { fixtureKind: "base", fixtureHash: baseHash });
  assert.deepEqual(subsetBindings.S8, { fixtureKind: "timeline-range-warning", fixtureHash: warningHash });
});

test("D8u1：构造器拒绝非法组与缺失、错误或交换的 fixture 摘要", () => {
  const fixtureHash = getPaletteFixtureHash();
  const warningFixtureHash = getTimelineWarningFixtureHash();
  const reject = (groups, base = fixtureHash, warning = warningFixtureHash) =>
    assert.throws(
      () => buildFixedMatrixFixtureBindings({ groups, fixtureHash: base, warningFixtureHash: warning }),
      TypeError,
    );

  reject([]);
  reject(null);
  reject(["unknown"]);
  reject(["S0", "S0"]);
  reject(["S0", 8]);
  reject(["S0"], "0".repeat(64), warningFixtureHash);
  reject(["S0"], fixtureHash, fixtureHash);
  reject(["S0"], warningFixtureHash, fixtureHash);
  assert.throws(() => buildFixedMatrixFixtureBindings({ groups: ["S0"], warningFixtureHash }), TypeError);
  assert.throws(() => buildFixedMatrixFixtureBindings({ groups: ["S0"], fixtureHash }), TypeError);
});

test("D8u1：断言器拒绝不精确的组键、记录形态、字段、种类与摘要", () => {
  const fixtureHash = getPaletteFixtureHash();
  const warningFixtureHash = getTimelineWarningFixtureHash();
  const groups = ["S0", "S8", "D"];
  const valid = buildFixedMatrixFixtureBindings({ groups, fixtureHash, warningFixtureHash });
  const reject = (fixtureBindings, actualGroups = groups, actualHash = fixtureHash) =>
    assert.throws(
      () => assertFixedMatrixFixtureBindings({ groups: actualGroups, fixtureHash: actualHash, fixtureBindings }),
      TypeError,
    );

  const unchanged = structuredClone(valid);
  assert.equal(assertFixedMatrixFixtureBindings({ groups, fixtureHash, fixtureBindings: valid }), undefined);
  assert.deepEqual(valid, unchanged);
  reject(null);
  reject([]);
  reject(new (class BindingMap {})());
  reject(Object.assign(Object.create(null), valid));
  reject({ S0: valid.S0, S8: valid.S8 });
  reject({ ...valid, extra: valid.S0 });
  reject({ ...valid, S8: null });
  reject({ ...valid, S8: ["timeline-range-warning", warningFixtureHash] });
  reject({ ...valid, S8: { ...valid.S8, extra: true } });
  reject({ ...valid, S8: { fixtureHash: warningFixtureHash } });
  reject({ ...valid, S8: { fixtureKind: "base", fixtureHash } });
  reject({ ...valid, S0: { fixtureKind: "timeline-range-warning", fixtureHash: warningFixtureHash } });
  reject({ ...valid, S8: { fixtureKind: "timeline-range-warning", fixtureHash: fixtureHash } });
  reject({ ...valid, S0: { fixtureKind: "base", fixtureHash: warningFixtureHash } });
  reject(valid, ["S0", "S8", "S8"]);
  reject(valid, ["S0", "unknown", "D"]);
  reject(valid, groups, "0".repeat(64));
  assert.throws(() => assertFixedMatrixFixtureBindings({ groups, fixtureBindings: valid }), TypeError);
});

test("D8u2A：实际 mode 按数据域选 URL/hash，S8 warm-up 不测量或覆盖 S0", async () => {
  const source = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function captureStateMatrixMode({");
  const end = source.indexOf("\n}\n\n/**\n * M4.3 状态矩阵与可恢复执行入口", start) + 2;
  assert.ok(start >= 0 && end > start, "probe extracts and executes the real private matrix-mode function");

  const baseUrl = "http://base.test/";
  const warningUrl = "http://warning.test/";
  const baseHash = getPaletteFixtureHash();
  const warningHash = getTimelineWarningFixtureHash();
  const groups = ["S8", "D", "S1", "S0"];
  const bindings = buildFixedMatrixFixtureBindings({ groups, fixtureHash: baseHash, warningFixtureHash: warningHash });
  const baseline = { ...matrixGroup("S0").units[0], group: "S0" };
  const warning = { ...matrixGroup("S8").units[0], group: "S8" };
  const ordinary = { ...matrixGroup("S1").units[0], group: "S1" };
  const desktop = { ...matrixGroup("D").units[0], group: "D" };
  const units = [warning, desktop, ordinary, baseline];
  const contexts = [];
  const baselineCalls = [];
  const attempts = [];
  const evidenceManifests = [];
  const progress = { units: {}, attempts: [] };
  const sandbox = {
    BASELINE_UNIT_ID: "baseline",
    MAX_MATRIX_ATTEMPTS_PER_UNIT: 2,
    POLICY,
    STATE_BY_ID: new Map(STATE_CATALOG.map((state) => [state.id, state])),
    buildMatrixCaptureSequences,
    collectBaselineEvidenceManifest: async (...args) => {
      evidenceManifests.push(args);
      return { probeOnly: true };
    },
    createModeContext: async (args) => {
      const ctx = { ...args, previewUrl: args.previewUrl, close: async () => {} };
      contexts.push({ previewUrl: args.previewUrl, viewport: args.viewport });
      return ctx;
    },
    existsSync: () => false,
    path,
    runBaselineCapture: async ({ ctx, measureRoles, captureEvidence }) => {
      baselineCalls.push({ previewUrl: ctx.previewUrl, viewport: ctx.viewport, measureRoles, captureEvidence });
      return {
        status: "captured",
        blockers: [],
        moduleRequestCount: ctx.previewUrl === warningUrl ? 13 : ctx.viewport ? 20 : 12,
        pricingRefreshInterceptions: 0,
        firstScreenMatches: true,
        runtimeMatches: true,
        durationMs: 0,
        evidence: captureEvidence ? { stub: true } : null,
      };
    },
    runStateUnit: async (args) => {
      attempts.push({
        unitId: args.unit.id,
        attempt: args.attempt,
        fixtureHash: args.fixtureHash,
        previewUrl: args.ctx.previewUrl,
      });
      return {
        status: "failed",
        blockers: ["intentional route-probe stop; no capture asserted"],
        trace: { unitId: args.unit.id, roleScopeGaps: [] },
        measurement: null,
        geometry: null,
        shots: {},
        durations: {},
        errors: {},
        stateId: args.unit.stateId ?? null,
      };
    },
    writeUnitEvidence: async () => ({ evidenceHash: "route-probe-only" }),
  };
  const mode = vm.runInNewContext(`${source.slice(start, end)}\ncaptureStateMatrixMode`, sandbox);
  const markUnit = (key, status, extra = {}) => {
    progress.units[key] = { ...(progress.units[key] ?? {}), status, ...extra };
  };
  const result = await mode({
    mode: "light",
    units,
    expectedPairs: [],
    otherModePairs: [],
    candidate: null,
    skinId: "chatgpt",
    browser: {},
    previewUrl: baseUrl,
    warningPreviewUrl: warningUrl,
    fixtureBindings: bindings,
    outDir: "E:/probe",
    measureBaseline: true,
    stateTimeoutMs: 1,
    baselineTimeoutMs: 1,
    progress,
    resumedCapturedUnits: new Map(),
    writeProgress: async () => {},
    markUnit,
    recordAttempt: (key, entry) => progress.attempts.push({ key, ...entry }),
    fixtureHash: baseHash,
  });

  assert.equal(result.status, "failed", "the stubbed unit executor deliberately fails instead of claiming captures");
  assert.equal(
    result.baseline.moduleRequestCount,
    12,
    "S0 baseline metadata must come from the base URL even when S8 runs first",
  );
  assert.equal(evidenceManifests.length, 1, "only the base sequence writes the S0 attachment manifest");
  assert.deepEqual(
    attempts
      .filter((entry) => entry.unitId === warning.id)
      .map(({ attempt, fixtureHash, previewUrl }) => ({ attempt, fixtureHash, previewUrl })),
    [1, 2].map((attempt) => ({ attempt, fixtureHash: warningHash, previewUrl: warningUrl })),
    "S8 initial and retry execution must use the warning data domain",
  );
  for (const entry of attempts.filter((item) => item.unitId !== warning.id)) {
    assert.equal(entry.fixtureHash, baseHash);
    assert.equal(entry.previewUrl, baseUrl);
  }
  assert.ok(
    contexts.filter((ctx) => ctx.previewUrl === warningUrl).length >= 2,
    "S8 gets a fresh warning context for retry",
  );
  assert.ok(
    contexts.filter((ctx) => ctx.previewUrl === baseUrl).length >= 2,
    "base state and D retry stay on base preview",
  );
  assert.ok(
    contexts.some((ctx) => ctx.previewUrl === baseUrl && ctx.viewport === undefined),
    "S0 uses its main-viewport base context even when D is the only other base group",
  );
  assert.ok(
    baselineCalls
      .filter((call) => call.previewUrl === warningUrl)
      .every((call) => !call.measureRoles && !call.captureEvidence),
    "warning warm-up waits for readiness without measuring or writing S0 evidence",
  );
  assert.ok(
    baselineCalls.some(
      (call) => call.previewUrl === baseUrl && call.viewport === undefined && call.measureRoles && call.captureEvidence,
    ),
    "only the base main-viewport sequence can measure and capture S0",
  );
  assert.deepEqual(Object.keys(result.states).sort(), [warning.id, ordinary.id, desktop.id].sort());
  assert.ok(Object.values(result.states).every((state) => state.status === "failed"));

  contexts.length = 0;
  baselineCalls.length = 0;
  attempts.length = 0;
  evidenceManifests.length = 0;
  progress.units = {};
  progress.attempts = [];
  const baselineWithDesktopOnly = await mode({
    mode: "light",
    units: [warning, desktop, baseline],
    expectedPairs: [],
    otherModePairs: [],
    candidate: null,
    skinId: "chatgpt",
    browser: {},
    previewUrl: baseUrl,
    warningPreviewUrl: warningUrl,
    fixtureBindings: buildFixedMatrixFixtureBindings({
      groups: ["S8", "D", "S0"],
      fixtureHash: baseHash,
      warningFixtureHash: warningHash,
    }),
    outDir: "E:/probe",
    measureBaseline: true,
    stateTimeoutMs: 1,
    baselineTimeoutMs: 1,
    progress,
    resumedCapturedUnits: new Map(),
    writeProgress: async () => {},
    markUnit,
    recordAttempt: (key, entry) => progress.attempts.push({ key, ...entry }),
    fixtureHash: baseHash,
  });
  assert.equal(baselineWithDesktopOnly.baseline.moduleRequestCount, 12);
  assert.ok(contexts.some((ctx) => ctx.previewUrl === baseUrl && ctx.viewport === undefined));
  assert.equal(evidenceManifests.length, 1, "D-only base selection still captures S0 at the main viewport");
});

test("D8u2A：实际入口把固定 map 写进 progress/capture，并保留单 fixture 格式", async () => {
  const dual = await createCaptureMatrixEntryProbe();
  const dualResult = await dual.run({ timelineWarningFixture: dual.warningFixture, port: 43111 });
  const expected = buildFixedMatrixFixtureBindings({
    groups: ["S0", "S8"],
    fixtureHash: getPaletteFixtureHash(),
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });

  assert.equal(dualResult.capture.fixtureHash, getPaletteFixtureHash(), "top-level fixtureHash remains base");
  assert.deepEqual(
    JSON.parse(JSON.stringify(dualResult.capture.fixtureBindings)),
    JSON.parse(JSON.stringify(expected)),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(dualResult.progress.digests.fixtureBindings)),
    JSON.parse(JSON.stringify(dualResult.capture.fixtureBindings)),
  );
  const writtenProgress = dual.calls.writes.findLast((entry) => entry.file.endsWith("progress.json"));
  const writtenCapture = dual.calls.writes.find((entry) => entry.file.endsWith("capture.json"));
  assert.deepEqual(writtenProgress.data.digests.fixtureBindings, writtenCapture.data.fixtureBindings);
  assert.equal(writtenProgress.data.digests.fixtureHash, getPaletteFixtureHash());
  assert.deepEqual(
    dual.calls.previews.map(({ domain, port }) => ({ domain, port })),
    [
      { domain: "base", port: 43111 },
      { domain: "warning", port: 0 },
    ],
  );
  assert.equal(dual.calls.previews[0].candidate, dual.candidateSnapshot);
  assert.equal(dual.calls.previews[0].candidate, dual.calls.previews[1].candidate);
  assert.equal(dual.calls.browserLaunches, 1);
  assert.deepEqual(dual.calls.previewCloses, ["browser", "warning", "base"]);
  assert.equal(dual.calls.modeCalls[0].previewUrl, "http://base.invalid/");
  assert.equal(dual.calls.modeCalls[0].warningPreviewUrl, "http://warning.invalid/");

  const single = await createCaptureMatrixEntryProbe();
  const singleResult = await single.run({ groups: ["S0", "S0"] });
  assert.equal(Object.hasOwn(singleResult.capture, "fixtureBindings"), false);
  assert.equal(Object.hasOwn(singleResult.progress.digests, "fixtureBindings"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(singleResult.capture.groups)),
    ["S0"],
    "legacy single-fixture duplicate-group normalization remains unchanged",
  );
  assert.deepEqual(
    single.calls.previews.map(({ domain }) => domain),
    ["base"],
  );
  assert.equal(single.calls.modeCalls[0].fixtureBindings, null);
});

test("D8u2A：fixture 实例/hash 在任何 preview、browser 或写盘前拒绝", async () => {
  const sameFixture = await createCaptureMatrixEntryProbe();
  await assert.rejects(sameFixture.run({ timelineWarningFixture: sameFixture.baseFixture }), /必须是不同实例/);
  assert.deepEqual(sameFixture.calls.previews, []);
  assert.equal(sameFixture.calls.browserLaunches, 0);
  assert.deepEqual(sameFixture.calls.writes, []);

  const wrongHash = await createCaptureMatrixEntryProbe();
  await assert.rejects(
    wrongHash.run({ timelineWarningFixture: { fixtureHash: "0".repeat(64) } }),
    /warningFixtureHash/,
  );
  assert.deepEqual(wrongHash.calls.previews, []);
  assert.equal(wrongHash.calls.browserLaunches, 0);
  assert.deepEqual(wrongHash.calls.writes, []);

  const duplicateGroups = await createCaptureMatrixEntryProbe();
  await assert.rejects(
    duplicateGroups.run({ timelineWarningFixture: duplicateGroups.warningFixture, groups: ["S0", "S0"] }),
    TypeError,
  );
  assert.deepEqual(duplicateGroups.calls.previews, []);
  assert.equal(duplicateGroups.calls.browserLaunches, 0);
  assert.deepEqual(duplicateGroups.calls.writes, []);
});

test("D8u2A：resume 校验固定 map、数据组和单/双 fixture 边界且拒绝前不写盘", async () => {
  const initial = await createCaptureMatrixEntryProbe();
  const captured = await initial.run({ timelineWarningFixture: initial.warningFixture, modes: ["light", "dark"] });
  const goodProgress = JSON.parse(JSON.stringify(captured.progress));
  const invalidMaps = [
    (() => {
      const value = structuredClone(goodProgress);
      delete value.digests.fixtureBindings;
      return value;
    })(),
    (() => {
      const value = structuredClone(goodProgress);
      value.digests.fixtureBindings.S8 = { fixtureKind: "base", fixtureHash: getPaletteFixtureHash() };
      return value;
    })(),
    (() => {
      const value = structuredClone(goodProgress);
      value.digests.fixtureBindings.extra = value.digests.fixtureBindings.S0;
      return value;
    })(),
  ];

  for (const savedProgress of invalidMaps) {
    const probe = await createCaptureMatrixEntryProbe({ savedProgress });
    await assert.rejects(
      probe.run({ resume: true, timelineWarningFixture: probe.warningFixture, modes: ["light", "dark"] }),
      /fixtureBindings/,
    );
    assert.deepEqual(probe.calls.writes, []);
    assert.deepEqual(probe.calls.previews, []);
    assert.equal(probe.calls.browserLaunches, 0);
  }

  const invalidHeaders = [
    ["groups 与本次输入不一致", (progress) => (progress.groups = ["S0"]), /progress\.json groups/],
    ["groups 顺序不同", (progress) => (progress.groups = ["S8", "S0"]), /progress\.json groups/],
    ["groups 缺失", (progress) => delete progress.groups, /progress\.json groups/],
    ["groups 非数组", (progress) => (progress.groups = "S0,S8"), /progress\.json groups/],
    ["groups 重复", (progress) => (progress.groups = ["S0", "S0"]), /progress\.json groups/],
    ["groups 未知", (progress) => (progress.groups = ["S0", "UNKNOWN"]), /progress\.json groups/],
    ["modes 与本次输入不一致", (progress) => (progress.modes = ["dark"]), /progress\.json modes/],
    ["modes 顺序不同", (progress) => (progress.modes = ["dark", "light"]), /progress\.json modes/],
    ["modes 缺失", (progress) => delete progress.modes, /progress\.json modes/],
    ["modes 非数组", (progress) => (progress.modes = "light,dark"), /progress\.json modes/],
    ["modes 重复", (progress) => (progress.modes = ["light", "light"]), /progress\.json modes/],
    ["modes 未知", (progress) => (progress.modes = ["light", "unknown"]), /progress\.json modes/],
  ];
  for (const [description, mutate, errorPattern] of invalidHeaders) {
    const savedProgress = structuredClone(goodProgress);
    mutate(savedProgress);
    const probe = await createCaptureMatrixEntryProbe({ savedProgress });
    await assert.rejects(
      probe.run({ resume: true, timelineWarningFixture: probe.warningFixture, modes: ["light", "dark"] }),
      errorPattern,
      description,
    );
    assert.deepEqual(probe.calls.writes, [], `${description}: 不得改写 progress/capture`);
    assert.deepEqual(probe.calls.previews, [], `${description}: 不得启动 preview`);
    assert.equal(probe.calls.browserLaunches, 0, `${description}: 不得启动 browser`);
  }

  const validResume = await createCaptureMatrixEntryProbe({ savedProgress: goodProgress });
  await validResume.run({
    resume: true,
    timelineWarningFixture: validResume.warningFixture,
    modes: ["light", "dark"],
  });
  assert.ok(validResume.calls.writes.some((entry) => entry.file.endsWith("progress.json")));
  assert.ok(validResume.calls.writes.some((entry) => entry.file.endsWith("capture.json")));
  assert.deepEqual(
    validResume.calls.previews.map(({ domain }) => domain),
    ["base", "warning"],
    "有效且完全匹配的 groups/modes 应允许双 fixture 续跑",
  );
  assert.equal(validResume.calls.browserLaunches, 1);

  const groupDrift = await createCaptureMatrixEntryProbe({ savedProgress: goodProgress });
  await assert.rejects(
    groupDrift.run({
      resume: true,
      timelineWarningFixture: groupDrift.warningFixture,
      groups: ["S0"],
      modes: ["light", "dark"],
    }),
    /progress\.json groups/,
  );
  assert.deepEqual(groupDrift.calls.writes, []);
  assert.deepEqual(groupDrift.calls.previews, []);

  const single = await createCaptureMatrixEntryProbe();
  const singleResult = await single.run({ groups: ["S0"] });
  const legacyProgress = JSON.parse(JSON.stringify(singleResult.progress));
  const legacyResume = await createCaptureMatrixEntryProbe({ savedProgress: legacyProgress });
  await legacyResume.run({ resume: true, groups: ["S0"] });
  assert.deepEqual(
    legacyResume.calls.previews.map(({ domain }) => domain),
    ["base"],
  );
  assert.equal(legacyResume.calls.browserLaunches, 1);

  const legacyToDual = await createCaptureMatrixEntryProbe({ savedProgress: legacyProgress });
  await assert.rejects(
    legacyToDual.run({
      resume: true,
      timelineWarningFixture: legacyToDual.warningFixture,
      modes: ["light"],
      groups: ["S0"],
    }),
    /fixtureBindings/,
  );
  assert.deepEqual(legacyToDual.calls.writes, []);
  assert.deepEqual(legacyToDual.calls.previews, []);

  const dualToLegacy = await createCaptureMatrixEntryProbe({ savedProgress: goodProgress });
  await assert.rejects(
    dualToLegacy.run({ resume: true, groups: ["S0", "S8"], modes: ["light", "dark"] }),
    /摘要绑定不一致/,
  );
  assert.deepEqual(dualToLegacy.calls.writes, []);
  assert.deepEqual(dualToLegacy.calls.previews, []);
});

test("D8u2A：第二 preview/browser 启动失败及主错+清理错都完整关闭资源", async () => {
  const warningStartError = new Error("warning preview start failed");
  const warningStart = await createCaptureMatrixEntryProbe({ failures: { warningPreviewStart: warningStartError } });
  await assert.rejects(
    warningStart.run({ timelineWarningFixture: warningStart.warningFixture }),
    (error) => error === warningStartError,
  );
  assert.deepEqual(warningStart.calls.previewCloses, ["base"]);
  assert.equal(warningStart.calls.browserLaunches, 0);

  const browserStartError = new Error("browser start failed");
  const browserStart = await createCaptureMatrixEntryProbe({ failures: { browserStart: browserStartError } });
  await assert.rejects(
    browserStart.run({ timelineWarningFixture: browserStart.warningFixture }),
    (error) => error === browserStartError,
  );
  assert.deepEqual(browserStart.calls.previewCloses, ["warning", "base"]);

  const primaryError = new Error("mode failed");
  const browserCloseError = new Error("browser close failed");
  const warningCloseError = new Error("warning close failed");
  const baseCloseError = new Error("base close failed");
  const closeProbe = await createCaptureMatrixEntryProbe({
    failures: {
      mode: primaryError,
      browserClose: browserCloseError,
      warningPreviewClose: warningCloseError,
      basePreviewClose: baseCloseError,
    },
  });
  await assert.rejects(closeProbe.run({ timelineWarningFixture: closeProbe.warningFixture }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primaryError, browserCloseError, warningCloseError, baseCloseError]);
    return true;
  });
  assert.deepEqual(closeProbe.calls.previewCloses, ["browser", "warning", "base"]);
});

test("矩阵完整性：40 个 catalog 状态全部有归属、单元 id 唯一、S0 在前且兼任 50% 角色态", () => {
  const groupIds = STATE_MATRIX_GROUPS.map((group) => group.id);
  const ids = ALL_MATRIX_UNITS.map((unit) => unit.id);
  assert.equal(STATE_CATALOG.length, 40);
  assert.equal(new Set(groupIds).size, groupIds.length, "矩阵组 id 必须唯一");
  assert.equal(new Set(ids).size, ids.length, "单元 id 必须唯一");
  for (const unit of ALL_MATRIX_UNITS) {
    if (unit.kind === "catalog") {
      assert.ok(typeof unit.stateId === "string" && unit.stateId.length > 0, `单元 ${unit.id} 必须登记 stateId`);
      assert.ok(
        STATE_CATALOG.some((state) => state.id === unit.stateId),
        `单元 ${unit.id} 引用不存在的 catalog 状态 ${unit.stateId}`,
      );
    } else if (unit.kind === "procedure") {
      assert.ok(typeof unit.handler === "string" && unit.handler.length > 0, `规程单元 ${unit.id} 必须登记 handler`);
    } else if (unit.kind !== "baseline") {
      assert.fail(`单元 ${unit.id} 类型未知：${unit.kind}`);
    }
  }
  assert.equal(STATE_MATRIX_GROUPS[0].id, "S0", "S0 基准必须是第一个组");
  assert.equal(ALL_MATRIX_UNITS[0].id, "baseline");
  assert.equal(ALL_MATRIX_UNITS.length, 45, "每个模式必须有 45 个已登记捕获单元");
  const coverage = describeMatrixCoverage();
  assert.equal(
    coverage.size,
    STATE_CATALOG.length,
    `全矩阵必须覆盖全部 ${STATE_CATALOG.length} 个 catalog 状态（缺：${STATE_CATALOG.map((s) => s.id)
      .filter((id) => !coverage.has(id))
      .join(",")}）`,
  );
  assert.ok(
    coverage.get("characters-50").includes("baseline"),
    "卡面矩阵的 (50%, 聚光关) 单元就是 S0 基准，不得重复捕获",
  );
  assert.deepEqual(coverage.get("autorefresh-on"), ["autorefresh-on"], "开启态必须由独立 S1 单元覆盖");
  assert.deepEqual(coverage.get("dashboard-default"), [
    "baseline",
    "d2560x1440-dashboard-default",
    "d1280x720-dashboard-default",
  ]);
  for (const stateId of [
    "spotlight-language-selected",
    "spotlight-metric-label",
    "spotlight-timeline-heading",
    "spotlight-detail-bars",
    "spotlight-detail-fill",
  ]) {
    assert.deepEqual(coverage.get(stateId), [stateId]);
  }
});

test("D8b-sort：S5 为排序指示使用独立 catalog 单元", () => {
  const s5 = matrixGroup("S5").units;
  const state = STATE_CATALOG.find((item) => item.id === "comparison-sort-active");
  const unit = s5.find((item) => item.id === "comparison-sort-active");
  assert.equal(STATE_CATALOG.length, 40);
  assert.equal(ALL_MATRIX_UNITS.length, 45);
  assert.deepEqual(state.expectedRoleIds, ["indicator.sort"]);
  assert.equal(state.ready.kind, "matches");
  assert.equal(state.ready.selector, "#modelComparisonTable .comparison-sort-indicator:not([hidden])");
  assert.equal(unit.kind, "catalog");
  assert.equal(unit.stateId, "comparison-sort-active");
  assert.equal(unit.clipSelector, "#modelComparisonTable");
  assert.equal(unit.postSteps, undefined);
});

test("D8e-badge：S5 在 dense-data 后接入固定日期可见状态并正确恢复", () => {
  const s5 = matrixGroup("S5").units;
  const state = STATE_CATALOG.find((item) => item.id === "metric-record-visible");
  const unit = s5.find((item) => item.id === "metric-record-visible");

  assert.equal(STATE_CATALOG.length, 40);
  assert.equal(ALL_MATRIX_UNITS.length, 45);
  assert.deepEqual(
    s5.map((item) => item.id),
    ["dense-data", "metric-record-visible", "comparison-sort-active", "bar-fill-visual"],
  );
  assert.equal(s5.indexOf(s5.find((item) => item.id === "comparison-sort-active")), 2);
  assert.equal(unit.kind, "catalog");
  assert.equal(unit.stateId, "metric-record-visible");
  assert.equal(unit.clipSelector, ".metric:has(#totalTokens)");
  assert.equal(unit.postSteps, undefined);
  assert.deepEqual(unit.restorePreSteps, [{ action: "click", selector: "#dateRangeButton" }]);
  assert.deepEqual(unit.stepRewrites, [
    {
      matchAction: "click",
      matchSelector: "[data-date-picker-clear]",
      to: { action: "clickIfEnabled" },
    },
  ]);
  assert.deepEqual(state.restore, [
    { action: "click", selector: "[data-date-picker-clear]" },
    { action: "click", selector: "#dateRangeButton" },
    { action: "click", selector: '#presetButtons button[data-preset="all"]' },
  ]);
  assert.equal(
    state.ready.selector,
    'body:has(#dateRangeButton[aria-expanded="false"]) .metric:has(#totalTokens) .metric-new:not([hidden])',
  );
  const readySource = buildStateReadyWaitSource(state.ready);
  assert.equal(
    vm.runInNewContext(readySource, {
      document: { querySelector: (selector) => (selector === state.ready.selector ? {} : null) },
    }),
    true,
    "ready.matches 必须把‘闭层且徽标可见’的完整联合选择器交给等待器",
  );
});

test("D8h-ready-fix：Chromium 原生编译全部 ready 并约束到闭层 totalTokens 徽标", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不以字符串检查代替 Chromium 语法验证");
    return;
  }

  const browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
  let browserSession;
  let context;
  let browserVersion = null;
  let browserPid = null;
  let requestCount = 0;
  let pidExited = false;
  let pidCheckError = null;

  try {
    browserVersion = browser.version();
    assert.equal(browser.contexts().length, 0, "启动后先确认没有隐式上下文");
    browserSession = await browser.newBrowserCDPSession();
    const { processInfo } = await browserSession.send("SystemInfo.getProcessInfo");
    browserPid = processInfo.find((item) => item.type === "browser")?.id ?? null;
    assert.ok(Number.isInteger(browserPid) && browserPid > 0, "CDP 必须返回浏览器进程 PID");
    context = await browser.newContext();
    assert.equal(browser.contexts().length, 1, "只创建一个 Chromium 上下文");
    const page = await context.newPage();
    page.on("request", () => requestCount++);
    await page.setContent(`<!doctype html><html><body>
      <button id="dateRangeButton" aria-expanded="false"></button>
      <section class="metric"><strong id="totalTokens">10</strong><span id="targetBadge" class="metric-new"></span></section>
      <section class="metric"><strong id="otherMetric">20</strong><span id="otherBadge" class="metric-new" hidden></span></section>
    </body></html>`);

    const readySelectors = STATE_CATALOG.map((state) => state.ready?.selector).filter(
      (selector) => typeof selector === "string",
    );
    assert.ok(readySelectors.length > 0, "ready selector 清单不得为空");
    const compiledCount = await page.evaluate((selectors) => {
      for (const selector of selectors) document.querySelector(selector);
      return selectors.length;
    }, readySelectors);
    assert.equal(compiledCount, readySelectors.length, "每个目录 selector 都经 Chromium 原生 querySelector 编译");

    const state = STATE_CATALOG.find((item) => item.id === "metric-record-visible");
    assert.equal(ROLES_VERSION, POLICY.versions.roles, "当前角色目录版本必须与 policy 同步");
    assert.equal(
      state.ready.selector,
      'body:has(#dateRangeButton[aria-expanded="false"]) .metric:has(#totalTokens) .metric-new:not([hidden])',
    );
    const behavior = await page.evaluate((selector) => {
      const dateRangeButton = document.querySelector("#dateRangeButton");
      const targetBadge = document.querySelector("#targetBadge");
      const otherBadge = document.querySelector("#otherBadge");
      const matches = () => document.querySelector(selector);
      const result = { closedTargetVisible: matches() === targetBadge };

      dateRangeButton.setAttribute("aria-expanded", "true");
      result.open = matches() === null;
      dateRangeButton.setAttribute("aria-expanded", "false");
      targetBadge.hidden = true;
      result.targetHidden = matches() === null;
      otherBadge.hidden = false;
      result.onlyOtherBadgeVisible = matches() === null && otherBadge.hidden === false && targetBadge.hidden === true;
      return result;
    }, state.ready.selector);
    assert.deepEqual(behavior, {
      closedTargetVisible: true,
      open: true,
      targetHidden: true,
      onlyOtherBadgeVisible: true,
    });

    const legacySelector =
      'body:has(#dateRangeButton[aria-expanded="false"]):has(.metric:has(#totalTokens) .metric-new:not([hidden]))';
    const legacyError = await page.evaluate((selector) => {
      try {
        document.querySelector(selector);
        return null;
      } catch (error) {
        return { name: error.name, message: error.message };
      }
    }, legacySelector);
    assert.equal(legacyError?.name, "SyntaxError", "Chromium 必须拒绝旧嵌套 :has 写法");
    assert.equal(requestCount, 0, "静态 setContent 回归不得发出页面网络请求");
    t.diagnostic(
      `静态选择器检查：Chromium ${browserVersion}，PID ${browserPid}，ready=${compiledCount}，roles=${ROLES_VERSION}/${POLICY.versions.roles}`,
    );
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await browserSession?.detach();
      } finally {
        try {
          await browser.close();
        } finally {
          if (Number.isInteger(browserPid)) {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
              try {
                process.kill(browserPid, 0);
                await new Promise((resolve) => setTimeout(resolve, 50));
              } catch (error) {
                if (error.code !== "ESRCH") {
                  pidCheckError = error;
                  break;
                }
                pidExited = true;
                break;
              }
            }
            assert.equal(browser.isConnected(), false, "Playwright browser connection 必须关闭");
            assert.equal(pidExited, true, `Edge PID ${browserPid} 必须退出`);
            t.diagnostic(`浏览器清理：Chromium ${browserVersion}，PID ${browserPid} 已退出`);
          }
        }
      }
    }
  }
  if (pidCheckError) throw pidCheckError;
});

test("D7d：S2 将日历选区与闭层上行分开，并保留下行与同日状态", () => {
  const s2 = matrixGroup("S2").units;
  assert.equal(STATE_CATALOG.length, 40);
  assert.equal(ALL_MATRIX_UNITS.length, 45);
  assert.deepEqual(
    s2.map(({ id, stateId }) => [id, stateId]),
    [
      ["calendar-open", "calendar-open"],
      ["calendar-range", "calendar-range"],
      ["comparison-trend-up", "comparison-trend-up"],
      ["comparison-trend-down", "comparison-trend-down"],
      ["calendar-same-day", "calendar-same-day"],
      ["empty-range", "empty-range"],
    ],
  );

  const catalog = (id) => STATE_CATALOG.find((state) => state.id === id);
  const range = s2.find((unit) => unit.id === "calendar-range");
  const calendar = catalog("calendar-range");
  assert.match(calendar.ready.selector, /2026-09-28.*range-end/);
  assert.doesNotMatch(calendar.ready.selector, /comparison-item\.up/);
  assert.equal(calendar.expectedRoleIds.includes("summary.trend-up"), false);
  assert.equal(range.clipSelector, ".date-picker-popover");
  assert.equal(range.evidenceTargets, undefined);
  assert.deepEqual(range.postSteps, [{ action: "click", selector: "#dateRangeButton" }]);
  assert.deepEqual(calendar.restore, [
    { action: "click", selector: "[data-date-picker-clear]" },
    { action: "click", selector: "#dateRangeButton" },
  ]);

  const trendUp = catalog("comparison-trend-up");
  const upUnit = s2.find((unit) => unit.id === "comparison-trend-up");
  assert.deepEqual(
    trendUp.steps.filter((step) => step.selector?.startsWith(".date-picker-day")).map((step) => step.selector),
    ['.date-picker-day[data-date="2026-09-26"]', '.date-picker-day[data-date="2026-09-28"]'],
  );
  assert.equal(
    trendUp.ready.selector,
    'body:has(#dateRangeButton[aria-expanded="false"]):has(#comparisonSummary .comparison-item.up strong)',
  );
  assert.equal(trendUp.expectedRoleIds.includes("summary.trend-up"), true);
  assert.equal(upUnit.clipSelector, "#comparisonSummary");
  assert.deepEqual(upUnit.restorePreSteps, [{ action: "click", selector: "#dateRangeButton" }]);
  assert.equal(upUnit.postSteps, undefined, "上行摘要在选择终点、弹层自动关闭后测量");
  assert.deepEqual(trendUp.restore, [
    { action: "click", selector: "[data-date-picker-clear]" },
    { action: "click", selector: "#dateRangeButton" },
  ]);

  const down = catalog("comparison-trend-down");
  const downUnit = s2.find((unit) => unit.id === "comparison-trend-down");
  assert.deepEqual(
    down.steps.filter((step) => step.selector?.startsWith(".date-picker-day")).map((step) => step.selector),
    ['.date-picker-day[data-date="2026-09-29"]', '.date-picker-day[data-date="2026-09-30"]'],
  );
  assert.equal(down.ready.selector, "#comparisonSummary .comparison-item.down strong");
  assert.equal(downUnit.clipSelector, "#comparisonSummary");
  assert.deepEqual(downUnit.restorePreSteps, [{ action: "click", selector: "#dateRangeButton" }]);
  assert.equal(downUnit.postSteps, undefined, "下行摘要在选完终点、弹层自动关闭后测量");
  assert.deepEqual(down.restore, [
    { action: "click", selector: "[data-date-picker-clear]" },
    { action: "click", selector: "#dateRangeButton" },
  ]);

  const sameDay = catalog("calendar-same-day");
  const sameDayUnit = s2.find((unit) => unit.id === "calendar-same-day");
  assert.deepEqual(
    sameDay.steps.filter((step) => step.selector?.startsWith(".date-picker-day")).map((step) => step.selector),
    ['.date-picker-day[data-date="2026-09-28"]', '.date-picker-day[data-date="2026-09-28"]'],
  );
  assert.equal(sameDay.ready.selector, '.date-picker-day[data-date="2026-09-28"].range-start.range-end');
  assert.equal(sameDayUnit.clipSelector, ".date-picker-popover");
  assert.deepEqual(sameDayUnit.postSteps, [{ action: "click", selector: "#dateRangeButton" }]);
  assert.deepEqual(sameDay.restore, [
    { action: "click", selector: "[data-date-picker-clear]" },
    { action: "click", selector: "#dateRangeButton" },
  ]);
  for (const unit of [range, upUnit, downUnit, sameDayUnit, s2.find((item) => item.id === "empty-range")]) {
    assert.deepEqual(unit.stepRewrites, [
      {
        matchAction: "click",
        matchSelector: "[data-date-picker-clear]",
        to: { action: "clickIfEnabled" },
      },
    ]);
  }

  const coverage = describeMatrixCoverage();
  assert.deepEqual(coverage.get("calendar-range"), ["calendar-range"]);
  assert.deepEqual(coverage.get("comparison-trend-up"), ["comparison-trend-up"]);
  assert.deepEqual(coverage.get("comparison-trend-down"), ["comparison-trend-down"]);
  assert.deepEqual(coverage.get("calendar-same-day"), ["calendar-same-day"]);
});

test("矩阵固定顺序：S6 不取笛卡尔积，quota-toast 登记 fixture 前置条件", () => {
  const s6 = matrixGroup("S6").units;
  // (50%,off) 即 S0 基准；S6 自身落剩余角色组合与五个独立聚光区域。
  assert.deepEqual(
    s6.map((unit) => [unit.id, unit.stateId]),
    [
      ["characters-off", "characters-off"],
      ["characters-100", "characters-100"],
      ["spotlight-on", "spotlight-on"],
      ["spotlight-on-characters-100", "spotlight-on"],
      ["spotlight-language-selected", "spotlight-language-selected"],
      ["spotlight-metric-label", "spotlight-metric-label"],
      ["spotlight-timeline-heading", "spotlight-timeline-heading"],
      ["spotlight-detail-bars", "spotlight-detail-bars"],
      ["spotlight-detail-fill", "spotlight-detail-fill"],
    ],
  );
  assert.deepEqual(
    s6.slice(4).map(({ id, clipSelector }) => [id, clipSelector]),
    [
      ["spotlight-language-selected", "#languageToggle"],
      ["spotlight-metric-label", ".metric:has(> #totalTokens)"],
      ["spotlight-timeline-heading", ".chart-panel"],
      ["spotlight-detail-bars", "#detailPanel"],
      ["spotlight-detail-fill", "#detailPanel"],
    ],
  );
  // 每个聚光单元都必须先把指针归位到凹陷面：否则上一个单元遗留的鼠标位置可能正好
  // 压在 .topbar 上，入口就绪被误命中，聚光"点亮/熄灭"两条路径一次都没真跑过
  for (const unit of s6.filter((item) => item.id.startsWith("spotlight-"))) {
    assert.ok(
      unit.preSteps?.some((step) => step.action === "setSpotlight" && step.value === "off"),
      `${unit.id} 必须在 catalog 步骤点亮前先把聚光熄灭`,
    );
  }
  assert.deepEqual(s6[3].preSteps, [
    { action: "setSpotlight", value: "off" },
    { action: "setOpacity", value: "1" },
  ]);
  assert.deepEqual(s6[3].postRestoreSteps, [{ action: "setOpacity", value: "0.5" }]);
  // 绝不取笛卡尔积：自定义步骤里把透明度设成 1 的只允许“100%+聚光”一个组合
  const opacityOne = ALL_MATRIX_UNITS.filter((unit) =>
    [...(unit.preSteps ?? []), ...(unit.postRestoreSteps ?? [])].some(
      (step) => step.action === "setOpacity" && Number(step.value) === 1,
    ),
  );
  assert.deepEqual(
    opacityOne.map((unit) => unit.id),
    ["spotlight-on-characters-100"],
  );

  const quota = matrixGroup("S1").units.find((unit) => unit.id === "quota-toast");
  assert.equal(quota.precondition.selector, "#quotaPresetToggle:not([disabled])");
  assert.ok(
    quota.precondition.note.includes("Codex"),
    "前置原因必须点明：fixture 只有 project-log 家目录，限额开关恒禁用",
  );
});

test("C45：语言聚光状态经既有 VM 执行 hover/ready/off 恢复且不触发点击", async () => {
  const state = STATE_CATALOG.find((item) => item.id === "spotlight-language-selected");
  assert.ok(state);

  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const applyStart = captureSource.indexOf("async function applyStateStep(");
  const applyEnd = captureSource.indexOf("\n}\n\n/** 点击；目标是日历日期格", applyStart) + 2;
  const readyStart = captureSource.indexOf("async function evaluateReady(");
  const readyEnd = captureSource.indexOf("\n}\n\n/** 就绪等待", readyStart) + 2;
  assert.ok(applyStart >= 0 && applyEnd > applyStart, "execute the real private applyStateStep body");
  assert.ok(readyStart >= 0 && readyEnd > readyStart, "execute the real private evaluateReady body");

  const hoverCalls = [];
  const readySources = [];
  const spotlightCalls = [];
  const page = {
    async hover(selector, options) {
      hoverCalls.push({ selector, options });
    },
    async evaluate(source) {
      readySources.push(source);
      return readySources.length === 2;
    },
  };
  const funcs = vm.runInNewContext(
    `${captureSource.slice(applyStart, applyEnd)}\n${captureSource.slice(readyStart, readyEnd)}\n({ applyStateStep, evaluateReady })`,
    {
      ENSURE_CLICK_ACTIONS: ["ensureClick"],
      buildStateReadyWaitSource,
      applySpotlight: async (_page, value, _timeout, record) => {
        spotlightCalls.push(value);
        record.spotlight = { value, point: { x: 1, y: 1 }, ms: 0 };
      },
    },
  );

  const trigger = await funcs.applyStateStep(page, state.steps[0], { stateTimeoutMs: 50 });
  assert.equal(trigger.ok, true);
  assert.deepEqual(
    hoverCalls.map(({ selector, options }) => [selector, options.timeout]),
    [["#languageToggle[aria-pressed='false'] > [data-language='zh-CN'].is-selected", 50]],
  );
  assert.equal(await funcs.evaluateReady(page, state.ready), false);
  assert.equal(await funcs.evaluateReady(page, state.ready), true);
  assert.deepEqual(readySources, Array(2).fill(buildStateReadyWaitSource(state.ready)));

  const restore = await funcs.applyStateStep(page, state.restore[0], { stateTimeoutMs: 50 });
  assert.equal(restore.ok, true);
  assert.deepEqual(spotlightCalls, ["off"]);
});

test("D8s7-warning：today 告警入口等待异步渲染结束后再检查 entryReady", async () => {
  const [unit] = matrixGroup("S8").units;
  const state = STATE_CATALOG.find((item) => item.id === "timeline-range-warning");
  const todaySelector = '#presetButtons button[data-preset="today"]';
  const warningHiddenSelector =
    'body:has(#presetButtons button[data-preset="today"].active) #timelineRangeWarning[hidden]';
  const allSelector = '#presetButtons button[data-preset="all"]';
  assert.deepEqual(unit.preSteps, [{ action: "click", selector: todaySelector, until: warningHiddenSelector }]);

  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const applyStart = captureSource.indexOf("async function applyStateStep(");
  const applyEnd = captureSource.indexOf("\n}\n\n/** 点击；目标是日历日期格", applyStart) + 2;
  const readyStart = captureSource.indexOf("async function evaluateReady(");
  const readyEnd = captureSource.indexOf("\n}\n\n/** 就绪等待", readyStart) + 2;
  assert.ok(applyStart >= 0 && applyEnd > applyStart, "execute the real private applyStateStep body");
  assert.ok(readyStart >= 0 && readyEnd > readyStart, "execute the real private evaluateReady body");

  const createDeferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const makeHarness = () => {
    const dom = { todayActive: false, allActive: false, warningHidden: false, warningVisible: true };
    const render = createDeferred();
    const waitEntered = createDeferred();
    const page = {
      evaluate: async (source) => {
        assert.equal(source, buildStateReadyWaitSource(state.ready));
        return dom.warningVisible;
      },
      waitForFunction: async (source, _argument, options) => {
        assert.equal(source, `(() => Boolean(document.querySelector(${JSON.stringify(warningHiddenSelector)})))()`);
        assert.equal(options.timeout, 15000);
        waitEntered.resolve();
        await render.promise;
        if (!(dom.todayActive && dom.warningHidden)) throw new Error("today 告警隐藏条件未成立");
      },
    };
    const funcs = vm.runInNewContext(
      `${captureSource.slice(applyStart, applyEnd)}\n${captureSource.slice(readyStart, readyEnd)}\n({ applyStateStep, evaluateReady })`,
      {
        ENSURE_CLICK_ACTIONS: ["ensureClick"],
        buildStateReadyWaitSource,
        clickWithCalendarNavigation: async (_page, selector) => {
          if (selector === todaySelector) {
            dom.todayActive = true;
            return;
          }
          assert.equal(selector, allSelector);
          assert.equal(dom.todayActive, true);
          assert.equal(dom.warningHidden, true, "all 触发前必须等 today 异步响应隐藏告警");
          dom.todayActive = false;
          dom.allActive = true;
          dom.warningHidden = false;
          dom.warningVisible = true;
        },
      },
    );
    return {
      dom,
      page,
      funcs,
      waitEntered: waitEntered.promise,
      finishTodayRender() {
        dom.warningHidden = true;
        dom.warningVisible = false;
        render.resolve();
      },
    };
  };

  // Reproduce the former race: today becomes active synchronously while the prior all warning remains.
  const legacy = makeHarness();
  const legacyStep = await legacy.funcs.applyStateStep(
    legacy.page,
    { action: "click", selector: todaySelector },
    { stateTimeoutMs: 15000 },
  );
  assert.equal(legacyStep.ok, true);
  assert.equal(legacy.dom.todayActive, true);
  assert.equal(legacy.dom.warningVisible, true);
  assert.equal(
    await legacy.funcs.evaluateReady(legacy.page, state.ready),
    true,
    "old entry check sees stale all warning",
  );
  legacy.finishTodayRender();

  // The catalog step now remains pending until the controlled async today render hides the warning.
  const fixed = makeHarness();
  let stepReturned = false;
  const fixedStepPromise = fixed.funcs
    .applyStateStep(fixed.page, unit.preSteps[0], { stateTimeoutMs: 15000 })
    .finally(() => {
      stepReturned = true;
    });
  const firstEvent = await Promise.race([
    fixedStepPromise.then((result) => ({ kind: "returned", result })),
    fixed.waitEntered.then(() => ({ kind: "until-wait", result: null })),
  ]);
  assert.equal(firstEvent.kind, "until-wait", "applyStateStep must enter its existing until wait after the click");
  assert.equal(stepReturned, false);
  assert.equal(fixed.dom.todayActive, true);
  assert.equal(fixed.dom.warningVisible, true, "the controlled today response has not rendered yet");

  fixed.finishTodayRender();
  const preStepResult = await fixedStepPromise;
  assert.equal(preStepResult.ok, true);
  assert.equal(preStepResult.until, warningHiddenSelector);
  assert.equal(await fixed.funcs.evaluateReady(fixed.page, state.ready), false);
  const allStepResult = await fixed.funcs.applyStateStep(fixed.page, state.steps[0], { stateTimeoutMs: 15000 });
  assert.equal(allStepResult.ok, true);
  assert.equal(fixed.dom.allActive, true);
  assert.equal(await fixed.funcs.evaluateReady(fixed.page, state.ready), true);
});

test("D8s5-warning：S8 独立登记告警状态，并在实际单元前置拒绝非变体 fixture", async () => {
  const group = matrixGroup("S8");
  const [unit] = group.units;
  const state = STATE_CATALOG.find((item) => item.id === "timeline-range-warning");

  assert.equal(STATE_CATALOG.length, 40);
  assert.equal(ALL_MATRIX_UNITS.length, 45);
  assert.deepEqual(
    group.units.map((item) => item.id),
    ["timeline-range-warning"],
  );
  assert.equal(unit.kind, "catalog");
  assert.equal(unit.stateId, state.id);
  assert.equal(unit.clipSelector, "#timelineRangeWarning");
  assert.deepEqual(unit.preSteps, [
    {
      action: "click",
      selector: '#presetButtons button[data-preset="today"]',
      until: 'body:has(#presetButtons button[data-preset="today"].active) #timelineRangeWarning[hidden]',
    },
  ]);
  assert.deepEqual(unit.recovery, {
    steps: [],
    expectGone: "#timelineRangeWarning:not([hidden])",
  });
  assert.deepEqual(state.restore, [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }]);
  assert.deepEqual(unit.fixtureRequirement, {
    name: "timeline-range-warning",
    expectedHash: getTimelineWarningFixtureHash(),
  });
  assert.notEqual(getTimelineWarningFixtureHash(), getPaletteFixtureHash());

  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const functionStart = captureSource.indexOf("async function runStateUnit({");
  const functionEnd = captureSource.indexOf("\n}\n\n/** S7 规程一", functionStart) + 2;
  assert.ok(
    functionStart >= 0 && functionEnd > functionStart,
    "canary must execute the real private runStateUnit body",
  );
  const privateRunStateUnit = captureSource.slice(functionStart, functionEnd);
  const interactionCounts = () => ({ evaluate: 0, trigger: 0, measure: 0, screenshot: 0, rebaseline: 0 });

  const execute = async (actualFixtureHash) => {
    const calls = interactionCounts();
    const errors = {
      pageErrors: [],
      consoleErrors: [],
      requestFailed: [],
      resourceFailures: [],
      blockedExternal: [],
    };
    const args = {
      ctx: {
        errors,
        page: {
          evaluate: async () => {
            calls.evaluate += 1;
            return { declarations: {} };
          },
          screenshot: async () => {
            calls.screenshot += 1;
            return Buffer.alloc(0);
          },
        },
      },
      unit: { ...unit, kind: "catalog", stateId: null, preSteps: [], recovery: undefined },
      mode: "light",
      skinId: "chatgpt",
      candidate: null,
      expectedPairs: {},
      otherModePairs: {},
      policy: {},
      stateTimeoutMs: 1,
      baselineTimeoutMs: 1,
      attempt: 1,
      fixtureHash: actualFixtureHash,
    };
    const sandbox = {
      args,
      STATE_BY_ID: new Map(),
      snapshotErrorCounts: (value) => Object.fromEntries(Object.keys(value).map((key) => [key, value[key].length])),
      errorDelta: (value, start) =>
        Object.fromEntries(Object.keys(value).map((key) => [key, value[key].slice(start[key])])),
      applyStateStep: async () => {
        calls.trigger += 1;
        return { ok: true };
      },
      measureBrowserRoles: async () => {
        calls.measure += 1;
        return {};
      },
      rebaselineToAll: async () => {
        calls.rebaseline += 1;
        errors.pageErrors.push("canary-stop-after-fixture-preflight");
        return { ok: true };
      },
      buildDeclarationsProbeSource: () => "probe",
      diffPaletteDeclarations: () => [],
      buildStateBlockers: (delta) => (delta.pageErrors.length ? ["canary stop"] : []),
    };
    const result = await vm.runInNewContext(`${privateRunStateUnit}\nrunStateUnit(args)`, sandbox);
    return { result, calls };
  };

  const wrongHashes = [getPaletteFixtureHash(), undefined, "0".repeat(64)].map((hash) =>
    hash === unit.fixtureRequirement.expectedHash ? "1".repeat(64) : hash,
  );
  for (const actualHash of wrongHashes) {
    const { result, calls } = await execute(actualHash);
    assert.equal(result.status, "unreachable");
    assert.equal(result.trace.fixtureRequirement.name, "timeline-range-warning");
    assert.equal(result.trace.fixtureRequirement.expectedHash, getTimelineWarningFixtureHash());
    assert.equal(result.trace.fixtureRequirement.actualHash, typeof actualHash === "string" ? actualHash : null);
    assert.equal(result.trace.fixtureRequirement.match, false);
    assert.equal(calls.evaluate, 0, "identity mismatch must return before any page/DOM probe");
    assert.equal(calls.trigger + calls.measure + calls.screenshot + calls.rebaseline, 0);
  }

  const { result, calls } = await execute(getTimelineWarningFixtureHash());
  assert.equal(
    result.trace.fixtureRequirement.match,
    true,
    "the exact variant identity must pass the actual preflight",
  );
  assert.equal(result.trace.fixtureRequirement.actualHash, getTimelineWarningFixtureHash());
  assert.equal(result.status, "failed", "the canary stops after preflight; it must not claim a fake capture");
  assert.equal(calls.rebaseline, 1, "matching identity must continue past the fixture preflight");
  assert.equal(
    calls.trigger + calls.measure + calls.screenshot,
    0,
    "the canary must not pretend to act, measure, or capture",
  );

  const modeStart = captureSource.indexOf("async function captureStateMatrixMode({");
  const matrixStart = captureSource.indexOf("export async function captureStateMatrix({");
  const modeSource = captureSource.slice(modeStart, matrixStart);
  const matrixSource = captureSource.slice(matrixStart);
  const unreachableStart = modeSource.indexOf('if (outcome.status === "unreachable") {');
  const retryStart = modeSource.indexOf('while (outcome.status !== "captured") {', unreachableStart);
  const unreachableBranch = modeSource.slice(unreachableStart, retryStart);
  assert.match(modeSource, /runStateUnit\(\s*\{[\s\S]*?fixtureHash,\s*\}\)/);
  assert.ok(unreachableStart >= 0 && retryStart > unreachableStart);
  assert.match(unreachableBranch, /recordAttempt\(key,[\s\S]*?status: "unreachable"/);
  assert.match(unreachableBranch, /markUnit\(key, "unreachable"/);
  assert.match(unreachableBranch, /results\.states\[unit\.id\] = \{ status: "unreachable"/);
  assert.match(unreachableBranch, /results\.gaps\.push\(/);
  assert.match(unreachableBranch, /await writeProgress\(\);\s*continue;/);
  assert.match(matrixSource, /fixtureHash: typeof fixture\?\.fixtureHash === "string" \? fixture\.fixtureHash : null/);
  assert.match(matrixSource, /progress = \{[\s\S]*?digests,/);
  assert.match(matrixSource, /fixtureHash: digests\.fixtureHash,/);
});

test("D8u3B1: registered fixture trace is checked after evidence hashes and ordinary units stay readable", async (t) => {
  const fixtureUnit = matrixGroup("S8").units[0];
  const evidenceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m52-c-d8s9-warning-paired/capture-output",
  );
  if (!existsSync(evidenceRoot)) {
    t.skip("dated frozen evidence is not in this tree (release archive); it stays in the authoring repository");
    return;
  }
  const frozenUnitDir = path.join(evidenceRoot, "light", "states", fixtureUnit.id);
  const frozenProgress = JSON.parse(await readFile(path.join(evidenceRoot, "progress.json"), "utf8"));
  const frozenEvidenceHash = frozenProgress.units[`light/${fixtureUnit.id}`].evidenceHash;
  const frozenState = JSON.parse(await readFile(path.join(frozenUnitDir, "state.json"), "utf8"));
  const historicalFixtureUnit = {
    ...fixtureUnit,
    fixtureRequirement: {
      ...fixtureUnit.fixtureRequirement,
      expectedHash: frozenState.trace.fixtureRequirement.expectedHash,
    },
  };
  assert.notEqual(
    historicalFixtureUnit.fixtureRequirement.expectedHash,
    fixtureUnit.fixtureRequirement.expectedHash,
    "frozen S8 evidence must carry the historical fixture identity",
  );
  assert.deepEqual(frozenState.trace.fixtureRequirement, {
    name: fixtureUnit.fixtureRequirement.name,
    expectedHash: historicalFixtureUnit.fixtureRequirement.expectedHash,
    actualHash: historicalFixtureUnit.fixtureRequirement.expectedHash,
    match: true,
  });

  await assert.rejects(
    () =>
      readCapturedUnitEvidence({
        unitDir: frozenUnitDir,
        unit: fixtureUnit,
        mode: "light",
        skinId: "chatgpt",
        expectedRoleIds: ["warning.timeline-range"],
        expectedEvidenceHash: frozenEvidenceHash,
      }),
    /trace\.fixtureRequirement/,
    "the current fixture identity must reject historical evidence after accepting its tree digest",
  );
  const accepted = await readCapturedUnitEvidence({
    unitDir: frozenUnitDir,
    unit: historicalFixtureUnit,
    mode: "light",
    skinId: "chatgpt",
    expectedRoleIds: ["warning.timeline-range"],
    expectedEvidenceHash: frozenEvidenceHash,
  });
  assert.deepEqual(accepted.state.trace.fixtureRequirement, frozenState.trace.fixtureRequirement);

  const source = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const hashStart = source.indexOf("async function hashEvidenceTree(rootDir) {");
  const hashEnd = source.indexOf("\n}\n\n/**", hashStart) + 2;
  assert.ok(hashStart >= 0 && hashEnd > hashStart, "rehash must execute capture.mjs's actual private hash function");
  const makeHashEvidenceTree = vm.runInThisContext(
    `(path, realpath, readdir, readFile, sha256Of, sha256Canonical) => (${source.slice(hashStart, hashEnd)})`,
  );
  const hashEvidenceTree = makeHashEvidenceTree(
    path,
    realpath,
    readdir,
    readFile,
    (bytes) => createHash("sha256").update(bytes).digest("hex"),
    sha256Canonical,
  );

  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-d8u3b1-state-proof-"));
  try {
    const ordinaryCandidate = makeCandidate();
    const ordinaryRunDir = path.join(sandbox, "ordinary");
    const ordinaryUnit = matrixGroup("S1").units.find((unit) => unit.id === "autorefresh-on");
    assert.equal(ordinaryUnit.fixtureRequirement, undefined);
    const { progress: ordinaryProgress } = await writeMatrixCapture(ordinaryRunDir, "capture", ordinaryCandidate, {
      groups: ["S1"],
      modes: ["light"],
    });
    const ordinary = await readCapturedUnitEvidence({
      unitDir: path.join(ordinaryRunDir, "capture", "light", "states", ordinaryUnit.id),
      unit: ordinaryUnit,
      mode: "light",
      skinId: ordinaryCandidate.skinId,
      expectedRoleIds: [],
      expectedEvidenceHash: ordinaryProgress.units[`light/${ordinaryUnit.id}`].evidenceHash,
    });
    assert.equal(ordinary.state.unitId, ordinaryUnit.id);

    const alteredUnitDir = path.join(sandbox, "altered-s8-unit");
    await cp(frozenUnitDir, alteredUnitDir, { recursive: true });
    const statePath = path.join(alteredUnitDir, "state.json");
    const mutations = [
      ["missing proof", (state) => delete state.trace.fixtureRequirement],
      ["null proof", (state) => (state.trace.fixtureRequirement = null)],
      ["missing own actualHash", (state) => delete state.trace.fixtureRequirement.actualHash],
      ["wrong name", (state) => (state.trace.fixtureRequirement.name = "base")],
      ["wrong expectedHash", (state) => (state.trace.fixtureRequirement.expectedHash = getPaletteFixtureHash())],
      [
        "base actualHash claimed as match",
        (state) => {
          state.trace.fixtureRequirement.actualHash = getPaletteFixtureHash();
          state.trace.fixtureRequirement.match = true;
        },
      ],
      ["wrong actualHash", (state) => (state.trace.fixtureRequirement.actualHash = "0".repeat(64))],
      ["false match", (state) => (state.trace.fixtureRequirement.match = false)],
      ["string true is not boolean true", (state) => (state.trace.fixtureRequirement.match = "true")],
    ];

    for (const [label, mutate] of mutations) {
      const changedState = structuredClone(frozenState);
      mutate(changedState);
      await writeFile(statePath, `${JSON.stringify(changedState, null, 2)}\n`, "utf8");
      const recomputedHash = await hashEvidenceTree(alteredUnitDir);
      assert.notEqual(recomputedHash, frozenEvidenceHash, `${label}: the altered tree hash must differ`);
      await assert.rejects(
        () =>
          readCapturedUnitEvidence({
            unitDir: alteredUnitDir,
            unit: historicalFixtureUnit,
            mode: "light",
            skinId: "chatgpt",
            expectedRoleIds: ["warning.timeline-range"],
            expectedEvidenceHash: recomputedHash,
          }),
        /trace\.fixtureRequirement/,
        `${label}: semantic rejection must happen after accepting the recomputed evidence hash`,
      );
    }

    const unrehashedState = structuredClone(frozenState);
    unrehashedState.trace.fixtureRequirement.actualHash = getPaletteFixtureHash();
    await writeFile(statePath, `${JSON.stringify(unrehashedState, null, 2)}\n`, "utf8");
    await assert.rejects(
      () =>
        readCapturedUnitEvidence({
          unitDir: alteredUnitDir,
          unit: historicalFixtureUnit,
          mode: "light",
          skinId: "chatgpt",
          expectedRoleIds: ["warning.timeline-range"],
          expectedEvidenceHash: frozenEvidenceHash,
        }),
      /证据文件摘要与 progress\.json 不一致/,
      "without a recomputed hash, existing tree integrity rejection still applies",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("矩阵固定顺序：S1 开启态复测在前、autorefresh-error 收尾且带确定性恢复", () => {
  const s1 = matrixGroup("S1").units;
  assert.equal(s1[0].id, "autorefresh-on");
  const enabledState = STATE_CATALOG.find((state) => state.id === s1[0].stateId);
  assert.deepEqual(enabledState?.steps, [
    { action: "click", selector: '#presetButtons button[data-preset="all"]' },
    { action: "ensureClick", selector: "#autoRefreshToggle", until: '#autoRefreshToggle[aria-pressed="true"]' },
  ]);
  const last = s1[s1.length - 1];
  assert.equal(last.id, "autorefresh-error", "autorefresh-error 必须收尾：它依赖开启态且自身要恢复");
  assert.equal(last.routeFault, "/api/usage");
  assert.ok(last.readyTimeoutMs > 15000, "错误态的触发要连续拨动开关并等请求失败，timeout 单独放宽");
  assert.deepEqual(last.recovery.unrouteFault, true);
  assert.ok(last.recovery.steps.length > 0, "恢复必须走确定性动作，不能只靠 60s 后的自然轮询");
  assert.equal(last.recovery.expectGone, ".auto-refresh-error.is-error");
  // focus.outline 在目录里是句人话（机测不可用），Tab 命中的控件又在首屏之外：
  // 必须登记目标元素取证，否则"局部截图"这条证据要求落空
  const focus = s1.find((unit) => unit.id === "keyboard-focus");
  assert.deepEqual(focus.evidenceTargets, ["#addImportButton"], "焦点环必须有原尺寸元素截图");
});

test("D 组：恰好两个桌面 CSS 视口 × 两个状态，不重复弹窗状态", () => {
  const d = matrixGroup("D").units;
  assert.deepEqual(
    d.map((unit) => `${unit.viewport.width}x${unit.viewport.height}-${unit.stateId}`),
    ["2560x1440-dashboard-default", "2560x1440-dense-data", "1280x720-dashboard-default", "1280x720-dense-data"],
  );
  for (const unit of d) {
    assert.ok([2560, 1280].includes(unit.viewport.width));
    assert.equal(unit.viewport.height, unit.viewport.width === 2560 ? 1440 : 720);
    assert.ok(["dashboard-default", "dense-data"].includes(unit.stateId), "D 组不展开全部弹窗状态");
    assert.equal(unit.clipSelector, undefined);
    assert.equal(unit.handler, undefined);
  }
});

test("D 组取证：settle 后仅两个目标状态关闭聚光，失败阻断截图/几何/M3", async () => {
  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const functionStart = captureSource.indexOf("async function runStateUnit({");
  const functionEnd = captureSource.indexOf("\n}\n\n/** S7 规程一", functionStart) + 2;
  assert.ok(functionStart >= 0 && functionEnd > functionStart, "canary 必须执行真实 runStateUnit");
  const privateRunStateUnit = captureSource.slice(functionStart, functionEnd);

  const execute = async ({ group, stateId, spotlightError = null }) => {
    const calls = [];
    const errors = {
      pageErrors: [],
      consoleErrors: [],
      requestFailed: [],
      resourceFailures: [],
      blockedExternal: [],
    };
    const state = STATE_CATALOG.find((item) => item.id === stateId);
    assert.ok(state, `缺少测试状态 ${stateId}`);
    const args = {
      ctx: {
        errors,
        page: {
          async evaluate(source) {
            if (source === "layout") {
              calls.push("geometry");
              return { viewport: { width: 1280, height: 720, dpr: 1 } };
            }
            if (source === "declarations") return { declarations: {} };
            throw new Error(`unexpected page.evaluate: ${source}`);
          },
          async screenshot() {
            calls.push("screenshot");
            return Buffer.alloc(0);
          },
        },
      },
      unit: { id: `probe-${group}-${stateId}`, kind: "catalog", group, stateId },
      mode: "dark",
      skinId: "chatgpt",
      candidate: null,
      expectedPairs: {},
      otherModePairs: {},
      policy: {},
      stateTimeoutMs: 50,
      baselineTimeoutMs: 50,
      attempt: 1,
      fixtureHash: null,
    };
    const sandbox = {
      args,
      STATE_BY_ID: new Map([[stateId, state]]),
      snapshotErrorCounts: () =>
        Object.fromEntries(
          ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"].map((key) => [
            key,
            errors[key].length,
          ]),
        ),
      errorDelta: () => structuredClone(errors),
      applyStateStep: async (_page, _step, { phase }) => {
        calls.push(phase === "restore" ? "restore" : "trigger");
        return { ok: true };
      },
      rewriteCatalogStep: (step) => step,
      evaluateReady: async () => false,
      waitStateReady: async () => {
        calls.push("ready");
        return { ok: true, kind: "test", selector: null, ms: 0 };
      },
      settleStateEvidenceViewport: async () => {
        calls.push("settle");
      },
      applySpotlight: async (_page, value, _timeout, record) => {
        calls.push("spotlight");
        if (spotlightError) throw spotlightError;
        record.spotlight = { value, point: { x: 10, y: 20 }, ms: 1 };
      },
      ROLE_CATALOG: [],
      adaptRoleCatalogForMeasurement: (catalog) => catalog,
      measureBrowserRoles: async () => {
        calls.push("measure");
        return {};
      },
      failedCatalogMeasurement: () => {
        throw new Error("unexpected measurement failure");
      },
      measurementErrorTrace: (error) => ({ message: error.message }),
      rebaselineToAll: async () => {
        calls.push("rebaseline");
        return { ok: true };
      },
      buildLayoutProbeSource: () => "layout",
      buildDeclarationsProbeSource: () => "declarations",
      diffPaletteDeclarations: () => [],
      buildStateBlockers: () => [],
    };
    const result = await vm.runInNewContext(`${privateRunStateUnit}\nrunStateUnit(args)`, sandbox);
    return { result, calls };
  };

  for (const stateId of ["dashboard-default", "dense-data"]) {
    const { result, calls } = await execute({ group: "D", stateId });
    assert.equal(result.status, "captured", JSON.stringify(result.blockers));
    assert.equal(result.trace.restingPointer.spotlight.value, "off");
    const settle = calls.indexOf("settle");
    const spotlight = calls.indexOf("spotlight");
    const screenshot = calls.indexOf("screenshot");
    const geometry = calls.indexOf("geometry");
    const measure = calls.indexOf("measure");
    assert.ok(
      settle >= 0 && settle < spotlight && spotlight < screenshot && screenshot < geometry && geometry < measure,
      `${stateId} 的执行顺序必须是 settle → spotlight-off → 截图 → 几何 → M3：${calls.join(" → ")}`,
    );
  }

  for (const probe of [
    { group: "S5", stateId: "dashboard-default" },
    { group: "D", stateId: "spotlight-detail-bars" },
  ]) {
    const { result, calls } = await execute(probe);
    assert.equal(result.status, "captured", JSON.stringify(result.blockers));
    assert.equal(calls.includes("spotlight"), false, `${probe.group}/${probe.stateId} 不得关闭聚光`);
    assert.equal(result.trace.restingPointer, undefined);
  }

  const failure = new Error("spotlight off failed");
  const { result, calls } = await execute({
    group: "D",
    stateId: "dashboard-default",
    spotlightError: failure,
  });
  assert.equal(result.status, "failed");
  assert.match(result.trace.restingPointer.error, /spotlight off failed$/);
  assert.ok(result.blockers.some((blocker) => blocker.includes("状态取证失败") && blocker.includes(failure.message)));
  assert.equal(calls.includes("screenshot"), false, "聚光失败后不得截图");
  assert.equal(calls.includes("geometry"), false, "聚光失败后不得生成几何");
  assert.equal(calls.includes("measure"), false, "聚光失败后不得执行 M3");
  assert.equal(result.geometry, null);
  assert.equal(result.measurement, null);
});

test("B67：基准 M3 仅在 restingPointer===true 时接详情行落点回调", async (t) => {
  const source = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function runBaselineCapture({");
  const end =
    source.indexOf(
      "\n}\n\n// ---------------------------------------------------------------------------\n// 单模式捕获",
      start,
    ) + 2;
  assert.ok(start >= 0 && end > start, "B67 canary 必须执行真实 runBaselineCapture");
  const privateRunBaselineCapture = source.slice(start, end);

  const execute = async ({ restingPointer, failAt = null }) => {
    const calls = { applySpotlight: 0, measureOptions: [] };
    const failure = new Error("B67 baseline resting pointer failure");
    const page = {
      async goto() {},
      async evaluate(evaluateSource) {
        if (evaluateSource === "declarations") {
          return {
            declarations: {},
            dataset: {},
            backgrounds: {},
            stylesheets: [],
            unrenderedMetrics: 1,
          };
        }
        if (evaluateSource === "layout") return { viewport: { width: 1280, height: 720, dpr: 1 } };
        return { x: 0, y: 0 };
      },
      async screenshot() {
        return Buffer.alloc(1);
      },
    };
    const sandbox = {
      applySpotlight: async (_page, value, _timeout, record) => {
        calls.applySpotlight += 1;
        if (calls.applySpotlight === failAt) throw failure;
        record.spotlight = {
          value,
          point: { x: 10, y: 20 },
          nextPoint: { x: 11, y: 21 },
          ms: 1,
        };
      },
      awaitRuntimeReady: async () => {},
      BASELINE_STATE_ID: "dashboard-default",
      buildBootstrapReadySource: () => "bootstrap",
      buildDeclarationsProbeSource: () => "declarations",
      buildLayoutProbeSource: () => "layout",
      buildResourceBlockers: () => [],
      captureStableFullPage: async () => Buffer.alloc(1),
      diffPaletteDeclarations: () => [],
      measureBrowserRoles: async (options) => {
        calls.measureOptions.push(options);
        if (options.detailFillRestingPointer) {
          await options.detailFillRestingPointer();
          await options.detailFillRestingPointer();
        }
        return {
          records: [],
          captures: [],
          diagnostics: { counts: { pass: 0, fail: 0, unmeasured: 0, notApplicable: 0 } },
        };
      },
      mkdir: async () => {},
      normalizeMeasurementIdentity: ({ candidateId, records, diagnostics }) => ({
        candidateId,
        records,
        diagnostics,
      }),
      PAINT_SETTLE_SOURCE: "paint",
      path,
      ROLE_CATALOG: [],
      saveScreenshotBuffer: async () => "shot.png",
      waitOk: async () => true,
      writeFile: async () => {},
      writeJson: async () => {},
    };
    sandbox.args = {
      ctx: {
        page,
        errors: {
          pageErrors: [],
          consoleErrors: [],
          requestFailed: [],
          resourceFailures: [],
          blockedExternal: [],
        },
        counters: { moduleRequestCount: 0, pricingRefreshInterceptions: 0 },
        heldRoutes: [{}],
        firstModuleRequestHeld: Promise.resolve(),
        releaseHeldRoutes: async () => {},
      },
      mode: "dark",
      skinId: "chatgpt",
      candidate: null,
      expectedPairs: [],
      outModeDir: "E:/probe",
      stateTimeoutMs: 50,
      policy: {},
      measureRoles: true,
      captureEvidence: true,
      restingPointer,
    };
    const result = await vm.runInNewContext(`${privateRunBaselineCapture}\nrunBaselineCapture(args)`, sandbox);
    return { result, calls, failure };
  };

  await t.test("true 时复用一个闭包，并把每次实际 record 留在 readiness", async () => {
    const { result, calls } = await execute({ restingPointer: true });

    assert.equal(result.status, "captured", JSON.stringify(result.blockers));
    assert.equal(typeof calls.measureOptions[0].detailFillRestingPointer, "function");
    assert.equal(calls.applySpotlight, 3);
    assert.equal(result.readiness.spotlight.off, true);
    assert.equal(result.readiness.spotlight.calls.length, 3);
    assert.ok(result.readiness.spotlight.calls.every((record) => record.spotlight?.value === "off"));
  });

  await t.test("false 时 M3 不收回调，也不移动基准指针", async () => {
    const { result, calls } = await execute({ restingPointer: false });

    assert.equal(result.status, "captured", JSON.stringify(result.blockers));
    assert.equal(Object.hasOwn(calls.measureOptions[0], "detailFillRestingPointer"), false);
    assert.equal(calls.applySpotlight, 0);
    assert.equal(result.readiness.spotlight, undefined);
  });

  await t.test("回调失败保留原错并让 readiness 中的调用 record 可见", async () => {
    const { result, calls, failure } = await execute({ restingPointer: true, failAt: 2 });

    assert.equal(result.status, "failed");
    assert.equal(calls.applySpotlight, 2);
    assert.ok(result.blockers.some((blocker) => blocker.includes(failure.message)));
    assert.equal(result.readiness.spotlight.off, false);
    assert.equal(result.readiness.spotlight.calls.length, 2);
    assert.match(result.readiness.spotlight.calls[1].error, /B67 baseline resting pointer failure/);
  });
});

test("B67：状态单元只给普通图表详情角色传落点回调", async (t) => {
  const source = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function runStateUnit({");
  const end = source.indexOf("\n}\n\n/** S7 规程一", start) + 2;
  assert.ok(start >= 0 && end > start, "B67 canary 必须执行真实 runStateUnit");
  const privateRunStateUnit = source.slice(start, end);

  const execute = async ({ stateId, group, failCallback = false }) => {
    const state = STATE_CATALOG.find((item) => item.id === stateId);
    assert.ok(state, `缺少 B67 测试状态 ${stateId}`);
    const calls = { applySpotlight: 0, measureOptions: [] };
    const failure = new Error("B67 state resting pointer failure");
    const errors = {
      pageErrors: [],
      consoleErrors: [],
      requestFailed: [],
      resourceFailures: [],
      blockedExternal: [],
    };
    const page = {
      async evaluate(evaluateSource) {
        if (evaluateSource === "layout") return { viewport: { width: 1280, height: 720, dpr: 1 } };
        if (evaluateSource === "declarations") return { declarations: {} };
        throw new Error(`unexpected page.evaluate: ${evaluateSource}`);
      },
      async screenshot() {
        return Buffer.alloc(1);
      },
    };
    const args = {
      ctx: { errors, page },
      unit: { id: `probe-${stateId}`, kind: "catalog", group, stateId },
      mode: "dark",
      skinId: "chatgpt",
      candidate: null,
      expectedPairs: {},
      otherModePairs: {},
      policy: {},
      stateTimeoutMs: 50,
      baselineTimeoutMs: 50,
      attempt: 1,
      fixtureHash: null,
    };
    const sandbox = {
      args,
      STATE_BY_ID: new Map([[stateId, state]]),
      snapshotErrorCounts: () =>
        Object.fromEntries(
          ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"].map((key) => [
            key,
            errors[key].length,
          ]),
        ),
      errorDelta: () => structuredClone(errors),
      applyStateStep: async () => ({ ok: true }),
      rewriteCatalogStep: (step) => step,
      evaluateReady: async () => false,
      waitStateReady: async () => ({ ok: true, kind: "test", selector: null, ms: 0 }),
      settleStateEvidenceViewport: async () => {},
      applySpotlight: async (_page, value, _timeout, record) => {
        calls.applySpotlight += 1;
        if (failCallback) throw failure;
        record.spotlight = { value, point: { x: 10, y: 20 }, ms: 1 };
      },
      ROLE_CATALOG: [],
      adaptRoleCatalogForMeasurement: (catalog) => catalog,
      measureBrowserRoles: async (options) => {
        calls.measureOptions.push(options);
        if (options.detailFillRestingPointer) {
          await options.detailFillRestingPointer();
          await options.detailFillRestingPointer();
        }
        return {};
      },
      failedCatalogMeasurement: (error) => ({
        measurement: null,
        phase: null,
        packet: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      }),
      measurementErrorTrace: (error) => ({
        message: error instanceof Error ? error.message : String(error),
      }),
      PAINT_SETTLE_SOURCE: "paint",
      rebaselineToAll: async () => ({ ok: true }),
      buildLayoutProbeSource: () => "layout",
      buildDeclarationsProbeSource: () => "declarations",
      diffPaletteDeclarations: () => [],
      buildStateBlockers: () => [],
      STEP_FAILURE_PREFIXES: [],
    };
    const result = await vm.runInNewContext(`${privateRunStateUnit}\nrunStateUnit(args)`, sandbox);
    return { result, calls, failure };
  };

  await t.test("dashboard-default 普通态传闭包并逐次记录", async () => {
    const { result, calls } = await execute({ stateId: "dashboard-default", group: "S0" });

    assert.equal(result.status, "captured", JSON.stringify(result.blockers));
    assert.equal(typeof calls.measureOptions[0].detailFillRestingPointer, "function");
    assert.equal(result.trace.detailFillRestingPointer.length, 2);
    assert.equal(calls.applySpotlight, 2);
    assert.ok(result.trace.detailFillRestingPointer.every((record) => record.spotlight?.value === "off"));
  });

  await t.test("spotlight-detail-fill active 不传回调，也不移动指针", async () => {
    const { result, calls } = await execute({ stateId: "spotlight-detail-fill", group: "S6" });

    assert.equal(result.status, "captured", JSON.stringify(result.blockers));
    assert.equal(Object.hasOwn(calls.measureOptions[0], "detailFillRestingPointer"), false);
    assert.equal(result.trace.detailFillRestingPointer, undefined);
    assert.equal(calls.applySpotlight, 0);
  });

  await t.test("不含 chart.detail-fill 的普通态不传回调", async () => {
    const { result, calls } = await execute({ stateId: "dense-data", group: "S5" });

    assert.equal(result.status, "captured", JSON.stringify(result.blockers));
    assert.equal(Object.hasOwn(calls.measureOptions[0], "detailFillRestingPointer"), false);
    assert.equal(result.trace.detailFillRestingPointer, undefined);
    assert.equal(calls.applySpotlight, 0);
  });

  await t.test("回调失败进入现有测量失败路径并保留 trace record", async () => {
    const { result, calls, failure } = await execute({
      stateId: "dashboard-default",
      group: "S0",
      failCallback: true,
    });

    assert.equal(result.status, "failed");
    assert.equal(calls.applySpotlight, 1);
    assert.ok(result.blockers.some((blocker) => blocker.includes(failure.message)));
    assert.match(result.trace.detailFillRestingPointer[0].error, /B67 state resting pointer failure/);
    assert.match(result.trace.measurementFailure.error.message, /B67 state resting pointer failure/);
  });
});

test("B65 聚光 off 只落在视口内可命中的凹陷候选，两次移动均有命中证明", async () => {
  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  const functionStart = captureSource.indexOf("async function applySpotlight(");
  const functionEnd = captureSource.indexOf("\n}\n\n/** 经产品自身运行时钩子改皮肤状态", functionStart) + 2;
  assert.ok(functionStart >= 0 && functionEnd > functionStart, "canary 必须执行真实 applySpotlight");
  const privateApplySpotlight = captureSource.slice(functionStart, functionEnd);

  const node = (name, rect, children = []) => ({
    name,
    children,
    getBoundingClientRect: () => rect,
    contains(hit) {
      return hit === this || this.children.some((child) => child.contains?.(hit) || child === hit);
    },
  });

  const execute = async ({ value, offCandidates = [], onNode = null, elementAt = () => null }) => {
    const moves = [];
    const hits = [];
    const record = {};
    const page = {
      async evaluate(source, ...args) {
        return vm.runInNewContext(
          `(${String(source)})(${args.map((argument) => JSON.stringify(argument)).join(",")})`,
          {
            window: { innerWidth: 1000, innerHeight: 700 },
            document: {
              querySelector(selector) {
                assert.equal(selector, ".topbar");
                return onNode;
              },
              querySelectorAll(selector) {
                assert.equal(selector, ".metric > strong, #timelineChart, .timeline-chart-well");
                return offCandidates;
              },
              elementFromPoint(x, y) {
                hits.push({ x, y });
                return elementAt(x, y);
              },
            },
          },
        );
      },
      mouse: {
        async move(x, y) {
          moves.push({ x, y });
        },
      },
      async waitForFunction() {
        return true;
      },
    };
    const applySpotlight = vm.runInNewContext(`${privateApplySpotlight}\napplySpotlight`, { page });
    await applySpotlight(page, value, 50, record);
    return { moves, hits, record };
  };

  const visibleChild = node("visible-child", {});
  const visible = node("visible", { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 }, [
    visibleChild,
  ]);
  const offscreen = node("offscreen", { left: 100, top: 750, right: 300, bottom: 790, width: 200, height: 40 });
  const fallback = await execute({
    value: "off",
    offCandidates: [offscreen, visible],
    elementAt: (x, y) => ((x === 200 && y === 150) || (x === 201 && y === 151) ? visibleChild : null),
  });
  assert.deepEqual(fallback.moves, [
    { x: 200, y: 150 },
    { x: 201, y: 151 },
  ]);
  assert.equal(fallback.record.spotlight.point.x, 200);
  assert.equal(fallback.record.spotlight.point.y, 150);
  assert.equal(fallback.record.spotlight.nextPoint.x, 201);
  assert.equal(fallback.record.spotlight.nextPoint.y, 151);

  const fractionalNarrow = node("fractional-narrow", {
    left: 100.7,
    top: 100.7,
    right: 101.2,
    bottom: 101.2,
    width: 0.5,
    height: 0.5,
  });
  const fractionalFallback = await execute({
    value: "off",
    offCandidates: [fractionalNarrow, visible],
    elementAt: (x, y) => {
      if ((x === 100 || x === 101) && (y === 100 || y === 101)) return fractionalNarrow;
      if ((x === 200 && y === 150) || (x === 201 && y === 151)) return visibleChild;
      return null;
    },
  });
  assert.deepEqual(fractionalFallback.moves, [
    { x: 200, y: 150 },
    { x: 201, y: 151 },
  ]);

  const rightBottomBoundary = node("right-bottom-boundary", {
    left: 100,
    top: 100,
    right: 102,
    bottom: 102,
    width: 2,
    height: 2,
  });
  const boundaryFallback = await execute({
    value: "off",
    offCandidates: [rightBottomBoundary, visible],
    elementAt: (x, y) => {
      if ((x === 101 || x === 102) && (y === 101 || y === 102)) return rightBottomBoundary;
      if ((x === 200 && y === 150) || (x === 201 && y === 151)) return visibleChild;
      return null;
    },
  });
  assert.deepEqual(boundaryFallback.moves, [
    { x: 200, y: 150 },
    { x: 201, y: 151 },
  ]);

  const firstChild = node("first-child", {});
  const secondChild = node("second-child", {});
  const first = node("first", { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 }, [firstChild]);
  const second = node("second", { left: 400, top: 100, right: 600, bottom: 200, width: 200, height: 100 }, [
    secondChild,
  ]);
  const secondPointCovered = await execute({
    value: "off",
    offCandidates: [first, second],
    elementAt: (x, y) => {
      if (x === 200 && y === 150) return firstChild;
      if (x === 201 && y === 151) return null;
      if ((x === 500 && y === 150) || (x === 501 && y === 151)) return secondChild;
      return null;
    },
  });
  assert.deepEqual(secondPointCovered.moves, [
    { x: 500, y: 150 },
    { x: 501, y: 151 },
  ]);

  const covered = node("covered", { left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 });
  let rejected = null;
  try {
    await execute({
      value: "off",
      offCandidates: [offscreen, covered],
      elementAt: () => null,
    });
  } catch (error) {
    rejected = error;
  }
  assert.match(String(rejected?.message), /setSpotlight off: 找不到指针落点/);

  const onNode = node("topbar", { x: 10, y: 20, width: 100, height: 50 });
  const on = await execute({
    value: "on",
    onNode,
    elementAt() {
      throw new Error("on 不得查询凹陷命中原语");
    },
  });
  assert.deepEqual(on.moves, [
    { x: 60, y: 45 },
    { x: 61, y: 46 },
  ]);
  assert.deepEqual(on.hits, []);
});

test("未测项登记：目标机器的显示缩放/浏览器 zoom 人工复核必须显式列出，且不做 390px 移动矩阵", () => {
  assert.ok(Array.isArray(MATRIX_UNTESTED) && MATRIX_UNTESTED.length > 0);
  assert.ok(MATRIX_UNTESTED.some((item) => item.includes("显示缩放") && item.includes("zoom")));
  assert.ok(
    !JSON.stringify(STATE_MATRIX_GROUPS).includes("390"),
    "卡面明确不做 390px 移动端矩阵：矩阵里不得出现该视口",
  );
});

test("日历适配：所有选区清空都改写为条件点击，选完终点后按状态需要重开弹层", async () => {
  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  assert.ok(
    captureSource.includes('matchSelector: "[data-date-picker-clear]"') &&
      captureSource.includes('to: { action: "clickIfEnabled" }'),
    "日期选区单元必须把“清除”改写为点击-if-enabled",
  );
  assert.ok(captureSource.includes("function rewriteCatalogStep"), "改写必须是显式函数并在轨迹里留 rewrittenFrom");
  assert.ok(
    captureSource.includes('postSteps: [{ action: "click", selector: "#dateRangeButton" }]'),
    "选完终点后要重开弹层才会渲染 range-end",
  );
});

test("状态就绪等待源：四类就绪的布尔语义与坏输入", () => {
  const matches = buildStateReadyWaitSource({ kind: "matches", selector: ".x.active" });
  assert.equal(
    vm.runInNewContext(matches, { document: { querySelector: (sel) => (sel === ".x.active" ? {} : null) } }),
    true,
  );
  assert.equal(vm.runInNewContext(matches, { document: { querySelector: () => null } }), false);
  assert.equal(
    vm.runInNewContext(buildStateReadyWaitSource({ kind: "exists", selector: "#a" }), {
      document: { querySelector: () => null },
    }),
    false,
  );
  // visible：矩形与可见性都要算（visibility:hidden 与零尺寸都不算就绪）
  const visible = buildStateReadyWaitSource({ kind: "visible", selector: "#d" });
  assert.equal(
    vm.runInNewContext(visible, {
      document: { querySelector: () => ({ getBoundingClientRect: () => ({ width: 12, height: 4 }) }) },
      getComputedStyle: () => ({ visibility: "visible" }),
    }),
    true,
  );
  assert.equal(
    vm.runInNewContext(visible, {
      document: { querySelector: () => ({ getBoundingClientRect: () => ({ width: 0, height: 4 }) }) },
      getComputedStyle: () => ({ visibility: "visible" }),
    }),
    false,
  );
  assert.equal(
    vm.runInNewContext(visible, {
      document: { querySelector: () => null },
      getComputedStyle: () => ({ visibility: "visible" }),
    }),
    false,
  );
  // nonZeroText：未渲染占位（"-"）不算，至少一个正数才就绪
  const nonZero = buildStateReadyWaitSource({ kind: "nonZeroText", selector: ".metric strong" });
  assert.equal(
    vm.runInNewContext(nonZero, {
      document: { querySelectorAll: () => [{ textContent: "-" }, { textContent: "1,234" }] },
    }),
    true,
  );
  assert.equal(vm.runInNewContext(nonZero, { document: { querySelectorAll: () => [{ textContent: "-" }] } }), false);
  assert.equal(vm.runInNewContext(nonZero, { document: { querySelectorAll: () => [] } }), false);
  // dataCount：达到 min 才就绪
  const count = buildStateReadyWaitSource({ kind: "dataCount", selector: ".comparison-table tbody tr", min: 8 });
  assert.equal(vm.runInNewContext(count, { document: { querySelectorAll: () => new Array(8).fill({}) } }), true);
  assert.equal(vm.runInNewContext(count, { document: { querySelectorAll: () => new Array(7).fill({}) } }), false);
  assert.throws(() => buildStateReadyWaitSource({ kind: "dataCount", selector: ".r" }), /min/);
  assert.throws(() => buildStateReadyWaitSource({ kind: "galaxy", selector: ".r" }), /未知就绪类型/);
  assert.throws(() => buildStateReadyWaitSource(null), TypeError);
  assert.throws(() => buildStateReadyWaitSource("matches"), TypeError);
});

test("日历翻月计划：同月不前跳、跨年前后向与次数正确", () => {
  assert.deepEqual(planMonthNavigation({ year: 2026, month: 10 }, "2026-10-03"), { action: "none", clicks: 0 });
  assert.deepEqual(planMonthNavigation({ year: 2026, month: 10 }, "2026-09-26"), { action: "prev", clicks: 1 });
  assert.deepEqual(planMonthNavigation({ year: 2026, month: 10 }, "2026-07-31"), { action: "prev", clicks: 3 });
  assert.deepEqual(planMonthNavigation({ year: 2026, month: 1 }, "2025-11-30"), { action: "prev", clicks: 2 });
  assert.deepEqual(planMonthNavigation({ year: 2026, month: 10 }, "2026-11-02"), { action: "next", clicks: 1 });
  assert.deepEqual(planMonthNavigation({ year: 2026, month: 12 }, "2027-02-01"), { action: "next", clicks: 2 });
  assert.throws(() => planMonthNavigation({ year: 2026, month: 10 }, "2026-1-3"), /YYYY-MM-DD/);
  assert.throws(() => planMonthNavigation({ year: 2026, month: 10 }, null), /YYYY-MM-DD/);
  assert.throws(() => planMonthNavigation({ year: 2026, month: 13 }, "2026-11-03"), TypeError);
  assert.throws(() => planMonthNavigation(null, "2026-11-03"), TypeError);
});

test("状态单元阻断：四类错误逐项阻断，空记录不阻断", () => {
  const clean = { pageErrors: [], consoleErrors: [], requestFailed: [], resourceFailures: [] };
  assert.deepEqual(buildStateBlockers(clean), [], "干净记录不得产生阻断");
  assert.deepEqual(buildStateBlockers(null), []);
  for (const key of ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures"]) {
    const blockers = buildStateBlockers({ ...clean, [key]: ["boom"] });
    assert.equal(blockers.length, 1, `${key} 单独出现必须阻断`);
    assert.ok(blockers[0].includes("boom"));
  }
});

test("恢复执行摘要比对：皮肤身份、重试预算及 sourceHashes 绑定后才允许续跑", () => {
  const digests = {
    candidate: { id: "chatgpt-a-abc" },
    candidateHash: "h".repeat(64),
    skinId: "chatgpt",
    retryPolicy: { version: 1, maxAttemptsPerUnit: 2 },
    policyHash: "p".repeat(64),
    fixtureHash: "f".repeat(64),
    sourceHashes: {
      "public/app.js": "a",
      "public/timeline-utils.js": "t",
      "scripts/skin-palette/capture.mjs": "b",
    },
  };
  assert.equal(resumeDigestsMatch(JSON.parse(JSON.stringify(digests)), digests), true);
  // candidate 是对象：progress.json 解析出来的副本与本次新构造的对象引用不同，
  // 按引用比会把每一次候选续跑都误判为不一致（本断言守护该回归）
  assert.equal(
    resumeDigestsMatch({ ...digests, candidate: { id: "chatgpt-a-abc" } }, digests),
    true,
    "结构相同的 candidate 副本必须判为一致",
  );
  assert.equal(
    resumeDigestsMatch({ ...digests, candidate: { id: "chatgpt-a-xyz" } }, digests),
    false,
    "候选身份变了不得续跑",
  );
  assert.equal(resumeDigestsMatch({ ...digests, fixtureHash: "other" }, digests), false, "fixture 换了不得续跑");
  assert.equal(resumeDigestsMatch({ ...digests, skinId: "claude" }, digests), false, "正式/候选皮肤身份变化不得续跑");
  assert.equal(
    resumeDigestsMatch({ ...digests, retryPolicy: { version: 1, maxAttemptsPerUnit: 3 } }, digests),
    false,
    "跨续跑重试预算变化不得复用旧进度",
  );
  assert.equal(resumeDigestsMatch({ ...digests, candidateHash: "other" }, digests), false, "候选换了不得续跑");
  assert.equal(resumeDigestsMatch({ ...digests, policyHash: "other" }, digests), false, "policy 换了不得续跑");
  assert.equal(
    resumeDigestsMatch({ ...digests, sourceHashes: { ...digests.sourceHashes, "public/app.js": "changed" } }, digests),
    false,
    "工具自身（capture.mjs 在 sourceHashes 里）改过不得续跑",
  );
  const missingTimeline = { ...digests.sourceHashes };
  delete missingTimeline["public/timeline-utils.js"];
  assert.equal(
    resumeDigestsMatch({ ...digests, sourceHashes: missingTimeline }, digests),
    false,
    "缺少 timeline-utils.js 摘要的旧进度不能续跑",
  );
  assert.equal(
    resumeDigestsMatch(
      { ...digests, sourceHashes: { ...digests.sourceHashes, "public/timeline-utils.js": "changed" } },
      digests,
    ),
    false,
    "timeline-utils.js 源码变化不得续跑",
  );
  assert.equal(
    resumeDigestsMatch({ ...digests, sourceHashes: { "public/app.js": "a" } }, digests),
    false,
    "源文件集合变化不得续跑",
  );
  assert.equal(resumeDigestsMatch(null, digests), false);
  assert.equal(resumeDigestsMatch(digests, null), false);

  const formal = {
    ...digests,
    candidate: null,
    candidateHash: null,
    skinId: "chatgpt",
  };
  assert.equal(resumeDigestsMatch({ ...formal }, formal), true, "同一正式皮肤允许续跑");
  assert.equal(
    resumeDigestsMatch({ ...formal, skinId: "claude" }, formal),
    false,
    "candidate=null 从 ChatGPT 切到 Claude 必须拒绝续跑",
  );
});

test("恢复计划：已 captured 跳过，缺测与失败进补缺队列", () => {
  const plan = planResume(["light/a", "light/b", "light/c", "dark/a"], {
    "light/a": { status: "captured" },
    "light/c": { status: "failed", attempts: 2 },
  });
  assert.deepEqual(plan.skip, ["light/a"], "已有成功证据的单元必须跳过（不覆盖）");
  assert.deepEqual(plan.pending, ["light/b", "light/c", "dark/a"], "缺测与失败都要进补缺队列");
  assert.throws(() => planResume("light/a", {}), TypeError);
  assert.deepEqual(planResume([], {}), { pending: [], skip: [] });
});

test("D8j-adapter：兼容适配原样保留角色目录、对象身份和 foreground", () => {
  const catalog = ["badge.record", "chart.legend-swatch", "focus.outline", "chart.model-bar", "page.body-text"].map(
    (id) => ROLE_CATALOG.find((role) => role.id === id),
  );
  const [badge, legend, explicitForeground, thresholdless, text] = catalog;
  const adapted = adaptRoleCatalogForMeasurement(catalog);

  assert.strictEqual(adapted, catalog, "兼容适配不得复制目录数组");
  assert.deepEqual(adapted, catalog);
  assert.strictEqual(adapted[0], badge);
  assert.strictEqual(adapted[1], legend);
  assert.strictEqual(adapted[2], explicitForeground);
  assert.strictEqual(adapted[3], thresholdless);
  assert.strictEqual(adapted[4], text);
  assert.equal(badge.foreground, null);
  assert.equal(legend.foreground, null);
  assert.equal(explicitForeground.kind, "graphic");
  assert.notEqual(explicitForeground.foreground, null);
  assert.equal(thresholdless.threshold, null);
  assert.equal(text.kind, "text");
  assert.throws(() => adaptRoleCatalogForMeasurement(null), TypeError);
  assert.throws(() => adaptRoleCatalogForMeasurement({}), TypeError);
});

test("接线金丝雀：进度随单元落盘、最多重试一次、不覆盖成功证据、服务级故障可中断", async () => {
  const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
  assert.ok(captureSource.includes('markUnit(key, "captured"'), "每个单元成功后必须登记 progress（恢复执行的地基）");
  assert.ok(
    captureSource.includes("`attempt-" + "${" + "attemptNumber}`"),
    "失败尝试必须按全局单元尝试号落入 attempt-N 目录",
  );
  assert.ok(captureSource.includes("MAX_MATRIX_ATTEMPTS_PER_UNIT = 2"), "同一单元跨续跑最多执行两次");
  assert.ok(captureSource.includes("attemptsAlreadyUsed(key, unitDir) + 1"), "续跑必须从已有尝试号继续");
  assert.ok(
    captureSource.includes('if (progress.units[key]?.status === "captured")'),
    "续跑必须跳过已捕获单元，成功证据不覆盖",
  );
  assert.ok(
    /if \(outcome\.status === "unreachable"\)/.test(captureSource),
    "前置条件未命中必须是独立状态：不重试、不计失败",
  );
  assert.ok(/serviceBroken = true/.test(captureSource), "新上下文基准不可达必须中断本模式剩余单元（服务级故障）");
  assert.ok(captureSource.includes("resumeDigestsMatch(saved.digests, digests)"), "续跑前必须比对摘要绑定");
  assert.ok(captureSource.includes("await writeProgress();"), "进度必须随完成随写，不能只在结尾写一次");
  assert.ok(captureSource.includes("trace.faultInducedErrors"), "故障注入的伴生错误必须单独记账，不得混入阻断");
  const adaptationCall = "adaptRoleCatalogForMeasurement(ROLE_CATALOG)";
  const sectionBetween = (startMarker, endMarker) => {
    const start = captureSource.indexOf(startMarker);
    const end = captureSource.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `canary must locate ${startMarker} through ${endMarker}`);
    return captureSource.slice(start, end);
  };
  const measurementPaths = [
    [
      "home-source-excluded",
      sectionBetween("export async function captureHomeSourceExcludedEvidence({", "async function runStateUnit({"),
    ],
    [
      "source-excluded",
      sectionBetween(
        '} else if (unit.handler === "source-excluded") {',
        '} else if (unit.handler === "home-source-excluded") {',
      ),
    ],
    [
      "timeline-mode-sequence",
      sectionBetween(
        "if (trace.ready?.ok && Array.isArray(unit.timelineModeSequence)) {",
        "// 4. 显式保留触发视口的单元保持不动",
      ),
    ],
    ["catalog", sectionBetween("// 5. M3 测量", "// 5b. 目标元素取证")],
  ];
  for (const [label, section] of measurementPaths) {
    assert.ok(section.includes(adaptationCall), `${label} 测量路径必须保留身份适配器调用`);
  }
  assert.equal(
    captureSource.match(/adaptRoleCatalogForMeasurement\(ROLE_CATALOG\)/g)?.length,
    measurementPaths.length,
    "所有且仅有四个生产测量入口保留身份适配器调用",
  );
  assert.ok(captureSource.includes("trace.roleScopeAdaptation = [];"), "适配轨迹字段保留为空数组");
  assert.ok(captureSource.includes("trace.roleScopeGaps = [];"), "角色缺测轨迹字段保留为空数组");
});

const unitState = (outDir, mode, unitId) =>
  readFile(path.join(outDir, mode, "states", unitId, "state.json"), "utf8").then((text) => JSON.parse(text));

function runtimeFailingSecondContextCreation(runtime) {
  return {
    executablePath: runtime.executablePath,
    chromium: {
      launch: async (options) => {
        const browser = await runtime.chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        let contextCreations = 0;
        return {
          newContext: async (...args) => {
            contextCreations += 1;
            if (contextCreations === 2) throw new Error("injected retry context creation failure");
            return newContext(...args);
          },
          version: () => browser.version(),
          close: () => browser.close(),
        };
      },
    },
  };
}

function runtimeFailingFirstImportRestore(runtime) {
  let injected = false;
  return {
    executablePath: runtime.executablePath,
    chromium: {
      launch: async (options) => {
        const browser = await runtime.chromium.launch(options);
        const newContext = browser.newContext.bind(browser);
        return {
          newContext: async (...args) => {
            const context = await newContext(...args);
            const newPage = context.newPage.bind(context);
            context.newPage = async () => {
              const page = await newPage();
              const click = page.click.bind(page);
              page.click = async (selector, ...clickArgs) => {
                if (!injected && selector === "#cancelImportButton") {
                  injected = true;
                  throw new Error("injected catalog restore failure");
                }
                return click(selector, ...clickArgs);
              };
              return page;
            };
            return context;
          },
          version: () => browser.version(),
          close: () => browser.close(),
        };
      },
    },
  };
}

test("M4.3 真机矩阵：light 模式 S1/S2/S6 全覆盖、恢复无旧色残留、未测项与摘要齐备", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  const watched = ["skin-palettes.js", "skin-bootstrap.js"];
  const before = {};
  for (const name of watched) {
    before[name] = sha256(await readFile(path.join("public", name)));
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-matrix-c1-"));
  try {
    const result = await captureStateMatrix({
      candidate: previewCandidate(),
      fixture,
      outDir: path.join(sandbox, "docs", "validation", "m43", "matrix"),
      rootDir: sandbox,
      modes: ["light"],
      measureBaseline: false,
      groups: ["S1", "S2", "S6"],
    });
    const mode = result.modes.light;
    const expectedUnits = ["S1", "S2", "S6"].flatMap((id) =>
      STATE_MATRIX_GROUPS.find((g) => g.id === id).units.map((u) => u.id),
    );
    assert.deepEqual(Object.keys(mode.states).sort(), [...expectedUnits].sort(), "矩阵必须逐单元给结果");
    assert.equal(
      mode.status,
      "captured",
      `S1/S2/S6 在 fixture 下全部可捕获：模式应为 captured；blockers=${JSON.stringify(mode.blockers)} states=${JSON.stringify(
        Object.fromEntries(
          Object.entries(mode.states).map(([id, state]) => [id, { status: state.status, blockers: state.blockers }]),
        ),
      )}`,
    );
    assert.deepEqual(mode.blockers, [], "没有操作失败就不该有阻断");
    assert.equal(
      mode.gaps.some((entry) => entry.unitId === "quota-toast"),
      false,
      "当前 fixture 的可选空 Codex 主来源使 quota-toast 真实可达",
    );
    for (const unitId of expectedUnits) {
      const entry = mode.states[unitId];
      assert.equal(entry.status, "captured", `${unitId} 必须完整捕获：${JSON.stringify(entry.blockers ?? [])}`);
    }

    // 每单元证据齐备：checks.json / geometry.json / state.png（有 clipSelector 的还有区域截图）
    for (const unitId of expectedUnits) {
      const dir = path.join(result.outDir, "light", "states", unitId);
      const checks = JSON.parse(await readFile(path.join(dir, "checks.json"), "utf8"));
      assert.equal(checks.unitId, unitId);
      assert.equal(checks.mode, "light");
      assert.equal(checks.status, "captured");
      const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
      assert.equal(state.status, checks.status);
      assert.equal(state.skinId, "chatgpt");
      assert.ok(existsSync(path.join(dir, "state.png")), `${unitId} 必须有视口截图`);
      assert.ok(existsSync(path.join(dir, "geometry.json")), `${unitId} 必须有固定元素几何`);
      assert.ok(Array.isArray(checks.records) && checks.records.length > 0, `${unitId} 必须有逐角色判据`);
      assert.equal(state.trace.declarations.postMatches, true, `${unitId} 恢复后 20 项声明必须回到本模式期望`);
      if (unitId === "autorefresh-error") {
        // 故障注入单元：失败请求与控制台噪声是“触发因”，必须全部归因到注入，
        // 且不得顺手解释掉页面异常或 ≥400 响应
        const induced = state.trace.faultInducedErrors;
        assert.ok((state.errors.requestFailed ?? []).length >= 1, "注入的失败请求必须出现在错误记录里");
        for (const entry of state.errors.requestFailed) {
          assert.ok(
            (induced?.requestFailed ?? []).some((item) => item.url === entry.url && item.error === entry.error),
            "失败请求必须逐条归因到故障注入",
          );
        }
        for (const text of state.errors.consoleErrors ?? []) {
          assert.ok((induced?.consoleErrors ?? []).includes(text), "控制台错误必须归因到故障注入的背景噪声");
        }
        assert.deepEqual(state.errors.pageErrors, [], "故障注入不得解释页面未捕获异常");
        assert.deepEqual(state.errors.resourceFailures, [], "故障注入不得解释 ≥400 响应");
        continue;
      }
      if (unitId === "quota-toast") {
        const evidence = state.trace.quotaEvidence;
        assert.equal(evidence?.started, true, "quota 专属证据采集必须启动");
        assert.deepEqual(evidence?.errors, [], "quota 专属证据采集不得记录 handler 错误");
        assert.equal(evidence?.windowEnded, true, "quota 专属证据窗口必须结束");
        const snapshot = evidence?.snapshot;
        const translated = evidence?.translatedIndexes;
        assert.ok(snapshot?.scope, "quota 证据必须保留完整触发窗口");
        assert.equal(translated?.responses.length, snapshot.responses.length);
        assert.equal(translated?.consoles.length, snapshot.consoles.length);
        const responses = snapshot.responses.map((entry) => {
          const bindings = translated.responses.filter((item) => item.requestId === entry.requestId);
          assert.equal(bindings.length, 1, `quota 响应 ${entry.requestId} 必须只有一个错误索引绑定`);
          return { ...entry, resourceFailureIndex: bindings[0].resourceFailureIndex };
        });
        const consoles = snapshot.consoles.map((entry) => {
          const bindings = translated.consoles.filter((item) => item.order === entry.order);
          assert.equal(bindings.length, 1, `quota console order ${entry.order} 必须只有一个错误索引绑定`);
          return { ...entry, index: bindings[0].index };
        });
        const classified = classifyExpectedQuotaErrors({
          errors: state.errors,
          scope: snapshot.scope,
          responses,
          consoles,
        });
        assert.deepEqual(classified.rejected, [], "quota 预期错误必须全部得到唯一严格归因");
        assert.deepEqual(classified.scopedErrors.pageErrors, []);
        assert.deepEqual(classified.scopedErrors.requestFailed, []);
        assert.deepEqual(classified.scopedErrors.resourceFailures, []);
        assert.deepEqual(classified.scopedErrors.consoleErrors, []);
        assert.equal(classified.expectedErrors.resourceFailures.length, 1);
        assert.equal(classified.expectedErrors.resourceFailures[0].status, 409);
        assert.deepEqual(classified.expectedErrors.consoleErrors, [
          "Failed to load resource: the server responded with a status of 409 (Conflict)",
        ]);
        const exact = classified.matches.find((entry) => entry.binding === "EXACT_RESPONSE_METADATA");
        const inferred = classified.matches.find((entry) => entry.binding === "INFERRED_UNIQUE");
        assert.ok(exact && inferred, "quota 原响应与 console 必须各有独立归因");
        assert.equal(inferred.requestId, exact.requestId);
        assert.equal(inferred.resourceFailureIndex, exact.resourceFailureIndex);
        const acceptedResponse = snapshot.responses.find((entry) => entry.requestId === exact.requestId);
        const acceptedUrl = new URL(acceptedResponse.url);
        assert.equal(acceptedResponse.method, "GET");
        assert.equal(acceptedResponse.bodyCode, "QUOTA_WINDOW_UNAVAILABLE");
        assert.equal(acceptedUrl.pathname, "/api/usage");
        assert.equal(acceptedUrl.searchParams.get("preset"), "quota_5h");
        assert.equal(acceptedUrl.searchParams.get("bucket"), "quota_30m");
        assert.deepEqual(evidence.expectedErrors, classified.expectedErrors);
        assert.deepEqual(evidence.matches, classified.matches);
        assert.deepEqual(evidence.rejected, []);

        const contaminated = structuredClone(state.errors);
        contaminated.pageErrors.push("unexpected page error");
        contaminated.requestFailed.push({ url: "http://127.0.0.1/api/other", error: "net::ERR_FAILED" });
        contaminated.resourceFailures.push({
          url: "http://127.0.0.1/api/usage?preset=quota_week&bucket=quota_24h",
          status: 409,
        });
        contaminated.consoleErrors.push(
          "Failed to load resource: the server responded with a status of 409 (Conflict)",
        );
        const rejected = classifyExpectedQuotaErrors({
          errors: contaminated,
          scope: snapshot.scope,
          responses,
          consoles,
        });
        assert.deepEqual(rejected.scopedErrors.pageErrors, ["unexpected page error"]);
        assert.equal(rejected.scopedErrors.requestFailed.length, 1);
        assert.equal(rejected.scopedErrors.resourceFailures.length, 1);
        assert.equal(rejected.scopedErrors.consoleErrors.length, 1);
        assert.ok(rejected.rejected.some((entry) => entry.kind === "resourceFailures"));
        assert.ok(rejected.rejected.some((entry) => entry.kind === "consoleErrors"));

        assert.equal(state.trace.precondition.met, true);
        assert.ok(
          state.trace.steps.some(
            (step) => step.action === "click" && step.selector === "#presetButtons .quota-preset-toggle" && step.ok,
          ),
          "quota-toast 必须执行自己的预设切换动作",
        );
        assert.equal(state.trace.ready.ok, true);
        assert.equal(state.trace.ready.kind, "visible");
        assert.equal(state.trace.ready.selector, ".quota-preset-status");
        continue;
      }
      assert.deepEqual(state.errors.pageErrors, [], `${unitId} 不得有页面错误`);
      assert.deepEqual(state.errors.consoleErrors, [], `${unitId} 不得有 console 错误`);
      assert.deepEqual(state.errors.requestFailed, [], `${unitId} 必要资源不得加载失败`);
      assert.deepEqual(state.errors.resourceFailures, [], `${unitId} 不得有 ≥400 响应`);
    }

    // keyboard-focus：必须走真实 Tab（脚本 focus() 不触发 :focus-visible）
    const focus = await unitState(result.outDir, "light", "keyboard-focus");
    const focusStep = focus.trace.steps.find((step) => step.action === "focus");
    assert.equal(focusStep.focusStrategy, "tab", "键盘焦点必须用 Tab 真实触发");
    assert.ok(focusStep.focusPresses > 0, "Tab 次数必须记录在轨迹里");
    assert.equal(focus.trace.ready.ok, true);
    // focus.outline 在 M0 目录里是句人话（机测恒 unmeasured），卡面要"局部截图"：
    // 被命中的 #addImportButton 在首屏之外，必须有滚动后的元素截图供人工核验
    assert.ok(focus.screenshots.target1, "焦点环必须有原尺寸元素截图（target1）");
    assert.ok(focus.screenshots.target1.clip?.width > 0, "元素截图必须带 clip 元数据");

    // spotlight-on：聚光必须真的激活（就绪条件是 data-spotlight-active 存在）
    const spotlight = await unitState(result.outDir, "light", "spotlight-on");
    assert.equal(spotlight.trace.ready.ok, true, "聚光层必须激活");
    assert.ok(spotlight.screenshots.region, "聚光状态必须有 topbar 区域截图");
    // 点亮必须是真操作：入口就绪不得命中（聚光是指针派生态，靠上个单元遗留的
    // 鼠标位置命中入口就绪，会让"开/关"两条路径一次都没跑）
    assert.equal(spotlight.trace.entryReady, false, "spotlight-on 入口不得命中就绪（先熄灭再点亮）");
    assert.ok(
      spotlight.trace.steps.some((step) => step.action === "setSpotlight" && step.spotlight?.value === "on"),
      "必须有真实的点亮步骤（setSpotlight on）",
    );
    assert.ok(
      spotlight.trace.restore.some((step) => step.action === "setSpotlight" && step.spotlight?.value === "off"),
      "收尾必须真实熄灭（setSpotlight off）",
    );

    // 日历选区：清除按钮禁用时跳过并留痕、重开弹层后才等到 range-end
    const range = await unitState(result.outDir, "light", "calendar-range");
    const clearStep = range.trace.steps.find((step) => step.action === "clickIfEnabled");
    assert.ok(clearStep, "清除步骤必须改写为点击-if-enabled");
    assert.ok(String(clearStep.clickIfEnabled).includes("skipped"), "无选区可清时必须跳过并说明原因");
    assert.ok(
      range.trace.steps.some((step) => step.action === "click" && step.selector === "#dateRangeButton"),
      "选完终点后必须重开弹层（真实用户回看选区）",
    );
    assert.equal(range.trace.ready.ok, true, "重开后 range-end 必须就绪");

    // autorefresh-error：故障注入的伴生错误单独记账，恢复必须走确定性动作并清掉错误
    const autoError = await unitState(result.outDir, "light", "autorefresh-error");
    assert.equal(autoError.status, "captured", "注入的失败不得算作捕获阻断");
    assert.ok(
      (autoError.trace.faultInducedErrors?.requestFailed ?? []).length >= 1,
      "被注入中止的请求必须留在 trace.faultInducedErrors 里供审计",
    );
    assert.equal(autoError.trace.recovery.errorCleared, true, "恢复后错误提示必须清除");
    assert.equal(autoError.trace.declarations.postMatches, true);

    // 运行级元数据：摘要覆盖 M3.4 必需集、组与未测项、双桌面视口
    const meta = JSON.parse(await readFile(path.join(result.outDir, "capture.json"), "utf8"));
    assert.equal(meta.kind, "skin-palette-capture-matrix");
    assert.deepEqual(meta.groups, ["S1", "S2", "S6"]);
    assert.ok(meta.untested.length > 0, "目标机器的显示缩放/浏览器 zoom 人工复核必须登记为未测");
    assert.deepEqual(
      meta.environment.viewports.map((viewport) => `${viewport.width}x${viewport.height}`),
      ["1920x1080", "2560x1440", "1280x720"],
    );
    for (const file of REQUIRED_SOURCE_FILES) {
      assert.ok(meta.sourceHashes[file], `运行证据摘要必须覆盖 M3.4 必需文件 ${file}`);
    }
    assert.equal(meta.fixtureHash, fixture.fixtureHash);

    // 进度文件：每个单元都有登记，失败/不可达事实同样落盘
    const progress = JSON.parse(await readFile(path.join(result.outDir, "progress.json"), "utf8"));
    assert.equal(progress.kind, "skin-palette-capture-progress");
    for (const unitId of expectedUnits) {
      assert.ok(progress.units[`light/${unitId}`], `${unitId} 必须登记进 progress`);
    }
    assert.equal(progress.units["light/quota-toast"].status, "captured");

    for (const name of watched) {
      assert.equal(sha256(await readFile(path.join("public", name))), before[name], `${name} 全程不得被改写`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

test("D8u18：合成非空角色缺口经真实 reader 与续跑报告保留", async () => {
  const candidate = makeCandidate();
  const sandboxDir = await mkdtemp(path.join(tmpdir(), "skin-palette-d8u18-gap-resume-"));
  const outDir = path.join(sandboxDir, "capture");
  const unit = matrixGroup("S5").units.find((entry) => entry.id === "dense-data");
  const gapRoleId = "table.comparison-cell";
  const gapReason = "D8u18 synthetic evidence: role intentionally marked unmeasured";
  const declaredGap = { roleId: gapRoleId, reason: gapReason };
  const expectedRoleIds = STATE_CATALOG.find((state) => state.id === unit.stateId).expectedRoleIds;
  assert.ok(expectedRoleIds.includes(gapRoleId), "合成缺口必须属于注册状态的必要角色");

  try {
    // Synthetic-only fixture in a fresh temp directory; D8u17 evidence remains read-only.
    const synthetic = await writeMatrixCapture(sandboxDir, "capture", candidate, {
      groups: ["S5"],
      modes: ["light"],
      recordOverrides: {
        "light/dense-data": (records) =>
          records.map((record) =>
            record.roleId === gapRoleId
              ? {
                  ...record,
                  result: "unmeasured",
                  ratio: null,
                  evidence: JSON.stringify({ kind: "synthetic-d8u18", reason: gapReason }),
                  reason: gapReason,
                }
              : record,
          ),
      },
    });
    const unitDir = path.join(outDir, "light", "states", unit.id);
    const statePath = path.join(unitDir, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.trace.roleScopeGaps = [declaredGap];
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const captureSource = await readFile(new URL("../scripts/skin-palette/capture.mjs", import.meta.url), "utf8");
    const hashStart = captureSource.indexOf("async function hashEvidenceTree(rootDir) {");
    const hashEnd = captureSource.indexOf("\n}\n\n/**", hashStart) + 2;
    assert.ok(hashStart >= 0 && hashEnd > hashStart, "must use capture.mjs's evidence-tree hash");
    const makeHashEvidenceTree = vm.runInThisContext(
      `(path, realpath, readdir, readFile, sha256Of, sha256Canonical) => (${captureSource.slice(hashStart, hashEnd)})`,
    );
    const hashEvidenceTree = makeHashEvidenceTree(
      path,
      realpath,
      readdir,
      readFile,
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
      sha256Canonical,
    );
    const evidenceHash = await hashEvidenceTree(unitDir);
    synthetic.progress.units[`light/${unit.id}`].evidenceHash = evidenceHash;

    const seedProbe = await createCaptureMatrixEntryProbe({ outDir, candidateSnapshot: candidate });
    const seeded = await seedProbe.run({ groups: ["S5"], modes: ["light"], measureBaseline: false });
    const savedProgress = structuredClone(synthetic.progress);
    savedProgress.digests = seeded.progress.digests;
    await writeFile(path.join(outDir, "progress.json"), `${JSON.stringify(savedProgress, null, 2)}\n`, "utf8");

    const accepted = await readCapturedUnitEvidence({
      unitDir,
      unit,
      mode: "light",
      skinId: candidate.skinId,
      expectedRoleIds,
      expectedEvidenceHash: evidenceHash,
    });
    assert.equal(accepted.roleScopeGaps.length, 1, "真实 reader 必须先读回非空 gap");
    assert.deepEqual(accepted.roleScopeGaps, [declaredGap]);
    assert.equal(
      accepted.checks.records.find((record) => record.roleId === gapRoleId)?.result,
      "unmeasured",
      "reader 输入必须含与 gap 同角色的 unmeasured 判据",
    );

    const modeProbe = await createCapturedMatrixResumeModeProbe();
    const readerUnitIds = [];
    const resumeProbe = await createCaptureMatrixEntryProbe({
      savedProgress,
      outDir,
      candidateSnapshot: candidate,
      readUnitEvidence: async (args) => {
        readerUnitIds.push(args.unit.id);
        return readCapturedUnitEvidence(args);
      },
      modeRunner: (args) => modeProbe.run(args),
    });
    const resumed = await resumeProbe.run({ groups: ["S5"], modes: ["light"], measureBaseline: false, resume: true });
    const expectedReportGap = {
      unitId: unit.id,
      stateId: unit.stateId,
      reason: `角色 ${gapRoleId} 未由 M3.2 实测：${gapReason}`,
    };
    assert.ok(readerUnitIds.includes(unit.id), "resume preflight 必须调用真实 evidence reader");
    assert.equal(resumed.modes.light.gaps.length, 1, "续跑结果必须保留非空 gap");
    assert.deepEqual(JSON.parse(JSON.stringify(resumed.modes.light.gaps)), [expectedReportGap]);
    assert.deepEqual(JSON.parse(JSON.stringify(resumed.capture.modes.light.gaps)), [expectedReportGap]);
    const captureWrite = resumeProbe.calls.writes.find((entry) => String(entry.file).endsWith("capture.json"));
    assert.ok(captureWrite, "续跑必须写出 capture.json");
    assert.deepEqual(JSON.parse(JSON.stringify(captureWrite.data.modes.light.gaps)), [expectedReportGap]);
    assert.equal(resumeProbe.calls.browserLaunches, 1, "only the injected fake Browser runtime may launch");
    assert.equal(modeProbe.calls.contexts, 1);
    assert.equal(modeProbe.calls.baselines, 1);
    assert.equal(resumeProbe.calls.modeCalls.length, 1);
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
});

test("M4.3 S3/S5 真实交互：完成目录选择、来源筛选和按模型/花销切图", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  let evidenceOutputDir = null;
  if (process.env.SKIN_PALETTE_D8U26_EVIDENCE_DIR) {
    assert.equal(
      path.basename(runtime.executablePath).toLowerCase(),
      "msedge.exe",
      "D8u26 实测证据必须来自 Microsoft Edge，而非替代浏览器",
    );
    const requestedEvidenceDir = path.resolve(process.env.SKIN_PALETTE_D8U26_EVIDENCE_DIR);
    const integrationRoot = await realpath(
      fileURLToPath(
        new URL(
          "../docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m52-c-d8u26-table-label-coverage",
          import.meta.url,
        ),
      ),
    );
    await mkdir(requestedEvidenceDir, { recursive: true });
    evidenceOutputDir = await realpath(requestedEvidenceDir);
    const relativeEvidencePath = path.relative(integrationRoot, evidenceOutputDir);
    assert.ok(
      relativeEvidencePath &&
        relativeEvidencePath !== ".." &&
        !relativeEvidencePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeEvidencePath),
      "D8u26 实测证据只能写入本卡 integration 根目录内",
    );
    assert.deepEqual(await readdir(evidenceOutputDir), [], "D8u26 本次证据目录必须是新的空目录");
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-matrix-s3-s5-"));
  const outDir = path.join(sandbox, "docs", "validation", "m43", "s3-s5");
  let chromiumLaunchCount = 0;
  const trackedBrowserRuntime = {
    ...runtime,
    chromium: {
      launch: (...args) => {
        chromiumLaunchCount += 1;
        return runtime.chromium.launch(...args);
      },
    },
  };
  const captureOptions = {
    candidate: previewCandidate(),
    fixture,
    outDir,
    rootDir: sandbox,
    browserRuntime: trackedBrowserRuntime,
    modes: ["light"],
    measureBaseline: false,
    groups: ["S3", "S5"],
    stateTimeoutMs: 15000,
  };
  try {
    const result = await captureStateMatrix(captureOptions);
    assert.equal(
      result.modes.light.status,
      "captured",
      `S3/S5 操作必须完整执行：${JSON.stringify(result.modes.light.states)} ${JSON.stringify(result.modes.light.blockers)}`,
    );
    assert.equal(chromiumLaunchCount, 1, "首次真实捕获必须只启动一次 Edge");

    const importState = await unitState(outDir, "light", "dialog-import-open");
    assert.equal(importState.status, "captured");
    assert.equal(importState.trace.importControls.directory.selected, true);
    assert.equal(importState.trace.importControls.directory.actualPath, fixture.pickedPath);
    assert.equal(importState.trace.importControls.sourceFilter.excluded, true);
    assert.equal(importState.trace.importControls.sourceFilter.restored, true);
    assert.ok(importState.trace.interactionAssertions.every((assertion) => assertion.ok));
    assert.ok(
      importState.trace.steps.some((step) => step.selector === "#pickImportDirectoryButton" && step.ok),
      "必须留下真实目录选择按钮操作",
    );
    assert.ok(
      importState.trace.steps.some((step) => step.action === "uncheck" && step.ok),
      "必须留下关闭来源筛选的真实操作",
    );
    assert.ok(importState.trace.restore.some((step) => step.action === "check" && step.ok));
    for (const name of ["source-directory-selected.png", "source-filtered.png"]) {
      assert.ok(existsSync(path.join(outDir, "light", "states", "dialog-import-open", name)), `${name} 必须保存`);
    }

    const dense = await unitState(outDir, "light", "dense-data");
    assert.equal(dense.status, "captured");
    const expectedDenseRoles = STATE_CATALOG.find((state) => state.id === "dense-data").expectedRoleIds;
    assert.deepEqual(
      dense.trace.timelineModes.checks.map((entry) => entry.mode),
      ["model", "cost"],
      "必须在单次密集数据状态中真实切换两个视图",
    );
    const timelineChecks = {};
    for (const [mode, label, file] of [
      ["model", "按模型", "timeline-model.png"],
      ["cost", "按花销", "timeline-cost.png"],
    ]) {
      const check = dense.trace.timelineModes.checks.find((entry) => entry.mode === mode);
      assert.equal(check.actualLabel, label);
      assert.equal(check.selected, true);
      assert.ok(existsSync(path.join(outDir, "light", "states", "dense-data", file)), `${file} 必须保存`);
      assert.ok(
        dense.trace.steps.some(
          (step) => step.action === "click" && step.selector.includes(`data-timeline-mode="${mode}"`),
        ),
        `${label} 必须来自真实按钮点击`,
      );
      assert.equal(check.measurement.status, "captured", `${label} 切换后必须完成角色测量`);
      const viewChecks = JSON.parse(
        await readFile(path.join(outDir, "light", "states", "dense-data", `checks.timeline-${mode}.json`), "utf8"),
      );
      timelineChecks[mode] = viewChecks;
      assert.equal(viewChecks.status, "captured");
      assert.equal(viewChecks.viewMode, mode);
      assert.ok(viewChecks.captureIndex.length > 0, `${label} 视图测量截图必须留存`);
      assert.deepEqual(
        new Set(viewChecks.records.map((record) => record.roleId)),
        new Set(expectedDenseRoles),
        `${label} 视图必须为 dense-data 的每个预期角色保存判据`,
      );
      assert.equal(
        check.measurementEvidence.checks,
        `checks.timeline-${mode}.json`,
        `${label} 测量证据必须从 state.json trace 可追溯`,
      );
    }
    const channelChecks = JSON.parse(
      await readFile(path.join(outDir, "light", "states", "dense-data", "checks.json"), "utf8"),
    );
    const viewChecksByMode = { channel: channelChecks, ...timelineChecks };
    const viewCheckPaths = {
      channel: path.join(outDir, "light", "states", "dense-data", "checks.json"),
      model: path.join(outDir, "light", "states", "dense-data", "checks.timeline-model.json"),
      cost: path.join(outDir, "light", "states", "dense-data", "checks.timeline-cost.json"),
    };
    const comparisonCellViews = {};
    const preserveEvidenceFile = async (sourcePath, fileName) => {
      if (!evidenceOutputDir) return null;
      const bytes = await readFile(sourcePath);
      await writeFile(path.join(evidenceOutputDir, fileName), bytes, { flag: "wx" });
      return {
        file: fileName,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    };
    const legendRole = ROLE_CATALOG.find((role) => role.id === "chart.legend-swatch");
    assert.ok(legendRole?.required, "dense-data 图例色块仍是必要角色");
    assert.ok(expectedDenseRoles.includes(legendRole.id), "dense-data 必须登记图例色块角色");
    const comparisonCellRole = ROLE_CATALOG.find((role) => role.id === "table.comparison-cell");
    assert.equal(comparisonCellRole.required, true);
    for (const [viewMode, checks] of Object.entries(viewChecksByMode)) {
      const legendRecords = checks.records.filter((record) => record.roleId === legendRole.id);
      assert.equal(legendRecords.length, 1, `${viewMode} 必须有且仅有一条真实图例色块测量记录`);
      const [legend] = legendRecords;
      assert.equal(legend.result, "pass", `${viewMode} 图例色块必须精确通过`);
      assert.equal(legend.method, "browser-painted-surface", `${viewMode} 图例色块必须来自真实浏览器绘制测量`);
      assert.equal(legend.threshold, legendRole.threshold, `${viewMode} 阈值必须与角色目录一致`);
      assert.ok(Number.isFinite(legend.ratio), `${viewMode} ratio 必须是有限数值`);
      assert.ok(legend.ratio >= legendRole.threshold, `${viewMode} ratio 必须达到角色目录阈值`);

      const cellRecords = checks.records.filter((record) => record.roleId === comparisonCellRole.id);
      assert.equal(cellRecords.length, 1, `${viewMode} 必须有一条比较表主标签/单元格测量记录`);
      const [cell] = cellRecords;
      assert.equal(cell.stateId, "dense-data");
      assert.equal(cell.threshold, comparisonCellRole.threshold);
      const cellEvidence = JSON.parse(cell.evidence);
      const nodeFacts = new Map();
      const factFor = (index, identity) => {
        const key = Number.isInteger(identity?.identityId)
          ? `identity:${identity.identityId}`
          : `node:${index}:${identity?.tag ?? "unknown"}:${identity?.className ?? ""}`;
        if (!nodeFacts.has(key)) {
          nodeFacts.set(key, {
            index,
            identity,
            samples: [],
            gaps: [],
          });
        }
        return nodeFacts.get(key);
      };
      for (const node of cellEvidence.nodes ?? []) {
        const fact = factFor(node.index, node.identity);
        fact.samples.push(
          ...(node.bands ?? [])
            .filter((band) => band.worst)
            .map((band) => ({ capture: band.capture, worst: band.worst })),
        );
      }
      for (const [kind, entries] of [
        ["unmeasured", cellEvidence.unmeasuredNodes],
        ["not-rendered", cellEvidence.notRenderedNodes],
        ["not-applicable", cellEvidence.notApplicableNodes],
      ]) {
        for (const entry of entries ?? []) {
          factFor(entry.index, entry.identity).gaps.push({ kind, reason: entry.reason });
        }
      }
      const actualNodes = [...nodeFacts.values()];
      const labels = actualNodes.filter(
        ({ identity }) =>
          identity?.tag === "span" &&
          String(identity.className ?? "")
            .split(/\s+/)
            .includes("comparison-row-label"),
      );
      const cells = actualNodes.filter(({ identity }) => identity?.tag === "td");
      assert.ok(labels.length > 0, `${viewMode} 实测身份中必须出现 .comparison-row-label span`);
      assert.ok(cells.length > 0, `${viewMode} 实测身份中必须保留原 td`);
      for (const [kind, facts] of [
        ["comparison-row-label", labels],
        ["td", cells],
      ]) {
        assert.ok(
          facts.every((fact) => fact.samples.length > 0 || fact.gaps.length > 0),
          `${viewMode} 的 ${kind} 节点身份必须进入实际测量或显式缺测事实`,
        );
      }
      const measuredSampleCount = actualNodes.reduce((count, fact) => count + fact.samples.length, 0);
      assert.equal(measuredSampleCount, cellEvidence.measuredCount);
      const captureIds = [
        ...new Set(labels.flatMap((fact) => fact.samples.map((sample) => sample.capture)).filter(Number.isInteger)),
      ];
      const representativeCell = cells.find((fact) => fact.samples.length > 0);
      if (representativeCell) {
        captureIds.push(...representativeCell.samples.map((sample) => sample.capture).filter(Number.isInteger));
      }
      comparisonCellViews[viewMode] = {
        status: cell.result,
        ratio: cell.ratio,
        threshold: cell.threshold,
        method: cell.method,
        reason: cell.reason,
        sourceChecksSha256: createHash("sha256")
          .update(await readFile(viewCheckPaths[viewMode]))
          .digest("hex"),
        captureIndex: checks.captureIndex.length,
        nodeCounts: {
          selectedEvidenceIdentities: actualNodes.length,
          comparisonRowLabels: labels.length,
          measuredComparisonRowLabels: labels.filter((fact) => fact.samples.length > 0).length,
          gapComparisonRowLabels: labels.filter((fact) => fact.gaps.length > 0).length,
          tableCells: cells.length,
          measuredTableCells: cells.filter((fact) => fact.samples.length > 0).length,
          gapTableCells: cells.filter((fact) => fact.gaps.length > 0).length,
          measuredSamples: measuredSampleCount,
          unmeasuredSamples: cellEvidence.unmeasuredCount,
          notRenderedNodes: cellEvidence.notRenderedCount,
          notApplicableNodes: cellEvidence.notApplicableCount,
        },
        nodes: actualNodes.map((fact) => ({
          index: fact.index,
          identity: fact.identity,
          samples: fact.samples,
          gaps: fact.gaps,
        })),
        requiredCaptureIndices: [...new Set(captureIds)],
        captureIndexEntries: checks.captureIndex.filter(
          (entry) => entry.roleId === comparisonCellRole.id && captureIds.includes(entry.index),
        ),
      };
    }
    assert.equal(dense.trace.timelineModes.restoredMode, dense.trace.timelineModes.initialMode);

    const originalCapture = await readFile(path.join(outDir, "capture.json"));
    const originalProgress = await readFile(path.join(outDir, "progress.json"));
    const originalMeta = JSON.parse(originalCapture.toString("utf8"));
    const originalGaps = originalMeta.modes.light.gaps;
    const stateShotPath = path.join(outDir, "light", "states", "dense-data", "state.png");
    const stateShot = await readFile(stateShotPath);
    await rm(stateShotPath);
    await assert.rejects(
      () => captureStateMatrix({ ...captureOptions, resume: true }),
      /续跑单元 dense-data 的成功证据不完整：证据文件摘要与 progress\.json 不一致/,
      "progress.json 虽标 captured，但截图缺失时必须拒绝续跑",
    );
    assert.deepEqual(
      await readFile(path.join(outDir, "capture.json")),
      originalCapture,
      "证据预检失败不能覆盖原 capture.json",
    );
    assert.deepEqual(
      await readFile(path.join(outDir, "progress.json")),
      originalProgress,
      "证据预检失败不能覆盖原 progress.json",
    );
    assert.equal(chromiumLaunchCount, 1, "缺损证据预检必须在 Edge 启动前拒绝续跑");
    await writeFile(stateShotPath, stateShot);

    const resumed = await captureStateMatrix({ ...captureOptions, resume: true });
    assert.equal(chromiumLaunchCount, 2, "合法续跑必须只额外启动一次 Edge");
    assert.equal(resumed.modes.light.states["dense-data"].resumed, true);
    assert.deepEqual(resumed.modes.light.gaps, originalGaps, "续跑跳过成功单元时必须恢复原角色缺测记录");
    const resumedMeta = JSON.parse(await readFile(path.join(outDir, "capture.json"), "utf8"));
    assert.deepEqual(resumedMeta.modes.light.gaps, originalGaps, "重写的总报告必须保留原有角色缺测");

    if (evidenceOutputDir) {
      const preservedFiles = [];
      for (const [viewMode, screenshot] of [
        ["channel", "state.png"],
        ["model", "timeline-model.png"],
        ["cost", "timeline-cost.png"],
      ]) {
        const stateDir = path.join(outDir, "light", "states", "dense-data");
        const view = comparisonCellViews[viewMode];
        const nodeCaptureIds = view.requiredCaptureIndices;
        const cellCaptures = view.captureIndexEntries.filter((entry) => nodeCaptureIds.includes(entry.index));
        const copiedCaptures = [];
        for (const entry of cellCaptures) {
          const captureBytes = await readFile(path.join(stateDir, entry.file));
          const file = `captures/${viewMode}-comparison-cell-${String(entry.index).padStart(3, "0")}.png`;
          await mkdir(path.dirname(path.join(evidenceOutputDir, file)), { recursive: true });
          await writeFile(path.join(evidenceOutputDir, file), captureBytes, { flag: "wx" });
          copiedCaptures.push({
            index: entry.index,
            file,
            bytes: captureBytes.length,
            sha256: createHash("sha256").update(captureBytes).digest("hex"),
          });
        }
        view.captureFiles = copiedCaptures;
        view.captureIndexEntries = copiedCaptures.map(({ index, file }) => ({
          index,
          roleId: comparisonCellRole.id,
          file,
        }));
        preservedFiles.push(...copiedCaptures);
        preservedFiles.push(await preserveEvidenceFile(path.join(stateDir, screenshot), `${viewMode}-${screenshot}`));
      }
      const importEvidenceDir = path.join(outDir, "light", "states", "dialog-import-open");
      const importScreenshots = [];
      for (const name of ["source-directory-selected.png", "source-filtered.png"]) {
        importScreenshots.push(await preserveEvidenceFile(path.join(importEvidenceDir, name), `import-${name}`));
      }
      await writeFile(
        path.join(evidenceOutputDir, "comparison-cell-three-view-evidence.json"),
        `${JSON.stringify({ schemaVersion: 1, roleId: comparisonCellRole.id, views: comparisonCellViews }, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await writeFile(
        path.join(evidenceOutputDir, "s3-s5-execution-evidence.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            browser: {
              runtime: "Playwright Chromium",
              executable: path.basename(runtime.executablePath),
              launches: chromiumLaunchCount,
            },
            captureStatus: result.modes.light.status,
            interactions: {
              importControls: importState.trace.importControls,
              importAssertions: importState.trace.interactionAssertions,
              importSteps: importState.trace.steps.filter((step) =>
                ["#pickImportDirectoryButton", "#sourceFilter"].some((selector) => step.selector?.includes(selector)),
              ),
              timelineModes: dense.trace.timelineModes,
              timelineClicks: dense.trace.steps.filter((step) => step.selector?.includes("data-timeline-mode")),
              legend: Object.fromEntries(
                Object.entries(viewChecksByMode).map(([viewMode, checks]) => {
                  const [record] = checks.records.filter((entry) => entry.roleId === legendRole.id);
                  return [viewMode, { result: record.result, ratio: record.ratio, threshold: record.threshold }];
                }),
              ),
            },
            screenshotPreflight: {
              missingStatePngRejected: true,
              captureJsonUnchanged: true,
              progressJsonUnchanged: true,
              edgeLaunchCountAfterRejectedResume: 1,
            },
            legalResume: {
              resumed: resumed.modes.light.states["dense-data"].resumed,
              gapsPreserved: resumedMeta.modes.light.gaps,
              edgeLaunchCountAfterResume: chromiumLaunchCount,
            },
            preservedFiles,
            importScreenshots,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", flag: "wx" },
      );
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

test("M4.3 catalog 恢复失败会阻断当前尝试并使用新上下文有限重试", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-matrix-restore-failure-"));
  const outDir = path.join(sandbox, "docs", "validation", "m43", "restore-failure");
  try {
    const result = await captureStateMatrix({
      candidate: previewCandidate(),
      fixture,
      outDir,
      rootDir: sandbox,
      browserRuntime: runtimeFailingFirstImportRestore(runtime),
      modes: ["light"],
      measureBaseline: false,
      groups: ["S3"],
      stateTimeoutMs: 15000,
    });
    assert.equal(
      result.modes.light.status,
      "captured",
      `恢复失败后的新上下文重试应成功：${JSON.stringify(result.modes.light.states)}`,
    );
    const firstAttempt = JSON.parse(
      await readFile(path.join(outDir, "light", "states", "dialog-import-open", "attempt-1", "state.json"), "utf8"),
    );
    assert.equal(firstAttempt.status, "failed");
    assert.ok(firstAttempt.blockers.some((blocker) => blocker.includes("恢复步骤失败")));
    assert.ok(
      firstAttempt.trace.restore.some((step) => step.selector === "#cancelImportButton" && step.ok === false),
      "catalog restore() 的失败结果必须进入轨迹",
    );
    const success = await unitState(outDir, "light", "dialog-import-open");
    assert.equal(success.status, "captured");
    assert.equal(success.attempt, 2);
    assert.equal(success.trace.declarations.postMatches, true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

test("M4.3 跨续跑重试预算：耗尽后拒绝第三次执行并保留旧证据", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-matrix-c2-"));
  const outDir = path.join(sandbox, "docs", "validation", "m43", "resume");
  const base = {
    candidate: previewCandidate(),
    fixture,
    outDir,
    rootDir: sandbox,
    modes: ["light"],
    measureBaseline: false,
    groups: ["S7"],
  };
  try {
    // 第一轮：单元 timeout 1ms 必然失败（基准仍用 15s，保证是单元失败而非服务级故障）
    const failing = await captureStateMatrix({ ...base, stateTimeoutMs: 1, baselineTimeoutMs: 15000 });
    assert.equal(failing.modes.light.status, "failed", "全部失败时模式状态必须是 failed");
    const unitIds = ["theme-roundtrip", "reload-preferences", "skin-roundtrip"];
    for (const unitId of unitIds) {
      const entry = failing.modes.light.states[unitId];
      assert.equal(entry.status, "failed", `${unitId} 第一轮必须失败`);
      assert.equal(entry.attempts, 2, "失败一次后只允许在新上下文复跑一次");
      assert.ok(entry.blockers.length > 0, "失败原因必须记账");
      const attempt1 = JSON.parse(
        await readFile(path.join(outDir, "light", "states", unitId, "attempt-1", "state.json"), "utf8"),
      );
      const attempt2 = JSON.parse(
        await readFile(path.join(outDir, "light", "states", unitId, "attempt-2", "state.json"), "utf8"),
      );
      assert.equal(attempt1.status, "failed", "第一次尝试的证据必须单独存放");
      assert.equal(attempt2.status, "failed", "第二次尝试的证据必须单独存放");
      assert.notEqual(attempt1.attempt, attempt2.attempt, "两次尝试必须可区分");
      assert.equal(
        existsSync(path.join(outDir, "light", "states", unitId, "state.json")),
        false,
        "失败的单元不得在单元目录留下“成功”证据",
      );
    }

    // 摘要不一致（fixture 换了）必须拒绝续跑，由调用方创建新目录
    await assert.rejects(
      () => captureStateMatrix({ ...base, resume: true, fixture: { ...fixture, fixtureHash: "0".repeat(64) } }),
      /摘要绑定不一致/,
      "摘要不一致不得静默续跑",
    );

    // 重试预算是同一证据目录的总预算：正常 timeout 续跑也不能把它重置。
    const resumed = await captureStateMatrix({ ...base, resume: true, stateTimeoutMs: 15000 });
    assert.equal(resumed.modes.light.status, "failed", "预算耗尽的失败单元必须保持 failed");
    for (const unitId of unitIds) {
      assert.equal(resumed.modes.light.states[unitId].status, "failed");
      assert.equal(resumed.modes.light.states[unitId].retryBudgetExhausted, true);
      assert.equal(
        existsSync(path.join(outDir, "light", "states", unitId, "state.json")),
        false,
        `${unitId} 不得伪造成功证据`,
      );
    }
    // 历史尝试保留：attempt-1/2 原文件与 progress.attempts 不得被覆盖或重置。
    const progress = JSON.parse(await readFile(path.join(outDir, "progress.json"), "utf8"));
    const history = progress.attempts.filter((entry) => entry.status === "failed");
    assert.equal(history.length, 6, "第一轮的 3 个失败单元 × 2 次尝试必须全部保留");
    assert.equal(progress.attempts.length, 6, "预算耗尽续跑不得执行或登记新尝试");
    for (const unitId of unitIds) {
      assert.ok(
        existsSync(path.join(outDir, "light", "states", unitId, "attempt-1", "state.json")),
        "历史尝试证据不得被删除",
      );
      assert.ok(
        existsSync(path.join(outDir, "light", "states", unitId, "attempt-2", "state.json")),
        "历史尝试证据不得被删除",
      );
      assert.equal(progress.units[`light/${unitId}`].status, "failed");
      assert.equal(progress.units[`light/${unitId}`].retryBudgetExhausted, true);
    }
    const meta = JSON.parse(await readFile(path.join(outDir, "capture.json"), "utf8"));
    assert.equal(meta.modes.light.status, "failed");
    assert.equal(meta.baselineTimeoutMs, 15000);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

test("M4.3 服务级恢复失败会停止当前组，后续单元保持 incomplete，之后可按预算续跑", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-matrix-c2-service-break-"));
  const outDir = path.join(sandbox, "docs", "validation", "m43", "service-break");
  const base = {
    candidate: previewCandidate(),
    fixture,
    outDir,
    rootDir: sandbox,
    modes: ["light"],
    measureBaseline: false,
    groups: ["S3"],
  };
  try {
    const interrupted = await captureStateMatrix({
      ...base,
      browserRuntime: runtimeFailingSecondContextCreation(runtime),
      stateTimeoutMs: 1,
      baselineTimeoutMs: 15000,
    });
    assert.equal(interrupted.modes.light.status, "failed");
    assert.equal(interrupted.modes.light.states["dialog-import-open"].status, "failed");
    assert.equal(interrupted.modes.light.states["dialog-import-open"].attempts, 1);
    assert.equal(interrupted.modes.light.states["dialog-import-error"].status, "incomplete");
    assert.equal(interrupted.progress.units["light/dialog-import-error"].status, "incomplete");
    assert.ok(
      existsSync(path.join(outDir, "light", "states", "dialog-import-open", "attempt-1", "state.json")),
      "第一次失败证据必须写入 attempt-1",
    );
    assert.equal(
      existsSync(path.join(outDir, "light", "states", "dialog-import-error", "attempt-1", "state.json")),
      false,
      "服务级故障后未执行的单元不得伪装成失败尝试",
    );

    const resumed = await captureStateMatrix({ ...base, resume: true, stateTimeoutMs: 15000 });
    assert.equal(
      resumed.modes.light.status,
      "captured",
      `正常续跑应使用第一次失败后的剩余预算：${JSON.stringify(resumed.modes.light.states)}`,
    );
    for (const unitId of ["dialog-import-open", "dialog-import-error"]) {
      assert.equal(resumed.modes.light.states[unitId].status, "captured");
      const success = JSON.parse(await readFile(path.join(outDir, "light", "states", unitId, "state.json"), "utf8"));
      assert.equal(success.status, "captured");
      assert.equal(success.trace.declarations.postMatches, true);
    }
    const history = JSON.parse(
      await readFile(path.join(outDir, "light", "states", "dialog-import-open", "attempt-1", "state.json"), "utf8"),
    );
    assert.equal(history.status, "failed", "续跑成功不得覆盖首轮失败证据");
    assert.equal(history.attempt, 1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

test("M4.3 正式色源模式：S0 基准（含角色测量）与 S7 规程一并捕获", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造真机捕获");
    return;
  }
  const fixture = await createPaletteFixture();
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-matrix-c3-"));
  const outDir = path.join(sandbox, "docs", "validation", "m43", "production");
  try {
    const result = await captureStateMatrix({
      candidate: null,
      skinId: "chatgpt",
      fixture,
      outDir,
      rootDir: sandbox,
      modes: ["light"],
      measureBaseline: true,
      groups: ["S0", "S7"],
    });
    const mode = result.modes.light;
    assert.equal(
      mode.status,
      "captured",
      `正式模式必须完整捕获：${JSON.stringify(mode.blockers)}${JSON.stringify(mode.states)}`,
    );
    assert.equal(mode.baseline.status, "captured");
    assert.equal(progressUnitStatus(result, "light", "baseline"), "captured");

    // S0 基准：M4.2 的首屏/运行时/测量证据全部落在模式根目录
    const first = JSON.parse(await readFile(path.join(result.outDir, "light", "first-screen.json"), "utf8"));
    assert.equal(first.matches, true, "正式模式页面颜色必须与生产派生一致（对照基线可信）");
    assert.ok(first.unrenderedMetrics > 0, "首屏必须拍到模块扣住状态");
    assert.equal(Object.keys(first.actual).length, 20);
    const checks = JSON.parse(await readFile(path.join(result.outDir, "light", "checks.json"), "utf8"));
    assert.equal(checks.stateId, "dashboard-default");
    assert.ok(checks.records.length > 0, "基准角色测量不得为空");
    assert.ok(checks.captureIndex.length > 0, "基准测量截图索引不得为空");
    // 卡面 S0 要求"聚光关闭"：聚光是指针派生态，catalog 触发（点『全部』）会把指针
    // 留在凸起的预设按钮上——探针实测 data-spotlight-active 就挂在 button.active 上，
    // 基准取证前必须把指针归位到凹陷面并留痕
    const colors = JSON.parse(await readFile(path.join(result.outDir, "light", "colors.json"), "utf8"));
    assert.equal(colors.spotlight?.off, true, "基准取证前聚光必须关闭（S0：聚光关闭）");
    assert.ok(colors.spotlight?.ms >= 0, "聚光关闭耗时必须记账");

    const modeDir = path.join(result.outDir, "light");
    const progressPath = path.join(result.outDir, "progress.json");
    const capturePath = path.join(result.outDir, "capture.json");
    const baselineProgress = JSON.parse(await readFile(progressPath, "utf8")).units["light/baseline"];
    const baselineEvidence = baselineProgress.baselineEvidence;
    assert.equal(baselineEvidence.schemaVersion, 1);
    assert.equal(baselineEvidence.measureRoles, true);
    assert.equal(baselineEvidence.sha256, sha256Canonical(baselineEvidence.files));
    assert.ok(baselineEvidence.files.some((entry) => entry.file === "baseline.png"));
    assert.ok(baselineEvidence.files.some((entry) => entry.file === "checks.json"));
    assert.ok(baselineEvidence.files.some((entry) => entry.file.startsWith("captures/")));
    assert.ok(
      baselineEvidence.files.every((entry) => !entry.file.startsWith("states/")),
      "S0 固定附件摘要不得吸收后续状态目录",
    );
    const originalProgress = await readFile(progressPath);
    const originalCapture = await readFile(capturePath);
    const resumeOptions = {
      candidate: null,
      skinId: "chatgpt",
      fixture,
      outDir,
      rootDir: sandbox,
      modes: ["light"],
      measureBaseline: true,
      groups: ["S0", "S7"],
      resume: true,
    };

    const baselinePngPath = path.join(modeDir, "baseline.png");
    const baselinePng = await readFile(baselinePngPath);
    await rm(baselinePngPath);
    await assert.rejects(
      () => captureStateMatrix(resumeOptions),
      /S0 基准附件证据不完整.*baseline\.png/,
      "缺少基准整页截图时必须在续跑写盘前拒绝",
    );
    assert.deepEqual(await readFile(progressPath), originalProgress, "缺失基准附件不得改写 progress.json");
    assert.deepEqual(await readFile(capturePath), originalCapture, "缺失基准附件不得改写 capture.json");
    await writeFile(baselinePngPath, baselinePng);

    const layoutPath = path.join(modeDir, "layout.json");
    const originalLayout = await readFile(layoutPath);
    const replacementLayout = JSON.parse(originalLayout.toString("utf8"));
    replacementLayout.replacementProbe = "same-path-different-content";
    await writeFile(layoutPath, `${JSON.stringify(replacementLayout, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => captureStateMatrix(resumeOptions),
      /S0 基准附件证据不完整.*SHA-256 已变化/,
      "被替换但仍可解析的基准布局必须在续跑写盘前拒绝",
    );
    assert.deepEqual(await readFile(progressPath), originalProgress, "被替换基准附件不得改写 progress.json");
    assert.deepEqual(await readFile(capturePath), originalCapture, "被替换基准附件不得改写 capture.json");
    await writeFile(layoutPath, originalLayout);

    const resumed = await captureStateMatrix(resumeOptions);
    assert.equal(resumed.modes.light.status, "captured", "恢复原附件后完整基准应允许续跑");

    // 矩阵的 S0 基准必须与 M4.2 入口产出同一套判据（同一测量函数、同一 fixtures）
    const direct = await captureBaseline({
      candidate: null,
      skinId: "chatgpt",
      fixture,
      outDir: path.join(sandbox, "docs", "validation", "m43", "direct-baseline"),
      rootDir: sandbox,
      modes: ["light"],
      measureRoles: true,
    });
    assert.equal(
      direct.modes.light.status,
      "captured",
      `M4.2 入口必须同样捕获：${JSON.stringify(direct.modes.light.blockers)}`,
    );
    const directChecks = JSON.parse(await readFile(path.join(direct.outDir, "light", "checks.json"), "utf8"));
    const directColors = JSON.parse(await readFile(path.join(direct.outDir, "light", "colors.json"), "utf8"));
    assert.equal(directColors.spotlight?.off, true, "M4.2 direct 基准取证前聚光必须关闭");
    t.diagnostic(
      JSON.stringify({
        detailFillParity: [checks, directChecks].map(({ records }) => {
          const record = records.find(({ roleId }) => roleId === "chart.detail-fill");
          return record && { result: record.result, ratio: record.ratio, reason: record.reason, method: record.method };
        }),
      }),
    );
    const matrixVerdicts = new Map(checks.records.map((record) => [record.roleId, `${record.result}:${record.ratio}`]));
    const failCount = (records) => records.filter((record) => record.result === "fail").length;
    for (const record of directChecks.records) {
      assert.equal(
        matrixVerdicts.get(record.roleId),
        `${record.result}:${record.ratio}`,
        `角色 ${record.roleId} 的判据必须与 M4.2 入口逐字一致`,
      );
    }
    assert.equal(failCount(checks.records), failCount(directChecks.records), "fail 数量必须与 M4.2 入口一致");
    // fail/unmeasured 是角色级证据而非捕获阻断：正式色源 light 基准本就存在若干 fail
    // （M3.2 口径，M4.2 起如此），矩阵如实记录，绝不为“全绿”过滤角色或改判
    assert.ok(
      checks.records.every((record) => ["pass", "fail", "unmeasured", "not-applicable"].includes(record.result)),
      "角色结果必须是四种合法判据之一",
    );

    // S7 三个规程：各自的关键帧截图与 20 项声明复读
    const theme = await unitState(result.outDir, "light", "theme-roundtrip");
    assert.equal(theme.status, "captured");
    assert.equal(theme.trace.verification.atOtherTheme.declarationsMatch, true, "对侧主题下 20 项声明必须整体切换");
    assert.ok(theme.screenshots.otherTheme, "对侧主题必须有截图");
    const reload = await unitState(result.outDir, "light", "reload-preferences");
    assert.equal(reload.status, "captured");
    assert.ok(reload.screenshots.reloaded, "重载后必须有截图");
    assert.equal(
      reload.trace.verification.checks.every((check) => check.ok),
      true,
      "重载后偏好必须逐项恢复",
    );
    const skin = await unitState(result.outDir, "light", "skin-roundtrip");
    assert.equal(skin.status, "captured");
    assert.ok(
      skin.screenshots.classic && skin.trace.verification.atClassic.candidateColoursCleared,
      "classic 必须整体清除候选色",
    );

    const meta = JSON.parse(await readFile(path.join(result.outDir, "capture.json"), "utf8"));
    assert.equal(meta.candidate.production, true);
    assert.equal(meta.candidate.skinId, "chatgpt");
    assert.deepEqual(meta.groups, ["S0", "S7"]);
    assert.equal(meta.coverage["characters-50"][0], "baseline", "50% 角色态必须由基准覆盖");

    await assert.rejects(
      () =>
        captureStateMatrix({
          candidate: null,
          skinId: "claude",
          fixture,
          outDir,
          rootDir: sandbox,
          modes: ["light"],
          measureBaseline: true,
          groups: ["S0", "S7"],
          resume: true,
        }),
      /摘要绑定不一致/,
      "正式 ChatGPT 证据不能被 Claude 正式色源复用",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
    await fixture.close();
  }
});

test("M4.3 online freeze 独立回归：live 更新、暂停同快照、恢复取得新增量", async (t) => {
  const runtime = await resolveBrowserRuntime();
  if (!runtime) {
    t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）：不伪造在线冻结回归");
    return;
  }
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-online-freeze-"));
  try {
    for (const mode of ["light", "dark"]) {
      const fixture = await createPaletteFixture();
      try {
        const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
        const usageLog = path.join(imports.imports[0].path, ".codex-usage", "usage.jsonl");
        const originalLog = await readFile(usageLog, "utf8");
        const outDir = path.join(sandbox, "docs", "validation", "m43", "online-freeze", mode);
        const { result } = await captureOnlineFreezeRegression({
          candidate: null,
          skinId: "chatgpt",
          fixture,
          mode,
          outDir,
          rootDir: sandbox,
          browserRuntime: runtime,
          stateTimeoutMs: 30000,
          pollIntervalMs: 250,
        });
        assert.equal(result.status, "passed", `${mode} 回归断言必须全部通过：${JSON.stringify(result)}`);
        assert.equal(result.events.length, 2, "暂停前后必须各新增一条 fixture 记录");
        assert.equal(result.phases.liveUpdated.totalTokens, result.phases.initialLive.totalTokens + 100_000);
        assert.equal(result.phases.paused.totalTokens, result.phases.liveUpdated.totalTokens);
        assert.equal(result.phases.pausedWeek.snapshotId, result.phases.paused.snapshotId);
        assert.equal(result.phases.pausedAll.snapshotId, result.phases.paused.snapshotId);
        assert.equal(result.phases.pausedAll.totalTokens, result.phases.paused.totalTokens);
        assert.equal(result.phases.resumed.totalTokens, result.phases.paused.totalTokens + 200_000);
        assert.ok(result.assertions.every((assertion) => assertion.ok));
        assert.ok(existsSync(path.join(outDir, "online-freeze.json")));
        for (const screenshot of Object.values(result.screenshots)) {
          assert.ok(existsSync(path.join(outDir, screenshot.file)));
        }
        assert.equal(await readFile(usageLog, "utf8"), originalLog, "独立回归退出后必须原样恢复 fixture 日志");
      } finally {
        await fixture.close();
      }
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

function progressUnitStatus(result, mode, unitId) {
  return result.progress.units[`${mode}/${unitId}`]?.status ?? null;
}

/**
 * M4.1 不可变候选预览服务（preview-server.mjs）
 * ============================================================================
 *
 * 固定接口（M4 卡面）：
 *   startCandidatePreview({ candidate, fixture, port = 0 })
 *     -> Promise<{ url, close }>
 *
 *   candidate = null 是正式色源验收模式：两个色源模块按盘上原文件提供，没有任何
 *   模块覆盖；其他输入必须是过 M0 契约的有效完整 Candidate。fixture 是 M0.4
 *   隔离 fixture（createPaletteFixture 的返回值），生命周期归调用方。
 *
 * 实现路径（卡面固定）：Node 开发代理 + 原有 createUsageServer，一实例固定一候选，
 * 没有可变全局"当前候选"。后端真实 usage server 只监听 127.0.0.1:0（临时端口，
 * 由 listen 结果决定，绝不使用用户正在运行的 3765）；前置代理只监听 loopback，
 * /api/* 与 /internal/shutdown 按方法/路径/查询/body 原样转发到自己的后端，
 * 其余路径由本模块按明确白名单从 public/ 原文件读取。
 *
 * 色源覆盖（只在这两处，页面 DOM 不改写、不注入生产分支）：
 *   /skin-palettes.js   —— 完整正式 SKIN_PALETTES 对象深拷贝后替换对应皮肤的
 *                          light/dark（扁平 token，与生产文件同形状），输出 ESM；
 *   /skin-bootstrap.js  —— M1.2 发射器 buildSkinBootstrapSource 以同一候选 override
 *                          在内存生成，首屏与运行时模块天然配对。
 *
 * 启动边界语义（复核更正后）：
 *   并发名额在第一次 await 之前同步占用，覆盖整个启动过程；任意启动失败释放名额，
 *   关闭完成后才释放。maxConcurrent 只能收紧（≥1 且 ≤ 硬上限 2），不能放宽。
 *   candidate 在启动边界同步深拷贝为快照并校验快照，两个色源模块都由快照生成、
 *   先于任何服务的创建/监听——启动期间修改调用方候选不影响服务，调用方对象不被
 *   冻结。close() 的重复/并发调用共享同一个关闭 Promise：前后服务实际关闭后才
 *   完成，fixture 不归本服务管，关闭不删证据或共享 fixture。
 *
 * 代理 body 上限 10MB：超限立即转入丢弃模式并向客户端明确回 413（先送状态码，
 * 剩余 body 只读不存、内存有界），drain 完成后才结束——客户端拿到的是 HTTP 413，
 * 不是连接重置。生产文件全程只读。
 */

import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createUsageServer } from "../../src/server.js";
import { canonicalJson, validateCandidate, validateTokens } from "./contracts.mjs";
import { buildSkinBootstrapSource } from "./bootstrap-source.mjs";
import { SKIN_PALETTES } from "../../public/skin-palettes.js";
import { createPaletteServerOptions } from "../../test-support/skin-palette-fixture.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(MODULE_DIR, "..", "..", "public");

/** 开发服务允许读取的文件类型：明确的白名单，不在表内的类型一律拒绝。 */
const STATIC_EXTENSION_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
]);

/** 转发时保留的响应头：状态与这两个"必要响应头"保持一致，逐跳头一律丢弃。 */
const FORWARDED_RESPONSE_HEADERS = new Set(["content-type", "cache-control"]);

/** 代理转发请求 body 的上限：开发工具只服务小 JSON，超限直接拒绝。 */
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

/** 同一进程同时存活的预览实例硬上限（卡面：上限 2，选项只能收紧不能放宽；"默认并发 1"是 M4.2 捕获编排的运行纪律）。 */
export const MAX_CONCURRENT_PREVIEWS = 2;

let activePreviews = 0;

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      // keep-alive 连接不会自己断：主动清掉，保证 close() 之后端口确定性地空出来。
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    } catch {
      resolve();
    }
  });
}

/**
 * fixture 必须是 M0.4 隔离 fixture：缺任一字段就在启动前报错，绝不静默回退到
 * createUsageServer 的默认值——那会读用户主目录的导入存储与数据库。
 */
function assertIsolatedFixture(fixture) {
  const message = "startCandidatePreview: fixture 必须是 createPaletteFixture() 的返回值（隔离合成 fixture）";
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new TypeError(message);
  }
  for (const field of ["homeDir", "importStoreFile", "databaseFile", "pickedPath", "fixtureHash"]) {
    if (typeof fixture[field] !== "string" || fixture[field].length === 0) {
      throw new TypeError(`${message}：缺 ${field}`);
    }
  }
}

/**
 * 内存生成候选版 /skin-palettes.js：完整正式对象深拷贝，仅替换 candidate.skinId
 * 的 light/dark（扁平 token，与生产文件同形状，不包 { tokens: ... }）。候选与生产
 * 对象都过 M0 token 校验后才序列化；绝不改写共享的生产模块状态。
 */
export function buildSkinPalettesModuleSource(candidate) {
  const merged = JSON.parse(JSON.stringify(SKIN_PALETTES));
  if (!Object.hasOwn(merged, candidate.skinId)) {
    throw new TypeError(`buildSkinPalettesModuleSource: 正式 SKIN_PALETTES 没有 "${candidate.skinId}" 条目`);
  }
  merged[candidate.skinId] = {
    light: { ...candidate.modes.light },
    dark: { ...candidate.modes.dark },
  };
  for (const mode of ["light", "dark"]) {
    const check = validateTokens(merged[candidate.skinId][mode], `SKIN_PALETTES.${candidate.skinId}.${mode}`);
    if (!check.valid) {
      const first = check.errors[0];
      throw new TypeError(`buildSkinPalettesModuleSource: ${first.path} ${first.code}：${first.message}`);
    }
  }
  return `// Generated by scripts/skin-palette/preview-server.mjs (M4.1 内存生成，生产文件未被改动).
// 本模块只属于当前预览实例：${candidate.id}
export const SKIN_PALETTES = ${JSON.stringify(merged, null, 2)};
`;
}

/** 内存生成候选版 /skin-bootstrap.js：M1.2 发射器 + 同一候选 override，首屏与模块配对。 */
export function buildSkinBootstrapModuleSource(candidate) {
  return buildSkinBootstrapSource({
    [candidate.skinId]: { light: { ...candidate.modes.light }, dark: { ...candidate.modes.dark } },
  });
}

/** 静态文件：URL 解码 → 解析 → public/ 内包含关系校验 → 扩展名白名单。 */
async function serveStaticFile(pathname, response) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }
  if (decoded.includes("\0")) {
    sendText(response, 400, "Bad request");
    return;
  }
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.resolve(PUBLIC_DIR, `.${normalized}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  const contentType = STATIC_EXTENSION_TYPES.get(path.extname(filePath).toLowerCase());
  if (!contentType) {
    sendText(response, 403, "Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    response.end(body);
  } catch {
    sendText(response, 404, "Not found");
  }
}

/**
 * 读取要转发的请求 body：累计超过 MAX_PROXY_BODY_BYTES 时立即把 413 状态码送达
 * 客户端（flushHeaders，但响应保持打开），随后转入丢弃模式继续读入剩余 body
 * （只读不存、内存有界）；等 body drain 完成后才收尾响应并返回 { tooLarge, body }。
 * 响应不提前 end：在客户端仍在发送时结束响应会触发连接重置，客户端反而收不到状态码。
 */
function readRequestBody(request, response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (tooLarge && !response.writableEnded) response.end();
      resolve({ tooLarge, body: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks) });
    };
    request.on("data", (chunk) => {
      if (tooLarge) return; // 丢弃模式：超限后的字节只读不存
      total += chunk.length;
      if (total > MAX_PROXY_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        response.writeHead(413, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          connection: "close",
        });
        response.flushHeaders();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", settle);
    // 客户端中途断开：半截 body 不能当完整请求转发
    request.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("preview proxy request connection closed before body ended"));
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/** /api/* 与 /internal/shutdown 原样转发到本实例自己的后端（绝不指向用户端口）。 */
async function forwardToBackend(request, response, backendPort) {
  let drained;
  try {
    drained = await readRequestBody(request, response);
  } catch (error) {
    // 读取失败多半是客户端中途断开，响应已不可达：尽力而为
    if (!response.headersSent && !response.destroyed) {
      sendText(response, 502, `preview proxy request read failure: ${error?.message ?? error}`);
    }
    return;
  }
  if (drained.tooLarge) return; // 413 已在超限点发出，body 已 drain 完毕
  const body = drained.body;
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  delete headers["keep-alive"];
  delete headers.expect;
  if (body.length > 0) headers["content-length"] = String(body.length);
  const upstream = httpRequest({
    host: "127.0.0.1",
    port: backendPort,
    method: request.method,
    path: request.url,
    headers,
  });
  upstream.on("response", (upstreamResponse) => {
    const forwarded = {};
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (FORWARDED_RESPONSE_HEADERS.has(name) && value !== undefined) forwarded[name] = value;
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, forwarded);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) sendText(response, 502, "preview backend unavailable");
  });
  if (body.length > 0) upstream.end(body);
  else upstream.end();
}

/**
 * 同步深拷贝候选快照：启动边界之后调用方对象怎么改都不影响本实例。
 * 必须走 M0 的 canonicalJson 而不是 JSON.stringify——stringify 会"洗掉"非法数据
 * （undefined 字段被删、稀疏数组空位变 null、Date 变 ISO 字符串），让本应被 M0
 * 契约拒绝的候选洗白成"有效"快照。canonicalJson 对这几类（以及循环引用、非 JSON
 * 数值等）显式抛错：快照失败即候选非法，绝不静默放宽。
 */
function snapshotCandidate(candidate) {
  try {
    return JSON.parse(canonicalJson(candidate));
  } catch (error) {
    throw new TypeError(
      `startCandidatePreview: candidate 必须是可 JSON 序列化的完整 Candidate（快照失败：${error?.message ?? error}）`,
    );
  }
}

function contractError(check) {
  const first = check.errors[0];
  return new TypeError(
    `startCandidatePreview: 候选不合 M0 契约（candidates.${first.path} ${first.code}：${first.message}）`,
  );
}

/**
 * 启动不可变候选预览服务。candidate=null 为正式色源验收模式；其他输入必须是
 * 有效完整 Candidate（启动边界同步快照并校验快照，坏候选在监听任何端口之前报错）。
 */
export async function startCandidatePreview({
  candidate,
  fixture,
  port = 0,
  maxConcurrent = MAX_CONCURRENT_PREVIEWS,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("startCandidatePreview: port 必须是 0—65535 的整数（0 = 临时端口）");
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new TypeError("startCandidatePreview: maxConcurrent 必须是正整数");
  }
  if (maxConcurrent > MAX_CONCURRENT_PREVIEWS) {
    throw new TypeError(
      `startCandidatePreview: maxConcurrent 不能超过硬上限 ${MAX_CONCURRENT_PREVIEWS}（只能收紧，不能放宽）`,
    );
  }
  assertIsolatedFixture(fixture);
  if (activePreviews >= maxConcurrent) {
    throw new Error(
      `startCandidatePreview: 已有 ${activePreviews} 个预览实例存活，达到并发上限 ${maxConcurrent}（先 close 再开新实例）`,
    );
  }
  // 名额在第一次 await 之前同步占用，覆盖整个启动过程；以下任何失败在出口统一释放。
  activePreviews += 1;
  try {
    const productionMode = candidate === null;
    let snapshot = null;
    if (!productionMode) {
      if (typeof candidate !== "object") {
        // 原始值/undefined 不是正式模式：给标准 M0 契约错误，而不是快照器的报错
        throw contractError(validateCandidate(candidate));
      }
      snapshot = snapshotCandidate(candidate);
      const check = validateCandidate(snapshot);
      if (!check.valid) throw contractError(check);
    }
    // 两个色源模块先于任何服务的创建/监听由快照生成：生成失败时没有任何资源可泄漏
    const paletteModuleSource = productionMode ? null : buildSkinPalettesModuleSource(snapshot);
    const bootstrapModuleSource = productionMode ? null : buildSkinBootstrapModuleSource(snapshot);

    const backend = createUsageServer(createPaletteServerOptions(fixture));
    try {
      await listen(backend, 0, "127.0.0.1");
    } catch (error) {
      await closeServer(backend);
      throw error;
    }
    const backendPort = backend.address().port;

    const frontend = createHttpServer((request, response) => {
      void handlePreviewRequest({ request, response, backendPort, paletteModuleSource, bootstrapModuleSource });
    });
    try {
      await listen(frontend, port, "127.0.0.1");
    } catch (error) {
      await closeServer(frontend);
      await closeServer(backend);
      throw error;
    }

    let closePromise = null;
    const close = () => {
      if (closePromise === null) {
        closePromise = (async () => {
          // fixture 生命周期归调用方：这里只关两个服务，不碰 fixture。
          await closeServer(frontend);
          await closeServer(backend);
          // 所有重复/并发调用等的是同一次真实关闭；名额在关闭完成后才释放。
          activePreviews = Math.max(0, activePreviews - 1);
        })();
      }
      return closePromise;
    };

    const address = frontend.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    return {
      url: `http://127.0.0.1:${actualPort}/`,
      close,
    };
  } catch (error) {
    activePreviews = Math.max(0, activePreviews - 1);
    throw error;
  }
}

async function handlePreviewRequest({ request, response, backendPort, paletteModuleSource, bootstrapModuleSource }) {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/skin-palettes.js" && paletteModuleSource !== null) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(paletteModuleSource);
      return;
    }
    if (url.pathname === "/skin-bootstrap.js" && bootstrapModuleSource !== null) {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(bootstrapModuleSource);
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname === "/internal/shutdown") {
      await forwardToBackend(request, response, backendPort);
      return;
    }
    await serveStaticFile(url.pathname, response);
  } catch (error) {
    if (!response.headersSent) {
      sendText(response, 500, `preview server error: ${error?.message ? error.message : error}`);
    } else {
      response.destroy();
    }
  }
}

export default {
  startCandidatePreview,
  buildSkinPalettesModuleSource,
  buildSkinBootstrapModuleSource,
  MAX_CONCURRENT_PREVIEWS,
};

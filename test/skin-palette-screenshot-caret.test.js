import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { pathToFileURL } from "node:url";

import { screenshotWithStyleAttributeGuard } from "../scripts/skin-palette/browser-measure.mjs";

class FakeElement {
  constructor(style = null) {
    this.attributes = new Map();
    this.removeError = null;
    this.removeCalls = 0;
    this.shadowRoot = null;
    if (style !== null) this.setAttribute("style", style);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.removeCalls += 1;
    if (this.removeError) throw this.removeError;
    this.attributes.delete(name);
  }
}

class FakeRoot {
  constructor(targets = [], elements = targets) {
    this.targets = targets;
    this.elements = elements;
  }

  querySelectorAll(selector) {
    return selector === "*" ? this.elements : this.targets;
  }
}

class FakePage {
  constructor(document, takeScreenshot) {
    this.document = document;
    this.takeScreenshot = takeScreenshot;
    this.screenshotCalls = 0;
    this.screenshotOptions = undefined;
    this.evaluateCalls = 0;
    this.evaluateArguments = [];
    this.failEvaluationAt = null;
    this.evaluationError = null;
    this.window = { otherOperationState: { keep: true } };
    this.pageRealm = createContext({ document, window: this.window });
  }

  async evaluate(callback, argument) {
    assert.equal(typeof callback, "function", "适配器只暴露现有 evaluate(source, argument) 接口");
    this.evaluateCalls += 1;
    this.evaluateArguments.push(argument);
    if (this.evaluateCalls === this.failEvaluationAt) throw this.evaluationError;
    this.pageRealm.argument = argument;
    return runInContext(`(${callback.toString()})(argument)`, this.pageRealm);
  }

  async screenshot(options) {
    this.screenshotCalls += 1;
    this.screenshotOptions = options;
    return this.takeScreenshot(options);
  }
}

function fakePageFor(input, takeScreenshot, { elements = [input], targets = [input] } = {}) {
  return new FakePage(new FakeRoot(targets, elements), takeScreenshot);
}

function assertGuardStashReleased(page) {
  assert.deepEqual(
    Object.getOwnPropertyNames(page.window).filter((key) => key.startsWith("__skinScreenshotStyleGuard_")),
    [],
  );
  assert.deepEqual(page.window.otherOperationState, { keep: true }, "不能删除其他页内状态");
}

test("D8u12：full-page、viewport 与 clip 实际截图边界都委托 guard 并保留 options", () => {
  const source = readFileSync(new URL("../scripts/skin-palette/browser-measure.mjs", import.meta.url), "utf8");
  const stablePageStart = source.indexOf("async function captureStablePage(");
  const fullPageStart = source.indexOf("export async function captureStableFullPage");
  const roleMeasureStart = source.indexOf("export async function measureBrowserRoles");
  assert.ok(stablePageStart >= 0 && fullPageStart > stablePageStart && roleMeasureStart > fullPageStart);
  const stablePageSource = source.slice(stablePageStart, fullPageStart);
  const fullPageSource = source.slice(fullPageStart, roleMeasureStart);
  const roleMeasureSource = source.slice(roleMeasureStart);

  assert.match(stablePageSource, /png\s*=\s*await\s+screenshotWithStyleAttributeGuard\(page,\s*\{\s*fullPage\s*\}\);/);
  assert.match(
    fullPageSource,
    /return captureStablePage\(page, \{ fullPage: true, name: "captureStableFullPage" \}\);/,
  );
  assert.match(
    fullPageSource,
    /return captureStablePage\(page, \{ fullPage: false, name: "captureStableViewport" \}\);/,
  );
  assert.match(
    roleMeasureSource,
    /const\s+png\s*=\s*await\s+screenshotWithStyleAttributeGuard\(page,\s*\{\s*clip\s*\}\);/,
  );
});

test("D8u11：evaluate-only 默认截图清理原无 style 的主文档和开放 shadow 输入", async () => {
  const input = new FakeElement();
  const shadowInput = new FakeElement();
  const host = new FakeElement();
  host.shadowRoot = new FakeRoot([shadowInput], [shadowInput]);
  const replacement = new FakeElement("color: blue;");
  const document = new FakeRoot([input], [input, host]);
  const buffer = Buffer.from("original screenshot bytes");
  const options = { clip: { x: 0, y: 0, width: 1, height: 1 } };
  const page = new FakePage(document, (receivedOptions) => {
    assert.strictEqual(receivedOptions, options);
    const [key] = Object.getOwnPropertyNames(page.window).filter((name) =>
      name.startsWith("__skinScreenshotStyleGuard_"),
    );
    assert.ok(key, "截图期间页内暂存仍存在");
    assert.equal(page.window[key].token, key.slice("__skinScreenshotStyleGuard_".length));
    assert.ok(page.window[key].elements.has(input), "页内状态持有原元素对象引用");
    input.setAttribute("style", "");
    shadowInput.setAttribute("style", "");
    document.targets[0] = replacement;
    return buffer;
  });

  const result = await screenshotWithStyleAttributeGuard(page, options);

  assert.strictEqual(result, buffer);
  assert.equal(page.screenshotCalls, 1);
  assert.equal(Object.hasOwn(options, "caret"), false, "默认截图继续隐藏光标，不改用 caret: initial");
  assert.equal(input.hasAttribute("style"), false);
  assert.equal(shadowInput.hasAttribute("style"), false);
  assert.equal(input.removeCalls, 1);
  assert.equal(shadowInput.removeCalls, 1);
  assert.equal(replacement.getAttribute("style"), "color: blue;", "不按 selector 清理替换后的节点");
  assert.equal(replacement.removeCalls, 0);
  assert.equal(page.evaluateCalls, 2, "只使用快照和清理两次 evaluate");
  assert.match(page.evaluateArguments[0], /^[0-9a-f-]{36}$/);
  assert.equal(page.evaluateArguments[0], page.evaluateArguments[1], "快照和清理复用本次唯一 token");
  assert.equal(typeof page.evaluateHandle, "undefined");
  assertGuardStashReleased(page);
});

test("D8u11：原有空 style 属性保持存在", async () => {
  const input = new FakeElement("");
  const page = fakePageFor(input, () => Buffer.from("png"));

  await screenshotWithStyleAttributeGuard(page);

  assert.equal(input.hasAttribute("style"), true);
  assert.equal(input.getAttribute("style"), "");
  assert.equal(input.removeCalls, 0);
  assertGuardStashReleased(page);
});

test("D8u11：原非空 style 声明及 caret priority 保持不变", async () => {
  const originalStyle = "caret-color: teal !important; color: red;";
  const input = new FakeElement(originalStyle);
  const page = fakePageFor(input, () => {
    input.setAttribute("style", "caret-color: transparent !important; color: red;");
    input.setAttribute("style", originalStyle);
    return Buffer.from("png");
  });

  await screenshotWithStyleAttributeGuard(page);

  assert.equal(input.getAttribute("style"), originalStyle);
  assert.equal(input.removeCalls, 0);
  assertGuardStashReleased(page);
});

test("D8u11：截图期间新增的无关声明不会被删除", async () => {
  const input = new FakeElement();
  const page = fakePageFor(input, () => {
    input.setAttribute("style", "color: rebeccapurple;");
    return Buffer.from("png");
  });

  await screenshotWithStyleAttributeGuard(page);

  assert.equal(input.getAttribute("style"), "color: rebeccapurple;");
  assert.equal(input.removeCalls, 0);
  assertGuardStashReleased(page);
});

test("D8u11：截图抛错仍清理空 style 并原样抛出主错误", async () => {
  const input = new FakeElement();
  const screenshotError = new Error("injected screenshot error");
  const page = fakePageFor(input, () => {
    input.setAttribute("style", "");
    throw screenshotError;
  });

  await assert.rejects(screenshotWithStyleAttributeGuard(page), (error) => error === screenshotError);

  assert.equal(input.hasAttribute("style"), false);
  assertGuardStashReleased(page);
});

test("D8u11：截图成功但属性清理失败时显式报错", async () => {
  const input = new FakeElement();
  input.removeError = new Error("injected cleanup error");
  const page = fakePageFor(input, () => {
    input.setAttribute("style", "");
    return Buffer.from("png");
  });

  await assert.rejects(screenshotWithStyleAttributeGuard(page), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /injected cleanup error/);
    return true;
  });
  assert.equal(input.getAttribute("style"), "");
  assertGuardStashReleased(page);
});

test("D8u11：截图和清理双错时主错误在 AggregateError 首位", async () => {
  const input = new FakeElement();
  input.removeError = new Error("injected cleanup error");
  const screenshotError = new Error("injected screenshot error");
  const page = fakePageFor(input, () => {
    input.setAttribute("style", "");
    throw screenshotError;
  });

  await assert.rejects(screenshotWithStyleAttributeGuard(page), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.strictEqual(error.errors[0], screenshotError);
    assert.strictEqual(error.cause, screenshotError);
    assert.match(error.errors[1].message, /injected cleanup error/);
    return true;
  });
  assertGuardStashReleased(page);
});

test("D8u11：同步快照失败不启动截图，并释放可能已保存的本次暂存", async () => {
  const input = new FakeElement();
  const snapshotError = new Error("injected snapshot transport error");
  const page = fakePageFor(input, () => Buffer.from("unexpected screenshot"));
  page.failEvaluationAt = 1;
  page.evaluationError = snapshotError;

  await assert.rejects(screenshotWithStyleAttributeGuard(page), (error) => error === snapshotError);

  assert.equal(page.screenshotCalls, 0);
  assert.equal(page.evaluateCalls, 2, "失败后仍用 evaluate 尝试按本次 token 清理");
  assertGuardStashReleased(page);
});

async function resolvePlaywrightRuntime() {
  const candidates = [
    process.env.AGENT_USAGE_PLAYWRIGHT_MODULE,
    path.join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
    ),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      const specifier = existsSync(candidate) ? pathToFileURL(candidate).href : candidate;
      const module = await import(specifier);
      if (module.chromium) return { chromium: module.chromium, entry: import.meta.resolve(specifier) };
    } catch {
      // Try the next configured runtime candidate.
    }
  }
  throw new Error("D8u11: 无法解析现有 Playwright runtime");
}

test("D8u11：Edge 默认截图后恢复原无 style 输入的属性边界", async (t) => {
  const runtime = await resolvePlaywrightRuntime();
  const edgeCandidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/google-chrome",
  ];
  const executablePath = edgeCandidates.find((candidate) => existsSync(candidate));
  assert.ok(executablePath, "D8u11: 找不到现有 Edge 可执行文件");

  const browser = await runtime.chromium.launch({ executablePath, headless: true });
  let context;
  try {
    t.diagnostic(`Edge ${browser.version()}, Playwright entry ${runtime.entry}`);
    context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html><head><meta charset="utf-8"></head><body><input id="target" value="x"></body></html>',
      { waitUntil: "load" },
    );
    await page.locator("#target").focus();
    const before = await page.evaluate(() => {
      const input = document.querySelector("#target");
      const rawBeforeCssom = { present: input.hasAttribute("style"), value: input.getAttribute("style") };
      const caretColor = input.style.getPropertyValue("caret-color");
      const caretPriority = input.style.getPropertyPriority("caret-color");
      const rawAfterCssom = { present: input.hasAttribute("style"), value: input.getAttribute("style") };
      return {
        rawBeforeCssom,
        caretColor,
        caretPriority,
        rawAfterCssom,
        guardKeys: Object.getOwnPropertyNames(window).filter((key) => key.startsWith("__skinScreenshotStyleGuard_")),
        active: document.activeElement === input,
        value: input.value,
      };
    });
    assert.deepEqual(before.rawBeforeCssom, { present: false, value: null });
    assert.deepEqual(before.rawAfterCssom, { present: false, value: null });
    assert.deepEqual(before.guardKeys, []);
    assert.equal(before.active, true);
    assert.equal(before.value, "x");

    const screenshot = await screenshotWithStyleAttributeGuard(page);
    assert.ok(Buffer.isBuffer(screenshot), "helper returns the original screenshot Buffer");
    const after = await page.evaluate(() => {
      const input = document.querySelector("#target");
      const rawBeforeCssom = { present: input.hasAttribute("style"), value: input.getAttribute("style") };
      const caretColor = input.style.getPropertyValue("caret-color");
      const caretPriority = input.style.getPropertyPriority("caret-color");
      const rawAfterCssom = { present: input.hasAttribute("style"), value: input.getAttribute("style") };
      return {
        rawBeforeCssom,
        caretColor,
        caretPriority,
        rawAfterCssom,
        guardKeys: Object.getOwnPropertyNames(window).filter((key) => key.startsWith("__skinScreenshotStyleGuard_")),
        active: document.activeElement === input,
        value: input.value,
      };
    });
    assert.deepEqual(after.rawBeforeCssom, { present: false, value: null });
    assert.deepEqual(after.rawAfterCssom, { present: false, value: null });
    assert.deepEqual(after.guardKeys, [], "Edge page has no remaining guard token property");
    assert.equal(after.active, true);
    assert.equal(after.value, "x");
    t.diagnostic(`default screenshot SHA-256 ${createHash("sha256").update(screenshot).digest("hex")}`);
  } finally {
    if (context) await context.close();
    await browser.close();
  }
});

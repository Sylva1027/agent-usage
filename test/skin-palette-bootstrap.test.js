/**
 * M1.2 bootstrap emitter acceptance tests (node --test).
 *
 * The emitter is pure: same input, same output, no filesystem access. These
 * tests pin byte-identity with the committed production bootstrap, the
 * override contract (strict validation + M1.1 derivation), and the emitted
 * IIFE's behaviour in a simulated DOM/storage sandbox.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { buildSkinBootstrapSource } from "../scripts/skin-palette/bootstrap-source.mjs";
import {
  DEFAULT_SKIN_PREFERENCE,
  PALETTE_CSS_VAR_NAMES,
  SKINS,
  SKIN_MODES,
  SKIN_PREFERENCE_KEY,
  SKIN_PREFERENCE_VERSION,
  derivePaletteDeclarationsFromTokens,
  paletteDeclarations,
} from "../public/skins.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const makeTokens = (overrides = {}) => ({
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
  ...overrides,
});

const withoutAccent = (tokens) => {
  const { accent: _accent, ...rest } = tokens;
  return rest;
};

const parseConfig = (source) => JSON.parse(source.match(/const CONFIG = (\{[^\n]*\});/)[1]);

/**
 * Execute an emitted bootstrap against a simulated DOM/storage. The sandbox
 * converts camelCase dataset keys to their data-* attributes exactly like the
 * platform, records every style removal/application in call order, and cleans
 * the globals up afterwards so tests stay independent.
 */
function runBootstrap(source, { preference = null, theme = "light" } = {}) {
  const attributes = new Map();
  const toAttribute = (key) => `data-${String(key).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
  const dataset = new Proxy(
    {},
    {
      get: (_target, key) => attributes.get(toAttribute(key)),
      set: (_target, key, value) => {
        attributes.set(toAttribute(key), String(value));
        return true;
      },
    },
  );
  attributes.set("data-theme", theme);
  const style = {
    removed: [],
    applied: new Map(),
    removeProperty(name) {
      this.removed.push(name);
      this.applied.delete(name);
    },
    setProperty(name, value) {
      this.applied.set(name, value);
    },
  };
  const storage = new Map();
  if (preference !== null) storage.set(SKIN_PREFERENCE_KEY, JSON.stringify(preference));
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  globalThis.document = { documentElement: { dataset, style } };
  globalThis.localStorage = { getItem: (key) => (storage.has(key) ? storage.get(key) : null) };
  try {
    vm.runInThisContext(source, { filename: "skin-bootstrap.sandbox.js" });
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
  return { attributes, style, storage };
}

test("buildSkinBootstrapSource：无 override 时与已提交生产 bootstrap 逐字相同且输出稳定", () => {
  const committed = readFileSync(path.join(root, "public/skin-bootstrap.js"), "utf8");
  const first = buildSkinBootstrapSource();
  assert.equal(first, committed, "the pure emitter must reproduce the committed canonical text byte-for-byte");
  assert.equal(buildSkinBootstrapSource(), first, "the emitter is pure: same input, same output");
  assert.equal(buildSkinBootstrapSource({}), first, "an empty override object behaves like no override");
});

test("buildSkinBootstrapSource：CONFIG 载荷与注册表等价，classic 无 palette", () => {
  const config = parseConfig(buildSkinBootstrapSource());
  assert.equal(config.key, SKIN_PREFERENCE_KEY);
  assert.equal(config.version, SKIN_PREFERENCE_VERSION);
  assert.deepEqual(config.defaultPreference, DEFAULT_SKIN_PREFERENCE);
  assert.deepEqual(config.modes, SKIN_MODES);
  assert.deepEqual(config.paletteVarNames, [...PALETTE_CSS_VAR_NAMES]);
  assert.equal(config.registry.length, SKINS.length);
  for (const [index, entry] of config.registry.entries()) {
    const skin = SKINS[index];
    assert.equal(entry.id, skin.id);
    assert.equal(entry.name, skin.name);
    assert.equal(entry.isClassic, skin.isClassic);
    assert.deepEqual(entry.light, skin.variants.light.assets);
    assert.deepEqual(entry.dark, skin.variants.dark.assets);
    if (skin.isClassic) assert.equal(entry.palette, null);
    else {
      assert.deepEqual(entry.palette.light, paletteDeclarations(skin.id, "light"));
      assert.deepEqual(entry.palette.dark, paletteDeclarations(skin.id, "dark"));
    }
  }
});

test("buildSkinBootstrapSource：覆盖单角色只改该角色两模式 palette，值来自 M1.1 纯接口", () => {
  const overrideTokens = {
    light: makeTokens({ accent: "#123456", pageBackground: "#223344" }),
    dark: makeTokens({ accent: "#654321", pageBackground: "#334455" }),
  };
  const base = parseConfig(buildSkinBootstrapSource());
  const overridden = parseConfig(buildSkinBootstrapSource({ kimi: overrideTokens }));
  const baseById = new Map(base.registry.map((entry) => [entry.id, entry]));
  for (const entry of overridden.registry) {
    const before = baseById.get(entry.id);
    if (entry.id === "kimi") {
      assert.notDeepEqual(entry.palette, before.palette, "the override must actually change the covered palette");
      assert.deepEqual(entry.palette.light, derivePaletteDeclarationsFromTokens(overrideTokens.light, "light"));
      assert.deepEqual(entry.palette.dark, derivePaletteDeclarationsFromTokens(overrideTokens.dark, "dark"));
      assert.deepEqual(
        { light: entry.light, dark: entry.dark, name: entry.name, isClassic: entry.isClassic },
        { light: before.light, dark: before.dark, name: before.name, isClassic: before.isClassic },
        "assets and identity stay registry-derived even for the covered skin",
      );
    } else {
      assert.deepEqual(entry, before, `${entry.id}: uncovered skins keep the official payload unchanged`);
    }
  }
});

test("buildSkinBootstrapSource：未知 id、classic、半套、未知模式与坏色值显式抛错", () => {
  const full = { light: makeTokens(), dark: makeTokens() };
  assert.throws(() => buildSkinBootstrapSource({ foo: full }), /不是十套角色皮肤/);
  assert.throws(() => buildSkinBootstrapSource({ classic: full }), /classic 不可覆盖/);
  assert.throws(() => buildSkinBootstrapSource({ kimi: { light: makeTokens() } }), /缺少自有属性 dark/);
  assert.throws(() => buildSkinBootstrapSource({ kimi: { dark: makeTokens() } }), /缺少自有属性 light/);
  assert.throws(() => buildSkinBootstrapSource({ kimi: { ...full, noon: makeTokens() } }), /未知模式 "noon"/);
  assert.throws(
    () => buildSkinBootstrapSource({ kimi: { light: makeTokens({ accent: "#3870ff" }), dark: makeTokens() } }),
    /未通过 M0 严格 token 校验/,
  );
  assert.throws(
    () => buildSkinBootstrapSource({ kimi: { light: makeTokens({ accent: "#3870FFAA" }), dark: makeTokens() } }),
    /未通过 M0 严格 token 校验/,
  );
  assert.throws(
    () => buildSkinBootstrapSource({ kimi: { light: withoutAccent(makeTokens()), dark: makeTokens() } }),
    /accent 不是自有属性/,
    "a missing token key is caught by the own-property gate before the shared validator",
  );
  assert.throws(() => buildSkinBootstrapSource(null), /paletteOverrides 必须是/);
  assert.throws(() => buildSkinBootstrapSource("nope"), /paletteOverrides 必须是/);
  assert.throws(() => buildSkinBootstrapSource({ kimi: null }), /必须是 \{ light, dark \} 形状/);
});

test("buildSkinBootstrapSource：原型链上的模式、token 与皮肤条目一律不算已提供", () => {
  // `in` 与普通属性读取都走原型链：继承来的 dark 此前会被当成已提供。
  const borrowedDark = Object.assign(Object.create({ dark: makeTokens() }), { light: makeTokens() });
  assert.throws(() => buildSkinBootstrapSource({ kimi: borrowedDark }), /缺少自有属性 dark/);

  // 共享 validateTokens 经普通属性读取会接受继承的 accent；自有属性闸门必须先拦下。
  const borrowedAccent = Object.assign(Object.create({ accent: "#3870FF" }), withoutAccent(makeTokens()));
  assert.throws(
    () => buildSkinBootstrapSource({ kimi: { light: borrowedAccent, dark: makeTokens() } }),
    /accent 不是自有属性/,
  );

  // 发射只读已验证的自有皮肤条目：原型链上的 kimi 覆盖不是输入，
  // 输出必须与无 override 基线逐字相同。
  const sneaky = Object.create({ kimi: { light: makeTokens(), dark: makeTokens() } });
  assert.equal(buildSkinBootstrapSource(sneaky), buildSkinBootstrapSource());

  // 继承覆盖也不得经 IIFE 进首帧：applied 的 --blue 仍是正式值。
  const { style } = runBootstrap(buildSkinBootstrapSource(sneaky), {
    preference: { version: SKIN_PREFERENCE_VERSION, skinId: "kimi", showCharacters: true, opacity: 0.5 },
  });
  const officialBlue = paletteDeclarations("kimi", "light").find(([name]) => name === "--blue")[1];
  assert.equal(style.applied.get("--blue"), officialBlue, "an inherited override must not reach first paint");
});

test("buildSkinBootstrapSource：IIFE 在模拟 DOM/storage 中执行，先清 20 变量再设 M1.1 声明", () => {
  const source = buildSkinBootstrapSource();
  const preference = { version: SKIN_PREFERENCE_VERSION, skinId: "chatgpt", showCharacters: true, opacity: 0.5 };
  const { attributes, style } = runBootstrap(source, { preference });
  assert.equal(attributes.get("data-skin"), "chatgpt");
  assert.equal(attributes.get("data-skin-characters"), "on");
  assert.equal(attributes.get("data-skin-opacity"), "0.5");
  assert.equal(attributes.get("data-skin-theme"), "light");
  assert.equal(attributes.get("data-skin-bootstrap"), "1");
  assert.ok(attributes.get("data-skin-side-asset")?.startsWith("/assets/skins/light/"));
  assert.deepEqual(
    [...new Set(style.removed)].sort(),
    [...PALETTE_CSS_VAR_NAMES].sort(),
    "every palette variable is cleared before re-application",
  );
  const declarations = paletteDeclarations("chatgpt", "light");
  assert.equal(style.applied.size, declarations.length);
  for (const [name, value] of declarations) {
    assert.equal(style.applied.get(name), value, `${name} must carry the M1.1 declaration value`);
  }
});

test("buildSkinBootstrapSource：classic 恢复清除全部变量且不残留任何 palette 值", () => {
  const source = buildSkinBootstrapSource();
  // Empty storage: the IIFE must fall back to the classic default preference.
  const { attributes, style } = runBootstrap(source, {});
  assert.equal(attributes.get("data-skin"), DEFAULT_SKIN_PREFERENCE.skinId);
  assert.deepEqual([...new Set(style.removed)].sort(), [...PALETTE_CSS_VAR_NAMES].sort());
  assert.equal(style.applied.size, 0, "no palette value may survive a classic restore");
  assert.equal(attributes.get("data-skin-side-asset"), undefined);
  assert.equal(attributes.get("data-skin-front-asset"), undefined);
});

test("buildSkinBootstrapSource：IIFE 按 data-theme 取深色声明，storage 版本不符回退 classic", () => {
  const source = buildSkinBootstrapSource();
  const dark = runBootstrap(source, {
    preference: { version: SKIN_PREFERENCE_VERSION, skinId: "chatgpt", showCharacters: true, opacity: 0.5 },
    theme: "dark",
  });
  for (const [name, value] of paletteDeclarations("chatgpt", "dark")) {
    assert.equal(dark.style.applied.get(name), value);
  }
  const stale = runBootstrap(source, {
    preference: { version: SKIN_PREFERENCE_VERSION + 1, skinId: "kimi", showCharacters: false, opacity: 1 },
  });
  assert.equal(stale.attributes.get("data-skin"), "classic", "a wrong preference version falls back to classic");
});

test("buildSkinBootstrapSource：覆盖角色的 IIFE 首帧声明即 override 派生值", () => {
  const overrideTokens = { light: makeTokens({ accent: "#123456" }), dark: makeTokens({ accent: "#654321" }) };
  const source = buildSkinBootstrapSource({ kimi: overrideTokens });
  const { style } = runBootstrap(source, {
    preference: { version: SKIN_PREFERENCE_VERSION, skinId: "kimi", showCharacters: true, opacity: 0.5 },
  });
  for (const [name, value] of derivePaletteDeclarationsFromTokens(overrideTokens.light, "light")) {
    assert.equal(style.applied.get(name), value);
  }
  assert.equal(style.applied.get("--blue"), "#123456", "the first painted accent is the overridden one");
});

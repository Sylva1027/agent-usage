/**
 * ============================================================================
 *  配色输入通道 / Colour input channel
 * ============================================================================
 *
 * 这是给你（用户）填写配色的唯一入口。它和代码完全分离：你只需要在这个文件
 * 里填颜色，不需要改任何其他文件，也不需要用命令行。
 *
 * 使用方法
 * ---------------------------------------------------------------------------
 * 1. 找到想配色的角色（下面每个角色都有一段空白模板）。
 * 2. 把 `light: null` / `dark: null` 换成一个大括号，按需填 token。
 * 3. 只填你想指定的 token。**没填的 token 一律"沿用当前模式基底"**，不会被
 *    推导、复制或猜测。
 * 4. 一个 token 都不填时，该模式保持 `null`（界面显示"配色待定"），这是正确
 *    状态，不是错误。
 * 5. 保存后告诉我"配色填好了"，我会跑校验并接入。
 *
 * 校验
 * ---------------------------------------------------------------------------
 *   npm run skins:palette        # 只校验，不改任何文件
 *
 * 校验会检查：颜色格式、是否在允许的 token 名单内、浅深两组是否各自独立。
 * 填错会给出精确到行号的提示，不会静默忽略。
 *
 * 允许的 token 名单（只有这些会被接受）
 * ---------------------------------------------------------------------------
 *   pageBackground    页面基底
 *   panelBackground   卡片 / 面板底
 *   panelBorder       面板描边
 *   panelHighlight    面板高光（拟物凸起）
 *   panelShadow       面板阴影（拟物凹陷）
 *   textPrimary       主文字
 *   textSecondary     次要文字
 *   accent            强调色（按钮 / 选中态）
 *   controlBackground 控件底
 *   controlBorder     控件描边
 *   controlText       控件文字
 *   chartText         图表文字
 *
 *   chartSeries       可选：图表系列色数组，例如 ["#007d91", "#4bb3c4", "#9ed9e2"]
 *                     （它按数组整体替换，不是单个 token）
 *
 * 颜色写法
 * ---------------------------------------------------------------------------
 *   十六进制       "#23313c"、"#fff"、"#23313cff"
 *   rgb / rgba     "rgb(35, 49, 60)"、"rgba(35, 49, 60, 0.6)"
 *   其它 CSS 颜色  "hsl(210 30% 20%)"、"transparent"、"currentColor" 亦可
 *
 * 不要写的内容
 * ---------------------------------------------------------------------------
 *   ✗ 不要写尺寸、间距、字体（如 "12px"、"1.5rem"、"Inter"）——本通道只收颜色，
 *     写这些会被校验拒绝。皮肤配色**绝不改变任何布局几何**。
 *   ✗ 不要留 TODO 占位或示例颜色当作"待定"——不确定就直接保持 null。
 *
 * 当前状态
 * ---------------------------------------------------------------------------
 * 十个角色的浅深两模式已由用户经配色工作台定稿并全部填入（2026-10-02，每套
 * 12 token，共 20/20 槽位）；classic（无皮肤）没有 palette 槽。`npm run
 * skins:palette` PASS；八条"次要文字"对比度告警（浅 2 / 深 6）记录在案，
 * 详见 docs/validation/2026-10-02-model-character-skins/README.md 第 12 节。
 * 整页接线已实施（skins.js paletteDeclarations → apply/bootstrap/离线快照），
 * 见同 README 第 13 节。
 */

/**
 * @typedef {object} PaletteTokens
 * @property {string} [pageBackground]
 * @property {string} [panelBackground]
 * @property {string} [panelBorder]
 * @property {string} [panelHighlight]
 * @property {string} [panelShadow]
 * @property {string} [textPrimary]
 * @property {string} [textSecondary]
 * @property {string} [accent]
 * @property {string} [controlBackground]
 * @property {string} [controlBorder]
 * @property {string} [controlText]
 * @property {string} [chartText]
 *
 * @typedef {PaletteTokens & { chartSeries?: string[] }} Palette
 *
 * 每个模式可以是：
 *   - null            → 未指定，界面标注"配色待定"（当前全部如此）
 *   - { ...tokens }   → 只填你指定的 token，其余沿用当前模式基底
 */

/**
 * 皮肤配色。
 *
 * 键名（skin id）必须与注册表一致，不要新增或改名：
 *   chatgpt claude glm gemini deepseek kimi qwen grok muse mimo  classic
 *
 * classic（无皮肤）没有 palette 槽，也不应该有：它本来就"不使用任何配色"。
 */
export const SKIN_PALETTES = {
  chatgpt: {
    // 源四色（深→浅）：#52407d #607ec7 #9685c1 #B9C9EE
    light: {
      pageBackground: "#B9C9EE",
      panelBackground: "#dce4f7",
      panelBorder: "#dce4f7",
      panelHighlight: "#f3f6fc",
      panelShadow: "#71699f",
      textPrimary: "#52407d",
      textSecondary: "#807eb0",
      accent: "#3870ff",
      controlBackground: "#dce4f7",
      controlBorder: "#7f98d5",
      controlText: "#52407d",
      chartText: "#807eb0",
    },
    dark: {
      pageBackground: "#52407d",
      panelBackground: "#585c9e",
      panelBorder: "#585c9e",
      panelHighlight: "#7e6da9",
      panelShadow: "#15101f",
      textPrimary: "#B9C9EE",
      textSecondary: "#8b8bbb",
      accent: "#5c86f0",
      controlBackground: "#585c9e",
      controlBorder: "#6a5895",
      controlText: "#B9C9EE",
      chartText: "#8b8bbb",
    },
  },

  claude: {
    // 源四色（深→浅）：#292020 #9e6c57 #d26e46 #efd6cc
    light: {
      pageBackground: "#efd6cc",
      panelBackground: "#f7ebe6",
      panelBorder: "#f7ebe6",
      panelHighlight: "#f7e7de",
      panelShadow: "#645754",
      textPrimary: "#292020",
      textSecondary: "#82726d",
      accent: "#d26e46",
      controlBackground: "#f7ebe6",
      controlBorder: "#ba9180",
      controlText: "#292020",
      chartText: "#82726d",
    },
    dark: {
      pageBackground: "#292020",
      panelBackground: "#5e4239",
      panelBorder: "#5e4239",
      panelHighlight: "#95604b",
      panelShadow: "#0a0808",
      textPrimary: "#efd6cc",
      textSecondary: "#96847f",
      accent: "#d77f5c",
      controlBackground: "#5e4239",
      controlBorder: "#643b2d",
      controlText: "#efd6cc",
      chartText: "#96847f",
    },
  },

  glm: {
    // 源四色（深→浅）：#221F28 #777181 #547FE4 #ffffff
    light: {
      pageBackground: "#ffffff",
      panelBackground: "#ffffff",
      panelBorder: "#ffffff",
      panelHighlight: "#ffffff",
      panelShadow: "#646269",
      textPrimary: "#221F28",
      textSecondary: "#858489",
      accent: "#547FE4",
      controlBackground: "#ffffff",
      controlBorder: "#a7a3ad",
      controlText: "#221F28",
      chartText: "#858489",
    },
    dark: {
      pageBackground: "#221F28",
      panelBackground: "#484450",
      panelBorder: "#484450",
      panelHighlight: "#435da2",
      panelShadow: "#09080a",
      textPrimary: "#ffffff",
      textSecondary: "#9c9a9e",
      accent: "#698ee7",
      controlBackground: "#484450",
      controlBorder: "#34416a",
      controlText: "#ffffff",
      chartText: "#9c9a9e",
    },
  },

  gemini: {
    // 源四色（深→浅）：#322b5a #6e71c4 #DC97F8 #FBEBEC
    light: {
      pageBackground: "#FBEBEC",
      panelBackground: "#fdf5f6",
      panelBorder: "#fdf5f6",
      panelHighlight: "#fefcfc",
      panelShadow: "#6e6586",
      textPrimary: "#322b5a",
      textSecondary: "#8c819c",
      accent: "#DC97F8",
      controlBackground: "#fdf5f6",
      controlBorder: "#9f9cd2",
      controlText: "#322b5a",
      chartText: "#8c819c",
    },
    dark: {
      pageBackground: "#322b5a",
      panelBackground: "#4d4b8a",
      panelBorder: "#4d4b8a",
      panelHighlight: "#a171c1",
      panelShadow: "#0d0b17",
      textPrimary: "#FBEBEC",
      textSecondary: "#a195aa",
      accent: "#e0a3f9",
      controlBackground: "#4d4b8a",
      controlBorder: "#6e5191",
      controlText: "#FBEBEC",
      chartText: "#a195aa",
    },
  },

  deepseek: {
    // 源四色（深→浅）：#354b7e #7279ac #88a4dd #f5f5fa
    light: {
      pageBackground: "#eeeefb",
      panelBackground: "#e9edfb",
      panelBorder: "#e9edfb",
      panelHighlight: "#ededf7",
      panelShadow: "#6f7ea3",
      textPrimary: "#354b7e",
      textSecondary: "#344360",
      accent: "#6990dd",
      controlBackground: "#fafafd",
      controlBorder: "#a0a4c7",
      controlText: "#354b7e",
      chartText: "#8b98b6",
    },
    dark: {
      pageBackground: "#354b7e",
      panelBackground: "#506093",
      panelBorder: "#444c9c",
      panelHighlight: "#6b85bc",
      panelShadow: "#0d1320",
      textPrimary: "#f5f5fa",
      textSecondary: "#9fa9c2",
      accent: "#8eb1f5",
      controlBackground: "#506093",
      controlBorder: "#526a9f",
      controlText: "#f5f5fa",
      chartText: "#9fa9c2",
    },
  },

  kimi: {
    // 源四色（深→浅）：#000000 #636080 #737d87 #e8ebf7
    light: {
      pageBackground: "#e8ebf7",
      panelBackground: "#f4f5fb",
      panelBorder: "#fcf8f9",
      panelHighlight: "#fbfcfe",
      panelShadow: "#46474a",
      textPrimary: "#000000",
      textSecondary: "#686a6f",
      accent: "#636080",
      controlBackground: "#f4f5fb",
      controlBorder: "#9291aa",
      controlText: "#000000",
      chartText: "#686a6f",
    },
    dark: {
      pageBackground: "#000000",
      panelBackground: "#2d2b3a",
      panelBorder: "#454357",
      panelHighlight: "#4b5158",
      panelShadow: "#000000",
      textPrimary: "#e8ebf7",
      textSecondary: "#808188",
      accent: "#76738f",
      controlBackground: "#2d2b3a",
      controlBorder: "#282c2f",
      controlText: "#e8ebf7",
      chartText: "#808188",
    },
  },

  qwen: {
    // 源四色（深→浅）：#23203c #877ad6 #898ECB #faf3fb
    light: {
      pageBackground: "#faf3fb",
      panelBackground: "#fdf9fd",
      panelBorder: "#fefafa",
      panelHighlight: "#fefdfe",
      panelShadow: "#645f75",
      textPrimary: "#23203c",
      textSecondary: "#847f92",
      accent: "#877ad6",
      controlBackground: "#fdf9fd",
      controlBorder: "#afa4e3",
      controlText: "#23203c",
      chartText: "#847f92",
    },
    dark: {
      pageBackground: "#23203c",
      panelBackground: "#504981",
      panelBorder: "#47476e",
      panelHighlight: "#656899",
      panelShadow: "#09080f",
      textPrimary: "#faf3fb",
      textSecondary: "#9994a5",
      accent: "#958adb",
      controlBackground: "#504981",
      controlBorder: "#47476e",
      controlText: "#faf3fb",
      chartText: "#9994a5",
    },
  },

  grok: {
    // 源四色（深→浅）：#2e242e #651535 #f7e25f #FEFEFE
    light: {
      pageBackground: "#FEFEFE",
      panelBackground: "#ae9e9e",
      panelBorder: "#ae9e9e",
      panelHighlight: "#ffffff",
      panelShadow: "#6c656c",
      textPrimary: "#2e242e",
      textSecondary: "#514d4d",
      accent: "#dbc84d",
      controlBackground: "#828282",
      controlBorder: "#ae9e9e",
      controlText: "#2e242e",
      chartText: "#514d4d",
    },
    dark: {
      pageBackground: "#2e242e",
      panelBackground: "#471d31",
      panelBorder: "#341b28",
      panelHighlight: "#a69959",
      panelShadow: "#0c090c",
      textPrimary: "#FEFEFE",
      textSecondary: "#a09ca0",
      accent: "#f8e572",
      controlBackground: "#471d31",
      controlBorder: "#74673f",
      controlText: "#FEFEFE",
      chartText: "#a09ca0",
    },
  },

  muse: {
    // 源四色（深→浅）：#38343D #575d66 #4687EE #daeafb
    light: {
      pageBackground: "#daeafb",
      panelBackground: "#edf5fd",
      panelBorder: "#edf5fd",
      panelHighlight: "#f9fcfe",
      panelShadow: "#696b76",
      textPrimary: "#38343D",
      textSecondary: "#818693",
      accent: "#4687EE",
      controlBackground: "#edf5fd",
      controlBorder: "#858e9a",
      controlText: "#38343D",
      chartText: "#818693",
    },
    dark: {
      pageBackground: "#38343D",
      panelBackground: "#46464f",
      panelBorder: "#46464f",
      panelHighlight: "#416ab0",
      panelShadow: "#0e0d0f",
      textPrimary: "#daeafb",
      textSecondary: "#9198a6",
      accent: "#5c95f0",
      controlBackground: "#46464f",
      controlBorder: "#3d517b",
      controlText: "#daeafb",
      chartText: "#9198a6",
    },
  },

  mimo: {
    // 源四色（深→浅）：#332B2A #828C9E #FF8D3F #fdf6f2
    light: {
      pageBackground: "#fdf6f2",
      panelBackground: "#fefbf9",
      panelBorder: "#fefbf9",
      panelHighlight: "#fffefd",
      panelShadow: "#706866",
      textPrimary: "#332B2A",
      textSecondary: "#8e8684",
      accent: "#FF8D3F",
      controlBackground: "#fefbf9",
      controlBorder: "#adb1bb",
      controlText: "#332B2A",
      chartText: "#8e8684",
    },
    dark: {
      pageBackground: "#332B2A",
      panelBackground: "#57575e",
      panelBorder: "#57575e",
      panelHighlight: "#b86b38",
      panelShadow: "#0d0b0b",
      textPrimary: "#fdf6f2",
      textSecondary: "#a29b98",
      accent: "#ff9b56",
      controlBackground: "#57575e",
      controlBorder: "#7a4d31",
      controlText: "#fdf6f2",
      chartText: "#a29b98",
    },
  },
};

/** 仅用于让类型信息在纯 JS 项目里可被引用；无运行时作用。 */
export const SKIN_PALETTE_DOCS = Object.freeze({
  /** @type {PaletteTokens} */ example: {},
});

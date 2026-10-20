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
      pageBackground: "#F1EEFC",
      panelBackground: "#FAF9FF",
      panelBorder: "#EBEAF0",
      panelHighlight: "#FEFEFF",
      panelShadow: "#BCBAC4",
      textPrimary: "#15131B",
      textSecondary: "#3A3742",
      accent: "#50578E",
      controlBackground: "#FAF9FF",
      controlBorder: "#EBEAF0",
      controlText: "#15131B",
      chartText: "#504E59",
    },
    dark: {
      pageBackground: "#18161F",
      panelBackground: "#222127",
      panelBorder: "#2B2B2F",
      panelHighlight: "#353538",
      panelShadow: "#020204",
      textPrimary: "#EFEDFA",
      textSecondary: "#B7B5C2",
      accent: "#A9B2F1",
      controlBackground: "#222127",
      controlBorder: "#2B2B2F",
      controlText: "#EFEDFA",
      chartText: "#B7B5C2",
    },
  },

  claude: {
    // 源四色（深→浅）：#292020 #9e6c57 #d26e46 #efd6cc
    light: {
      pageBackground: "#FDEDE2",
      panelBackground: "#FFF9F5",
      panelBorder: "#F0EAE6",
      panelHighlight: "#FFFEFE",
      panelShadow: "#C5BAB2",
      textPrimary: "#191310",
      textSecondary: "#403732",
      accent: "#9A3D12",
      controlBackground: "#FFF9F5",
      controlBorder: "#F0EAE6",
      controlText: "#191310",
      chartText: "#584D46",
    },
    dark: {
      pageBackground: "#1F140D",
      panelBackground: "#27201C",
      panelBorder: "#2F2A27",
      panelHighlight: "#383533",
      panelShadow: "#040100",
      textPrimary: "#F9ECE4",
      textSecondary: "#C1B4AC",
      accent: "#FF9971",
      controlBackground: "#27201C",
      controlBorder: "#2F2A27",
      controlText: "#F9ECE4",
      chartText: "#C1B4AC",
    },
  },

  glm: {
    // 源四色（深→浅）：#221F28 #777181 #547FE4 #ffffff
    light: {
      pageBackground: "#E6E8EC",
      panelBackground: "#F1F2F4",
      panelBorder: "#E2E3E4",
      panelHighlight: "#FAFAFB",
      panelShadow: "#B3B4B7",
      textPrimary: "#0F1013",
      textSecondary: "#343536",
      accent: "#224BC1",
      controlBackground: "#F1F2F4",
      controlBorder: "#E2E3E4",
      controlText: "#0F1013",
      chartText: "#4E4F53",
    },
    dark: {
      pageBackground: "#151619",
      panelBackground: "#202022",
      panelBorder: "#2A2A2B",
      panelHighlight: "#343435",
      panelShadow: "#010202",
      textPrimary: "#EDEEF3",
      textSecondary: "#B5B7BB",
      accent: "#94B6FF",
      controlBackground: "#202022",
      controlBorder: "#2A2A2B",
      controlText: "#EDEEF3",
      chartText: "#B5B7BB",
    },
  },

  gemini: {
    // 源四色（深→浅）：#322b5a #6e71c4 #DC97F8 #FBEBEC
    light: {
      pageBackground: "#FFF3FA",
      panelBackground: "#FFFEFF",
      panelBorder: "#F3EEF1",
      panelHighlight: "#FFFEFF",
      panelShadow: "#C9BFC5",
      textPrimary: "#1C1519",
      textSecondary: "#433940",
      accent: "#82459A",
      controlBackground: "#FFFEFF",
      controlBorder: "#F3EEF1",
      controlText: "#1C1519",
      chartText: "#574C53",
    },
    dark: {
      pageBackground: "#1F161C",
      panelBackground: "#282226",
      panelBorder: "#312C2F",
      panelHighlight: "#3A3739",
      panelShadow: "#050204",
      textPrimary: "#F8EAF2",
      textSecondary: "#BFB3BB",
      accent: "#DB99F5",
      controlBackground: "#282226",
      controlBorder: "#312C2F",
      controlText: "#F8EAF2",
      chartText: "#BFB3BB",
    },
  },

  deepseek: {
    // 源四色（深→浅）：#354b7e #7279ac #88a4dd #f5f5fa
    light: {
      pageBackground: "#E2ECFC",
      panelBackground: "#F0F6FF",
      panelBorder: "#E2E6ED",
      panelHighlight: "#FCFDFF",
      panelShadow: "#B0B8C4",
      textPrimary: "#121212",
      textSecondary: "#313740",
      accent: "#3252AD",
      controlBackground: "#F0F6FF",
      controlBorder: "#E2E6ED",
      controlText: "#121212",
      chartText: "#4A505A",
    },
    dark: {
      pageBackground: "#141B26",
      panelBackground: "#21252D",
      panelBorder: "#2C2F34",
      panelHighlight: "#37393D",
      panelShadow: "#010308",
      textPrimary: "#E8EFFB",
      textSecondary: "#B0B8C3",
      accent: "#96B6FF",
      controlBackground: "#21252D",
      controlBorder: "#2C2F34",
      controlText: "#E8EFFB",
      chartText: "#B0B8C3",
    },
  },

  kimi: {
    // 源四色（深→浅）：#000000 #636080 #737d87 #e8ebf7
    light: {
      pageBackground: "#F0FAF3",
      panelBackground: "#FDFFFD",
      panelBorder: "#EDF0EE",
      panelHighlight: "#FDFFFD",
      panelShadow: "#BEC4C0",
      textPrimary: "#171717",
      textSecondary: "#3C3C3C",
      accent: "#3F6659",
      controlBackground: "#FDFFFD",
      controlBorder: "#EDF0EE",
      controlText: "#171717",
      chartText: "#4A524C",
    },
    dark: {
      pageBackground: "#0C120E",
      panelBackground: "#181C19",
      panelBorder: "#222523",
      panelHighlight: "#2C2E2D",
      panelShadow: "#000100",
      textPrimary: "#E8F2EB",
      textSecondary: "#B1BAB3",
      accent: "#6CCDAE",
      controlBackground: "#181C19",
      controlBorder: "#222523",
      controlText: "#E8F2EB",
      chartText: "#B1BAB3",
    },
  },

  qwen: {
    // 源四色（深→浅）：#23203c #877ad6 #898ECB #faf3fb
    light: {
      pageBackground: "#E6F7F9",
      panelBackground: "#FAFEFF",
      panelBorder: "#E9F0F1",
      panelHighlight: "#FDFFFF",
      panelShadow: "#B6C2C3",
      textPrimary: "#0F1718",
      textSecondary: "#3A3A3A",
      accent: "#2E656C",
      controlBackground: "#FAFEFF",
      controlBorder: "#E9F0F1",
      controlText: "#0F1718",
      chartText: "#445354",
    },
    dark: {
      pageBackground: "#0B1719",
      panelBackground: "#192122",
      panelBorder: "#252A2A",
      panelHighlight: "#303334",
      panelShadow: "#000202",
      textPrimary: "#E2F2F4",
      textSecondary: "#ABBBBC",
      accent: "#43CCDE",
      controlBackground: "#192122",
      controlBorder: "#252A2A",
      controlText: "#E2F2F4",
      chartText: "#ABBBBC",
    },
  },

  grok: {
    // 源四色（深→浅）：#2e242e #651535 #f7e25f #FEFEFE
    light: {
      pageBackground: "#F2EADD",
      panelBackground: "#F9F4EC",
      panelBorder: "#E9E6E0",
      panelHighlight: "#FFFDFA",
      panelShadow: "#BCB7AD",
      textPrimary: "#171109",
      textSecondary: "#383634",
      accent: "#5C5942",
      controlBackground: "#F9F4EC",
      controlBorder: "#E9E6E0",
      controlText: "#171109",
      chartText: "#554F45",
    },
    dark: {
      pageBackground: "#1D170E",
      panelBackground: "#26221C",
      panelBorder: "#2F2C28",
      panelHighlight: "#383634",
      panelShadow: "#040200",
      textPrimary: "#F5EEE2",
      textSecondary: "#BDB6AB",
      accent: "#CCB93E",
      controlBackground: "#26221C",
      controlBorder: "#2F2C28",
      controlText: "#F5EEE2",
      chartText: "#BDB6AB",
    },
  },

  muse: {
    // 源四色（深→浅）：#38343D #575d66 #4687EE #daeafb
    light: {
      pageBackground: "#EBF7FF",
      panelBackground: "#FEFEFF",
      panelBorder: "#E8F1F6",
      panelHighlight: "#FEFEFF",
      panelShadow: "#B4C4CE",
      textPrimary: "#13171A",
      textSecondary: "#373C40",
      accent: "#1759BD",
      controlBackground: "#FEFEFF",
      controlBorder: "#E8F1F6",
      controlText: "#13171A",
      chartText: "#465158",
    },
    dark: {
      pageBackground: "#010F18",
      panelBackground: "#0F191E",
      panelBorder: "#1B2125",
      panelHighlight: "#272B2D",
      panelShadow: "#000001",
      textPrimary: "#E4F1F9",
      textSecondary: "#ADB9C1",
      accent: "#8CB9FF",
      controlBackground: "#0F191E",
      controlBorder: "#1B2125",
      controlText: "#E4F1F9",
      chartText: "#ADB9C1",
    },
  },

  mimo: {
    // 源四色（深→浅）：#332B2A #828C9E #FF8D3F #fdf6f2
    light: {
      pageBackground: "#F6F0EF",
      panelBackground: "#FEFBFA",
      panelBorder: "#EEECEB",
      panelHighlight: "#FFFEFE",
      panelShadow: "#C0BDBB",
      textPrimary: "#181413",
      textSecondary: "#3B3939",
      accent: "#9C3D00",
      controlBackground: "#FEFBFA",
      controlBorder: "#EEECEB",
      controlText: "#181413",
      chartText: "#534F4D",
    },
    dark: {
      pageBackground: "#191514",
      panelBackground: "#22201F",
      panelBorder: "#2B2A29",
      panelHighlight: "#353433",
      panelShadow: "#020201",
      textPrimary: "#F2EDEC",
      textSecondary: "#BBB6B4",
      accent: "#FF996C",
      controlBackground: "#22201F",
      controlBorder: "#2B2A29",
      controlText: "#F2EDEC",
      chartText: "#BBB6B4",
    },
  },
};

/** 仅用于让类型信息在纯 JS 项目里可被引用；无运行时作用。 */
export const SKIN_PALETTE_DOCS = Object.freeze({
  /** @type {PaletteTokens} */ example: {},
});

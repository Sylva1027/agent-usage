# Agent Usage

简体中文 · [English](README.en.md)

把 Codex、ZCode、DSH、OpenCode、Claude Code 和 WorkBuddy 的用量汇总到一个本地看板，查看 Token、缓存命中、模型使用与费用趋势。

当前版本：[0.85a](https://github.com/Sylva1027/agent-usage/releases/tag/0.85a)。

![DeepSeek 浅色皮肤看板，示例数据](docs/images/dashboard-deepseek-light.png)

## 快速开始

推荐安装 **Node.js 26 LTS**（最低要求 23.8）。打开 [官方下载页](https://nodejs.org/en/download)，选择 26 LTS 和你的系统：Windows 下载 `.msi`、macOS 下载 `.pkg`，按默认选项安装；Linux 按页面命令安装。重新打开终端，运行 `node -v` 确认版本。

下载 [普通版](https://github.com/Sylva1027/agent-usage/releases/download/0.85a/0.85a.zip) 或 [waifu 版](https://github.com/Sylva1027/agent-usage/releases/download/0.85a/0.85a-waifu.zip)，解压后在该目录打开终端，运行：

```bash
node src/cli.js run
```

也可以从源码启动：

```bash
git clone https://github.com/Sylva1027/agent-usage.git
cd agent-usage
node src/cli.js run
```

打开 [http://127.0.0.1:3765/](http://127.0.0.1:3765/)，按 `Ctrl+C` 停止服务。

普通版提供简洁界面；waifu 版增加角色皮肤。两版统计功能相同，源码运行默认为 waifu 版。下方截图展示 waifu 版。

waifu 版部分角色形象来自 [ZipZipPipe](https://space.bilibili.com/4168597)，感谢其创作。

## 看板功能

- **时间趋势：** 按日、周、月或自定义日期查看用量，切换渠道、模型和费用视图。
- **Codex 额度：** 查看当前和上一轮 5 小时、每周额度窗口的用量。
- **用量明细：** 查看输入、输出和缓存命中，按模型、渠道或仓库搜索、排序。
- **周期对比：** 与上一周期比较，发现用量变化和新纪录。
- **来源管理：** 自动发现本机日志，也可导入其他目录；支持自动刷新和暂停。
- **语言与外观：** 中英文界面、深浅主题；waifu 版提供十款角色皮肤，可调整角色显示与透明度。

![界面风格选择器，十款皮肤与浅深配色预览](docs/images/skin-picker.png)

## 费用估算

按模型的 API 单价估算输入、输出和缓存费用，方便比较不同模型的使用成本。价目与汇率自动更新，也可以在看板中手动调整。

## 命令

```bash
node src/cli.js summary        # 终端汇总
node src/cli.js summary --json # JSON 输出
```

项目采用 [MIT License](LICENSE)。

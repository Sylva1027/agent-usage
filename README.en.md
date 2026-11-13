# Agent Usage

[简体中文](README.md) · English

A local dashboard for Codex, ZCode, DSH, OpenCode, Claude Code, and WorkBuddy. Track tokens, cache hits, model usage, and cost trends in one place.

Current release: [0.9](https://github.com/Sylva1027/agent-usage/releases/tag/0.9).

![DeepSeek light dashboard with sample data](docs/images/dashboard-deepseek-light.png)

## Quick Start

We recommend **Node.js 26 LTS** (minimum 23.8). Visit the [official download page](https://nodejs.org/en/download), choose 26 LTS and your system: install the `.msi` on Windows or `.pkg` on macOS with the default options; on Linux, follow the commands on that page. Reopen your terminal and run `node -v` to check the version.

Download [Standard](https://github.com/Sylva1027/agent-usage/releases/download/0.9/0.9.zip) or [Waifu](https://github.com/Sylva1027/agent-usage/releases/download/0.9/0.9-waifu.zip), extract it, open a terminal in that directory, and run:

```bash
node src/cli.js run
```

Or run from source:

```bash
git clone https://github.com/Sylva1027/agent-usage.git
cd agent-usage
node src/cli.js run
```

Open [http://127.0.0.1:3765/](http://127.0.0.1:3765/). Press `Ctrl+C` to stop the server.

Standard offers a simple interface; Waifu adds character skins. Both editions share the same statistics. Running from source defaults to Waifu, which is shown in the screenshots below.

Some character designs in Waifu come from [ZipZipPipe](https://space.bilibili.com/4168597). Thank you for your work.

## Dashboard

- **Time trends:** Explore daily, weekly, monthly, or custom ranges, with views by source, model, and cost.
- **Codex limits:** See usage in the current and previous five-hour and weekly allowance windows.
- **Usage details:** Inspect input, output, and cache hits; search and sort by model, source, or repository.
- **Period comparisons:** Compare with the preceding period to spot changes and new records.
- **Share images:** Select today, this week, or this month, then use the rightmost header button to create a 3:4 card. Choose two extra metrics, optionally show cost, and copy or save the PNG. Available in both Standard and Waifu, following the current theme.
- **Source management:** Automatically scan local logs and confirm before importing, with stages and elapsed time shown. Import other directories, refresh automatically, or pause.
- **Language and appearance:** Switch between Chinese and English or light and dark themes. Waifu adds ten character skins with visibility and opacity controls.

![Skin picker with ten skins and light/dark previews](docs/images/skin-picker.png)

## Cost Estimates

Estimate input, output, and cache costs using each model's API rates, displayed in USD or CNY. Prices and exchange rates update automatically and can also be edited manually.

## Commands

```bash
node src/cli.js summary        # Terminal summary
node src/cli.js summary --json # JSON output
```

Licensed under the [MIT License](LICENSE).

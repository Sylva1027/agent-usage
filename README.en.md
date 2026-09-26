# Agent Usage

[简体中文](README.md) · English

Agent Usage is a local dashboard for Codex and ZCode usage. It reads existing session and usage records to show tokens, cache hits, sessions, and estimated API equivalent costs by time, source, model, and repository. Your logs stay on your computer.

This project builds on [DhWU-coder/codex-usage](https://github.com/DhWU-coder/codex-usage).

## Quick Start

Requires **Node.js 22.13 or later**; check with `node -v`. Download and extract the repository ZIP, or run:

```bash
git clone https://github.com/Sylva1027/codex-usage.git
cd codex-usage
node src/cli.js run
```

Open [http://127.0.0.1:3765/](http://127.0.0.1:3765/). The server binds to `127.0.0.1` by default. Press `Ctrl+C` to stop it. No npm dependencies need to be installed. On Windows PowerShell, the `node` command above also avoids `npm.ps1` execution policy errors.

## Dashboard

- **Time and Trends:** Explore Today, This Week, This Month, All Time, custom dates, and hourly, daily, weekly, or monthly timelines. This Week follows the calendar week.
- **Recent Ranges:** Last 5h and Last Week select the previous completed Codex five-hour and weekly limit reset windows. Last Month is the previous full calendar month; This Year runs from January 1 through today. Last Week here is a limit window, not a calendar week.
- **Codex Limits:** The `5h / Week` control switches between the current five-hour and weekly limit windows. Boundaries come from local Codex limit observations; the five-hour chart uses 30-minute slots and the weekly chart uses consecutive 24-hour slots. The dashboard does not guess missing boundaries. With no Codex source selected, the limit control and the Last 5h and Last Week options are disabled.
- **Usage and Costs:** Inspect Total Input, Cache Hit, Cache Miss, Output, Reasoning Tokens, and Cache Hit Rate. Compare usage by source, model, and Git repository; search and sort the details. Cache-hit and cache-miss input use separate pricing rates.
- **Records and Comparisons:** Applicable ranges can highlight new highs and compare them with a preceding period. All Time has no preceding period and shows no New Record badges.
- **Sources and Refresh:** Codex and ZCode data are discovered locally. You can import another Codex or ZCode directory, or a project with `.codex-usage/usage.jsonl`. Choose which sources count in the Edit dialog. The page checks for new records every 60 seconds by default; pausing auto refresh keeps the data snapshot fixed while you change ranges.
- **Language and Theme:** The **文/A** button beside the theme control switches between Simplified Chinese and English. The first visit follows your browser's preferred language, and a manual choice is remembered. Light and dark themes are available.

## Data Sources and Privacy

Codex usage comes from session logs in Codex homes such as `~/.codex`. ZCode usage comes from `~/.zcode/cli/db/db.sqlite` by default. Agent Usage opens that database read-only and does not modify it. Requests absent from these records or an imported project log do not appear in the dashboard.

- `CODEX_USAGE_ZCODE_HOMES`: Add ZCode data directories. Separate paths with the system path separator (`;` on Windows, `:` on macOS/Linux).
- `CODEX_USAGE_ZCODE=0`: Disable the ZCode source.

An incremental SQLite index stays on your computer at `~/.codex-usage/usage-index.sqlite` by default. Subsequent scans process only changed files.

## Cost Estimates

The dashboard estimates **API equivalent costs, not actual bills or subscription limit charges**. You can inspect and edit model rates in the dashboard. Pricing distinguishes cache-miss input, cache-hit input, cache writes, and output, plus long-context and Fast/Priority rates where applicable. When a record lacks required details, the page identifies tokens estimated at the lowest applicable rate and tokens that cannot be priced.

Built-in rates are based on public provider information: [OpenAI](https://developers.openai.com/api/docs/pricing), [StepFun](https://platform.stepfun.com/docs/zh/guides/pricing/details), [MiMo](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go), [DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/), [Kimi](https://platform.kimi.com/docs/pricing/chat), [GLM](https://bigmodel.cn/pricing), [xAI](https://docs.x.ai/developers/pricing), [Qwen](https://www.qwencloud.com/pricing/api), [Gemini](https://ai.google.dev/gemini-api/docs/pricing), [MiniMax](https://platform.minimax.io/docs/guides/pricing-paygo), and [Meta](https://dev.meta.ai/docs/pricing-rate-limits). Amounts retain each model's pricing currency (USD or CNY). Mixed-currency totals appear side by side; charts use an adjustable exchange rate for comparison. Rates and discounts can change, so check the provider's current terms before relying on an estimate.

## Commands and Static Snapshot

```bash
node src/cli.js summary       # Terminal summary
node src/cli.js summary --json
node src/static-export.js     # Export standalone HTML
node --test                   # Run tests
```

The snapshot is written to `dist/codex-usage.html`. You can open it directly and switch languages. It retains the usage data and limit observations from export time and does not refresh; export again to include new records. The HTML embeds usage data and may contain local paths. Inspect it before sharing.

Licensed under the [MIT License](LICENSE).

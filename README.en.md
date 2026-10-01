# Agent Usage

[简体中文](README.md) · English

Agent Usage is a local dashboard for Codex, ZCode, DSH, and OpenCode usage. It reads existing session and usage records to show tokens, cache hits, sessions, and estimated API equivalent costs by time, source, model, and repository. Your logs stay on your computer.

This project builds on [DhWU-coder/codex-usage](https://github.com/DhWU-coder/codex-usage).

Current release: [v0.5.0](https://github.com/Sylva1027/codex-usage/releases/tag/v0.5.0).

## Quick Start

Requires **Node.js 23.8 or later**; check with `node -v`. Download and extract the repository ZIP, or run:

```bash
git clone https://github.com/Sylva1027/codex-usage.git
cd codex-usage
node src/cli.js run
```

Open [http://127.0.0.1:3765/](http://127.0.0.1:3765/). The server binds to `127.0.0.1` by default. Press `Ctrl+C` to stop it. No npm dependencies need to be installed. On Windows PowerShell, the `node` command above also avoids `npm.ps1` execution policy errors.

## Dashboard

- **Time and Trends:** Explore Today, This Week, This Month, All Time, custom dates, and recent ranges. View the timeline by source, model, or estimated cost. Longer All Time, custom, and recent ranges automatically merge daily bars into weekly or monthly bars; the subtitle and tooltips show the grouping and covered dates. This Week follows the calendar week.
- **Recent Ranges:** Last 5h and Last Week select the previous completed Codex five-hour and weekly limit reset windows. Last Month is the previous full calendar month; This Year runs from January 1 through today. Last Week here is a limit window, not a calendar week.
- **Codex Limits:** The `5h / week` control switches between the current five-hour and weekly limit windows. These limit ranges, Last 5h, and Last Week count Codex sources only; ordinary ranges such as Today, This Week, and This Month still count all selected sources. Boundaries come from local Codex limit observations; the five-hour chart uses 30-minute slots and the weekly chart uses consecutive 24-hour slots. The dashboard does not guess missing boundaries. With no Codex source selected, the limit control and the corresponding recent range options are disabled.
- **Usage and Costs:** Inspect Total Input, Cache Hit, Cache Miss, Output, Reasoning Tokens, and Cache Hit Rate. Compare usage by source, model, and Git repository; search and sort the details. Model names appear in lowercase in the interface, while aggregation and pricing retain their original model keys. Cache-hit and cache-miss input use separate pricing rates. Ordinary ranges group subagents and execution channels under Codex, ZCode, DSH, and OpenCode; Codex-only limit ranges retain channel detail. Local Git repositories appear first, followed by the selected period sort.
- **Records and Comparisons:** Applicable ranges can highlight new highs and compare them with a preceding period. All Time has no preceding period and shows no New Record badges.
- **Sources and Refresh:** Codex, ZCode, DSH, and OpenCode data are discovered locally. You can import another Codex, ZCode, or DSH directory, an OpenCode data directory, or a project with `.codex-usage/usage.jsonl`. Choose which sources count in the Edit dialog. Add sources through Scan Directories. The page checks for new records every 60 seconds by default, showing a spinner beside the switch during checks; pausing auto refresh keeps the data snapshot fixed while you change ranges.
- **Language and Theme:** The **文/A** button beside the theme control switches between Simplified Chinese and English. The first visit follows your browser's preferred language, and a manual choice is remembered. Light and dark themes are available.

## Data Sources and Privacy

Codex usage comes from session logs in homes such as `~/.codex`; ZCode defaults to `~/.zcode/cli/db/db.sqlite`; DSH (DeepSeek Harness) uses `~/.dsh/sessions`; OpenCode uses `opencode*.db` in its data directory, such as `~/.local/share/opencode`. Requests absent from these records or an imported project log do not appear in the dashboard.

Adapters extract usage and necessary metadata without including message content in statistical events. SQLite databases are opened read-only first; the current fallback uses a regular open and can trigger recovery or auxiliary file operations. The app does not intentionally rewrite upstream business records. See the [data-source reference](docs/10-data-sources.md) for formats, imports, and read boundaries.

- `CODEX_USAGE_ZCODE_HOMES`: Add ZCode data directories. Separate paths with the system path separator (`;` on Windows, `:` on macOS/Linux).
- `CODEX_USAGE_ZCODE=0`: Disable automatic ZCode discovery.
- `CODEX_USAGE_DSH_HOMES`: Add DSH data directories, using the same path separator.
- `CODEX_USAGE_DSH=0`: Disable automatic DSH discovery.
- `CODEX_USAGE_OPENCODE_HOMES`: Add OpenCode data directories, using the same path separator.
- `CODEX_USAGE_OPENCODE=0`: Disable automatic OpenCode discovery.

Codex, ZCode, DSH, and OpenCode all count toward ordinary ranges. The **5-hour and weekly limit windows measure Codex usage only**; the other sources have no limit records and never take part in them.

An incremental SQLite index stays on your computer at `~/.codex-usage/usage-index.sqlite` by default. Subsequent scans process only changed files.

## Cost Estimates

The dashboard estimates **API equivalent costs, not actual bills or subscription limit charges**. You can inspect and edit model rates in the dashboard. Pricing distinguishes cache-miss input, cache-hit input, cache writes, and output, plus long-context and Fast/Priority rates where applicable. When a record lacks required details, the page identifies tokens estimated at the lowest applicable rate and tokens that cannot be priced.

The local dashboard checks public model rates and USD/CNY exchange rates, normally every 24 hours, retrying an hour after a failure. Existing sources include Models.dev, LiteLLM, and official StepFun, MiMo, Kimi, and GLM pages. New model discovery currently requires complete evidence for an OpenAI USD text model. Models in Use includes only models seen within the last rolling calendar month; older models remain available under All Models for historical pricing. Missing models remain visible; uncatalogued `-free` models use the free rule, while other missing rates retain minimum-estimate labels.

Automatic results live in `~/.codex-usage/pricing-auto.json`; manual changes live in `~/.codex-usage/pricing.json` and take precedence. Offline use falls back to cached or built-in values. Public price requests do not upload local usage or model names. Amounts retain their original currency, with an adjustable rate for mixed-currency charts. See the [pricing reference](docs/11-pricing.md) for matching, source limits, and overrides. Provider rates can change; verify the source links in the active catalog.

## Commands and Static Snapshot

```bash
node src/cli.js summary       # Terminal summary
node src/cli.js summary --json
node src/static-export.js     # Export standalone HTML
node --test                   # Run tests
```

The snapshot is written to `dist/codex-usage.html`. You can open it directly and switch languages. It retains the usage data and limit observations from export time and does not refresh; export again to include new records. The HTML embeds usage data and may contain local paths. Inspect it before sharing.

## Documentation and Development

- [Documentation index](docs/00-index.md): roadmap, tasks, current references, validation, and archives.
- [Dashboard behavior](docs/12-dashboard.md): ranges, sorting, refresh, dialogs, languages, and themes.
- [Project-log integration](docs/14-project-log.md): produce importable records using real token usage.
- [Development and handoff](docs/03-development.md): code locations, environment, and checks.

Detailed references are maintained in Simplified Chinese. Licensed under the [MIT License](LICENSE).

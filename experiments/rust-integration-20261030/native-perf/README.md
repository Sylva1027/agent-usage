# native-perf

Native implementation of the `summarizePerf` aggregation tail. The Node adapter
remains authoritative for selection, deduplication, range/date filtering, sample
flags, sampled/rank admission, missing-duration admission, and dropped reasons.

The binary reads one NDJSON stream, retains only compact numeric vectors and
aggregate state, and writes the same `{groups, models, coverage,
codexTimingCoverage, meta}` JSON object as `src/perf-stats.js`.

## Build

Run from this directory:

```powershell
$repoRoot = (Resolve-Path '..\..\..').Path
$env:CARGO_TARGET_DIR = Join-Path $repoRoot '.codex-usage\rust-integration-20261030\perf-target'
cargo build --release --offline
```

The binary is:

```text
.codex-usage/rust-integration-20261030/perf-target/release/native-perf.exe
```

## CLI

```powershell
native-perf.exe --input PATH [--pid-file PATH]
```

`--input` is required. `--pid-file` is optional; when supplied, the process
writes its current process id before opening the input so an external memory
sampler can include short-lived runs.

The first input line is the JS-supplied configuration. Every later non-empty
line is one compact sample object. The current adapter may also include
`status`; when present, `status === "in_progress"` determines pending coverage.
If `status` is absent, an eligible row with `sampled=false` and
`droppedReason=null` is treated as pending.

## Behavior

- `groups` use `sampled`; `models` numeric buckets use `modelSampled`.
- `codexTimingCoverage.counts` uses `codexCurrent`; the token sums iterate
  eligible current Codex rows in input order.
- Coverage breakdowns retain eligible and unplaced diagnostics. `byEra` is
  emitted only for an eligible single-source Codex bucket.
- Missing-duration model candidates are hidden when a numeric model bucket with
  the same `modelKey` exists.
- Exact nearest-rank quantiles, JS safe-integer overflow, and raw unrounded
  floating-point arithmetic follow `src/perf-stats.js`.
- All stable string ordering uses UTF-16 code units, including map keys, group
  keys, model keys, and source warnings.
- Existing source warnings are sorted, then one `AGGREGATE_OVERFLOW` warning is
  added for each overflowing group.

## Local verification

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Resolve-Path '..\..\..').Path '.codex-usage\rust-integration-20261030\perf-target'
cargo test --offline --all-targets
$rustBin = Join-Path $env:CARGO_TARGET_DIR 'debug\native-perf.exe'
node tests/js-fixture-parity.mjs tests/fixtures/small.ndjson $rustBin
```

The Rust integration fixture covers pending/drop/coverage counts, era splits,
unplaced diagnostics, rank admission, overflow, missing-duration hiding,
warning ordering, and pid-file creation. The Node parity script compares the
same fixture against the authoritative JS `summarizePerf`.

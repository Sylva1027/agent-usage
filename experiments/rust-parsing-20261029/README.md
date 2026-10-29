# Rust DSH parsing experiment

This isolated experiment compares the frozen Node
`streamDshSessionRows` reader with a Rust release implementation. It does not
change production code.

## R2 result

The parser-only comparison now separates decompression plus complete JSON
parsing from the recursive semantic digest. Across all 160 real DSH files, the
three-run warm medians were:

| Mode | Node wall | Rust wall | Node / Rust | Decompressed throughput, Node / Rust |
| --- | ---: | ---: | ---: | ---: |
| Parser-only, 160 files | 4,310.09 ms | 2,898.53 ms | 1.49x | 138.50 / 205.94 MiB/s |
| Full semantic digest, 160 files | 13,990.16 ms | 3,779.64 ms | 3.70x | 42.67 / 157.93 MiB/s |
| Parser-only, actual max file | 403.00 ms | 341.55 ms | 1.18x | - |
| Full semantic digest, actual max file | 1,138.67 ms | 394.98 ms | 2.88x | - |

Both modes really decompress every frame and parse every non-empty record.
Parser-only reads the top-level `type`, `time`, `usage`, `stream`, and header
fields needed for its aggregates. Rust sends every parsed
`serde_json::Value` through `std::hint::black_box`; it does not hash or recurse
through the complete stream value. Semantic mode retains the R1 ordered
SHA-256 projection and remains the independent correctness oracle.

On this corpus the parser-only saving was 1,411.57 ms (32.75%) over the full
160 files, while the maximum-file saving was only 61.45 ms (15.25%). The full
semantic result removes another 9,680.07 ms from Node and 881.12 ms from Rust.
The R1 3.9x therefore describes the measured full semantic digest benchmark,
not pure parsing, the production DSH reader, or the whole project.

## Warm and first-round timings

These are complete child-process wall times in milliseconds. OS caches were not
cleared. The first round is reported separately; warm values are medians of
three alternating Node/Rust pairs.

| Workload | First Node | First Rust | Warm Node | Warm Rust | Warm ratio |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parser-only, 160 files | 4,507.83 | 2,893.81 | 4,310.09 | 2,898.53 | 1.49x |
| Parser-only, max file | 405.81 | 327.48 | 403.00 | 341.55 | 1.18x |
| Semantic digest, 160 files | 13,670.31 | 3,660.59 | 13,990.16 | 3,779.64 | 3.70x |
| Semantic digest, max file | 1,087.83 | 372.98 | 1,138.67 | 394.98 | 2.88x |

Using the timers emitted inside each process, the 160-file warm ratios were
1.48x for parser-only and 3.72x for the semantic digest. Wall time is the
reported benchmark number because it includes process startup, module loading,
stdout serialization, and process teardown.

## Memory

Values below are warm medians of sampled whole-process peak working set and
private bytes. They are not JavaScript heap size.

| Mode and workload | Node working set | Rust working set | Node private | Rust private |
| --- | ---: | ---: | ---: | ---: |
| Parser-only, 160 files | 173.02 MiB | 48.20 MiB | 165.68 MiB | 54.27 MiB |
| Parser-only, max file | 118.43 MiB | 20.65 MiB | 114.39 MiB | 16.71 MiB |
| Semantic digest, 160 files | 168.83 MiB | 48.70 MiB | 171.82 MiB | 55.52 MiB |
| Semantic digest, max file | 113.71 MiB | 20.88 MiB | 106.32 MiB | 17.05 MiB |

Process startup was also measured independently:

| Configuration | Warm wall | Working set | Private bytes |
| --- | ---: | ---: | ---: |
| Node, formal V8 limits | 68.50 ms | 55.34 MiB | 8.87 MiB |
| Node, default V8 | 62.56 ms | 63.57 MiB | 19.27 MiB |
| Rust release | 42.38 ms | 3.06 MiB | 0.45 MiB |

## Formal and default V8

The formal Node runs used the production calculation limits:

```text
--max-old-space-size=224 --max-semi-space-size=4
```

R1 did not use these flags. R2 measured the difference on the same source and
corpus:

| Mode | Formal wall | Default-V8 wall | Default delta | Formal WS/private | Default WS/private |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parser-only | 4,310.09 ms | 4,195.65 ms | -2.66% | 173.02 / 165.68 MiB | 244.84 / 243.71 MiB |
| Semantic digest | 13,990.16 ms | 13,364.53 ms | -4.47% | 168.83 / 171.82 MiB | 291.61 / 284.90 MiB |

The limits lowered peak working set substantially in this run and were slightly
slower. The time differences are smaller than some run-to-run variation, so the
result does not establish a reliable speed penalty.

## Node reader shape

Node parser-only uses the real `async function* streamDshSessionRows` and a
`for await` consumer. Its timing includes `yield`/resume and async-generator
scheduling. Rust consumes the same frame and line semantics in a synchronous
loop. That architectural overhead is part of the measured Node baseline; this
experiment does not include a yield-stripped Node control, so the 1.49x result
cannot isolate how much belongs to JSON parsing and how much belongs to the
async reader shape.

## Node calling the Rust helper

The helper path starts a Node process, starts Rust as a child, waits for the
full JSON result on stdout, parses it in Node, and emits a wrapper JSON object.
The table uses full-process wall time and sampled process-tree memory.

| Mode | Direct Rust | Node plus helper | Added wall | JSON stdout | Tree peak WS/private |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parser-only | 2,898.53 ms | 2,936.21 ms | +37.68 ms, +1.30% | 58,590 B | 111.43 / 75.18 MiB |
| Semantic digest | 3,779.64 ms | 3,579.76 ms | -199.88 ms | 70,770 B | 110.84 / 73.31 MiB |

The semantic helper median is lower than the separately measured direct-Rust
median because run-to-run Rust spread overlaps the wrapper cost; it is not
evidence of negative overhead. R1 measured the semantic helper at +139.05 ms
over direct Rust. Parser-only gives a clean small positive wrapper result in R2.
The helper child's warm medians were 49.27 MiB working set / 57.29 MiB private
for parser-only and 48.78 / 55.41 MiB for semantic mode.

## Inputs and equivalence

- Frozen Node source:
  `C:\Users\Silver\AppData\Local\Temp\codex-local-summary-FvxvXj\endurance\source\src\dsh-usage.js`
- Source SHA-256:
  `fb68ed271387d075241c1e2632b4638f567d5c74a09c2c21b285d033393c0fd4`
- DSH root:
  `C:\Users\Silver\AppData\Local\Temp\codex-local-summary-FvxvXj\inputs\home\.dsh\sessions`
- 160 files, 158,939,249 compressed bytes, 625,922,807 decompressed bytes.
- 77,862 frames and no failed frames in the frozen real input.
- 153,348 parsed records and 23,557 usage records.
- Parser aggregates: 3,277,184,482 input tokens, 3,178,535,211 cached
  tokens, 0 cache-write tokens, 22,738,850 output tokens, and 3,299,923,332
  mapped total tokens.

The largest actual file is 13,114,066 compressed / 53,927,502 decompressed
bytes. The task's 10.8 MB reference file remains recorded in R1 at
10,806,901 compressed / 35,268,817 decompressed bytes.

Every real file matched between Node and Rust for paths, compressed bytes,
record counts, usage counts, nonzero usage events, stream item counts, header
counts, warnings, and parser token aggregates. Semantic mode additionally
matched every per-file digest. R2 semantic output also matched all 160 R1 file
digests and counts exactly.

The synthetic fixture exercises cross-frame UTF-8 replacement, corrupt and
empty frames, malformed JSON, usage, header, title, and stream fields. Both
modes match Node and Rust:

- 6 parsed records and 3 usage records.
- Semantic digest:
  `68c411e7b9a0ad2288cba12f133a3375d6bdd563adae7d5eb9e9d73d3205d331`.
- Warning order remains corrupt/empty frames first, then malformed JSON.

## Source selection and reproduction

`node-baseline.mjs` supports both modes. Its default source is repository
`src/dsh-usage.js`; `DSH_SOURCE_PATH` overrides the default, and `--source`
overrides both. The benchmark passes the frozen source explicitly.

```powershell
$env:DSH_SOURCE_PATH = 'C:\path\to\dsh-usage.js'
node experiments\rust-parsing-20261029\node-baseline.mjs `
  --mode parser --source 'C:\path\to\dsh-usage.js' --root 'C:\path\to\sessions'

pwsh -NoProfile -File experiments\rust-parsing-20261029\benchmark.ps1
pwsh -NoProfile -File experiments\rust-parsing-20261029\summarize-results.ps1 `
  -ResultsPath output\rust-parsing-20261029\results-r2.json `
  -SummaryPath output\rust-parsing-20261029\summary-r2.json
```

R2 raw and summarized results are in `output/rust-parsing-20261029/`:
`results-r2.json`, `summary-r2.json`, `input-scan-r2.json`, and `raw-r2/`.
R1's `results.json`, `summary.json`, `input-scan.json`, and `raw/` remain
unchanged.

## zstd dependency

The Cargo cache contained `serde_json 1.0.138` but no `zstd` crate. Rust calls
the local zstd C API through `raw-dylib`:

- Version: `1.5.7`
- DLL:
  `C:\Users\Silver\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\zstd.dll`
- Size: 673,072 bytes
- SHA-256:
  `24BFECB651F4FA23E69A929ACFE3DFF9587621BCF50CB137BDFC8EA3D349933A`

No network access was used.

## Limits

- One Windows machine, one Node/V8 and Rust toolchain pair, and one frozen real
  corpus.
- Three warm pairs per parser/semantic workload; individual samples remain in
  `results-r2.json`.
- Memory was sampled every 2 ms. Process-tree totals add shared working-set
  pages from Node and Rust.
- Node async-generator overhead is included but not decomposed.
- The helper sends a 160-file summary and parses it in Node. A production API
  with a different response shape changes this cost.
- The experiment covers DSH decompression, JSON parsing, selected fields, and
  optional semantic digestion. It does not measure the other five source kinds,
  pricing, rollups, SQLite work, report generation, or production integration.
- The result does not justify claiming 3.9x, 3.70x, or 1.49x for the whole
  project.

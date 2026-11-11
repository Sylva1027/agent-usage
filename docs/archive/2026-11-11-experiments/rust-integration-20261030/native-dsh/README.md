# native-dsh

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../../README.md)。

`dsh-rust-helper.exe` is the frozen R1 helper behind
`streamDshRustRows()`. It reads a DSH session, decompresses every zstd frame,
parses JSON, emits the compact fields used by the existing Node event and TPS
consumers, and reports frame/JSON warnings. The Node adapter remains
responsible for request serialization, consumer backpressure, and warning
callbacks.

The parser projection and adapter are frozen. The final helper also writes
`RUST_DSH_PID_FILE`, when set, immediately on startup so the experiment can
retire the helper PID after its Node owner exits. This changes no parsed output.

## Offline helper build

Run from the repository root with PowerShell 7. The helper is compiled
directly with `rustc`; Cargo is used only to prepare the frozen
`serde_json 1.0.138` rlibs in the isolated target directory.

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'E:\12 AI\ccusage\codex-usage'
$repoRoot = (Resolve-Path '.').Path
$depsTarget = Join-Path $repoRoot '.codex-usage\rust-integration-20261030\rust-target\deps-build'

$env:CARGO_TARGET_DIR = $depsTarget
cargo build `
  --manifest-path (Join-Path $repoRoot 'experiments\rust-parsing-20261029\Cargo.toml') `
  --release `
  --offline `
  --locked
if ($LASTEXITCODE -ne 0) { throw "cargo build failed: $LASTEXITCODE" }

$deps = Join-Path $depsTarget 'release\deps'
$serde = (Get-ChildItem -LiteralPath $deps -Filter 'libserde_json*.rlib' |
  Select-Object -First 1).FullName
$out = Join-Path $repoRoot '.codex-usage\rust-integration-20261030\rust-target\release'
New-Item -ItemType Directory -Force -Path $out | Out-Null

rustc `
  --edition=2024 `
  --crate-name dsh_rust_helper `
  --crate-type bin `
  -O `
  -L "dependency=$deps" `
  --extern "serde_json=$serde" `
  (Join-Path $repoRoot 'experiments\rust-integration-20261030\native-dsh\dsh-rust-helper.rs') `
  -o (Join-Path $out 'dsh-rust-helper.exe')
if ($LASTEXITCODE -ne 0) { throw "rustc failed: $LASTEXITCODE" }
```

The successful R1 build resolved:

```text
serde rlib:
E:\12 AI\ccusage\codex-usage\.codex-usage\rust-integration-20261030\rust-target\deps-build\release\deps\libserde_json-7a29fc21d9b3887f.rlib
```

That rlib came from the locked, offline Cargo build of
`experiments/rust-parsing-20261029/Cargo.toml` shown above. The helper source
uses `serde_json 1.0.138`.

## zstd dependency

Rust calls the local zstd C API through `#[link(name = "zstd", kind =
"raw-dylib")]`. The DLL is copied from the local Codex primary runtime:

```text
Source:
C:\Users\Silver\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\zstd.dll

Version: 1.5.7
Size: 673,072 bytes
SHA-256: 24BFECB651F4FA23E69A929ACFE3DFF9587621BCF50CB137BDFC8EA3D349933A
```

Place it beside the helper:

```powershell
$zstdSource = 'C:\Users\Silver\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\zstd.dll'
$zstdTarget = Join-Path $out 'zstd.dll'
Copy-Item -LiteralPath $zstdSource -Destination $zstdTarget -Force
$zstdHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zstdTarget).Hash
if ($zstdHash -ne '24BFECB651F4FA23E69A929ACFE3DFF9587621BCF50CB137BDFC8EA3D349933A') {
  throw "unexpected zstd.dll hash: $zstdHash"
}
```

The frozen helper binary produced by this build has SHA-256:

```text
C41C247404E85DD3C09C29E9C9DEBDC8608074C3913F0AE6091DEA7AA793F9DC
```

## Candidate DSH injection

`dsh-build.mjs` reproduces the existing candidate integration from the frozen
baseline. It reads only `baseline/src/dsh-usage.js` and writes only
`candidate/src/dsh-usage.js`; it does not copy the candidate tree or touch any
other candidate file.

Run the read-only comparison while a matrix is active:

```powershell
node experiments/rust-integration-20261030/dsh-build.mjs --check
```

The write mode is:

```powershell
node experiments/rust-integration-20261030/dsh-build.mjs
```

The script requires each source anchor to occur exactly once. It removes the
Node zstd reader and installs this exact path:

```js
export async function* streamDshSessionRows(filePath, { onWarning } = {}) {
  const physicalPath = globalThis.__localSummaryPhysical?.(filePath) ?? filePath;
  yield* streamDshRustRows(physicalPath, { displayPath: filePath, onWarning });
}
```

`physicalPath` is the path the Rust filesystem call opens. `displayPath`
remains the logical path, so frame and malformed-JSON warnings retain the
production-visible path after the hook maps a logical path to a temporary
physical copy. The static check also verifies that the frozen adapter still
accepts `displayPath` and sends both paths in its request.

## IPC boundary

- One helper is reused per calculation process.
- Requests are serialized.
- Rows arrive as NDJSON batches with at most 64 rows.
- stdout pauses after each message and resumes as the consumer advances.
- Batch and warning payloads contain projected rows only; body, stream text,
  and tool argument text do not cross IPC.

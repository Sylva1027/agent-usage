# B2 growth diagnostic: source, facts, and dashboard

Status: complete. The final eight-case matrix passed under the unchanged 224 MiB old-space / 4 MiB semi-space limits. The previously reproduced 10x Codex E full-replacement OOM is retained as before/after evidence; the same-process full replacement passed after Main moved replacement-fact diffing to bounded temporary SQLite storage. The matrix predates Main's final initial-import ctime race guard; the post-measurement delta and bounded C: facade smoke are documented below.

## Scope

This card measures one vertical path at 1x and 10x for the largest frozen Codex and DSH `usage-file` sources:

`usage file -> UsageStore.sync() -> source progress/proof -> SQLite facts -> dashboardHistory(today/all)`

It does not measure the complete six-source dashboard score owned by Main. It does not change source discovery, store contracts, parser behavior, native proof code, tests, or journal configuration.

The fixture starts with one selected source under a synthetic home:

- Codex: `.codex/sessions/fixture/<source>.jsonl`
- DSH: `.dsh/sessions/fixture/<session>/session.v4.jsonl.zstd`

The frozen source itself is never appended, replaced, or otherwise modified. The diagnostic copies its unchanged bytes to a private fixture, then appends only semantically known synthetic records.

## Frozen sources

| Scale | Kind | Source bytes | Rows | Events | SHA-256 |
| --- | --- | ---: | ---: | ---: | --- |
| 1x | Codex | 202,242,135 | 37,205 | 4,240 | `68d6b88fc4229ff17a87b2d11251d98391c054fa02b33e7edb8eb7a60bc5a638` |
| 1x | DSH | 17,996,994 | 11,206 | 1,131 | `36426a8ff20d252d3cf2a8164d1c3aa5e1294844fcb9674cf97d2b08dbd432a9` |
| 10x | Codex | 2,022,421,350 | 372,050 | 42,400 | `203ff824eecbe23643c7dd56c536ae29a99934013b227e387a550f178ffe7523` |
| 10x | DSH | 179,935,645 | 112,060 | 11,310 | `9c8ead05e2e00e29d183a4c51fa8f97cde7fcef789a5220a86e6bfb416e6e2c4` |

The diagnostic streams SHA-256 over each original before and after the matrix and asserts both the dataset size and digest.

## Cases

The eight sequential cases are:

```text
1x-codex-C   1x-codex-E   1x-dsh-C   1x-dsh-E
10x-codex-C  10x-codex-E  10x-dsh-C  10x-dsh-E
```

C cases use a unique strict child of the real `%LOCALAPPDATA%\Temp\codex-b2-growth-*`. E cases use a private strict child of this card's ignored output.

Each worker is launched with the unchanged limits:

```text
node --max-old-space-size=224 --max-semi-space-size=4 \
  experiments/architecture-20261101/b2-growth-diagnostic.mjs --worker <config>
```

No heap increase or extra runtime dependency is used.

Each passing case performs:

1. A full parse and durable checkpoint.
2. Three newline/frame appends with known Codex cumulative usage or DSH per-request usage.
3. `store.sync()` after every append.
4. Both `dashboardHistory({preset:"all"})` and `dashboardHistory({preset:"today"})`.
5. Exact expected-total and event-count increments.
6. A fresh full-replacement oracle over the final source.
7. Field-by-field fact comparison excluding only `events.id`.
8. `PRAGMA quick_check` on both databases.

The E cases additionally force one `appendFile()=>null` replacement in the same worker and store instance after the three appends. This is the real replacement path that normal recovery takes. It is explicitly not a saved pre-B1 control, and moving only the control to another process is not accepted as a fix.

## Source proof expectations

For normal post-fix increments:

- C active-journal native proof: `validation.kind === "ntfs-usn-v1"`, `parsedBytes === suffixBytes`, `prefixBytesRead === 0`, and `journalBytes > 0`.
- E inactive-journal fallback: `validation.kind === "sha256-prefix-v1"`, `parsedBytes === suffixBytes`, `journalBytes === 0`, and `prefixBytesRead === 2 * oldPrefixBytes + suffixBytes`. The factor of two is the required post-fix old-prefix recheck across verify and capture.

The probe records Node `fs` physical identity at the copied fixture and around every append. dev, inode, and birth time must stay constant; ctime/mtime/size advancement is retained as evidence. This directly covers the physical-identity fields being added by Main.

## Appended facts

Codex appends one complete `event_msg/token_count` JSON line. It reads the saved checkpoint's cumulative state and supplies a larger cumulative usage plus a matching exact increment.

DSH appends one complete zstd frame containing a request header and one `assistant/message` row. Its input, cached, output, and total fields are fixed per case and compared with dashboard deltas.

Before and after every sync, the diagnostic streams a hash of the entire original prefix and requires exactly the initial frozen source digest. No 2 GB file is loaded with `readFile`; copies and hashes are streamed.

## Resource accounting

Sync and dashboard calls record wall time, worker CPU, heap/RSS/external bytes, and Node's lifetime maximum RSS. A bounded `pwsh` 7 sampler walks only the worker's process tree at 50 ms intervals and records:

- simultaneous service-tree working-set peak
- worker lifetime working-set peak
- native helper lifetime working-set peak
- sampled per-process CPU
- observed process count and exit

The sampler excludes itself. Worker teardown closes the store and native helper; the parent records sampler exit and does not launch descendants beyond the one current case worker.

## Capacity repair before and after

After Main landed and validated the verify-to-capture repair, a new full matrix was run as `growth-incremental-2026-11-03T064156807Z`. Seven cases completed.

The `10x-codex-E` case completed the initial parse and all three normal appends:

- initial: 42,400 events, full SHA validation
- append 1: 41 tokens, `parsedBytes=357`, `prefixBytesRead=4,044,843,057`
- append 2: 42 tokens, `parsedBytes=357`, `prefixBytesRead=4,044,843,771`
- append 3: 43 tokens, `parsedBytes=359`, `prefixBytesRead=4,044,844,487`

The actual same-process replacement after those appends then terminated with exit code 134 and `FATAL ERROR: Reached heap limit Allocation failed`. V8 reported `223.5 (226.9) -> 223.5 (225.4) MB` against the unchanged 224 MiB old-space limit. The failure occurred after the third append completed and before `full-control-finished`. The runner now emits narrower append/sync phase markers for the next stable run.

This reproduced the production-relevant issue: a real old-prefix revision on the largest E fallback source could not complete full replacement under the required heap. A fresh-database oracle could parse the same source because it did not hold the existing old fact arrays during replacement, so that path did not remove or explain away the capacity failure.

After Main replaced the in-memory old-fact multiset and current counts with bounded temporary SQLite storage, the focused `growth-confirm-20261103T065127837Z` run passed. It kept one worker and one store open across:

1. Initial full SHA parse: 6.227 s.
2. Three normal appends: 3.159 s, 3.259 s, 3.620 s.
3. Real same-process `appendFile()=>null` full replacement: 16.311 s.
4. Final fresh-database oracle and exact fact comparison.

The replacement parsed all 2,022,422,782 bytes and advanced `all` from 636,126 to 636,170 and `today` from 126 to 170. All three fact tables had zero side-only rows and identical hashes; `quick_check=ok`. Worker lifetime maximum reported RSS was 171.23 MiB, and cleanup completed.

The pre-fix OOM run remains untouched for direct comparison.

## Failure and cleanup policy

Failed runs retain their fixture and case JSON with the case label. Successful C and E fixture roots are removed only after an absolute-path containment check. Original frozen sources are rehashed after the matrix.

## Final matrix

Final run:

```text
node experiments/architecture-20261101/b2-growth-diagnostic.mjs
```

Exact result directory:

```text
output/architecture-20261103/b2/growth-incremental-2026-11-03T065324386Z
```

The parent launched each worker as:

```text
node --max-old-space-size=224 --max-semi-space-size=4 \
  experiments/architecture-20261101/b2-growth-diagnostic.mjs --worker <config>
```

Environment and identity:

- `DESKTOP-D61AMRC\Silver`, `Administrator=false`
- PowerShell 7.6.5, Node.js 24.19.0
- real `LOCALAPPDATA=C:\Users\Silver\AppData\Local`
- C: active journal; E: SHA fallback with no journal bytes
- no UAC elevation and no journal configuration changes

All eight cases passed:

| Case | Initial events | Initial all total | Facts diff | Quick check | Worker CPU ms | Worker lifetime max RSS MiB | Helper peak MiB | Service-tree peak MiB |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1x-codex-C | 4,240 | 63,600 | 0 | ok | 4,671 | 172.38 | 9.07 | 182.82 |
| 1x-codex-E | 4,240 | 63,600 | 0 | ok | 8,203 | 161.57 | 8.93 | 157.79 |
| 1x-dsh-C | 1,131 | 16,965 | 0 | ok | 2,562 | 126.32 | 8.99 | 136.64 |
| 1x-dsh-E | 1,131 | 16,965 | 0 | ok | 3,765 | 119.17 | 8.93 | 139.66 |
| 10x-codex-C | 42,400 | 636,000 | 0 | ok | 38,733 | 161.24 | 9.07 | 177.89 |
| 10x-codex-E | 42,400 | 636,000 | 0 | ok | 75,452 | 171.59 | 8.89 | 190.70 |
| 10x-dsh-C | 11,310 | 169,650 | 0 | ok | 20,124 | 189.36 | 9.00 | 190.90 |
| 10x-dsh-E | 11,310 | 169,650 | 0 | ok | 33,531 | 194.64 | 8.93 | 183.32 |

The sampled service-tree peaks include the native helper where present. Both C and E cases show helper processes because the proof bridge can be launched before E discovers that its journal is unavailable; E has no journal byte coverage and validates through SHA.

### Source work

| Case | Append parsed bytes | Append prefix bytes | Append journal bytes | Control parsed / prefix / journal |
| --- | --- | --- | --- | --- |
| 1x-codex-C | 357 / 357 / 359 | 0 / 0 / 0 | 1,872 / 1,152 / 1,632 | n/a |
| 1x-codex-E | 357 / 357 / 359 | 404,484,627 / 404,485,341 / 404,486,057 | 0 / 0 / 0 | 202,243,567 / 202,243,567 / 0 |
| 1x-dsh-C | 201 / 201 / 201 | 0 / 0 / 0 | 1,392 / 1,152 / 1,152 | n/a |
| 1x-dsh-E | 201 / 201 / 201 | 35,994,189 / 35,994,591 / 35,994,993 | 0 / 0 / 0 | 17,997,799 / 17,997,799 / 0 |
| 10x-codex-C | 357 / 357 / 359 | 0 / 0 / 0 | 6,352 / 9,792 / 22,272 | n/a |
| 10x-codex-E | 357 / 357 / 359 | 4,044,843,057 / 4,044,843,771 / 4,044,844,487 | 0 / 0 / 0 | 2,022,422,782 / 2,022,422,782 / 0 |
| 10x-dsh-C | 201 / 201 / 201 | 0 / 0 / 0 | 17,072 / 4,352 / 1,472 | n/a |
| 10x-dsh-E | 201 / 201 / 201 | 359,871,491 / 359,871,893 / 359,872,295 | 0 / 0 / 0 | 179,936,450 / 179,936,450 / 0 |

Every C normal append reported native proof, exact suffix parse, zero prefix bytes, non-zero journal bytes, and `ntfs-usn-v1`. Every E normal append reported exact suffix parse plus `2 * oldPrefix + suffix` prefix reads, zero journal bytes, and `sha256-prefix-v1`.

### Dashboard and sync time

Times below are one deterministic local sample in seconds, not a benchmark distribution. Dashboard sequences include the initial call plus each append and, for E, the full control.

| Case | Initial sync | Three append syncs | Full control sync | `all` dashboard sequence | `today` dashboard sequence |
| --- | ---: | --- | ---: | --- | --- |
| 1x-codex-C | 0.593 | 0.020 / 0.019 / 0.020 | n/a | 0.070 / 0.060 / 0.053 / 0.060 | 0.111 / 0.011 / 0.010 / 0.010 |
| 1x-codex-E | 0.730 | 0.325 / 0.339 / 0.332 | 1.445 | 0.072 / 0.054 / 0.059 / 0.054 / 0.074 | 0.120 / 0.012 / 0.012 / 0.011 / 0.157 |
| 1x-dsh-C | 0.816 | 0.012 / 0.014 / 0.011 | n/a | 0.024 / 0.022 / 0.020 / 0.019 | 0.069 / 0.007 / 0.007 / 0.006 |
| 1x-dsh-E | 0.814 | 0.041 / 0.040 / 0.038 | 0.861 | 0.024 / 0.023 / 0.020 / 0.019 / 0.018 | 0.070 / 0.006 / 0.005 / 0.006 / 0.091 |
| 10x-codex-C | 4.712 | 0.033 / 0.034 / 0.041 | n/a | 0.516 / 0.401 / 0.432 / 0.410 | 0.505 / 0.054 / 0.058 / 0.056 |
| 10x-codex-E | 6.227 | 3.165 / 3.152 / 3.155 | 16.358 | 0.546 / 0.468 / 0.413 / 0.428 / 0.710 | 0.519 / 0.072 / 0.061 / 0.058 / 0.890 |
| 10x-dsh-C | 7.505 | 0.017 / 0.018 / 0.019 | n/a | 0.088 / 0.151 / 0.135 / 0.122 | 0.173 / 0.019 / 0.019 / 0.019 |
| 10x-dsh-E | 7.157 | 0.296 / 0.295 / 0.300 | 9.884 | 0.090 / 0.139 / 0.134 / 0.135 / 0.125 | 0.173 / 0.020 / 0.019 / 0.019 / 0.262 |

CPU is worker lifetime CPU. It includes the diagnostic's full correctness oracles, streamed source and prefix hashing, dashboard calls, and fixture setup in addition to sync work. It therefore cannot be used as production append CPU or to calculate a production append CPU ratio. Helper CPU samples were generally below the 50 ms sampler's useful resolution (0 to 0.0625 s); the meaningful helper result is its bounded working set, about 8.9 to 9.1 MiB.

### Correctness checks

For every case:

- All expected Codex and DSH deltas matched both dashboard scopes.
- Every appended event count advanced by exactly one.
- The original source prefix SHA stayed equal to the frozen SHA after every append.
- dev, inode, and birth time stayed fixed; ctime, mtime, and size advanced.
- `events` excluding `id`, `rate_limit_observations`, and `quota_usage_sources` had zero rows unique to either side and identical SHA-256 hashes against a fresh full oracle.
- Both databases returned `quick_check=ok`.
- The four frozen source hashes matched before and after the matrix.
- Successful fixtures were removed after path containment checks.

Exact per-case, per-step metrics are in:

```text
output/architecture-20261103/b2/growth-incremental-2026-11-03T065324386Z/growth-final-summary.json
```

## Post-measurement race-guard delta

The eight-case timing and fact matrix above was measured before Main's final initial-import race guard. This later guard changes no parsing, accounting, dashboard, or append-evidence calculation. It closes the no-saved-checkpoint window in which a source could be rewritten during parsing and have its mtime restored:

- The expected discovery snapshot now includes `ctimeMs` as well as size and mtime in `assertExpected`.
- The end of `replaceFile` rechecks both `ctimeMs` and physical identity (device, inode, and birth time) after parsing.

The post-measurement `src/usage-store.js` SHA-256 observed for this closeout is `0363ab3a3b84ca03bf55d88f2f291ed45f5e7dd3ba6e9b6bafb7841527006235`, replacing the pre-guard S1 hash `b5fd6722ffd798a37a0c978774523cab02b2a7f986505af8b843bdb4458ec980`. The matrix was not rerun because the guard adds fail-closed snapshot comparisons without changing the measured computation; the matrix remains an explicitly pre-guard measurement.

A bounded post-measurement facade smoke checked the guard's filesystem assumption. On a 64 KiB synthetic C: fixture, `UsageSourceProof.begin()` followed by an unchanged `capture()` returned native proof with zero read bytes and left size, mtime, `ctimeMs`, birth time, physical identity, and SHA-256 contents exactly unchanged. The same assertions passed both inside the sandbox and outside it under the ordinary Medium-integrity token (`S-1-16-8192`). The C: fixture was removed after an absolute-path containment check. Evidence:

```text
output/architecture-20261103/b2/growth-ctime-seal-smoke-20261103070659879.json
output/architecture-20261103/b2/growth-ctime-seal-smoke-outside-20261103070722636.json
```

This smoke confirms that the read-only seal operations used by the facade do not themselves trip the new `ctimeMs` guard for this tested C: fixture. It is not a full rerun of the timing matrix or a universal filesystem claim.

## Smallest safe path and fallback

The smallest observed source-work path is active C: with `ntfs-usn-v1`: exact suffix parse, zero prefix bytes. On active C:, the tested Codex `sync()` source-processing times were 19 to 41 ms, and the tested DSH `sync()` source-processing times were 11 to 19 ms (minimum 11 ms). These are source-sync timings only: they exclude `dashboardHistory()` and are not end-to-end source-to-dashboard latency.

When the volume journal is inactive, `sha256-prefix-v1` remains exact but reads the old prefix twice plus the suffix. At 10x Codex E that was 4.04 GB per append and 3.15 to 3.16 s in this run. It is bounded and independent of journal activity, but it is linear in source size.

When exact append evidence is unavailable, full replacement reparses the complete source. The final bounded implementation completed the formerly fatal 10x Codex E case, but at 16.36 s for 2.02 GB and with materially higher work than the native path. Safe failure remains preferable to accepting an unproven prefix or an incomplete journal range.

## Limits of this evidence

- Each cell is one deterministic local run, not a distribution or production SLO.
- Only one selected source is present per synthetic home; this is not the complete six-source page result.
- C journal activity and helper residency are sampled at 50 ms, so peaks are lower-bound observations.
- The E cost shown here includes the required double-prefix verification; it is not constant-size work.
- The experiment did not force journal wrap, corrupt records, concurrent writers, source replacement during sync, or high unrelated-volume activity. Those unsafe cases must continue to fall back or fail closed.
- The successful full replacement applies to these fixtures and the bounded implementation tested here; it is not a universal capacity guarantee for larger or more complex sources.

## Excluded and retained runs

The following runs must not be used as final measurements:

- initial partial matrix `growth-incremental-2026-11-03T063341057Z`
- full pre-fix matrix `growth-incremental-2026-11-03T063523891Z`
- stable-repair capacity baseline `growth-incremental-2026-11-03T064156807Z`, retained because it is the actual 10x Codex E full-replacement OOM
- pre-fix smoke directories `growth-smoke-20261103T0632*`, `growth-smoke-20261103T0633*`, and `growth-smoke-20261103T0638*`
- isolated-control smoke directories `growth-smoke-20261103T0646*`; these are attribution experiments only and are not accepted as a replacement fix

They remain ignored output for audit only.

## Final result

The final matrix passed all eight cases in 159 seconds. C delivers bounded native append evidence with zero prefix reads on the active journal. E delivers exact append evidence through SHA prefix rereads with no journal dependency. The E full replacement remains linear in source bytes and is materially slower, but the previously fatal 10x Codex case now completes under the unchanged heap.

This experiment establishes behavior for these frozen, synthetic, single-source fixtures only. It does not establish a universal throughput claim, constant-size work, or safety on arbitrary volume activity. It also does not replace Main's complete six-source dashboard measurement.

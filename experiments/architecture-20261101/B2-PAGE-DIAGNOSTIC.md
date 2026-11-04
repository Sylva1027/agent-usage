# B2 page diagnostic: source landing to painted refresh

Status: the correctness path passed at 1x and 10x. The original page reached the exact expected totals through SSE, a closed-SSE polling recovery, and frozen/auto-resume behavior, and fresh full-parser oracles matched all three fact tables. The one-second refresh target was not met, and the 10x cold run exceeded the 512 MiB service-tree RSS target.

The final evidence is split deliberately:

- `page-e1-final-v8` contains the valid 1x cold/import/append run and the valid 10x cold/import plus six automatic appends. The overall label is failed only because its closed-SSE poll exceeded the then-current 75-second harness window.
- `page-e1-final-v10-continuation` reuses the v8 10x home and database without another empty-database import. It completes the remaining closed-SSE recovery, frozen/auto-resume check, page paint, final all-scope read, and fresh full-parser oracle.

No failed directory was removed or relabeled.

## Scope and isolation

The diagnostic exercises:

```text
frozen fixture -> isolated home mirror -> private UsageStore sync
  -> original Chromium page -> exact API value -> painted value
  -> closed-SSE poll -> frozen/resume -> full-parser facts oracle
```

It uses the frozen `growth-baseline/{1x,10x}/dataset.json` sources without modifying them. Unchanged files in the private home mirror may be hardlinks. The largest Codex and DSH sources and the configuration files are independent `copyFile` copies before any append. No real source, database, import store, pricing file, or user service is touched.

The server uses only the private output home/database/import/pricing files. Automatic discovery and pricing scheduling are disabled. The limits remain:

```text
gateway:  NODE_GATEWAY_HEAP_MB=512
executor: EXECUTOR_HEAP_MB=224
```

The page test waits for the exact `/api/usage` response, then for the exact displayed total and two `requestAnimationFrame` callbacks. API-only completion or spinner disappearance is not accepted. Failed `/api/usage-events` requests are treated as expected only when the page instrumentation records an explicit `EventSource.close()`; other request or connection errors remain failures.

## Preparation and cold landing

Mirror preparation is outside the refresh measurements. Empty-database landing and import are also reported separately so they are not presented as cached refresh speed.

| Run | Page ready | First `all` data | Total | Events | Cache | Sampled service RSS peak |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| v8 1x cold | 59.423 s | 2.974 s | 2,196,180 | 146,412 | miss | 331,259,904 B / 315.9 MiB |
| v8 10x cold | 444.534 s | 18.079 s | 21,961,800 | 1,464,120 | miss | 469,069,824 B / 447.3 MiB during bootstrap |
| v10 10x reused home | 9.170 s page shell | 21.024 s | 21,971,500 | 1,464,127 | miss | 487,063,552 B / 464.5 MiB over the continuation run |

The 10x cold import took about 7.4 minutes. It remains preparation evidence and is not a refresh measurement. The continuation page shell opened from the existing database in 9.170 seconds, but the first full `all` data paint took 21.024 seconds.

All observed preset reads below reported the summary cache as `miss`. The first physical source-signature change rebuilt the persistent summary. The later physical-metadata fingerprint adjustment therefore requires one honest cache rebuild preparation; it does not turn the measured refreshes into warm-cache hits.

## Automatic append results

All six normal appends used the real page SSE path. Each response advanced the event count by one, returned the exact expected total, and painted that total.

| Kind and append | v8 1x wall | v8 10x wall | Result |
| --- | ---: | ---: | --- |
| Codex 1 | 7.693 s | 35.957 s | exact `/api/usage`, SSE, cache miss |
| Codex 2 | 7.426 s | 33.145 s | exact `/api/usage`, SSE, cache miss |
| Codex 3 | 7.158 s | 34.099 s | exact `/api/usage`, SSE, cache miss |
| DSH 1 | 4.236 s | 22.891 s | exact `/api/usage`, SSE, cache miss |
| DSH 2 | 3.933 s | 22.919 s | exact `/api/usage`, SSE, cache miss |
| DSH 3 | 3.977 s | 24.193 s | exact `/api/usage`, SSE, cache miss |

The stable 1x observations from usable earlier runs were Codex 4.725-5.223 seconds and DSH 3.534-3.666 seconds. The final v8 cold fixture was slower on both: Codex 7.158-7.693 seconds and DSH 3.933-4.236 seconds. These are original-page wall times from append through exact painted value. Every value is above the one-second target. G1 sync latency is not substituted for this number.

The v8 1x wall-time window overlapped the `full-tests-closure` run from 15:08:40 to 15:11:28. Its timings remain valid observed samples but are confounded and are not used to calculate a strict optimization ratio. The v8 10x ordinary append window, approximately 15:19-15:23, did not overlap that regression run.

Preset switching was exercised during collection:

| Run after three Codex appends | Today | Week | All |
| --- | --- | --- | --- |
| v8 1x | 3.783 s, 3,000 tokens / 3 events | 1.274 s, 3,000 / 3 | 2.818 s, 2,199,180 / 146,415 |
| v8 10x | 30.222 s, 3,000 / 3 | 7.926 s, 3,000 / 3 | 20.912 s, 21,964,800 / 1,464,123 |

`inputGrowthBytes` is only post-append file size minus pre-append file size. Across the seven v8 file updates it was 2,714 bytes at 10x. That figure is not a parser-read observation.

## Closed SSE and frozen page

At 1x, v8 closed the page EventSource, appended one Codex row without SSE notification, and recovered the expected 2,205,880 total through polling in 18.470 seconds.

At 10x, v8 had already reached 21,971,500 through the closed-SSE polling path when the harness failed at its 75-second `waitForResponse` window. This was a diagnostic timing failure, not evidence that the underlying sync had stalled: the cold page had much slower request completion, and the harness window began before the about 30-second sync/poll work completed.

The v10 continuation completed the same behavior on the existing 10x database:

- Reused page total/events: 21,971,500 / 1,464,127.
- Closed-SSE append expected total: 21,972,500.
- No SSE notification was observed.
- The exact total and painted value arrived after 70.721 seconds through polling, with cache `miss`.
- Auto-refresh was then disabled. A Codex append was written, and the page held 21,972,500 after the 1.5-second unchanged check and a frozen snapshot request.
- Explicit resume painted 21,973,500. The complete disable/append/resume scope took 56.943 seconds.
- Final page after the final `all` read: 21,973,500 tokens and 1,464,129 events.

The 70.721-second recovery is consistent with the 60-second status-poll interval plus request completion time. This report does not invent a separate request-start timestamp that the saved observation did not record.

## Facts oracle

The v10 oracle performed a fresh full sync into a new database over the already-appended 10x sources, then read `all` from that database.

| Check | Live page database | Fresh full oracle | Difference |
| --- | ---: | ---: | ---: |
| Total tokens | 21,973,500 | 21,973,500 | 0 |
| Events | 1,464,129 | 1,464,129 | 0 |
| `events` rows, excluding `id` | exact table comparison | exact table comparison | 0 |
| `rate_limit_observations` rows | exact table comparison | exact table comparison | 0 |
| `quota_usage_sources` rows | exact table comparison | exact table comparison | 0 |

The fresh oracle took 435.302 seconds. The live DB and oracle also had the same event, rate-limit, and quota-source table content after excluding only generated event IDs.

The oracle result's `cpuSeconds=0.062` is parent-runner coordination CPU. It is not child parser CPU and is not used here as production CPU.

Selected checkpoint rows end at actual EOF and use SHA fallback:

| Source | Adapter | Offset | Line | Validation |
| --- | --- | ---: | ---: | --- |
| Codex | `codex-jsonl` | 2,022,425,332 | 372,064 | `sha256-prefix-v1` with physical identity and `ctimeMs` |
| DSH | `dsh-v4-zstd` | 179,936,083 | 112,063 | `sha256-prefix-v1` with physical identity and `ctimeMs` |

Both frozen selected sources kept their original digest and byte count after the page work:

| Source | Bytes | SHA-256 |
| --- | ---: | --- |
| Codex 10x | 2,022,421,350 | `203ff824eecbe23643c7dd56c536ae29a99934013b227e387a550f178ffe7523` |
| DSH 10x | 179,935,645 | `9c8ead05e2e00e29d183a4c51fa8f97cde7fcef789a5220a86e6bfb416e6e2c4` |

## SHA fallback cost

The synthetic private fixture is on an inactive-journal volume, so the tested Codex and DSH appends use `sha256-prefix-v1`; this is a real fallback cost, not an active-journal optimization.

For the v10 closed-SSE Codex append, the theoretical proof-input contract was:

```text
2 * 2,022,424,194 old-prefix bytes + 569 suffix bytes
= 4,044,848,957 bytes
```

The v8 10x seven file updates had an `expectedProofBytesIfAppend` total of 17,258,995,076 bytes. This is the required double old-prefix check plus the suffix. It is not observed parser input and is not observed physical I/O. The latter is measured separately through the OS service-tree logical counters below.

## Resource result

The service-tree RSS target was missed at 10x.

| Run | Sampled process peak | Sampled RSS peak | 512 MiB target |
| --- | ---: | ---: | --- |
| v8 1x | 6 | 331,259,904 B / 315.9 MiB | pass |
| v8 10x cold/append | 6 | 601,354,240 B / 573.5 MiB | **miss by 64,483,328 B / 61.5 MiB** |
| v10 10x continuation | 6 | 487,063,552 B / 464.5 MiB | warm continuation only; does not erase the cold miss |

The v8 10x peak is raw sample 725 at `2026-11-03T15:24:08.4776921+08:00`. It falls after the six automatic appends while the page is waiting for closed-SSE polling recovery. Freeze had not started, so this is not a freeze executor overlap.

At that peak:

- gateway `node.exe`: 220,119,040 B
- executor `node.exe`: 350,978,048 B
- `windows-source-proof.exe`: 4,685,824 B
- three `conhost.exe` helpers: 25,571,328 B total

The bootstrap peak was lower at 469,069,824 B. A DSH append scope reached 575,733,760 B, still below the later recovery-wait peak. The result is reported as a real capacity miss, not hidden by heap non-OOM evidence or by the lower warm run.

The service-tree CPU and logical I/O totals include the gateway, executor, proof helper, and conhost processes. Browser, runner, and observer are separate sampler scopes. These are sampled deltas from raw samples, not production parser reads.

| Run | Samples | Sampled CPU | Logical read | Logical write |
| --- | ---: | ---: | ---: | ---: |
| v8 1x | 129 | 79.234 s | 20,178,143,048 B | 10,520,477,832 B |
| v8 10x | 732 | 705.094 s | 286,635,151,446 B | 119,935,791,192 B |
| v10 continuation | 199 | 148.172 s | 65,715,121,602 B | 7,093,541,145 B |

Selected 10x scopes show where the sampled work occurred:

| Scope | Wall | CPU | Logical read | Logical write | RSS peak |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold bootstrap | 444.534 s | 445.719 s | 171.461 GB | 105.918 GB | 447.3 MiB |
| Codex append 1 | 35.957 s | 31.391 s | 14.395 GB | 1.261 GB | 488.3 MiB |
| Codex append 2 | 33.145 s | 31.016 s | 14.632 GB | 1.274 GB | 507.6 MiB |
| Codex append 3 | 34.099 s | 30.766 s | 13.278 GB | 1.279 GB | 506.5 MiB |
| DSH append 1 | 22.891 s | 19.969 s | 7.600 GB | 1.006 GB | 515.8 MiB |
| DSH append 2 | 22.919 s | 21.031 s | 7.959 GB | 1.015 GB | 523.9 MiB |
| DSH append 3 | 24.193 s | 23.016 s | 9.328 GB | 1.027 GB | 549.1 MiB |
| v10 SSE-loss poll | 70.721 s | 30.984 s | 14.443 GB | 1.239 GB | 464.5 MiB |
| v10 frozen/resume | 56.943 s | 51.688 s | 23.413 GB | 2.419 GB | 457.7 MiB |

The sampler interval is about one second, so a scope can miss activity before its first sample or after its last sample.

The resource summary's `sqliteFiles.peakTotalBytes=0` is not a disk-usage result. The reused sampler scans `<scaleRoot>/state`; the actual isolated state is under `<scaleRoot>/.codex-usage`. The current post-run footprint is:

| Run | `.codex-usage` bytes | Database-family bytes |
| --- | ---: | ---: |
| v8 1x | 223,689,084 | 223,535,160 |
| v8 10x | 1,890,900,348 | 1,890,746,424 |

The peak disk footprint was not measured. This report makes no zero-disk or peak-disk claim.

## Shutdown and cleanup

- v8 1x server exited with code 0 and zero residual processes.
- v10 server exited with code 0.
- v10's immediate record checked 23 process instances and found zero residual processes.
- A delayed check of the v7 1x raw sample found all 46 recorded PIDs gone, exact creation-time matches gone, and no detected PID reuse. The earlier v7 failure was an immediate-assertion race, not retained evidence of a real leak.
- A delayed check of the v8 10x raw sample checked 42 recorded process instances and found zero residual processes.

## Validation self-checks

The saved raw evidence was rechecked without repeating a cold import:

```text
resource self-check, v8 1x:      129 samples, service process peak 6, RSS 331,259,904
resource self-check, v8 10x:     732 samples, service process peak 6, RSS 601,354,240
residual self-check, v7 1x:      46 checked, residual 0, PID reuse none
residual self-check, v8 10x:     42 checked, residual 0, PID reuse none
residual self-check, v10:        23 checked, residual 0, PID reuse none
oracle self-check, v10:          total 21,973,500, events 1,464,129
```

## Final source snapshot

The v10 result captured all production files before and after the measured continuation. The two snapshots were identical, and the current files still match:

| File | SHA-256 |
| --- | --- |
| `public/app.js` | `012100753a40a030fa0ac6a59eac1e6c4404a368a2cc6ef8c18eb2a1d75edd1f` |
| `public/timeline-utils.js` | `b9e3c30bea969427c45fae9593287122646309df19cc9b4fedee3b7fd1cdd33d` |
| `src/dsh-frame-progress.js` | `917b103d3e1f1a744777df0fc33846cc13d0286b316d4586e9998e992304be4e` |
| `src/dsh-usage.js` | `d7a7cdbb5d0c40663e08e11d1c995a7d545e8f8734750a54bcbf4a278748828d` |
| `src/server.js` | `d94e7346090c76c914da52121fdc93ef76ce770b7dfc378103e63c050eafe1bb` |
| `src/usage-core.js` | `9a84662c012c6038650bc2f2b92c5f23b64a80571a72dcb73b902ac4a85ac039` |
| `src/usage-executor.js` | `a25129b37540d71c5b1b71317f0f35700bd66ed21c2f2f6078158403fef9014b` |
| `src/usage-rollups.js` | `ccd30f2be58f7f86a1d6ac808539156d1c98074c5643b4071211d11c86e859e9` |
| `src/usage-source-native.js` | `1c029ddc1065df9044d7136a84d4f9f0eee63d6d2635deb5d836daaf0066db72` |
| `src/usage-source-proof.js` | `8adbf1375fef0bea382d213350c39dd11691c0d9a76af84225199a3539bc4943` |
| `src/usage-store.js` | `34d1be922495512d270cdc2302a9663c47657f87f1f49aa2099e3e9eba7d68bd` |
| `src/usage-summary-cache.js` | `ac829b027fbe7a0f8b9163ffa19ee7aefb7d7a9b713f1f9c5a6ce3a03626b453` |

The v10 source snapshot therefore includes Main's final dependency/error-gate boundary fix. There is no post-v10 normal-path source delta. That error-gate change is outside the normal no-pending path and is not used to invalidate the cold/append observations.

## Retained failed labels

| Label | Invalid portion | Reusable observation |
| --- | --- | --- |
| `page-e1-smoke-v1` | Pre-fix fixture had no Codex token row near EOF. | Initial landing reached 2,196,180 / 146,412. |
| `page-e1-smoke-v2` | Trace synchronization problem; manually stopped and cleaned before a page result was written. | No timing or correctness claim. |
| `page-e1-final-v2` | Stale API-response predicate produced a 2,197,180 vs 2,198,180 assertion. `totalBefore` was correct and scopes were not mixed. | Initial page and first append path reached the then-current total. |
| `page-e1-final-v3` | A stale source-size stat was compared with a later frozen append checkpoint (570-byte difference); this was a script bug. | 1x application flow otherwise completed. |
| `page-e1-final-v4` | Harness instrumentation threw `E1 diagnostic EventSource is closed`, causing the only page error. | Page flow and facts completed; not a product error. |
| `page-e1-final-v5` | Summary analyzer read the wrong nested resource shape. | Application/facts succeeded; raw samples self-check from 0 to 6 and remain usable. |
| `page-e1-guard-v6` | Oracle used stale `store.dashboard()` API. | Page/resource walk succeeded; current executor oracle self-check passed separately. |
| `page-e1-final-v7` | Immediate `conhost.exe` assertion raced process exit. | 1x flow and facts succeeded; delayed raw check found all 46 instances gone and zero residual. |
| `page-e1-final-v8` | 10x closed-SSE poll hit the 75-second harness timeout. | Valid 1x run; valid 10x cold/import and six appended facts; peak resource evidence retained. |
| `page-e1-final-v9-continuation` | Continuation did not seed the Codex cumulative state from the saved checkpoint. Its appended row reported cumulative `total_tokens=1000`, while the harness expected the existing page total plus 1,000. The expected response value therefore did not correspond to the generated fact, so the page waited for a value that the append did not describe. v10 fixed the input by loading `checkpoint.state.previousCumulative`. | This is a harness input/expected-total failure, not evidence that the product failed to publish a valid fact. |
| `page-e1-final-v10-continuation` | None. `passed: true`. | Final 10x recovery, freeze/resume, page facts, oracle parity, and stable source snapshot. |

## Limits of this evidence

- This is one 1x/10x correctness diagnostic, not p95, not the B3 matrix, and not a C-journal capacity result.
- The 10x resource target is not green: the cold/append page tree reached 573.5 MiB against a 512 MiB active target.
- The one-second page refresh target is not met.
- SAMPLER SQLITE `0` DOES NOT DESCRIBE `.codex-usage`; peak disk use was not measured.
- The saved v8 JSON uses old field names `parserBytesDelta` and `shaPrefixBytesContract`. They are translated here as `inputGrowthBytes` and `expectedProofBytesIfAppend` and are not observed parser-read or physical-I/O values.
- The continuation is warm-fixture evidence and does not replace the valid cold bootstrap or six-append evidence in v8.

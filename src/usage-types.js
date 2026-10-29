/**
 * Token counts after normalizing a source event. A zero detail value does not
 * imply that the source supplied that detail; callers must also inspect detailMask.
 * @typedef {{ total: number, input: number, cached: number, output: number, reasoning: number }} UsageTotals
 */

/**
 * A discovered Codex, ZCode, or imported project-log source.
 * @typedef {{ id: string, label: string, path: string, kind: string, usageLogPath?: string }} UsageSource
 */

/**
 * One normalized increment of usage, identified by its source and session.
 * @typedef {object} UsageEvent
 * @property {string} timestamp
 * @property {string} sessionId
 * @property {string} homeId
 * @property {string} homeLabel
 * @property {string} [sourceKind]
 * @property {string} channel
 * @property {string} model
 * @property {string} [quotaSource]
 * @property {UsageTotals} total
 * @property {number} detailMask
 * @property {string} [cwd]
 * @property {string} [repositoryKey]
 * @property {string} [repositoryPath]
 * @property {number} [cacheWriteTokens]
 * @property {boolean} [cacheWriteKnown]
 * @property {number} [requestInputTokens]
 * @property {string} [contextLevel]
 * @property {string} [serviceTier]
 * @property {string} [priceVersion]
 */

/**
 * A physical Codex rate-limit observation, keyed by file, line, and role.
 * @typedef {object} RateLimitObservation
 * @property {string} sourcePath
 * @property {number} lineNumber
 * @property {string} role
 * @property {number} observedAtMs
 * @property {string} limitId
 * @property {string | null} limitName
 * @property {string | null} planType
 * @property {number} windowMinutes
 * @property {number} resetsAtMs
 * @property {number | null} usedPercent
 */

/**
 * Pricing projection of an indexed SQLite event. This shape is shared by
 * timeline aggregation and the range-wide cost estimate.
 * @typedef {object} IndexedCostEvent
 * @property {string} [homeId]
 * @property {string} [homeLabel]
 * @property {string} [sourcePath]
 * @property {string} [sourceKind]
 * @property {number} timestamp
 * @property {string} sessionId
 * @property {string} channel
 * @property {string} model
 * @property {string} [quotaSource]
 * @property {string} [project]
 * @property {string} [repositoryKey]
 * @property {string} [repositoryPath]
 * @property {string} [repositoryKind]
 * @property {string} [cwd]
 * @property {number} detailMask
 * @property {number} [reconciliationGap]
 * @property {number} cacheWriteTokens
 * @property {boolean} cacheWriteKnown
 * @property {number} requestInputTokens
 * @property {string} contextLevel
 * @property {string} serviceTier
 * @property {string} priceVersion
 * @property {UsageTotals} total
 */

/**
 * Resolved inclusive event range. Quota ranges also retain the exclusive
 * window boundary so they can be rendered without losing their original span.
 * @typedef {object} UsageRange
 * @property {Date | null} start
 * @property {Date | null} end
 * @property {string} preset
 * @property {string} calendarZone
 * @property {string} [bucket]
 * @property {boolean} [rolling]
 * @property {boolean} [quotaWindow]
 * @property {string} [recentValue]
 * @property {string} [quotaPreset]
 * @property {Date} [asOf]
 * @property {Date} [endExclusive]
 * @property {Date} [windowEndExclusive]
 * @property {Date | null} [observedAt]
 * @property {number | null} [usedPercent]
 * @property {boolean} [percentStale]
 * @property {string | null} [limitId]
 * @property {string} [quotaState]
 * @property {string | null} [quotaReason]
 * @property {number} [durationMinutes]
 * @property {string} [plannedResetAt]
 */

/**
 * @typedef {object} UsageReport
 * @property {string} generatedAt
 * @property {UsageSource[]} homes
 * @property {UsageEvent[]} events
 * @property {object[]} sessions
 * @property {RateLimitObservation[]} rateLimitObservations
 * @property {string[]} warnings
 * @property {PerfSample[]} [perfSamples] In-memory TPS candidates (index path persists them instead).
 */

/**
 * Serialized bounds and bucket used by every summary path.
 * @typedef {{ preset: string, start: string | null, end: string | null, bucket: string, calendarZone: string, rolling: boolean }} SummaryRange
 */

/**
 * Common semantic fields of an in-memory or indexed summary. Individual
 * renderers may add source groups, record badges, or more pricing detail.
 * @typedef {object} UsageSummary
 * @property {string} generatedAt
 * @property {SummaryRange} range
 * @property {UsageTotals} totals
 * @property {object | null} comparison
 * @property {{ asOf: string, limitId: string | null, windows: object, previousWindows: object }} quota
 * @property {{ totalUsd: number | null, pricedTokens: number, unpricedTokens: number }} costEstimate
 * @property {number} eventCount
 * @property {number} sessionCount
 * @property {number} homeCount
 * @property {object[]} timeline
 * @property {string | null} timelineError
 * @property {object[]} channels
 * @property {object[]} homes
 * @property {object[]} models
 * @property {object[]} projects
 * @property {object[]} repositories
 * @property {PerfSummary} [perf] TPS groups, model speed rows, coverage and method metadata.
 */

/**
 * One deduplicated request/turn candidate observation of the TPS feature. Shape mirrors
 * the `perf_samples` columns of plan §4 one-for-one, camelCase in JS and snake_case in
 * SQLite. A missing number is `null` and a true zero is `0`; a missing name is the empty
 * string. `sampleKey` is the canonical JSON array of the §17.1 identity tuple, and
 * `sourceKind` is the canonical kind (`main/jetbrains/extra/codex` all map to `codex`).
 * @typedef {object} PerfSample
 * @property {string} sampleKey
 * @property {string} sourcePath
 * @property {string} sourceKind
 * @property {string} homeId
 * @property {string} channel
 * @property {string} agentKind `main` | `subagent` | `unknown`
 * @property {string} agent
 * @property {string} sessionId
 * @property {string} turnKey
 * @property {string} model
 * @property {string} modelProvider
 * @property {string} [quotaSource]
 * @property {string} reasoningEffort
 * @property {string} modelEvidence
 * @property {string} window `request` | `step` | `message` | `turn`
 * @property {string} timingKind `generation` (v3), or historical `request_e2e` (Codex v2 sums complete request durations
 *   within one turn) | `item_span_estimate` (historical diagnostic only)
 * @property {string} timingSource `explicit` | `timestamp_fallback` | `mixed` | `unknown`
 * @property {string} tokenScope `non_reasoning_output` (v3), or historical `reported_output_includes_reasoning` | `visible_plus_reasoning` | `reported_output_unspecified`
 * @property {string} status `completed` | `failed` | `cancelled` | `in_progress` | `unverified`
 * @property {number | null} tsMs
 * @property {number | null} windowStartMs
 * @property {number | null} windowEndMs
 * @property {number | null} durationMs
 * @property {number | null} outputTokens
 * @property {number | null} inputTokens
 * @property {number | null} requestCount
 * @property {number | null} itemCount
 * @property {number | null} timedItemCount
 * @property {number} sampleFlags Bit mask of the persistent §17.4 flags.
 * @property {string} diagnosticReason Source-side fine-grained reason (enum), never a raw error message;
 *   distinct from the §17.5:278 `droppedByReason` main-reason vocabulary.
 * @property {string[]} diagnosticReasonChain Every considered reason in evaluation order; keeps a
 *   `status_synthesized_from_filter_evidence` derivation visible even when another reason outranks it.
 * @property {string} methodVersion
 */

/**
 * A retained source that is currently unavailable.
 * @typedef {object} PerfMissingSource
 * @property {string} path Last successfully published physical source path.
 * @property {string} kind Original source kind, not the canonical perf kind.
 * @property {string} homeId
 * @property {string} homeLabel
 * @property {string} homePath
 * @property {number} missingSinceMs
 */

/**
 * TPS statistics and source availability exposed as `summary.perf`.
 * @typedef {object} PerfSummary
 * @property {PerfMissingSource[]} missingSources Retained sources currently unavailable, independent of the event date range.
 * @property {PerfSummaryGroup[]} groups
 * @property {PerfModelRow[]} models One source/model/effort/provider speed row per canonical identity.
 * @property {PerfCoverageShape} coverage
 * @property {PerfCodexTimingCoverage | null} codexTimingCoverage Current-method Codex
 *   coverage, or `null` when no applicable Codex source is configured.
 * @property {PerfSummaryMeta} meta
 */

/**
 * Current-method Codex coverage on the summary's selection.
 * @typedef {object} PerfCodexTimingCoverage
 * @property {string} methodVersion
 * @property {number | null} recordedOutputTokens Sum of known valid non-negative
 *   output tokens across current-method Codex candidates; `null` when the integer
 *   sum overflows.
 * @property {number | null} sampledOutputTokens Sum over the non-pending candidates
 *   that pass `isPerfSampled`; `null` when the integer sum overflows.
 * @property {number} unknownOutputCandidates Eligible candidates whose output is not
 *   a known safe non-negative integer. Unknown output is never counted as zero.
 * @property {PerfCoverageShape} counts
 */

/**
 * One source/model/reasoning-effort/provider speed row of `summary.perf.models`.
 * Home, channel and agents are deliberately folded into this projection.
 * @typedef {object} PerfModelRow
 * @property {string} key `[sourceKind, model, reasoningEffort, modelProvider]` JSON identity and stable tie-break.
 * @property {string} sourceKind
 * @property {string} model
 * @property {string} reasoningEffort
 * @property {string} modelProvider Empty string means provider unknown.
 * @property {"request" | "step" | "message" | "turn" | "mixed"} window
 *   Sample unit for this row; `mixed` cannot be rank-admitted.
 * @property {number | null} firstSampleAtMs Earliest actual sample `tsMs` in this row.
 * @property {number | null} lastSampleAtMs Latest actual sample `tsMs` in this row.
 * @property {number} [candidateCount] Deduplicated current-method candidates missing
 *   duration, present only on `missing_duration` rows; never a valid sample count.
 * @property {number} [firstCandidateAtMs] Earliest actual candidate `tsMs` in the selected range.
 * @property {number} [lastCandidateAtMs] Latest actual candidate `tsMs` in the selected range.
 * @property {number | null} averageTps Sum of output tokens × 1000 / sum of durations.
 * @property {number | null} p10
 * @property {number | null} p90
 * @property {number} n Valid sample count; zero when request duration is missing.
 * @property {"ok" | "overflow" | "missing_duration"} state
 * @property {"overflow" | "unverified" | "insufficient_samples" | "eligible"} rankState
 *   Admission, sample-count and overflow state in that priority order.
 * @property {number | null} rank `null` when overflowing or not admitted to the
 *   reviewed v2 unified ranking, or when `n < meta.minSamples`. This does not remove
 *   diagnostics or statistics.
 */

/**
 * One statistical group of `summary.perf.groups` (M1.3 `summarizePerf`). Dimensions
 * come from the canonical §17.1 group key; the statistics follow plan §17.2. Values
 * are **raw and never rounded** (§17.3: the API does not round for display).
 *
 * `tps.*`, `durationMs.*` and `sums.*` are all `null` exactly when
 * `state === "overflow"`: an unsafe raw integer sum must not produce a pseudo-precise
 * TPS (plan §17.2:229), and `warnings` then carries `AGGREGATE_OVERFLOW`.
 * Duration quantiles are computed from the durations directly and are never
 * back-derived from the TPS quantiles (plan §17.2:227).
 * @typedef {object} PerfSummaryGroup
 * @property {string} groupKey Canonical §17.1 key; the stable sort tie-break.
 * @property {string} sourceKind
 * @property {string} homeId
 * @property {string} channel
 * @property {string} agentKind `main` | `subagent` | `unknown`
 * @property {string} agent
 * @property {string} model
 * @property {string} modelProvider
 * @property {string} reasoningEffort
 * @property {string} timingKind
 * @property {string} tokenScope
 * @property {number} n `sampled` count feeding every statistic below; always > 0.
 * @property {{ p10: number | null, p50: number | null, p90: number | null, pooled: number | null }} tps
 *   nearest-rank `r[ceil(p × n) − 1]` over `r_i = outputTokens × 1000 / durationMs`,
 *   plus `pooled = sumOutputTokens × 1000 / sumDurationMs` (plan §17.2:226-228).
 * @property {{ p50: number | null, p90: number | null }} durationMs
 * @property {{ outputTokens: number | null, durationMs: number | null }} sums
 * @property {"ok" | "overflow"} state
 * @property {number | null} rank 1-based display rank, or `null` for a group that is
 *   under-sampled, overflowing, historical v1, or otherwise not admitted to the
 *   reviewed v2 ranking.
 * @property {boolean} insufficientSamples `n < minSamples`; the group is still
 *   reported, just not ranked.
 * @property {string[]} warnings Codes from the frozen `sourceWarnings` domain.
 */

/**
 * `summary.perf.coverage`: the §17.5:272 count shape, produced by `computePerfCoverage`
 * from the same selection `groups` is built from.
 * @typedef {object} PerfCoverageShape
 * @property {number} eligible
 * @property {number} positiveOutput
 * @property {number} timedPositiveOutput
 * @property {number} completeTimedPositiveOutput
 * @property {number} sampled
 * @property {number} dropped
 * @property {number} pending
 * @property {number} unplaced
 * @property {Record<string, number>} byFlag
 * @property {Record<string, number>} droppedByReason
 * @property {number | null} timingRate
 * @property {number | null} completeTimingRate
 * @property {number | null} sampleRate
 * @property {{ recent: PerfCoverageShape, legacy: PerfCoverageShape } | null} byEra
 */

/**
 * Method and provenance metadata for a `PerfSummary` (plan §3:81). `sourceWarnings`
 * accepts only the eight codes frozen by plan §3:83; ruling Q keeps the M1
 * normalization warning codes out of this shape.
 * @typedef {object} PerfSummaryMeta
 * @property {string} methodVersion Defaults to `tps-v4`. Historical `tps-v1` / `tps-v2` / `tps-v3`
 *   samples remain diagnostic and are never rank-admitted.
 * @property {"rebuilding" | "ready" | "degraded"} state
 * @property {string | null} indexVersion Fingerprint of the published sources.
 * @property {string | null} indexedAt Build timestamp; may legitimately differ between
 *   two summary runs whose samples, statistics, coverage and method version match.
 * @property {number} minSamples Defaults to 20.
 * @property {number} longWindowMs Hint threshold, 300000.
 * @property {number} eraCutoffMs Codex era boundary. This is **the value actually used**
 *   to compute every `byEra` in this summary (global, `bySource` and `byGroup`): the
 *   cut point is resolved and validated once per call and shared, so this field never
 *   reports a cut point other than the one that produced the splits.
 * @property {{ sourceKind: string, homeId: string, code: string, count: number }[]} sourceWarnings
 *   Encoded causes only — never a raw error message, SQL path or session id.
 */

/**
 * The `bySource` breakdown of a summary's coverage: one §17.5 count shape per
 * `sourceKind`, keyed by canonical source kind and emitted in code-unit key order.
 *
 * This exists because `byEra` is only produced when the whole eligible set is a single
 * Codex source, so a mixed run necessarily reports `byEra: null` globally. The Codex
 * bucket here is the only way to obtain the era split in a mixed run. Non-Codex
 * buckets keep `byEra: null` (§17.5:280).
 *
 * Buckets partition `eligible` exactly: `sum(bySource[k].eligible) === coverage.eligible`.
 * @typedef {Record<string, PerfCoverageShape>} PerfCoverageBySource
 */

/**
 * The `byGroup` breakdown of a summary's coverage: one §17.5 count shape per canonical
 * §17.1 `perfGroupKey`, emitted in code-unit key order.
 *
 * Unlike `summary.groups`, which only contains groups with `sampled > 0`, this map
 * **keeps diagnostic buckets** — a bucket with `eligible > 0` and `sampled === 0` is
 * the only answer to "which model was dropped and why does it produce no TPS".
 * A group with TPS always has a bucket here; a bucket need not have a group.
 *
 * Candidates whose `sourceKind` is unsupported have no canonical group key
 * (`perfGroupKey` returns `null`) and are collected under the explicit
 * `"(unkeyed)"` bucket so that no eligible candidate is lost:
 * `sum(byGroup[k].eligible) === coverage.eligible`.
 * @typedef {Record<string, PerfCoverageShape>} PerfCoverageByGroup
 */

/**
 * `summary.perf.coverage`: the §17.5:272 global count shape **plus** the
 * `bySource`/`byGroup` breakdowns. All three levels come from the same selection and
 * the same once-resolved era cut point, and every bucket is computed by the same
 * implementation as the global numbers (no second coverage algorithm).
 * @typedef {object} PerfSummaryCoverage
 * @property {number} eligible
 * @property {number} positiveOutput
 * @property {number} timedPositiveOutput
 * @property {number} completeTimedPositiveOutput
 * @property {number} sampled
 * @property {number} dropped
 * @property {number} pending
 * @property {number} unplaced
 * @property {Record<string, number>} byFlag
 * @property {Record<string, number>} droppedByReason
 * @property {number | null} timingRate
 * @property {number | null} completeTimingRate
 * @property {number | null} sampleRate
 * @property {{ recent: PerfCoverageShape, legacy: PerfCoverageShape } | null} byEra
 *   `null` whenever the eligible set is not a single Codex source; consult
 *   `bySource.codex.byEra` for the per-source split in a mixed run.
 * @property {PerfCoverageBySource} bySource
 * @property {PerfCoverageByGroup} byGroup
 */

/**
 * One `perf_samples` SQLite row, in **snake_case**, exactly as the M3.1 frozen DDL declares it.
 * This is the shape `encodePerfSample()` produces and `decodePerfSample()` consumes; it is not a
 * second source of truth for the schema — `PERF_SAMPLE_FIELDS` is, and a test locks the two plus
 * `PRAGMA table_info(perf_samples)` together.
 *
 * Nullability is semantic, not cosmetic (ruling AO-3): every measurement column is `INTEGER` and
 * **nullable**, so "unknown" is `NULL` and a true zero is `0`. Text columns are `NOT NULL`
 * because M1 always produces a string (a missing name is the empty string, ruling P).
 * `diagnostic_reason_chain` is JSON array text and nullable, so `NULL` ("no chain was recorded")
 * and `'[]'` ("the chain was computed and is empty") stay different states.
 * @typedef {object} PerfSampleRow
 * @property {string} sample_key
 * @property {string} source_path
 * @property {string} source_kind
 * @property {string} home_id
 * @property {string} channel
 * @property {string} agent_kind
 * @property {string} agent
 * @property {string} session_id
 * @property {string} turn_key
 * @property {string} model
 * @property {string} model_provider
 * @property {string} reasoning_effort
 * @property {string} model_evidence
 * @property {string} window
 * @property {string} timing_kind
 * @property {string} timing_source
 * @property {string} token_scope
 * @property {string} status
 * @property {number | null} ts_ms
 * @property {number | null} window_start_ms
 * @property {number | null} window_end_ms
 * @property {number | null} duration_ms
 * @property {number | null} output_tokens
 * @property {number | null} input_tokens
 * @property {number | null} request_count
 * @property {number | null} item_count
 * @property {number | null} timed_item_count
 * @property {number} sample_flags
 * @property {string} diagnostic_reason
 * @property {string | null} diagnostic_reason_chain
 * @property {string} method_version
 */

/**
 * `decodePerfSample()` output: the canonical {@link PerfSample} shape with one honest difference —
 * `diagnosticReasonChain` may be `null`, because a SQL `NULL` chain is **not** an empty chain
 * (ruling AO-1/AO-3). Every chain M1 produces is an array, so this only widens the type for rows
 * written by another path; the column is exactly what keeps the two states distinguishable.
 * @typedef {Omit<PerfSample, "diagnosticReasonChain"> & { diagnosticReasonChain: string[] | null }} PerfSampleRowDecoded
 */

export {};

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
 * @property {string} channel
 * @property {string} model
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
 * @property {number} timestamp
 * @property {string} sessionId
 * @property {string} channel
 * @property {string} model
 * @property {number} detailMask
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
 */

/**
 * @typedef {object} UsageReport
 * @property {string} generatedAt
 * @property {UsageSource[]} homes
 * @property {UsageEvent[]} events
 * @property {object[]} sessions
 * @property {RateLimitObservation[]} rateLimitObservations
 * @property {string[]} warnings
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
 */

export {};

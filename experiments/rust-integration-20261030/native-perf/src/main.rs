use serde_json::{Number, Value};
use std::collections::{HashMap, HashSet};
use std::env;
use std::error::Error;
use std::fmt;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::PathBuf;

const PERF_METHOD_VERSION: &str = "tps-v4";
const PERF_MIN_SAMPLES: f64 = 20.0;
const PERF_LONG_WINDOW_MS: f64 = 300_000.0;
const JS_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug)]
struct AppError(String);

impl AppError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for AppError {}

type Result<T> = std::result::Result<T, AppError>;

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(AppError::new(message))
}

#[derive(Debug, Clone)]
struct SourceWarning {
    source_kind: String,
    home_id: String,
    code: String,
    count: Number,
}

#[derive(Debug)]
struct Meta {
    method_version: String,
    state: String,
    index_version: Option<String>,
    indexed_at: Option<String>,
    min_samples: f64,
    long_window_ms: f64,
    era_cutoff_ms: f64,
    source_warnings: Vec<SourceWarning>,
}

#[derive(Debug)]
struct Config {
    min_samples: f64,
    era_cutoff_ms: f64,
    codex_applicable: bool,
    flag_names: Vec<Option<String>>,
    dropped_reasons: Vec<String>,
    reason_indexes: HashMap<String, usize>,
    unkeyed_group_bucket: String,
    meta: Meta,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Placement {
    Eligible,
    Unplaced,
}

#[derive(Debug)]
struct Sample {
    source_kind: String,
    home_id: String,
    channel: String,
    agent_kind: String,
    agent: String,
    model: String,
    model_provider: String,
    reasoning_effort: String,
    timing_kind: String,
    token_scope: String,
    window: String,
    ts_ms: Option<f64>,
    output_tokens: Option<f64>,
    duration_ms: Option<f64>,
    sample_flags: u32,
    group_key: Option<String>,
    model_key: Option<String>,
    placement: Placement,
    sampled: bool,
    rank_admitted: bool,
    model_sampled: bool,
    missing_candidate: bool,
    dropped_reason: Option<String>,
    status: Option<String>,
    codex_current: bool,
}

impl Sample {
    fn pending(&self) -> bool {
        match self.status.as_deref() {
            Some(status) => status == "in_progress",
            None => !self.sampled && self.dropped_reason.is_none(),
        }
    }
}

#[derive(Debug)]
struct Counts {
    eligible: u64,
    positive_output: u64,
    timed_positive_output: u64,
    complete_timed_positive_output: u64,
    sampled: u64,
    dropped: u64,
    pending: u64,
    by_flag: Vec<u64>,
    dropped_by_reason: Vec<u64>,
}

impl Counts {
    fn new(flag_count: usize, reason_count: usize) -> Self {
        Self {
            eligible: 0,
            positive_output: 0,
            timed_positive_output: 0,
            complete_timed_positive_output: 0,
            sampled: 0,
            dropped: 0,
            pending: 0,
            by_flag: vec![0; flag_count],
            dropped_by_reason: vec![0; reason_count],
        }
    }

    fn feed(&mut self, sample: &Sample, config: &Config) -> Result<()> {
        self.eligible += 1;
        for (bit, name) in config.flag_names.iter().enumerate() {
            if sample.sample_flags & (1_u32 << bit) != 0 {
                if name.is_none() {
                    return invalid(format!("reserved perf flag bit {bit} is set"));
                }
                self.by_flag[bit] += 1;
            }
        }

        let positive = sample.output_tokens.is_some_and(|value| value > 0.0);
        if positive {
            self.positive_output += 1;
        }
        let timed_positive = positive && sample.duration_ms.is_some_and(|value| value > 0.0);
        if timed_positive {
            self.timed_positive_output += 1;
        }
        let partial_bit = flag_bit(config, "PARTIAL_ITEM_SPAN");
        let overlap_bit = flag_bit(config, "OVERLAPPING_ITEM_SPAN");
        let incomplete_span = partial_bit
            .is_some_and(|bit| sample.sample_flags & (1_u32 << bit) != 0)
            || overlap_bit.is_some_and(|bit| sample.sample_flags & (1_u32 << bit) != 0);
        if timed_positive && !incomplete_span {
            self.complete_timed_positive_output += 1;
        }

        if sample.pending() {
            self.pending += 1;
        } else if sample.sampled {
            self.sampled += 1;
        } else {
            let reason = sample
                .dropped_reason
                .as_deref()
                .ok_or_else(|| AppError::new("dropped eligible sample has no droppedReason"))?;
            let index = config
                .reason_indexes
                .get(reason)
                .copied()
                .ok_or_else(|| AppError::new(format!("unknown droppedReason {reason:?}")))?;
            self.dropped += 1;
            self.dropped_by_reason[index] += 1;
        }
        Ok(())
    }
}

#[derive(Debug)]
struct CoverageBucket {
    counts: Counts,
    recent: Counts,
    legacy: Counts,
    eligible_source_kinds: HashSet<String>,
    unplaced: u64,
}

impl CoverageBucket {
    fn new(flag_count: usize, reason_count: usize) -> Self {
        Self {
            counts: Counts::new(flag_count, reason_count),
            recent: Counts::new(flag_count, reason_count),
            legacy: Counts::new(flag_count, reason_count),
            eligible_source_kinds: HashSet::new(),
            unplaced: 0,
        }
    }

    fn feed_eligible(&mut self, sample: &Sample, config: &Config) -> Result<()> {
        self.counts.feed(sample, config)?;
        self.eligible_source_kinds
            .insert(sample.source_kind.clone());
        if sample
            .ts_ms
            .is_some_and(|value| value >= config.era_cutoff_ms)
        {
            self.recent.feed(sample, config)?;
        } else {
            self.legacy.feed(sample, config)?;
        }
        Ok(())
    }

    fn feed_unplaced(&mut self) {
        self.unplaced += 1;
    }

    fn by_era(&self) -> Option<(&Counts, &Counts)> {
        if self.counts.eligible == 0
            || self.eligible_source_kinds.len() != 1
            || !self.eligible_source_kinds.contains("codex")
        {
            return None;
        }
        Some((&self.recent, &self.legacy))
    }
}

#[derive(Debug, Clone)]
struct GroupIdentity {
    source_kind: String,
    home_id: String,
    channel: String,
    agent_kind: String,
    agent: String,
    model: String,
    model_provider: String,
    reasoning_effort: String,
    timing_kind: String,
    token_scope: String,
}

impl GroupIdentity {
    fn from_sample(sample: &Sample) -> Self {
        Self {
            source_kind: sample.source_kind.clone(),
            home_id: sample.home_id.clone(),
            channel: sample.channel.clone(),
            agent_kind: sample.agent_kind.clone(),
            agent: sample.agent.clone(),
            model: sample.model.clone(),
            model_provider: sample.model_provider.clone(),
            reasoning_effort: sample.reasoning_effort.clone(),
            timing_kind: sample.timing_kind.clone(),
            token_scope: sample.token_scope.clone(),
        }
    }
}

#[derive(Debug)]
struct GroupBucket {
    first: GroupIdentity,
    outputs: Vec<f64>,
    durations: Vec<f64>,
    rank_admitted: bool,
}

#[derive(Debug)]
struct ModelIdentity {
    source_kind: String,
    model: String,
    reasoning_effort: String,
    model_provider: String,
}

#[derive(Debug)]
struct ModelBucket {
    identity: ModelIdentity,
    outputs: Vec<f64>,
    durations: Vec<f64>,
    first_sample_at_ms: Option<f64>,
    last_sample_at_ms: Option<f64>,
    windows: HashSet<String>,
    rank_admitted: bool,
}

#[derive(Debug)]
struct MissingBucket {
    identity: ModelIdentity,
    candidate_count: u64,
    first_candidate_at_ms: f64,
    last_candidate_at_ms: f64,
}

#[derive(Debug)]
struct GroupRow {
    key: String,
    identity: GroupIdentity,
    n: u64,
    tps_p10: Option<f64>,
    tps_p50: Option<f64>,
    tps_p90: Option<f64>,
    tps_pooled: Option<f64>,
    duration_p50: Option<f64>,
    duration_p90: Option<f64>,
    sum_output_tokens: Option<f64>,
    sum_duration_ms: Option<f64>,
    overflow: bool,
    rank_admitted: bool,
    rank: Option<u64>,
    insufficient_samples: bool,
}

#[derive(Debug)]
struct ModelRow {
    key: String,
    identity: ModelIdentity,
    window: String,
    first_sample_at_ms: Option<f64>,
    last_sample_at_ms: Option<f64>,
    average_tps: Option<f64>,
    p10: Option<f64>,
    p90: Option<f64>,
    n: u64,
    state: &'static str,
    rank_state: &'static str,
    rank: Option<u64>,
    candidate_count: Option<u64>,
    first_candidate_at_ms: Option<f64>,
    last_candidate_at_ms: Option<f64>,
}

#[derive(Debug)]
struct SafeSum {
    value: f64,
    overflow: bool,
}

impl SafeSum {
    fn new() -> Self {
        Self {
            value: 0.0,
            overflow: false,
        }
    }

    fn add(&mut self, value: f64) {
        if self.overflow {
            return;
        }
        let next = self.value + value;
        if is_js_safe_integer(next) {
            self.value = next;
        } else {
            self.overflow = true;
        }
    }

    fn output(&self) -> Option<f64> {
        (!self.overflow).then_some(self.value)
    }
}

#[derive(Debug)]
struct Aggregator {
    groups: HashMap<String, GroupBucket>,
    models: HashMap<String, ModelBucket>,
    missing: HashMap<String, MissingBucket>,
    coverage: CoverageBucket,
    coverage_by_source: HashMap<String, CoverageBucket>,
    coverage_by_group: HashMap<String, CoverageBucket>,
    codex_coverage: CoverageBucket,
    recorded_output_tokens: SafeSum,
    sampled_output_tokens: SafeSum,
    unknown_output_candidates: u64,
}

impl Aggregator {
    fn new(config: &Config) -> Self {
        let flag_count = config.flag_names.len();
        let reason_count = config.dropped_reasons.len();
        Self {
            groups: HashMap::new(),
            models: HashMap::new(),
            missing: HashMap::new(),
            coverage: CoverageBucket::new(flag_count, reason_count),
            coverage_by_source: HashMap::new(),
            coverage_by_group: HashMap::new(),
            codex_coverage: CoverageBucket::new(flag_count, reason_count),
            recorded_output_tokens: SafeSum::new(),
            sampled_output_tokens: SafeSum::new(),
            unknown_output_candidates: 0,
        }
    }

    fn consume(&mut self, sample: Sample, config: &Config) -> Result<()> {
        if sample.sample_flags as u64 >= (1_u64 << config.flag_names.len()) {
            return invalid(format!(
                "sampleFlags {} has bits outside the configured flag table",
                sample.sample_flags
            ));
        }

        if sample.placement == Placement::Unplaced {
            self.coverage.feed_unplaced();
            coverage_bucket_for(&mut self.coverage_by_source, &sample.source_kind, config)
                .feed_unplaced();
            let group_key = sample
                .group_key
                .as_deref()
                .unwrap_or(&config.unkeyed_group_bucket);
            coverage_bucket_for(&mut self.coverage_by_group, group_key, config).feed_unplaced();
            if sample.codex_current {
                self.codex_coverage.feed_unplaced();
            }
            return Ok(());
        }

        self.coverage.feed_eligible(&sample, config)?;
        coverage_bucket_for(&mut self.coverage_by_source, &sample.source_kind, config)
            .feed_eligible(&sample, config)?;
        let group_key = sample
            .group_key
            .as_deref()
            .unwrap_or(&config.unkeyed_group_bucket);
        coverage_bucket_for(&mut self.coverage_by_group, group_key, config)
            .feed_eligible(&sample, config)?;

        if sample.codex_current {
            self.codex_coverage.feed_eligible(&sample, config)?;
            if let Some(output) = sample.output_tokens {
                if is_js_safe_integer(output) && output >= 0.0 {
                    self.recorded_output_tokens.add(output);
                    if sample.sampled {
                        self.sampled_output_tokens.add(output);
                    }
                } else {
                    self.unknown_output_candidates += 1;
                }
            } else {
                self.unknown_output_candidates += 1;
            }
        }

        if sample.sampled
            && let Some(key) = sample.group_key.as_ref()
        {
            if !self.groups.contains_key(key) {
                self.groups.insert(
                    key.clone(),
                    GroupBucket {
                        first: GroupIdentity::from_sample(&sample),
                        outputs: Vec::new(),
                        durations: Vec::new(),
                        rank_admitted: sample.rank_admitted,
                    },
                );
            }
            let bucket = self.groups.get_mut(key).expect("group inserted");
            bucket
                .outputs
                .push(sample.output_tokens.expect("sampled output"));
            bucket
                .durations
                .push(sample.duration_ms.expect("sampled duration"));
            bucket.rank_admitted &= sample.rank_admitted;
        }

        if sample.model_sampled {
            let key = sample
                .model_key
                .as_ref()
                .ok_or_else(|| AppError::new("modelSampled row has no modelKey"))?;
            if !self.models.contains_key(key) {
                let identity = parse_model_key(key)?;
                self.models.insert(
                    key.clone(),
                    ModelBucket {
                        identity,
                        outputs: Vec::new(),
                        durations: Vec::new(),
                        first_sample_at_ms: None,
                        last_sample_at_ms: None,
                        windows: HashSet::new(),
                        rank_admitted: sample.rank_admitted,
                    },
                );
            }
            let bucket = self.models.get_mut(key).expect("model inserted");
            bucket
                .outputs
                .push(sample.output_tokens.expect("model output"));
            bucket
                .durations
                .push(sample.duration_ms.expect("model duration"));
            update_timestamp_bounds(
                &mut bucket.first_sample_at_ms,
                &mut bucket.last_sample_at_ms,
                sample.ts_ms,
            );
            bucket.windows.insert(js_trim(&sample.window).to_owned());
            bucket.rank_admitted &= sample.rank_admitted;
        }

        if sample.missing_candidate {
            let key = sample
                .model_key
                .as_ref()
                .ok_or_else(|| AppError::new("missingCandidate row has no modelKey"))?;
            let timestamp = sample
                .ts_ms
                .ok_or_else(|| AppError::new("missingCandidate row has no numeric tsMs"))?;
            if let Some(bucket) = self.missing.get_mut(key) {
                bucket.candidate_count += 1;
                bucket.first_candidate_at_ms = bucket.first_candidate_at_ms.min(timestamp);
                bucket.last_candidate_at_ms = bucket.last_candidate_at_ms.max(timestamp);
            } else {
                self.missing.insert(
                    key.clone(),
                    MissingBucket {
                        identity: parse_model_key(key)?,
                        candidate_count: 1,
                        first_candidate_at_ms: timestamp,
                        last_candidate_at_ms: timestamp,
                    },
                );
            }
        }
        Ok(())
    }

    fn finish(mut self, config: &Config) -> Output {
        let mut groups = Vec::with_capacity(self.groups.len());
        for (key, bucket) in self.groups.drain() {
            groups.push(finalize_group(key, bucket, config.min_samples));
        }
        groups.sort_by(compare_group_rows);
        let mut next_rank = 1_u64;
        for group in &mut groups {
            if !group.insufficient_samples && !group.overflow && group.rank_admitted {
                group.rank = Some(next_rank);
                next_rank += 1;
            }
        }

        let mut models = Vec::with_capacity(self.models.len() + self.missing.len());
        for (key, bucket) in self.models.drain() {
            models.push(finalize_model(key, bucket, config.min_samples));
        }
        let sampled_model_keys: HashSet<String> =
            models.iter().map(|model| model.key.clone()).collect();
        for (key, bucket) in self.missing.drain() {
            if sampled_model_keys.contains(&key) {
                continue;
            }
            models.push(ModelRow {
                key,
                identity: bucket.identity,
                window: "request".to_owned(),
                first_sample_at_ms: None,
                last_sample_at_ms: None,
                average_tps: None,
                p10: None,
                p90: None,
                n: 0,
                state: "missing_duration",
                rank_state: "unverified",
                rank: None,
                candidate_count: Some(bucket.candidate_count),
                first_candidate_at_ms: Some(bucket.first_candidate_at_ms),
                last_candidate_at_ms: Some(bucket.last_candidate_at_ms),
            });
        }
        models.sort_by(compare_model_rows);
        let mut next_model_rank = 1_u64;
        for model in &mut models {
            if model.rank_state == "eligible" {
                model.rank = Some(next_model_rank);
                next_model_rank += 1;
            }
        }

        let mut warnings = config.meta.source_warnings.clone();
        for group in &groups {
            if group.overflow {
                warnings.push(SourceWarning {
                    source_kind: group.identity.source_kind.clone(),
                    home_id: group.identity.home_id.clone(),
                    code: "AGGREGATE_OVERFLOW".to_owned(),
                    count: Number::from(1_u64),
                });
            }
        }
        warnings.sort_by(compare_source_warnings);

        let codex_timing_coverage = config.codex_applicable.then(|| CodexTimingCoverage {
            recorded_output_tokens: self.recorded_output_tokens.output(),
            sampled_output_tokens: self.sampled_output_tokens.output(),
            unknown_output_candidates: self.unknown_output_candidates,
            coverage: self.codex_coverage,
        });

        let meta = Meta {
            method_version: config.meta.method_version.clone(),
            state: config.meta.state.clone(),
            index_version: config.meta.index_version.clone(),
            indexed_at: config.meta.indexed_at.clone(),
            min_samples: config.meta.min_samples,
            long_window_ms: config.meta.long_window_ms,
            era_cutoff_ms: config.meta.era_cutoff_ms,
            source_warnings: warnings,
        };

        Output {
            groups,
            models,
            coverage: self.coverage,
            coverage_by_source: self.coverage_by_source,
            coverage_by_group: self.coverage_by_group,
            codex_timing_coverage,
            meta,
        }
    }
}

struct CodexTimingCoverage {
    recorded_output_tokens: Option<f64>,
    sampled_output_tokens: Option<f64>,
    unknown_output_candidates: u64,
    coverage: CoverageBucket,
}

struct Output {
    groups: Vec<GroupRow>,
    models: Vec<ModelRow>,
    coverage: CoverageBucket,
    coverage_by_source: HashMap<String, CoverageBucket>,
    coverage_by_group: HashMap<String, CoverageBucket>,
    codex_timing_coverage: Option<CodexTimingCoverage>,
    meta: Meta,
}

fn coverage_bucket_for<'a>(
    buckets: &'a mut HashMap<String, CoverageBucket>,
    key: &str,
    config: &Config,
) -> &'a mut CoverageBucket {
    buckets.entry(key.to_owned()).or_insert_with(|| {
        CoverageBucket::new(config.flag_names.len(), config.dropped_reasons.len())
    })
}

fn flag_bit(config: &Config, name: &str) -> Option<usize> {
    config
        .flag_names
        .iter()
        .position(|candidate| candidate.as_deref() == Some(name))
}

fn update_timestamp_bounds(
    first: &mut Option<f64>,
    last: &mut Option<f64>,
    timestamp: Option<f64>,
) {
    let Some(timestamp) = timestamp else {
        return;
    };
    *first = Some(first.map_or(timestamp, |current| current.min(timestamp)));
    *last = Some(last.map_or(timestamp, |current| current.max(timestamp)));
}

fn finalize_group(key: String, bucket: GroupBucket, min_samples: f64) -> GroupRow {
    let mut sum_output_tokens = 0.0;
    let mut sum_duration_ms = 0.0;
    let mut overflow = false;
    for (output, duration) in bucket.outputs.iter().zip(&bucket.durations) {
        sum_output_tokens += *output;
        sum_duration_ms += *duration;
        if !is_js_safe_integer(sum_output_tokens) || !is_js_safe_integer(sum_duration_ms) {
            overflow = true;
        }
    }

    let n = bucket.outputs.len() as u64;
    if overflow {
        return GroupRow {
            key,
            identity: bucket.first,
            n,
            tps_p10: None,
            tps_p50: None,
            tps_p90: None,
            tps_pooled: None,
            duration_p50: None,
            duration_p90: None,
            sum_output_tokens: None,
            sum_duration_ms: None,
            overflow: true,
            rank_admitted: bucket.rank_admitted,
            rank: None,
            insufficient_samples: (n as f64) < min_samples,
        };
    }

    let mut rates: Vec<f64> = bucket
        .outputs
        .iter()
        .zip(&bucket.durations)
        .map(|(output, duration)| (*output * 1000.0) / *duration)
        .collect();
    let mut durations = bucket.durations;
    sort_numbers(&mut rates);
    sort_numbers(&mut durations);
    GroupRow {
        key,
        identity: bucket.first,
        n,
        tps_p10: nearest_rank(&rates, 0.1),
        tps_p50: nearest_rank(&rates, 0.5),
        tps_p90: nearest_rank(&rates, 0.9),
        tps_pooled: Some((sum_output_tokens * 1000.0) / sum_duration_ms),
        duration_p50: nearest_rank(&durations, 0.5),
        duration_p90: nearest_rank(&durations, 0.9),
        sum_output_tokens: Some(sum_output_tokens),
        sum_duration_ms: Some(sum_duration_ms),
        overflow: false,
        rank_admitted: bucket.rank_admitted,
        rank: None,
        insufficient_samples: (n as f64) < min_samples,
    }
}

fn finalize_model(key: String, bucket: ModelBucket, min_samples: f64) -> ModelRow {
    let mut sum_output_tokens = 0.0;
    let mut sum_duration_ms = 0.0;
    let mut overflow = false;
    for (output, duration) in bucket.outputs.iter().zip(&bucket.durations) {
        sum_output_tokens += *output;
        sum_duration_ms += *duration;
        if !is_js_safe_integer(sum_output_tokens) || !is_js_safe_integer(sum_duration_ms) {
            overflow = true;
        }
    }

    let n = bucket.outputs.len() as u64;
    let window = if bucket.windows.len() == 1 {
        bucket.windows.iter().next().expect("one window").clone()
    } else {
        "mixed".to_owned()
    };
    let rank_state = if overflow {
        "overflow"
    } else if !bucket.rank_admitted || window == "mixed" {
        "unverified"
    } else if (n as f64) < min_samples {
        "insufficient_samples"
    } else {
        "eligible"
    };
    let (average_tps, p10, p90) = if overflow {
        (None, None, None)
    } else {
        let mut rates: Vec<f64> = bucket
            .outputs
            .iter()
            .zip(&bucket.durations)
            .map(|(output, duration)| (*output * 1000.0) / *duration)
            .collect();
        sort_numbers(&mut rates);
        (
            Some((sum_output_tokens * 1000.0) / sum_duration_ms),
            nearest_rank(&rates, 0.1),
            nearest_rank(&rates, 0.9),
        )
    };
    ModelRow {
        key,
        identity: bucket.identity,
        window,
        first_sample_at_ms: bucket.first_sample_at_ms,
        last_sample_at_ms: bucket.last_sample_at_ms,
        average_tps,
        p10,
        p90,
        n,
        state: if overflow { "overflow" } else { "ok" },
        rank_state,
        rank: None,
        candidate_count: None,
        first_candidate_at_ms: None,
        last_candidate_at_ms: None,
    }
}

fn nearest_rank(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len();
    let index = (p * n as f64).ceil() as isize - 1;
    let clamped = index.clamp(0, n as isize - 1) as usize;
    Some(sorted[clamped])
}

fn sort_numbers(values: &mut [f64]) {
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
}

fn compare_group_rows(left: &GroupRow, right: &GroupRow) -> std::cmp::Ordering {
    match (left.tps_p50, right.tps_p50) {
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(left_value), Some(right_value)) if left_value != right_value => {
            right_value.partial_cmp(&left_value).unwrap()
        }
        _ => compare_js_code_units(&left.key, &right.key),
    }
}

fn compare_model_rows(left: &ModelRow, right: &ModelRow) -> std::cmp::Ordering {
    let left_missing = left.state == "missing_duration";
    let right_missing = right.state == "missing_duration";
    if left_missing != right_missing {
        return if left_missing {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
    }
    let left_overflow = left.rank_state == "overflow";
    let right_overflow = right.rank_state == "overflow";
    if left_overflow != right_overflow {
        return if left_overflow {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
    }
    let left_eligible = left.rank_state == "eligible";
    let right_eligible = right.rank_state == "eligible";
    if left_eligible != right_eligible {
        return if left_eligible {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    if let (Some(left_average), Some(right_average)) = (left.average_tps, right.average_tps)
        && left_average != right_average
    {
        return right_average.partial_cmp(&left_average).unwrap();
    }
    compare_js_code_units(&left.key, &right.key)
}

fn compare_source_warnings(left: &SourceWarning, right: &SourceWarning) -> std::cmp::Ordering {
    compare_js_code_units(&left.source_kind, &right.source_kind)
        .then_with(|| compare_js_code_units(&left.home_id, &right.home_id))
        .then_with(|| compare_js_code_units(&left.code, &right.code))
}

fn compare_js_code_units(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn is_js_safe_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value && value.abs() <= JS_MAX_SAFE_INTEGER
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|character| {
        matches!(
            character,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    })
}

fn parse_model_key(key: &str) -> Result<ModelIdentity> {
    let value: Value = serde_json::from_str(key)
        .map_err(|error| AppError::new(format!("invalid modelKey JSON: {error}")))?;
    let parts = value
        .as_array()
        .ok_or_else(|| AppError::new("modelKey must be a JSON array"))?;
    if parts.len() != 4 {
        return invalid("modelKey must contain exactly four strings");
    }
    let mut strings = Vec::with_capacity(4);
    for part in parts {
        strings.push(
            part.as_str()
                .ok_or_else(|| AppError::new("modelKey parts must be strings"))?
                .to_owned(),
        );
    }
    Ok(ModelIdentity {
        source_kind: strings.remove(0),
        model: strings.remove(0),
        reasoning_effort: strings.remove(0),
        model_provider: strings.remove(0),
    })
}

fn parse_config(value: &Value) -> Result<Config> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::new("config line must be a JSON object"))?;
    let min_samples = f64_or_default(object.get("minSamples"), "minSamples", PERF_MIN_SAMPLES)?;
    if !min_samples.is_finite() || min_samples < 0.0 {
        return invalid("minSamples must be a non-negative finite number");
    }
    let era_cutoff_ms = required_f64(object.get("eraCutoffMs"), "eraCutoffMs")?;
    if !era_cutoff_ms.is_finite() {
        return invalid("eraCutoffMs must be a finite number");
    }
    let codex_applicable = required_bool(object.get("codexApplicable"), "codexApplicable")?;
    let flag_values = object
        .get("flagNames")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("flagNames must be an array"))?;
    if flag_values.len() > 31 {
        return invalid("flagNames may contain at most 31 bits");
    }
    let mut flag_names = Vec::with_capacity(flag_values.len());
    for (index, value) in flag_values.iter().enumerate() {
        match value {
            Value::Null => flag_names.push(None),
            Value::String(name) => flag_names.push(Some(name.clone())),
            _ => return invalid(format!("flagNames[{index}] must be a string or null")),
        }
    }
    let dropped_reasons = required_string_array(object.get("droppedReasons"), "droppedReasons")?;
    let mut reason_indexes = HashMap::new();
    for (index, reason) in dropped_reasons.iter().enumerate() {
        if reason_indexes.insert(reason.clone(), index).is_some() {
            return invalid(format!("duplicate droppedReason {reason:?}"));
        }
    }
    let unkeyed_group_bucket =
        required_string(object.get("unkeyedGroupBucket"), "unkeyedGroupBucket")?;
    let meta = parse_meta(
        object
            .get("meta")
            .ok_or_else(|| AppError::new("meta is required"))?,
    )?;
    Ok(Config {
        min_samples,
        era_cutoff_ms,
        codex_applicable,
        flag_names,
        dropped_reasons,
        reason_indexes,
        unkeyed_group_bucket,
        meta,
    })
}

fn parse_meta(value: &Value) -> Result<Meta> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::new("meta must be an object"))?;
    let source_warning_values = object
        .get("sourceWarnings")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("meta.sourceWarnings must be an array"))?;
    let mut source_warnings = Vec::with_capacity(source_warning_values.len());
    for warning in source_warning_values {
        let warning = warning
            .as_object()
            .ok_or_else(|| AppError::new("sourceWarnings entries must be objects"))?;
        let count = warning
            .get("count")
            .and_then(Value::as_number)
            .ok_or_else(|| AppError::new("sourceWarnings.count must be a number"))?
            .clone();
        source_warnings.push(SourceWarning {
            source_kind: required_string(warning.get("sourceKind"), "sourceKind")?,
            home_id: required_string(warning.get("homeId"), "homeId")?,
            code: required_string(warning.get("code"), "code")?,
            count,
        });
    }
    Ok(Meta {
        method_version: required_string(object.get("methodVersion"), "methodVersion")?,
        state: required_string(object.get("state"), "state")?,
        index_version: nullable_string(object.get("indexVersion"), "indexVersion")?,
        indexed_at: nullable_string(object.get("indexedAt"), "indexedAt")?,
        min_samples: f64_or_default(
            object.get("minSamples"),
            "meta.minSamples",
            PERF_MIN_SAMPLES,
        )?,
        long_window_ms: f64_or_default(
            object.get("longWindowMs"),
            "meta.longWindowMs",
            PERF_LONG_WINDOW_MS,
        )?,
        era_cutoff_ms: required_f64(object.get("eraCutoffMs"), "meta.eraCutoffMs")?,
        source_warnings,
    })
}

fn parse_sample(value: &Value) -> Result<Sample> {
    let object = value
        .as_object()
        .ok_or_else(|| AppError::new("sample line must be a JSON object"))?;
    let placement = match required_string(object.get("placement"), "placement")?.as_str() {
        "eligible" => Placement::Eligible,
        "unplaced" => Placement::Unplaced,
        other => return invalid(format!("unknown placement {other:?}")),
    };
    let sample_flags = object
        .get("sampleFlags")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::new("sampleFlags must be a non-negative integer"))?;
    if sample_flags > u32::MAX as u64 {
        return invalid("sampleFlags exceeds the JS 32-bit flag range");
    }
    let sample = Sample {
        source_kind: required_string(object.get("sourceKind"), "sourceKind")?,
        home_id: required_string(object.get("homeId"), "homeId")?,
        channel: required_string(object.get("channel"), "channel")?,
        agent_kind: required_string(object.get("agentKind"), "agentKind")?,
        agent: required_string(object.get("agent"), "agent")?,
        model: required_string(object.get("model"), "model")?,
        model_provider: required_string(object.get("modelProvider"), "modelProvider")?,
        reasoning_effort: required_string(object.get("reasoningEffort"), "reasoningEffort")?,
        timing_kind: required_string(object.get("timingKind"), "timingKind")?,
        token_scope: required_string(object.get("tokenScope"), "tokenScope")?,
        window: required_string(object.get("window"), "window")?,
        ts_ms: nullable_f64(object.get("tsMs"), "tsMs")?,
        output_tokens: nullable_f64(object.get("outputTokens"), "outputTokens")?,
        duration_ms: nullable_f64(object.get("durationMs"), "durationMs")?,
        sample_flags: sample_flags as u32,
        group_key: nullable_string(object.get("groupKey"), "groupKey")?,
        model_key: nullable_string(object.get("modelKey"), "modelKey")?,
        placement,
        sampled: required_bool(object.get("sampled"), "sampled")?,
        rank_admitted: required_bool(object.get("rankAdmitted"), "rankAdmitted")?,
        model_sampled: required_bool(object.get("modelSampled"), "modelSampled")?,
        missing_candidate: required_bool(object.get("missingCandidate"), "missingCandidate")?,
        dropped_reason: nullable_string(object.get("droppedReason"), "droppedReason")?,
        status: nullable_string(object.get("status"), "status")?,
        codex_current: required_bool(object.get("codexCurrent"), "codexCurrent")?,
    };
    required_string(object.get("methodVersion"), "methodVersion")?;
    if sample.sampled && sample.pending() {
        return invalid("sample cannot be both sampled and pending");
    }
    Ok(sample)
}

fn required_string(value: Option<&Value>, name: &str) -> Result<String> {
    value
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::new(format!("{name} must be a string")))
}

fn nullable_string(value: Option<&Value>, name: &str) -> Result<Option<String>> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => invalid(format!("{name} must be a string or null")),
    }
}

fn required_bool(value: Option<&Value>, name: &str) -> Result<bool> {
    value
        .and_then(Value::as_bool)
        .ok_or_else(|| AppError::new(format!("{name} must be a boolean")))
}

fn required_f64(value: Option<&Value>, name: &str) -> Result<f64> {
    value
        .and_then(Value::as_f64)
        .ok_or_else(|| AppError::new(format!("{name} must be a number")))
}

fn f64_or_default(value: Option<&Value>, name: &str, default: f64) -> Result<f64> {
    match value {
        Some(_) => required_f64(value, name),
        None => Ok(default),
    }
}

fn nullable_f64(value: Option<&Value>, name: &str) -> Result<Option<f64>> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| AppError::new(format!("{name} must be a number or null"))),
        None => invalid(format!("{name} is required")),
    }
}

fn required_string_array(value: Option<&Value>, name: &str) -> Result<Vec<String>> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new(format!("{name} must be an array")))?
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            entry
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| AppError::new(format!("{name}[{index}] must be a string")))
        })
        .collect()
}

fn run(input_path: &PathBuf, output: &mut impl Write) -> Result<()> {
    let file = File::open(input_path).map_err(|error| {
        AppError::new(format!(
            "failed to open input {}: {error}",
            input_path.display()
        ))
    })?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    if reader
        .read_line(&mut line)
        .map_err(|error| AppError::new(format!("failed to read config line: {error}")))?
        == 0
    {
        return invalid("input is empty");
    }
    let config_value: Value = serde_json::from_str(&line)
        .map_err(|error| AppError::new(format!("invalid config JSON on line 1: {error}")))?;
    let config = parse_config(&config_value)?;
    let mut aggregator = Aggregator::new(&config);

    let mut line_number = 1_u64;
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(|error| AppError::new(format!("failed to read input: {error}")))?;
        if read == 0 {
            break;
        }
        line_number += 1;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&line).map_err(|error| {
            AppError::new(format!(
                "invalid sample JSON on line {line_number}: {error}"
            ))
        })?;
        let sample = parse_sample(&value).map_err(|error| {
            AppError::new(format!("invalid sample on line {line_number}: {error}"))
        })?;
        aggregator.consume(sample, &config).map_err(|error| {
            AppError::new(format!("failed to aggregate line {line_number}: {error}"))
        })?;
    }

    write_output(output, &aggregator.finish(&config), &config)?;
    output
        .write_all(b"\n")
        .map_err(|error| AppError::new(format!("failed to finish output: {error}")))
}

fn write_output(writer: &mut impl Write, output: &Output, config: &Config) -> Result<()> {
    writer.write_all(b"{\"groups\":")?;
    write_groups(writer, &output.groups)?;
    writer.write_all(b",\"models\":")?;
    write_models(writer, &output.models)?;
    writer.write_all(b",\"coverage\":")?;
    write_full_coverage(
        writer,
        &output.coverage,
        &output.coverage_by_source,
        &output.coverage_by_group,
        config,
    )?;
    writer.write_all(b",\"codexTimingCoverage\":")?;
    if let Some(coverage) = output.codex_timing_coverage.as_ref() {
        write_codex_timing_coverage(writer, coverage, config)?;
    } else {
        writer.write_all(b"null")?;
    }
    writer.write_all(b",\"meta\":")?;
    write_meta(writer, &output.meta)?;
    writer.write_all(b"}")?;
    Ok(())
}

fn write_groups(writer: &mut impl Write, groups: &[GroupRow]) -> Result<()> {
    writer.write_all(b"[")?;
    for (index, group) in groups.iter().enumerate() {
        if index != 0 {
            writer.write_all(b",")?;
        }
        writer.write_all(b"{\"groupKey\":")?;
        write_json(writer, &group.key)?;
        writer.write_all(b",\"sourceKind\":")?;
        write_json(writer, &group.identity.source_kind)?;
        writer.write_all(b",\"homeId\":")?;
        write_json(writer, &group.identity.home_id)?;
        writer.write_all(b",\"channel\":")?;
        write_json(writer, &group.identity.channel)?;
        writer.write_all(b",\"agentKind\":")?;
        write_json(writer, &group.identity.agent_kind)?;
        writer.write_all(b",\"agent\":")?;
        write_json(writer, &group.identity.agent)?;
        writer.write_all(b",\"model\":")?;
        write_json(writer, &group.identity.model)?;
        writer.write_all(b",\"modelProvider\":")?;
        write_json(writer, &group.identity.model_provider)?;
        writer.write_all(b",\"reasoningEffort\":")?;
        write_json(writer, &group.identity.reasoning_effort)?;
        writer.write_all(b",\"timingKind\":")?;
        write_json(writer, &group.identity.timing_kind)?;
        writer.write_all(b",\"tokenScope\":")?;
        write_json(writer, &group.identity.token_scope)?;
        writer.write_all(b",\"n\":")?;
        write_u64(writer, group.n)?;
        writer.write_all(b",\"tps\":{\"p10\":")?;
        write_optional_number(writer, group.tps_p10)?;
        writer.write_all(b",\"p50\":")?;
        write_optional_number(writer, group.tps_p50)?;
        writer.write_all(b",\"p90\":")?;
        write_optional_number(writer, group.tps_p90)?;
        writer.write_all(b",\"pooled\":")?;
        write_optional_number(writer, group.tps_pooled)?;
        writer.write_all(b"},\"durationMs\":{\"p50\":")?;
        write_optional_number(writer, group.duration_p50)?;
        writer.write_all(b",\"p90\":")?;
        write_optional_number(writer, group.duration_p90)?;
        writer.write_all(b"},\"sums\":{\"outputTokens\":")?;
        write_optional_number(writer, group.sum_output_tokens)?;
        writer.write_all(b",\"durationMs\":")?;
        write_optional_number(writer, group.sum_duration_ms)?;
        writer.write_all(b"},\"state\":")?;
        write_json(writer, if group.overflow { "overflow" } else { "ok" })?;
        writer.write_all(b",\"rank\":")?;
        write_optional_u64(writer, group.rank)?;
        writer.write_all(b",\"insufficientSamples\":")?;
        write_bool(writer, group.insufficient_samples)?;
        writer.write_all(b",\"warnings\":")?;
        if group.overflow {
            writer.write_all(b"[\"AGGREGATE_OVERFLOW\"]")?;
        } else {
            writer.write_all(b"[]")?;
        }
        writer.write_all(b"}")?;
    }
    writer.write_all(b"]")?;
    Ok(())
}

fn write_models(writer: &mut impl Write, models: &[ModelRow]) -> Result<()> {
    writer.write_all(b"[")?;
    for (index, model) in models.iter().enumerate() {
        if index != 0 {
            writer.write_all(b",")?;
        }
        writer.write_all(b"{\"key\":")?;
        write_json(writer, &model.key)?;
        writer.write_all(b",\"sourceKind\":")?;
        write_json(writer, &model.identity.source_kind)?;
        writer.write_all(b",\"model\":")?;
        write_json(writer, &model.identity.model)?;
        writer.write_all(b",\"reasoningEffort\":")?;
        write_json(writer, &model.identity.reasoning_effort)?;
        writer.write_all(b",\"modelProvider\":")?;
        write_json(writer, &model.identity.model_provider)?;
        writer.write_all(b",\"window\":")?;
        write_json(writer, &model.window)?;
        writer.write_all(b",\"firstSampleAtMs\":")?;
        write_optional_number(writer, model.first_sample_at_ms)?;
        writer.write_all(b",\"lastSampleAtMs\":")?;
        write_optional_number(writer, model.last_sample_at_ms)?;
        writer.write_all(b",\"averageTps\":")?;
        write_optional_number(writer, model.average_tps)?;
        writer.write_all(b",\"p10\":")?;
        write_optional_number(writer, model.p10)?;
        writer.write_all(b",\"p90\":")?;
        write_optional_number(writer, model.p90)?;
        writer.write_all(b",\"n\":")?;
        write_u64(writer, model.n)?;
        writer.write_all(b",\"state\":")?;
        write_json(writer, model.state)?;
        writer.write_all(b",\"rankState\":")?;
        write_json(writer, model.rank_state)?;
        writer.write_all(b",\"rank\":")?;
        write_optional_u64(writer, model.rank)?;
        if let Some(candidate_count) = model.candidate_count {
            writer.write_all(b",\"candidateCount\":")?;
            write_u64(writer, candidate_count)?;
            writer.write_all(b",\"firstCandidateAtMs\":")?;
            write_optional_number(writer, model.first_candidate_at_ms)?;
            writer.write_all(b",\"lastCandidateAtMs\":")?;
            write_optional_number(writer, model.last_candidate_at_ms)?;
        }
        writer.write_all(b"}")?;
    }
    writer.write_all(b"]")?;
    Ok(())
}

fn write_full_coverage(
    writer: &mut impl Write,
    coverage: &CoverageBucket,
    by_source: &HashMap<String, CoverageBucket>,
    by_group: &HashMap<String, CoverageBucket>,
    config: &Config,
) -> Result<()> {
    writer.write_all(b"{")?;
    write_counts_fields(
        writer,
        &coverage.counts,
        coverage.unplaced,
        coverage.by_era(),
        config,
    )?;
    writer.write_all(b",\"bySource\":{")?;
    let mut source_keys: Vec<&String> = by_source.keys().collect();
    source_keys.sort_by(|left, right| compare_js_code_units(left, right));
    for (index, key) in source_keys.into_iter().enumerate() {
        if index != 0 {
            writer.write_all(b",")?;
        }
        write_json(writer, key)?;
        writer.write_all(b":")?;
        write_coverage_bucket(writer, by_source.get(key).expect("source key"), config)?;
    }
    writer.write_all(b"},\"byGroup\":{")?;
    let mut group_keys: Vec<&String> = by_group.keys().collect();
    group_keys.sort_by(|left, right| compare_js_code_units(left, right));
    for (index, key) in group_keys.into_iter().enumerate() {
        if index != 0 {
            writer.write_all(b",")?;
        }
        write_json(writer, key)?;
        writer.write_all(b":")?;
        write_coverage_bucket(writer, by_group.get(key).expect("group key"), config)?;
    }
    writer.write_all(b"}}")?;
    Ok(())
}

fn write_coverage_bucket(
    writer: &mut impl Write,
    coverage: &CoverageBucket,
    config: &Config,
) -> Result<()> {
    writer.write_all(b"{")?;
    write_counts_fields(
        writer,
        &coverage.counts,
        coverage.unplaced,
        coverage.by_era(),
        config,
    )?;
    writer.write_all(b"}")?;
    Ok(())
}

fn write_counts_fields(
    writer: &mut impl Write,
    counts: &Counts,
    unplaced: u64,
    by_era: Option<(&Counts, &Counts)>,
    config: &Config,
) -> Result<()> {
    writer.write_all(b"\"eligible\":")?;
    write_u64(writer, counts.eligible)?;
    writer.write_all(b",\"positiveOutput\":")?;
    write_u64(writer, counts.positive_output)?;
    writer.write_all(b",\"timedPositiveOutput\":")?;
    write_u64(writer, counts.timed_positive_output)?;
    writer.write_all(b",\"completeTimedPositiveOutput\":")?;
    write_u64(writer, counts.complete_timed_positive_output)?;
    writer.write_all(b",\"sampled\":")?;
    write_u64(writer, counts.sampled)?;
    writer.write_all(b",\"dropped\":")?;
    write_u64(writer, counts.dropped)?;
    writer.write_all(b",\"pending\":")?;
    write_u64(writer, counts.pending)?;
    writer.write_all(b",\"unplaced\":")?;
    write_u64(writer, unplaced)?;
    writer.write_all(b",\"byFlag\":{")?;
    let mut first = true;
    for (bit, name) in config.flag_names.iter().enumerate() {
        let Some(name) = name else {
            continue;
        };
        if !first {
            writer.write_all(b",")?;
        }
        first = false;
        write_json(writer, name)?;
        writer.write_all(b":")?;
        write_u64(writer, counts.by_flag[bit])?;
    }
    writer.write_all(b"},\"droppedByReason\":{")?;
    for (index, reason) in config.dropped_reasons.iter().enumerate() {
        if index != 0 {
            writer.write_all(b",")?;
        }
        write_json(writer, reason)?;
        writer.write_all(b":")?;
        write_u64(writer, counts.dropped_by_reason[index])?;
    }
    writer.write_all(b"},\"timingRate\":")?;
    write_optional_number(
        writer,
        rate_or_null(counts.timed_positive_output, counts.positive_output),
    )?;
    writer.write_all(b",\"completeTimingRate\":")?;
    write_optional_number(
        writer,
        rate_or_null(
            counts.complete_timed_positive_output,
            counts.positive_output,
        ),
    )?;
    writer.write_all(b",\"sampleRate\":")?;
    write_optional_number(writer, rate_or_null(counts.sampled, counts.eligible))?;
    writer.write_all(b",\"byEra\":")?;
    if let Some((recent, legacy)) = by_era {
        writer.write_all(b"{\"recent\":")?;
        writer.write_all(b"{")?;
        write_counts_fields(writer, recent, 0, None, config)?;
        writer.write_all(b"},\"legacy\":{")?;
        write_counts_fields(writer, legacy, 0, None, config)?;
        writer.write_all(b"}}")?;
    } else {
        writer.write_all(b"null")?;
    }
    Ok(())
}

fn write_codex_timing_coverage(
    writer: &mut impl Write,
    coverage: &CodexTimingCoverage,
    config: &Config,
) -> Result<()> {
    writer.write_all(b"{\"methodVersion\":")?;
    write_json(writer, PERF_METHOD_VERSION)?;
    writer.write_all(b",\"recordedOutputTokens\":")?;
    write_optional_number(writer, coverage.recorded_output_tokens)?;
    writer.write_all(b",\"sampledOutputTokens\":")?;
    write_optional_number(writer, coverage.sampled_output_tokens)?;
    writer.write_all(b",\"unknownOutputCandidates\":")?;
    write_u64(writer, coverage.unknown_output_candidates)?;
    writer.write_all(b",\"counts\":{")?;
    write_counts_fields(
        writer,
        &coverage.coverage.counts,
        coverage.coverage.unplaced,
        coverage.coverage.by_era(),
        config,
    )?;
    writer.write_all(b"}}")?;
    Ok(())
}

fn write_meta(writer: &mut impl Write, meta: &Meta) -> Result<()> {
    writer.write_all(b"{\"methodVersion\":")?;
    write_json(writer, &meta.method_version)?;
    writer.write_all(b",\"state\":")?;
    write_json(writer, &meta.state)?;
    writer.write_all(b",\"indexVersion\":")?;
    write_optional_string(writer, meta.index_version.as_deref())?;
    writer.write_all(b",\"indexedAt\":")?;
    write_optional_string(writer, meta.indexed_at.as_deref())?;
    writer.write_all(b",\"minSamples\":")?;
    write_number(writer, meta.min_samples)?;
    writer.write_all(b",\"longWindowMs\":")?;
    write_number(writer, meta.long_window_ms)?;
    writer.write_all(b",\"eraCutoffMs\":")?;
    write_number(writer, meta.era_cutoff_ms)?;
    writer.write_all(b",\"sourceWarnings\":[")?;
    for (index, warning) in meta.source_warnings.iter().enumerate() {
        if index != 0 {
            writer.write_all(b",")?;
        }
        writer.write_all(b"{\"sourceKind\":")?;
        write_json(writer, &warning.source_kind)?;
        writer.write_all(b",\"homeId\":")?;
        write_json(writer, &warning.home_id)?;
        writer.write_all(b",\"code\":")?;
        write_json(writer, &warning.code)?;
        writer.write_all(b",\"count\":")?;
        serde_json::to_writer(&mut *writer, &warning.count)?;
        writer.write_all(b"}")?;
    }
    writer.write_all(b"]}")?;
    Ok(())
}

fn rate_or_null(numerator: u64, denominator: u64) -> Option<f64> {
    (denominator != 0).then(|| numerator as f64 / denominator as f64)
}

fn write_json(writer: &mut impl Write, value: &str) -> Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    Ok(())
}

fn write_optional_string(writer: &mut impl Write, value: Option<&str>) -> Result<()> {
    match value {
        Some(value) => write_json(writer, value),
        None => {
            writer.write_all(b"null")?;
            Ok(())
        }
    }
}

fn write_bool(writer: &mut impl Write, value: bool) -> Result<()> {
    writer.write_all(if value { b"true" } else { b"false" })?;
    Ok(())
}

fn write_u64(writer: &mut impl Write, value: u64) -> Result<()> {
    write!(writer, "{value}")?;
    Ok(())
}

fn write_optional_u64(writer: &mut impl Write, value: Option<u64>) -> Result<()> {
    match value {
        Some(value) => write_u64(writer, value),
        None => {
            writer.write_all(b"null")?;
            Ok(())
        }
    }
}

fn write_optional_number(writer: &mut impl Write, value: Option<f64>) -> Result<()> {
    match value {
        Some(value) => write_number(writer, value),
        None => {
            writer.write_all(b"null")?;
            Ok(())
        }
    }
}

fn write_number(writer: &mut impl Write, value: f64) -> Result<()> {
    if !value.is_finite() {
        return invalid("output number is not finite");
    }
    if value == 0.0 {
        writer.write_all(b"0")?;
    } else if value.trunc() == value && value.abs() <= JS_MAX_SAFE_INTEGER {
        write!(writer, "{}", value as i64)?;
    } else {
        serde_json::to_writer(&mut *writer, &value)?;
    }
    Ok(())
}

impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

fn main() {
    if let Err(error) = main_inner() {
        eprintln!("native-perf: {error}");
        std::process::exit(1);
    }
}

fn main_inner() -> Result<()> {
    let mut input = None;
    let mut pid_file = None;
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--input" => {
                input = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| AppError::new("--input requires a path"))?,
                ));
            }
            "--pid-file" => {
                pid_file =
                    Some(PathBuf::from(arguments.next().ok_or_else(|| {
                        AppError::new("--pid-file requires a path")
                    })?));
            }
            "--help" | "-h" => {
                println!("Usage: native-perf --input PATH [--pid-file PATH]");
                return Ok(());
            }
            other => return invalid(format!("unknown argument {other:?}")),
        }
    }
    let input = input.ok_or_else(|| AppError::new("--input is required"))?;
    if let Some(pid_file) = pid_file {
        fs::write(&pid_file, std::process::id().to_string()).map_err(|error| {
            AppError::new(format!(
                "failed to write pid file {}: {error}",
                pid_file.display()
            ))
        })?;
    }
    let stdout = io::stdout();
    let mut output = BufWriter::new(stdout.lock());
    run(&input, &mut output)?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_unit_order_uses_utf16_not_utf8() {
        assert_eq!(
            compare_js_code_units("\u{10000}", "\u{E000}"),
            std::cmp::Ordering::Less
        );
        assert_eq!(
            compare_js_code_units("\u{E000}", "\u{10000}"),
            std::cmp::Ordering::Greater
        );
    }

    #[test]
    fn safe_sum_stays_overflowed_like_js_loop() {
        let mut sum = SafeSum::new();
        sum.add(JS_MAX_SAFE_INTEGER);
        sum.add(1.0);
        sum.add(-1.0);
        assert_eq!(sum.output(), None);
    }

    #[test]
    fn nearest_rank_uses_ceiling() {
        let values = [1.0, 2.0, 3.0, 4.0];
        assert_eq!(nearest_rank(&values, 0.1), Some(1.0));
        assert_eq!(nearest_rank(&values, 0.5), Some(2.0));
        assert_eq!(nearest_rank(&values, 0.9), Some(4.0));
    }

    #[test]
    fn config_defaults_are_documented_constants() {
        assert_eq!(PERF_MIN_SAMPLES, 20.0);
        assert_eq!(PERF_LONG_WINDOW_MS, 300_000.0);
    }
}

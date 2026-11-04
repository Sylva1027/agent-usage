use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::Arc;

use crate::storage::{Source, State};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const USAGE_FIELDS: [&str; 5] = ["total", "input", "cached", "output", "reasoning"];

#[derive(Debug)]
pub enum ModelError {
    Invalid(String),
    Internal(String),
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) | Self::Internal(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ModelError {}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct UsageTotals {
    pub total: u64,
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    pub reasoning: u64,
}

impl UsageTotals {
    fn add(&mut self, other: &Self) -> Result<(), ModelError> {
        for (target, value) in [
            (&mut self.total, other.total),
            (&mut self.input, other.input),
            (&mut self.cached, other.cached),
            (&mut self.output, other.output),
            (&mut self.reasoning, other.reasoning),
        ] {
            let next = target
                .checked_add(value)
                .filter(|next| *next <= MAX_SAFE_INTEGER)
                .ok_or_else(|| {
                    ModelError::Internal("aggregate exceeds the JSON safe-integer limit".into())
                })?;
            *target = next;
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCommit {
    source_id: String,
    events: Vec<Value>,
    cursor: Value,
    context: Option<Value>,
    #[serde(default, deserialize_with = "deserialize_expected_cursor")]
    expected_cursor: Option<Option<Value>>,
}

#[derive(Debug)]
pub enum ExpectedCursor {
    Any,
    Absent,
    Exact(Value),
}

#[derive(Debug)]
pub struct ValidatedCommit {
    pub source_id: String,
    pub events: Vec<Value>,
    pub cursor: Value,
    pub context: Option<Value>,
    pub expected_cursor: ExpectedCursor,
}

#[derive(Clone, Debug, Default)]
pub struct Filters {
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    pub exclude_homes: HashSet<String>,
    pub snapshot: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ReportResponse {
    pub revision: u64,
    pub events: Vec<Value>,
    pub context: Value,
    pub cursors: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct CursorsResponse {
    pub revision: u64,
    pub cursors: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize)]
pub struct ChangesResponse {
    pub revision: u64,
    pub reset: bool,
    pub sources: Vec<SourceDelta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDelta {
    pub source_id: String,
    pub events: Vec<Value>,
    pub cursor: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResponse {
    pub revision: u64,
    pub event_count: u64,
    pub session_count: usize,
    pub home_count: usize,
    pub totals: UsageTotals,
    pub models: Vec<GroupRow>,
    pub channels: Vec<GroupRow>,
    pub projects: Vec<GroupRow>,
    pub repositories: Vec<GroupRow>,
    pub timeline: Vec<GroupRow>,
}

#[derive(Debug, Serialize)]
pub struct GroupRow {
    pub name: String,
    pub count: u64,
    pub sessions: usize,
    pub total: UsageTotals,
}

#[derive(Debug)]
struct PreparedEvent {
    source_id: String,
    event_id: String,
    event_index: usize,
    timestamp: DateTime<Utc>,
    usage: UsageTotals,
    session_id: String,
    home_id: String,
    model: String,
    channel: String,
    project: String,
    repository: String,
}

#[derive(Debug)]
pub struct PreparedSource {
    source: Source,
    events: Vec<PreparedEvent>,
}

impl PreparedSource {
    pub fn new(source_id: &str, source: Source) -> Result<Self, ModelError> {
        let mut ids = HashSet::new();
        let mut events = Vec::with_capacity(source.events.len());
        for (event_index, event) in source.events.iter().enumerate() {
            let (event_id, timestamp, usage) = validate_event(event).map_err(|error| {
                ModelError::Internal(format!("stored event is invalid: {error}"))
            })?;
            if !ids.insert(event_id.to_owned()) {
                return Err(ModelError::Internal(format!(
                    "stored source {source_id} contains duplicate eventId {event_id}"
                )));
            }
            let object = event
                .as_object()
                .expect("validate_event accepted a non-object");
            let session_id = object["sessionId"]
                .as_str()
                .expect("validate_event accepted a non-string sessionId")
                .to_owned();
            let home_id = object["homeId"]
                .as_str()
                .expect("validate_event accepted a non-string homeId")
                .to_owned();
            events.push(PreparedEvent {
                source_id: source_id.to_owned(),
                event_id: event_id.to_owned(),
                event_index,
                timestamp,
                usage,
                session_id,
                home_id,
                model: string_or_unknown(object.get("model"), "Unknown model"),
                channel: string_or_unknown(object.get("channel"), "Unknown channel"),
                project: string_or_unknown(object.get("cwd"), "Unknown cwd"),
                repository: string_or_unknown(object.get("repositoryKey"), "Unknown repository"),
            });
        }
        Ok(Self { source, events })
    }

    pub fn source(&self) -> &Source {
        &self.source
    }
}

#[derive(Debug)]
pub struct PublishedState {
    revision: u64,
    context: Arc<Value>,
    context_revision: u64,
    cursors: BTreeMap<String, Value>,
    sources: BTreeMap<String, Arc<PreparedSource>>,
    source_revisions: BTreeMap<String, u64>,
    reset_floor: u64,
    event_count: u64,
}

impl PublishedState {
    pub fn new(state: State) -> Result<Self, ModelError> {
        let State {
            revision,
            sources,
            context,
        } = state;
        let mut cursors = BTreeMap::new();
        let mut prepared_sources = BTreeMap::new();
        let mut event_count: u64 = 0;
        for (source_id, source) in sources {
            cursors.insert(source_id.clone(), source.cursor.clone());
            let prepared = Arc::new(PreparedSource::new(&source_id, source)?);
            event_count = event_count
                .checked_add(convert_event_count(prepared.events.len())?)
                .ok_or_else(|| ModelError::Internal("event count overflow".into()))?;
            prepared_sources.insert(source_id, prepared);
        }
        Ok(Self {
            revision,
            context: Arc::new(context),
            // Storage persists only context, so restart conservatively dates it at the current revision.
            context_revision: revision,
            cursors,
            source_revisions: prepared_sources
                .keys()
                .map(|source_id| (source_id.clone(), revision))
                .collect(),
            reset_floor: revision,
            sources: prepared_sources,
            event_count,
        })
    }

    #[cfg(test)]
    pub fn from_commit(state: State, previous: &Self, source_id: &str) -> Result<Self, ModelError> {
        let State {
            revision,
            mut sources,
            context,
        } = state;
        let source = sources.remove(source_id).ok_or_else(|| {
            ModelError::Internal(format!(
                "committed state does not contain source {source_id}"
            ))
        })?;
        let context = (context != *previous.context).then_some(context);
        Self::from_prepared_commit(
            revision,
            source_id,
            PreparedSource::new(source_id, source)?,
            context,
            previous,
        )
    }

    pub fn from_prepared_commit(
        revision: u64,
        source_id: &str,
        prepared: PreparedSource,
        context: Option<Value>,
        previous: &Self,
    ) -> Result<Self, ModelError> {
        let context_changed = context.is_some();
        let context = context.map_or_else(|| Arc::clone(&previous.context), Arc::new);
        let mut cursors = previous.cursors.clone();
        cursors.insert(source_id.to_owned(), prepared.source.cursor.clone());
        let mut source_revisions = previous.source_revisions.clone();
        source_revisions.insert(source_id.to_owned(), revision);
        let previous_event_count = previous
            .sources
            .get(source_id)
            .map_or(Ok(0), |source| convert_event_count(source.events.len()))?;
        let next_event_count = convert_event_count(prepared.events.len())?;
        let event_count = previous
            .event_count
            .checked_sub(previous_event_count)
            .and_then(|count| count.checked_add(next_event_count))
            .ok_or_else(|| ModelError::Internal("event count overflow".into()))?;
        let mut sources = previous.sources.clone();
        sources.insert(source_id.to_owned(), Arc::new(prepared));
        Ok(Self {
            revision,
            context,
            context_revision: if context_changed {
                revision
            } else {
                previous.context_revision
            },
            cursors,
            sources,
            source_revisions,
            reset_floor: previous.reset_floor,
            event_count,
        })
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn event_count(&self) -> Result<u64, ModelError> {
        Ok(self.event_count)
    }

    pub fn cursor(&self, source_id: &str) -> Option<&Value> {
        self.cursors.get(source_id)
    }
}

fn convert_event_count(event_count: usize) -> Result<u64, ModelError> {
    u64::try_from(event_count).map_err(|_| ModelError::Internal("event count overflow".into()))
}

fn sorted_event_rows(state: &PublishedState) -> Vec<&PreparedEvent> {
    let mut rows: Vec<_> = state
        .sources
        .values()
        .flat_map(|source| source.events.iter())
        .collect();
    rows.sort_by(|left, right| {
        left.timestamp
            .cmp(&right.timestamp)
            .then_with(|| left.source_id.cmp(&right.source_id))
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    rows
}

struct GroupAccumulator<'a> {
    count: u64,
    sessions: HashSet<&'a str>,
    total: UsageTotals,
}

pub fn parse_commit(body: &[u8]) -> Result<ValidatedCommit, ModelError> {
    let request: WireCommit = serde_json::from_slice(body)
        .map_err(|error| ModelError::Invalid(format!("invalid commit JSON: {error}")))?;
    if request.source_id.trim().is_empty() {
        return Err(ModelError::Invalid("sourceId must not be empty".into()));
    }

    let mut ids = HashSet::new();
    for event in &request.events {
        let (event_id, _, _) = validate_event(event)?;
        if !ids.insert(event_id.to_owned()) {
            return Err(ModelError::Invalid(format!(
                "duplicate eventId in source {}: {event_id}",
                request.source_id
            )));
        }
    }

    Ok(ValidatedCommit {
        source_id: request.source_id,
        events: request.events,
        cursor: request.cursor,
        context: request.context,
        expected_cursor: match request.expected_cursor {
            None => ExpectedCursor::Any,
            Some(None) => ExpectedCursor::Absent,
            Some(Some(cursor)) => ExpectedCursor::Exact(cursor),
        },
    })
}

fn deserialize_expected_cursor<'de, D>(deserializer: D) -> Result<Option<Option<Value>>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(Some(match value {
        Value::Null => None,
        value => Some(value),
    }))
}

pub fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, ModelError> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| ModelError::Invalid(format!("invalid ISO timestamp {value:?}: {error}")))
}

pub fn report(state: &PublishedState, filters: &Filters) -> Result<ReportResponse, ModelError> {
    let events = sorted_event_rows(state)
        .into_iter()
        .filter(|row| matches_filters(row, filters))
        .map(|row| state.sources[&row.source_id].source.events[row.event_index].clone())
        .collect();

    Ok(ReportResponse {
        revision: state.revision,
        events,
        context: state.context.as_ref().clone(),
        cursors: state.cursors.clone(),
    })
}

pub fn cursors(state: &PublishedState) -> CursorsResponse {
    CursorsResponse {
        revision: state.revision,
        cursors: state.cursors.clone(),
    }
}

pub fn changes(state: &PublishedState, since: Option<u64>) -> Result<ChangesResponse, ModelError> {
    changes_with_context(state, since, None)
}

pub fn changes_with_context(
    state: &PublishedState,
    since: Option<u64>,
    context_since: Option<u64>,
) -> Result<ChangesResponse, ModelError> {
    if let Some(since) = since
        && since > state.revision
    {
        return Err(ModelError::Invalid(format!(
            "since must not exceed current revision {}",
            state.revision
        )));
    }
    if let Some(context_since) = context_since
        && context_since > state.revision
    {
        return Err(ModelError::Invalid(format!(
            "contextSince must not exceed current revision {}",
            state.revision
        )));
    }
    let reset = since.is_none_or(|since| since < state.reset_floor);
    let sources = state
        .sources
        .iter()
        .filter(|(source_id, _)| {
            since.is_none_or(|since| {
                reset
                    || state
                        .source_revisions
                        .get(*source_id)
                        .is_none_or(|revision| *revision > since)
            })
        })
        .map(|(source_id, source)| SourceDelta {
            source_id: source_id.clone(),
            events: source.source.events.clone(),
            cursor: source.source.cursor.clone(),
        })
        .collect();
    let context = (reset
        || context_since.is_none_or(|context_since| state.context_revision > context_since))
    .then(|| state.context.as_ref().clone());

    Ok(ChangesResponse {
        revision: state.revision,
        reset,
        sources,
        context,
    })
}

pub fn query(state: &PublishedState, filters: &Filters) -> Result<QueryResponse, ModelError> {
    let rows: Vec<_> = sorted_event_rows(state)
        .into_iter()
        .filter(|row| matches_filters(row, filters))
        .collect();

    let event_count = u64::try_from(rows.len())
        .map_err(|_| ModelError::Internal("event count overflow".into()))?;
    let session_count = rows
        .iter()
        .map(|row| row.session_id.as_str())
        .collect::<HashSet<_>>()
        .len();
    let home_count = rows
        .iter()
        .map(|row| row.home_id.as_str())
        .collect::<HashSet<_>>()
        .len();

    let mut totals = UsageTotals::default();
    for row in &rows {
        totals.add(&row.usage)?;
    }

    let models = grouped_rows(&rows, |row| row.model.clone())?;
    let channels = grouped_rows(&rows, |row| row.channel.clone())?;
    let projects = grouped_rows(&rows, |row| row.project.clone())?;
    let repositories = grouped_rows(&rows, |row| row.repository.clone())?;
    let mut timeline = grouped_rows(&rows, |row| row.timestamp.format("%Y-%m-%d").to_string())?;
    timeline.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(QueryResponse {
        revision: state.revision,
        event_count,
        session_count,
        home_count,
        totals,
        models,
        channels,
        projects,
        repositories,
        timeline,
    })
}

fn validate_event(event: &Value) -> Result<(&str, DateTime<Utc>, UsageTotals), ModelError> {
    let object = event
        .as_object()
        .ok_or_else(|| ModelError::Invalid("event must be an object".into()))?;
    let event_id = required_string(object.get("eventId"), "eventId")?;
    if event_id.trim().is_empty() {
        return Err(ModelError::Invalid("eventId must not be empty".into()));
    }
    let timestamp = required_string(object.get("timestamp"), "timestamp")?;
    let timestamp = parse_timestamp(timestamp)?;
    let session_id = required_string(object.get("sessionId"), "sessionId")?;
    if session_id.is_empty() {
        return Err(ModelError::Invalid("sessionId must not be empty".into()));
    }
    let home_id = required_string(object.get("homeId"), "homeId")?;
    if home_id.is_empty() {
        return Err(ModelError::Invalid("homeId must not be empty".into()));
    }

    let total = object
        .get("total")
        .and_then(Value::as_object)
        .ok_or_else(|| ModelError::Invalid("event total must be an object".into()))?;
    let mut values = HashMap::new();
    for field in USAGE_FIELDS {
        let value = total
            .get(field)
            .and_then(Value::as_u64)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                ModelError::Invalid(format!(
                    "event total.{field} must be a non-negative safe integer"
                ))
            })?;
        values.insert(field, value);
    }
    let usage = UsageTotals {
        total: values["total"],
        input: values["input"],
        cached: values["cached"],
        output: values["output"],
        reasoning: values["reasoning"],
    };
    Ok((event_id, timestamp, usage))
}

fn required_string<'a>(value: Option<&'a Value>, field: &str) -> Result<&'a str, ModelError> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| ModelError::Invalid(format!("event {field} must be a string")))
}

fn string_or_unknown(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn matches_filters(row: &PreparedEvent, filters: &Filters) -> bool {
    filters.start.is_none_or(|start| row.timestamp >= start)
        && filters.end.is_none_or(|end| row.timestamp <= end)
        && !filters.exclude_homes.contains(&row.home_id)
}

fn grouped_rows<'a>(
    rows: &[&'a PreparedEvent],
    name_for: impl Fn(&PreparedEvent) -> String,
) -> Result<Vec<GroupRow>, ModelError> {
    let mut groups: BTreeMap<String, GroupAccumulator<'a>> = BTreeMap::new();
    for &row in rows {
        let name = name_for(row);
        let group = groups.entry(name).or_insert_with(|| GroupAccumulator {
            count: 0,
            sessions: HashSet::new(),
            total: UsageTotals::default(),
        });
        group.count = group
            .count
            .checked_add(1)
            .ok_or_else(|| ModelError::Internal("group count overflow".into()))?;
        group.sessions.insert(row.session_id.as_str());
        group.total.add(&row.usage)?;
    }

    let mut rows: Vec<_> = groups
        .into_iter()
        .map(|(name, group)| GroupRow {
            name,
            count: group.count,
            sessions: group.sessions.len(),
            total: group.total,
        })
        .collect();
    rows.sort_by(|left, right| {
        right
            .total
            .total
            .cmp(&left.total.total)
            .then_with(|| left.name.encode_utf16().cmp(right.name.encode_utf16()))
    });
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(id: &str, timestamp: &str, home: &str, total: u64) -> Value {
        json!({
            "eventId": id,
            "timestamp": timestamp,
            "sessionId": format!("session-{id}"),
            "homeId": home,
            "model": "model-a",
            "channel": "channel-a",
            "cwd": "repo",
            "repositoryKey": "repository-a",
            "total": {
                "total": total,
                "input": total,
                "cached": 0,
                "output": 0,
                "reasoning": 0
            }
        })
    }

    #[test]
    fn rejects_unsafe_and_duplicate_integers() {
        let unsafe_event = event("a", "2026-11-01T00:00:00Z", "home-a", MAX_SAFE_INTEGER + 1);
        let body = serde_json::to_vec(&json!({
            "sourceId": "source-a",
            "events": [unsafe_event],
            "cursor": null
        }))
        .unwrap();
        assert!(matches!(
            parse_commit(&body).unwrap_err(),
            ModelError::Invalid(_)
        ));

        let duplicate = event("same", "2026-11-01T00:00:00Z", "home-a", 1);
        let body = serde_json::to_vec(&json!({
            "sourceId": "source-a",
            "events": [duplicate.clone(), duplicate],
            "cursor": null
        }))
        .unwrap();
        assert!(matches!(
            parse_commit(&body).unwrap_err(),
            ModelError::Invalid(_)
        ));
    }

    #[test]
    fn expected_cursor_distinguishes_missing_null_and_value() {
        let event = event("a", "2026-11-01T00:00:00Z", "home-a", 1);
        let missing = serde_json::to_vec(&json!({
            "sourceId": "source-a",
            "events": [event.clone()],
            "cursor": {"offset": 1}
        }))
        .unwrap();
        assert!(matches!(
            parse_commit(&missing).unwrap().expected_cursor,
            ExpectedCursor::Any
        ));

        let null = serde_json::to_vec(&json!({
            "sourceId": "source-a",
            "events": [event.clone()],
            "cursor": {"offset": 1},
            "expectedCursor": null
        }))
        .unwrap();
        assert!(matches!(
            parse_commit(&null).unwrap().expected_cursor,
            ExpectedCursor::Absent
        ));

        let exact = serde_json::to_vec(&json!({
            "sourceId": "source-a",
            "events": [event],
            "cursor": {"offset": 1},
            "expectedCursor": {"offset": 0}
        }))
        .unwrap();
        match parse_commit(&exact).unwrap().expected_cursor {
            ExpectedCursor::Exact(cursor) => assert_eq!(cursor, json!({"offset": 0})),
            other => panic!("expected exact cursor, got {other:?}"),
        }
    }

    #[test]
    fn changes_track_source_revisions_and_restart_reset_floor() {
        let initial_sources = BTreeMap::from([
            (
                "source-a".into(),
                crate::storage::Source {
                    events: vec![event("early", "2026-11-01T00:00:00Z", "home-a", 1)],
                    cursor: json!({"offset": 1}),
                },
            ),
            (
                "source-b".into(),
                crate::storage::Source {
                    events: vec![event("other", "2026-11-01T00:00:00Z", "home-b", 2)],
                    cursor: json!({"offset": 2}),
                },
            ),
        ]);
        let initial = PublishedState::new(State {
            revision: 1,
            sources: initial_sources.clone(),
            context: json!({"marker": "initial"}),
        })
        .unwrap();
        let full = changes(&initial, None).unwrap();
        assert!(full.reset);
        assert_eq!(full.sources.len(), 2);

        let incremental = PublishedState::from_commit(
            State {
                revision: 2,
                sources: BTreeMap::from([
                    (
                        "source-a".into(),
                        crate::storage::Source {
                            events: vec![event("late", "2026-11-02T00:00:00Z", "home-a", 3)],
                            cursor: json!({"offset": 3}),
                        },
                    ),
                    ("source-b".into(), initial_sources["source-b"].clone()),
                ]),
                context: json!({"marker": "incremental"}),
            },
            &initial,
            "source-a",
        )
        .unwrap();
        let delta = changes(&incremental, Some(1)).unwrap();
        assert!(!delta.reset);
        assert_eq!(delta.sources.len(), 1);
        assert_eq!(delta.sources[0].source_id, "source-a");
        assert_eq!(delta.sources[0].events.len(), 1);
        assert_eq!(
            delta.context.as_ref(),
            Some(&json!({"marker": "incremental"}))
        );

        let empty = PublishedState::from_commit(
            State {
                revision: 3,
                sources: BTreeMap::from([
                    (
                        "source-a".into(),
                        crate::storage::Source {
                            events: Vec::new(),
                            cursor: json!({"offset": 4}),
                        },
                    ),
                    ("source-b".into(), initial_sources["source-b"].clone()),
                ]),
                context: json!({"marker": "empty"}),
            },
            &incremental,
            "source-a",
        )
        .unwrap();
        let empty_delta = changes(&empty, Some(2)).unwrap();
        assert!(!empty_delta.reset);
        assert_eq!(empty_delta.sources.len(), 1);
        assert_eq!(empty_delta.sources[0].source_id, "source-a");
        assert!(empty_delta.sources[0].events.is_empty());
        assert_eq!(empty_delta.sources[0].cursor, json!({"offset": 4}));

        let restarted = PublishedState::new(State {
            revision: 3,
            sources: BTreeMap::from([
                (
                    "source-a".into(),
                    crate::storage::Source {
                        events: Vec::new(),
                        cursor: json!({"offset": 4}),
                    },
                ),
                ("source-b".into(), initial_sources["source-b"].clone()),
            ]),
            context: json!({"marker": "empty"}),
        })
        .unwrap();
        let reset = changes(&restarted, Some(2)).unwrap();
        assert!(reset.reset);
        assert_eq!(reset.sources.len(), 2);
        assert!(matches!(
            changes(&restarted, Some(4)).unwrap_err(),
            ModelError::Invalid(_)
        ));
    }

    #[test]
    fn incremental_publication_keeps_source_blocks_and_updates_event_count() {
        let initial = PublishedState::new(State {
            revision: 1,
            sources: BTreeMap::from([
                (
                    "source-a".into(),
                    crate::storage::Source {
                        events: vec![
                            event("a-1", "2026-11-01T00:00:00Z", "home-a", 1),
                            event("a-2", "2026-11-01T00:01:00Z", "home-a", 2),
                            event("a-3", "2026-11-01T00:02:00Z", "home-a", 3),
                        ],
                        cursor: json!({"offset": 1}),
                    },
                ),
                (
                    "source-b".into(),
                    crate::storage::Source {
                        events: vec![
                            event("b-1", "2026-11-01T01:00:00Z", "home-b", 4),
                            event("b-2", "2026-11-01T01:01:00Z", "home-b", 5),
                        ],
                        cursor: json!({"offset": 2}),
                    },
                ),
            ]),
            context: json!({"marker": "initial"}),
        })
        .unwrap();
        assert_eq!(initial.event_count, 5);
        let source_b = Arc::clone(&initial.sources["source-b"]);
        let context = Arc::clone(&initial.context);

        let source_a = crate::storage::Source {
            events: vec![event("a-4", "2026-11-02T00:00:00Z", "home-a", 6)],
            cursor: json!({"offset": 2}),
        };
        let next = PublishedState::from_prepared_commit(
            2,
            "source-a",
            PreparedSource::new("source-a", source_a).unwrap(),
            None,
            &initial,
        )
        .unwrap();
        assert!(Arc::ptr_eq(&source_b, &next.sources["source-b"]));
        assert!(Arc::ptr_eq(&context, &next.context));
        assert_eq!(next.sources["source-a"].events.len(), 1);
        assert_eq!(next.sources["source-b"].events.len(), 2);
        assert_eq!(next.event_count, 3);
        assert_eq!(next.context_revision, 1);
        assert!(
            changes_with_context(&next, Some(1), Some(1))
                .unwrap()
                .context
                .is_none()
        );

        let source_a = crate::storage::Source {
            events: Vec::new(),
            cursor: json!({"offset": 3}),
        };
        let changed_context = PublishedState::from_prepared_commit(
            3,
            "source-a",
            PreparedSource::new("source-a", source_a).unwrap(),
            Some(json!({"marker": "changed"})),
            &next,
        )
        .unwrap();
        assert!(!Arc::ptr_eq(&context, &changed_context.context));
        assert_eq!(changed_context.event_count, 2);
        assert_eq!(changed_context.context_revision, 3);
        assert_eq!(
            changes_with_context(&changed_context, Some(2), Some(2))
                .unwrap()
                .context
                .as_ref(),
            Some(&json!({"marker": "changed"}))
        );
        assert!(
            changes_with_context(&changed_context, Some(2), Some(3))
                .unwrap()
                .context
                .is_none()
        );
    }

    #[test]
    fn query_filters_utc_bounds_and_keeps_group_order() {
        let state = State {
            revision: 3,
            sources: BTreeMap::from([(
                "source-a".into(),
                crate::storage::Source {
                    events: vec![
                        event("late", "2026-11-02T00:00:00Z", "home-a", 4),
                        event("early", "2026-11-01T00:00:00Z", "home-a", 2),
                    ],
                    cursor: Value::Null,
                },
            )]),
            context: Value::Null,
        };
        let filters = Filters {
            start: Some(parse_timestamp("2026-11-01T00:00:00Z").unwrap()),
            end: Some(parse_timestamp("2026-11-01T23:59:59Z").unwrap()),
            ..Filters::default()
        };
        let state = PublishedState::new(state).unwrap();
        let result = query(&state, &filters).unwrap();
        assert_eq!(result.event_count, 1);
        assert_eq!(result.totals.total, 2);
        assert_eq!(result.timeline[0].name, "2026-11-01");
    }

    #[test]
    fn session_count_does_not_combine_home_id() {
        let mut first = event("first", "2026-11-01T00:00:00Z", "home-a", 1);
        let mut second = event("second", "2026-11-01T00:01:00Z", "home-b", 2);
        let mut third = event("third", "2026-11-01T00:02:00Z", "home-c", 3);
        first["sessionId"] = json!("shared-session");
        second["sessionId"] = json!("shared-session");
        third["sessionId"] = json!("shared-session");
        let state = PublishedState::new(State {
            revision: 4,
            sources: BTreeMap::from([(
                "source-a".into(),
                crate::storage::Source {
                    events: vec![first, second, third],
                    cursor: Value::Null,
                },
            )]),
            context: Value::Null,
        })
        .unwrap();

        let result = query(&state, &Filters::default()).unwrap();
        assert_eq!(result.event_count, 3);
        assert_eq!(result.session_count, 1);
        assert_eq!(result.home_count, 3);
    }

    #[test]
    fn missing_group_fields_use_node_fallbacks() {
        let mut missing = event("missing", "2026-11-01T00:00:00Z", "home-a", 1);
        let object = missing.as_object_mut().unwrap();
        object.remove("model");
        object.remove("channel");
        object.insert("cwd".into(), json!(""));
        object.insert("repositoryKey".into(), json!(""));
        let state = PublishedState::new(State {
            revision: 5,
            sources: BTreeMap::from([(
                "source-a".into(),
                crate::storage::Source {
                    events: vec![missing],
                    cursor: Value::Null,
                },
            )]),
            context: Value::Null,
        })
        .unwrap();

        let result = query(&state, &Filters::default()).unwrap();
        assert_eq!(result.models[0].name, "Unknown model");
        assert_eq!(result.channels[0].name, "Unknown channel");
        assert_eq!(result.projects[0].name, "Unknown cwd");
        assert_eq!(result.repositories[0].name, "Unknown repository");
    }

    #[test]
    fn equal_total_group_names_sort_by_utf16_code_units() {
        let mut emoji = event("emoji", "2026-11-01T00:00:00Z", "home-a", 1);
        let mut private_use = event("private-use", "2026-11-01T00:01:00Z", "home-a", 1);
        emoji["model"] = json!("😀");
        private_use["model"] = json!("\u{e000}");
        let state = PublishedState::new(State {
            revision: 6,
            sources: BTreeMap::from([(
                "source-a".into(),
                crate::storage::Source {
                    events: vec![private_use, emoji],
                    cursor: Value::Null,
                },
            )]),
            context: Value::Null,
        })
        .unwrap();

        let result = query(&state, &Filters::default()).unwrap();
        assert_eq!(result.models[0].name, "😀");
        assert_eq!(result.models[1].name, "\u{e000}");
    }
}

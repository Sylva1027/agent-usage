use crate::model::{GroupRow, MAX_SAFE_INTEGER, QueryResponse, UsageTotals};
use crate::storage::{Source, State, Storage, StoreResult, storage_error};
use ::duckdb::{Connection, OptionalExt, ToSql, Transaction, params, params_from_iter};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

const MILLIS_PER_UTC_DAY: i64 = 86_400_000;
const UTC_DAY_BUCKET_SQL: &str =
    "CAST(CAST(FLOOR(epoch_ms(event_ts_utc) / 86400000.0) AS BIGINT) AS VARCHAR)";

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS storage_meta (
    id INTEGER PRIMARY KEY,
    revision UBIGINT NOT NULL,
    context_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    source_id VARCHAR PRIMARY KEY,
    cursor_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    source_id VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    event_ts VARCHAR NOT NULL,
    event_ts_utc TIMESTAMPTZ,
    session_id VARCHAR NOT NULL,
    home_id VARCHAR NOT NULL,
    channel VARCHAR,
    model VARCHAR,
    input_tokens UBIGINT NOT NULL,
    cached_tokens UBIGINT NOT NULL,
    output_tokens UBIGINT NOT NULL,
    reasoning_tokens UBIGINT NOT NULL,
    total_tokens UBIGINT NOT NULL,
    detail_mask UBIGINT,
    cwd VARCHAR,
    repository_key VARCHAR,
    service_tier VARCHAR,
    price_version VARCHAR,
    revision UBIGINT NOT NULL,
    payload VARCHAR NOT NULL,
    event_ordinal UBIGINT NOT NULL,
    PRIMARY KEY (source_id, event_id)
);

CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events (event_ts_utc);
CREATE INDEX IF NOT EXISTS events_home_idx ON events (home_id);
CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id);

CREATE TABLE IF NOT EXISTS snapshots (
    revision UBIGINT PRIMARY KEY,
    state_json VARCHAR NOT NULL
);
"#;

struct DuckDbStorage {
    connection: Connection,
}

struct EventRow {
    event_id: String,
    timestamp: String,
    session_id: String,
    home_id: String,
    channel: Option<String>,
    model: Option<String>,
    input: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
    total: u64,
    detail_mask: Option<u64>,
    cwd: Option<String>,
    repository_key: Option<String>,
    service_tier: Option<String>,
    price_version: Option<String>,
    payload: String,
}

pub fn open(path: &Path) -> StoreResult<Box<dyn Storage>> {
    let connection = Connection::open(path)?;
    connection.execute_batch(SCHEMA)?;
    Ok(Box::new(DuckDbStorage { connection }))
}

fn required_string(event: &Value, field: &str) -> StoreResult<String> {
    event
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| storage_error(format!("event field {field:?} must be a string")))
}

fn optional_string(event: &Value, field: &str) -> Option<String> {
    event
        .get(field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn required_u64(value: &Value, field: &str) -> StoreResult<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| storage_error(format!("event total field {field:?} must be UBIGINT")))
}

fn parse_event(event: &Value) -> StoreResult<EventRow> {
    let total = event
        .get("total")
        .ok_or_else(|| storage_error("event total must be an object"))?;
    Ok(EventRow {
        event_id: required_string(event, "eventId")?,
        timestamp: required_string(event, "timestamp")?,
        session_id: required_string(event, "sessionId")?,
        home_id: required_string(event, "homeId")?,
        channel: optional_string(event, "channel"),
        model: optional_string(event, "model"),
        input: required_u64(total, "input")?,
        cached: required_u64(total, "cached")?,
        output: required_u64(total, "output")?,
        reasoning: required_u64(total, "reasoning")?,
        total: required_u64(total, "total")?,
        detail_mask: event.get("detailMask").and_then(Value::as_u64),
        cwd: optional_string(event, "cwd"),
        repository_key: optional_string(event, "repositoryKey"),
        service_tier: optional_string(event, "serviceTier"),
        price_version: optional_string(event, "priceVersion"),
        payload: serde_json::to_string(event)
            .map_err(|error| storage_error(format!("failed to encode event payload: {error}")))?,
    })
}

fn read_meta(transaction: &Transaction<'_>) -> StoreResult<(u64, Option<String>)> {
    let row = transaction
        .query_row(
            "SELECT revision, context_json FROM storage_meta WHERE id = 0",
            [],
            |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;
    Ok(row.map_or((0, None), |(revision, context)| (revision, Some(context))))
}

fn read_revision(transaction: &Transaction<'_>) -> StoreResult<u64> {
    Ok(transaction
        .query_row(
            "SELECT revision FROM storage_meta WHERE id = 0",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

fn load_state(transaction: &Transaction<'_>) -> StoreResult<State> {
    let (revision, context_json) = read_meta(transaction)?;
    let context = match context_json {
        Some(context) => serde_json::from_str(&context)
            .map_err(|error| storage_error(format!("invalid DuckDB context JSON: {error}")))?,
        None => Value::Null,
    };

    let mut sources = BTreeMap::new();
    {
        let mut statement =
            transaction.prepare("SELECT source_id, cursor_json FROM sources ORDER BY source_id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let source_id: String = row.get(0)?;
            let cursor_json: String = row.get(1)?;
            let cursor = serde_json::from_str(&cursor_json).map_err(|error| {
                storage_error(format!(
                    "invalid cursor JSON for source {source_id:?}: {error}"
                ))
            })?;
            sources.insert(
                source_id,
                Source {
                    events: Vec::new(),
                    cursor,
                },
            );
        }
    }

    {
        let mut statement = transaction
            .prepare("SELECT source_id, payload FROM events ORDER BY source_id, event_ordinal")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let source_id: String = row.get(0)?;
            let payload: String = row.get(1)?;
            let event = serde_json::from_str(&payload).map_err(|error| {
                storage_error(format!(
                    "invalid event payload for source {source_id:?}: {error}"
                ))
            })?;
            sources
                .get_mut(&source_id)
                .ok_or_else(|| {
                    storage_error(format!("event references missing source {source_id:?}"))
                })?
                .events
                .push(event);
        }
    }

    Ok(State {
        revision,
        sources,
        context,
    })
}

fn safe_aggregate(value: u128, field: &str) -> StoreResult<u64> {
    if value > u128::from(MAX_SAFE_INTEGER) {
        return Err(storage_error(format!(
            "DuckDB aggregate {field} exceeds the JSON safe-integer limit"
        )));
    }
    Ok(value as u64)
}

fn count_to_usize(value: u64, field: &str) -> StoreResult<usize> {
    usize::try_from(value).map_err(|_| storage_error(format!("DuckDB {field} exceeds usize::MAX")))
}

fn utc_day_name(day_bucket: &str) -> StoreResult<String> {
    let bucket = day_bucket
        .parse::<i64>()
        .map_err(|error| storage_error(format!("invalid DuckDB UTC day bucket: {error}")))?;
    let day_start_ms = bucket
        .checked_mul(MILLIS_PER_UTC_DAY)
        .ok_or_else(|| storage_error("DuckDB UTC day bucket overflows millisecond timestamp"))?;
    let day = DateTime::<Utc>::from_timestamp_millis(day_start_ms)
        .ok_or_else(|| storage_error("DuckDB UTC day bucket is outside chrono's range"))?;
    Ok(day.format("%Y-%m-%d").to_string())
}

fn query_groups(
    transaction: &Transaction<'_>,
    filter_sql: &str,
    parameters: &[&dyn ToSql],
    name_expression: &str,
    timeline: bool,
) -> StoreResult<Vec<GroupRow>> {
    let order_by = if timeline { "1 ASC" } else { "4 DESC" };
    let sql = format!(
        r#"
        SELECT
            {name_expression} AS name,
            COUNT(*) AS event_count,
            COUNT(DISTINCT session_id) AS session_count,
            COALESCE(SUM(total_tokens), 0) AS total,
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(cached_tokens), 0) AS cached,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(reasoning_tokens), 0) AS reasoning
        FROM events
        {filter_sql}
        GROUP BY 1
        ORDER BY {order_by}
        "#
    );
    let mut statement = transaction.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(parameters.iter().copied()))?;
    let mut groups = Vec::new();
    while let Some(row) = rows.next()? {
        groups.push(GroupRow {
            name: row.get(0)?,
            count: row.get(1)?,
            sessions: count_to_usize(row.get(2)?, "group session count")?,
            total: UsageTotals {
                total: safe_aggregate(row.get(3)?, "total")?,
                input: safe_aggregate(row.get(4)?, "input")?,
                cached: safe_aggregate(row.get(5)?, "cached")?,
                output: safe_aggregate(row.get(6)?, "output")?,
                reasoning: safe_aggregate(row.get(7)?, "reasoning")?,
            },
        });
    }
    if !timeline {
        groups.sort_by(|left, right| {
            right
                .total
                .total
                .cmp(&left.total.total)
                .then_with(|| left.name.encode_utf16().cmp(right.name.encode_utf16()))
        });
    }
    Ok(groups)
}

impl DuckDbStorage {
    fn with_transaction<T>(
        &mut self,
        operation: impl FnOnce(&Transaction<'_>) -> StoreResult<T>,
    ) -> StoreResult<T> {
        let transaction = self.connection.transaction()?;
        match operation(&transaction) {
            Ok(value) => {
                transaction.commit()?;
                Ok(value)
            }
            Err(error) => {
                let _ = transaction.rollback();
                Err(error)
            }
        }
    }
}

impl Storage for DuckDbStorage {
    fn load(&mut self, snapshot: Option<u64>) -> StoreResult<State> {
        self.with_transaction(|transaction| {
            if let Some(revision) = snapshot {
                let state_json = transaction
                    .query_row(
                        "SELECT state_json FROM snapshots WHERE revision = ?",
                        params![revision],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?
                    .ok_or_else(|| {
                        storage_error(format!("DuckDB snapshot {revision} does not exist"))
                    })?;
                let state: State = serde_json::from_str(&state_json).map_err(|error| {
                    storage_error(format!("invalid DuckDB snapshot {revision}: {error}"))
                })?;
                if state.revision != revision {
                    return Err(storage_error(format!(
                        "DuckDB snapshot {revision} contains revision {}",
                        state.revision
                    )));
                }
                Ok(state)
            } else {
                load_state(transaction)
            }
        })
    }

    fn commit_delta(
        &mut self,
        source_id: &str,
        source: &Source,
        context: Option<&Value>,
    ) -> StoreResult<u64> {
        self.with_transaction(|transaction| {
            let current_revision = read_revision(transaction)?;
            let next_revision = current_revision
                .checked_add(1)
                .ok_or_else(|| storage_error("DuckDB revision overflow"))?;
            let context_json = context
                .map(|context| {
                    serde_json::to_string(context).map_err(|error| {
                        storage_error(format!("failed to encode context: {error}"))
                    })
                })
                .transpose()?;
            let cursor_json = serde_json::to_string(&source.cursor)
                .map_err(|error| storage_error(format!("failed to encode cursor: {error}")))?;
            let rows = source
                .events
                .iter()
                .map(parse_event)
                .collect::<StoreResult<Vec<_>>>()?;

            transaction.execute("DELETE FROM events WHERE source_id = ?", params![source_id])?;
            transaction.execute(
                "DELETE FROM sources WHERE source_id = ?",
                params![source_id],
            )?;
            transaction.execute(
                "INSERT INTO sources (source_id, cursor_json) VALUES (?, ?)",
                params![source_id, cursor_json],
            )?;

            {
                let mut insert_event = transaction.prepare(
                    r#"
                    INSERT INTO events (
                        source_id, event_id, event_ts, event_ts_utc,
                        session_id, home_id, channel, model,
                        input_tokens, cached_tokens, output_tokens,
                        reasoning_tokens, total_tokens, detail_mask,
                        cwd, repository_key, service_tier, price_version,
                        revision, payload, event_ordinal
                    ) VALUES (
                        ?, ?, ?, TRY_CAST(? AS TIMESTAMPTZ),
                        ?, ?, ?, ?,
                        ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?,
                        ?, ?, ?
                    )
                    "#,
                )?;
                for (ordinal, row) in rows.into_iter().enumerate() {
                    insert_event.execute(params![
                        source_id,
                        row.event_id,
                        row.timestamp,
                        row.timestamp,
                        row.session_id,
                        row.home_id,
                        row.channel,
                        row.model,
                        row.input,
                        row.cached,
                        row.output,
                        row.reasoning,
                        row.total,
                        row.detail_mask,
                        row.cwd,
                        row.repository_key,
                        row.service_tier,
                        row.price_version,
                        next_revision,
                        row.payload,
                        ordinal as u64,
                    ])?;
                }
            }

            if let Some(context_json) = context_json {
                transaction.execute("DELETE FROM storage_meta WHERE id = 0", [])?;
                transaction.execute(
                    "INSERT INTO storage_meta (id, revision, context_json) VALUES (0, ?, ?)",
                    params![next_revision, context_json],
                )?;
            } else {
                let updated = transaction.execute(
                    "UPDATE storage_meta SET revision = ? WHERE id = 0",
                    params![next_revision],
                )?;
                if updated == 0 {
                    transaction.execute(
                        "INSERT INTO storage_meta (id, revision, context_json) VALUES (0, ?, 'null')",
                        params![next_revision],
                    )?;
                }
            }

            Ok(next_revision)
        })
    }

    fn commit(
        &mut self,
        source_id: &str,
        source: &Source,
        context: Option<&Value>,
    ) -> StoreResult<State> {
        self.commit_delta(source_id, source, context)?;
        self.load(None)
    }

    fn freeze(&mut self) -> StoreResult<u64> {
        self.with_transaction(|transaction| {
            let state = load_state(transaction)?;
            let state_json = serde_json::to_string(&state)
                .map_err(|error| storage_error(format!("failed to encode snapshot: {error}")))?;
            transaction.execute(
                "DELETE FROM snapshots WHERE revision = ?",
                params![state.revision],
            )?;
            transaction.execute(
                "INSERT INTO snapshots (revision, state_json) VALUES (?, ?)",
                params![state.revision, state_json],
            )?;
            Ok(state.revision)
        })
    }

    fn query_current(
        &mut self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        excluded_homes: &[String],
    ) -> StoreResult<Option<Value>> {
        self.with_transaction(|transaction| {
            let (revision, _) = read_meta(transaction)?;
            let mut filter_sql = String::from("WHERE TRUE");
            let mut parameters: Vec<&dyn ToSql> = Vec::new();
            if let Some(start_ms) = start_ms.as_ref() {
                filter_sql.push_str(" AND event_ts_utc >= epoch_ms(?)");
                parameters.push(start_ms);
            }
            if let Some(end_ms) = end_ms.as_ref() {
                filter_sql.push_str(" AND event_ts_utc <= epoch_ms(?)");
                parameters.push(end_ms);
            }
            for home in excluded_homes {
                filter_sql.push_str(" AND home_id NOT IN (?)");
                parameters.push(home);
            }

            let summary_sql = format!(
                r#"
                SELECT
                    COUNT(*),
                    COUNT(DISTINCT session_id),
                    COUNT(DISTINCT home_id),
                    COALESCE(SUM(total_tokens), 0),
                    COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(cached_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(reasoning_tokens), 0)
                FROM events
                {filter_sql}
                "#
            );
            let (
                event_count,
                session_count,
                home_count,
                total,
                input,
                cached,
                output,
                reasoning,
            ): (u64, u64, u64, u128, u128, u128, u128, u128) = transaction.query_row(
                &summary_sql,
                params_from_iter(parameters.iter().copied()),
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )?;

            let response = QueryResponse {
                revision,
                event_count,
                session_count: count_to_usize(session_count, "session count")?,
                home_count: count_to_usize(home_count, "home count")?,
                totals: UsageTotals {
                    total: safe_aggregate(total, "total")?,
                    input: safe_aggregate(input, "input")?,
                    cached: safe_aggregate(cached, "cached")?,
                    output: safe_aggregate(output, "output")?,
                    reasoning: safe_aggregate(reasoning, "reasoning")?,
                },
                models: query_groups(
                    transaction,
                    &filter_sql,
                    &parameters,
                    "COALESCE(NULLIF(model, ''), 'Unknown model')",
                    false,
                )?,
                channels: query_groups(
                    transaction,
                    &filter_sql,
                    &parameters,
                    "COALESCE(NULLIF(channel, ''), 'Unknown channel')",
                    false,
                )?,
                projects: query_groups(
                    transaction,
                    &filter_sql,
                    &parameters,
                    "COALESCE(NULLIF(cwd, ''), 'Unknown cwd')",
                    false,
                )?,
                repositories: query_groups(
                    transaction,
                    &filter_sql,
                    &parameters,
                    "COALESCE(NULLIF(repository_key, ''), 'Unknown repository')",
                    false,
                )?,
                timeline: {
                    let mut timeline = query_groups(
                        transaction,
                        &filter_sql,
                        &parameters,
                        UTC_DAY_BUCKET_SQL,
                        true,
                    )?;
                    for group in &mut timeline {
                        group.name = utc_day_name(&group.name)?;
                    }
                    timeline.sort_by(|left, right| left.name.cmp(&right.name));
                    timeline
                },
            };
            serde_json::to_value(response)
                .map(Some)
                .map_err(|error| storage_error(format!("failed to encode query response: {error}")))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{self, Filters, PublishedState};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let nonce = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "codex-usage-duckdb-{name}-{}-{nanos}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp dir");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn event(id: &str, total: u64) -> Value {
        json!({
            "eventId": id,
            "timestamp": "2026-11-01T12:00:00.000Z",
            "sessionId": "session-a",
            "homeId": "codex",
            "homeLabel": "Codex",
            "channel": "Codex",
            "model": "gpt-6",
            "cwd": "/work/project",
            "total": {
                "total": total,
                "input": total,
                "cached": 0,
                "output": 0,
                "reasoning": 0
            }
        })
    }

    fn query_event(
        id: &str,
        timestamp: &str,
        session_id: &str,
        home_id: &str,
        model: Option<&str>,
        channel: Option<&str>,
        cwd: Option<&str>,
        repository_key: Option<&str>,
        usage: [u64; 5],
    ) -> Value {
        let mut event = json!({
            "eventId": id,
            "timestamp": timestamp,
            "sessionId": session_id,
            "homeId": home_id,
            "total": {
                "total": usage[0],
                "input": usage[1],
                "cached": usage[2],
                "output": usage[3],
                "reasoning": usage[4]
            }
        });
        let object = event.as_object_mut().expect("event object");
        for (field, value) in [
            ("model", model),
            ("channel", channel),
            ("cwd", cwd),
            ("repositoryKey", repository_key),
        ] {
            if let Some(value) = value {
                object.insert(field.to_owned(), Value::String(value.to_owned()));
            }
        }
        event
    }

    #[test]
    fn events_table_has_typed_columns_and_full_payload() {
        let temp = TempDir::new("schema");
        let path = temp.0.join("store.duckdb");
        let mut store = open(&path).expect("open DuckDB");
        store
            .commit(
                "source-a",
                &Source {
                    events: vec![event("a-1", 10)],
                    cursor: json!({"offset": 1}),
                },
                Some(&json!({"generatedAt": "2026-11-01T12:00:00Z"})),
            )
            .expect("commit");
        drop(store);

        let typed = DuckDbStorage {
            connection: Connection::open(&path).expect("inspect DuckDB"),
        };
        let mut statement = typed
            .connection
            .prepare(
                "SELECT column_name, data_type \
                 FROM information_schema.columns \
                 WHERE table_name = 'events'",
            )
            .expect("describe events");
        let columns = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("query columns")
            .collect::<::duckdb::Result<BTreeMap<_, _>>>()
            .expect("collect columns");
        assert_eq!(columns["event_ts_utc"], "TIMESTAMP WITH TIME ZONE");
        assert_eq!(columns["home_id"], "VARCHAR");
        assert_eq!(columns["event_id"], "VARCHAR");
        assert_eq!(columns["total_tokens"], "UBIGINT");
        assert_eq!(columns["payload"], "VARCHAR");

        let (home, total, payload): (String, u64, String) = typed
            .connection
            .query_row(
                "SELECT home_id, total_tokens, payload FROM events WHERE event_id = 'a-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read typed event");
        assert_eq!(home, "codex");
        assert_eq!(total, 10);
        assert_eq!(
            serde_json::from_str::<Value>(&payload).unwrap(),
            event("a-1", 10)
        );
    }

    #[test]
    fn failed_replacement_rolls_back_and_snapshot_survives_reopen() {
        let temp = TempDir::new("snapshot");
        let path = temp.0.join("store.duckdb");
        let first_context = json!({"generatedAt": "2026-11-01T12:00:00Z"});

        {
            let mut store = open(&path).expect("open DuckDB");
            store
                .commit(
                    "source-a",
                    &Source {
                        events: vec![event("a-1", 10)],
                        cursor: json!({"offset": 1}),
                    },
                    Some(&first_context),
                )
                .expect("first commit");
            assert_eq!(store.freeze().expect("freeze"), 1);
            store
                .commit(
                    "source-b",
                    &Source {
                        events: vec![event("b-1", 30)],
                        cursor: json!({"offset": 7}),
                    },
                    None,
                )
                .expect("unrelated source commit");

            let failed = store.commit(
                "source-a",
                &Source {
                    events: vec![event("duplicate", 20), event("duplicate", 30)],
                    cursor: json!({"offset": 2}),
                },
                None,
            );
            assert!(failed.is_err(), "duplicate event ids must fail");

            let current = store.load(None).expect("load after failed commit");
            assert_eq!(current.revision, 2);
            assert_eq!(current.context, first_context);
            assert_eq!(current.sources.len(), 2);
            assert_eq!(current.sources["source-a"].events.len(), 1);
            assert_eq!(current.sources["source-a"].events[0]["eventId"], "a-1");
            assert_eq!(current.sources["source-a"].cursor, json!({"offset": 1}));
            assert_eq!(current.sources["source-b"].events[0]["eventId"], "b-1");
            assert_eq!(current.sources["source-b"].cursor, json!({"offset": 7}));

            store
                .commit(
                    "source-c",
                    &Source {
                        events: vec![event("c-1", 40)],
                        cursor: json!({"offset": 1}),
                    },
                    Some(&json!({"generatedAt": "later"})),
                )
                .expect("post-freeze commit");
        }

        let mut reopened = open(&path).expect("reopen DuckDB");
        let current = reopened.load(None).expect("load current");
        assert_eq!(current.revision, 3);
        assert_eq!(current.sources.len(), 3);

        let frozen = reopened.load(Some(1)).expect("load frozen");
        assert_eq!(frozen.revision, 1);
        assert_eq!(frozen.sources.len(), 1);
        assert_eq!(frozen.sources["source-a"].events[0]["eventId"], "a-1");
        assert_eq!(frozen.context, first_context);
    }

    #[test]
    fn delta_commit_does_not_read_unrelated_source() {
        let temp = TempDir::new("delta-isolation");
        let path = temp.0.join("store.duckdb");
        let connection = Connection::open(&path).expect("open DuckDB");
        connection.execute_batch(SCHEMA).expect("create schema");
        let mut store = DuckDbStorage { connection };
        store
            .commit_delta(
                "source-a",
                &Source {
                    events: vec![event("a-1", 10)],
                    cursor: json!({"offset": 1}),
                },
                Some(&json!({"marker": "a"})),
            )
            .expect("commit source-a");
        store
            .connection
            .execute(
                "UPDATE events SET payload = 'not-json' WHERE source_id = 'source-a'",
                [],
            )
            .expect("corrupt source-a");

        let revision = store
            .commit_delta(
                "source-b",
                &Source {
                    events: vec![event("b-1", 20)],
                    cursor: json!({"offset": 2}),
                },
                None,
            )
            .expect("delta commit ignores unrelated source");
        assert_eq!(revision, 2);
        let (stored_revision, cursor): (u64, String) = store
            .connection
            .query_row(
                "SELECT meta.revision, sources.cursor_json
                 FROM storage_meta AS meta
                 JOIN sources ON sources.source_id = 'source-b'
                 WHERE meta.id = 0",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read committed metadata");
        assert_eq!(stored_revision, 2);
        assert_eq!(
            serde_json::from_str::<Value>(&cursor).unwrap(),
            json!({"offset": 2})
        );
        assert!(store.load(None).is_err());
    }

    #[test]
    fn delta_commit_without_context_does_not_parse_or_rewrite_context() {
        let temp = TempDir::new("context-isolation");
        let path = temp.0.join("store.duckdb");
        let connection = Connection::open(&path).expect("open DuckDB");
        connection.execute_batch(SCHEMA).expect("create schema");
        let mut store = DuckDbStorage { connection };
        store
            .commit_delta(
                "source-a",
                &Source {
                    events: vec![event("a-1", 10)],
                    cursor: json!({"offset": 1}),
                },
                Some(&json!({"marker": "a"})),
            )
            .expect("commit source-a");
        store
            .connection
            .execute(
                "UPDATE storage_meta SET context_json = 'not-json' WHERE id = 0",
                [],
            )
            .expect("corrupt context");

        let revision = store
            .commit_delta(
                "source-b",
                &Source {
                    events: vec![event("b-1", 20)],
                    cursor: json!({"offset": 2}),
                },
                None,
            )
            .expect("context omission ignores stored context");
        assert_eq!(revision, 2);
        let (stored_revision, context_json): (u64, String) = store
            .connection
            .query_row(
                "SELECT revision, context_json FROM storage_meta WHERE id = 0",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read committed metadata");
        assert_eq!(stored_revision, 2);
        assert_eq!(context_json, "not-json");
        assert!(store.load(None).is_err());
    }

    #[test]
    fn duckdb_sql_query_matches_native_core() {
        let temp = TempDir::new("query-match");
        let path = temp.0.join("store.duckdb");
        let start_text = "1969-12-31T00:00:00.000Z";
        let end_text = "2026-11-02T00:00:00.000Z";
        let events = vec![
            query_event(
                "pre-epoch",
                "1969-12-31T23:30:00.000Z",
                "session-pre-epoch",
                "home-pre-epoch",
                Some("model-pre-epoch"),
                Some("channel-pre-epoch"),
                Some("project-pre-epoch"),
                Some("repo-pre-epoch"),
                [3, 1, 1, 1, 0],
            ),
            query_event(
                "offset-crosses-utc-day",
                "1969-12-31T23:30:00.000-02:00",
                "session-offset",
                "home-offset",
                Some("model-offset"),
                Some("channel-offset"),
                Some("project-offset"),
                Some("repo-offset"),
                [5, 2, 1, 1, 1],
            ),
            query_event(
                "excluded-at-start",
                start_text,
                "excluded-session",
                "home-a",
                Some("excluded-model"),
                None,
                None,
                None,
                [13, 4, 3, 2, 4],
            ),
            query_event(
                "empty-fallbacks",
                "2026-11-01T23:59:59.999Z",
                "session-shared",
                "home-b",
                Some(""),
                None,
                Some(""),
                Some("repo-b"),
                [7, 3, 2, 1, 1],
            ),
            query_event(
                "included-at-end",
                end_text,
                "session-shared",
                "home-c",
                Some("😀"),
                Some("channel-a"),
                Some("project-a"),
                None,
                [11, 5, 3, 2, 1],
            ),
            query_event(
                "tie-at-end",
                end_text,
                "session-solo",
                "home-b",
                Some("\u{e000}"),
                Some("channel-a"),
                Some("project-b"),
                Some("repo-b"),
                [11, 4, 4, 1, 2],
            ),
        ];
        let excluded_homes = vec!["home-a".to_owned()];
        let source = Source {
            events: events.clone(),
            cursor: json!({"offset": 4}),
        };
        let native_state = State {
            revision: 1,
            sources: BTreeMap::from([("source-a".to_owned(), source.clone())]),
            context: json!({"generatedAt": end_text}),
        };
        let filters = Filters {
            start: Some(model::parse_timestamp(start_text).expect("start timestamp")),
            end: Some(model::parse_timestamp(end_text).expect("end timestamp")),
            exclude_homes: excluded_homes.iter().cloned().collect(),
            snapshot: None,
        };
        let expected = serde_json::to_value(
            model::query(
                &PublishedState::new(native_state).expect("native state"),
                &filters,
            )
            .expect("native query"),
        )
        .expect("native JSON");
        let expected_days = expected["timeline"]
            .as_array()
            .expect("timeline array")
            .iter()
            .map(|row| row["name"].as_str().expect("timeline name"))
            .collect::<Vec<_>>();
        assert!(expected_days.contains(&"1969-12-31"));
        assert!(expected_days.contains(&"1970-01-01"));
        assert_eq!(expected["models"][0]["name"], "😀");
        assert_eq!(expected["models"][1]["name"], "\u{e000}");

        let mut store = open(&path).expect("open DuckDB");
        store
            .commit("source-a", &source, Some(&json!({"generatedAt": end_text})))
            .expect("commit");
        drop(store);
        {
            let connection = Connection::open(&path).expect("open for payload mutation");
            connection
                .execute("UPDATE events SET payload = 'not-json'", [])
                .expect("corrupt payload");
        }
        let mut store = open(&path).expect("reopen DuckDB");
        let actual = store
            .query_current(
                Some(
                    model::parse_timestamp(start_text)
                        .expect("start timestamp")
                        .timestamp_millis(),
                ),
                Some(
                    model::parse_timestamp(end_text)
                        .expect("end timestamp")
                        .timestamp_millis(),
                ),
                &excluded_homes,
            )
            .expect("DuckDB query")
            .expect("DuckDB query support");
        assert_eq!(actual, expected);
    }

    #[test]
    fn query_current_rejects_aggregate_above_safe_integer() {
        let temp = TempDir::new("query-overflow");
        let path = temp.0.join("store.duckdb");
        let mut store = open(&path).expect("open DuckDB");
        store
            .commit(
                "source-a",
                &Source {
                    events: vec![
                        event("safe-a", MAX_SAFE_INTEGER),
                        event("safe-b", MAX_SAFE_INTEGER),
                    ],
                    cursor: Value::Null,
                },
                None,
            )
            .expect("commit");

        let error = store
            .query_current(None, None, &[])
            .expect_err("unsafe aggregate must fail");
        assert!(error.to_string().contains("safe-integer limit"));
    }
}

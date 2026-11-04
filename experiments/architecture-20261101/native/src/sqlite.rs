use crate::storage::{Source, State, Storage, StoreResult};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::time::Duration;

pub struct SqliteStorage {
    connection: Connection,
}

pub fn open(path: &Path) -> StoreResult<Box<dyn Storage>> {
    let connection = Connection::open(path)?;
    Ok(Box::new(SqliteStorage::initialize(connection)?))
}

impl SqliteStorage {
    fn initialize(connection: Connection) -> StoreResult<Self> {
        connection.busy_timeout(Duration::from_secs(30))?;
        connection.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS meta (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                revision INTEGER NOT NULL CHECK (revision >= 0),
                context TEXT NOT NULL
            );
            INSERT OR IGNORE INTO meta (id, revision, context)
            VALUES (1, 0, 'null');
            CREATE TABLE IF NOT EXISTS sources (
                source_id TEXT PRIMARY KEY,
                cursor TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS source_events (
                source_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (source_id, event_id),
                FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS source_events_order
            ON source_events (source_id, position);
            CREATE TABLE IF NOT EXISTS snapshots (
                revision INTEGER PRIMARY KEY,
                context TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS snapshot_sources (
                snapshot_revision INTEGER NOT NULL,
                source_id TEXT NOT NULL,
                cursor TEXT NOT NULL,
                PRIMARY KEY (snapshot_revision, source_id),
                FOREIGN KEY (snapshot_revision) REFERENCES snapshots(revision) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS snapshot_events (
                snapshot_revision INTEGER NOT NULL,
                source_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                payload TEXT NOT NULL,
                PRIMARY KEY (snapshot_revision, source_id, event_id),
                FOREIGN KEY (snapshot_revision, source_id)
                    REFERENCES snapshot_sources(snapshot_revision, source_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS snapshot_events_order
            ON snapshot_events (snapshot_revision, source_id, position);
            COMMIT;
            ",
        )?;
        Ok(Self { connection })
    }

    #[cfg(test)]
    fn in_memory() -> StoreResult<Self> {
        Self::initialize(Connection::open_in_memory()?)
    }
}

impl Storage for SqliteStorage {
    fn load(&mut self, snapshot: Option<u64>) -> StoreResult<State> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let state = read_state(&transaction, snapshot)?;
        transaction.commit()?;
        Ok(state)
    }

    fn commit_delta(
        &mut self,
        source_id: &str,
        source: &Source,
        context: Option<&Value>,
    ) -> StoreResult<u64> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        transaction.execute(
            "INSERT INTO sources (source_id, cursor) VALUES (?1, ?2)
             ON CONFLICT(source_id) DO UPDATE SET cursor = excluded.cursor",
            params![source_id, serde_json::to_string(&source.cursor)?],
        )?;
        transaction.execute(
            "DELETE FROM source_events WHERE source_id = ?1",
            params![source_id],
        )?;

        for (position, event) in source.events.iter().enumerate() {
            let event_id = event
                .get("eventId")
                .and_then(Value::as_str)
                .filter(|event_id| !event_id.is_empty())
                .ok_or_else(|| {
                    Box::new(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "stored event is missing eventId",
                    )) as Box<dyn std::error::Error + Send + Sync>
                })?;
            let position = i64::try_from(position).map_err(|_| {
                Box::new(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "too many events in source",
                )) as Box<dyn std::error::Error + Send + Sync>
            })?;
            transaction.execute(
                "INSERT INTO source_events (source_id, event_id, position, payload)
                 VALUES (?1, ?2, ?3, ?4)",
                params![source_id, event_id, position, serde_json::to_string(event)?],
            )?;
        }

        if let Some(context) = context {
            transaction.execute(
                "UPDATE meta SET context = ?1 WHERE id = 1",
                params![serde_json::to_string(context)?],
            )?;
        }

        let current_revision = read_revision(&transaction)?;
        let next_revision = current_revision
            .checked_add(1)
            .and_then(|revision| i64::try_from(revision).ok())
            .ok_or_else(|| {
                Box::new(io::Error::new(io::ErrorKind::Other, "revision overflow"))
                    as Box<dyn std::error::Error + Send + Sync>
            })?;
        transaction.execute(
            "UPDATE meta SET revision = ?1 WHERE id = 1",
            params![next_revision],
        )?;

        transaction.commit()?;
        u64::try_from(next_revision).map_err(|_| {
            Box::new(io::Error::new(
                io::ErrorKind::InvalidData,
                "negative stored revision",
            )) as Box<dyn std::error::Error + Send + Sync>
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
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision = read_revision(&transaction)?;
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO snapshots (revision, context)
             SELECT revision, context FROM meta WHERE id = 1",
            [],
        )?;
        if inserted == 1 {
            transaction.execute(
                "INSERT INTO snapshot_sources (snapshot_revision, source_id, cursor)
                 SELECT ?1, source_id, cursor FROM sources",
                params![revision],
            )?;
            transaction.execute(
                "INSERT INTO snapshot_events
                    (snapshot_revision, source_id, event_id, position, payload)
                 SELECT ?1, source_id, event_id, position, payload FROM source_events",
                params![revision],
            )?;
        }
        transaction.commit()?;
        Ok(u64::try_from(revision).map_err(|_| {
            Box::new(io::Error::new(
                io::ErrorKind::InvalidData,
                "negative stored revision",
            )) as Box<dyn std::error::Error + Send + Sync>
        })?)
    }
}

fn read_state(connection: &Connection, snapshot: Option<u64>) -> StoreResult<State> {
    let Some(snapshot) = snapshot else {
        let revision = u64::try_from(read_revision(connection)?).map_err(|_| {
            Box::new(io::Error::new(
                io::ErrorKind::InvalidData,
                "negative stored revision",
            )) as Box<dyn std::error::Error + Send + Sync>
        })?;
        let context: String =
            connection.query_row("SELECT context FROM meta WHERE id = 1", [], |row| {
                row.get(0)
            })?;
        let mut sources = BTreeMap::new();
        {
            let mut statement =
                connection.prepare("SELECT source_id, cursor FROM sources ORDER BY source_id")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (source_id, cursor) = row?;
                sources.insert(
                    source_id,
                    Source {
                        events: Vec::new(),
                        cursor: serde_json::from_str(&cursor)?,
                    },
                );
            }
        }
        for (source_id, source) in &mut sources {
            let mut statement = connection.prepare(
                "SELECT payload FROM source_events
                 WHERE source_id = ?1 ORDER BY position",
            )?;
            let rows = statement.query_map(params![source_id], |row| row.get::<_, String>(0))?;
            for row in rows {
                source.events.push(serde_json::from_str(&row?)?);
            }
        }
        return Ok(State {
            revision,
            sources,
            context: serde_json::from_str(&context)?,
        });
    };

    let snapshot_revision = i64::try_from(snapshot).map_err(|_| {
        Box::new(io::Error::new(
            io::ErrorKind::NotFound,
            format!("snapshot {snapshot} not found"),
        )) as Box<dyn std::error::Error + Send + Sync>
    })?;
    let context: Option<String> = connection
        .query_row(
            "SELECT context FROM snapshots WHERE revision = ?1",
            params![snapshot_revision],
            |row| row.get(0),
        )
        .optional()?;
    let context = context.ok_or_else(|| {
        Box::new(io::Error::new(
            io::ErrorKind::NotFound,
            format!("snapshot {snapshot} not found"),
        )) as Box<dyn std::error::Error + Send + Sync>
    })?;

    let mut sources = BTreeMap::new();
    {
        let mut statement = connection.prepare(
            "SELECT source_id, cursor FROM snapshot_sources
             WHERE snapshot_revision = ?1 ORDER BY source_id",
        )?;
        let rows = statement.query_map(params![snapshot_revision], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (source_id, cursor) = row?;
            sources.insert(
                source_id,
                Source {
                    events: Vec::new(),
                    cursor: serde_json::from_str(&cursor)?,
                },
            );
        }
    }
    for (source_id, source) in &mut sources {
        let mut statement = connection.prepare(
            "SELECT payload FROM snapshot_events
             WHERE snapshot_revision = ?1 AND source_id = ?2 ORDER BY position",
        )?;
        let rows = statement.query_map(params![snapshot_revision, source_id], |row| {
            row.get::<_, String>(0)
        })?;
        for row in rows {
            source.events.push(serde_json::from_str(&row?)?);
        }
    }
    Ok(State {
        revision: snapshot,
        sources,
        context: serde_json::from_str(&context)?,
    })
}

fn read_revision(connection: &Connection) -> StoreResult<i64> {
    Ok(
        connection.query_row("SELECT revision FROM meta WHERE id = 1", [], |row| {
            row.get(0)
        })?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn source(id: &str) -> Source {
        Source {
            events: vec![json!({
                "eventId": id,
                "timestamp": "2026-11-01T00:00:00Z",
                "sessionId": format!("session-{id}"),
                "homeId": "home-a",
                "total": {
                    "total": 1,
                    "input": 1,
                    "cached": 0,
                    "output": 0,
                    "reasoning": 0
                }
            })],
            cursor: json!({"offset": 1}),
        }
    }

    fn database_path() -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "architecture-prototype-sqlite-{}-{nonce}.db",
            std::process::id()
        ))
    }

    fn remove_database(path: &Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn commit_failure_rolls_back_source_and_revision() {
        let mut storage = SqliteStorage::in_memory().unwrap();
        storage
            .connection
            .execute_batch(
                "CREATE TRIGGER force_failure BEFORE INSERT ON source_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced failure');
                 END;",
            )
            .unwrap();

        assert!(
            storage
                .commit(
                    "source-a",
                    &source("event-a"),
                    Some(&json!({"generatedAt": "now"}))
                )
                .is_err()
        );
        let state = storage.load(None).unwrap();
        assert_eq!(state.revision, 0);
        assert!(state.sources.is_empty());
        assert_eq!(state.context, Value::Null);
    }

    #[test]
    fn delta_commit_does_not_read_unrelated_source() {
        let mut storage = SqliteStorage::in_memory().unwrap();
        storage
            .commit_delta(
                "source-a",
                &source("event-a"),
                Some(&json!({"marker": "a"})),
            )
            .unwrap();
        storage
            .connection
            .execute(
                "UPDATE source_events SET payload = 'not-json' WHERE source_id = 'source-a'",
                [],
            )
            .unwrap();

        let revision = storage
            .commit_delta("source-b", &source("event-b"), None)
            .unwrap();
        assert_eq!(revision, 2);
        assert_eq!(read_revision(&storage.connection).unwrap(), 2);
        let cursor: String = storage
            .connection
            .query_row(
                "SELECT cursor FROM sources WHERE source_id = 'source-b'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&cursor).unwrap(),
            json!({"offset": 1})
        );
        assert!(storage.load(None).is_err());
    }

    #[test]
    fn freeze_survives_reopen_and_live_commit() {
        let path = database_path();
        remove_database(&path);
        {
            let mut storage = SqliteStorage::initialize(Connection::open(&path).unwrap()).unwrap();
            storage
                .commit(
                    "source-a",
                    &source("event-a"),
                    Some(&json!({"generatedAt": "first"})),
                )
                .unwrap();
            assert_eq!(storage.freeze().unwrap(), 1);
            storage
                .commit(
                    "source-b",
                    &source("event-b"),
                    Some(&json!({"generatedAt": "second"})),
                )
                .unwrap();
        }
        {
            let mut storage = SqliteStorage::initialize(Connection::open(&path).unwrap()).unwrap();
            let live = storage.load(None).unwrap();
            let frozen = storage.load(Some(1)).unwrap();
            assert_eq!(live.revision, 2);
            assert_eq!(live.sources.len(), 2);
            assert_eq!(frozen.revision, 1);
            assert_eq!(frozen.sources.len(), 1);
            assert_eq!(frozen.context["generatedAt"], "first");
        }
        remove_database(&path);
    }

    #[test]
    fn durability_pragmas_remain_enabled() {
        let path = database_path();
        remove_database(&path);
        let storage = SqliteStorage::initialize(Connection::open(&path).unwrap()).unwrap();
        let synchronous: i64 = storage
            .connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap();
        let journal_mode: String = storage
            .connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(synchronous, 2);
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        drop(storage);
        remove_database(&path);
    }
}

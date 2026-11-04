use crate::storage::{Source, State, Storage, StoreResult, storage_error};
use ::redb::{
    Database, Durability, ReadTransaction, ReadableDatabase, ReadableTable, TableDefinition,
    WriteTransaction,
};
use serde_json::Value;
use std::path::Path;

const REVISION_KEY: &str = "revision";
const CONTEXT_KEY: &str = "context";
const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
const SOURCES: TableDefinition<&str, &[u8]> = TableDefinition::new("sources");
const SNAPSHOTS: TableDefinition<u64, &[u8]> = TableDefinition::new("snapshots");

struct RedbStorage {
    db: Database,
}

pub fn open(path: &Path) -> StoreResult<Box<dyn Storage>> {
    Ok(Box::new(open_inner(path)?))
}

fn open_inner(path: &Path) -> StoreResult<RedbStorage> {
    let db = Database::create(path)?;
    let mut write = db.begin_write()?;
    write.set_durability(Durability::Immediate)?;
    {
        let _ = write.open_table(META)?;
        let _ = write.open_table(SOURCES)?;
        let _ = write.open_table(SNAPSHOTS)?;
    }
    write.commit()?;
    Ok(RedbStorage { db })
}

fn decode_snapshot(bytes: &[u8]) -> StoreResult<State> {
    serde_json::from_slice(bytes)
        .map_err(|error| storage_error(format!("invalid redb snapshot: {error}")))
}

fn encode_snapshot(state: &State) -> StoreResult<Vec<u8>> {
    serde_json::to_vec(state)
        .map_err(|error| storage_error(format!("failed to encode redb snapshot: {error}")))
}

fn decode_source(bytes: &[u8], source_id: &str) -> StoreResult<Source> {
    serde_json::from_slice(bytes)
        .map_err(|error| storage_error(format!("invalid redb source {source_id:?}: {error}")))
}

fn encode_source(source: &Source, source_id: &str) -> StoreResult<Vec<u8>> {
    serde_json::to_vec(source).map_err(|error| {
        storage_error(format!(
            "failed to encode redb source {source_id:?}: {error}"
        ))
    })
}

fn decode_revision(bytes: &[u8]) -> StoreResult<u64> {
    serde_json::from_slice(bytes)
        .map_err(|error| storage_error(format!("invalid redb revision: {error}")))
}

fn encode_revision(revision: u64) -> StoreResult<Vec<u8>> {
    serde_json::to_vec(&revision)
        .map_err(|error| storage_error(format!("failed to encode redb revision: {error}")))
}

fn decode_context(bytes: &[u8]) -> StoreResult<Value> {
    serde_json::from_slice(bytes)
        .map_err(|error| storage_error(format!("invalid redb context: {error}")))
}

fn encode_context(context: &Value) -> StoreResult<Vec<u8>> {
    serde_json::to_vec(context)
        .map_err(|error| storage_error(format!("failed to encode redb context: {error}")))
}

fn state_from_write(write: &WriteTransaction) -> StoreResult<State> {
    let (revision, context) = {
        let table = write.open_table(META)?;
        let revision = match table.get(REVISION_KEY)? {
            Some(value) => decode_revision(value.value())?,
            None => 0,
        };
        let context = match table.get(CONTEXT_KEY)? {
            Some(value) => decode_context(value.value())?,
            None => Value::Null,
        };
        (revision, context)
    };
    let mut sources = std::collections::BTreeMap::new();
    {
        let table = write.open_table(SOURCES)?;
        for entry in table.iter()? {
            let (key, value) = entry?;
            let source_id = key.value().to_owned();
            sources.insert(source_id.clone(), decode_source(value.value(), &source_id)?);
        }
    }
    Ok(State {
        revision,
        sources,
        context,
    })
}

fn state_from_read(read: &ReadTransaction) -> StoreResult<State> {
    let (revision, context) = {
        let table = read.open_table(META)?;
        let revision = match table.get(REVISION_KEY)? {
            Some(value) => decode_revision(value.value())?,
            None => 0,
        };
        let context = match table.get(CONTEXT_KEY)? {
            Some(value) => decode_context(value.value())?,
            None => Value::Null,
        };
        (revision, context)
    };
    let mut sources = std::collections::BTreeMap::new();
    {
        let table = read.open_table(SOURCES)?;
        for entry in table.iter()? {
            let (key, value) = entry?;
            let source_id = key.value().to_owned();
            sources.insert(source_id.clone(), decode_source(value.value(), &source_id)?);
        }
    }
    Ok(State {
        revision,
        sources,
        context,
    })
}

impl RedbStorage {
    fn commit_inner(
        &mut self,
        source_id: &str,
        source: &Source,
        context: Option<&Value>,
        before_commit: impl FnOnce() -> StoreResult<()>,
    ) -> StoreResult<u64> {
        let mut write = self.db.begin_write()?;
        write.set_durability(Durability::Immediate)?;

        let revision = {
            let table = write.open_table(META)?;
            let current_revision = match table.get(REVISION_KEY)? {
                Some(value) => decode_revision(value.value())?,
                None => 0,
            };
            current_revision
                .checked_add(1)
                .ok_or_else(|| storage_error("redb revision overflow"))?
        };

        let encoded_source = encode_source(source, source_id)?;
        let encoded_revision = encode_revision(revision)?;
        {
            let mut table = write.open_table(SOURCES)?;
            table.insert(source_id, encoded_source.as_slice())?;
        }
        {
            let mut table = write.open_table(META)?;
            table.insert(REVISION_KEY, encoded_revision.as_slice())?;
            if let Some(context) = context {
                let encoded_context = encode_context(context)?;
                table.insert(CONTEXT_KEY, encoded_context.as_slice())?;
            }
        }

        if let Err(error) = before_commit() {
            let _ = write.abort();
            return Err(error);
        }
        write.commit()?;
        Ok(revision)
    }
}

impl Storage for RedbStorage {
    fn load(&mut self, snapshot: Option<u64>) -> StoreResult<State> {
        let read = self.db.begin_read()?;
        if let Some(revision) = snapshot {
            let table = read.open_table(SNAPSHOTS)?;
            let value = table
                .get(revision)?
                .ok_or_else(|| storage_error(format!("redb snapshot {revision} does not exist")))?;
            let state = decode_snapshot(value.value())?;
            if state.revision != revision {
                return Err(storage_error(format!(
                    "redb snapshot {revision} contains revision {}",
                    state.revision
                )));
            }
            return Ok(state);
        }

        state_from_read(&read)
    }

    fn commit_delta(
        &mut self,
        source_id: &str,
        source: &Source,
        context: Option<&Value>,
    ) -> StoreResult<u64> {
        self.commit_inner(source_id, source, context, || Ok(()))
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
        let mut write = self.db.begin_write()?;
        write.set_durability(Durability::Immediate)?;

        let state = state_from_write(&write)?;
        let encoded = encode_snapshot(&state)?;
        {
            let mut table = write.open_table(SNAPSHOTS)?;
            table.insert(state.revision, encoded.as_slice())?;
        }
        write.commit()?;
        Ok(state.revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
                "codex-usage-redb-{name}-{}-{nanos}-{nonce}",
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
            "total": {
                "total": total,
                "input": total,
                "cached": 0,
                "output": 0,
                "reasoning": 0
            }
        })
    }

    fn raw_source(store: &RedbStorage, source_id: &str) -> Vec<u8> {
        let read = store.db.begin_read().expect("begin raw source read");
        let table = read.open_table(SOURCES).expect("open sources");
        table
            .get(source_id)
            .expect("read source")
            .expect("source exists")
            .value()
            .to_vec()
    }

    fn raw_revision(store: &RedbStorage) -> u64 {
        let read = store.db.begin_read().expect("begin raw meta read");
        let table = read.open_table(META).expect("open meta");
        let value = table
            .get(REVISION_KEY)
            .expect("read revision")
            .expect("revision exists");
        decode_revision(value.value()).expect("decode revision")
    }

    #[test]
    fn commit_replaces_source_and_snapshot_survives_reopen() {
        let temp = TempDir::new("snapshot");
        let path = temp.0.join("store.redb");
        let first_context = json!({"generatedAt": "2026-11-01T12:00:00Z"});

        {
            let mut store = open(&path).expect("open redb");
            let first = store
                .commit(
                    "source-a",
                    &Source {
                        events: vec![event("a-1", 10)],
                        cursor: json!({"offset": 1}),
                    },
                    Some(&first_context),
                )
                .expect("first commit");
            assert_eq!(first.revision, 1);

            let replaced = store
                .commit(
                    "source-a",
                    &Source {
                        events: vec![event("a-2", 20)],
                        cursor: json!({"offset": 2}),
                    },
                    None,
                )
                .expect("replacement commit");
            assert_eq!(replaced.sources["source-a"].events.len(), 1);
            assert_eq!(replaced.sources["source-a"].events[0]["eventId"], "a-2");
            assert_eq!(replaced.context, first_context);

            assert_eq!(store.freeze().expect("freeze"), 2);
            store
                .commit(
                    "source-b",
                    &Source {
                        events: vec![event("b-1", 30)],
                        cursor: json!({"offset": 1}),
                    },
                    Some(&json!({"generatedAt": "later"})),
                )
                .expect("post-freeze commit");
        }

        let mut reopened = open(&path).expect("reopen redb");
        let current = reopened.load(None).expect("load current");
        assert_eq!(current.revision, 3);
        assert_eq!(current.sources.len(), 2);

        let frozen = reopened.load(Some(2)).expect("load frozen");
        assert_eq!(frozen.revision, 2);
        assert_eq!(frozen.sources.len(), 1);
        assert_eq!(frozen.sources["source-a"].events[0]["eventId"], "a-2");
        assert_eq!(frozen.context, first_context);
    }

    #[test]
    fn commit_does_not_rewrite_other_sources() {
        let temp = TempDir::new("source-isolation");
        let path = temp.0.join("store.redb");
        let context = json!({"generatedAt": "2026-11-01T12:00:00Z"});
        let source_b = Source {
            events: vec![event("b-1", 30)],
            cursor: json!({"offset": 7}),
        };
        let mut store = open_inner(&path).expect("open redb");
        store
            .commit(
                "source-a",
                &Source {
                    events: vec![event("a-1", 10)],
                    cursor: json!({"offset": 1}),
                },
                Some(&context),
            )
            .expect("commit source-a");
        store
            .commit("source-b", &source_b, None)
            .expect("commit source-b");

        let source_b_before = raw_source(&store, "source-b");
        store
            .commit(
                "source-a",
                &Source {
                    events: vec![event("a-2", 20)],
                    cursor: json!({"offset": 2}),
                },
                None,
            )
            .expect("replace source-a");

        assert_eq!(raw_source(&store, "source-b"), source_b_before);
        let state = store.load(None).expect("load current");
        assert_eq!(state.revision, 3);
        assert_eq!(state.context, context);
        assert_eq!(state.sources["source-b"].events, source_b.events);
        assert_eq!(state.sources["source-b"].cursor, source_b.cursor);
        assert_eq!(state.sources["source-a"].events[0]["eventId"], "a-2");
    }

    #[test]
    fn delta_commit_does_not_read_unrelated_source() {
        let temp = TempDir::new("delta-isolation");
        let path = temp.0.join("store.redb");
        let mut store = open_inner(&path).expect("open redb");
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

        let mut write = store.db.begin_write().expect("begin corruption write");
        write
            .set_durability(Durability::Immediate)
            .expect("set durability");
        {
            let mut table = write.open_table(SOURCES).expect("open sources");
            table
                .insert("source-a", b"not-json".as_slice())
                .expect("corrupt source-a");
        }
        write.commit().expect("commit corruption");

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
        assert_eq!(raw_revision(&store), 2);
        assert!(store.load(None).is_err());
    }

    #[test]
    fn commit_rolls_back_source_meta_and_context_on_failure() {
        let temp = TempDir::new("rollback");
        let path = temp.0.join("store.redb");
        let context = json!({"generatedAt": "2026-11-01T12:00:00Z"});
        let mut store = open_inner(&path).expect("open redb");
        store
            .commit(
                "source-a",
                &Source {
                    events: vec![event("a-1", 10)],
                    cursor: json!({"offset": 1}),
                },
                Some(&context),
            )
            .expect("commit source-a");
        store
            .commit(
                "source-b",
                &Source {
                    events: vec![event("b-1", 30)],
                    cursor: json!({"offset": 7}),
                },
                None,
            )
            .expect("commit source-b");
        let source_a_before = raw_source(&store, "source-a");
        let source_b_before = raw_source(&store, "source-b");

        let error = store
            .commit_inner(
                "source-a",
                &Source {
                    events: vec![event("a-2", 20)],
                    cursor: json!({"offset": 2}),
                },
                Some(&json!({"generatedAt": "must roll back"})),
                || Err(storage_error("injected failure before redb commit")),
            )
            .expect_err("injected failure must abort");
        assert!(error.to_string().contains("injected failure"));

        assert_eq!(raw_source(&store, "source-a"), source_a_before);
        assert_eq!(raw_source(&store, "source-b"), source_b_before);
        let state = store.load(None).expect("load after rollback");
        assert_eq!(state.revision, 2);
        assert_eq!(state.context, context);
        assert_eq!(state.sources["source-a"].events[0]["eventId"], "a-1");
        assert_eq!(state.sources["source-a"].cursor, json!({"offset": 1}));
        assert_eq!(state.sources["source-b"].events[0]["eventId"], "b-1");
    }
}

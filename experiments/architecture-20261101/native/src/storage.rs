use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::error::Error;
use std::io;
use std::path::Path;

#[cfg(feature = "duckdb")]
#[path = "duckdb.rs"]
mod duckdb;
#[cfg(feature = "redb")]
#[path = "redb.rs"]
mod redb;
#[cfg(feature = "sqlite")]
#[path = "sqlite.rs"]
mod sqlite;

pub type StoreResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct State {
    pub revision: u64,
    pub sources: BTreeMap<String, Source>,
    pub context: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub events: Vec<Value>,
    pub cursor: Value,
}

pub trait Storage: Send {
    fn load(&mut self, snapshot: Option<u64>) -> StoreResult<State>;
    fn commit_delta(
        &mut self,
        source_id: &str,
        source: &Source,
        context: Option<&Value>,
    ) -> StoreResult<u64> {
        self.commit(source_id, source, context)
            .map(|state| state.revision)
    }
    fn commit(
        &mut self,
        source_id: &str,
        source: &Source,
        context: Option<&Value>,
    ) -> StoreResult<State>;
    fn freeze(&mut self) -> StoreResult<u64>;
    fn query_current(
        &mut self,
        _start_ms: Option<i64>,
        _end_ms: Option<i64>,
        _excluded_homes: &[String],
    ) -> StoreResult<Option<Value>> {
        Ok(None)
    }
}

pub(crate) fn storage_error(message: impl Into<String>) -> Box<dyn Error + Send + Sync> {
    Box::new(io::Error::other(message.into()))
}

pub fn open(backend: &str, path: &Path) -> StoreResult<Box<dyn Storage>> {
    match backend {
        #[cfg(feature = "sqlite")]
        "sqlite" => return sqlite::open(path),
        #[cfg(feature = "redb")]
        "redb" => return redb::open(path),
        #[cfg(feature = "duckdb")]
        "duckdb" => return duckdb::open(path),
        _ => {}
    }

    match backend {
        "sqlite" | "redb" | "duckdb" => Err(storage_error(format!(
            "backend {backend:?} is not enabled in this build"
        ))),
        other => Err(storage_error(format!("unknown storage backend {other:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_backend() {
        let error = open("unknown", Path::new("unused"))
            .err()
            .expect("unknown backend must fail");
        assert!(error.to_string().contains("unknown storage backend"));
    }
}

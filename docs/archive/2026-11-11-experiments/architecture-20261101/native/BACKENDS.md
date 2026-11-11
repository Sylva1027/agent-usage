# Storage backends

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../../README.md)。

The shared `storage::Storage` contract and dispatch live in `src/storage.rs`.
Backend availability is controlled by Cargo features:

| Feature | Backend name | Module |
| --- | --- | --- |
| `sqlite` | `sqlite` | `src/sqlite.rs` |
| `redb` | `redb` | `src/redb.rs` |
| `duckdb` | `duckdb` | `src/duckdb.rs` |

`storage::open` returns an explicit error when a known backend was not enabled
in the current build. It never substitutes another storage engine.

## Cargo configuration

The B-owned `Cargo.toml` is authoritative. It currently enables all three
backends by default and defines these feature mappings:

```toml
[features]
default = ["sqlite", "redb", "duckdb"]
sqlite = ["dep:rusqlite"]
redb = ["dep:redb"]
duckdb = ["dep:duckdb"]

[dependencies]
serde = { version = "=1.0.228", features = ["derive"] }
serde_json = "=1.0.149"
rusqlite = { version = "0.41.1", optional = true, features = ["bundled"] }
redb = { version = "4.4.0", optional = true }
duckdb = { version = "1.20000.1", optional = true, default-features = false, features = ["bundled"] }
```

The all-backend build is:

```text
cargo build --release --features redb,duckdb
```

Individual feature builds use `--no-default-features`:

```text
cargo build --release --no-default-features --features sqlite
cargo build --release --no-default-features --features redb
cargo build --release --no-default-features --features duckdb
```

The bundled DuckDB source build is intentionally feature-gated so SQLite-only
and redb-only builds do not compile it. On Windows, keep `CARGO_TARGET_DIR`
short to avoid the DuckDB unity build's MSVC path-length limit.

## Transaction and durability behavior

- `commit` replaces one source's complete event array and cursor, optionally
  updates context, increments revision, and returns the committed state.
- `freeze` copies the current revision into a separately stored immutable
  snapshot. Later commits do not alter that snapshot.
- Any serialization, constraint, SQL, or transaction error returns before the
  revision is published. The previous source/context/revision remains current.
- redb stores revision/context in `meta` and each `sourceId` as its own JSON
  value in `sources`. A commit writes only the affected source, meta revision,
  and context when supplied, inside one immediate-durable transaction.
- DuckDB uses an explicit transaction for each operation. The `events` table
  stores source id, event id, exact timestamp text, a sortable `TIMESTAMPTZ`,
  session/home/channel/model, all five token fields as `UBIGINT`, optional
  grouping metadata, revision, and the complete original event JSON payload.
- The shared `Storage` trait exposes optional `query_current(start, end,
  excludedHomes)`. Its default implementation returns `None`; only DuckDB
  overrides it. The DuckDB override reads typed event columns and never reads
  `payload` or rebuilds `State`.

## DuckDB SQL current-query pushdown (C4)

The shared optional method is:

```rust
fn query_current(
    &mut self,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    excluded_homes: &[String],
) -> StoreResult<Option<Value>>
```

SQLite and redb inherit the default `Ok(None)`. DuckDB overrides the method and
returns `Some(Value)` produced from the shared `model::QueryResponse`,
`model::GroupRow`, and `model::UsageTotals` types, so field names and nesting
match the native `/api/query` response shape.

The DuckDB implementation performs the current-query work in typed SQL:

- inclusive millisecond range filtering on `event_ts_utc`;
- exact, parameter-bound exclusion of `excluded_homes` using `home_id`;
- event count plus independent `COUNT(DISTINCT session_id)` and
  `COUNT(DISTINCT home_id)`;
- `SUM` for `total`, `input`, `cached`, `output`, and `reasoning`;
- model, channel, project, repository, and UTC timeline grouping;
- SQL `total DESC` ordering for non-timeline groups, followed by a Rust final
  sort using `total DESC` and `name.encode_utf16()` code-unit order. This
  avoids DuckDB UTF-8 collation differing from Node/native behavior for emoji
  and BMP names. The UTC timeline is formatted and sorted by date in Rust;
- the native fallbacks `Unknown model`, `Unknown channel`, `Unknown cwd`, and
  `Unknown repository` for NULL or empty grouping values.

The revision and all summary/group queries execute in one DuckDB transaction.
Every aggregate is read as a wide unsigned integer and rejected if it exceeds
`MAX_SAFE_INTEGER` before conversion into the response. Dynamic SQL contains
only generated placeholders; start/end values and excluded homes are bound as
parameters. This path does not select `payload`, deserialize events, or call
`load_state`. The timeline is grouped in SQL by
`FLOOR(epoch_ms(event_ts_utc) / 86400000)`; Rust converts the resulting UTC day
bucket number to `YYYY-MM-DD`. This avoids `strftime`, ICU, and online DuckDB
extensions while preserving negative-epoch floor semantics and UTC conversion
of timestamps carrying non-UTC offsets.

The DuckDB storage tests include:

- `duckdb_sql_query_matches_native_core`: builds the same source events and
  filters in DuckDB and the native core, then compares the complete serialized
  `QueryResponse`. It covers inclusive time boundaries, excluded homes,
  NULL/empty grouping fallbacks, all five token fields, distinct
  session/home counts, multiple grouping dimensions, timeline UTC days, and
  `total DESC/name ASC` tie ordering. Equal-total model names `😀` and U+E000
  verify UTF-16 code-unit ordering where UTF-8 order would differ. It also
  corrupts `payload` before querying to prove that the SQL path does not depend
  on it. Its timeline cases include a pre-epoch negative timestamp and a
  negative UTC offset that crosses into the next UTC day.
- `query_current_rejects_aggregate_above_safe_integer`: commits two events that
  are individually safe but whose token sum exceeds `MAX_SAFE_INTEGER`, then
  requires `query_current` to return an error.
- `failed_replacement_rolls_back_and_snapshot_survives_reopen`: retains the
  primary-key constraint failure test. The reused prepared INSERT statement
  still fails on the duplicate event id, and the test verifies revision,
  context, the affected source, and an unrelated source roll back correctly.

These tests are present in the tree but were not executed during C4 because
the unified Cargo run is owned by the main agent.

## Prototype limits

redb snapshots remain one complete `State` JSON value per frozen revision.
Current data is source-isolated, but individual sources are still whole JSON
values rather than compact event rows or indexed projections. The prototype
does not migrate an older `current_state` table.

The following C4 work remains outside this storage change:

- Integrated `main.rs` calls `query_current` for live queries. DuckDB uses the
  typed SQL path; SQLite/redb retain the in-memory native core fallback.
- Report loading and frozen snapshots still use complete `State` JSON paths.
  `query_current` has no snapshot parameter, and snapshot rows remain complete
  state JSON rather than normalized tables.
- DuckDB commit now prepares the event INSERT once and reuses it for all rows,
  but still binds and executes one row at a time. It does not use the DuckDB
  appender, and it still calls `load_state` after the write to satisfy the
  shared trait's returned `State`.
- The DuckDB schema has no migration mechanism beyond
  `CREATE TABLE IF NOT EXISTS`; use a fresh prototype database for each run.
- No rigorous performance comparison has been completed. Import timing from a
  single diagnostic run is not treated as a benchmark, and this document does
  not claim a measured columnar-query benefit.

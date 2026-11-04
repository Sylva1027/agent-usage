# Native architecture prototype

This directory contains the shared Rust HTTP engine and storage implementations used by the
`rust-sqlite`, `rust-redb`, and `rust-duckdb` architecture prototypes.

The binary name is `architecture-prototype`.

## Current scope

The native service owns:

- Event validation, UTC range filtering, home exclusion, stable ordering, and the narrow
  `report/query/status/cursors/freeze` carrier API.
- Transactional source replacement, current revision publication, frozen revisions, and restart
  recovery.
- One in-memory published state, loaded once at startup. Current status, cursors, and report reads
  use that state; query uses a backend-specific `query_current` fast path when available and
  otherwise falls back to the same published state.
- A fixed pool of four HTTP workers.
- Static delivery of the shared prototype page through `--web`.

The native service does not implement:

- Raw Codex, DSH, or other source parsing. `collector.rs` and `--sources` are not part of this card.
- The complete current-product business calculation. `/api/query` is a narrow native aggregate;
  the shared Node compatibility layer must apply the existing product formulas to `/api/report`.
- A native dashboard, pricing/quota business port, or TPS path. Current product 0.8.5 has removed
  TPS, and this prototype does not reintroduce it.

Do not describe the native query endpoint as a complete native replacement for the product
dashboard.

## Build and run (Windows first)

As of 2026-11-02, implementation, architecture selection and acceptance focus on Windows.
Linux/macOS adaptation and runtime verification follow once the core refactor is substantially
complete; they are not prerequisites for the current phase.

Run commands from the repository root. On Windows, use PowerShell 7 (`pwsh`), not Windows
PowerShell 5.1.

All three backends are enabled by default:

```text
cargo build --release --manifest-path experiments/architecture-20261101/native/Cargo.toml
```

DuckDB uses `bundled` and may require a long source build. For a faster SQLite-only loop:

```text
cargo build --manifest-path experiments/architecture-20261101/native/Cargo.toml --no-default-features --features sqlite
```

On Windows x64, run the release executable with PowerShell 7:

```powershell
$native = "experiments\architecture-20261101\native\target\release\architecture-prototype.exe"
& $native --backend sqlite --database "<database-path>" --port 0 --web "experiments\architecture-20261101\web.html"
```

For the later Linux/macOS adaptation phase, the intended binary invocation omits `.exe`:

```sh
experiments/architecture-20261101/native/target/release/architecture-prototype \
  --backend sqlite --database "<database-path>" --port 0 \
  --web experiments/architecture-20261101/web.html
```

`--backend` accepts `sqlite`, `redb`, or `duckdb`. `--port 0` selects an available loopback port.
The process writes exactly one startup line to stdout:

```json
{"port":12345,"backend":"rust-sqlite"}
```

The equivalent `cargo run` form is:

```sh
cargo run --release --manifest-path experiments/architecture-20261101/native/Cargo.toml -- --backend sqlite --database <database-path> --port 0 --web experiments/architecture-20261101/web.html
```

This command is the same on all three platforms; Windows will build and invoke
`architecture-prototype.exe`.

## HTTP contract

- `POST /api/commit`
- `GET /api/report`
- `GET /api/query`
- `GET /api/status`
- `GET /api/cursors`
- `POST /api/freeze`
- `GET /api/health`
- `GET /` when `--web` is configured

`report` and `query` accept `start`, `end`, `excludeHomes`, and `snapshot`. Timestamps and ranges
are evaluated in UTC. Commit bodies are limited to 64 MiB.

`POST /api/commit` accepts an optional `expectedCursor` compare-and-swap condition. Omitting the
field commits unconditionally; explicit `null` requires the source not to exist; any other JSON
value must structurally equal the source's current published cursor. A mismatch returns HTTP 409
without changing the revision.

## Consistency model

The service loads the current state once at startup. Current `status`, `cursors`, and `report`
requests read the published in-memory state. A no-snapshot `query` first calls the backend
`query_current` hook while holding the storage lock; a backend result is returned directly. When
the backend returns `None`, the storage lock is released before the Rust fallback reads the current
state. Snapshot queries continue to load the requested frozen state.

A commit holds the single storage writer lock through the database transaction and publication of
the new current state. A failed validation or storage transaction returns an error without
replacing the published state. Consecutive commits therefore cannot publish out of order.

An `expectedCursor` check also runs while the storage writer lock is held. It briefly takes the
current-state read lock, then releases it before the storage transaction; the lock order is always
storage, then current. This makes concurrent collectors using the same expected cursor race
safely: one commit succeeds and the other receives HTTP 409.

Freeze uses the same storage lock, so it is ordered with commits: a freeze either captures the
version before a commit or the already-published version after it. Snapshot reads use the storage
lock independently of the current-state read lock, so they do not block current in-memory reads.

SQLite keeps `journal_mode=WAL`, `synchronous=FULL`, foreign keys, source replacement, context,
cursor, revision, and snapshot copies inside transactions.

## Tests

SQLite:

```text
cargo test --manifest-path experiments/architecture-20261101/native/Cargo.toml --no-default-features --features sqlite
```

SQLite and redb:

```text
cargo test --manifest-path experiments/architecture-20261101/native/Cargo.toml --no-default-features --features sqlite,redb
```

All backends, including bundled DuckDB:

```text
cargo test --manifest-path experiments/architecture-20261101/native/Cargo.toml
```

`tests/core_api.rs` covers HTTP filtering and aggregation, session de-duplication by `sessionId`
only, safe integers, duplicate IDs, validation failures, SQL failure rollback without publication,
full-library commit `eventCount`, freeze isolation, restart recovery, current-memory reads, and
concurrent current reads including the events-free `/api/cursors` response. Unit tests cover SQLite
transaction rollback and durability settings,
redb restart/freeze behavior, blocked snapshot reads, commit/freeze publication ordering, and the
Node-compatible `Unknown model` / `Unknown channel` / `Unknown cwd` / `Unknown repository`
fallbacks. CAS coverage distinguishes missing, null, and exact `expectedCursor` values and verifies
that two concurrent commits using the same expected cursor produce exactly one success and one 409.
Backend query dispatch is tested with UTC millisecond bounds and sorted excluded homes; SQLite's
default `None` path continues to exercise the Rust aggregation fallback. A lock-order regression
test blocks the fallback on current and verifies the store mutex has already been released.

The shared runner verification is:

```text
node experiments/architecture-20261101/verify.mjs output/architecture-20261101/verification rust-sqlite rust-redb rust-duckdb
```

That command requires the release binary. Its built-in synthetic fixture is useful for contract
checks but is not a substitute for the real 159,610-event, approximately 151 MB fixture.

## Verification status

- Windows: the bundled all-features release build completed. The final release test run passed
  26 tests in two suites, including status naming, cursor CAS, publication ordering and concurrency.
- DuckDB: live query dispatch executes typed SQL aggregation. The final four-backend contract,
  collector and browser runs passed, including the UTC/UTF-16 edge cases in unit tests.
- Linux and macOS: adaptation, build, run, restart and HTTP verification are deferred until the
  core Windows refactor is substantially complete. Existing portable dependencies remain in place.
- Real history: all four backends preserved the 159,610-event carrier. The latest query paths also
  matched all core groups and four complete product-formula projections against that frozen input.
  Single diagnostic timings are not a p95 performance result.

Current acceptance runs on Windows. During the later adaptation phase, each additional platform
will require an actual release build and runtime checks covering health, commit, query, freeze,
restart and snapshot reads. Successful cross-compilation alone is not runtime verification.

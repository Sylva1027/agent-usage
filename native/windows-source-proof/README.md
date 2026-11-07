# Windows source proof helper

This is an optional Windows-only native helper for the `WindowsSourceProof`
class in `src/usage-source-native.js`. It supplies bounded append evidence from
an already-active NTFS USN journal. It never enables or configures a journal,
never reads source payload bytes, and returns unavailable for unsupported
filesystems, inactive journals, unsafe mutations, incomplete coverage, and
protocol failures.

## Build

Build explicitly during development or packaging:

```powershell
pwsh -NoProfile -File native/windows-source-proof/build.ps1
npm run native:check
```

The script requires the Rust toolchain and Cargo on Windows. It builds with the
checked-in `Cargo.lock` using `--locked`, then copies the release executable to:

```text
native/windows-source-proof/bin/windows-source-proof.exe
native/windows-source-proof/bin/windows-source-proof.build.json
```

The receipt binds the executable hash to the Cargo files, build script, Rust
sources, and host target. `npm run native:check` verifies it without Cargo; a
missing receipt, changed source, or different executable requires rebuilding
before packaging. Runtime remains compatible with older or missing helpers.

For an isolated build, pass `-OutputDirectory <directory>` and
`-TargetDirectory <directory>` to the script. `-Check` only reads the output and
source hashes. Compilation failure leaves existing output untouched; successful
publication replaces staged files. Stop the relevant instance before an upgrade,
or build into a new program directory. See [delivery and upgrade](../../docs/15-delivery-upgrade.md).

The Node bridge discovers `bin/windows-source-proof.exe`, then
`target/release/windows-source-proof.exe`. Tests can pass an explicit path to
the `WindowsSourceProof` constructor.

The application does not invoke this script. A normal first refresh must not
start Cargo or wait for a compiler. Build before packaging or installation; if
the executable is absent, the bridge returns `null` and the caller uses its
content-based fallback.

## Temporary archive read locks

`await provider.lockFiles([databasePath, manifestPath])` returns `null` if any
file cannot be locked, or a lease with `check(): Promise<boolean>` and
`close(): Promise<void>`. Acquisition rolls back the entire set on failure.
Pass both files and await `check()` before and after each consumer; discard the
consumer's result if either check fails. Keep the SQLite read-only connection
and its fixed read transaction alive for the same operation scope.

The `archiveLock`, `archiveCheck`, and `archiveUnlock` protocol operations use
the existing `path` and `token` fields with kind `windows-archive-read-lock-v2`;
the bridge rejects v1 leases. File handles use `GENERIC_READ` and only
`FILE_SHARE_READ`, independently of USN availability. Every ancestor from the
drive root through the direct parent is also retained, using
`FILE_LIST_DIRECTORY`, `FILE_SHARE_READ | FILE_SHARE_WRITE` (without delete sharing), and
`FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`. Acquisition rejects
each reparse point and verifies handle-derived final child paths against their
retained parents. Each ancestor then has an undeletable child, so NTFS cannot
convert it into a reparse point while the lease lives. Shared ancestors are
retained once; files are released before their ancestor references.
Directory write sharing is necessary for sibling renames; archive file handles
still share reads only.
The nonempty-directory rule is documented under
[FSCTL_SET_REPARSE_POINT](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/fsctl-set-reparse-point).

SQLite `readOnly` opens and sibling file creation, writing, rename, replacement,
and main-database WAL activity remain compatible. Checks compare file metadata
and identity, but ancestor checks compare only identity and directory/reparse
state, ignoring directory timestamps and size. Existing writers, redirected
drive roots, non-NTFS volumes, directories as file targets, device paths,
alternate streams, and traversal/special components make acquisition unavailable.

At most 64 file and shared ancestor handles are retained per helper. Tokens are never recycled within
that helper, and leases also capture its child identity. Unlock, stdin EOF,
bridge close, or helper death releases handles; death permanently invalidates
old leases. Lease close is idempotent and never starts a helper. Older or missing
helpers return `null` so callers retain their existing verification fallback.
These locks do not replace complete SHA validation. Without a v2 lease, callers
must not read or publish persistent verification receipts. Existing in-process
`legacy-memory` semantic evidence reuse remains available under its original
conditions and stays separate from the `path-locked-v2` proof domain.

Run the isolated integration tests against an explicitly built candidate:

```powershell
$env:ARCHIVE_NATIVE_TEST_HELPER = (Resolve-Path <candidate-directory>/windows-source-proof.exe).Path
node --test test/history-archive-native-lock.test.js
```

## Runtime constraints

- Supported source paths must resolve to local drive-letter NTFS volumes with
  an already-active USN journal and V2/V3 records.
- The current helper is built for Windows x64. Package the binary for the
  target architecture and sign it as required by the deployment environment.
- UNC, network, cloud-backed, and non-NTFS paths are unsupported and fall back.
- The bridge has a fixed three-second per-request bound with no environment
  override. The native journal scan has its own two-second bound plus fixed page,
  byte, record, and unrelated activity limits.
- Directory change responses merge repeated records for the same object and parent,
  keeping the latest USN and every reason bit. Different parents remain separate;
  the 2,048-entry response, journal-byte, page, and time limits still apply.
- One helper process is used per `WindowsSourceProof` instance. Its measured
  footprint is small in the W3 fixture, but aggregate limits for many writers
  remain an integration responsibility.
- The helper is not a service. It starts with the writer's bridge instance and
  stops on `close()`, timeout, protocol failure, or child failure.

See `experiments/architecture-20261101/B2-NATIVE-PROOF.md` for the tested
mechanism, evidence, and remaining proof obligations.

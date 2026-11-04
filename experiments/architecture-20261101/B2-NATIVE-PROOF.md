# B2 Windows native source proof: W3

Status: **W3 capability and implementation card completed**

Date: 2026-11-03
Workspace: `E:\12 AI\ccusage\codex-usage`

## Result

The W3 component now has a scoped Windows append-evidence mechanism:

- A Rust stdio helper queries an already-active NTFS USN journal.
- It pages `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` with bounded output.
- It uses `FSCTL_WRITE_USN_CLOSE_RECORD` on read-only handles to the private
  synthetic fixture. It does not change journal configuration.
- It matches V2/V3 records by exact volume plus file reference/file ID, never by
  path or filename.
- It scans from the exact old seal USN through the newly returned seal USN,
  excludes only the old baseline record, and leaves records after the new seal
  for the next interval.
- It certifies open-writer append and unchanged intervals on the tested active
  C: journal, and returns unavailable for mixed overwrite+append, truncation,
  rename, and same-path replacement.
- It never reads source payload bytes. `readBytes` is asserted to be zero.

The Node bridge exposes `WindowsSourceProof` with the requested `begin`,
`verify`, `advance`, and `close` surface. A missing helper, non-Windows caller,
inactive journal, unsupported filesystem/protocol, unsafe mutation, retention
gap, malformed record, exhausted bound, or identity mismatch becomes `null` so
the main implementation can use its already-authorized full fallback.

This does not establish universal reliability, constant journal work, or
production safety. It is one tested Windows volume, filesystem, and process
sequence. E: remains inactive under the prior W1 conditions and must fall back;
that observation does not generalize to every Windows volume.

## Scope and write boundary

W3 changed only:

- `native/windows-source-proof/Cargo.toml`
- `native/windows-source-proof/Cargo.lock`
- `native/windows-source-proof/.gitignore`
- `native/windows-source-proof/src/main.rs`
- `native/windows-source-proof/src/usn.rs`
- `native/windows-source-proof/build.ps1`
- `native/windows-source-proof/README.md`
- `src/usage-source-native.js`
- `test/usage-source-native.test.js`
- this document

Private test output is under:

```text
output/native/windows-source-proof/
```

The local build script generates ignored artifacts under
`native/windows-source-proof/target/` and
`native/windows-source-proof/bin/`.

The integration creates a unique fixture below the current user's C: temp
directory. The test resolves the directory and verifies that it is a strict
child of `os.tmpdir()` before recursive cleanup. No source home file, real
harness log, real database, service, or volume journal was modified.

The final outside-sandbox temp root was
`C:\Users\Silver\AppData\Local\Temp`; a post-run read-only check found no
remaining `usage-native-w3-*` directory.

The final integration process was run outside the command sandbox so DeviceIoControl
could reach the already-active C: journal without the tool sandbox filtering
the calls. This removed only command sandboxing. It did not request UAC or add
the Administrator role.

## Node bridge

Exported class:

```js
import { WindowsSourceProof } from "./src/usage-source-native.js";

const proof = new WindowsSourceProof(internalExecutablePath);
```

The constructor's optional `internalExecutablePath` exists for tests or
deployment packaging. Without it, discovery checks:

1. `native/windows-source-proof/bin/windows-source-proof.exe`
2. `native/windows-source-proof/target/release/windows-source-proof.exe`

There is no executable-path or timeout environment override.

The methods are:

```text
async begin(filePath, offset, expectedInfo)
async verify(filePath, validation, offset, expectedInfo)
async advance(filePath, verified, newOffset, expectedInfo)
close()
```

`begin` and `verify` return:

```js
{
  kind: "ntfs-usn-v1",
  offset,
  validation: { kind: "ntfs-usn-v1", offset, token },
  info: <Node fs.Stats>,
  readBytes: 0,
  journalBytes
}
```

`advance` returns:

```js
{
  validation: { kind: "ntfs-usn-v1", offset: newOffset, token },
  readBytes: 0,
  journalBytes
}
```

Any unavailable or unsafe result is `null`. `journalBytes` is the sum of bytes
returned by successful bounded journal-query, seal, and journal-read calls for
that operation. It is not source-content bytes.

The bridge compares the caller's size and mtime with a fresh Node `fs.stat`
before invoking the native helper. The helper independently validates the file
size and exact NTFS mtime and checks the volume serial, 128-bit file ID, and
FRN64. Large integer identity and cursor fields stay in the native payload and
are encoded as hexadecimal strings in the token.

One helper process is lazily started per `WindowsSourceProof` instance.
Requests are serialized. The bridge bounds requests to 128 KiB, responses to
exactly 1 MiB of UTF-8 bytes, tokens to 512 characters, and each request to a
fixed three-second timeout. A timeout, spawn error, child exit, malformed or
invalid UTF-8 response, wrong request ID, oversized response, or trailing
protocol data disables that instance and terminates its helper. `close()` is
synchronous and fails an in-flight request safely.

The native helper itself caps requests at 128 KiB, uses 64 KiB journal pages,
at most 64 pages, 4 MiB of returned journal data, 16,384 records, 8,192
unrelated records, and two seconds of scan time. It requires monotonic USN
progress and page consumption, so a short or non-progressing read cannot loop.

## Fence rule

The token persisted between operations contains:

```text
ntfs-usn-v1:journalId:sealUsn:volume:fileId128:frn64:offset:size:mtimeNs
```

The exact seal USN returned by `FSCTL_WRITE_USN_CLOSE_RECORD` is persisted.
`NextUsn` queried after that seal is never substituted for the seal USN.

For `verify` or `advance` from an old token:

1. Query the journal before the new seal and check journal ID, retention
   floors, flags, and supported major versions.
2. Open only a shared read handle to the source and match expected size, mtime,
   volume, 128-bit ID, and FRN64.
3. Request a new file seal and retain its exact returned USN.
4. Query again and reject journal-ID, flag, version, range, or retention-floor
   changes. Both the old and new seals must be at or above the end floor.
5. Read inclusively from the old seal USN through the new seal USN.
6. Require the old baseline at that exact USN with `CLOSE`, exclude it from the
   transition, and OR all target-identity records strictly after it through the
   new seal.
7. Require the target-identity record at the exact new seal USN with `CLOSE`.
8. Recheck the source snapshot so it did not change during the proof operation.
9. Persist the new exact seal USN. Records beyond it are deliberately not part
   of this interval.

Zero records, absent old or new seals, incomplete pagination, malformed output,
retention gaps, identity changes, excessive activity, or unknown record
versions make the operation unavailable. The implementation never derives a
new checkpoint from the first eight output bytes after the seal.

## Reason and identity policy

Target records matched by exact file identity are accepted only when their
combined reason mask is contained in:

```text
DATA_EXTEND | BASIC_INFO_CHANGE | CLOSE
```

The baseline and new seal records must both contain `CLOSE`. A target overwrite,
truncation, create, delete, rename, or unknown reason rejects the interval.
`BASIC_INFO_CHANGE` and `CLOSE` do not establish content growth by themselves;
they are allowed because the native snapshots and the main parser still own the
unchanged-content decision.

If the source size is unchanged, the interval can certify an unchanged or
metadata-only state. If size grew, `DATA_EXTEND` must be present. If size
decreased, the interval is unavailable. Absolute-path reuse alone cannot pass:
the replacement has a different 128-bit file ID and FRN64 and is rejected.

Natural journal coalescing is never treated as a zero-mutation result. Every
accepted interval is bracketed by an exact old seal and a newly returned seal,
requires both identity-matched seal records, and requires complete bounded
coverage of all target records between them.

`FSCTL_READ_FILE_USN_DATA` is not used. Its documented Reason field cannot
certify an append.

## API controls and tested status

The helper uses these Windows controls:

```text
FSCTL_QUERY_USN_JOURNAL               0x000900F4
FSCTL_READ_UNPRIVILEGED_USN_JOURNAL   0x000903AB
FSCTL_WRITE_USN_CLOSE_RECORD          0x000900EF
```

On the tested C: directory handle:

- `FSCTL_QUERY_USN_JOURNAL` succeeded under the ordinary token and returned
  the 80-byte `USN_JOURNAL_DATA_V2` structure.
- `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` succeeded with bounded 64 KiB output.
- `FSCTL_WRITE_USN_CLOSE_RECORD` succeeded on the private fixture's read-only
  handles and returned one positive 64-bit USN in an 8-byte output buffer.

Every W3 operation reported below either completed these checks with
`ERROR_SUCCESS (0)` or became `null`; the bridge intentionally normalizes
unavailable API details to safe fallback. The earlier accepted W2 probe records
the concrete ordinary-token query and read results for C:. E: remains
`JOURNAL_NOT_ACTIVE` under W1's tested conditions.

Final observation counters from `W3_OBSERVATION`:

| Label | Available | Journal bytes | Journal ID | Exact seal USN |
| --- | --- | ---: | --- | --- |
| baseline | yes | 168 | `01dd1dd4195f46ce` | `000000049f30ea80` |
| unchanged | yes | 1,216 | `01dd1dd4195f46ce` | `000000049f30eef8` |
| append-1 | yes | 1,936 | `01dd1dd4195f46ce` | `000000049f30f830` |
| append-2 | yes | 1,536 | `01dd1dd4195f46ce` | `000000049f310060` |
| overwrite-append-1 | no | n/a | n/a | n/a |
| reset-1 | yes | 168 | `01dd1dd4195f46ce` | `000000049f3108d8` |
| overwrite-append-2 | no | n/a | n/a | n/a |
| reset-2 | yes | 168 | `01dd1dd4195f46ce` | `000000049f3110c0` |
| reader-restart-append | yes | 2,576 | `01dd1dd4195f46ce` | `000000049f313a78` |
| truncate | no | n/a | n/a | n/a |
| truncate-reset | yes | 168 | `01dd1dd4195f46ce` | `000000049f314120` |
| rename | no | n/a | n/a | n/a |
| renamed-baseline | yes | 168 | `01dd1dd4195f46ce` | `000000049f315000` |
| same-path-replacement | no | n/a | n/a | n/a |
| replacement-baseline | yes | 168 | `01dd1dd4195f46ce` | `000000049f315640` |

These counters show that bounded work is observable. The exact byte count varies
with pages and unrelated volume activity. Nothing here proves constant-size
journal work or a fixed latency.

## Verification matrix

The integration starts `node -e` as a separate writer process. That process
opens the synthetic fixture with `r+` and keeps the handle open across:

1. A baseline seal.
2. An unchanged-source `advance`.
3. Two separate append intervals.
4. Two separate old-prefix overwrite plus append intervals.
5. A helper-process restart followed by another append.
6. A real truncate.
7. A close, rename, and same-identity baseline at the renamed path.
8. Creation of a replacement at the original path with a new identity.

Every content mutation has an independent deterministic expected byte array,
full read-back, exact length, and SHA-256 check before the proof result is
accepted. Rename content is also read back. The assertions establish:

- both append-only intervals are available;
- unchanged-source advance is available;
- both mixed overwrite+append intervals are unavailable;
- truncate is unavailable;
- helper restart and later append are available;
- rename is unavailable for interval advancement while preserving the original
  identity for a fresh baseline;
- the same-path replacement is rejected against the old token and receives a
  different identity on a fresh baseline.

Rust unit tests add synthetic V2/V3 parser coverage, exact identity extraction,
truncated and unsupported record rejection, malformed name bounds, token
round-trip and size limits, unsafe reason rejection, journal flag/version/gap
validation, retention-floor checks at the start, old seal, and new seal, and an
end-version change.

Node protocol tests cover missing executable, closed helper, malformed JSON,
invalid UTF-8, truncated output, unavailable response, unsupported `kind`,
oversized output, timeout, and native helper footprint reporting.

The non-Windows path returns `null` before process launch. Filesystems without
an active supported NTFS journal likewise become unavailable through native
API failure rather than a normal-ingestion exception.

## Build and exact commands

All commands were run from the workspace with PowerShell 7 (`pwsh`). Rust
dependencies are pinned in `Cargo.lock`. The build command is a separate local
step; normal application refresh never invokes Cargo.

Format and native tests:

```powershell
cargo fmt --manifest-path native/windows-source-proof/Cargo.toml
cargo test --manifest-path native/windows-source-proof/Cargo.toml --target-dir output/native/windows-source-proof/build --offline
pwsh -NoProfile -File native/windows-source-proof/build.ps1
```

The build script compiles `target/release/windows-source-proof.exe` and copies
it to the first path discovered at runtime,
`native/windows-source-proof/bin/windows-source-proof.exe`. It does not install
a service, alter a journal, change global Rust settings, or compile during an
application refresh.

JavaScript and type checks:

```powershell
npx.cmd biome check src/usage-source-native.js test/usage-source-native.test.js
npx.cmd tsc -p tsconfig.checkjs.json --pretty false
npx.cmd tsc --noEmit --allowJs --checkJs --module NodeNext --moduleResolution NodeNext --target ES2022 --types node src/usage-source-native.js test/usage-source-native.test.js --pretty false
```

Biome and the final targeted W3 type check passed. The repository-wide
`tsconfig.checkjs.json` check was also run while main-owned source work was in
progress; at that point it reported errors only in `src/server.js`,
`src/usage-source-watch.js`, and `src/usage-store.js`. No W3-owned file was in
that failure list. Those source contracts remain with main.

Final active-journal integration:

```powershell
node --test test/usage-source-native.test.js
```

The first proof instance uses default binary discovery, which resolves the
locally built `bin` artifact. The reader-restart instance passes that same path
through the constructor's internal test injection. The test prints the
fixture's bounded journal counters directly.

The final integration was executed outside the command sandbox. The recorded
process identity was:

```text
user:                 DESKTOP-D61AMRC\Silver
authentication type:  NTLM
Administrator:        false
system:               false
pwsh:                 7.6.5
Node:                 v24.19.0
OS:                   Microsoft Windows NT 10.0.26300.0
architecture:         X64
context:              outside command sandbox; UAC not used
```

Results:

```text
Rust tests:       7 passed
Node tests:       4 passed
failures:         0
skipped:          0
```

The protocol-timeout test took 3,238.548 ms and passed assertions requiring the
fixed timeout to fire after 2.5 seconds and before 6 seconds. There is no timeout
environment override.

The preserved integration log is:

```text
output/native/windows-source-proof/w3-native-test.log
```

The release artifact is:

```text
native/windows-source-proof/bin/windows-source-proof.exe
```

Measured final release artifact and helper:

```text
executable bytes:       293376
SHA-256:                17fb2137fd285a313ecd946f4bee4bb7a0eb35ed62303db845de6adc4b98031e
working set bytes:      4542464
peak working set bytes: 4542464
pagefile usage bytes:   659456
```

This is one sample for one helper, not an aggregate for many writer instances.

## Deployment limits

The repository does not package or compile a Windows executable during normal
application startup. Deployment must run the local build script or otherwise
provide the correctly signed helper at a discovered path before packaging.
When the artifact is absent or incompatible, ingestion continues through the
content fallback with the native source proof unavailable.

The current tested artifact is Windows x64 and requires an already-active NTFS
journal that exposes V2/V3 records. It supports local drive-letter source
paths only. UNC, network, cloud-backed, reparse-heavy, and non-NTFS sources
must fall back. Runtime distribution must account for executable signing,
permissions, architecture, antivirus policy, and aggregate memory use when
many writer instances are active. No journal is enabled or configured.

## Fallback and remaining obligations

The smallest safe integration path is:

1. At offset zero, complete the main full parse, then call `begin`.
2. On a later refresh, call `verify` to cover changes through a fresh fence
   before parsing a suffix.
3. Parse the suffix without the native helper reading source bytes.
4. Call `advance` for the completed offset and source snapshot.
5. Accept the new token only on a non-null, identity- and reason-valid result.
6. On any `null`, retain the current transaction semantics and use the main
   implementation's full SHA/content fallback. Start a fresh proof baseline
   only after that safe processing succeeds.

W3 does not integrate that transaction flow, persistence, or fallback decision;
those remain with main. It also does not establish:

- behavior on every Windows version, filesystem, filter driver, or home path;
- repeatability of read-only sealing against every writer or sharing mode;
- live V4 record semantics, journal recreation, wrap timing, or heavy
  unrelated-volume activity;
- multiple concurrent writers, hard links, sparse files, reparse paths, cloud
  sync, network shares, antivirus interference, or asynchronous metadata flush;
- helper signing, installation, packaging, crash supervision, or aggregate
  resource limits for many writer processes;
- production latency or constant-size journal scanning.

Those conditions must produce fallback until separately proven. The W3 result
provides a tested native mechanism and a safe failure boundary; it is not a
universal append-safety claim.

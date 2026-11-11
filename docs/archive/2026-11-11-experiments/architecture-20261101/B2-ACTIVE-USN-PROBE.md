# B2 active-USN open-writer probe

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

Status: **W2 capability experiment completed**

Date: 2026-11-03
Workspace: `E:\12 AI\ccusage\codex-usage`

## Scope and guardrails

This card tests whether an ordinary, non-administrator Windows token can obtain
append-specific evidence from the already-active C: USN journal while a writer
handle remains open. It does not change product code, enable or alter a volume
journal, install a service, elevate through UAC, or access a real harness log or
database.

The only file fixture was a unique directory under
`C:\Users\Silver\AppData\Local\Temp\`. The probe verified that the resolved
directory was a non-reparse child of the current temp root before recursive
cleanup. The run records show cleanup succeeded:

```text
C:\Users\Silver\AppData\Local\Temp\active-usn-w2-4b5897c9561944da93edd33f7f26f266
```

The W1 E: result is not generalized to C:. W1 remains unchanged and is still
the evidence for E: `JOURNAL_NOT_ACTIVE` under its tested conditions.

## Probe and exact run context

The probe is `experiments/architecture-20261101/b2-active-usn-probe.ps1`. It
uses a self-contained PowerShell `Add-Type` C# P/Invoke block and these control
codes:

```text
FSCTL_QUERY_USN_JOURNAL               0x000900F4
FSCTL_READ_UNPRIVILEGED_USN_JOURNAL   0x000903AB
FSCTL_WRITE_USN_CLOSE_RECORD          0x000900EF
```

The last control was invoked only on the private synthetic fixture. It was not
used to modify journal configuration.

PowerShell syntax was checked before the final run:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path -LiteralPath 'experiments/architecture-20261101/b2-active-usn-probe.ps1').Path,
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.ToString() }; exit 1 }
```

Result: `PARSE_OK tokens=7759`.

The final run was outside the command sandbox so that the ordinary-token
process could read the active C: journal and create its private C: temp
fixture. The execution wrapper asked only for removal of command sandboxing;
it did not request or grant Windows elevation.

```powershell
pwsh -NoProfile -File 'experiments/architecture-20261101/b2-active-usn-probe.ps1' -RunLabel 'W2-materialization-v5' -ProbeContext outside
```

Recorded process identity:

```text
identity:      DESKTOP-D61AMRC\Silver
Administrator: false
pwsh:          7.6.5
OS:            Microsoft Windows NT 10.0.26300.0
context:       outside
outcome:       COMPLETED
assertions:    272 passed
```

Final evidence directory:

```text
output/architecture-20261103/b2/usn-active-w2-20261103T045213767Z-W2-materialization-v5-530eb10b
```

## Active C: journal API results

`FSCTL_QUERY_USN_JOURNAL` on a `GENERIC_READ`-less C: root directory handle
with `FILE_FLAG_BACKUP_SEMANTICS` succeeded under the ordinary token:

```text
Win32 status:        ERROR_SUCCESS (0)
bytes returned:      80
journal ID:          134296360686929614
first USN:           19788726272
next USN:            19825927128
lowest valid USN:    0
max USN:             17592185978880
supported versions:  2 through 4
```

`FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` also succeeded. At the initial
`NextUsn`, bounded output requests of 8, 64, 4096, and 65536 bytes each
returned exactly the 8-byte header, with no malformed or unsupported record.
This confirms the ordinary-token read capability and buffer bounds on this
volume at that checkpoint.

An exact V3 request (`MinMajorVersion=3`, `MaxMajorVersion=3`) succeeded with
`ERROR_SUCCESS`, returned 72 bytes, and contained one V2 record for the
fixture. Windows therefore did not honor the exact version range as a V3-only
filter in this observation. This is a journal-output behavior, not an API
failure, and no V3 live record was observed.

The bounded parser's V3 path was checked independently with a synthetic
102-byte V3 record. It matched the fixture's 128-bit file ID, preserved
`DATA_EXTEND`, and rejected a deliberately truncated record as malformed.
That proves parser coverage only; it is not evidence that the live journal
produced V3 records.

Forced pagination requested only 72 output bytes per page over the sealed
four-record fixture interval:

```text
pages:                 4
bytes scanned:         288
records:               4
target records:        4
unrelated records:     0
malformed records:     0
unsupported records:   0
coverage:              KNOWN
gap reason:            none
```

The paginator marks coverage `UNKNOWN` for page/byte limits, incomplete or
non-progressing ranges, checkpoints below `FirstUsn`, malformed buffers,
unsupported versions, read failures, journal-ID changes, excessive unrelated
activity, or an incomplete final range.

## Natural open-writer behavior

The writer was created with `CREATE_ALWAYS`, held open, flushed after every
mutation, and queried between checkpoints. Each expected byte array was read
back independently and checked by exact length and SHA-256.

| Step while writer stayed open | Visible target records | Observed reason mask |
| --- | ---: | --- |
| Initial 4096-byte write | 1 | `0x00000102` (`DATA_EXTEND`, `FILE_CREATE`) |
| First append | 0 | `0x00000000` |
| Second append | 0 | `0x00000000` |
| First middle overwrite plus append | 1 | `0x00000103` (`DATA_OVERWRITE`, `DATA_EXTEND`, `FILE_CREATE`) |
| Second middle overwrite plus append | 0 | `0x00000000` |
| Truncate | 1 | `0x00000107` (`DATA_OVERWRITE`, `DATA_EXTEND`, `DATA_TRUNCATION`, `FILE_CREATE`) |

After `FSCTL_WRITE_USN_CLOSE_RECORD` on the original writer, the cumulative
fixture interval contained four records with aggregate mask
`0x80000107`:

```text
DATA_OVERWRITE | DATA_EXTEND | DATA_TRUNCATION | FILE_CREATE | CLOSE
```

The latest close record retained cumulative reasons rather than identifying
the two appends that had no earlier visible record. Thus a zero-record result
between two checkpoints is not proof of no mutation, and immediate natural
USNs are not reliable per-checkpoint append evidence on this run.

## Seal trials

All seal calls below returned `ERROR_SUCCESS (0)` and 8 output bytes.

### Read-only handle with the original writer open

After an append, the direct interval contained one `DATA_EXTEND` record.
Sealing through the separate `GENERIC_READ` handle produced a new record with
`0x80000002` (`DATA_EXTEND|CLOSE`). A subsequent seal through the still-open
writer with no new mutation produced an exact delta with only
`0x80000000` (`CLOSE`).

This shows that the read-only seal created a boundary in this fixture case and
that the later mutation was not hidden behind an already-stale close marker.
After another middle overwrite plus append, sealing the writer exposed:

```text
0x00000001  DATA_OVERWRITE
0x00000003  DATA_OVERWRITE|DATA_EXTEND
0x80000003  DATA_OVERWRITE|DATA_EXTEND|CLOSE
```

The overwrite remained explicit; it was not reduced to a CLOSE-only summary.
This is one successful local observation, not a universal guarantee about
sealing another process's open writer through a read-only handle.

### Cooperating writer seal

Two append-only trials each produced a raw `DATA_EXTEND` record and then an
exact seal delta of `DATA_EXTEND|CLOSE`:

```text
trial 1: USN 19825928624 = 0x00000002; seal USN 19825928712 = 0x80000002
trial 2: USN 19825928800 = 0x00000002; seal USN 19825928888 = 0x80000002
```

Two middle-overwrite-plus-append trials each produced exactly:

```text
0x00000001  DATA_OVERWRITE
0x00000003  DATA_OVERWRITE|DATA_EXTEND
0x80000003  DATA_OVERWRITE|DATA_EXTEND|CLOSE
```

Their exact seal deltas were each one `0x80000003` close record from the prior
checkpoint. The tested intervals therefore distinguish append-only from
overwrite-plus-append without relying on file names. Cooperative sealing
requires the writer to expose the close-record operation at each evidence
boundary; the collector does not own harness writer handles.

The read-only and writer seals use `FSCTL_WRITE_USN_CLOSE_RECORD`, which asks
USN to materialize a record. The experiment did not infer that it changes the
volume journal configuration. It did confirm that the call affects journal
records for the private fixture and that reasons can still coalesce until the
resulting boundary.

## Identity and close/reopen behavior

The original file identity was:

```text
volume serial: 0xC69D8EA8
FRN64:         013D0000000C8810
file ID 128:   10880c0000003d010000000000000000
creation time: 639292783338329246 ticks
```

Assertions and direct observations established:

- Closing and reopening the same path preserved the full identity.
- Rename preserved the full identity while later append records still matched
  that identity; the rename interval also contained unrelated records, all
  bounded and covered.
- `CREATE_ALWAYS` replacement at the old path produced a different FRN64 and
  different 128-bit file ID.
- The replacement interval matched three records to the new identity and zero
  to the old identity, even though the path name was reused.

Matching used the volume's FRN64 for V2 records and the 128-bit file ID for V3
records. File names alone were never used as identity.

## Content validation and coverage interpretation

Every mutation was followed by a full independent file read. Exact lengths
were, in order, 4096, 4873, 5428, 5639, 5838, 3000, 3145, 3212, 3260, 3309,
3383, 3458, 3551, 3640, and 1024 bytes for the replacement. Each matched its
expected deterministic bytes by SHA-256. The final renamed original and the
same-path replacement also matched their independently expected contents.

The tested evidence supports these claims:

1. An ordinary, non-administrator token can query and read the active C:
   journal with the unprivileged read control.
2. Natural records from an open writer can be delayed or coalesced, so absence
   of a visible record between arbitrary checkpoints cannot certify append.
3. On this volume and run, a seal boundary exposed bounded append-only and
   mixed overwrite-plus-append reasons that agreed with independently verified
   content.
4. Filename reuse, rename, close/reopen, FRN64, 128-bit identity, malformed
   records, pagination limits, and journal gaps can be handled explicitly.

It does not support these claims:

- Every active Windows volume behaves this way.
- The unprivileged API always returns V2/V3 records or a requested version.
- A read-only handle can always finalize an arbitrary writer's pending open
  record without cooperation.
- A USN category alone proves append without a complete, bounded interval and
  independent content or source-contract validation.
- Journal work has constant production size or is safe without retention and
  race analysis.

Remaining proof obligations include live V3/V4 behavior, volume and filesystem
variety, permissions on real home files, journal wrap/retention, concurrent
writers and multiple handles, rename/replacement races, async materialization,
network or redirected homes, exact interval atomicity, and repeatability across
processes and Windows versions.

## Preserved probe runs

All exploratory runs below remain under
`output/architecture-20261103/b2/`; none was deleted.

| Run label | Result | Classification |
| --- | --- | --- |
| `W2-materialization-v1` | Failed after 5 assertions | PowerShell fixed-size collection materialization defect; probe-invalid |
| `W2-materialization-v2` | Failed after 81 assertions | Zero-byte seal output buffer returned `ERROR_INVALID_PARAMETER`; seal capability not established |
| `W2-materialization-v3` | Completed, 223 assertions | Exploratory cumulative-interval result; exact delta checks not yet present |
| `W2-materialization-v4` | Failed after 35 assertions | Probe expectation defect required a live V3 record even though the exact request returned V2; capability was not disproved |
| `W2-materialization-v5` | Completed, 272 assertions | Final corrected evidence in this card |

The corresponding v1-v4 commands used the same script with
`-ProbeContext outside` and the matching labels:

```powershell
pwsh -NoProfile -File 'experiments/architecture-20261101/b2-active-usn-probe.ps1' -RunLabel 'W2-materialization-v1' -ProbeContext outside
pwsh -NoProfile -File 'experiments/architecture-20261101/b2-active-usn-probe.ps1' -RunLabel 'W2-materialization-v2' -ProbeContext outside
pwsh -NoProfile -File 'experiments/architecture-20261101/b2-active-usn-probe.ps1' -RunLabel 'W2-materialization-v3' -ProbeContext outside
pwsh -NoProfile -File 'experiments/architecture-20261101/b2-active-usn-probe.ps1' -RunLabel 'W2-materialization-v4' -ProbeContext outside
```

## Smallest safe path

An incremental journal collector can accept an append only from a complete,
identity-matched interval whose records show an append-compatible transition
and no overwrite/truncation, with explicit handling for coalesced close records,
gaps, version limits, identity changes, and excessive activity. Any interval
that fails those conditions must be treated as unknown.

When reliable incremental information is absent, the plan's authorized safe
fallback remains a full content reread with identity, exact-length, and full
content comparison. Making seals cooperative, changing writer ownership or
share modes, or treating a read-only seal as a production guarantee would
change source or writer contracts and is outside this capability card.

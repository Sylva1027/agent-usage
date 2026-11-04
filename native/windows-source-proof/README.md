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
```

The script requires the Rust toolchain and Cargo on Windows. It builds with the
checked-in `Cargo.lock` using `--locked`, then copies the release executable to:

```text
native/windows-source-proof/bin/windows-source-proof.exe
```

The Node bridge discovers `bin/windows-source-proof.exe`, then
`target/release/windows-source-proof.exe`. Tests can pass an explicit path to
the `WindowsSourceProof` constructor.

The application does not invoke this script. A normal first refresh must not
start Cargo or wait for a compiler. Build before packaging or installation; if
the executable is absent, the bridge returns `null` and the caller uses its
content-based fallback.

## Runtime constraints

- Supported source paths must resolve to local drive-letter NTFS volumes with
  an already-active USN journal and V2/V3 records.
- The current helper is built for Windows x64. Package the binary for the
  target architecture and sign it as required by the deployment environment.
- UNC, network, cloud-backed, and non-NTFS paths are unsupported and fall back.
- The bridge has a fixed three-second per-request bound with no environment
  override. The native journal scan has its own two-second bound plus fixed page,
  byte, record, and unrelated activity limits.
- One helper process is used per `WindowsSourceProof` instance. Its measured
  footprint is small in the W3 fixture, but aggregate limits for many writers
  remain an integration responsibility.
- The helper is not a service. It starts with the writer's bridge instance and
  stops on `close()`, timeout, protocol failure, or child failure.

See `experiments/architecture-20261101/B2-NATIVE-PROOF.md` for the tested
mechanism, evidence, and remaining proof obligations.

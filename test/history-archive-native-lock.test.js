import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WindowsSourceProof } from "../src/usage-source-native.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../output");
const executable = process.env.ARCHIVE_NATIVE_TEST_HELPER;
const windows = { skip: process.platform !== "win32" };
const native = { skip: process.platform !== "win32" || !executable, timeout: 20_000 };
const kind = "windows-archive-read-lock-v2";

async function fixture(t) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "archive-lock-test-"));
  const proofs = [];
  t.after(async () => {
    for (const proof of proofs) proof.close();
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith("archive-lock-test-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const db = path.join(directory, "archive.sqlite"),
    manifest = `${db}.json`;
  const writer = new DatabaseSync(db);
  writer.exec("PRAGMA journal_mode=DELETE; CREATE TABLE fact(n); INSERT INTO fact VALUES(14)");
  writer.close();
  await writeFile(manifest, '{"format":1}');
  return {
    directory,
    db,
    manifest,
    proof(helper = executable) {
      const proof = new WindowsSourceProof(helper);
      proofs.push(proof);
      return proof;
    },
    async mock(body) {
      const helper = path.join(directory, `helper-${proofs.length}.cjs`);
      await writeFile(
        helper,
        `const fs=require('node:fs'); let count=0;
        require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
          const request=JSON.parse(line);
          const reply=value=>process.stdout.write(JSON.stringify({id:request.id,ok:true,available:true,
            kind:${JSON.stringify(kind)},token:'lease-'+(++count),...value})+'\\n');
          ${body}
        });`,
      );
      return this.proof(helper);
    },
  };
}

async function rawHelper() {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  return {
    async request(value) {
      const line = once(lines, "line");
      child.stdin.write(`${JSON.stringify({ id: ++id, ...value })}\n`);
      return JSON.parse((await line)[0]);
    },
    async end() {
      child.stdin.end();
      await exited;
      lines.close();
    },
    async kill() {
      child.kill();
      await exited;
      lines.close();
    },
  };
}

async function overwrite(file) {
  const handle = await open(file, "r+");
  try {
    await handle.write(Buffer.from("x"), 0, 1, 0);
  } finally {
    await handle.close();
  }
}

test("archive leases fall back for missing helpers and never start after bridge close", windows, async (t) => {
  const f = await fixture(t);
  const proof = f.proof(path.join(f.directory, "missing.exe"));
  assert.equal(await proof.lockFiles([f.db, f.manifest]), null);
  proof.close();
  assert.equal(await proof.lockFiles([f.db, f.manifest]), null);
  const marker = path.join(f.directory, "started");
  const closed = await f.mock(`fs.writeFileSync(${JSON.stringify(marker)},'started'); reply({});`);
  closed.close();
  assert.equal(await closed.lockFiles([f.db, f.manifest]), null);
  assert.equal(existsSync(marker), false);
});

test("archive bridge rejects invalid responses and rolls back partial acquisition", windows, async (t) => {
  const f = await fixture(t);
  for (const value of [
    { kind: "ntfs-usn-directory-v1" },
    { kind: "windows-archive-read-lock-v1" },
    { token: "" },
    { token: 1 },
    { available: false },
    { ok: false },
  ]) {
    const proof = await f.mock(`reply(${JSON.stringify(value)});`);
    assert.equal(await proof.lockFiles([f.db, f.manifest]), null);
    proof.close();
  }
  const log = path.join(f.directory, "requests.jsonl");
  const proof = await f.mock(`fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
    if(request.op==='archiveLock' && count===1) reply({ok:false,available:false});
    else reply({token:request.token || 'first'});`);
  assert.equal(await proof.lockFiles([f.db, f.manifest]), null);
  const requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    requests.map((r) => r.op),
    ["archiveLock", "archiveLock", "archiveUnlock"],
  );
  assert.equal(requests[2].path, f.db);
  assert.equal(requests[2].token, "first");
});

test(
  "archive bridge serializes requests, closes once, and invalidates failed checks permanently",
  windows,
  async (t) => {
    const f = await fixture(t);
    const log = path.join(f.directory, "requests.jsonl");
    const proof = await f.mock(`fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
    reply({token:request.token || 'lock-'+count});`);
    for (const paths of [null, [], [f.db, null], Array(65).fill(f.db)])
      assert.equal(await proof.lockFiles(paths), null);
    const lease = await proof.lockFiles([f.db, f.manifest]);
    assert.ok(lease);
    assert.deepEqual(await Promise.all([lease.check(), lease.check()]), [true, true]);
    const firstClose = lease.close();
    await lease.close();
    await firstClose;
    assert.equal(await lease.check(), false);
    const requests = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(requests.filter((r) => r.op === "archiveLock").length, 2);
    assert.equal(requests.filter((r) => r.op === "archiveUnlock").length, 2);
    const broken = await f.mock(`reply(request.op==='archiveCheck'
    ? {ok:false,available:false} : {token:request.token || 'lock-'+count});`);
    const invalid = await broken.lockFiles([f.db, f.manifest]);
    assert.ok(invalid);
    assert.equal(await invalid.check(), false);
    assert.equal(await invalid.check(), false);
    await invalid.close();
  },
);

test(
  "native archive locks block raw writes, delete, rename and replacement with SQLite readOnly",
  native,
  async (t) => {
    const f = await fixture(t);
    const proof = f.proof();
    const lease = await proof.lockFiles([f.db, f.manifest]);
    assert.ok(lease);
    assert.equal(await lease.check(), true);
    const reader = new DatabaseSync(f.db, { readOnly: true });
    try {
      reader.exec("BEGIN");
      assert.equal(reader.prepare("SELECT n FROM fact").get().n, 14);
      for (const file of [f.db, f.manifest]) {
        await assert.rejects(overwrite(file), /EPERM|EACCES|EBUSY/);
        await assert.rejects(rename(file, `${file}.moved`), /EPERM|EACCES|EBUSY/);
        await assert.rejects(unlink(file), /EPERM|EACCES|EBUSY/);
        await writeFile(`${file}.replacement`, "replacement");
        await assert.rejects(rename(`${file}.replacement`, file), /EPERM|EACCES|EBUSY/);
      }
      assert.equal(await lease.check(), true);
    } finally {
      reader.close();
      await lease.close();
    }
    assert.equal(await lease.check(), false);
    await overwrite(f.db);
    await overwrite(f.manifest);
  },
);

test("native archive pairing rolls back for an existing writer, missing file and directory", native, async (t) => {
  const f = await fixture(t);
  const proof = f.proof();
  for (const file of [f.db, f.manifest]) {
    const writer = await open(file, "r+");
    try {
      assert.equal(await proof.lockFiles([f.db, f.manifest]), null);
    } finally {
      await writer.close();
    }
    const lease = await proof.lockFiles([f.db, f.manifest]);
    assert.ok(lease);
    await lease.close();
  }
  for (const unavailable of [path.join(f.directory, "absent"), f.directory]) {
    assert.equal(await proof.lockFiles([f.db, unavailable]), null);
    const writable = await open(f.db, "r+");
    await writable.close();
    await rename(f.directory, `${f.directory}.moved`);
    await rename(`${f.directory}.moved`, f.directory);
  }
});

test("native archive leases reject parent junctions targeting distinct A/B databases", native, async (t) => {
  const f = await fixture(t);
  const a = path.join(f.directory, "A"),
    b = path.join(f.directory, "B");
  for (const directory of [a, b]) {
    await mkdir(directory);
    await copyFile(f.db, path.join(directory, "archive.sqlite"));
    await copyFile(f.manifest, path.join(directory, "archive.sqlite.json"));
  }
  const writer = new DatabaseSync(path.join(b, "archive.sqlite"));
  writer.exec("UPDATE fact SET n=99");
  writer.close();
  const junction = path.join(f.directory, "J");
  const files = [path.join(junction, "archive.sqlite"), path.join(junction, "archive.sqlite.json")];
  const proof = f.proof();
  for (const [target, expected] of [
    [a, 14],
    [b, 99],
    [a, 14],
  ]) {
    await symlink(target, junction, "junction");
    try {
      const reader = new DatabaseSync(files[0], { readOnly: true });
      try {
        assert.equal(reader.prepare("SELECT n FROM fact").get().n, expected);
      } finally {
        reader.close();
      }
      assert.equal(await proof.lockFiles(files), null, "a parent junction must never issue a reusable lease");
    } finally {
      await unlink(junction);
    }
  }
  const lease = await proof.lockFiles([f.db, f.manifest]);
  assert.ok(lease, "rejecting junctions must not disable ordinary archive locks");
  await lease.close();
});

test("native parent pool keeps case-distinct directory and junction paths separate", native, async (t) => {
  const f = await fixture(t);
  const sensitive = path.join(f.directory, "sensitive");
  await mkdir(sensitive);
  const configured = spawnSync("fsutil", ["file", "setCaseSensitiveInfo", sensitive, "enable"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  const setupError = `${configured.stdout || ""}${configured.stderr || ""}`.match(/0x[0-9a-f]{8}/i)?.[0];
  if (configured.status !== 0 || (setupError && Number.parseInt(setupError, 16) !== 0)) {
    t.skip(
      `case-sensitive scratch fixture unavailable: ${setupError ? `fsutil reported Win32 ${setupError} (exit ${configured.status})` : configured.error?.message || configured.stderr || configured.stdout}`,
    );
    return;
  }
  const ordinary = path.join(sensitive, "Case"),
    junction = path.join(sensitive, "case");
  await mkdir(ordinary);
  await copyFile(f.db, path.join(ordinary, "archive.sqlite"));
  await copyFile(f.manifest, path.join(ordinary, "archive.sqlite.json"));
  try {
    await symlink(ordinary, junction, "junction");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const status = spawnSync("fsutil", ["file", "queryCaseSensitiveInfo", sensitive], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const detail = (status.stderr || status.stdout || status.error?.message || "").trim().replace(/\s+/g, " ");
    t.skip(`Win32 junction creation aliases Case/case (EEXIST) after fsutil enable attempt; ${detail}`);
    return;
  }
  assert.equal((await lstat(ordinary)).isSymbolicLink(), false);
  assert.equal((await lstat(junction)).isSymbolicLink(), true);
  const proof = f.proof();
  const files = (directory) => [path.join(directory, "archive.sqlite"), path.join(directory, "archive.sqlite.json")];
  const warm = await proof.lockFiles(files(ordinary));
  assert.ok(warm);
  try {
    // The same target defeats final-path comparison if the pool aliases Case and case.
    assert.equal(await proof.lockFiles(files(junction)), null);
    assert.equal(await warm.check(), true);
  } finally {
    await warm.close();
  }
});

test(
  "native ancestor locks block parent rename while sibling files and main WAL remain writable",
  native,
  async (t) => {
    const f = await fixture(t);
    const parent = path.join(f.directory, "parent"),
      direct = path.join(parent, "archives");
    await mkdir(direct, { recursive: true });
    const db = path.join(direct, "archive.sqlite"),
      manifest = `${db}.json`;
    await copyFile(f.db, db);
    await copyFile(f.manifest, manifest);
    const proof = f.proof();
    const lease = await proof.lockFiles([db, manifest]);
    assert.ok(lease);
    try {
      for (const directory of [direct, parent])
        await assert.rejects(rename(directory, `${directory}.moved`), /EPERM|EACCES|EBUSY/);
      for (const directory of [direct, parent, f.directory]) {
        const source = path.join(directory, "source.jsonl"),
          moved = `${source}.moved`,
          temporary = `${source}.tmp`;
        await writeFile(source, "initial");
        await overwrite(source);
        await rename(source, moved);
        await writeFile(temporary, "replacement");
        await rename(temporary, moved);
        assert.equal(await readFile(moved, "utf8"), "replacement");
        await unlink(moved);
      }
      const hot = path.join(direct, "main.sqlite");
      const main = new DatabaseSync(hot);
      try {
        main.exec("PRAGMA journal_mode=WAL; CREATE TABLE hot(n); BEGIN; INSERT INTO hot VALUES(7); COMMIT");
        assert.equal(main.prepare("SELECT n FROM hot").get().n, 7);
        assert.equal(existsSync(`${hot}-wal`), true);
        main.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        main.close();
      }
      assert.equal(existsSync(`${hot}-wal`), false);
      assert.equal(existsSync(`${hot}-shm`), false);
      assert.equal(await lease.check(), true, "sibling changes must not invalidate directory identity checks");
    } finally {
      await lease.close();
    }
    await rename(parent, `${parent}.moved`);
    await rename(`${parent}.moved`, parent);
  },
);

test("a pinned child prevents in-place reparse mutation even through FILE_WRITE_ATTRIBUTES", native, async (t) => {
  const f = await fixture(t);
  const parent = path.join(f.directory, "parent"),
    target = path.join(f.directory, "B");
  await mkdir(parent);
  await mkdir(target);
  const db = path.join(parent, "archive.sqlite"),
    manifest = `${db}.json`;
  await copyFile(f.db, db);
  await copyFile(f.manifest, manifest);
  const script = path.join(f.directory, "set-junction.ps1");
  await writeFile(
    script,
    String.raw`param([string]$Directory, [string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
public static class ReparseMutation {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool DeviceIoControl(IntPtr file, uint code, byte[] input, uint size, IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
  public static int Set(string directory, string target) {
    var file = CreateFileW(directory, 0x100, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (file == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    try {
      var name = Encoding.Unicode.GetBytes(@"\??\" + Path.GetFullPath(target));
      using (var stream = new MemoryStream()) {
        using (var writer = new BinaryWriter(stream, Encoding.Unicode, true)) {
          writer.Write(0xA0000003u); writer.Write((ushort)(name.Length + 12)); writer.Write((ushort)0);
          writer.Write((ushort)0); writer.Write((ushort)name.Length);
          writer.Write((ushort)(name.Length + 2)); writer.Write((ushort)0);
          writer.Write(name); writer.Write((ushort)0); writer.Write((ushort)0);
        }
        var bytes = stream.ToArray(); uint returned;
        return DeviceIoControl(file, 0x900A4, bytes, (uint)bytes.Length, IntPtr.Zero, 0, out returned, IntPtr.Zero)
          ? 0 : Marshal.GetLastWin32Error();
      }
    } finally { CloseHandle(file); }
  }
}
'@
[ReparseMutation]::Set($Directory, $Target)
`,
  );
  const setJunction = () => {
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, parent, target], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout.trim(), /^\d+$/);
    return Number(result.stdout.trim());
  };
  const lease = await f.proof().lockFiles([db, manifest]);
  assert.ok(lease);
  try {
    const mutationError = setJunction();
    assert.ok(
      [32, 145].includes(mutationError),
      `a pinned nonempty parent cannot become a junction: Win32 ${mutationError}`,
    );
    assert.equal(await lease.check(), true);
  } finally {
    await lease.close();
  }
  await unlink(db);
  await unlink(manifest);
  assert.equal(setJunction(), 0, "the same attribute-only mutation succeeds on the released empty directory");
  await unlink(parent);
});

test(
  "native archive protocol bounds locks, never recycles tokens, rejects invalid requests and releases on EOF",
  native,
  async (t) => {
    const f = await fixture(t);
    const helper = await rawHelper();
    try {
      for (const invalid of [
        { id: 0, op: "archiveLock", path: f.db },
        { op: "archiveLock", path: f.db, unknown: true },
        { op: "archiveLock", path: f.db, offset: 0 },
        { op: "archiveLock", path: f.db, token: "caller-token" },
        { op: "archiveCheck", path: f.db },
        { op: "archiveUnlock", path: f.db, token: "" },
        ...[
          "",
          "E:\\",
          "E:\\NUL",
          "E:\\CON.txt",
          "E:\\a\\..\\b",
          "E:\\a\\.\\b",
          "E:\\a:stream",
          "E:\\a.",
          "E:\\a ",
          "E:\\a*",
          "\\\\.\\PhysicalDrive0",
          "\\\\?\\E:\\a",
          "relative.sqlite",
          `${f.db}\0`,
        ].map((p) => ({ op: "archiveLock", path: p })),
      ])
        assert.equal((await helper.request(invalid)).ok, false, JSON.stringify(invalid));
      const tokens = new Set();
      for (let n = 0; n < 64; n++) {
        // Reusing request IDs must still create distinct leases.
        const value = await helper.request({ id: 7, op: "archiveLock", path: f.db });
        if (!value.ok) {
          assert.match(value.reason, /archive lock limit/);
          break;
        }
        assert.equal(value.ok, true);
        assert.equal(value.kind, kind);
        assert.equal(tokens.has(value.token), false);
        tokens.add(value.token);
      }
      assert.ok(tokens.size > 1 && tokens.size < 64, "ancestors and file handles share the 64-handle bound");
      assert.equal((await helper.request({ op: "archiveLock", path: f.db })).ok, false);
      const old = tokens.values().next().value;
      assert.equal((await helper.request({ op: "archiveCheck", path: f.manifest, token: old })).ok, false);
      assert.equal((await helper.request({ op: "archiveCheck", path: f.db, token: old })).ok, true);
      assert.equal((await helper.request({ op: "archiveUnlock", path: f.db, token: old })).ok, true);
      assert.equal((await helper.request({ op: "archiveCheck", path: f.db, token: old })).ok, false);
      const fresh = await helper.request({ op: "archiveLock", path: f.db });
      assert.equal(fresh.ok, true);
      assert.equal(tokens.has(fresh.token), false);
      assert.equal((await helper.request({ op: "stats" })).ok, true);
      assert.equal((await helper.request({ op: "begin", path: f.db })).ok, false);
      await helper.end();
      await overwrite(f.db);
      await rename(f.directory, `${f.directory}.moved`);
      await rename(`${f.directory}.moved`, f.directory);
    } finally {
      await helper.kill();
    }
  },
);

test("native helper death releases both files and cannot revive old leases in a fresh helper", native, async (t) => {
  const f = await fixture(t);
  const pidFile = path.join(f.directory, "native.pid");
  const wrapper = path.join(f.directory, "proxy.cjs");
  await writeFile(
    wrapper,
    `const child=require('node:child_process').spawn(${JSON.stringify(executable)},[],
    {stdio:['pipe','pipe','pipe'],windowsHide:true});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
    process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.resume();
    child.stdin.on('error',()=>{}); child.on('exit',()=>process.exit(0));
    process.on('exit',()=>child.kill());`,
  );
  const proof = f.proof(wrapper);
  const old = await proof.lockFiles([f.db, f.manifest]);
  assert.ok(old);
  assert.equal(await old.check(), true);
  process.kill(Number(await readFile(pidFile, "utf8")));
  assert.equal(await old.check(), false);
  await old.close();
  await overwrite(f.manifest);
  await rename(f.directory, `${f.directory}.moved`);
  await rename(`${f.directory}.moved`, f.directory);
  assert.equal(await proof.lockFiles([f.db, f.manifest]), null);
  const replacement = f.proof();
  const fresh = await replacement.lockFiles([f.db, f.manifest]);
  assert.ok(fresh);
  assert.equal(await fresh.check(), true);
  assert.equal(await old.check(), false);
  await fresh.close();
  await overwrite(f.db);
});

test("archive locking works when the fixture volume journal is unavailable", native, async (t) => {
  const f = await fixture(t);
  const proof = f.proof();
  assert.equal(await proof.journal(f.directory), null, "run this fixture on the journal-unavailable E: volume");
  const lease = await proof.lockFiles([f.db, f.manifest]);
  assert.ok(lease);
  assert.equal(await lease.check(), true);
  await lease.close();
});

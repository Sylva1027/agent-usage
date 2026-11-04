import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsSourceProof } from "../src/usage-source-native.js";

test("directory protocol rejects malformed cuts, records and old-helper responses", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "usage-directory-protocol-"));
  const helper = path.join(directory, "helper.cjs");
  const journal = { format: 1, volume: "01".repeat(8), journalId: "1", firstUsn: "5", lowestValidUsn: "5", nextUsn: "20" };
  const interval = { format: 1, journalId: "1", startUsn: "5", nextUsn: "20", journalBytes: 88,
    records: [{ id: "01".repeat(8), parent: "02".repeat(8), usn: "10", reason: 2 }] };
  async function response(value, op = "changes") {
    await writeFile(helper, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);process.stdout.write(JSON.stringify({id:request.id,ok:true,available:true,
      kind:'ntfs-usn-directory-v1',value:${JSON.stringify(value)}})+'\\n');});`);
    const proof = new WindowsSourceProof(helper);
    try { return op === "journal" ? await proof.journal(directory) : await proof.changes(directory, { ...journal, nextUsn: "5" }); }
    finally { proof.close(); }
  }
  try {
    assert.ok(await response(journal, "journal"));
    assert.ok(await response(interval));
    for (const invalid of [
      { ...journal, firstUsn: "21" }, { ...journal, nextUsn: 20 }, { ...journal, journalId: "bad" },
    ]) assert.equal(await response(invalid, "journal"), null);
    for (const invalid of [
      { ...interval, journalId: "2" }, { ...interval, startUsn: "6" }, { ...interval, nextUsn: "4" },
      { ...interval, records: [{ ...interval.records[0], usn: "20" }] },
      { ...interval, records: [{ ...interval.records[0], reason: -1 }] },
      { ...interval, records: [...interval.records, ...interval.records] },
      { ...interval, records: Array(2049).fill(interval.records[0]) },
      { ...interval, journalBytes: 4 * 1024 * 1024 + 1 }, null,
    ]) assert.equal(await response(invalid), null);
    await writeFile(helper, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);process.stdout.write(JSON.stringify({id:request.id,ok:false,available:false,reason:'unsupported'})+'\\n');});`);
    const old = new WindowsSourceProof(helper);
    try { assert.equal(await old.journal(directory), null); } finally { old.close(); }
    const missing = new WindowsSourceProof(path.join(directory, "missing.exe"));
    try { assert.equal(await missing.journal(directory), null); } finally { missing.close(); }
  } finally {
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  }
});

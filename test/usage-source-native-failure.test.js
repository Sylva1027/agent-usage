import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsSourceProof } from "../src/usage-source-native.js";

const cursor = { journalId: "1", nextUsn: "10" };
const onlyWindows = { skip: process.platform !== "win32" };
async function bridge(t, body) {
  const root = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(root, "usage-native-failure-"));
  assert.ok(directory.startsWith(`${root}${path.sep}`));
  const file = path.join(directory, "helper.cjs");
  await writeFile(file, `const input=require('node:readline').createInterface({input:process.stdin});
input.on('line',line=>{const request=JSON.parse(line);${body}});`);
  const proof = new WindowsSourceProof(file);
  t.after(async () => { proof.close(); await rm(directory, { recursive: true, force: true }); });
  return proof;
}

test("directory failures retain native reasons and successful requests clear them", onlyWindows, async (t) => {
  const proof = await bridge(t, `process.stdout.write(JSON.stringify(request.op==='changes'
    ? {id:request.id,ok:false,available:false,reason:'directory response record limit'}
    : {id:request.id,ok:true,available:true,kind:'ntfs-usn-directory-v1',value:{format:1,
      path:'C:\\\\fixture',volume:'0000000000000001',id64:'0000000000000002',
      id128:'00000000000000000000000000000002',links:1,attributes:16,size:'0'}})+'\\n');`);
  assert.equal(await proof.changes("C:\\fixture", cursor), null);
  assert.deepEqual(proof.lastDirectoryFailure, { operation: "changes", reason: "directory response record limit" });
  assert.ok(await proof.object("C:\\fixture"));
  assert.equal(proof.lastDirectoryFailure, null);
});

test("malformed directory values cannot become evidence and retain a validation failure", onlyWindows, async (t) => {
  const proof = await bridge(t, `process.stdout.write(JSON.stringify({id:request.id,ok:true,available:true,
    kind:'ntfs-usn-directory-v1',value:{format:1,journalId:'1',startUsn:'10',nextUsn:'9',records:[],journalBytes:0}})+'\\n');`);
  assert.equal(await proof.changes("C:\\fixture", cursor), null);
  assert.deepEqual(proof.lastDirectoryFailure, { operation: "changes", reason: "invalid directory response" });
});

test("directory protocol failures remain distinct from an unavailable journal", onlyWindows, async (t) => {
  const proof = await bridge(t, "process.stdout.write('not-json\\n');");
  assert.equal(await proof.changes("C:\\fixture", cursor), null);
  assert.deepEqual(proof.lastDirectoryFailure, { operation: "changes", reason: "invalid native response encoding or JSON" });
});

test("directory request timeouts retain their cause without accepting evidence", onlyWindows, async (t) => {
  const proof = await bridge(t, "void request;");
  assert.equal(await proof.changes("C:\\fixture", cursor), null);
  assert.deepEqual(proof.lastDirectoryFailure, { operation: "changes", reason: "native request timed out" });
});

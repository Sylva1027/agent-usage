import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const results=[];
const cases=[
  ['off-on-off',"PRAGMA recursive_triggers=ON; INSERT OR REPLACE INTO store_meta VALUES('perf_state','new'); UPDATE events SET value=value+1; PRAGMA recursive_triggers=OFF;"],
  ['rowid-insert',"INSERT OR REPLACE INTO store_meta(rowid,key,value) SELECT rowid,'perf_indexed_at','new' FROM store_meta WHERE key='ordinary';"],
  ['rowid-update',"UPDATE OR REPLACE store_meta SET rowid=(SELECT rowid FROM store_meta WHERE key='ordinary') WHERE key='perf_state';"],
];
for(const fixed of [false,true]) for(const [name,sql] of cases) {
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE events(value INTEGER); INSERT INTO events VALUES(10); CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO store_meta VALUES('perf_state','ready'),('ordinary','original'); CREATE TEMP TABLE counter(value INTEGER); INSERT INTO counter VALUES(0); PRAGMA recursive_triggers=OFF;");
  for(const operation of ['INSERT','UPDATE','DELETE']) {
    if(fixed && operation==='INSERT') continue;
    const refs=operation==='INSERT'?['NEW']:operation==='DELETE'?['OLD']:['OLD','NEW'];
    const keys=refs.map(ref=>`${ref}.key IN ('perf_state','perf_indexed_at')`).join(' AND ');
    const when=fixed?`(SELECT recursive_triggers FROM pragma_recursive_triggers)=0 AND ${keys}${operation==='UPDATE'?' AND OLD.rowid=NEW.rowid':''}`:keys;
    db.exec(`CREATE TEMP TRIGGER audit_${operation} AFTER ${operation} ON main.store_meta WHEN ${when} BEGIN UPDATE counter SET value=value+1; END;`);
  }
  const state=()=>({total:Number(db.prepare('SELECT total_changes() n').get().n),ignored:Number(db.prepare('SELECT value FROM counter').get().value),
    facts:JSON.stringify([db.prepare('SELECT * FROM events').all(),db.prepare("SELECT * FROM store_meta WHERE key='ordinary'").all()])});
  const before=state();db.exec(sql);const after=state();
  const collision=before.total-2*before.ignored===after.total-2*after.ignored;
  assert.notEqual(before.facts,after.facts,name);
  assert.equal(collision,!fixed,name);
  results.push({name,fixed,before,after,collision});db.close();
}
fs.writeFileSync('output/q2-q3-projection-20261027/evidence/sqlite-accounting-counterexamples.json',JSON.stringify({passed:true,results},null,2));
console.log(JSON.stringify({passed:true,cases:results.length,originalCollisions:results.filter(row=>row.collision).length}));

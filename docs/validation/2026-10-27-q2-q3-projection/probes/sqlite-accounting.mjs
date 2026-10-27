import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE events(id INTEGER PRIMARY KEY, value INTEGER);
  CREATE TABLE perf(id INTEGER PRIMARY KEY, event INTEGER REFERENCES events(id) ON DELETE CASCADE, value INTEGER UNIQUE);
  CREATE TABLE store_meta(key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO events VALUES(1,10),(2,20);
  INSERT INTO perf VALUES(1,1,100),(2,2,200);
  INSERT INTO store_meta VALUES('perf_state','ready'),('ordinary','old');
  CREATE TEMP TABLE q2_ignored(value INTEGER NOT NULL);
  INSERT INTO q2_ignored VALUES(0);`);
const ignoredKey = "('perf_state','perf_indexed_at')";
for (const operation of ['INSERT','UPDATE','DELETE']) {
  const predicate = operation === 'INSERT' ? `NEW.key IN ${ignoredKey}` : operation === 'DELETE' ? `OLD.key IN ${ignoredKey}`
    : `OLD.key IN ${ignoredKey} AND NEW.key IN ${ignoredKey}`;
  for (const [table, when] of [['perf','1'],['store_meta',predicate]]) {
    db.exec(`CREATE TEMP TRIGGER q2_${table}_${operation} AFTER ${operation} ON main.${table}
      WHEN ${when} BEGIN UPDATE q2_ignored SET value=value+1; END;`);
  }
}
const version = () => `${db.prepare('PRAGMA main.schema_version').get().schema_version}/${db.prepare('PRAGMA temp.schema_version').get().schema_version}`;
const installed = version();
const counts = () => {
  const total = Number(db.prepare('SELECT total_changes() n').get().n);
  const ignored = Number(db.prepare('SELECT value FROM q2_ignored').get().value);
  const recursive = db.prepare('PRAGMA recursive_triggers').get().recursive_triggers;
  return {total,ignored,recursive,usage:total-2*ignored};
};
const key = () => { const row=counts(); return `${version()}/${row.recursive}/${version()===installed && row.recursive===0 ? row.usage : row.total}`; };
const facts = () => JSON.stringify([db.prepare('SELECT * FROM events ORDER BY id').all(),db.prepare("SELECT * FROM store_meta WHERE key NOT IN ('perf_state','perf_indexed_at') ORDER BY key").all()]);
const checks=[];
function check(label,sql,{unchangedKey=false,error=false}={}) {
  const before={key:key(),facts:facts(),...counts()};
  let failure;
  try { db.exec(sql); } catch(cause) {failure=cause.message;}
  assert.equal(Boolean(failure),error,label);
  const after={key:key(),facts:facts(),...counts()};
  if(before.facts!==after.facts) assert.notEqual(after.key,before.key,label+' must invalidate changed usage');
  if(unchangedKey) assert.equal(after.key,before.key,label);
  checks.push({label,before,after,failure});
}
check('perf update', 'UPDATE perf SET value=value+1',{unchangedKey:true});
check('perf delete', 'DELETE FROM perf WHERE id=2',{unchangedKey:true});
check('perf insert', 'INSERT INTO perf VALUES(2,2,202)',{unchangedKey:true});
check('metadata upsert', "INSERT INTO store_meta VALUES('perf_state','degraded') ON CONFLICT(key) DO UPDATE SET value=excluded.value",{unchangedKey:true});
check('metadata replace recursive off', "INSERT OR REPLACE INTO store_meta VALUES('perf_state','ready')",{unchangedKey:true});
check('unknown metadata', "UPDATE store_meta SET value='new' WHERE key='ordinary'");
check('rename leaves allowlist', "UPDATE store_meta SET key='not_perf' WHERE key='perf_state'");
check('rename enters allowlist', "UPDATE store_meta SET key='perf_state' WHERE key='not_perf'");
check('zero rows','UPDATE perf SET value=1 WHERE id=99',{unchangedKey:true});
check('mixed transaction',"BEGIN; UPDATE perf SET value=value+10; UPDATE events SET value=value+1; COMMIT;");
check('rollback ignored', 'BEGIN; UPDATE perf SET value=value+1; ROLLBACK;');
check('savepoint rollback', 'SAVEPOINT a; UPDATE perf SET value=value+1; ROLLBACK TO a; RELEASE a;');
check('cascade event deletion', 'DELETE FROM events WHERE id=2;');
check('recursive replacement guard', "PRAGMA recursive_triggers=ON; INSERT OR REPLACE INTO store_meta VALUES('perf_state','ready'); UPDATE events SET value=value+1;");
check('warm recursive replacement collision guarded', "INSERT OR REPLACE INTO store_meta VALUES('perf_state','ready'); UPDATE events SET value=value+1;");
assert.equal(checks.at(-1).before.usage,checks.at(-1).after.usage,'unprotected subtraction collides with a changed event');
db.exec('PRAGMA recursive_triggers=OFF');
check('unique abort','UPDATE OR ABORT perf SET value=100 WHERE id=1; INSERT INTO perf VALUES(3,1,100);',{error:true});
db.exec("CREATE TRIGGER side_effect AFTER UPDATE ON perf BEGIN UPDATE events SET value=value+1 WHERE id=NEW.event; END;");
check('trigger side effect and schema fallback','UPDATE perf SET value=value+1');
db.exec("CREATE TRIGGER fail_late AFTER UPDATE ON perf BEGIN SELECT RAISE(FAIL,'q2 fail'); END;");
check('FAIL keeps prior side effects','UPDATE perf SET value=value+1',{error:true});
db.exec('DROP TRIGGER fail_late');
db.exec("CREATE TRIGGER abort_late AFTER UPDATE ON perf BEGIN SELECT RAISE(ABORT,'q2 abort'); END;");
check('ABORT restores statement','UPDATE perf SET value=value+1',{error:true});
const result={sqliteVersion:db.prepare('SELECT sqlite_version() version').get().version,checks,passed:true};
db.close();
fs.writeFileSync('output/q2-q3-projection-20261027/evidence/sqlite-accounting.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:true,checks:checks.length,sqliteVersion:result.sqliteVersion}));

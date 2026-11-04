import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
test('experimental index preserves cumulative aggregate and changes lookup plan', () => {
  execFileSync(process.execPath, ['--import', './experiments/architecture-20261101/startup-cumulative-index.mjs', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE events(session_id TEXT,home_id TEXT,source_path TEXT,timestamp_ms INTEGER,total INTEGER);INSERT INTO events VALUES ('s','h','old',1,7),('s','h','same',2,5),('s','other','old',3,9),('other','h','old',4,11)");
    const sql='SELECT SUM(total) AS total FROM events WHERE session_id = ? AND home_id = ? AND source_path <> ? AND timestamp_ms < ?';
    assert.equal(db.prepare(sql).get('s','h','same',5).total,7);
    assert.match(db.prepare('EXPLAIN QUERY PLAN '+sql).all('s','h','same',5)[0].detail,/architecture_session_home_time_idx/);db.close();
  `], { windowsHide: true, stdio: 'pipe' });
});

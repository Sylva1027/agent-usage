import sqlite from 'node:sqlite';
const prepare = sqlite.DatabaseSync.prototype.prepare, indexed = new WeakSet();
sqlite.DatabaseSync.prototype.prepare = function(sql, ...args) {
  if (!indexed.has(this) && sql.includes('FROM events WHERE session_id = ? AND home_id = ? AND source_path <> ? AND timestamp_ms < ?')) {
    this.exec('CREATE INDEX IF NOT EXISTS architecture_session_home_time_idx ON events(session_id, home_id, timestamp_ms)');
    indexed.add(this);
  }
  return Reflect.apply(prepare, this, [sql, ...args]);
};

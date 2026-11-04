import { DatabaseSync } from "node:sqlite";

/** Exact session sets share a small memory budget, then spill to an anonymous SQLite file. */
export class UsageSessionMembers {
  constructor(maxBytes = 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.sets = [];
    this.database = null;
    this.insert = null;
  }

  createSet() {
    const owner = this;
    const id = this.sets.length;
    const state = { values: new Set(), count: 0 };
    this.sets.push(state);
    return {
      add(value) {
        const member = String(value);
        if (owner.database) {
          state.count += Number(owner.insert.run(id, member).changes);
        } else if (!state.values.has(member)) {
          state.values.add(member);
          state.count += 1;
          owner.bytes += 160 + member.length * 2;
          if (owner.bytes > owner.maxBytes) owner.spill();
        }
        return this;
      },
      get size() {
        return state.count;
      },
    };
  }

  spill() {
    this.database = new DatabaseSync("");
    this.database.exec(`PRAGMA cache_size = -2048;
      CREATE TABLE members (scope INTEGER NOT NULL, member TEXT NOT NULL,
        PRIMARY KEY (scope, member)) WITHOUT ROWID; BEGIN`);
    this.insert = this.database.prepare("INSERT OR IGNORE INTO members VALUES (?, ?)");
    for (let id = 0; id < this.sets.length; id += 1) {
      for (const member of this.sets[id].values) this.insert.run(id, member);
      this.sets[id].values.clear();
    }
    this.bytes = 0;
  }

  close() {
    this.database?.close();
    this.database = null;
    this.insert = null;
    this.sets = [];
    this.bytes = 0;
  }
}

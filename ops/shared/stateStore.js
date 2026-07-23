// Generic fail-closed JSON state helper.
//
// Direct port of The Lazy Download's automation2/shared/state_store.py
// pattern (JSON state file, keyed records, "no record = not ready"),
// rewritten in JS since LazyRelay's own codebase and email agent are
// Node/TypeScript, not Python. Every ops domain creates its own StateStore
// pointed at its own state file — state is never shared across domains,
// so a bug in one domain's state can't corrupt another's.

const fs = require("fs");
const path = require("path");

class StateStore {
  constructor(stateFilePath) {
    this.path = stateFilePath;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    if (!fs.existsSync(this.path)) {
      this._write({});
    }
  }

  _read() {
    return JSON.parse(fs.readFileSync(this.path, "utf8"));
  }

  _write(data) {
    fs.writeFileSync(this.path, JSON.stringify(data, null, 2), "utf8");
  }

  /** Record a keyed result. Always stamps a UTC timestamp automatically. */
  mark(key, fields = {}) {
    const data = this._read();
    data[key] = { ...fields, _recordedAt: new Date().toISOString() };
    this._write(data);
  }

  /** Fail-closed lookup: {ok, reason, record}. No record => {ok: false, reason: "no record", record: null}. */
  check(key) {
    const record = this._read()[key];
    if (record === undefined) return { ok: false, reason: "no record", record: null };
    return { ok: true, reason: "ok", record };
  }

  get(key) {
    const record = this._read()[key];
    return record === undefined ? null : record;
  }

  all() {
    return this._read();
  }
}

module.exports = { StateStore };

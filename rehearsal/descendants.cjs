/* eslint-disable @typescript-eslint/no-require-imports -- Migration guardian ownership. */
'use strict';
const { randomUUID } = require('node:crypto');
const { insist, ownedChild } = require('./policy.cjs');
class Descendants {
  constructor(baseline = []) {
    this.records = new Map();
    this.cancelling = false;
    this.baseline = new Map(baseline.map((p) => [p.pid, p.start]));
  }
  add(child, start) {
    insist(Number.isInteger(child.pid) && child.pid > 1, 'DESCENDANT_PID');
    const r = { child, pid: child.pid, token: randomUUID(), start, exit: null, closed: false };
    this.records.set(child, r);
    child.once('exit', (code, signal) => {
      r.exit = { code, signal };
    });
    child.once('close', () => {
      r.closed = true;
    });
    child.on('error', () => {
      r.error = true;
    });
    return r;
  }
  terminate() {
    this.cancelling = true;
    for (const r of this.records.values())
      if (!r.exit && !r.closed) {
        ownedChild(r, r.child, r.token, 'SIGTERM');
        insist(r.child.kill('SIGTERM'), 'DESCENDANT_SIGNAL');
      }
  }
  inspect(tree, self) {
    const descendants = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of tree)
        if ((p.ppid === self || descendants.has(p.ppid)) && !descendants.has(p.pid)) {
          descendants.add(p.pid);
          changed = true;
        }
    }
    const active = [...this.records.values()].filter((r) => !r.closed);
    const known = new Set(active.map((r) => r.pid));
    if (this.baseline.size)
      insist(
        tree.every(
          (p) =>
            this.baseline.get(p.pid) === p.start ||
            active.some((r) => r.pid === p.pid && r.start === p.start),
        ),
        'UNTRACKED_NAMESPACE_PROCESS',
      );
    insist(
      [...descendants].every((pid) => known.has(pid)),
      'UNTRACKED_DESCENDANT',
    );
    return descendants.size === 0 && [...this.records.values()].every((r) => r.closed);
  }
}
function procTree(io) {
  const rows = [];
  for (const name of io.readdirSync('/proc').filter((v) => /^\d+$/.test(v))) {
    try {
      const stat = io.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      rows.push({ pid: Number(name), ppid: Number(fields[1]), start: fields[19] });
    } catch (error) {
      insist(error.code === 'ENOENT' || error.code === 'ESRCH', 'PROCESS_INVENTORY_INDETERMINATE');
    }
  }
  return rows;
}
module.exports = { Descendants, procTree };

import { InvalidInput } from './csv.js';

export class MemoryArchive {
  files = new Map(); receipts = new Map(); reads = 0; denied = false; failReceiptOnce = false;
  upload(event, csv) {
    if (this.denied) throw new Error('Upload denied. No object exists, so no finalized event exists.');
    this.files.set(`${event.data.name}#${event.data.generation}`, csv);
  }
  async read(c) { this.reads++; const csv = this.files.get(`${c.name}#${c.generation}`); if (csv === undefined) throw new InvalidInput('generation_missing', 'This exact archive generation is unavailable. Never substitute the latest file.'); return csv; }
  async receipt(key) { return this.receipts.get(key); }
  async record(key, result) {
    if (this.failReceiptOnce) { this.failReceiptOnce = false; throw new Error('Receipt store temporarily unavailable.'); }
    this.receipts.set(key, structuredClone(result));
  }
}

export class MemoryWarehouse {
  rows = new Map(); queues = new Map(); merges = 0; failMergeOnce = false;
  async exclusive(partition, action) {
    const previous = this.queues.get(partition) ?? Promise.resolve();
    let release; const wait = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => wait); this.queues.set(partition, queued);
    await previous;
    try { return await action(); } finally { release(); if (this.queues.get(partition) === queued) this.queues.delete(partition); }
  }
  async merge(c, records) {
    this.merges++;
    if (this.failMergeOnce) { this.failMergeOnce = false; throw new Error('Warehouse temporarily unavailable.'); }
    const next = new Map(this.rows); let changed = 0;
    for (const row of records) {
      const key = `${c.partition}/${row.product_id}`, old = next.get(key);
      if (!old || row.observed_at > old.observed_at) { next.set(key, structuredClone(row)); changed++; }
      else if (row.observed_at === old.observed_at && (row.amount !== old.amount || row.currency !== old.currency)) throw new InvalidInput('ambiguous_record', 'Conflicting price at the same observation time.');
    }
    this.rows = next;
    return changed;
  }
  snapshot() { return [...this.rows.values()].sort((a, b) => a.product_name.localeCompare(b.product_name) || (a.url ?? '').localeCompare(b.url ?? '')); }
}

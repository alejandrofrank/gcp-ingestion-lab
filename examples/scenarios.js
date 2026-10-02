import { readFile } from 'node:fs/promises';
import { createLoader, eventContext, normalizeRows, digest } from '../src/engine.js';
import { MemoryArchive, MemoryWarehouse } from '../src/memory.js';
const CSV = await readFile(new URL('../fixtures/catalog.csv', import.meta.url), 'utf8');
export const CONFIG = { bucket: 'demo-archive', vendors: { 'mercado-demo': 'retail' } };
export function makeEvent(generation = '41') { return { id: `delivery-${generation}`, type: 'google.cloud.storage.object.v1.finalized', data: { bucket: CONFIG.bucket, name: 'retail/mercado-demo/2026/06/01/catalog.csv', generation } }; }
export const SCENARIOS = [
  { id: 'healthy', name: 'Happy path', tag: 'ONE BATCH', description: 'Eight source listings. One read. One warehouse merge.', lesson: 'Small files stay simple: fixed schema, bounded memory, and a batch merge.' },
  { id: 'duplicate', name: 'Send it twice', tag: 'AT LEAST ONCE', description: 'Deliver the same file event twice. Watch the second delivery do almost nothing.', lesson: 'A durable receipt avoids repeated cloud work; the merge also tolerates a lost receipt.' },
  { id: 'denied', name: 'Scraped ≠ uploaded', tag: 'THE SILENT GAP', description: 'The collector finishes, but its upload permission is gone.', lesson: 'No object means no event. An event consumer cannot report a collector failure it never receives. Monitor expected publication separately.' },
  { id: 'schema', name: 'Sneak in a column', tag: 'NO SCHEMA GUESSING', description: 'A CSV tries to supply its own product_id. Reject it while keeping the file.', lesson: 'Source data cannot change warehouse identity or silently expand the schema.' },
  { id: 'late', name: 'Yesterday calls back', tag: 'GENERATION MATTERS', description: 'A newer price arrives before an older event. Read both exact generations.', lesson: 'Arrival time is not observation time. A late event must never roll a price backwards.' },
  { id: 'receipt', name: 'Commit, then crash', tag: 'THE AWKWARD MIDDLE', description: 'Rows commit, then writing the success receipt fails. Retry the event.', lesson: 'Commit and reporting are different boundaries. The retry sees the same file and adds no duplicate observations.' },
  { id: 'identity', name: 'Two URLs, one name', tag: 'THE IDENTITY TRAP', description: 'See name-based identity collapse real listings, then see an unsafe replay double-count them.', lesson: 'Changing an identity rule is a migration. A normal replay cannot clean up old IDs automatically.' },
];

export async function runScenario(id, step = 'start') {
  const scenario = SCENARIOS.find(item => item.id === id);
  if (!scenario) throw new Error('Unknown scenario');
  const archive = new MemoryArchive(), warehouse = new MemoryWarehouse(), events = [];
  const trace = (stage, message) => events.push({ stage, message });
  const loader = createLoader({ archive, warehouse, ...CONFIG, trace });
  const event = makeEvent(); let result; let backupRows = 0;
  const deliver = async (e = event) => {
    trace('event', `Finalized event for generation #${e.data.generation}.`);
    return loader(e);
  };
  if (id === 'denied') {
    trace('source', 'Collector finished: 8 listings.'); archive.denied = true;
    try { archive.upload(event, CSV); } catch (error) { trace('archive', error.message); }
    result = { status: 'missing_publication', rows: 0 };
  } else if (id === 'identity') {
    archive.upload(event, CSV); trace('archive', 'Original CSV preserved: 8 source listings.');
    const context = eventContext(event, CONFIG), modern = normalizeRows(CSV, context).rows;
    const legacy = modern.map(row => ({ ...row, product_id: digest(`legacy-name:${row.source}:${row.product_name}`), identity_version: 'legacy-name/v0' }));
    await warehouse.merge(context, [...new Map(legacy.map(row => [row.product_id, row])).values()]); trace('validate', 'Name-based identity collapses 8 listings into 6. Two prices disappear.');
    if (step !== 'start') { await deliver(); trace('warehouse', 'Unsafe replay: 6 old IDs + 8 new IDs = 14 rows. MERGE does not remove obsolete IDs.'); }
    if (step === 'repair') {
      const before = warehouse.snapshot(); backupRows = before.length;
      // A deliberately explicit demo migration: backup, replace one partition,
      // and verify the replacement contains every archived listing. Not an API
      // exposed by the deployed event consumer.
      const replacement = new Map(modern.map(row => [`${context.partition}/${row.product_id}`, row]));
      if (replacement.size !== 8 || before.length !== 14) throw new Error('Repair precondition failed');
      warehouse.rows = replacement;
      trace('warehouse', 'Repair preview applied locally: backed up 14 rows, replaced only this vendor/day with all 8 URL-aware listings.');
    }
    result = { status: step === 'repair' ? 'repaired' : step === 'replay' ? 'double_counted' : 'collapsed', rows: warehouse.rows.size };
  } else {
    const csv = id === 'schema' ? CSV.replace('name,price,', 'product_id,price,') : CSV;
    archive.upload(event, csv); trace('source', 'Collector produced an archived CSV.');
    if (id === 'late') {
      const next = makeEvent('42');
      archive.upload(next, CSV.replaceAll('10:00:00.000Z', '10:05:00.000Z').replace('2.49,NULL', '2.19,NULL'));
      await deliver(next); result = await deliver(event);
    } else if (id === 'receipt') {
      archive.failReceiptOnce = true;
      try { await deliver(); } catch { trace('event', 'Delivery was not acknowledged. Retrying.'); }
      result = await deliver();
    } else { result = await deliver(); if (id === 'duplicate') result = await deliver(); }
  }
  return { scenario, result, events, rows: warehouse.snapshot(), metrics: { sourceRows: 8, archivedFiles: archive.files.size, warehouseRows: warehouse.rows.size, archiveReads: archive.reads, mergeJobs: warehouse.merges, receipts: archive.receipts.size, backupRows }, step };
}

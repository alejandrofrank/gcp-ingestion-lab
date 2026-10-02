import { readFile } from 'node:fs/promises';
import { createLoader, eventContext, normalizeRows } from '../src/engine.js';
import { parseCSV } from '../src/csv.js';
import { defaultsFor, techniqueOptions, normalizer, nameIdentity, ExperimentArchive, ExperimentWarehouse } from './techniques.js';
const CSV = await readFile(new URL('../fixtures/catalog.csv', import.meta.url), 'utf8');
export const CONFIG = { bucket: 'demo-archive', vendors: { 'mercado-demo': 'retail' } };
export function makeEvent(generation = '41') { return { id: `delivery-${generation}`, type: 'google.cloud.storage.object.v1.finalized', data: { bucket: CONFIG.bucket, name: 'retail/mercado-demo/2026/06/01/catalog.csv', generation } }; }
export const SCENARIOS = [
  { id: 'healthy', name: 'Happy path', tag: 'ONE BATCH', description: 'Same-name products can still be different listings.', lesson: 'Small files stay simple: fixed schema, bounded memory, and a batch merge.' },
  { id: 'duplicate', name: 'Send it twice', tag: 'AT LEAST ONCE', description: 'Repeated deliveries point to the same archived generation.', lesson: 'A durable receipt avoids repeated cloud work; the merge also tolerates a lost receipt.' },
  { id: 'denied', name: 'Scraped ≠ uploaded', tag: 'THE SILENT GAP', description: 'The collector finishes, but its upload permission is gone.', lesson: 'No object means no event. An event consumer cannot report a collector failure it never receives. Monitor expected publication separately.' },
  { id: 'schema', name: 'Sneak in a column', tag: 'NO SCHEMA GUESSING', description: 'A CSV tries to supply its own product_id. Reject it while keeping the file.', lesson: 'Source data cannot change warehouse identity or silently expand the schema.' },
  { id: 'late', name: 'Newer first, older last', tag: 'GENERATION MATTERS', description: 'A newer price arrives before an older event. Read both exact generations.', lesson: 'Arrival time is not observation time. A late event must never roll a price backwards.' },
  { id: 'receipt', name: 'Commit, then crash', tag: 'THE AWKWARD MIDDLE', description: 'Rows commit, then writing the success receipt fails. Retry the event.', lesson: 'Commit and reporting are different boundaries. The retry sees the same file and adds no duplicate observations.' },
  { id: 'identity', name: 'Two URLs, one name', tag: 'THE IDENTITY TRAP', description: 'Two source URLs share a product title. Compare the identity rules.', lesson: 'Changing an identity rule is a migration. A normal replay cannot clean up old IDs automatically.' },
].map(scenario => ({ ...scenario, defaults: defaultsFor(scenario.id) }));

export async function runScenario(id, step = 'start', overrides = {}) {
  const scenario = SCENARIOS.find(item => item.id === id);
  if (!scenario || !['start', 'replay', 'repair'].includes(step)) throw new Error('Unknown scenario or step');
  const options = techniqueOptions(id, step, overrides);
  const baseCSV = CSV.replace('2.49,NULL', options.milkPrice + ',NULL');
  const source = parseCSV(baseCSV);
  const archive = new ExperimentArchive(options), warehouse = new ExperimentWarehouse(options), events = [];
  const trace = (stage, message) => events.push({ stage, message: !options.latest && stage === 'warehouse' ? message.replace('Older observations cannot replace newer ones.', 'Last arrival wins, even if its observation is older.') : message });
  const loader = createLoader({ archive, warehouse, ...CONFIG, trace, normalize: normalizer(options) });
  const event = makeEvent(); let result; let backupRows = 0, skipped = 0, deliveries = 0;
  const deliver = async (e = event) => {
    deliveries++;
    trace('event', `Finalized event for generation #${e.data.generation}.`);
    const result = await loader(e);
    if (result.duplicate) skipped++;
    return result;
  };
  let inputCSV = baseCSV;
  if (id === 'denied') {
    trace('source', 'Collector finished: 8 listings.'); archive.denied = true;
    try { archive.upload(event, baseCSV); } catch (error) { trace('archive', error.message); }
    result = { status: 'missing_publication', rows: 0 };
  } else if (id === 'identity') {
    archive.upload(event, baseCSV); trace('archive', 'Original CSV preserved: 8 source listings.');
    const context = eventContext(event, CONFIG), modern = normalizeRows(baseCSV, context).rows;
    if (step === 'start') {
      result = await deliver();
      for (let i = 1; i < options.deliveries; i++) result = await deliver();
    } else {
      const legacy = modern.map(row => ({ ...row, product_id: nameIdentity(row), identity_version: 'legacy-name/v0' }));
      await warehouse.merge(context, [...new Map(legacy.map(row => [row.product_id, row])).values()]);
      trace('validate', 'Name-based identity collapses 8 listings into 6. Two prices disappear.');
      await deliver(); trace('warehouse', 'Unsafe replay: 6 old IDs + 8 new IDs = 14 rows. MERGE does not remove obsolete IDs.');
    }
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
    result = { status: step === 'repair' ? 'repaired' : step === 'replay' ? 'double_counted' : options.identity === 'name' ? 'collapsed' : 'loaded', rows: warehouse.rows.size };
  } else {
    const csv = id === 'schema' ? baseCSV.replace('name,price,', 'product_id,price,') : baseCSV;
    inputCSV = csv;
    archive.upload(event, csv); trace('source', 'Collector produced an archived CSV.');
    if (id === 'late') {
      const next = makeEvent('42');
      archive.upload(next, baseCSV.replaceAll('10:00:00.000Z', '10:05:00.000Z').replace(options.milkPrice + ',NULL', '2.19,NULL'));
      await deliver(next); result = await deliver(event);
    } else if (id === 'receipt') {
      archive.failReceiptOnce = true;
      try { await deliver(); } catch { trace('event', 'Delivery was not acknowledged. Retrying.'); }
      result = await deliver();
    } else result = await deliver();
    for (let i = 1; i < options.deliveries; i++) result = await deliver();
  }
  const context = eventContext(event, CONFIG), candidates = normalizeRows(baseCSV, context).rows;
  const inputRows = source.map((row, index) => {
    const stable = candidates.find(candidate => candidate.url === row.url);
    return { ...row, index, stable_id: stable.product_id, derived_id: options.identity === 'name' ? nameIdentity(stable) : stable.product_id };
  });
  return { scenario, result, events, rows: warehouse.snapshot(), options, step,
    input: { rows: inputRows, csv: inputCSV, name: event.data.name, generation: '41', validSchema: id !== 'schema',
      newerGeneration: id === 'late' ? { generation: '42', price: '2.19', timestamp: '10:05:00 UTC' } : null },
    metrics: { sourceRows: source.length, archivedFiles: archive.files.size, warehouseRows: warehouse.rows.size, archiveReads: archive.reads, mergeJobs: warehouse.merges, receipts: archive.receipts.size, backupRows, deliveries, skipped } };
}

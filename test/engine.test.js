import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLoader, eventContext, normalizeRows, productIdentity, InvalidInput } from '../src/engine.js';
import { parseCSV } from '../src/csv.js';
import { MemoryArchive, MemoryWarehouse } from '../src/memory.js';
import { CONFIG, makeEvent, runScenario } from '../examples/scenarios.js';
const csv = await readFile(new URL('../fixtures/catalog.csv', import.meta.url), 'utf8');
const context = eventContext(makeEvent(), CONFIG);
const hasCode = code => error => error instanceof InvalidInput && error.code === code;
function setup(text = csv) {
  const archive = new MemoryArchive(), warehouse = new MemoryWarehouse(), event = makeEvent();
  archive.upload(event, text);
  return { archive, warehouse, event, load: createLoader({ archive, warehouse, ...CONFIG }) };
}

test('CSV supports BOM, CRLF, embedded newline, comma and escaped quotes', () => {
  const text = '\uFEFFname,price,timestamp,currency\r\n"Tea, ""mint""\nloose",1.40,2026-06-01T10:00:00.000Z,USD\r\n';
  assert.equal(parseCSV(text)[0].name, 'Tea, "mint"\nloose');
});
test('CSV rejects malformed quoting and mismatched widths', () => {
  assert.throws(() => parseCSV('name,price,timestamp,currency\n"a"x,1,t,USD'), hasCode('csv_syntax'));
  assert.throws(() => parseCSV('name,price,timestamp,currency\n"a,1,t,USD'), hasCode('csv_syntax'));
  assert.throws(() => parseCSV('name,price,timestamp,currency\na,1,USD'), hasCode('csv_width'));
});
test('CSV rejects unknown, duplicate and missing columns', () => {
  for (const text of [csv.replace('name,price', 'product_id,price'), csv.replace('name,price', 'name,name'), csv.replace('name,price,', 'name,')]) {
    assert.throws(() => parseCSV(text), hasCode('schema'));
  }
});
test('CSV bounds bytes, row count and field size; header alone is not success', () => {
  assert.throws(() => parseCSV(csv, { maxBytes: 20 }), hasCode('file_size'));
  assert.throws(() => parseCSV(csv, { maxRows: 7 }), hasCode('row_limit'));
  assert.throws(() => parseCSV(csv, { maxField: 4 }), hasCode('field_limit'));
  assert.throws(() => parseCSV('name,price,timestamp,currency\n'), hasCode('empty_file'));
});
test('event rejects foreign buckets, unknown vendors, traversal, invalid dates and missing generations', () => {
  for (const change of [
    { bucket: 'foreign-archive' }, { generation: '' }, { name: '../catalog.csv' },
    { name: 'retail/unknown/2026/06/01/catalog.csv' }, { name: 'retail/mercado-demo/2026/02/30/catalog.csv' },
  ]) {
    assert.throws(() => eventContext({ ...makeEvent(), data: { ...makeEvent().data, ...change } }, CONFIG), InvalidInput);
  }
});
test('NULL codes fall back to URL and preserve two same-name listings', () => {
  const rows = normalizeRows(csv, context).rows;
  assert.equal(rows.length, 8);
  const milk = rows.filter(r => r.product_name === 'Leche Valle Entera 1 L');
  assert.equal(milk.length, 2);
  assert.notEqual(milk[0].product_id, milk[1].product_id);
  assert.equal(milk[0].product_code, null);
});
test('a valid code survives title and URL changes; identity is vendor-scoped', () => {
  const row = { name: 'Tea', code: 'T1', url: 'https://shop.example.test/tea' };
  assert.equal(productIdentity('demo', row), productIdentity('demo', { ...row, name: 'New tea', url: 'https://shop.example.test/new' }));
  assert.notEqual(productIdentity('demo', row), productIdentity('other', row));
});
test('malformed prices, unspecified currency, wrong day and unsafe URL fail atomically', async () => {
  for (const [text, code] of [
    [csv.replace('2.49,NULL', '2.49x,NULL'), 'price'],
    [csv.replace('2.49,NULL', '-2.49,NULL'), 'price'],
    [csv.replace('USD', ''), 'currency'],
    [csv.replace('10:00:00.000Z', '10:00:00+00:00'), 'timestamp'],
    [csv.replace('2026-06-01T', '2026-06-02T'), 'observation_day'],
    [csv.replace('https://shop.example.test/milk-1l', 'https://user:pass@shop.example.test/milk-1l'), 'url'],
  ]) {
    const s = setup(text), result = await s.load(s.event);
    assert.equal(result.code, code);
    assert.equal(s.warehouse.rows.size, 0);
    assert.equal(s.archive.files.size, 1);
  }
});
test('equivalent decimals deduplicate; conflicting equal-time prices reject', () => {
  const text = 'name,price,code,timestamp,currency\nTea,2.49,T1,2026-06-01T10:00:00.000Z,USD\nTea,2.4900,T1,2026-06-01T10:00:00.000Z,USD';
  assert.equal(normalizeRows(text, context).rows.length, 1);
  assert.throws(() => normalizeRows(text.replace('2.4900', '3.00'), context), hasCode('ambiguous_record'));
});
test('concurrent duplicate deliveries do one read and one merge', async () => {
  const s = setup();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => s.load({ ...s.event, id: 'different-delivery-' + i })));
  assert.equal(results.filter(r => r.duplicate).length, 19);
  assert.equal(s.archive.reads, 1); assert.equal(s.warehouse.merges, 1);
  assert.equal(s.warehouse.rows.size, 8); assert.equal(s.warehouse.queues.size, 0);
});
test('lost receipt retries the committed generation without duplicating rows', async () => {
  const s = setup(); s.archive.failReceiptOnce = true;
  await assert.rejects(s.load(s.event), /Receipt store/);
  assert.equal(s.warehouse.rows.size, 8); assert.equal(s.archive.receipts.size, 0);
  const result = await s.load(s.event);
  assert.equal(result.changed, 0); assert.equal(s.warehouse.rows.size, 8);
});
test('failed warehouse commit is retried; it does not create a success receipt', async () => {
  const s = setup(); s.warehouse.failMergeOnce = true;
  await assert.rejects(s.load(s.event), /Warehouse temporarily/);
  assert.equal(s.archive.receipts.size, 0); assert.equal(s.warehouse.rows.size, 0);
  assert.equal((await s.load(s.event)).status, 'loaded');
});
test('missing old generation never silently reads the latest object', async () => {
  const s = setup(); s.archive.files.clear(); s.archive.upload(makeEvent('42'), csv);
  assert.equal((await s.load(s.event)).code, 'generation_missing');
  assert.equal(s.warehouse.rows.size, 0);
});
test('invalid-file receipt suppresses repeated validation and retains raw bytes', async () => {
  const s = setup(csv.replace('name,price', 'product_id,price'));
  assert.equal((await s.load(s.event)).status, 'invalid');
  assert.equal((await s.load(s.event)).duplicate, true);
  assert.equal(s.archive.reads, 1); assert.equal(s.warehouse.merges, 0);
  assert.equal([...s.archive.files.values()][0], csv.replace('name,price', 'product_id,price'));
});
test('late generation cannot roll the milk price backwards', async () => {
  const result = await runScenario('late');
  const milk = result.rows.find(r => r.url.endsWith('/milk-1l'));
  assert.equal(milk.amount, '2.19'); assert.equal(milk.archive_generation, '42');
  assert.equal(result.metrics.archiveReads, 2);
});
test('identity migration exposes collapse, double count, then explicit replacement', async () => {
  assert.equal((await runScenario('identity')).rows.length, 6);
  assert.equal((await runScenario('identity', 'replay')).rows.length, 14);
  const repaired = await runScenario('identity', 'repair');
  assert.equal(repaired.rows.length, 8); assert.equal(repaired.metrics.backupRows, 14);
});
test('upload denial produces no file, event, receipt or warehouse job', async () => {
  const { result, metrics } = await runScenario('denied');
  assert.equal(result.status, 'missing_publication');
  assert.equal(metrics.archivedFiles, 0); assert.equal(metrics.archiveReads, 0);
  assert.equal(metrics.mergeJobs, 0); assert.equal(metrics.receipts, 0);
});

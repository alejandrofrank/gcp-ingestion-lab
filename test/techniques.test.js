import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario } from '../examples/scenarios.js';
import { techniqueOptions } from '../examples/techniques.js';
test('the name-only experiment exposes the two lost source listings', async () => {
  const safe = await runScenario('healthy');
  const lossy = await runScenario('healthy', 'start', { identity: 'name' });
  assert.equal(safe.rows.length, 8);
  assert.equal(lossy.rows.length, 6);
  assert.equal(lossy.input.rows.length, 8);
  assert.equal(lossy.input.rows[0].derived_id, lossy.input.rows[1].derived_id);
  assert.notEqual(safe.input.rows[0].derived_id, safe.input.rows[1].derived_id);
  assert.equal(lossy.rows.find(row => row.product_name === 'Leche Valle Entera 1 L').url, 'https://shop.example.test/milk-1l-six-pack');
});
test('disabling receipts changes work, not the idempotent row count', async () => {
  const value = await runScenario('duplicate', 'start', { receipts: false, deliveries: 5 });
  assert.equal(value.rows.length, 8);
  assert.equal(value.metrics.archiveReads, 5);
  assert.equal(value.metrics.mergeJobs, 5);
  assert.equal(value.metrics.skipped, 0);
});
test('arrival ordering lets the old generation overwrite the newer price', async () => {
  const value = await runScenario('late', 'start', { latest: false });
  const row = value.rows.find(row => row.url.endsWith('/milk-1l'));
  assert.equal(row.amount, '2.49');
  assert.equal(row.archive_generation, '41');
});
test('input price changes flow to the actual output and source preview', async () => {
  const value = await runScenario('healthy', 'start', { milkPrice: '4.75' });
  assert.equal(value.input.rows[0].price, '4.75');
  assert.equal(value.rows.find(row => row.url.endsWith('/milk-1l')).amount, '4.75');
  assert.match(value.input.csv, /4.75,NULL/);
});
test('experiment options remain bounded', () => {
  for (const options of [{ deliveries: 100 }, { identity: 'user-sql' }, { milkPrice: 'NaN' }, { latest: 'false' }, { extra: true }]) {
    assert.throws(() => techniqueOptions('healthy', 'start', options));
  }
  assert.equal(techniqueOptions('identity', 'repair', { identity: 'name' }).identity, 'stable');
});

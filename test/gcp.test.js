import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { gcpAdapters } from '../src/gcp.js';
import { eventContext, normalizeRows } from '../src/engine.js';
import { CONFIG, makeEvent } from '../examples/scenarios.js';
import { readFile } from 'node:fs/promises';
const csv = await readFile(new URL('../fixtures/catalog.csv', import.meta.url), 'utf8');
const context = eventContext(makeEvent(), CONFIG);
const rows = normalizeRows(csv, context).rows;
function mock() {
  const calls = [], state = { files: new Map(), queryState: 'DONE' };
  const storage = { bucket: bucket => ({ file: (name, options) => {
    calls.push(['file', bucket, name, options]);
    const key = bucket + '/' + name, current = () => state.files.get(key);
    return {
      async download() { if (!current()) throw Object.assign(new Error('missing'), { code: 404 }); return [Buffer.from(current().data)]; },
      async getMetadata() { if (!current()) throw Object.assign(new Error('missing'), { code: 404 }); return [{ size: current().size ?? Buffer.byteLength(current().data), generation: '51' }]; },
      async save(data, opts) { calls.push(['save', name, opts]); if (current()) throw Object.assign(new Error('exists'), { code: 412 }); state.files.set(key, { data }); },
      async delete(opts) { calls.push(['lockDelete', name, opts]); state.files.delete(key); },
    };
  } }) };
  state.files.set('demo-archive/' + context.name, { data: csv });
  const bigquery = {
    dataset: name => ({ table: id => ({
      async create(opts) { calls.push(['createStage', name, id, opts]); },
      createWriteStream(opts) {
        calls.push(['load', opts]); let body = '';
        const stream = new Writable({ write(chunk, _, done) { body += chunk; done(); }, final(done) { calls.push(['loadedRows', body.trim().split('\n').map(JSON.parse)]); done(); queueMicrotask(() => stream.emit('complete')); } });
        return stream;
      },
      async delete(opts) { calls.push(['deleteStage', opts]); },
    }) }),
    async createQueryJob(opts) {
      calls.push(['query', opts]);
      if (state.submitFails) throw new Error('Submission response lost');
      return [{
        async getQueryResults() { if (state.queryFails) throw new Error(state.queryFails); return [[]]; },
        async getMetadata() { if (state.metadataFails) throw new Error('Network unavailable'); return [{ status: { state: state.queryState } }]; },
      }];
    },
  };
  return { calls, state, adapters: () => gcpAdapters({ projectId: 'sample-project', dataset: 'ingestion_lab', archiveBucket: 'demo-archive', controlBucket: 'demo-control', clients: { storage, bigquery } }) };
}
test('cloud archive reads the specified generation and rejects oversized metadata', async () => {
  const m = mock(), { archive } = await m.adapters();
  assert.equal(await archive.read(context), csv);
  assert.deepEqual(m.calls.find(c => c[0] === 'file' && c[1] === 'demo-archive')[3], { generation: '41' });
  m.state.files.get('demo-archive/' + context.name).size = 1_048_577;
  await assert.rejects(archive.read(context), { code: 'file_size' });
});
test('cloud archive rejects invalid UTF-8 and never falls back after a missing generation', async () => {
  const m = mock(), { archive } = await m.adapters();
  m.state.files.get('demo-archive/' + context.name).data = Buffer.from([0xc3, 0x28]);
  await assert.rejects(archive.read(context), { code: 'encoding' });
  m.state.files.clear();
  await assert.rejects(archive.read(context), { code: 'generation_missing' });
});
test('unsafe integer generation is rejected before the SDK can round it', async () => {
  const m = mock(), { archive } = await m.adapters();
  await assert.rejects(archive.read({ ...context, generation: '9007199254740993' }), { code: 'generation_range' });
  assert.equal(m.calls.filter(c => c[0] === 'file').length, 0);
});
test('receipts are create-only and tolerate a duplicate write', async () => {
  const m = mock(), { archive } = await m.adapters();
  assert.equal(await archive.receipt('key'), undefined);
  await archive.record('key', { status: 'loaded' });
  await archive.record('key', { status: 'invalid' });
  assert.deepEqual(await archive.receipt('key'), { status: 'loaded' });
  assert.equal(m.calls.find(c => c[0] === 'save')[2].preconditionOpts.ifGenerationMatch, 0);
});
test('partition lock excludes another worker and releases only its generation', async () => {
  const m = mock(), { warehouse } = await m.adapters();
  await warehouse.exclusive(context.partition, async () => {
    await assert.rejects(warehouse.exclusive(context.partition, async () => assert.fail()), /Partition is locked/);
  });
  assert.equal(m.calls.filter(c => c[0] === 'lockDelete').length, 1);
  assert.equal(m.calls.find(c => c[0] === 'lockDelete')[2].ifGenerationMatch, '51');
});
test('one batch load, one scoped transaction and one cleanup; no per-row calls', async () => {
  const m = mock(), { warehouse } = await m.adapters();
  assert.equal(await warehouse.merge(context, rows), null);
  assert.equal(m.calls.filter(c => c[0] === 'load').length, 1);
  assert.equal(m.calls.find(c => c[0] === 'loadedRows')[1].length, 8);
  const query = m.calls.find(c => c[0] === 'query')[1];
  assert.match(query.query, /BEGIN TRANSACTION/); assert.match(query.query, /COMMIT TRANSACTION/);
  assert.match(query.query, /t.observation_date=@day AND t.source=@vendor/);
  assert.match(query.query, /s.observed_at>t.observed_at/);
  assert.deepEqual(query.params, { day: '2026-06-01', vendor: 'mercado-demo' });
  assert.equal(query.maximumBytesBilled, '100000000');
  assert.match(query.jobId, /^merge_[a-f0-9]{32}$/);
  assert.equal(m.calls.filter(c => c[0] === 'deleteStage').length, 1);
});
test('uncertain query completion retains lock and staging table', async () => {
  const m = mock(); m.state.queryFails = 'Response lost'; m.state.queryState = 'RUNNING';
  const { warehouse } = await m.adapters();
  await assert.rejects(warehouse.exclusive(context.partition, () => warehouse.merge(context, rows)), /Response lost/);
  assert.equal(m.calls.filter(c => c[0] === 'deleteStage').length, 0);
  assert.equal(m.calls.filter(c => c[0] === 'lockDelete').length, 0);
});
test('lost submission response also retains the lock', async () => {
  const m = mock(); m.state.submitFails = true;
  const { warehouse } = await m.adapters();
  await assert.rejects(warehouse.exclusive(context.partition, () => warehouse.merge(context, rows)), /Submission response lost/);
  assert.equal(m.calls.filter(c => c[0] === 'lockDelete').length, 0);
});
test('confirmed terminal conflict releases lock and becomes an invalid-file result', async () => {
  const m = mock(); m.state.queryFails = 'Conflicting observations at the same timestamp';
  const { warehouse } = await m.adapters();
  await assert.rejects(warehouse.exclusive(context.partition, () => warehouse.merge(context, rows)), { code: 'ambiguous_record' });
  assert.equal(m.calls.filter(c => c[0] === 'deleteStage').length, 1);
  assert.equal(m.calls.filter(c => c[0] === 'lockDelete').length, 1);
});

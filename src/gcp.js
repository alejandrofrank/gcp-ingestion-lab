import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { digest, InvalidInput } from './engine.js';
const requireSDK = createRequire(new URL('../cloud/package.json', import.meta.url));

const FIELDS = [
  ['product_id', 'STRING'], ['identity_version', 'STRING'], ['source', 'STRING'],
  ['product_name', 'STRING'], ['product_code', 'STRING'], ['url', 'STRING'],
  ['amount', 'NUMERIC'], ['currency', 'STRING'], ['observed_at', 'TIMESTAMP'],
  ['observation_date', 'DATE'], ['archive_name', 'STRING'], ['archive_generation', 'STRING'],
];
export const SCHEMA = FIELDS.map(([name, type]) => ({ name, type }));

// Dependencies load only when the cloud adapter is explicitly requested.
export async function gcpAdapters({ projectId, dataset, archiveBucket, controlBucket, location = 'us-central1', maximumBytesBilled = '100000000', clients } = {}) {
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId ?? '') || !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(dataset ?? '') || !archiveBucket || !controlBucket || archiveBucket === controlBucket) throw new Error('Configure a project, dataset, and separate archive/control buckets.');
  if (!/^\d+$/.test(maximumBytesBilled)) throw new Error('maximumBytesBilled must be an integer string.');
  const storage = clients?.storage ?? new (requireSDK('@google-cloud/storage')).Storage({ projectId });
  const bq = clients?.bigquery ?? new (requireSDK('@google-cloud/bigquery')).BigQuery({ projectId });
  const control = storage.bucket(controlBucket), source = storage.bucket(archiveBucket);
  const archive = {
    async receipt(key) {
      try { const [data] = await control.file(`receipts/${key}.json`).download(); return JSON.parse(data.toString('utf8')); }
      catch (error) { if (error.code === 404) return undefined; throw error; }
    },
    async record(key, value) {
      try { await control.file(`receipts/${key}.json`).save(JSON.stringify(value), { resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: 0 } }); }
      catch (error) { if (error.code !== 412) throw error; }
    },
    async read(c) {
      // The pinned Storage SDK coerces string generations to Number. Refuse
      // unsafe integers rather than allowing a rounded generation request.
      if (!Number.isSafeInteger(Number(c.generation)) || Number(c.generation) <= 0) throw new InvalidInput('generation_range', 'Generation exceeds the pinned SDK safe integer range.');
      const file = source.file(c.name, { generation: c.generation });
      try {
        const [metadata] = await file.getMetadata();
        if (!Number.isFinite(Number(metadata.size)) || Number(metadata.size) > 1_048_576) throw new InvalidInput('file_size', 'CSV exceeds 1 MiB.');
        const [bytes] = await file.download();
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new InvalidInput('encoding', 'CSV is not valid UTF-8.'); }
      } catch (error) { if (error.code === 404) throw new InvalidInput('generation_missing', 'The event generation is unavailable; latest is never substituted.'); throw error; }
    },
  };
  const warehouse = {
    async exclusive(partition, action) {
      const lock = control.file(`locks/${digest(partition)}.json`), owner = randomUUID();
      let generation, retainLock = false;
      try {
        try { await lock.save(JSON.stringify({ owner, partition, acquiredAt: new Date().toISOString() }), { resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: 0 } }); }
        catch (error) { if (error.code === 412) throw new Error('Partition is locked. Retry later; inspect orphan locks before removing them.'); throw error; }
        const [metadata] = await lock.getMetadata(); generation = metadata.generation;
        try { return await action(); } catch (error) { retainLock = error.retainPartitionLock === true; throw error; }
      } finally {
        // No TTL stealing: a timed-out request can leave a BigQuery job running.
        // An orphan requires inspection, not a second concurrent MERGE.
        if (generation && !retainLock) await lock.delete({ ifGenerationMatch: generation });
      }
    },
    async merge(c, rows) {
      const suffix = randomUUID().replaceAll('-', ''), stage = `stage_${suffix}`;
      let retainStage = false;
      const table = bq.dataset(dataset).table(stage);
      await table.create({ schema: SCHEMA, expirationTime: String(Date.now() + 3_600_000) });
      try {
        await new Promise((resolve, reject) => {
          const stream = table.createWriteStream({ sourceFormat: 'NEWLINE_DELIMITED_JSON', schema: SCHEMA, writeDisposition: 'WRITE_EMPTY' });
          stream.on('error', reject).on('complete', resolve);
          Readable.from(rows.map(row => JSON.stringify(row) + '\n')).pipe(stream);
        });
        const target = `\`${projectId}.${dataset}.observations\``, input = `\`${projectId}.${dataset}.${stage}\``;
        const columns = FIELDS.map(([name]) => name);
        const query = `
          BEGIN TRANSACTION;
          ASSERT NOT EXISTS (
            SELECT 1 FROM ${target} t JOIN ${input} s ON t.product_id=s.product_id
            WHERE t.observation_date=@day AND t.source=@vendor AND t.observed_at=s.observed_at
              AND (t.amount!=s.amount OR t.currency!=s.currency)
          ) AS 'Conflicting observations at the same timestamp';
          MERGE ${target} t USING ${input} s
          ON t.observation_date=@day AND t.source=@vendor AND t.product_id=s.product_id
          WHEN MATCHED AND s.observed_at>t.observed_at THEN UPDATE SET
            ${columns.filter(name => !['product_id', 'source', 'observation_date'].includes(name)).map(name => `${name}=s.${name}`).join(', ')}
          WHEN NOT MATCHED THEN INSERT (${columns.join(', ')}) VALUES (${columns.map(name => 's.' + name).join(', ')});
          COMMIT TRANSACTION;`;
        let job;
        try {
          [job] = await bq.createQueryJob({ jobId: `merge_${suffix}`, labels: { component: 'ingestion-lab' }, query, location, maximumBytesBilled, useLegacySql: false, params: { day: c.date, vendor: c.vendor }, types: { day: 'DATE', vendor: 'STRING' } });
          await job.getQueryResults();
        } catch (error) {
          // A lost response is not evidence that the warehouse job stopped.
          // Retain both lock and stage unless DONE is confirmed.
          let finished = false;
          if (job) { try { const [metadata] = await job.getMetadata(); finished = metadata.status?.state === 'DONE'; } catch {} }
          if (!finished) { retainStage = true; error.retainPartitionLock = true; }
          if (finished && error.message?.includes('Conflicting observations at the same timestamp')) throw new InvalidInput('ambiguous_record', 'Conflicting price at the same observation time.');
          throw error;
        }
        // Script parent metadata does not report its child MERGE row count.
        // Return null rather than presenting a made-up efficiency number.
        return null;
      } finally { if (!retainStage) await table.delete({ ignoreNotFound: true }); }
    },
  };
  return { archive, warehouse };
}

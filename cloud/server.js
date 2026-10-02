import { createServer } from 'node:http';
import { createLoader } from '../src/engine.js';
import { gcpAdapters } from '../src/gcp.js';
const { GOOGLE_CLOUD_PROJECT: projectId, BQ_DATASET: dataset, ARCHIVE_BUCKET: bucket, CONTROL_BUCKET: controlBucket, BQ_LOCATION: location = 'us-central1' } = process.env;
const vendors = JSON.parse(process.env.VENDORS_JSON ?? '{"mercado-demo":"retail"}');
const loader = createLoader({ ...await gcpAdapters({ projectId, dataset, archiveBucket: bucket, controlBucket, location }), bucket, vendors });
createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/') { res.writeHead(404).end(); return; }
  if (req.headers['ce-type'] !== 'google.cloud.storage.object.v1.finalized' || !(req.headers['content-type'] ?? '').startsWith('application/json')) { res.writeHead(400).end('Expected a binary CloudEvent with a JSON body.'); return; }
  try {
    let body = '';
    for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 16_384) { res.writeHead(413).end(); req.destroy(); return; } }
    let data; try { data = JSON.parse(body); } catch { res.writeHead(400).end('Invalid event JSON.'); return; }
    const result = await loader({ type: req.headers['ce-type'], data });
    console.log(JSON.stringify({ eventId: req.headers['ce-id'], status: result.status, code: result.code, rows: result.rows, duplicate: result.duplicate }));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch {
    // Never echo SDK error bodies or credentials. An unacknowledged transient
    // failure is retried by Eventarc; inspect structured platform logs.
    console.error(JSON.stringify({ status: 'retryable_failure', eventId: req.headers['ce-id'] }));
    res.writeHead(503).end('Retryable ingestion failure');
  }
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0');

import { createHash } from 'node:crypto';
import { InvalidInput, parseCSV } from './csv.js';
export { InvalidInput } from './csv.js';
export const IDENTITY_VERSION = 'code-url-name/v1';
export const digest = text => createHash('sha256').update(text).digest('hex');
const present = value => value?.trim() && value.trim().toUpperCase() !== 'NULL' ? value.trim() : '';

export function productIdentity(vendor, row) {
  const code = present(row.code), url = present(row.url);
  return digest(`${vendor}|${code ? 'code:' + code : url ? 'url:' + url : 'name:' + row.name}`);
}

export function eventContext(event, { bucket, vendors }) {
  if (event?.type !== 'google.cloud.storage.object.v1.finalized') throw new InvalidInput('event_type', 'Only object-finalized events are accepted.');
  const data = event.data;
  if (!data || data.bucket !== bucket || typeof data.name !== 'string' || !/^\d{1,20}$/.test(String(data.generation ?? ''))) throw new InvalidInput('event_binding', 'Event bucket or generation does not match the configured archive.');
  const match = /^(retail|supermarket)\/([a-z][a-z0-9-]{0,40})\/(\d{4})\/(\d{2})\/(\d{2})\/([a-zA-Z0-9_-]+\.csv)$/.exec(data.name);
  if (!match) throw new InvalidInput('path', 'Expected domain/vendor/YYYY/MM/DD/file.csv.');
  const [, domain, vendor, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  if (Number(year) < 2000 || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new InvalidInput('date', 'Archive path is not a valid calendar day.');
  if (!Object.hasOwn(vendors, vendor) || vendors[vendor] !== domain) throw new InvalidInput('vendor', 'Vendor is not registered for this domain.');
  const generation = String(data.generation);
  return { domain, vendor, date, bucket, name: data.name, generation,
    partition: `${vendor}/${date}`, key: digest(`${bucket}/${data.name}#${generation}`),
    archive: `gs://${bucket}/${data.name}#${generation}` };
}

export function normalizeRows(csv, context) {
  const input = parseCSV(csv), unique = new Map();
  for (const row of input) {
    if (!row.name.trim()) throw new InvalidInput('name', 'A product name is required.');
    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,4})?$/.test(row.price)) throw new InvalidInput('price', 'Prices must be nonnegative decimal amounts. No locale guessing.');
    if (!/^[A-Z]{3}$/.test(row.currency)) throw new InvalidInput('currency', 'An explicit three-letter currency is required.');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp)) || new Date(row.timestamp).toISOString() !== row.timestamp) throw new InvalidInput('timestamp', 'Use an explicit UTC observation timestamp, including milliseconds.');
    if (row.timestamp.slice(0, 10) !== context.date) throw new InvalidInput('observation_day', 'Observation day differs from the archive day. Split files by UTC day.');
    const url = present(row.url);
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new InvalidInput('url', 'Product URL must be a valid HTTP(S) URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || url.length > 2048) throw new InvalidInput('url', 'Product URL must be HTTP(S), without embedded credentials.');
    }
    const amount = row.price.includes('.') ? row.price.replace(/0+$/, '').replace(/\.$/, '') : row.price;
    const record = { product_id: productIdentity(context.vendor, row), identity_version: IDENTITY_VERSION,
      source: context.vendor, product_name: row.name, product_code: present(row.code) || null, url: url || null,
      amount, currency: row.currency, observed_at: row.timestamp, observation_date: context.date,
      archive_name: context.name, archive_generation: context.generation };
    const previous = unique.get(record.product_id);
    if (!previous || record.observed_at > previous.observed_at) unique.set(record.product_id, record);
    else if (record.observed_at === previous.observed_at && (record.amount !== previous.amount || record.currency !== previous.currency || record.product_name !== previous.product_name || record.url !== previous.url)) throw new InvalidInput('ambiguous_record', 'One identity has conflicting observations at the same timestamp.');
  }
  return { rows: [...unique.values()], sourceRows: input.length };
}

export function createLoader({ archive, warehouse, bucket, vendors, trace = () => {}, normalize = normalizeRows }) {
  return async event => {
    let context;
    try { context = eventContext(event, { bucket, vendors }); }
    catch (error) { if (error instanceof InvalidInput) return { status: 'rejected_event', code: error.code }; throw error; }
    return warehouse.exclusive(context.partition, async () => {
      const previous = await archive.receipt(context.key);
      if (previous) { trace('event', 'Duplicate delivery: durable receipt found. No download or warehouse job.'); return { ...previous, duplicate: true }; }
      trace('archive', `Read the exact generation #${context.generation}.`);
      try {
        const csv = await archive.read(context);
        const { rows, sourceRows } = normalize(csv, context);
        trace('validate', `${sourceRows} source rows → ${rows.length} distinct identities. Schema is fixed.`);
        const changed = await warehouse.merge(context, rows);
        trace('warehouse', changed === null ? 'Warehouse committed. Older observations cannot replace newer ones.' : `${changed} changed observations. Older observations cannot replace newer ones.`);
        const result = { status: 'loaded', rows: rows.length, sourceRows, changed, generation: context.generation, archive: context.archive };
        // Commit precedes reporting. If writing this receipt fails, retry the same
        // generation; merge is idempotent. Never delete a committed source file.
        await archive.record(context.key, result);
        trace('receipt', 'Success receipt stored after the warehouse commit.');
        return result;
      } catch (error) {
        if (!(error instanceof InvalidInput)) { trace('retry', 'Transient failure: do not acknowledge; retry the same generation.'); throw error; }
        const result = { status: 'invalid', code: error.code, message: error.message, archive: context.archive };
        await archive.record(context.key, result);
        trace('validate', `Rejected: ${error.message} Original CSV is retained.`);
        return result;
      }
    });
  };
}

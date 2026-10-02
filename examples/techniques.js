import { digest, normalizeRows } from '../src/engine.js';
import { MemoryArchive, MemoryWarehouse } from '../src/memory.js';

// Deliberately unsafe rules exist only in the synthetic teaching experiment.
// The Cloud Run receiver uses the core defaults and never reads these options.
export function defaultsFor(id, step = 'start') {
  return {
    identity: id === 'identity' && step === 'start' ? 'name' : 'stable',
    receipts: true,
    latest: true,
    deliveries: id === 'duplicate' ? 2 : 1,
    milkPrice: '2.49',
  };
}

export function techniqueOptions(id, step, overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid technique options');
  const allowed = ['identity', 'receipts', 'latest', 'deliveries', 'milkPrice'];
  if (Object.keys(overrides).some(key => !allowed.includes(key))) throw new Error('Unknown technique option');
  const options = { ...defaultsFor(id, step), ...overrides };
  if (!['stable', 'name'].includes(options.identity) || typeof options.receipts !== 'boolean' || typeof options.latest !== 'boolean'
    || !Number.isInteger(options.deliveries) || options.deliveries < 1 || options.deliveries > 5
    || typeof options.milkPrice !== 'string' || !/^[0-9]\.[0-9]{2}$/.test(options.milkPrice) || Number(options.milkPrice) < 0.5) throw new Error('Technique option out of range');
  if (id === 'identity' && step !== 'start') { options.identity = 'stable'; options.deliveries = 1; }
  return options;
}

export const nameIdentity = row => digest(`legacy-name:${row.source}:${row.product_name}`);

export function normalizer(options) {
  return (csv, context) => {
    const validated = normalizeRows(csv, context);
    if (options.identity === 'stable') return validated;
    // Last listing wins: an explicit illustration of lossy name-only IDs.
    const legacy = validated.rows.map(row => ({ ...row, product_id: nameIdentity(row), identity_version: 'legacy-name/v0' }));
    return { ...validated, rows: [...new Map(legacy.map(row => [row.product_id, row])).values()] };
  };
}

export class ExperimentArchive extends MemoryArchive {
  constructor(options) { super(); this.options = options; }
  async receipt(key) { return this.options.receipts ? super.receipt(key) : undefined; }
}

export class ExperimentWarehouse extends MemoryWarehouse {
  constructor(options) { super(); this.options = options; }
  async merge(context, records) {
    if (this.options.latest) return super.merge(context, records);
    this.merges++;
    const replacement = new Map(this.rows); let changed = 0;
    for (const row of records) {
      const key = `${context.partition}/${row.product_id}`, old = replacement.get(key);
      if (!old || JSON.stringify(old) !== JSON.stringify(row)) changed++;
      replacement.set(key, structuredClone(row));
    }
    this.rows = replacement;
    return changed;
  }
}

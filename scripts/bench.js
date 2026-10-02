import { performance } from 'node:perf_hooks';
import { createLoader } from '../src/engine.js';
import { MemoryArchive, MemoryWarehouse } from '../src/memory.js';
import { CONFIG, makeEvent } from '../examples/scenarios.js';
const csv = 'name,price,code,timestamp,currency\n' + Array.from({ length: 10_000 }, (_, i) => `Item ${i},1.25,I${i},2026-06-01T10:00:00.000Z,USD`).join('\n');
const durations = [];
for (let round = 0; round < 5; round++) {
  const archive = new MemoryArchive(), warehouse = new MemoryWarehouse(), event = makeEvent();
  archive.upload(event, csv);
  const load = createLoader({ archive, warehouse, ...CONFIG }), start = performance.now();
  await load(event);
  for (let i = 0; i < 100; i++) await load({ ...event, id: 'repeat-' + i });
  durations.push(performance.now() - start);
  if (warehouse.rows.size !== 10_000 || archive.reads !== 1 || warehouse.merges !== 1) throw new Error('Efficiency invariant failed');
}
durations.sort((a, b) => a - b);
console.log(`Local simulation only · Node ${process.version}\n10,000 rows + 100 duplicate deliveries\n${Buffer.byteLength(csv)} input bytes · 1 archive read · 1 merge\nMedian of 5 rounds: ${durations[2].toFixed(1)} ms\nThis is not a cloud latency or billing benchmark.`);

import { SCENARIOS, runScenario } from './scenarios.js';
for (const scenario of SCENARIOS) {
  const value = await runScenario(scenario.id);
  console.log(`${scenario.name.padEnd(24)} ${value.result.status.padEnd(20)} rows=${value.metrics.warehouseRows} reads=${value.metrics.archiveReads} merges=${value.metrics.mergeJobs}`);
}

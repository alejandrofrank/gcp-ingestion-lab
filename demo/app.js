const $ = selector => document.querySelector(selector);
let current = 'healthy', step = 'start', busy = false;
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const warning = new Set(['invalid', 'missing_publication', 'collapsed', 'double_counted']);
function render(value) {
  const { scenario, result, metrics, rows, events } = value;
  $('#scenario-tag').textContent = scenario.tag;
  $('#scenario-title').textContent = scenario.name;
  $('#scenario-description').textContent = scenario.description;
  for (const [name, count] of [['files', metrics.archivedFiles], ['rows', metrics.warehouseRows], ['reads', metrics.archiveReads], ['jobs', metrics.mergeJobs]]) $(`#metric-${name}`).textContent = count;
  $('#lesson p').textContent = scenario.lesson;
  $('#lesson').classList.toggle('warning', warning.has(result.status));
  $('#result-status').textContent = result.status.replaceAll('_', ' ').toUpperCase();
  $('#result-status').classList.toggle('warning', warning.has(result.status));
  document.querySelectorAll('.scenario').forEach(button => { button.classList.toggle('active', button.dataset.id === current); button.setAttribute('aria-pressed', String(button.dataset.id === current)); });
  document.querySelectorAll('.flow>div').forEach(node => {
    node.classList.toggle('active', events.some(event => event.stage === node.dataset.stage));
    node.classList.toggle('fail', warning.has(result.status) && (result.status === 'missing_publication' ? node.dataset.stage === 'archive' : result.status === 'invalid' ? node.dataset.stage === 'validate' : node.dataset.stage === 'warehouse'));
  });
  $('#journal').innerHTML = events.map((event, i) => `<li class="${/reject|fail|denied|unsafe|collapse/i.test(event.message) ? 'fail' : ''}"><span class="journal-index">${String(i + 1).padStart(2, '0')}</span><div><b>${escape(event.stage.toUpperCase())}</b>${escape(event.message)}</div></li>`).join('');
  $('#rows').innerHTML = rows.map(row => `<tr><td>${escape(row.product_name)}<span class="listing-url">${escape(row.url?.replace('https://shop.example.test/', '/') ?? 'No source URL')}</span></td><td>$${Number(row.amount).toFixed(2)}</td><td>${row.identity_version === 'legacy-name/v0' ? 'NAME' : row.product_code ? 'CODE' : row.url ? 'URL' : 'NAME'}<span class="listing-url">${escape(row.product_id.slice(0, 6))}</span></td></tr>`).join('');
  $('#empty').hidden = rows.length !== 0;
  $('#identity-actions').hidden = current !== 'identity';
  $('#replay').hidden = step !== 'start'; $('#repair').hidden = step !== 'replay';
  $('#repair-note').textContent = step === 'repair' ? `${metrics.backupRows} rows backed up · 8 listings preserved` : 'Migration controls operate only on synthetic local data.';
}
async function run(id = current, nextStep = 'start') {
  if (busy) return;
  busy = true; current = id; step = nextStep; document.body.classList.add('loading');
  document.querySelectorAll('button').forEach(button => button.disabled = true);
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, step }) });
    if (!response.ok) throw new Error('The local demo could not complete this scenario.');
    render(await response.json());
  } catch (error) { $('#scenario-description').textContent = error.message; }
  finally { busy = false; document.body.classList.remove('loading'); document.querySelectorAll('button').forEach(button => button.disabled = false); }
}
const response = await fetch('/api/scenarios');
if (response.ok) {
  const scenarios = await response.json();
  $('#scenarios').innerHTML = scenarios.map(s => `<button class="scenario" data-id="${escape(s.id)}" aria-pressed="false"><span>${escape(s.tag)}</span><b>${escape(s.name)}</b></button>`).join('');
  $('#scenarios').addEventListener('click', event => { const button = event.target.closest('[data-id]'); if (button) run(button.dataset.id); });
  $('#rerun').addEventListener('click', () => run(current, step));
  $('#replay').addEventListener('click', () => run('identity', 'replay'));
  $('#repair').addEventListener('click', () => run('identity', 'repair'));
  await run();
}

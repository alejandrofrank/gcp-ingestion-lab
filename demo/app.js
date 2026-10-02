const $ = selector => document.querySelector(selector);
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const palette = ['#b8efb0', '#e8c87c', '#94b8ff', '#b3a0ef', '#efabbf', '#80ccc7', '#deb188', '#a6c9db'];
let scenarios = [], current = 'healthy', step = 'start', selected = 0, value, sequence = 0, controller, timer;
const money = amount => '$' + Number(amount).toFixed(2);
const path = url => url?.replace('https://shop.example.test/', '/') ?? 'No URL';
const basis = row => row.product_code ? 'CODE' : row.url ? 'URL' : 'NAME';
const blocked = data => ['invalid', 'missing_publication', 'rejected_event'].includes(data.result.status);
const nodeY = (index, count) => count === 1 ? 185 : 72 + index * 230 / (count - 1);
const curve = (x1, y1, x2, y2) => 'M' + x1 + ' ' + y1 + ' C' + (x1 + (x2 - x1) * .45) + ' ' + y1 + ',' + (x2 - (x2 - x1) * .45) + ' ' + y2 + ',' + x2 + ' ' + y2;
const safeId = id => id.slice(0, 5);

function controls(options) {
  $('#identity').value = options.identity;
  $('#receipts').value = String(options.receipts);
  $('#latest').value = String(options.latest);
  $('#deliveries').value = options.deliveries;
  $('#milk-price').value = options.milkPrice;
  updateKnobs();
}
function updateKnobs() {
  $('#milk-price-value').textContent = money($('#milk-price').value);
  $('#delivery-value').textContent = $('#deliveries').value;
  for (const id of ['identity', 'receipts', 'latest']) {
    const unsafe = id === 'identity' ? $('#' + id).value === 'name' : $('#' + id).value === 'false';
    $('#' + id).classList.toggle('unsafe', unsafe);
  }
}
function options() {
  return { identity: $('#identity').value, receipts: $('#receipts').value === 'true', latest: $('#latest').value === 'true',
    deliveries: Number($('#deliveries').value), milkPrice: Number($('#milk-price').value).toFixed(2) };
}

function renderInputs(data) {
  $('#input-count').textContent = data.input.rows.length + ' listings';
  $('#raw-csv').textContent = data.input.csv;
  $('#input-warning').hidden = data.input.validSchema && current !== 'denied';
  $('#input-warning').textContent = current === 'denied' ? 'Upload denied. These collected rows never become a file event.' : 'The header says product_id instead of name. The schema check will reject it.';
  $('#generation-order').hidden = !data.input.newerGeneration;
  $('#generation-order').textContent = 'Arrival order: #42 at 10:05 ($2.19), then #41 at 10:00 (' + money(data.options.milkPrice) + ').';
  $('#input-rows').innerHTML = data.input.rows.map(row => `<button class="source-row color-${row.index}" data-source="${row.index}" aria-pressed="${row.index === selected}" aria-label="Trace listing ${row.index + 1}: ${escape(row.name)}"><span class="source-number">${row.index + 1}</span><span><span class="source-name">${escape(row.name)}</span><span class="source-key">${escape(path(row.url))}</span></span><span class="source-price">${money(row.price)}</span></button>`).join('');
  $('#delivery-note').textContent = current === 'late' ? 'The newer #42 event is delivered once first.' : current === 'receipt' ? 'The failed receipt adds one automatic retry.' : 'Change the copies to see the duplicate shortcut.';
}

function outcome(data) {
  const { metrics: m, options: o } = data;
  if (data.result.status === 'missing_publication') return { title: '8 collected. Nothing published.', text: 'The upload failed before an event existed. Neither identity nor merge settings can fix a missing source file.', warning: true, status: 'UPLOAD BLOCKED' };
  if (data.result.status === 'invalid') return { title: 'The file stops at validation.', text: 'The original CSV is kept. Its unexpected header cannot redefine warehouse identity, so none of its rows are merged.', warning: true, status: 'SCHEMA REJECTED' };
  if (step === 'replay') return { title: '8 listings. 14 warehouse rows.', text: 'Six earlier name-based keys remain alongside eight stable keys. MERGE cannot infer which old identities are obsolete.', warning: true, status: 'DOUBLE COUNTED' };
  if (step === 'repair') return { title: 'The partition is back to 8 rows.', text: 'The local repair snapshots 14 rows and replaces this synthetic vendor/day with all eight archived listings.', warning: false, status: 'REPAIRED' };
  if (o.identity === 'name') return { title: '8 listings collapse into 6 identities.', text: 'Milk and keyboards each have two URLs with one name. The name-only rule keeps the last listing in each collision.', warning: true, status: '2 LISTINGS LOST' };
  if (current === 'late' && !o.latest) return { title: 'The old price wins.', text: 'Generation #41 arrived last, so its ' + money(o.milkPrice) + ' price overwrites the newer $2.19 observation. Delivery order is a poor price clock.', warning: true, status: 'OLDER PRICE WON' };
  if (current === 'late') return { title: 'Late arrival. Newer price preserved.', text: 'Generation #42 was observed at 10:05. The older 10:00 event cannot roll its $2.19 price back, even though it arrived last.', warning: false, status: 'LATEST PRESERVED' };
  if (!o.receipts && m.deliveries > 1) return { title: 'Same 8 rows. More repeated work.', text: m.deliveries + ' deliveries cause ' + m.archiveReads + ' reads and ' + m.mergeJobs + ' merges. Stable identities still prevent duplicate warehouse rows.', warning: true, status: 'REPEATED WORK' };
  if (current === 'receipt') return { title: 'A retry without a duplicate row.', text: 'The warehouse commits before the receipt write fails. The retry re-reads the file, but the second merge has nothing new to add.', warning: false, status: 'RETRY RECOVERED' };
  if (m.skipped) return { title: m.deliveries + ' deliveries. Just one batch.', text: 'The first delivery writes eight observations and a receipt. The other ' + m.skipped + ' deliveries skip the download and merge.', warning: false, status: 'DUPLICATES SKIPPED' };
  return { title: '8 listings. 8 distinct observations.', text: 'Stable code or URL identities preserve same-name listings. One batch carries the source prices into the warehouse.', warning: false, status: 'ALL LISTINGS KEPT' };
}

function renderGraph(data) {
  const input = data.input.rows, output = data.rows, focus = input[selected], stop = blocked(data);
  const width = Math.max(280, Math.round($('#lineage').getBoundingClientRect().width));
  const left = 64, middle = width / 2, right = width - 64;
  $('#lineage').setAttribute('viewBox','0 0 ' + width + ' 350');
  const groups = [...new Map(input.map(row => [row.derived_id, row])).keys()].map(id => ({ id, members: input.filter(row => row.derived_id === id) }));
  const heading = (x, title, note) => `<text class="graph-label" x="${x}" y="24" text-anchor="middle">${title}</text><text class="graph-hint" x="${x}" y="43" text-anchor="middle">${note}</text>`;
  const pickNode = (x, y, row, number, className, color, title, radius=14) => `<g class="graph-node-button" role="button" tabindex="0" data-source="${row.index}" aria-label="Trace listing ${row.index + 1}"><title>${escape(title)}</title><circle class="graph-node ${className}" cx="${x}" cy="${y}" r="${radius}" stroke="${color}"/><text class="graph-number ${radius<10 ? 'dense' : ''}" x="${x}" y="${y + 1}">${number}</text></g>`;
  let svg = heading(left, width < 450 ? 'INPUT' : 'SOURCE ROWS', input.length + ' listings') + heading(middle, stop ? 'BLOCKED' : width < 450 ? 'KEYS' : 'IDENTITY RULE', stop ? 'Not merged' : groups.length + ' derived keys') + heading(right, width < 450 ? 'OUTPUT' : 'WAREHOUSE', output.length + ' rows');
  for (const x of [(left+middle)/2,(middle+right)/2]) svg += `<line class="graph-divider" x1="${x}" y1="57" x2="${x}" y2="324"/>`;
  if (stop) {
    for (const row of input) svg += `<path class="graph-edge blocked ${row.index === selected ? 'focus' : ''}" stroke="${palette[row.index]}" d="${curve(left+14, nodeY(row.index,input.length), middle-23, 185)}"/>`;
    svg += `<circle cx="${middle}" cy="185" r="23" fill="#2a211c" stroke="#ffb586"/><path d="M${middle-8} 177L${middle+8} 193M${middle+8} 177L${middle-8} 193" stroke="#ffb586" stroke-width="2"/>`;
    svg += '<text class="graph-empty" x="'+middle+'" y="232">' + (current === 'denied' ? 'Upload denied' : 'Invalid schema') + '</text><text class="graph-empty" x="'+right+'" y="190">∅</text>';
  } else {
    for (const row of input) {
      const group = groups.findIndex(g => g.id === row.derived_id);
      svg += `<path class="graph-edge ${row.index === selected ? 'focus' : ''}" stroke="${row.index === selected ? '#b8efb0' : palette[row.index]}" d="${curve(left+14, nodeY(row.index,input.length), middle-14, nodeY(group,groups.length))}"/>`;
    }
    for (const [index, row] of output.entries()) {
      const group = groups.findIndex(g => g.id === row.product_id);
      const active = row.product_id === focus.derived_id;
      if (group >= 0) svg += `<path class="graph-edge ${active ? 'focus' : ''}" stroke="${active ? '#b8efb0' : palette[groups[group].members[0].index]}" d="${curve(middle+14,nodeY(group,groups.length),right-14,nodeY(index,output.length))}"/>`;
      else svg += `<path class="graph-edge legacy" d="${curve(right-75,323,right-14,nodeY(index,output.length))}"/>`;
    }
    for (const [index, group] of groups.entries()) {
      const active = group.id === focus.derived_id, row = group.members[0];
      svg += pickNode(middle,nodeY(index,groups.length),row,group.members.length > 1 ? '×' + group.members.length : row.index + 1,active ? 'focus' : '',active ? '#b8efb0' : palette[row.index],group.members.map(r=>r.name+' '+path(r.url)).join(' + '));
    }
    for (const [index, row] of output.entries()) {
      const group = groups.find(g => g.id === row.product_id), active = row.product_id === focus.derived_id;
      const source = group?.members[0] ?? input.find(item => item.url === row.url);
      svg += pickNode(right,nodeY(index,output.length),source,index+1,active ? 'focus' : '',group ? active ? '#b8efb0' : palette[source.index] : '#ffb586',row.product_name+' '+money(row.amount),output.length > 8 ? 9 : 14);
    }
    if (step === 'replay') svg += '<text class="graph-hint" x="'+(right-83)+'" y="341">6 earlier IDs</text>';
  }
  for (const row of input) svg += pickNode(left,nodeY(row.index,input.length),row,row.index+1,row.index===selected ? 'focus' : '',row.index===selected ? '#b8efb0' : palette[row.index],row.name+' '+path(row.url));
  $('#lineage').innerHTML = svg;
  $('#legacy-legend').hidden = step !== 'replay';
}

function renderSelection(data) {
  const source = data.input.rows[selected], matching = data.rows.filter(row => row.product_id === source.derived_id);
  const exact = matching.find(row => row.url === source.url), related = matching[0];
  document.querySelectorAll('.source-row').forEach(button => { const active = Number(button.dataset.source) === selected; button.classList.toggle('selected',active); button.setAttribute('aria-pressed',String(active)); });
  $('#output-rows').innerHTML = data.rows.map((row,index) => {
    const active = row.product_id === source.derived_id, sameURL = row.url === source.url;
    const legacy = row.identity_version === 'legacy-name/v0';
    return `<article class="output-row ${active ? sameURL ? 'selected' : 'related' : ''} ${legacy ? 'legacy' : ''}"><div><h3>${escape(row.product_name)}</h3><span class="output-url">${escape(path(row.url))}</span></div><span class="price">${money(row.amount)}</span><div class="output-badges"><span class="key-badge ${legacy ? 'legacy' : ''}">${index + 1} · ${legacy ? 'NAME' : basis(row)} · ${safeId(row.product_id)}</span><span class="output-time">#${escape(row.archive_generation)} · ${row.observed_at.slice(11,16)} UTC</span></div></article>`;
  }).join('');
  let detail;
  if (blocked(data)) detail = current === 'denied' ? 'This listing never reached an archive object or a warehouse job.' : 'This listing is retained in the raw file, but the schema prevents publication.';
  else if (exact) detail = (data.options.identity === 'name' ? 'Name identity' : basis(exact).toLowerCase() + ' identity') + ' · ' + money(source.price) + ' source → ' + money(exact.amount) + ' warehouse · generation #' + exact.archive_generation + '.';
  else if (related) detail = 'Its key collided with ' + path(related.url) + '. The selected source URL disappeared from the warehouse.';
  else detail = 'There is no corresponding warehouse observation.';
  $('#selection-detail').innerHTML = '<div class="selection-heading"><strong>' + escape(source.name) + '</strong><span class="detail-key">' + (blocked(data) ? 'Not merged' : 'Key ' + safeId(source.derived_id)) + '</span></div><p>' + escape(detail) + '</p>';
  renderGraph(data);
}

function render(data) {
  value = data;
  controls(data.options);
  $('#scenario-title').textContent = data.scenario.name;
  $('#scenario-tag').textContent = data.scenario.tag;
  $('#scenario-description').textContent = data.scenario.description;
  renderInputs(data);
  renderSelection(data);
  const explanation = outcome(data);
  $('#explanation h3').textContent = explanation.title;
  $('#explanation p').textContent = explanation.text;
  $('#explanation').classList.toggle('warning',explanation.warning);
  $('#result-status').textContent = explanation.status;
  $('#result-status').classList.toggle('warning',explanation.warning);
  $('#output-count').textContent = data.rows.length + ' rows';
  $('#output-caption').textContent = step === 'replay' ? 'Earlier IDs and new IDs coexist in this partition.' : data.options.latest ? 'One latest observation per listing/day.' : 'Last arrival wins · deliberately unsafe.';
  $('#empty').hidden = data.rows.length > 0;
  $('#empty p').textContent = current === 'denied' ? 'No upload means no event. Nothing reached this table.' : 'The file was rejected. Existing warehouse data would remain untouched.';
  $('#output-summary').innerHTML = '<strong>' + data.rows.length + ' warehouse rows</strong><br>' + (step === 'replay' ? '6 earlier keys + 8 stable keys' : blocked(data) ? '0 listings published' : data.rows.length === data.input.rows.length ? 'All 8 source listings preserved' : '2 source listings lost to collisions');
  for (const [id,count] of [['files',data.metrics.archivedFiles],['reads',data.metrics.archiveReads],['jobs',data.metrics.mergeJobs],['skips',data.metrics.skipped]]) $('#metric-'+id).textContent = count;
  $('#identity-actions').hidden = current !== 'identity' || (step === 'start' && data.options.identity !== 'name');
  $('#replay').hidden = step !== 'start';
  $('#repair').hidden = step !== 'replay';
  $('#repair-note').textContent = step === 'repair' ? data.metrics.backupRows + ' rows snapshotted locally · 8 preserved' : 'Replay uses a pre-existing name-based partition.';
  $('#identity').disabled = current === 'identity' && step !== 'start';
  $('#deliveries').disabled = current === 'identity' && step !== 'start';
  $('#journal-count').textContent = data.events.length + ' recorded events';
  $('#journal').innerHTML = data.events.map((event,index)=>`<li class="${/reject|fail|denied|unsafe|collapse/i.test(event.message)?'fail':''}"><span class="journal-index">${String(index+1).padStart(2,'0')}</span><div><b>${escape(event.stage.toUpperCase())}</b>${escape(event.message)}</div></li>`).join('');
}

async function run(nextStep = 'start') {
  clearTimeout(timer);
  const token = ++sequence;
  controller?.abort(); controller = new AbortController();
  step = nextStep;
  if (current === 'identity' && step !== 'start') { $('#identity').value='stable'; $('#deliveries').value='1'; }
  $('#experiment').setAttribute('aria-busy','true');
  $('#run-state').textContent = 'Updating…';
  try {
    const response = await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:current,step,options:options()}),signal:controller.signal});
    if (!response.ok) throw new Error('This experiment could not run.');
    const data = await response.json();
    if (token !== sequence) return;
    render(data);
    $('#run-state').textContent = 'Ready · fresh run';
  } catch(error) {
    if (token===sequence && error.name!=='AbortError') $('#run-state').textContent=error.message;
  } finally { if(token===sequence) $('#experiment').setAttribute('aria-busy','false'); }
}
function selectSource(event) {
  const target = event.target.closest('[data-source]');
  if (!target || !value) return;
  selected=Number(target.dataset.source);
  renderSelection(value);
}
function schedule() {
  updateKnobs(); clearTimeout(timer);
  // A response already in flight must not replace a newer slider value.
  ++sequence; controller?.abort();
  $('#experiment').setAttribute('aria-busy','true');
  $('#run-state').textContent='Updating…';
  timer=setTimeout(()=>run('start'),100);
}
$('#input-rows').addEventListener('click',selectSource);
$('#lineage').addEventListener('click',selectSource);
$('#lineage').addEventListener('keydown',event=>{ if(['Enter',' '].includes(event.key)) { event.preventDefault(); selectSource(event); $('#input-rows [data-source="'+selected+'"]').focus({preventScroll:true}); } });
for (const id of ['identity','receipts','latest']) $('#'+id).addEventListener('change',()=>{ updateKnobs(); run('start'); });
for (const id of ['milk-price','deliveries']) $('#'+id).addEventListener('input',schedule);
$('#preset').addEventListener('change',()=>{ current=$('#preset').value; step='start'; selected=0; controls(scenarios.find(s=>s.id===current).defaults); run(); });
$('#reset').addEventListener('click',()=>{ step='start'; controls(scenarios.find(s=>s.id===current).defaults); run(); });
$('#replay').addEventListener('click',()=>run('replay'));
$('#repair').addEventListener('click',()=>run('repair'));
let graphWidth=0;
new ResizeObserver(entries=>{
  const width=Math.round(entries[0].contentRect.width);
  if(value && graphWidth!==width) { graphWidth=width; renderGraph(value); }
}).observe($('.graph-wrap'));
try {
  const response = await fetch('/api/scenarios');
  if(!response.ok) throw new Error('Could not load experiments.');
  scenarios=await response.json();
  $('#preset').innerHTML=scenarios.map(s=>'<option value="'+escape(s.id)+'">'+escape(s.name)+'</option>').join('');
  controls(scenarios[0].defaults);
  await run();
} catch(error) { $('#run-state').textContent=error.message; }

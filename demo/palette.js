const palettes=[['amber','Graphite · amber'],['cyan','Slate · cyan'],['lilac','Ink · lilac']];
const key='bakiano.lab.palette.v1';
let selected='amber';
try { const saved=localStorage.getItem(key); if(palettes.some(([id])=>id===saved))selected=saved; } catch { /* Storage may be unavailable; the default remains usable. */ }
document.documentElement.dataset.labPalette=selected;
const target=document.querySelector('.app-header nav,.top-right,.wrap>nav .row');
if(target && !document.querySelector('[data-lab-palette-control]')) {
  const label=document.createElement('label'); label.className='lab-palette'; label.dataset.labPaletteControl='';
  const caption=document.createElement('span'); caption.textContent='Colors';
  const select=document.createElement('select'); select.setAttribute('aria-label','Color palette');
  for(const [id,name] of palettes) { const option=document.createElement('option'); option.value=id; option.textContent=name; select.append(option); }
  select.value=selected; label.append(caption,select); target.append(label);
  select.addEventListener('change',()=>{
    if(!palettes.some(([id])=>id===select.value))return;
    document.documentElement.dataset.labPalette=select.value;
    try { localStorage.setItem(key,select.value); } catch { /* The current view still changes when storage is blocked. */ }
  });
}

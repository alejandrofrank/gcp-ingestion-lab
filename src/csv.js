export class InvalidInput extends Error {
  constructor(code, message) { super(message); this.name = 'InvalidInput'; this.code = code; }
}

// Bounded RFC-4180-style parser. No eval, schema inference, or guessed number locale.
export function parseCSV(text, { maxBytes = 1_048_576, maxRows = 10_000, maxField = 8192 } = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new InvalidInput('file_size', 'CSV exceeds the file limit.');
  text = text.replace(/^\uFEFF/, '');
  const records = []; let row = [], field = '', quoted = false, closed = false;
  const pushField = () => { row.push(field); field = ''; closed = false; };
  const pushRow = () => {
    pushField();
    if (row.some(cell => cell !== '')) records.push(row);
    row = [];
    if (records.length > maxRows + 1) throw new InvalidInput('row_limit', 'CSV exceeds the row limit.');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',') pushField();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else if (c === '"' && field === '' && !closed) quoted = true;
    else {
      if (closed || c === '"') throw new InvalidInput('csv_syntax', 'Unexpected character after a quoted field.');
      field += c;
    }
    if (field.length > maxField || row.length > 16) throw new InvalidInput('field_limit', 'CSV field or column limit exceeded.');
  }
  if (quoted) throw new InvalidInput('csv_syntax', 'Unclosed quoted field.');
  if (row.length || field.length || closed) pushRow();
  if (records.length < 2) throw new InvalidInput('empty_file', 'A header without records is not a successful load.');
  const headers = records.shift();
  const allowed = new Set(['name', 'price', 'code', 'url', 'timestamp', 'currency']);
  if (new Set(headers).size !== headers.length || headers.some(h => !allowed.has(h))) throw new InvalidInput('schema', 'Unexpected or duplicate column. The CSV cannot define warehouse identity.');
  for (const required of ['name', 'price', 'timestamp', 'currency']) if (!headers.includes(required)) throw new InvalidInput('schema', `Missing required column: ${required}.`);
  return records.map((cells, i) => {
    if (cells.length !== headers.length) throw new InvalidInput('csv_width', `Row ${i + 2} has the wrong number of columns.`);
    return Object.fromEntries(headers.map((h, j) => [h, cells[j]]));
  });
}

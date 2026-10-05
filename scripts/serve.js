import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { SCENARIOS, runScenario } from '../examples/scenarios.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT ?? 4313), hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const respond = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (!hosts.has(req.headers.host)) return respond(res, 403, { error: 'Local host required' });
  try {
    const path = new URL(req.url, 'http://' + req.headers.host).pathname;
    if (path === '/api/scenarios' && req.method === 'GET') return respond(res, 200, SCENARIOS);
    if (path === '/api/run' && req.method === 'POST') {
      if (!hosts.has((req.headers.origin ?? '').replace(/^http:\/\//, '')) || req.headers['content-type'] !== 'application/json') return respond(res, 403, { error: 'Same-origin JSON required' });
      let body = '';
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 4096) { respond(res, 413, { error: 'Request too large' }); req.destroy(); return; } }
      const input = JSON.parse(body);
      if (!['start', 'replay', 'repair'].includes(input.step ?? 'start')) return respond(res, 400, { error: 'Invalid step' });
      return respond(res, 200, await runScenario(input.id, input.step, input.options));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return respond(res, 405, { error: 'Method not allowed' });
    const relative = path === '/' ? 'demo/index.html' : path.slice(1);
    if (!/^(demo\/(index\.html|app\.js|style\.css)|docs\/images\/[a-z-]+\.(svg|png|jpg))$/.test(relative)) return respond(res, 404, { error: 'Not found' });
    const bytes = await readFile(resolve(root, relative));
    res.writeHead(200, { 'Content-Type': types[extname(relative)], 'Cache-Control': 'no-store' }).end(req.method === 'HEAD' ? undefined : bytes);
  } catch { respond(res, 400, { error: 'Could not run this scenario.' }); }
}).listen(port, '127.0.0.1', () => console.log(`Local demo: http://127.0.0.1:${port}`));

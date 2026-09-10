// SPDX-License-Identifier: AGPL-3.0-or-later
// Audit-only probes. All writes and transports belong to disposable fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(process.argv[2] || '.');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmir-audit-'));
const results = [];
const exists = async p => !!(await fs.stat(p).catch(() => null));
async function check(id, fn) {
  try { const observed = await fn(); results.push({ id, status: 'pass', observed }); }
  catch (e) { results.push({ id, status: e.code === 'AUDIT_SKIP' ? 'skip' : 'fail', observed: String(e.message).slice(0, 1800) }); }
}
function skip(message) { throw Object.assign(new Error(message), { code: 'AUDIT_SKIP' }); }
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function freePort() { const s = http.createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; }
function request(port, pathname, { method = 'GET', body, headers = {}, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { Host: `localhost:${port}`, ...(text === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }), ...headers } }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', c => { bytes += c.length; if (bytes > 8 * 1024 * 1024) req.destroy(new Error('Audit response budget exceeded')); else chunks.push(c); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(timeout, () => req.destroy(new Error('Audit request timeout')));
    if (text !== undefined) req.write(text); req.end();
  });
}
const json = response => JSON.parse(response.body);
let child; let upstream; let log = '';
try {
  const port = await freePort();
  const home = path.join(temp, 'home'); const bins = path.join(temp, 'bin');
  await fs.mkdir(home); await fs.mkdir(bins);
  if (process.platform !== 'win32') {
    for (const name of ['open', 'xdg-open']) await fs.writeFile(path.join(bins, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(path.join(bins, 'x-terminal-emulator'), '#!/bin/sh\n[ "$1" = "-e" ] && shift\nexec "$@"\n', { mode: 0o755 });
  }
  child = spawn(process.execPath, ['server.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, USERPROFILE: home, GITMIR_PORT: String(port), PATH: bins + path.delimiter + process.env.PATH } });
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  let childError; child.on('error', e => { childError = e; });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (childError) throw childError;
    if (child.exitCode !== null) break;
    try { if ((await request(port, '/api/ping', { timeout: 300 })).status === 200) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, `Dashboard did not start: ${log.slice(-1600)}`);
  const project = path.join(temp, 'fixture project'); await fs.mkdir(project);
  const query = encodeURIComponent(project);
  await check('http-dashboard-and-client', async () => {
    const page = await request(port, '/'); const script = await request(port, '/app.js');
    assert.equal(page.status, 200); assert.ok(page.body.includes('GITMIR')); assert.equal(script.status, 200);
    new Function(script.body); return 'Dashboard HTML and browser script served; client syntax valid';
  });
  await check('http-project-crud', async () => {
    assert.equal(json(await request(port, '/api/add', { method: 'POST', body: { path: project } })).added, true);
    assert.equal(json(await request(port, '/api/add', { method: 'POST', body: { path: project } })).duplicate, true);
    assert.equal(json(await request(port, '/api/update', { method: 'POST', body: { path: project, name: 'Audit fixture' } })).ok, true);
    assert.ok(json(await request(port, '/api/projects')).projects.some(p => p.name === 'Audit fixture'));
    return 'Add, duplicate detection, rename, list';
  });
  await check('http-task-queue-roundtrip', async () => {
    const response = await request(port, '/api/task', { method: 'POST', body: { path: project, title: 'roundtrip', content: '# Roundtrip\n\n## Verify\n1. Audit canary\n' } });
    assert.equal(response.status, 200); const file = json(response).file;
    const read = await request(port, `/api/task-file?path=${query}&col=todo&file=${encodeURIComponent(file)}`);
    assert.equal(read.status, 200); assert.ok(json(read).content.includes('Audit canary'));
    assert.equal((await request(port, `/api/queue?path=${query}`)).status, 200);
    return 'Task persisted and readable through queue APIs';
  });
  await check('http-model-roundtrip', async () => {
    const dir = path.join(project, '.gitmir', 'model'); await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'index.json'), '{"name":"Audit fixture"}');
    await fs.writeFile(path.join(dir, 'modules.json'), '[{"id":"audit-module","name":"Audit fixture"}]');
    const model = json(await request(port, `/api/model?path=${query}`));
    assert.equal(model.exists, true); assert.equal(model.model.modules[0].id, 'audit-module');
    return 'Model index and dimensions loaded';
  });
  await check('http-skills-all-resolve', async () => {
    const skills = json(await request(port, '/api/skills')).skills; assert.ok(skills.length > 0);
    for (const skill of skills) { const r = await request(port, `/api/skill?name=${encodeURIComponent(skill.name)}`); assert.equal(r.status, 200, skill.name); assert.ok(json(r).text.trim(), skill.name); }
    return { skills: skills.map(s => s.name) };
  });
  await check('http-share-export', async () => {
    const r = await request(port, `/api/share/export?path=${query}&name=Audit`);
    assert.equal(r.status, 200); assert.ok(r.headers['content-disposition']?.includes('attachment')); assert.ok(r.body.includes('audit-module'));
    return 'Self-contained share generated; HTML/font payload intentionally not retained';
  });
  await check('http-reject-cross-origin', async () => {
    const r = await request(port, '/api/projects', { headers: { Origin: 'https://attacker.invalid', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403); return 'Cross-site Origin refused';
  });
  await check('http-reject-preview-origin-api', async () => {
    assert.equal((await request(port, '/api/projects', { headers: { Host: `127.0.0.1:${port}` } })).status, 403);
    return 'Preview hostname denied ordinary API access';
  });
  await check('http-reject-host-suffix', async () => {
    const r = await request(port, '/api/projects', { headers: { Host: `localhost.attacker.invalid:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(r.status, 403, `A non-loopback hostname received HTTP ${r.status}; expected 403`);
  });
  await check('http-invalid-json-is-client-error', async () => {
    const r = await request(port, '/api/task', { method: 'POST', body: 'null' });
    assert.equal(r.status, 400, `JSON null received ${r.status}; expected a validation error, not an internal error`);
  });
  await check('http-add-rejects-regular-file', async () => {
    const file = path.join(temp, 'not-a-directory.txt'); await fs.writeFile(file, 'fixture');
    const r = json(await request(port, '/api/add', { method: 'POST', body: { path: file } }));
    assert.notEqual(r.added, true, 'A regular file was registered as a project directory');
  });
  await check('http-task-identities-do-not-collide', async () => {
    const d = path.join(temp, 'collision-project'); await fs.mkdir(d);
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(json(await request(port, '/api/task', { method: 'POST', body: { path: d, title: 'same title', content: `task ${i}` } })).file);
    assert.equal(new Set(ids).size, 12, `${new Set(ids).size} unique filenames for 12 successful task submissions`);
  });
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><head></head><body>AUDIT_UPSTREAM_CANARY<script>globalThis.AUDIT_PREVIEW_CANARY=1</script></body></html>');
  });
  const upstreamPort = await listen(upstream);
  await check('preview-untrusted-html-not-on-dashboard-origin', async () => {
    const r = await request(port, '/api/preview?url=' + encodeURIComponent(`http://127.0.0.1:${upstreamPort}/`), { headers: { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site' } });
    const sandbox = String(r.headers['content-security-policy'] || '').includes('sandbox');
    const unsafe = r.status === 200 && r.body.includes('AUDIT_PREVIEW_CANARY') && !sandbox;
    assert.equal(unsafe, false, 'Untrusted executable HTML served on localhost dashboard origin without a CSP sandbox');
  });
  await check('preview-ipv6-mapped-loopback-is-blocked', async () => {
    const r = await request(port, `/api/px/http/[::ffff:127.0.0.1]:${upstreamPort}/`, { headers: { 'Sec-Fetch-Dest': 'empty' } });
    assert.equal(r.body.includes('AUDIT_UPSTREAM_CANARY'), false, 'IPv4-mapped IPv6 bypassed the loopback subresource restriction');
  });
  await check('linux-terminal-path-is-literal', async () => {
    if (process.platform !== 'linux') skip('Linux terminal branch only; other OS branches not simulated as proof');
    const marker = path.join(root, 'AUDIT_CANARY');
    const malicious = path.join(temp, 'project-$(touch AUDIT_CANARY)'); await fs.mkdir(malicious);
    const r = await request(port, '/api/open', { method: 'POST', body: { path: malicious } }); assert.equal(r.status, 200);
    await delay(500); const expanded = await exists(marker); await fs.rm(marker, { force: true });
    assert.equal(expanded, false, 'A directory name caused a shell substitution; only an inert fixture marker was created');
  });
  await check('http-project-remove', async () => {
    assert.equal(json(await request(port, '/api/remove', { method: 'POST', body: { path: project } })).ok, true);
    assert.equal(json(await request(port, '/api/projects')).projects.some(p => p.path === project), false);
    return 'Project removed without deleting its directory';
  });
} catch (e) { results.push({ id: 'http-harness', status: 'blocked', observed: String(e.stack || e).slice(0, 1800) }); }
finally {
  if (child && child.exitCode === null) { child.kill(); await Promise.race([new Promise(r => child.once('exit', r)), delay(1500)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  if (upstream) { upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); }
}

const originalSocket = globalThis.WebSocket;
const sockets = [];
class FakeSocket extends EventTarget {
  readyState = 1; sent = [];
  constructor(url) { super(); this.url = url; sockets.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
}
globalThis.WebSocket = FakeSocket;
let relay;
try {
  relay = await import(pathToFileURL(path.join(root, 'relay.ts')).href);
  const connect = (instance, p) => { instance.connect({ key: 'AUDIT_FAKE_KEY', name: 'Auditor', projectPath: p, projectId: 'fixture', url: 'ws://localhost:4600' }); const s = sockets.at(-1); s.receive({ type: 'welcome', sharing: 'local', project: 'fixture' }); return s; };
  await check('relay-status-withholds-key', async () => {
    connect(relay, temp); assert.equal(JSON.stringify(relay.status()).includes('AUDIT_FAKE_KEY'), false); relay.disconnect(); return 'Credential omitted from status';
  });
  await check('relay-local-level-does-not-send-queue', async () => {
    const p = path.join(temp, 'private-project'); await fs.mkdir(path.join(p, 'tasks', 'todo'), { recursive: true });
    await fs.writeFile(path.join(p, 'tasks', 'todo', '001-private.md'), '# Local only\nAUDIT_PRIVATE_QUEUE_CANARY');
    const s = connect(relay, p); const sent = JSON.stringify(s.sent); const label = relay.status().sharingText; relay.disconnect();
    assert.equal(sent.includes('AUDIT_PRIVATE_QUEUE_CANARY'), false, `Queue uploaded while sharing label says '${label}'`);
  });
  await check('relay-rejects-path-traversal-model-name', async () => {
    const p = path.join(temp, 'traversal-project'); await fs.mkdir(p); const s = connect(relay, p);
    s.receive({ type: 'model', from: { name: 'Peer', id: 'one' }, body: { files: { '../../../AUDIT_ESCAPE.json': 'canary' } } }); relay.disconnect();
    assert.equal(await exists(path.join(p, '.gitmir', 'AUDIT_ESCAPE.json')), false); return 'Traversal name rejected';
  });
  await check('relay-model-write-rejects-symlink', async () => {
    const p = path.join(temp, 'symlink-project'); const peer = path.join(p, '.gitmir', 'shared', 'peer');
    const model = path.join(peer, 'model'); await fs.mkdir(model, { recursive: true });
    await fs.writeFile(path.join(peer, 'meta.json'), '{"name":"Peer"}');
    const outside = path.join(temp, 'outside-model-canary.json'); await fs.writeFile(outside, 'ORIGINAL');
    try { await fs.symlink(outside, path.join(model, 'entities.json'), 'file'); } catch (e) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) skip('Runner cannot create file symlinks'); throw e; }
    const s = connect(relay, p); s.receive({ type: 'model', from: { name: 'Peer', id: 'one' }, body: { files: { 'entities.json': 'REPLACED_BY_FIXTURE' } } }); relay.disconnect();
    assert.equal(await fs.readFile(outside, 'utf8'), 'ORIGINAL', 'Incoming model followed a symlink outside the project');
  });
  await check('relay-completed-task-replay-after-fresh-state', async () => {
    const p = path.join(temp, 'replay-project'); await fs.mkdir(p);
    const message = { type: 'task', id: 'audit-unique-replay-id', from: { name: 'Peer' }, body: { title: 'Replay fixture', body: 'inert' } };
    connect(relay, p).receive(message); relay.disconnect();
    const todo = path.join(p, 'tasks', 'todo'); const done = path.join(p, 'tasks', 'done'); await fs.mkdir(done);
    for (const f of await fs.readdir(todo)) await fs.rename(path.join(todo, f), path.join(done, f));
    const fresh = await import(pathToFileURL(path.join(root, 'relay.ts')).href + '?auditFreshState=1');
    try { connect(fresh, p).receive(message); } finally { fresh.disconnect(); }
    assert.equal((await fs.readdir(todo)).length, 0, 'A completed task returned to todo after fresh module state and replay');
  });
} catch (e) { results.push({ id: 'relay-harness', status: 'blocked', observed: String(e.stack || e).slice(0, 1800) }); }
finally { relay?.disconnect(); globalThis.WebSocket = originalSocket; }
await fs.rm(temp, { recursive: true, force: true });
console.log('AUDIT_PROBES_BEGIN');
console.log(JSON.stringify({ platform: process.platform, node: process.version, results }, null, 2));
console.log('AUDIT_PROBES_END');
process.exitCode = results.some(r => r.status === 'fail' || r.status === 'blocked') ? 1 : 0;

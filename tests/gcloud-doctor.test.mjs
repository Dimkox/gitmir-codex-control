import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
const script = fileURLToPath(new URL('../plugin/skills/gcloud-doctor/scripts/doctor.mjs', import.meta.url));

test('doctor implementation exists', () => assert.ok(existsSync(script), 'missing optional gcloud-doctor CLI'));
test('help succeeds without Google Cloud SDK', () => {
  const p = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(p.status, 0);
  assert.match(p.stdout, /--json/);
  assert.match(p.stdout, /--min-version/);
});

const load = () => import('../plugin/skills/gcloud-doctor/scripts/doctor.mjs');

test('arguments reject mutations and malformed values', async () => {
  const { parseArgs } = await load();
  for (const args of [['--fix'], ['--project'], ['--min-version', 'latest'], ['--timeout-ms', '0'], ['--timeout-ms', '1e3']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(['--json', '--min-version', '584.0.0']).minVersion, '584.0.0');
});

test('Windows command construction quotes spaces and parentheses without shell:true', async () => {
  const { commandSpec } = await load();
  const spec = commandSpec('C:\\Program Files (x86)\\Google\\gcloud.cmd', ['version', '--format=json'], 'win32', { SystemRoot: 'C:\\Windows' });
  assert.equal(spec.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(spec.options.windowsVerbatimArguments, true);
  assert.deepEqual(spec.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.match(spec.args[4], /^""C:\\Program Files \(x86\)/);
  assert.equal(spec.options.shell, false);
});

test('Windows shell expansion in executable paths is rejected', async () => {
  const { commandSpec } = await load();
  for (const name of ['C:\\%TEMP%\\gcloud.cmd', 'C:\\a!b\\gcloud.cmd', 'C:\\x"&whoami\\gcloud.cmd']) {
    assert.throws(() => commandSpec(name, ['version'], 'win32', {}));
  }
});

test('Unix command invocation preserves argument boundaries', async () => {
  const { commandSpec } = await load();
  for (const platform of ['linux', 'darwin']) {
    const spec = commandSpec('/a directory/gcloud', ['info', '--format=json(basic.python_location)'], platform, {});
    assert.equal(spec.file, '/a directory/gcloud');
    assert.deepEqual(spec.args, ['info', '--format=json(basic.python_location)']);
    assert.equal(spec.options.shell, false);
  }
});

test('ADC default locations differ by OS and do not follow arbitrary SDK directories', async () => {
  const { adcLocation } = await load();
  assert.equal(adcLocation('win32', { APPDATA: 'C:\\Users\\D\\AppData\\Roaming' }, 'C:\\Users\\D').path, 'C:\\Users\\D\\AppData\\Roaming\\gcloud\\application_default_credentials.json');
  for (const platform of ['linux', 'darwin']) {
    assert.equal(adcLocation(platform, { CLOUDSDK_CONFIG: '/other/sdk' }, '/home/d').path, '/home/d/.config/gcloud/application_default_credentials.json');
  }
  assert.equal(adcLocation('linux', { GOOGLE_APPLICATION_CREDENTIALS: '/tmp/wif.json' }, '/home/d').source, 'environment');
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture(t, response = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitmir doctor (test) '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'sdk bin');
  mkdirSync(home); mkdirSync(bin);
  const fake = path.join(root, 'fixture.cjs');
  writeFileSync(fake, `const a=process.argv.slice(2); const f=JSON.parse(process.env.DOCTOR_FIXTURE); const key=a[0]==='config'?(a[1]==='list'?'config':'configurations'):a[0]; if(f.mode==='hang')setInterval(()=>{},1000); else if(f.mode==='bad'){process.stdout.write('bad JSON secret refresh_token');process.exitCode=1;} else process.stdout.write(JSON.stringify(f[key]));`);
  const executable = path.join(bin, process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud');
  const launcher = process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fake}" %*\r\nexit /b %errorlevel%\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`;
  writeFileSync(executable, launcher, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|home|userprofile|appdata|cloudsdk_.*|google_application_credentials)$/i.test(k)));
  Object.assign(env, { PATH: bin, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') });
  const data = {
    version: { 'Google Cloud SDK': '584.0.0', refresh_token: 'SECRET_TOKEN' },
    info: { installation: { sdk_root: bin }, basic: { python_location: process.execPath, python_version: '3.13.0' } },
    config: { core: { project: 'example-project', account: 'private@example.test' }, compute: { region: 'europe-west1' }, auth: {} },
    configurations: [{ name: 'default', is_active: true }],
    auth: [{ status: 'ACTIVE', account: 'private@example.test', token: 'SECRET_TOKEN' }],
    ...response,
  };
  env.DOCTOR_FIXTURE = JSON.stringify(data);
  return { root, home, bin, executable, env };
}

function cli(f, ...args) {
  return spawnSync(process.execPath, [script, '--json', ...args], { env: f.env, cwd: f.home, encoding: 'utf8', timeout: 15000 });
}

test('real subprocess diagnostic never emits account names, raw tokens or credential file contents', async t => {
  const f = fixture(t);
  const adc = path.join(f.root, 'adc.json');
  writeFileSync(adc, '{"refresh_token":"FILE_SECRET"}');
  f.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
  const result = cli(f);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.cloudAccess, 'not-tested');
  assert.equal(report.checks.find(c => c.id === 'SDK_VERSION').details.version, '584.0.0');
  assert.equal(report.checks.find(c => c.id === 'ADC_LOCAL').status, 'pass');
  assert.doesNotMatch(result.stdout, /SECRET_TOKEN|FILE_SECRET|refresh_token|private@example/);
  assert.match(result.stdout, /not tested|not-tested/i);
});

test('actual SDK version is compared numerically, not lexically or against a pinned target', t => {
  const f = fixture(t, { version: { 'Google Cloud SDK': '1000.0.0' } });
  assert.equal(cli(f, '--min-version', '584.0.0').status, 0);
  assert.equal(cli(f, '--min-version', '1001.0.0').status, 1);
});

test('project mismatch is an error without changing configuration', t => {
  const f = fixture(t);
  const p = cli(f, '--project', 'different-project');
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(p.stdout).checks.find(c => c.id === 'PROJECT').status, 'fail');
});

test('missing local ADC is a warning, not proof that metadata credentials are unavailable', t => {
  const f = fixture(t);
  let p = cli(f);
  assert.equal(p.status, 0);
  assert.equal(JSON.parse(p.stdout).checks.find(c => c.id === 'ADC_LOCAL').status, 'warn');
  p = cli(f, '--require-local-adc');
  assert.equal(p.status, 1);
});

test('explicit broken ADC override fails and does not fall back silently', t => {
  const f = fixture(t);
  f.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(f.root, 'missing.json');
  const p = cli(f);
  assert.equal(p.status, 1);
  const c = JSON.parse(p.stdout).checks.find(c => c.id === 'ADC_LOCAL');
  assert.equal(c.status, 'fail');
  assert.equal(c.details.source, 'environment');
});

test('directory is not accepted as a credential file', t => {
  const f = fixture(t);
  f.env.GOOGLE_APPLICATION_CREDENTIALS = f.home;
  assert.equal(cli(f).status, 1);
});

test('missing SDK yields structured error and does not need Google Cloud installed for help', t => {
  const f = fixture(t);
  f.env.PATH = f.home;
  const p = cli(f);
  assert.equal(p.status, 1);
  assert.equal(JSON.parse(p.stdout).checks.find(c => c.id === 'SDK_PATH').status, 'fail');
});

test('probe failures do not disclose stderr or raw invalid JSON', t => {
  const f = fixture(t, { mode: 'bad' });
  const p = cli(f);
  assert.equal(p.status, 1);
  assert.doesNotMatch(p.stdout + p.stderr, /secret refresh_token/);
  assert.ok(JSON.parse(p.stdout).summary.failures > 0);
});

test('unknown platform produces structured error without starting subprocesses', async () => {
  const { diagnose } = await load();
  const r = diagnose({}, { platform: 'freebsd', env: {}, home: '/tmp' });
  assert.equal(r.exitCode, 1);
  assert.equal(r.checks[0].id, 'PLATFORM');
});

test('strict mode promotes configuration warnings to failing exit status', t => {
  const f = fixture(t);
  assert.equal(cli(f, '--strict').status, 1);
});

test('separate SDKs on PATH are reported, never auto-selected for update', async t => {
  const f = fixture(t);
  const bin2 = path.join(f.root, 'another bin');
  mkdirSync(bin2);
  const target = path.join(bin2, path.basename(f.executable));
  writeFileSync(target, process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  f.env.PATH += path.delimiter + bin2;
  const p = cli(f);
  const c = JSON.parse(p.stdout).checks.find(c => c.id === 'SDK_PATH');
  assert.equal(c.status, 'warn');
  assert.equal(c.details.candidates.length, 2);
});

test('empty PATH entries never cause current-directory executable discovery', async t => {
  const f = fixture(t);
  const { findExecutables } = await load();
  assert.deepEqual(findExecutables({ platform: process.platform, env: { PATH: path.delimiter }, cwd: f.bin }), []);
});

test('symlink aliases to one SDK do not create false ambiguity', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const bin2 = path.join(f.root, 'alias'); mkdirSync(bin2);
  symlinkSync(f.executable, path.join(bin2, 'gcloud'));
  const { findExecutables } = await load();
  assert.equal(findExecutables({ platform: process.platform, env: { PATH: f.bin + path.delimiter + bin2 } }).length, 1);
});

test('per-probe timeout yields failure instead of hanging', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, { mode: 'hang' });
  const p = cli(f, '--timeout-ms', '100');
  assert.equal(p.status, 1);
  assert.match(p.stdout, /timed out/);
});

import { readFileSync, cpSync } from 'node:fs';

test('dashboard registration, skill mirror and npm scripts remain aligned', () => {
  const root = new URL('../', import.meta.url);
  const registry = JSON.parse(readFileSync(new URL('skills.json', root), 'utf8'));
  assert.equal(registry.filter(s => s.name === 'gcloud-doctor').length, 1);
  assert.equal(new Set(registry.map(s => s.name)).size, registry.length);
  const canonical = readFileSync(new URL('plugin/skills/gcloud-doctor/SKILL.md', root), 'utf8');
  assert.equal(readFileSync(new URL('skills/gcloud-doctor.md', root), 'utf8'), canonical);
  assert.match(canonical, /name: gcloud-doctor/);
  assert.match(canonical, /## Verify/);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.scripts['doctor:gcloud'], 'node plugin/skills/gcloud-doctor/scripts/doctor.mjs');
  assert.equal(pkg.scripts.start, 'node server.ts');
  assert.equal(pkg.engines.node, '>=22.18.0');
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
});

test('installed skill is self-contained outside the GitMir repository', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitmir installed skill '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, 'gcloud-doctor');
  cpSync(fileURLToPath(new URL('../plugin/skills/gcloud-doctor', import.meta.url)), installed, { recursive: true });
  const p = spawnSync(process.execPath, [path.join(installed, 'scripts', 'doctor.mjs'), '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.ok(existsSync(path.join(installed, 'references', 'maintenance.md')));
});

test('credential overrides are flagged without exposing their values', t => {
  const f = fixture(t, { config: { core: { project: 'example-project' }, auth: { impersonate_service_account: 'private@example.test', access_token_file: 'SECRET_TOKEN' } } });
  const p = cli(f);
  const report = JSON.parse(p.stdout);
  assert.equal(report.checks.find(c => c.id === 'CLI_AUTH_OVERRIDES').status, 'warn');
  assert.doesNotMatch(p.stdout, /private@example|SECRET_TOKEN/);
});

test('Windows process creation works with a real CMD fixture', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const p = cli(f);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).checks.find(c => c.id === 'SDK_VERSION').status, 'pass');
});

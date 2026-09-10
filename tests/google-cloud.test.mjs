import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const doctorFile = path.join(root, 'plugin/skills/google-cloud/scripts/doctor.mjs');
const runFile = promisify(execFile);
const implementationExists = await fs.access(doctorFile).then(() => true, () => false);

test('Google Cloud doctor is packaged with the installable skill', () => {
  assert.equal(implementationExists, true, 'Missing packaged Google Cloud doctor');
});

if (implementationExists) {
  const { inspectGoogleCloud, readBinding, parseOptions } = await import(pathToFileURL(doctorFile).href);
  const { buildInvocation, runGcloud, COMMANDS } = await import('../plugin/skills/google-cloud/scripts/gcloud.mjs');
  const binding = { projectId: 'demo-project-123', region: 'europe-west1' };
  const outputs = {
    version: { 'Google Cloud SDK': '583.0.0', extra: 'must-not-leak' },
    config: { core: { account: 'operator@example.invalid', project: 'other-project' }, proxy: { password: 'SECRET-PROXY' }, auth: { access_token: 'SECRET-TOKEN' } },
    auth: [{ account: 'operator@example.invalid', status: 'ACTIVE', refresh_token: 'SECRET-REFRESH' }],
    projects: { projectId: binding.projectId, lifecycleState: 'ACTIVE' },
  };
  const fake = (overrides = {}, calls = []) => async args => {
    calls.push(args);
    const value = Object.hasOwn(overrides, args[0]) ? overrides[args[0]] : outputs[args[0]];
    if (value instanceof Error) throw value;
    return value;
  };

  test('local inspection executes exactly three read-only local commands', async () => {
    const calls = [];
    const report = await inspectGoogleCloud({ binding, run: fake({}, calls) });
    assert.equal(report.status, 'local-only');
    assert.equal(report.sdkVersion, '583.0.0');
    assert.equal(report.cloudAccessVerified, false);
    assert.deepEqual(calls, [COMMANDS.version, COMMANDS.config, COMMANDS.auth]);
    assert.equal(report.binding.projectId, binding.projectId);
    assert.ok(report.warnings.includes('CLI_PROJECT_DIFFERS_FROM_BINDING'));
  });

  test('reports whitelist fields rather than exporting credentials or raw CLI data', async () => {
    const report = await inspectGoogleCloud({ binding, run: fake() });
    const text = JSON.stringify(report);
    for (const value of ['SECRET-PROXY', 'SECRET-TOKEN', 'SECRET-REFRESH', 'must-not-leak']) assert.ok(!text.includes(value));
    assert.equal(report.adc, 'not-checked');
  });

  test('project access is checked only with explicit opt-in and an explicit binding', async () => {
    const calls = [];
    const report = await inspectGoogleCloud({ binding, verifyProject: true, run: fake({}, calls) });
    assert.equal(report.status, 'verified-project-read');
    assert.equal(report.cloudAccessVerified, true);
    assert.deepEqual(calls.at(-1), ['projects', 'describe', binding.projectId, `--project=${binding.projectId}`, '--format=json(projectId,lifecycleState)', '--quiet']);
  });

  test('remote verification refuses ambient project fallback before running anything', async () => {
    const calls = [];
    await assert.rejects(inspectGoogleCloud({ verifyProject: true, run: fake({}, calls) }), /binding/i);
    assert.equal(calls.length, 0);
  });

  test('missing gcloud is a blocked result, not a green readiness assertion', async () => {
    const report = await inspectGoogleCloud({ binding, run: fake({ version: Object.assign(new Error('secret'), { code: 'ENOENT' }) }) });
    assert.equal(report.status, 'blocked');
    assert.equal(report.errors[0].code, 'GCLOUD_NOT_FOUND');
    assert.ok(!JSON.stringify(report).includes('secret'));
  });

  test('permission errors do not leak stderr or pretend verification succeeded', async () => {
    const report = await inspectGoogleCloud({ binding, verifyProject: true, run: fake({ projects: new Error('Bearer SECRET') }) });
    assert.equal(report.status, 'blocked');
    assert.equal(report.cloudAccessVerified, false);
    assert.ok(!JSON.stringify(report).includes('SECRET'));
  });

  test('project mismatch and inactive lifecycle cannot pass verification', async () => {
    for (const projects of [{ projectId: 'wrong-project', lifecycleState: 'ACTIVE' }, { projectId: binding.projectId, lifecycleState: 'DELETE_REQUESTED' }]) {
      const report = await inspectGoogleCloud({ binding, verifyProject: true, run: fake({ projects }) });
      assert.equal(report.status, 'blocked');
      assert.equal(report.cloudAccessVerified, false);
    }
  });

  test('invalid version/config/auth schemas fail closed', async () => {
    for (const overrides of [{ version: {} }, { version: { 'Google Cloud SDK': 'Unknown' } }, { config: [] }, { auth: {} }]) {
      const report = await inspectGoogleCloud({ binding, run: fake(overrides) });
      assert.equal(report.status, 'blocked');
      assert.equal(report.cloudAccessVerified, false);
    }
  });

  test('empty local accounts remain unverified and are not proof of ADC failure', async () => {
    const report = await inspectGoogleCloud({ run: fake({ auth: [], config: {} }) });
    assert.equal(report.status, 'local-only');
    assert.equal(report.cloudAccessVerified, false);
    assert.equal(report.adc, 'not-checked');
    assert.ok(report.warnings.includes('NO_LOCAL_CREDENTIALS'));
    assert.ok(report.warnings.includes('NO_PROJECT_BINDING'));
  });

  test('binding reader accepts UTF-8 BOM and returns null for a missing file', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmir-gcloud-binding-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    assert.equal(await readBinding(dir), null);
    await fs.mkdir(path.join(dir, '.gitmir'));
    await fs.writeFile(path.join(dir, '.gitmir/google-cloud.json'), '\uFEFF' + JSON.stringify(binding));
    assert.deepEqual(await readBinding(dir), binding);
  });

  test('invalid binding and credential-like fields are rejected before execution', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmir-gcloud-invalid-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.mkdir(path.join(dir, '.gitmir'));
    for (const value of [{ ...binding, token: 'secret' }, { projectId: 'x; calc.exe' }, { projectId: '--help' }, { projectId: 123 }, [], { ...binding, region: '$(bad)' }]) {
      await fs.writeFile(path.join(dir, '.gitmir/google-cloud.json'), JSON.stringify(value));
      await assert.rejects(readBinding(dir));
    }
  });

  test('CLI only accepts documented flags and does not accept arbitrary gcloud commands', () => {
    assert.deepEqual(parseOptions(['--directory', 'folder with spaces', '--json', '--verify-project']), { directory: 'folder with spaces', json: true, verifyProject: true, help: false });
    for (const args of [['--directory'], ['--delete'], ['--directory', '--json'], ['deploy']]) assert.throws(() => parseOptions(args));
  });

  test('process boundary rejects writes, token export, shell metacharacters and unrelated flags', () => {
    for (const args of [['auth', 'print-access-token'], ['components', 'update'], ['run', 'deploy'], ['projects', 'describe', 'a;calc'], [...COMMANDS.version, '--log-http'], ['version', '&&', 'calc']]) {
      assert.throws(() => buildInvocation(args));
    }
  });

  test('Windows uses noninteractive encoded PowerShell instead of an interpolated cmd line', () => {
    const invocation = buildInvocation(COMMANDS.version, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
    assert.match(invocation.file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.ok(invocation.args.includes('-NoProfile'));
    assert.ok(invocation.args.includes('-NonInteractive'));
    const script = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /gcloud\.cmd/);
    assert.match(script, /exit \$LASTEXITCODE/);
    assert.match(script, /--format=json/);
  });

  test('POSIX passes an argument array without enabling a shell', () => {
    const invocation = buildInvocation(COMMANDS.version, { platform: 'linux' });
    assert.equal(invocation.file, 'gcloud');
    assert.deepEqual(invocation.args, COMMANDS.version);
  });

  test('real subprocess adapter and CLI operate from a directory with spaces', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmir cloud fixture '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const bin = path.join(dir, 'bin');
    await fs.mkdir(bin);
    await fs.mkdir(path.join(dir, '.gitmir'));
    await fs.writeFile(path.join(dir, '.gitmir/google-cloud.json'), JSON.stringify(binding));
    const fixture = path.join(bin, 'fixture.mjs');
    await fs.writeFile(fixture, `const data=${JSON.stringify(outputs)}; if(process.env.GITMIR_FAKE_FAIL){console.error('SECRET-STDERR');process.exit(3);}else if(process.env.GITMIR_FAKE_LARGE){process.stdout.write('x'.repeat(2*1024*1024));}else if(process.env.GITMIR_FAKE_BROKEN){console.log('invalid json');}else{console.log(JSON.stringify(data[process.argv[2]]));}`);
    if (process.platform === 'win32') {
      await fs.writeFile(path.join(bin, 'gcloud.cmd'), `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
    } else {
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      await fs.writeFile(path.join(bin, 'gcloud'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o755 });
    }
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
    const version = await runGcloud(COMMANDS.version, { env });
    assert.equal(version['Google Cloud SDK'], '583.0.0');
    const result = await runFile(process.execPath, [doctorFile, '--directory', dir, '--json', '--verify-project'], { env });
    assert.equal(JSON.parse(result.stdout).status, 'verified-project-read');
    await assert.rejects(runGcloud(COMMANDS.version, { env: { ...env, GITMIR_FAKE_BROKEN: '1' } }), { code: 'INVALID_JSON' });
    await assert.rejects(runGcloud(COMMANDS.version, { env: { ...env, GITMIR_FAKE_LARGE: '1' } }), { code: 'GCLOUD_OUTPUT_LIMIT' });
    const local = await runFile(process.execPath, [doctorFile, '--directory', dir, '--json'], { env });
    assert.equal(JSON.parse(local.stdout).cloudAccessVerified, false);
    await assert.rejects(runFile(process.execPath, [doctorFile, '--directory', dir, '--json'], { env: { ...env, GITMIR_FAKE_FAIL: '1' } }), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).status, 'blocked');
      assert.ok(!error.stdout.includes('SECRET-STDERR'));
      return true;
    });
    await assert.rejects(runFile(process.execPath, [doctorFile, '--directory', dir, '--json', '--invalid'], { env }), error => {
      assert.equal(error.code, 2);
      assert.equal(JSON.parse(error.stdout).error, 'INVALID_INPUT');
      return true;
    });
  });

  test('installed skill symlinks and Windows junctions still execute the CLI entrypoint', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmir-skill-link-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const link = path.join(dir, 'google-cloud');
    await fs.symlink(path.join(root, 'plugin/skills/google-cloud'), link, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await runFile(process.execPath, [path.join(link, 'scripts/doctor.mjs'), '--help']);
    assert.match(result.stdout, /GitMir Google Cloud doctor/);
  });

  test('a mistyped target directory is not treated as an unbound valid project', async () => {
    await assert.rejects(readBinding(path.join(os.tmpdir(), 'gitmir-nonexistent-' + Date.now())), /directory/i);
  });

  test('packaging registers the same skill in the dashboard and the Codex plugin', async () => {
    const registry = JSON.parse(await fs.readFile(path.join(root, 'skills.json'), 'utf8'));
    const item = registry.find(skill => skill.name === 'google-cloud');
    assert.ok(item);
    assert.equal(item.file, 'skills/google-cloud.md');
    const canonical = await fs.readFile(path.join(root, 'plugin/skills/google-cloud/SKILL.md'), 'utf8');
    const mirror = await fs.readFile(path.join(root, item.file), 'utf8');
    assert.equal(canonical, mirror);
    assert.match(canonical, /name: google-cloud/);
    assert.match(canonical, /not.*deploy|never.*deploy/i);
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['gcloud:doctor'], 'node plugin/skills/google-cloud/scripts/doctor.mjs');
  });
}

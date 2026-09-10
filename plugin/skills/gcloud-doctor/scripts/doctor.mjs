#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = /^\d+\.\d+\.\d+$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;
const HELP = `GitMir gcloud-doctor — local configuration evidence, not a cloud access test.
Usage: node doctor.mjs [--json] [--project PROJECT_ID] [--min-version X.Y.Z]
                      [--gcloud ABSOLUTE_PATH] [--require-local-adc] [--strict]
                      [--timeout-ms 10000] [--help]
Exit: 0 = no failures; 1 = diagnostic failures (or warnings with --strict);
      2 = invalid arguments/internal error. Warnings do not certify cloud access.
No login, update, registry edits, credential reads or cloud resource changes.
Repairs require explicit approval; read references/maintenance.md in this skill.
`;

export function parseArgs(argv) {
  const result = { json: false, strict: false, requireLocalAdc: false, timeoutMs: 10000 };
  const boolean = { '--json': 'json', '--strict': 'strict', '--require-local-adc': 'requireLocalAdc', '--help': 'help', '-h': 'help' };
  const values = { '--project': 'project', '--min-version': 'minVersion', '--gcloud': 'gcloud', '--timeout-ms': 'timeoutMs' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(boolean, arg)) result[boolean[arg]] = true;
    else if (Object.hasOwn(values, arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('An option is missing its value.');
      result[values[arg]] = value;
    } else throw new Error('Unsupported option. Use --help; mutation flags are not supported.');
  }
  if (result.project && !IDENTIFIER.test(result.project)) throw new Error('Invalid project identifier.');
  if (result.minVersion && !VERSION.test(result.minVersion)) throw new Error('Version must have the numeric form X.Y.Z.');
  if (!/^\d+$/.test(String(result.timeoutMs)) || +result.timeoutMs < 50 || +result.timeoutMs > 120000) throw new Error('Timeout must be an integer from 50 to 120000 milliseconds.');
  result.timeoutMs = +result.timeoutMs;
  return result;
}

function envValue(env, name, platform) {
  const key = platform === 'win32' ? Object.keys(env).find(k => k.toUpperCase() === name.toUpperCase()) : name;
  return key ? env[key] : undefined;
}

function readableFile(filename) {
  try { fs.accessSync(filename, fs.constants.R_OK); return fs.statSync(filename).isFile(); }
  catch { return false; }
}

export function findExecutables({ platform = process.platform, env = process.env, explicit } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (explicit) {
    if (!p.isAbsolute(explicit)) throw new Error('--gcloud requires an absolute path.');
    if (!readableFile(explicit)) return [];
    return [explicit];
  }
  const directories = (envValue(env, 'PATH', platform) || '').split(p.delimiter);
  const names = platform === 'win32' ? ['gcloud.cmd', 'gcloud.exe', 'gcloud.bat'] : ['gcloud'];
  const found = [], seen = new Set();
  for (let directory of directories) {
    directory = directory.replace(/^"|"$/g, '');
    // Empty/relative PATH elements would execute untrusted project-local wrappers.
    if (!p.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = p.join(directory, name);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
        const real = fs.realpathSync(candidate);
        const key = platform === 'win32' ? real.toLowerCase() : real;
        if (!seen.has(key)) { seen.add(key); found.push(candidate); }
      } catch { /* Missing or inaccessible PATH entries are not executable candidates. */ }
    }
  }
  return found;
}

export function commandSpec(executable, args, platform = process.platform, env = process.env) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    // CMD expands %variables% even inside quotes. Reject expansion/metacharacters.
    if (/["%!\r\n&|<>^]/.test(executable) || args.some(a => /["%!\r\n&|<>^]/.test(a))) throw new Error('Unsafe Windows command path or arguments.');
    const root = envValue(env, 'SystemRoot', platform) || 'C:\\Windows';
    const command = '"' + [executable, ...args].map(a => '"' + a + '"').join(' ') + '"';
    return { file: path.win32.join(root, 'System32', 'cmd.exe'), args: ['/d', '/s', '/v:off', '/c', command], options: { shell: false, windowsVerbatimArguments: true } };
  }
  return { file: executable, args, options: { shell: false } };
}

export function adcLocation(platform, env, home) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const override = envValue(env, 'GOOGLE_APPLICATION_CREDENTIALS', platform);
  if (override) return { path: override, source: 'environment' };
  const base = platform === 'win32' ? envValue(env, 'APPDATA', platform) || p.join(home, 'AppData', 'Roaming') : p.join(home, '.config');
  return { path: p.join(base, 'gcloud', 'application_default_credentials.json'), source: 'well-known-file' };
}

function childEnvironment(env, platform) {
  const overrides = { CLOUDSDK_CORE_DISABLE_PROMPTS: '1', CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: '1', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: '1', CLOUDSDK_CORE_LOG_HTTP: '0' };
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    const canonical = platform === 'win32' ? key.toUpperCase() : key;
    if (!Object.hasOwn(overrides, canonical)) result[canonical] = value;
  }
  return { ...result, ...overrides };
}

function probe(executable, args, context, timeoutMs) {
  let spec;
  try { spec = commandSpec(executable, [...args, '--quiet', '--verbosity=error'], context.platform, context.env); }
  catch { return { ok: false, reason: 'Command path cannot be invoked safely on this platform.' }; }
  let result;
  try {
    result = spawnSync(spec.file, spec.args, { ...spec.options, env: childEnvironment(context.env, context.platform), cwd: context.cwd, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true });
  } catch { return { ok: false, reason: 'Could not start the SDK process.' }; }
  if (result.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'SDK probe timed out.' };
  if (result.error || result.status !== 0) return { ok: false, reason: 'SDK probe failed; raw output withheld to avoid exposing credentials.' };
  try { return { ok: true, value: JSON.parse(result.stdout.replace(/^\uFEFF/, '')) }; }
  catch { return { ok: false, reason: 'SDK returned invalid JSON; raw output withheld.' }; }
}

function numericCompare(a, b) {
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}

function safeText(value) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 1024) : null;
}

export function diagnose(options = {}, overrides = {}) {
  const context = { platform: process.platform, env: process.env, home: os.homedir(), cwd: process.cwd(), ...overrides };
  const { platform, env, home } = context;
  const checks = [];
  const add = (id, status, summary, details = {}) => checks.push({ id, status, summary, details });
  const report = { schemaVersion: 1, tool: 'gcloud-doctor', generatedAt: new Date().toISOString(), platform, architecture: process.arch, nodeVersion: process.versions.node, scope: 'local-configuration', cloudAccess: 'not-tested', checks };
  const finish = () => {
    report.summary = { failures: checks.filter(c => c.status === 'fail').length, warnings: checks.filter(c => c.status === 'warn').length, passed: checks.filter(c => c.status === 'pass').length };
    report.exitCode = report.summary.failures || (options.strict && report.summary.warnings) ? 1 : 0;
    return report;
  };
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    add('PLATFORM', 'fail', 'Supported platforms are Windows, macOS and Linux.'); return finish();
  }
  add('PLATFORM', 'pass', 'Supported operating system.', { platform, architecture: process.arch });
  const displayPath = value => {
    const text = safeText(value);
    if (!text) return null;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const a = platform === 'win32' ? text.toLowerCase() : text;
    const b = platform === 'win32' ? home.toLowerCase() : home;
    return a === b ? '$HOME' : a.startsWith(b + p.sep) ? '$HOME' + text.slice(home.length) : text;
  };
  const adc = adcLocation(platform, env, home);
  const present = readableFile(adc.path);
  add('ADC_LOCAL', present ? 'pass' : adc.source === 'environment' || options.requireLocalAdc ? 'fail' : 'warn', present ? 'Readable local ADC candidate; contents and authentication not tested.' : 'Local ADC candidate unavailable; metadata/federation access is not tested.', { source: adc.source, path: displayPath(adc.path), contentsRead: false });
  const customConfig = envValue(env, 'CLOUDSDK_CONFIG', platform);
  if (customConfig) add('ADC_CUSTOM_CONFIG', 'warn', 'CLOUDSDK_CONFIG is set. Client-library support for this override varies; verify the application separately.', { path: displayPath(customConfig) });
  add('CLOUD_ACCESS', 'skip', 'API access, IAM permissions, token validity, billing and metadata service are not tested.');
  let candidates;
  try { candidates = findExecutables({ platform, env, explicit: options.gcloud }); }
  catch { add('SDK_PATH', 'fail', 'Provide an existing absolute SDK executable path.'); return finish(); }
  if (!candidates.length) { add('SDK_PATH', 'fail', 'Google Cloud CLI was not found on absolute PATH entries or at the explicit path.'); return finish(); }
  const executable = candidates[0];
  add('SDK_PATH', candidates.length > 1 ? 'warn' : 'pass', candidates.length > 1 ? 'Multiple SDK launchers found. The first PATH match is diagnosed; no installation is modified.' : 'SDK launcher located.', { selected: displayPath(executable), candidates: candidates.map(displayPath) });
  const run = args => probe(executable, args, context, options.timeoutMs || 10000);
  const version = run(['version', '--format=json']);
  const v = version.value?.['Google Cloud SDK'];
  if (!version.ok || typeof v !== 'string' || !VERSION.test(v)) {
    add('SDK_VERSION', 'fail', version.reason || 'SDK version is missing or has an unsupported format.'); return finish();
  }
  const tooOld = options.minVersion && numericCompare(v, options.minVersion) < 0;
  add('SDK_VERSION', tooOld ? 'fail' : 'pass', tooOld ? 'Installed SDK is below the requested minimum.' : 'Actual SDK version read; latest-release availability is not tested.', { version: v, minimum: options.minVersion || null });
  const info = run(['info', '--format=json(installation.sdk_root,basic.python_location,basic.python_version)']);
  if (info.ok) {
    const runtime = info.value?.basic;
    const python = runtime?.python_location;
    const complete = typeof python === 'string' && readableFile(python) && typeof info.value?.installation?.sdk_root === 'string';
    add('SDK_RUNTIME', complete ? 'pass' : 'warn', complete ? 'SDK reports an available interpreter.' : 'SDK runtime fields are incomplete or the interpreter path is unavailable.', { sdkRoot: displayPath(info.value?.installation?.sdk_root), python: displayPath(python), pythonVersion: safeText(runtime?.python_version), pythonOverrideConfigured: Boolean(envValue(env, 'CLOUDSDK_PYTHON', platform)) });
  } else add('SDK_RUNTIME', 'warn', info.reason);
  const config = run(['config', 'list', '--format=json(core.project,compute.region,compute.zone,auth.impersonate_service_account,auth.credential_file_override,auth.access_token_file)']);
  if (config.ok && config.value && typeof config.value === 'object' && !Array.isArray(config.value)) {
    const project = config.value.core?.project;
    const valid = typeof project === 'string' && IDENTIFIER.test(project);
    const matches = valid && (!options.project || project === options.project);
    add('PROJECT', matches ? 'pass' : options.project ? 'fail' : 'warn', matches ? 'Effective project configuration found; project existence is not tested.' : 'Effective project is absent or differs from the expected project.', { project: valid ? project : null, expected: options.project || null, region: safeText(config.value.compute?.region), zone: safeText(config.value.compute?.zone) });
    const auth = config.value.auth || {};
    const modes = { impersonation: Boolean(auth.impersonate_service_account || envValue(env, 'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT', platform)), credentialOverride: Boolean(auth.credential_file_override || envValue(env, 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', platform)), tokenOverride: Boolean(auth.access_token_file || envValue(env, 'CLOUDSDK_AUTH_ACCESS_TOKEN_FILE', platform) || envValue(env, 'CLOUDSDK_AUTH_ACCESS_TOKEN', platform)) };
    if (Object.values(modes).some(Boolean)) add('CLI_AUTH_OVERRIDES', 'warn', 'CLI authentication overrides are configured; stored account entries do not prove the effective identity.', modes);
  } else add('PROJECT', 'fail', config.reason || 'SDK returned an invalid configuration object.');
  const configurations = run(['config', 'configurations', 'list', '--filter=is_active:true', '--format=json(name,is_active)']);
  const active = Array.isArray(configurations.value) ? configurations.value.filter(c => c?.is_active === true) : [];
  add('CONFIGURATION', configurations.ok && active.length === 1 ? 'pass' : 'warn', configurations.ok && active.length === 1 ? 'Active named configuration found.' : 'A single active named configuration could not be confirmed.', { name: active.length === 1 ? safeText(active[0].name) : null });
  const auth = run(['auth', 'list', '--format=json(status)']);
  if (auth.ok && Array.isArray(auth.value)) {
    const count = auth.value.filter(a => a?.status === 'ACTIVE').length;
    add('CLI_CREDENTIALS', count === 1 ? 'pass' : 'warn', count === 1 ? 'Active stored CLI credential entry found; token validity is not tested.' : 'No single active stored CLI credential entry; overrides or workload identity may apply.', { activeEntries: count, accountNamesIncluded: false });
  } else add('CLI_CREDENTIALS', 'warn', auth.reason || 'SDK returned an invalid credential list.');
  return finish();
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) { process.stdout.write(HELP); return 0; }
    const report = diagnose(options);
    if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else {
      process.stdout.write(`GitMir gcloud-doctor | ${report.platform} ${report.architecture} | local checks only\n`);
      for (const check of report.checks) process.stdout.write(`[${check.status.toUpperCase()}] ${check.id}: ${check.summary}\n  ${JSON.stringify(check.details)}\n`);
      process.stdout.write(`Failures: ${report.summary.failures}; warnings: ${report.summary.warnings}. Cloud access NOT TESTED.\n`);
    }
    return report.exitCode;
  } catch {
    const error = { schemaVersion: 1, tool: 'gcloud-doctor', exitCode: 2, error: 'Invalid arguments or an internal error. Use --help. Raw error details are withheld.' };
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(error) + '\n');
    else process.stderr.write(error.error + '\n');
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();

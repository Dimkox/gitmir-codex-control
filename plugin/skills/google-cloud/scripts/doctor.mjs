// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMANDS, PROJECT_ID, projectCommand, runGcloud } from './gcloud.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length <= 320 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const invalid = () => Object.assign(new Error('Unexpected gcloud response schema.'), { code: 'INVALID_RESPONSE' });

function validateBinding(value) {
  if (!isObject(value) || Object.keys(value).some(key => !['projectId', 'region'].includes(key))
      || typeof value.projectId !== 'string' || !PROJECT_ID.test(value.projectId)
      || (value.region !== undefined && (typeof value.region !== 'string' || !/^[a-z][a-z0-9-]{1,62}$/.test(value.region)))) {
    throw new Error('Invalid .gitmir/google-cloud.json: only a valid projectId and optional region are accepted; no credentials.');
  }
  return value.region === undefined ? { projectId: value.projectId } : { projectId: value.projectId, region: value.region };
}

export async function readBinding(directory) {
  const base = path.resolve(directory);
  const directoryInfo = await fs.stat(base).catch(() => null);
  if (!directoryInfo?.isDirectory()) throw new Error('Target directory does not exist or is not accessible.');
  const filename = path.join(base, '.gitmir', 'google-cloud.json');
  let handle;
  try {
    handle = await fs.open(filename, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Cannot read the project binding. Check file permissions.');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384) throw new Error('Invalid binding file.');
    const content = await handle.readFile('utf8');
    return validateBinding(JSON.parse(content.replace(/^\uFEFF/, '')));
  } catch {
    throw new Error('Invalid .gitmir/google-cloud.json: expected a small JSON object with projectId and optional region only.');
  } finally {
    await handle.close();
  }
}

/** Local metadata and project-read access are different levels of evidence. */
export async function inspectGoogleCloud({ binding = null, verifyProject = false, run = runGcloud } = {}) {
  if (binding !== null) binding = validateBinding(binding);
  if (verifyProject && !binding) throw new Error('--verify-project requires an explicit .gitmir/google-cloud.json binding.');
  const report = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    status: 'local-only',
    sdkVersion: null,
    binding,
    cli: { account: null, projectId: null, impersonatedServiceAccount: null },
    credentialedAccounts: 0,
    configuredAccountListed: false,
    adc: 'not-checked',
    cloudAccessVerified: false,
    projectState: null,
    warnings: [],
    errors: [],
  };
  if (!binding) report.warnings.push('NO_PROJECT_BINDING');
  let step = 'version';
  try {
    const version = await run(COMMANDS.version);
    if (!isObject(version) || typeof version['Google Cloud SDK'] !== 'string' || !/^\d+\.\d+\.\d+$/.test(version['Google Cloud SDK'])) throw invalid();
    report.sdkVersion = version['Google Cloud SDK'];
    step = 'config';
    const config = await run(COMMANDS.config);
    if (!isObject(config) || (config.core !== undefined && !isObject(config.core)) || (config.auth !== undefined && !isObject(config.auth))) throw invalid();
    report.cli = {
      account: text(config.core?.account),
      projectId: text(config.core?.project),
      impersonatedServiceAccount: text(config.auth?.impersonate_service_account),
    };
    if (binding && report.cli.projectId && binding.projectId !== report.cli.projectId) report.warnings.push('CLI_PROJECT_DIFFERS_FROM_BINDING');
    if (report.cli.impersonatedServiceAccount) report.warnings.push('SERVICE_ACCOUNT_IMPERSONATION_CONFIGURED');
    step = 'auth';
    const accounts = await run(COMMANDS.auth);
    if (!Array.isArray(accounts) || accounts.some(account => !isObject(account) || !text(account.account))) throw invalid();
    report.credentialedAccounts = accounts.length;
    report.configuredAccountListed = accounts.some(account => account.account === report.cli.account);
    if (!accounts.length) report.warnings.push('NO_LOCAL_CREDENTIALS');
    else if (!report.configuredAccountListed) report.warnings.push('CONFIGURED_ACCOUNT_NOT_LISTED');
    if (verifyProject) {
      step = 'project';
      const project = await run(projectCommand(binding.projectId));
      if (!isObject(project) || project.projectId !== binding.projectId || project.lifecycleState !== 'ACTIVE') throw invalid();
      report.projectState = 'ACTIVE';
      report.cloudAccessVerified = true;
      report.status = 'verified-project-read';
    }
  } catch (error) {
    const known = ['GCLOUD_NOT_FOUND', 'GCLOUD_TIMEOUT', 'GCLOUD_OUTPUT_LIMIT', 'GCLOUD_COMMAND_FAILED', 'INVALID_JSON', 'INVALID_RESPONSE'];
    const code = error.code === 'ENOENT' ? 'GCLOUD_NOT_FOUND' : known.includes(error.code) ? error.code : 'GCLOUD_COMMAND_FAILED';
    report.errors.push({ step, code });
    report.status = 'blocked';
  }
  return report;
}

export function parseOptions(args) {
  const options = { directory: process.cwd(), json: false, verifyProject: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') options.json = true;
    else if (args[i] === '--verify-project') options.verifyProject = true;
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else if (args[i] === '--directory') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--directory requires a directory path.');
      options.directory = value;
    } else throw new Error('Unknown argument. Use --help for supported options.');
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseOptions(args);
    if (options.help) {
      console.log('GitMir Google Cloud doctor\nUsage: node doctor.mjs [--directory PATH] [--json] [--verify-project]\nDefault: local SDK, config and credential metadata only. No cloud writes.\n--verify-project: explicitly read the bound project through Google Cloud API.\nExit codes: 0 = checks completed (local-only is NOT cloud readiness), 1 = check failed, 2 = invalid input.');
      return 0;
    }
    const binding = await readBinding(options.directory);
    const report = await inspectGoogleCloud({ binding, verifyProject: options.verifyProject });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`GitMir Google Cloud: ${report.status}\nSDK: ${report.sdkVersion || 'unavailable'}\nAccount: ${report.cli.account || 'not configured'}\nBound project: ${report.binding?.projectId || 'not configured'}\nCLI default project: ${report.cli.projectId || 'not configured'}\nProject read verified: ${report.cloudAccessVerified}\nADC, billing and deployment permissions: not checked`);
      for (const warning of report.warnings) console.log(`Warning: ${warning}`);
      for (const error of report.errors) console.log(`Error: ${error.step}: ${error.code}`);
    }
    return report.status === 'blocked' ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid input.';
    if (options?.json || args.includes('--json')) console.log(JSON.stringify({ schemaVersion: 1, status: 'blocked', error: 'INVALID_INPUT', message }));
    else console.error(message);
    return 2;
  }
}

// Installers link the whole skill directory; resolve that link before identifying the entrypoint.
const entrypoint = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await main();
}

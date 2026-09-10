// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
export const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const COMMANDS = Object.freeze({
  version: Object.freeze(['version', '--format=json', '--quiet']),
  config: Object.freeze(['config', 'list', '--format=json(core.account,core.project,auth.impersonate_service_account)', '--quiet']),
  auth: Object.freeze(['auth', 'list', '--format=json(account,status)', '--quiet']),
});

export function projectCommand(projectId) {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error('Invalid project ID.');
  return ['projects', 'describe', projectId, `--project=${projectId}`, '--format=json(projectId,lifecycleState)', '--quiet'];
}

/** Keep the process boundary narrower than a generic gcloud command runner. */
export function buildInvocation(args, { platform = process.platform, env = process.env } = {}) {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error('Command is not allowed.');
  const same = allowed => args.length === allowed.length && args.every((arg, i) => arg === allowed[i]);
  const isLocal = Object.values(COMMANDS).some(same);
  const isProjectRead = args[0] === 'projects' && PROJECT_ID.test(args[2] || '') && same(projectCommand(args[2]));
  if (!isLocal && !isProjectRead) throw new Error('Command is not allowed.');
  if (platform !== 'win32') return { file: 'gcloud', args: [...args] };

  // .cmd launchers need a Windows command interpreter. Encode a fixed PowerShell
  // script with individually quoted, allowlisted arguments; do not interpolate cmd.exe text.
  const quoted = args.map(arg => "'" + arg.replaceAll("'", "''") + "'").join(' ');
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; if (-not (Get-Command gcloud.cmd -CommandType Application -ErrorAction SilentlyContinue)) { exit 127 }; & gcloud.cmd " + quoted + '; exit $LASTEXITCODE';
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return {
    file: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

/** Execute bounded, noninteractive reads. Raw stdout/stderr never enter errors. */
export async function runGcloud(args, { env = process.env, timeout = 15000 } = {}) {
  const invocation = buildInvocation(args, { env });
  let stdout;
  try {
    ({ stdout } = await execute(invocation.file, invocation.args, {
      cwd: os.homedir(),
      env: {
        ...env,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: '1',
        CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: '1',
        CLOUDSDK_CORE_DISABLE_FILE_LOGGING: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const code = error.code === 'ENOENT' || error.code === 127 ? 'GCLOUD_NOT_FOUND'
      : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'GCLOUD_OUTPUT_LIMIT'
      : error.killed ? 'GCLOUD_TIMEOUT'
      : 'GCLOUD_COMMAND_FAILED';
    throw Object.assign(new Error(code), { code });
  }
  try {
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    throw Object.assign(new Error('gcloud returned invalid JSON.'), { code: 'INVALID_JSON' });
  }
}

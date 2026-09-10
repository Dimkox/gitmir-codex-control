#!/usr/bin/env python3
"""Read-only source audit with disposable native runtime/installer fixtures."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

TARGET_SHA = '0c9db4635407cb30faab7a3f1887634db097324e'
FRAMEWORK_SHA = 'be752872f3e5a9d6fe179872d9c8bdaec4338238'


def run_command(command, cwd, env=None, timeout=180):
    try:
        p = subprocess.run([str(x) for x in command], cwd=cwd, env=env, capture_output=True,
                           text=True, encoding='utf-8', errors='replace', timeout=timeout)
        return {'code': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr}
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {'code': None, 'stdout': '', 'stderr': str(exc)}


def tracked_files(root):
    p = run_command(['git', 'ls-files', '-z'], root)
    if p['code'] != 0:
        raise RuntimeError(p['stderr'])
    return sorted(x for x in p['stdout'].split('\0') if x)


def inventory(root, files):
    rows = []
    for name in files:
        p = root / name
        raw = os.readlink(p).encode('utf-8') if p.is_symlink() else p.read_bytes()
        rows.append({'path': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                     'kind': 'symlink' if p.is_symlink() else 'file'})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True)
    parser.add_argument('--framework', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    target, framework, output = (Path(x).resolve() for x in (args.target, args.framework, args.output))
    output.mkdir(parents=True, exist_ok=True)
    if output == target or target in output.parents:
        raise ValueError('Evidence must be outside the audited source tree')
    for root, expected in ((target, TARGET_SHA), (framework, FRAMEWORK_SHA)):
        p = run_command(['git', 'rev-parse', 'HEAD'], root)
        if p['code'] != 0 or p['stdout'].strip() != expected:
            raise ValueError(f'Unexpected source identity at {root}')
    files = tracked_files(target)
    before = inventory(target, files)
    (output / 'inventory.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
    results = []

    def record(name, status, detail):
        results.append({'name': name, 'status': status, 'detail': detail})
        print(f"AUDIT {status.upper()} {name}: {json.dumps(detail, ensure_ascii=True)[:3000]}", flush=True)

    def command(name, argv, cwd=target, env=None, timeout=180):
        started = time.monotonic()
        p = run_command(argv, cwd, env, timeout)
        (output / f'{name}.log').write_text('$ ' + ' '.join(map(str, argv)) + '\n' + p['stdout'] + '\n' + p['stderr'], encoding='utf-8')
        record(name, 'blocked' if p['code'] is None else 'pass' if p['code'] == 0 else 'fail',
               {'exit': p['code'], 'seconds': round(time.monotonic() - started, 2),
                'stdout_tail': p['stdout'][-3000:], 'stderr_tail': p['stderr'][-1800:]})
        return p

    record('source-identity', 'pass', {'target': TARGET_SHA, 'framework': FRAMEWORK_SHA, 'tracked_files': len(files), 'platform': sys.platform, 'python': sys.version.split()[0]})
    node = shutil.which('node')
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    command('node-version', [node or 'node', '--version'])
    command('original-google-cloud-tests', [node or 'node', '--test', 'tests/google-cloud.test.mjs'])

    syntax_failures = []
    syntax_count = 0
    for name in files:
        if Path(name).suffix in {'.js', '.mjs', '.cjs', '.ts'}:
            p = run_command([node or 'node', '--check', name], target, timeout=60)
            syntax_count += 1
            if p['code'] != 0:
                syntax_failures.append({'path': name, 'exit': p['code'], 'error': p['stderr'][-1000:]})
    record('all-js-ts-syntax', 'fail' if syntax_failures else 'pass', {'files_checked': syntax_count, 'failures': syntax_failures})
    bad_json = []
    for name in files:
        if name.endswith('.json') and name != 'tsconfig.json':
            try:
                json.loads((target / name).read_text(encoding='utf-8-sig'))
            except (ValueError, UnicodeError) as exc:
                bad_json.append({'path': name, 'error': str(exc)})
    record('json-structure', 'fail' if bad_json else 'pass', bad_json)

    shell_failures = []
    shell_files = [n for n in files if n.endswith(('.sh', '.command'))]
    bash = shutil.which('bash')
    if bash:
        for name in shell_files:
            p = run_command([bash, '-n', str(target / name)], target)
            if p['code'] != 0:
                shell_failures.append({'path': name, 'error': p['stderr'][-1000:]})
        record('all-shell-syntax', 'fail' if shell_failures else 'pass', {'files_checked': len(shell_files), 'failures': shell_failures})
    else:
        record('all-shell-syntax', 'blocked', 'bash unavailable')

    pwsh = shutil.which('pwsh')
    ps_files = [n for n in files if n.endswith('.ps1')]
    if pwsh:
        ps = "$bad=@(); foreach($f in ($env:AUDIT_PS_FILES | ConvertFrom-Json)) { $t=$null; $e=$null; [System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$t,[ref]$e)|Out-Null; if($e.Count){$bad+=$f; $e|ForEach-Object {$_.Message}} }; if($bad.Count){exit 1}"
        command('all-powershell-syntax', [pwsh, '-NoProfile', '-NonInteractive', '-Command', ps], env={**os.environ, 'AUDIT_PS_FILES': json.dumps([str(target / n) for n in ps_files])})
    else:
        record('all-powershell-syntax', 'blocked', 'pwsh unavailable; maintenance scripts NOT executed')

    if npm:
        installed = command('npm-ci', [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], timeout=180)
        if installed['code'] == 0:
            command('typescript', [npm, 'run', 'typecheck'])
            command('npm-dependency-audit', [npm, 'audit', '--json'], timeout=90)
        else:
            record('typescript', 'blocked', 'Dependency installation failed')
    else:
        record('npm-ci', 'blocked', 'npm unavailable')

    command('adaptive-installer-plan', [sys.executable, framework / 'scripts/install_into.py', '--plan', target])
    p = command('adaptive-verify', [sys.executable, framework / 'scripts/grok_verify.py', '--mode', 'pr', '--no-record', '--json'], timeout=240)
    try:
        report = json.loads(p['stdout'])
        (output / 'adaptive-verify.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        record('adaptive-check-breakdown', report['status'], [dict(name=c['name'], status=c['status'], summary=c['summary'], details=c.get('details', [])) for c in report['checks']])
    except (ValueError, KeyError, TypeError):
        record('adaptive-check-breakdown', 'blocked', 'Verifier did not emit its expected JSON report')

    # Invoke the same auditor's scanners over the entire tracked tree, not just a PR diff.
    scanner = "import json,subprocess,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from adaptive_grok.verification import _secret_scan,_contracts,_sql_safety;root=Path.cwd();files=subprocess.check_output(['git','ls-files','-z']).decode().split('\\0');files=[f for f in files if f];checks=[f(root,files).to_dict() for f in (_secret_scan,_contracts,_sql_safety)];print(json.dumps({'files':len(files),'checks':checks},indent=2));sys.exit(int(any(c['status']=='fail' for c in checks)))"
    p = command('adaptive-full-inventory-scans', [sys.executable, '-c', scanner, str(framework / '.grok-stack')])
    try:
        record('adaptive-full-inventory-detail', 'fail' if p['code'] else 'pass', json.loads(p['stdout']))
    except ValueError:
        pass

    probes = Path(__file__).with_name('runtime-probes.mjs')
    p = command('native-runtime-probes', [node or 'node', probes, target], timeout=120)
    try:
        data = json.loads(p['stdout'].split('AUDIT_PROBES_BEGIN\n', 1)[1].split('\nAUDIT_PROBES_END', 1)[0])
        (output / 'runtime-probes.json').write_text(json.dumps(data, indent=2), encoding='utf-8')
        for check in data['results']:
            record(check['id'], check['status'], check.get('observed'))
    except (ValueError, IndexError, KeyError):
        record('native-runtime-probes-report', 'blocked', 'No complete probe report')

    # Install only copies into private temporary HOME directories, never a runner's real HOME.
    with tempfile.TemporaryDirectory(prefix='gitmir-installer-audit-') as scratch:
        scratch = Path(scratch)
        source = scratch / 'source with spaces'
        source.mkdir()
        shutil.copytree(target / 'plugin', source / 'plugin')
        for name in ('install.sh', 'install.ps1'):
            shutil.copyfile(target / name, source / name)
        skills = sorted(p.name for p in (source / 'plugin/skills').iterdir() if p.is_dir())
        shells = [('bash', bash)] if os.name != 'nt' else [('pwsh', pwsh), ('windows-powershell', shutil.which('powershell.exe'))]
        for label, executable in shells:
            if not executable:
                record(f'install-{label}', 'blocked', 'Native interpreter unavailable')
                continue
            for conflict in (False, True):
                home = scratch / f'{label}-home-{conflict}'
                home.mkdir()
                canary = home / '.agents/skills/google-cloud/KEEP_ME.txt'
                if conflict:
                    canary.parent.mkdir(parents=True)
                    canary.write_text('USER_OWNED_CANARY', encoding='utf-8')
                env = {**os.environ, 'HOME': str(home), 'AUDIT_INSTALL_HOME': str(home), 'AUDIT_INSTALL_FILE': str(source / 'install.ps1')}
                argv = [executable, str(source / 'install.sh')] if label == 'bash' else [executable, '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Set-Variable -Name HOME -Value $env:AUDIT_INSTALL_HOME -Force; & $env:AUDIT_INSTALL_FILE"]
                r = run_command(argv, source, env=env)
                if conflict:
                    preserved = canary.is_file() and canary.read_text(encoding='utf-8') == 'USER_OWNED_CANARY'
                    rejected = r['code'] is not None and r['code'] != 0
                    record(f'install-{label}-conflict', 'pass' if preserved and rejected else 'fail', {'exit': r['code'], 'user_file_preserved': preserved, 'conflict_rejected': rejected, 'direct_skill_present': (canary.parent / 'SKILL.md').is_file()})
                else:
                    missing = [s for s in skills if not (home / '.agents/skills' / s / 'SKILL.md').is_file()]
                    record(f'install-{label}-fresh', 'pass' if r['code'] == 0 and not missing else 'fail', {'exit': r['code'], 'missing_skills': missing, 'stderr': r['stderr'][-1000:]})
                    r2 = run_command(argv, source, env=env)
                    missing2 = [s for s in skills if not (home / '.agents/skills' / s / 'SKILL.md').is_file()]
                    record(f'install-{label}-repeat', 'pass' if r2['code'] == 0 and not missing2 else 'fail', {'exit': r2['code'], 'missing_skills': missing2, 'stderr': r2['stderr'][-1000:]})

    after = inventory(target, files)
    altered = [a['path'] for a, b in zip(before, after) if a != b]
    record('tracked-source-unchanged', 'pass' if not altered else 'fail', altered)
    record('coverage-boundaries', 'skip', 'No real cloud/ADC/billing, hosted relay, interactive GUI folder-picker, browser E2E or deployed Trust CI/independent agent reviews. No SDK/registry maintenance executed. Native fixtures and syntax checks do not prove those capabilities.')
    summary = {'schema_version': 1, 'target_sha': TARGET_SHA, 'framework_sha': FRAMEWORK_SHA,
               'platform': sys.platform, 'results': results,
               'counts': {s: sum(r['status'] == s for r in results) for s in ('pass', 'fail', 'skip', 'blocked')}}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print('AUDIT_COUNTS ' + json.dumps(summary['counts']))
    return int(any(r['status'] in ('fail', 'blocked') for r in results))


if __name__ == '__main__':
    raise SystemExit(main())

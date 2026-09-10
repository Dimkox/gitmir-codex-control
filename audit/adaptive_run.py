"""Read-only-source, disposable-runtime audit of a pinned GitMir checkout.

This invokes Adaptive's quality engine, not its deployed Trust CI authority.
No provider, account login, cloud API, human approval, or merge is performed.
"""
from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from urllib.parse import urlencode


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', type=Path, required=True)
    parser.add_argument('--factory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, factory, out = args.target.resolve(), args.factory.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []

    def record(name: str, status: str, detail: object) -> None:
        if isinstance(detail, bytes):
            detail = {'bytes': len(detail), 'sha256': hashlib.sha256(detail).hexdigest()}
        item = {'name': name, 'status': status, 'detail': detail}
        results.append(item)
        print(json.dumps(item, ensure_ascii=True), flush=True)

    def command(name: str, argv: list[str], cwd: Path = root,
                env: dict | None = None, timeout: int = 180) -> subprocess.CompletedProcess | None:
        try:
            actual = argv[:]
            if os.name == 'nt' and actual[0] == 'npm':
                actual = [os.environ.get('ComSpec', 'cmd.exe'), '/d', '/c', *actual]
            proc = subprocess.run(actual, cwd=cwd, env=env, capture_output=True,
                                  text=True, encoding='utf-8', errors='replace', timeout=timeout)
            (out / (name + '.log')).write_text(proc.stdout + '\n' + proc.stderr, encoding='utf-8')
            record(name, 'pass' if proc.returncode == 0 else 'fail',
                   {'exit_code': proc.returncode, 'tail': (proc.stdout + proc.stderr)[-6500:]})
            return proc
        except Exception as exc:
            record(name, 'blocked', type(exc).__name__ + ': ' + str(exc))
            return None

    def probe(name: str, fn) -> None:
        try:
            value = fn()
            record(name, 'pass', value if value is not None else 'assertions satisfied')
        except AssertionError as exc:
            record(name, 'fail', str(exc))
        except Exception as exc:
            record(name, 'blocked', type(exc).__name__ + ': ' + str(exc))

    def git(*parts: str, cwd: Path = root) -> str:
        return subprocess.check_output(['git', *parts], cwd=cwd, text=True, encoding='utf-8').strip()

    metadata = {'target_sha': git('rev-parse', 'HEAD'),
                'factory_sha': git('rev-parse', 'HEAD', cwd=factory),
                'platform': sys.platform, 'python': sys.version,
                'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                'trust_ci_attestation': False}
    print('AUDIT_IDENTITY ' + json.dumps(metadata), flush=True)
    files = [f for f in git('ls-files', '-z').split('\0') if f]
    before = {f: hashlib.sha256((root / f).read_bytes()).hexdigest() for f in files if (root / f).is_file()}
    (out / 'inventory.json').write_text(json.dumps(before, indent=2), encoding='utf-8')
    record('tracked-inventory', 'pass', {'files': len(files), 'hashed': len(before)})
    command('npm-ci', ['npm', 'ci', '--ignore-scripts'], timeout=240)
    command('typecheck', ['npm', 'run', 'typecheck'])
    command('all-discovered-node-tests', ['node', '--test'], timeout=300)
    command('npm-audit-production', ['npm', 'audit', '--omit=dev', '--json'], timeout=120)
    command('npm-pack-dry-run', ['npm', 'pack', '--dry-run', '--json', '--ignore-scripts'])

    def syntax() -> dict:
        failures = []
        checked = []
        for rel in files:
            if Path(rel).suffix not in {'.js', '.mjs', '.cjs', '.ts'}:
                continue
            p = subprocess.run(['node', '--check', str(root / rel)], capture_output=True, text=True)
            checked.append(rel)
            if p.returncode:
                failures.append({'path': rel, 'error': p.stderr[-1500:]})
        assert not failures, json.dumps(failures)
        return {'files': checked}
    probe('javascript-typescript-syntax', syntax)

    def structured() -> dict:
        checked = []
        for rel in files:
            if rel.endswith('.json'):
                json.loads((root / rel).read_text(encoding='utf-8'))
                checked.append(rel)
        registry = json.loads((root / 'skills.json').read_text(encoding='utf-8'))
        missing = [s['file'] for s in registry if not (root / s['file']).is_file()]
        assert not missing, 'Missing registered skill files: ' + repr(missing)
        names = [s['name'] for s in registry]
        assert len(names) == len(set(names)), 'Duplicate registered skill names'
        return {'json_files': checked, 'registered_skills': len(names)}
    probe('json-and-skill-registry', structured)

    for rel in files:
        if rel.endswith(('.sh', '.command')):
            command('bash-syntax-' + Path(rel).name, ['bash', '-n', str(root / rel)])
    ps_parser = out / 'parse-powershell.ps1'
    ps_parser.write_text("param([string]$Root)\n$bad=0; Get-ChildItem -LiteralPath $Root -Filter *.ps1 -Recurse | Where-Object { $_.FullName -notmatch '[\\\\/]node_modules[\\\\/]' } | ForEach-Object { $t=$null; $e=$null; [System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$t,[ref]$e) | Out-Null; foreach($x in $e){ Write-Output ($_.FullName+': '+$x.Message); $bad++ } }; if($bad){exit 1}\n", encoding='utf-8')
    command('powershell-syntax', ['pwsh', '-NoProfile', '-File', str(ps_parser), str(root)])

    # The factory source remains a separate, unchanged checkout. No route is forged.
    sys.path.insert(0, str(factory / '.grok-stack'))
    try:
        from adaptive_grok.verification import verify, _secret_scan, _contracts, _sql_safety
        old = os.getcwd()
        try:
            os.chdir(root)
            report = verify(root, mode='pr', profiles=['base', 'frontend'], record=False)
            scans = [fn(root, files).to_dict() for fn in (_secret_scan, _contracts, _sql_safety)]
        finally:
            os.chdir(old)
        (out / 'factory-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        (out / 'factory-entire-tree.json').write_text(json.dumps(scans, indent=2), encoding='utf-8')
        for item in report['checks']:
            record('adaptive-' + item['name'], item['status'],
                   {'summary': item['summary'], 'details': item.get('details', []),
                    'stdout': item.get('stdout', '')[-3500:], 'stderr': item.get('stderr', '')[-3500:]})
        for item in scans:
            record('entire-tree-' + item['name'], item['status'],
                   {'summary': item['summary'], 'details': item.get('details', [])})
    except Exception:
        record('adaptive-engine', 'blocked', traceback.format_exc()[-5000:])

    with tempfile.TemporaryDirectory(prefix='gitmir audit ') as tmp:
        work = Path(tmp)
        home = work / 'home'
        home.mkdir()
        env = os.environ.copy()
        env.update(HOME=str(home), USERPROFILE=str(home), CI='true')
        skills = sorted(p.name for p in (root / 'plugin' / 'skills').iterdir() if p.is_dir())
        def install() -> None:
            if os.name == 'nt':
                wrapper = work / 'install-wrapper.ps1'
                wrapper.write_text("param([string]$SandboxHome,[string]$Installer)\n$ErrorActionPreference='Stop'; Set-Variable -Name HOME -Value $SandboxHome -Force; & $Installer\n", encoding='utf-8')
                argv = ['pwsh', '-NoProfile', '-File', str(wrapper), str(home), str(root / 'install.ps1')]
            else:
                argv = ['bash', str(root / 'install.sh')]
            p = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=60)
            assert p.returncode == 0, (p.stdout + p.stderr)[-2000:]
        def install_fresh() -> dict:
            install()
            for name in skills:
                assert (home / '.agents' / 'skills' / name / 'SKILL.md').is_file(), name + ' missing'
            install()
            return {'skills': len(skills), 'repeat_install': True}
        probe('native-installer-fresh-and-repeat', install_fresh)
        # An unrelated pre-existing directory must not be destroyed by installation.
        def install_collision() -> None:
            dest = home / '.agents' / 'skills' / skills[0]
            if dest.is_symlink():
                dest.unlink()
            elif os.name == 'nt':
                os.rmdir(dest)  # Remove junction only; never recurse through its target.
            else:
                raise RuntimeError('Expected an installed symlink, refusing cleanup')
            dest.mkdir()
            sentinel = dest / 'operator-owned.txt'
            sentinel.write_text('operator-owned-data', encoding='utf-8')
            install()
            assert sentinel.is_file() and sentinel.read_text() == 'operator-owned-data', 'Installer deleted pre-existing operator-owned directory contents'
        probe('installer-preserves-existing-directory', install_collision)

        runtime = work / 'runtime'
        shutil.copytree(root, runtime, ignore=shutil.ignore_patterns('.git', 'node_modules'))
        (runtime / 'projects.json').write_text('[]', encoding='utf-8')
        project = work / 'sample project'
        project.mkdir()
        (project / '.codex').mkdir()
        (project / '.codex' / 'tasks.json').write_text('[]', encoding='utf-8')
        # Only automatic desktop-browser launch is suppressed; HTTP handlers are unchanged.
        preload = work / 'headless.mjs'
        preload.write_text("import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; const original=cp.execFile; cp.execFile=function(file,args,...rest){ if(['open','xdg-open','cmd'].includes(file) && args.some(x=>String(x).startsWith('http://localhost:'))){ const cb=rest.at(-1); if(typeof cb==='function') queueMicrotask(()=>cb(null,'','')); return; } return original.call(this,file,args,...rest); }; syncBuiltinESMExports();\n", encoding='utf-8')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        env['GITMIR_PORT'] = str(port)
        env['GITMIR_PREVIEW'] = '0'
        log = (out / 'server.log').open('w', encoding='utf-8')
        server = subprocess.Popen(['node', '--import', str(preload), 'server.ts'], cwd=runtime,
                                  env=env, stdout=log, stderr=subprocess.STDOUT)
        observed_routes = set()
        def request(route: str, method: str = 'GET', payload=None, headers: dict | None = None) -> tuple[int, bytes]:
            observed_routes.add(method + ' ' + route.split('?')[0])
            body = None if payload is None else json.dumps(payload)
            h = {'Host': f'localhost:{port}'}
            if body is not None:
                h['Content-Type'] = 'application/json'
            h.update(headers or {})
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
            try:
                c.request(method, route, body=body, headers=h)
                r = c.getresponse()
                return r.status, r.read()
            finally:
                c.close()
        def expect(route: str, code: int = 200, **kwargs) -> bytes:
            status, body = request(route, **kwargs)
            assert status == code, f'{route}: expected {code}, got {status}; {body[:300]!r}'
            return body
        try:
            for _ in range(100):
                try:
                    request('/api/env')
                    break
                except (OSError, http.client.HTTPException):
                    if server.poll() is not None:
                        raise RuntimeError('Server exited: inspect server.log')
                    time.sleep(.1)
            else:
                raise RuntimeError('Server startup timed out')
            probe('http-dashboard', lambda: expect('/'))
            for asset in ['/app.js', '/vendor/fonts.css']:
                probe('http-asset-' + Path(asset).name, lambda a=asset: expect(a))
            query = '?' + urlencode({'path': str(project)})
            for route in ['/api/env', '/api/projects', '/api/skills', '/api/tasks' + query,
                          '/api/queue' + query, '/api/model' + query, '/api/team/status']:
                probe('http-read-' + route.split('?')[0].replace('/', '-'), lambda r=route: json.loads(expect(r)))
            for skill in json.loads((root / 'skills.json').read_text(encoding='utf-8')):
                probe('http-skill-' + skill['name'], lambda s=skill: bool(json.loads(expect('/api/skill?' + urlencode({'name': s['name']})))['text']))
            probe('http-reject-cross-origin', lambda: expect('/api/projects', 403, headers={'Origin': 'https://example.invalid', 'Sec-Fetch-Site': 'cross-site'}))
            probe('http-reject-host-suffix', lambda: expect('/api/projects', 403, headers={'Host': f'localhost.attacker.invalid:{port}', 'Sec-Fetch-Site': 'same-origin'}))
            probe('http-reject-preview-origin', lambda: expect('/api/projects', 403, headers={'Host': f'127.0.0.1:{port}'}))
            def projects_roundtrip() -> None:
                added = json.loads(expect('/api/add', method='POST', payload={'path': str(project)}))
                assert added.get('added') is True, repr(added)
                dup = json.loads(expect('/api/add', method='POST', payload={'path': str(project)}))
                assert dup.get('duplicate') is True, repr(dup)
                expect('/api/update', method='POST', payload={'path': str(project), 'name': 'Audit fixture', 'description': 'disposable'})
                items = json.loads(expect('/api/projects'))['projects']
                assert any(i['name'] == 'Audit fixture' for i in items), repr(items)
            probe('http-project-add-update-duplicate', projects_roundtrip)
            def tasks_unique() -> None:
                if time.time() % 1 > .25:
                    time.sleep(1.02 - time.time() % 1)
                a = json.loads(expect('/api/task', method='POST', payload={'path': str(project), 'title': 'same title', 'content': '# First'}))
                b = json.loads(expect('/api/task', method='POST', payload={'path': str(project), 'title': 'same title', 'content': '# Second'}))
                assert a['file'] != b['file'], 'Two successful task creations returned the same filename; first task overwritten: ' + a['file']
            probe('http-task-creation-no-overwrite', tasks_unique)
            def null_body() -> None:
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=8)
                try:
                    c.request('POST', '/api/update', 'null', {'Host': f'localhost:{port}', 'Content-Type': 'application/json'})
                    r = c.getresponse()
                    body = r.read()
                    assert 400 <= r.status < 500, f'JSON null returned {r.status}, expected 4xx; {body[:200]!r}'
                finally:
                    c.close()
            probe('http-reject-non-object-json', null_body)
            probe('http-project-remove', lambda: expect('/api/remove', method='POST', payload={'path': str(project)}))
            if sys.platform == 'linux':
                def browser_smoke() -> dict:
                    from playwright.sync_api import sync_playwright
                    errors, bad_responses = [], []
                    with sync_playwright() as p:
                        browser = p.chromium.launch(headless=True)
                        try:
                            page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                            page.on('pageerror', lambda e: errors.append(str(e)))
                            page.on('response', lambda r: bad_responses.append({'url': r.url, 'status': r.status}) if r.status >= 400 else None)
                            page.goto(f'http://localhost:{port}', wait_until='networkidle')
                            page.screenshot(path=str(out / 'dashboard.png'), full_page=True)
                            assert not errors, repr(errors)
                            assert not bad_responses, repr(bad_responses)
                            return {'title': page.title(), 'page_errors': errors, 'http_errors': bad_responses}
                        finally:
                            browser.close()
                probe('chromium-dashboard-smoke', browser_smoke)
            else:
                record('chromium-dashboard-smoke', 'skip', 'Browser smoke is performed on Linux; native API tests run on every OS')
            source = (root / 'server.ts').read_text(encoding='utf-8')
            declared = sorted(set(m + ' ' + p for m, p in re.findall(r"req\.method === '(GET|POST)' && url\.pathname === '([^']+)'", source)))
            record('http-route-coverage', 'info', {'declared_exact_routes': declared, 'exercised_routes': sorted(observed_routes),
                                                 'not_exercised': sorted(set(declared) - observed_routes)})
        except Exception:
            record('http-runtime', 'blocked', traceback.format_exc()[-3500:])
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
            log.close()

    after = {f: hashlib.sha256((root / f).read_bytes()).hexdigest() for f in before if (root / f).is_file()}
    record('baseline-source-unchanged', 'pass' if before == after else 'fail',
           {'changed': [f for f in before if before[f] != after.get(f)]})
    record('scope-boundaries', 'info', ['No real Codex/model turn', 'No real Google Cloud credentials or API calls',
                                      'No native terminal/picker GUI interaction', 'No live relay connection',
                                      'No SDK update or registry mutation', 'No Trust CI attestation or merge'])
    summary = {'metadata': metadata, 'checks': results,
               'counts': {s: sum(r['status'] == s for r in results) for s in ['pass', 'fail', 'blocked', 'skip', 'info']}}
    (out / 'summary.json').write_text(json.dumps(summary, ensure_ascii=True, indent=2), encoding='utf-8')
    print('AUDIT_COUNTS ' + json.dumps(summary['counts']), flush=True)
    return 1 if summary['counts']['fail'] or summary['counts']['blocked'] else 0


if __name__ == '__main__':
    raise SystemExit(main())

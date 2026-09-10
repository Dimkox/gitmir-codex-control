# GitMir whole-project audit — 2026-09-10

## Scope and implementation plan

Target: `Dimkox/gitmir-codex-control@0c9db4635407cb30faab7a3f1887634db097324e`.
Verifier source: `Dimkox/adaptive-grok-build-pro@be752872f3e5a9d6fe179872d9c8bdaec4338238`.

This is a reproducible audit snapshot, not a release, repair, or attestation. The product source stays unchanged. `audit/adaptive_run.py` and `.github/workflows/adaptive-project-audit.yml` are audit tooling only.

The approved scope is the whole GitMir project, not only its Google Cloud addition. The execution plan is: inventory and hash every tracked file; install locked development dependencies without lifecycle scripts; run typechecking, all auto-discovered Node tests, syntax checks, structured-file/skill-registry checks, production dependency audit and package dry-run; execute the pinned Adaptive verification engine and explicitly scan the whole tracked tree; test native skill installation in a disposable home; exercise real dashboard HTTP handlers against temporary projects; reproduce suspected input-validation and data-loss defects; run a Chromium dashboard smoke test on Linux; preserve results and list unexercised routes.

## Trust boundary

Adaptive's `AGENTS.md`, `START_HERE.md` and `PROJECT_STATE.json` distinguish local quality evidence from deployed Trust CI. This audit imports its existing `verification.verify(..., record=False)` engine with base/frontend profiles. It does not fabricate an active route, claim independent review agents, activate a model/provider, generate receipts or human approvals, or satisfy an `adaptive-trust-ci/verified@...` gate.

The Adaptive repository is read-only and receives no GitHub Actions files or dependency changes. GitMir already uses GitHub Actions; this separate GitMir audit uses ephemeral runners with `contents: read` and no persisted checkout credentials. No workflow or result grants merge authority. No merge is requested.

## Execution

Open this branch as a pull request to run the three native jobs. Each job audits the fixed baseline SHA, not the PR's application tree. All checks run even after individual failures; a failed or blocked check produces a nonzero exit, and artifacts are uploaded with `if: always()`.

A machine with both checkouts, Node 22.18.0, Python 3.12, Bash, PowerShell and the development dependencies can run:

```text
python audit/adaptive_run.py --target /path/to/gitmir --factory /path/to/adaptive --output /path/outside/source/audit-results
```

The workflow additionally installs PyYAML 6.0.2 and, on Linux, Playwright 1.55.0 plus Chromium as audit-only tooling. On an offline host absent tooling is recorded as blocked, not passed. Browser smoke is Linux-only; API, native installer and syntax checks run on Windows, macOS and Linux.

## Evidence

Artifacts contain `summary.json`, full tracked-file hash inventory, factory PR-mode report, factory whole-tree scan report, command logs, server log and a Linux browser screenshot. Source hashes are compared before and after the run. Findings from the factory's heuristic secret scan are candidates requiring triage, not proof that a credential is real.

Results are pending until the actual Actions jobs finish. The final reviewed results and known limitations belong in this directory or the PR discussion, not only in chat.

## Deliberately not exercised

Real Codex/model turns, cloud credentials and Google Cloud API calls, actual SDK upgrades or Windows registry writes, interactive terminal/folder-picker GUI behavior, live relay connections and Trust CI/production deployment are not exercised. API route coverage is reported explicitly. A browser page-load smoke test is not a full click-through audit of every UI state.

Security and data-loss regression probes touch only disposable test data. Automatic desktop browser opening is suppressed by a subprocess preload; the server request handlers are unmodified. The Windows installer is invoked with a temporary PowerShell HOME, and the Unix installer with a temporary HOME. No production credentials are read.

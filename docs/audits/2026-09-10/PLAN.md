# Full GitMir audit using Adaptive Grok Build Pro

## Scope and immutable inputs

Audit the entire `Dimkox/gitmir-codex-control` tree at `0c9db4635407cb30faab7a3f1887634db097324e`, not only the Google Cloud addition. Use unmodified `Dimkox/adaptive-grok-build-pro` at `be752872f3e5a9d6fe179872d9c8bdaec4338238` as the external preflight engine. Read its bootstrap, engineering contract, installer and verifier before invocation.

## Execution design

A disposable consumer checkout and an independent auditor checkout are exercised by an audit-only driver. The existing consumer CI is an execution host, not the factory's independent Trust CI or merge authority. No files, workflows, policy, credentials or live services in the factory repository are changed. No new permanent factory adoption, fabricated architecture, route receipts or human approvals are introduced.

The audit branch changes only documentation, audit probes and the existing consumer workflow. Application source remains unchanged. No merge, release, deployment, SDK update, real-cloud authentication or credential-store access is authorized by this audit.

## Checks

1. Verify exact source SHAs and enumerate/hash every tracked target file.
2. Execute the original Google Cloud tests, native syntax checks, dependency install/audit and TypeScript check.
3. Execute the factory installer in read-only `--plan` mode and `grok_verify.py --mode pr --no-record --json` from the consumer root. Preserve skips and failures. Separately pass the full tracked inventory to its secret/contract/SQL scanners because a clean PR diff is not a full-repository scan.
4. Exercise the actual loopback HTTP server against disposable projects: project CRUD, task queue, model, skill catalog, share export, origin and preview boundaries, invalid requests and task collisions.
5. Exercise the actual relay module with an in-process fake transport: metadata privacy, local sharing level, task replay and filesystem confinement. No real relay is contacted.
6. Exercise installers only under a disposable HOME, including a pre-existing skill directory with a canary. Parse all shell and PowerShell files without executing SDK maintenance or shortcut installers.
7. Record Windows/macOS/Linux results independently and publish reproducible findings with actual run links. Missing tool coverage is BLOCKED/SKIP, never PASS.

## Acceptance

The deliverable is an evidence-backed audit, not a claim that the application is repaired. Every claimed dynamic defect must have an inert local reproduction. Every source-only concern must be labeled as such. Source checksums must remain unchanged after verification. Independent route-selected agent reviews and the deployed App-owned attestation are not substituted by these checks.

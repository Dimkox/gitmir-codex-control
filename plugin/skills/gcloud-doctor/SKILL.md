---
name: gcloud-doctor
description: >-
  Use when a Google Cloud project has gcloud, Python, PATH, CLI login, ADC,
  configuration or WinGet version problems, or the user explicitly requests a
  Google Cloud environment check on Windows, macOS or Linux.
---

# Google Cloud environment doctor

Optional local diagnostics for Google Cloud projects. Never make Google Cloud a
GitMir prerequisite. Do not run this skill at dashboard startup or for unrelated
projects. Diagnostic permission is not repair, authentication or deployment permission.

## Run the bundled diagnostic

Locate this skill's installed directory containing `SKILL.md`, `scripts/doctor.mjs`
and `references/maintenance.md`. In a GitMir checkout the directory is
`plugin/skills/gcloud-doctor`. A dashboard flat copy under `skills/` is not the
script's directory. Resolve the absolute script path from the installed skill or
GitMir checkout, not by guessing relative to the user's project.

Run Node.js 22.18 or later against that script, with the user's project as working
directory. The script has no npm dependencies. From the GitMir checkout:

```text
node plugin/skills/gcloud-doctor/scripts/doctor.mjs
node plugin/skills/gcloud-doctor/scripts/doctor.mjs --json
```

Use `--project` only when the expected project is supplied or established from the
project's non-secret configuration. It compares configuration; it does not change
or remotely verify a project. `--min-version` accepts a numeric X.Y.Z minimum,
not "latest". There is no hardcoded Google Cloud release and no pin operation.

Use `--require-local-adc` only for a workflow that specifically requires a local
ADC file, not workloads using an attached service account. `--strict` makes
warnings fail CI. `--gcloud` selects an explicitly identified absolute executable
path when several installations exist. Read `--help` for the full interface.

## Interpret evidence, not wishful success

The JSON schema is versioned (`schemaVersion: 1`). Checks have stable IDs, a
`pass`, `warn`, `fail` or `skip` status, a summary and allowlisted details.
Exit 0 means no failing local checks; warnings may remain. Exit 1 means failures
or strict-mode warnings. Exit 2 means invalid arguments or an internal error.

Always distinguish:

- Actual SDK version versus the available version displayed by a package manager.
- A stored active CLI credential entry versus a successful authentication/API call.
- CLI credentials versus Application Default Credentials used by client libraries.
- A readable ADC candidate versus valid credentials, scopes, IAM or quota.
- The current Node/OS architecture versus native architecture of every SDK component.

`cloudAccess` is always `not-tested`. Missing local ADC does not prove workload
identity or metadata-server credentials are broken. `CLOUDSDK_CONFIG` can alter
CLI credential storage; application libraries do not all resolve overrides the
same way. Verify the actual application separately. Do not request or print tokens,
credential JSON, account email addresses, environment dumps or raw gcloud logs.
Project IDs, configuration names and non-home paths remain operational metadata;
review/redact before publishing a report.

## Repairs and GitMir task integration

Read [maintenance.md](references/maintenance.md) before proposing any change.
Identify the installation owner and the exact installation first. Windows is not
a synonym for WinGet, macOS is not a synonym for Homebrew, and Linux is not a
synonym for APT. Never mix package-manager and SDK self-updates blindly.

The CLI intentionally has no `--fix`, login, deploy, update or registry-write
mode. With explicit user authorization, perform only the selected maintenance
procedure from the runbook, preserve the prior state, and rerun the diagnostic.
Registry repair on Windows is a separate metadata operation, not a cloud update
or version pin. The old 584.0.0 recipe is historical, not a universal updater.

When the user requests queued work, create the next unused `tasks/todo/NNN-*.md`
in the managed project using the existing `task-planner` shape: `Type: fix`,
`## Context`, `## Task`, `## Verify`. Include the failed check ID, sanitized
reproduction, expected result, exact authorized scope and rollback. For cloud or
machine mutations not yet authorized, create a `Type: verify` task that diagnoses
only; state the repair is blocked, rather than queueing an autonomous mutation.
Do not mark a task done until its actual verification has passed. Never auto-push
reports or change GitMir server routes, cloud resources, IAM, billing or auth.

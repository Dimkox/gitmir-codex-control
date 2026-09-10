---
name: google-cloud
description: Use when a GitMir-managed project uses Google Cloud, needs gcloud SDK or account diagnostics, has an ambiguous GCP project target, needs cloud task planning, or has Windows WinGet Unknown metadata for Google Cloud SDK.
---

# Google Cloud for GitMir

Connect a local project's GitMir model and verified task workflow to an explicit Google Cloud project. GitMir remains local; this skill does not deploy the dashboard to Google Cloud.

## Start with evidence

Identify the local project directory from the current task. Read its `AGENTS.md` and existing `.gitmir/model/` context when present. Do not infer a cloud target from a repository name, an account email, or an unrelated project in the CLI configuration.

Use the bundled `scripts/doctor.mjs` relative to this skill's directory. Resolve its absolute path and run Node with `--directory` pointing to the local project and `--json`. Quote paths as arguments in the current shell. The helper travels with the skill through GitMir's directory-link installers and plugin package.

For a dashboard copy of this prompt, locate the installed `~/.agents/skills/google-cloud/scripts/doctor.mjs`, or the same file under `plugin/skills/google-cloud/scripts/` in the user's GitMir checkout. Do not invent a path. If neither exists, report that the helper is missing; do not silently download and execute a remote script.

The normal inspection only invokes `gcloud version`, `gcloud config list` and `gcloud auth list` with bounded JSON output. It does not authenticate, switch CLI configuration, update the SDK, alter the registry, print tokens or create cloud resources.

## Bind the project explicitly

The binding is `.gitmir/google-cloud.json` **inside the managed project**, not necessarily inside the GitMir checkout:

```json
{
  "projectId": "demo-project-123",
  "region": "europe-west1"
}
```

These are example identifiers, not approved deployment targets. Use values already supplied by the operator or authoritative project configuration. The file only accepts `projectId` and optional `region`; never put passwords, service-account keys, refresh tokens, OAuth client secrets or ADC contents in it. Region is descriptive context, not a verified service location.

If the operator requests verification against Google Cloud, use the helper's `--verify-project` flag. It requires the binding and performs only `gcloud projects describe` against the bound project. A different global CLI project is reported, not silently changed. Without a requested cloud read, remain in local inspection mode.

## Interpret results without inflating confidence

- `local-only`: local commands completed. Cloud access, billing, API availability and deployment permissions remain unverified, even with exit code 0.
- `verified-project-read`: the bound project's metadata was read and its lifecycle was ACTIVE. This does not prove Cloud Run, IAM, Artifact Registry, Google Ads API or billing permissions.
- `blocked`: a check failed. Use the reported step and error code; do not invent a successful result or change identities to bypass the failure.

`gcloud` authentication and Application Default Credentials are distinct configurations. The helper deliberately reports ADC as `not-checked`. An empty `gcloud auth list` is not proof that ADC or a workload identity cannot work. Likewise, a listed account is not proof that its credentials remain valid.

Do not persist reports or account identities into a public repository automatically. The report excludes raw credentials, but project IDs and account names can still be sensitive.

## Feed the existing GitMir workflow

For cloud implementation work, pass the operator's goal, explicit project binding and actual diagnostic result to `$task-planner`. Separate local code/configuration changes from remote cloud changes. Every remote task must state the exact project/resource, required API/IAM permissions, cost exposure, rollback and `## Verify` commands before it can be executed.

Use `$task-runner` only within the approved scope. An inspection request never authorizes deployment, IAM changes, service enablement, billing changes, secret creation, resource deletion or SDK maintenance. Do not deploy automatically. Model updates must follow the existing model schema and preserve its stable IDs. Record verified resource references and checks, not credentials or invented readiness percentages.

## Windows SDK maintenance

WinGet's available version is not necessarily the installed version. `Unknown` is not a pin. Read the actual SDK version with `gcloud version --format=json` before editing `DisplayVersion`.

In the GitMir checkout, `docs/windows/gcloud-winget-version-repair/README.md` documents the separate, opt-in 584.0.0 maintenance recipe: copy bundled Python, temporarily set `CLOUDSDK_PYTHON`, update, verify the real version, then change the existing uninstall metadata. Its original machine's successful end-to-end run was not confirmed. Never trigger it from the diagnostic helper, downgrade a newer SDK to match that historical example, or stamp a version that is not installed.

The plugin-only package may not contain the repository's `docs/` tree; report that limitation rather than fabricating or executing a missing maintenance script.

## References

- [gcloud config list](https://docs.cloud.google.com/sdk/gcloud/reference/config/list)
- [gcloud auth list](https://docs.cloud.google.com/sdk/gcloud/reference/auth/list)
- [gcloud projects describe](https://docs.cloud.google.com/sdk/gcloud/reference/projects/describe)
- [gcloud CLI authentication and ADC](https://docs.cloud.google.com/sdk/docs/authenticate)

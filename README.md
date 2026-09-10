# GitMir for Codex

**Your agent says the task is done. This is the tool that checks.**

One repo, two surfaces:

1. **Codex plugin** — installable skills (`$gitmir-model`, `$task-runner`, …) that Codex loads natively  
2. **Control dashboard** — local multi-project HUD (model diagrams, queue, task log) at `http://localhost:4599`

Same workflows as the original GitMir Claude Control, reworked for **OpenAI Codex** (`codex` CLI, `AGENTS.md`, `.codex/`).

---

## Quick start

### A) Codex plugin (skills)

**Windows (PowerShell):**

```powershell
cd path\to\gitmir-codex
.\install.ps1
```

**macOS / Linux:**

```bash
cd path/to/gitmir-codex
./install.sh
```

Restart Codex, then in a project:

```text
$gitmir-model
$task-planner
$task-runner
```

Or register as a marketplace and install from the Plugins UI:

```bash
codex plugin marketplace add .
# then install "GitMir" from Plugins
```

Plugin root: `plugin/` (manifest: `plugin/.codex-plugin/plugin.json`).

### B) Control dashboard

Requires **Node ≥ 22.18** (runs TypeScript directly, zero runtime deps).

```bash
cd path/to/gitmir-codex
node server.ts
```

Opens **http://localhost:4599** → add a project folder → **▶ Run Codex**.

Windows shortcuts: `start.cmd` / `install-shortcut.cmd`.  
macOS: `start.command` / `install-shortcut.command`.

### Windows maintenance recipes

[Google Cloud SDK: update to 584.0.0 and repair WinGet `Unknown`](docs/windows/gcloud-winget-version-repair/README.md) — PowerShell script, one-line command, troubleshooting, registry rollback guidance, and validation criteria. The guide is in Russian and records the Windows end-to-end validation status. This is an optional manual procedure, not a GitMir dependency or startup action.

---

## Skills

| Skill | Role |
|--------|------|
| `$gitmir-model` | Build/refresh `.gitmir/model/` from real code; standing rule in `AGENTS.md` |
| `$model-navigate` | Walk model by id-links; minimal context for a change |
| `$model-ingest` | Large/legacy sources in fragments |
| `$task-planner` | Goal → `tasks/todo/*.md` with `## Verify` from blast radius |
| `$task-runner` | Queue until empty; real checks only; never “looks right” → done |
| `$task-log` | Journal → `.codex/tasks.json` |
| `$app-audit` | End-to-end app walk |
| `$product-docs-spec` | Spec under `docs/` |
| `$context-distillation` | Messy input → `.gitmir/brief.json` |
| `$legacy-maintenance` | Safe changes on coupled systems |
| `$stack-port` | Port old stack → new without losing behaviour |
| `$google-cloud` | SDK/context inspection, explicit GCP project binding, opt-in project-read verification and cloud task planning |

Flat copies under `skills/` are for the dashboard UI (copy-paste). Canonical Codex layout is `plugin/skills/<name>/SKILL.md`.

---

## Google Cloud integration

Google Cloud is an optional integration for projects managed by GitMir, **not a requirement to host GitMir in the cloud**. The existing dashboard skill catalog and the installable Codex plugin both expose `$google-cloud`.

From the GitMir checkout, inspect the local SDK and CLI context:

```bash
npm run gcloud:doctor -- --directory "/path/to/your/project"
```

The helper reads `.gitmir/google-cloud.json` in that project when present. Add `--verify-project` only to explicitly read the bound project's metadata through Google Cloud API. No deployment, billing changes, global project switching, token export or SDK update is performed. Local metadata is **not** proof of working cloud credentials or deployment permissions.

[Full setup, commands, limitations and verification](docs/google-cloud.md) · [Windows SDK / WinGet maintenance recipe](docs/windows/gcloud-winget-version-repair/README.md)

---

## Typical flow

```text
$gitmir-model     # once (and after big refactors)
$task-planner     # e.g. "add refund flow for orders"
$task-runner      # execute + verify until queue empty
```

Optional: open the dashboard to see the product graph and verification log.

---

## Layout

```
gitmir-codex/
├── plugin/                    # Codex plugin package
│   ├── .codex-plugin/plugin.json
│   └── skills/*/SKILL.md
├── .codex-plugin/plugin.json  # alt root manifest (skills → plugin/skills)
├── .agents/plugins/marketplace.json
├── skills/                    # flat .md for dashboard
├── server.ts                  # Control dashboard
├── public/  vendor/  docs/
├── install.ps1  install.sh
└── package.json
```

---

## Requirements

- **Plugin:** OpenAI Codex CLI or ChatGPT/Codex app  
- **Dashboard:** Node.js ≥ 22.18  
- Codex installed and on PATH (`codex`)

---

## License

AGPL-3.0-or-later (upstream GitMir).

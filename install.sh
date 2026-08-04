#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.agents/skills"
mkdir -p "$DEST"
for d in "$ROOT"/plugin/skills/*/; do
  name=$(basename "$d")
  ln -sfn "$d" "$DEST/$name"
  echo "linked $name -> $DEST/$name"
done
echo ""
echo "Done. Restart Codex, then try: \$gitmir-model"

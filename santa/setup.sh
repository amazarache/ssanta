#!/bin/sh
# Creates the player's private files. Safe to run again: it never overwrites the token or the vibe file.
# Run from the repository root: sh santa/setup.sh          (opencode connects to the game server itself)
#                           or: sh santa/setup.sh stdio    (through the local bridge, which honours an HTTP proxy)
#                           or: sh santa/setup.sh claude | codex   (for those clients; then use santa/play.sh)
set -eu
cd "$(dirname "$0")/.."

# Claude Code and Codex are started through santa/play.sh, which passes everything they need on the
# command line. For them, setup creates only the two private files.
case "${1:-}" in
  claude|codex)
    if [ ! -s .santa-token ]; then
      (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > .santa-token)
    fi
    [ -f vibe.md ] || cp vibe.example.md vibe.md
    echo "files-ready ($1). Fill in vibe.md, then start the game with: sh santa/play.sh $1"
    exit 0
    ;;
esac

# opencode 1.x and 2.x read different config and agent formats.
major=$(opencode --version 2>/dev/null | tr -dc '0-9.' | cut -d. -f1)
case "$major" in
  ''|0|1) v=v1 ;;
  *) v=v2 ;;
esac

if [ ! -s .santa-token ]; then
  (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > .santa-token)
fi
[ -f vibe.md ] || cp vibe.example.md vibe.md

# The game agent, in the form this opencode version reads. Written first, so it exists even if a later step fails.
mkdir -p .opencode/agents
{ echo '---'; cat "santa/elf.$v.yml"; echo '---'; cat santa/elf.md; } > .opencode/agents/elf.md

# Mode "stdio": opencode starts santa/bridge.mjs locally and the bridge talks to the game server,
# through the configured HTTP proxy if there is one. Default mode: opencode connects to the server itself.
mode=${1:-remote}
if [ "$mode" = stdio ]; then
  if command -v node >/dev/null 2>&1; then run=node
  elif command -v bun >/dev/null 2>&1; then run=bun
  else echo "setup-failed: stdio mode needs Node 18+ or Bun on this machine"; exit 1
  fi
  if [ "$v" = v1 ]; then
    printf '{\n  "mcp": {\n    "santa": { "type": "local", "command": ["%s", "santa/bridge.mjs"], "enabled": true }\n  }\n}\n' "$run" > opencode.json
  else
    printf '{\n  "mcp": {\n    "servers": {\n      "santa": { "type": "local", "command": ["%s", "santa/bridge.mjs"] }\n    }\n  }\n}\n' "$run" > opencode.json
  fi
else
  mode=remote
  cp "santa/mcp.$v.json" opencode.json
fi
echo "files-ready ($v, $mode)"

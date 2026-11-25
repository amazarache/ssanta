#!/bin/sh
# Creates the player's private files. Safe to run again: it never overwrites the token or the vibe file.
# Run from the repository root: sh santa/setup.sh
set -eu
cd "$(dirname "$0")/.."

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
cp "santa/mcp.$v.json" opencode.json
mkdir -p .opencode/agents
{ echo '---'; cat "santa/elf.$v.yml"; echo '---'; cat santa/elf.md; } > .opencode/agents/elf.md
echo "files-ready ($v)"

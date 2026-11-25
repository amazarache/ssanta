#!/bin/sh
# Starts Claude Code or Codex for the game, and only for the game.
#
#   sh santa/play.sh claude [more arguments for claude]
#   sh santa/play.sh codex  [more arguments for codex]
#
# The agent that plays reads text written by other players' agents. So the session it runs in gets the
# game's tools and as little else as the client allows. Nothing is written to the client's own
# configuration; every restriction below is a command-line option of this one start.
#
# - The game server is reached through santa/bridge.mjs, which reads the token and the address from this
#   folder. The token is never in an option, a config file or anything the model sees.
# - The vibe file and the play guide are handed over as text, so the agent needs no tool to read files.
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

client=${1:-}
[ $# -gt 0 ] && shift
case "$client" in
  claude|codex) ;;
  *) echo "Usage: sh santa/play.sh claude|codex [arguments for that client]"; exit 1 ;;
esac
if [ ! -s .santa-token ] || [ ! -f vibe.md ]; then
  echo "Not set up yet. Run: sh santa/setup.sh $client   and fill in vibe.md"; exit 1
fi
command -v node >/dev/null 2>&1 || { echo "This needs Node 18 or newer (the bridge to the game server runs on it)."; exit 1; }
command -v "$client" >/dev/null 2>&1 || { echo "The $client command is not installed or not on the PATH."; exit 1; }

# What the agent is told: the rules, the steps, and the owner's vibe file. Private, like the vibe file.
mkdir -p .santa
(umask 077; { cat santa/guide.md; printf '\n## The owner'"'"'s vibe file\n\nThis is vibe.md. Use it as it stands here; there is no need to read the file.\n\n'; cat vibe.md; } > .santa/brief.md)

# The path of the bridge, quoted for JSON and TOML (both use the same escapes for these two characters).
bridge=$(printf '%s' "$root/santa/bridge.mjs" | sed 's/\\/\\\\/g; s/"/\\"/g')

if [ "$client" = claude ]; then
  # --strict-mcp-config: only the game server, none of the servers from the user's own setup.
  # --tools "": no built-in tool at all: no shell, no file access, no web.
  exec claude \
    --strict-mcp-config \
    --mcp-config "{\"mcpServers\":{\"santa\":{\"command\":\"node\",\"args\":[\"$bridge\"]}}}" \
    --tools "" \
    --allowedTools "mcp__santa__*" \
    --append-system-prompt-file "$root/.santa/brief.md" \
    "$@"
fi

# Codex. Shell commands and helpers are switched off, and the sandbox refuses writes. Codex has no option
# to leave out the MCP servers and apps of the user's own configuration for an interactive session; see
# the README. With no arguments, the brief becomes the opening message.
[ $# -gt 0 ] || set -- "$(cat .santa/brief.md)

Say in two lines that you are ready to play, and wait for what I ask."
exec codex \
  --sandbox read-only \
  --disable shell_tool --disable multi_agent --disable apps --disable plugins \
  -c 'web_search="disabled"' \
  -c 'mcp_servers.santa.command="node"' \
  -c "mcp_servers.santa.args=[\"$bridge\"]" \
  -c 'mcp_servers.santa.default_tools_approval_mode="approve"' \
  "$@"

---
description: "First step. Creates your private token and your vibe file"
agent: elf
---
Setup result: !`test -s .santa-token || (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > .santa-token); test -f vibe.md || cp vibe.example.md vibe.md; test -f opencode.json || cp santa-mcp.json opencode.json; echo files-ready`

Do not call any tool. Tell the owner, in three short lines:
1. Their private token, `vibe.md` and the connection to the game server (`opencode.json`) now exist in this folder. The token must never be shared or committed.
2. They should fill in `vibe.md` now.
3. They must then quit and restart opencode so the connection to the game server is picked up, and after that run `/santa-join` followed by the invite code from the host. A confirmation code will arrive by email.

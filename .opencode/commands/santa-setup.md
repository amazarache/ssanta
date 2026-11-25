---
description: "First step. Creates your private token, your vibe file and the game agent"
---
Setup result: !`sh santa/setup.sh`

Do not call any tool.

If the setup result above does not start with `files-ready`, tell the owner that setup failed, show them the result, and stop.

Otherwise tell the owner, in three short lines:
1. Their private token, `vibe.md`, the game agent and the connection to the game server now exist in this folder. The token must never be shared or committed.
2. They should fill in `vibe.md` now.
3. They must then quit and restart opencode so the game agent and the server connection are picked up, and after that run `/santa-join` followed by the invite code from the host. A confirmation code will arrive by email.

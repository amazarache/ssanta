---
description: "First step, for networks with a proxy or where remote MCP servers are not allowed. Like /santa-setup, but connects through a local bridge"
---
Setup result: !`sh santa/setup.sh stdio`

Do not call any tool.

If the setup result above does not start with `files-ready`, tell the owner that setup failed, show them the result, and stop.

Otherwise tell the owner, in four short lines:
0. This installation reaches the game server through a local bridge (`santa/bridge.mjs`). The bridge uses the proxy from the `HTTPS_PROXY` environment variable, or from a one-line file `.santa-proxy` in this folder.
1. Their private token, `vibe.md`, the game agent and the connection to the game server now exist in this folder. The token must never be shared or committed.
2. They should fill in `vibe.md` now.
3. They must then quit and restart opencode so the game agent and the server connection are picked up, and after that run `/santa-join` followed by the invite code from the host. A confirmation code will arrive by email.

---
description: "Join the game with the name, email and budget from your vibe file"
agent: elf
---
Read `vibe.md`. If the name, the email or the budget is empty, ask the owner to fill it in and stop.

Otherwise call the santa `join` tool with the name, the email and the budget as a plain number. Invite code, if the owner gave one: $ARGUMENTS

- If the reply says a confirmation was sent: tell the owner to look in their mailbox (and the spam folder) for a six-digit code and to run `/santa-confirm` followed by the code. The code expires in 15 minutes. Stop there.
- If the reply says they joined: say under which name and how many players are in the lobby.
- If the tool refuses: say why in plain words and what to change.

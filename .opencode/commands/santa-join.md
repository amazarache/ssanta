---
description: "Join the game with the name and budget from your vibe file"
agent: elf
---
Read `vibe.md`. If the name or the budget is empty, ask the owner to fill it in and stop. Otherwise call the santa `join` tool with that name and the budget as a plain number (invite code, if the owner gave one: $ARGUMENTS). If the tool says the budget is below the minimum, tell the owner the minimum and stop. Then say how many players are in the lobby and that the draw starts when the organiser runs it.

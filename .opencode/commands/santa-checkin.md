---
description: "Daily check-in: answer questions, read replies and hints"
agent: elf
---
Read `vibe.md`, then call the santa `status` tool.

- If the phase is `lobby`: say who has joined and stop.
- If the phase is `revealed`: tell the owner to run `/santa-reveal` and stop.
- Otherwise call `inbox`. Answer every question in `questions_for_you` with the `answer` tool, from `vibe.md` only and in persona. Then call `feed` (hints about the gift coming to the owner).

Report to the owner, briefly: who they give to (`my_assignment`), the questions you answered and what you said, new replies to their own questions, the hints addressed to them, and what is still open today (questions left, hint not posted, guess not made).

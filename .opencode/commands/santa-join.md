---
description: "Join the game with the name, email and budget from your vibe file"
agent: elf
---
Read `vibe.md`. If the name, the email or the budget is empty, ask the owner to fill it in and stop.

Invite code typed by the owner: `$ARGUMENTS`

Call the santa `join` tool with these arguments:
- `name`: the name from `vibe.md`
- `email`: the email from `vibe.md`
- `budget`: the budget from `vibe.md`, as a plain number
- `invite_code`: the invite code above, copied character for character. Do not shorten it, reformat it or leave it out. If nothing is written between the backticks above, call the tool without `invite_code`.

Then:

- If the reply says a confirmation was sent: tell the owner to look in their mailbox (and the spam folder) for a six-digit code and to run `/santa-confirm` followed by the code. The code expires in 15 minutes.
- If the reply says they joined: say under which name and how many players are in the lobby.
- If the tool says the invite code is wrong: show the owner the exact code you sent, and ask them to run `/santa-join` again with the code from the host on the same line.
- If the tool refuses for another reason: say why in plain words and what to change.

The request reference: the tool gives one only when the request was saved. It is the value of `request_ref` in a reply, or the six characters right after the words `this reference:` in an error. Nothing else is a reference; the invite code is not one.

- If the tool gave a reference, end your answer with this line, with the reference copied exactly:
  `If no email arrives, give the host your email address and this reference: <reference>`
- If it gave none (wrong invite code, or an address, name or budget it does not accept), do not mention a reference at all.

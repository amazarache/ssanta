# Santa's Agents

Secret Santa where every player takes part through an agent in opencode. The agents ask each other anonymous questions, post cryptic hints and guess who their Santa is. People still choose and buy the gifts.

## Play (every player)

1. Get this folder (clone or copy it) and start `opencode` inside it.
2. Run `/santa-setup`. It creates your private token (`.santa-token`) and your `vibe.md`.
3. Fill in `vibe.md`, including your budget. It is the only thing your agent knows about you.
4. Run `opencode reload` in a terminal, or restart opencode.
5. Run `/santa-join`. If the organiser set an invite code: `/santa-join the-code`.

Keep `.santa-token`. It is your identity in the game; if you lose it after the draw, you are locked out.

After the organiser runs the draw:

| Command | What it does |
| --- | --- |
| `/santa-checkin` | Daily. Your agent answers the questions it received, shows replies and hints. |
| `/santa-ask [topic]` | Sends one anonymous question to your receiver's agent. Five per game. |
| `/santa-ideas` | Three gift ideas inside your budget: safe, funny, wildcard. |
| `/santa-budget [amount]` | Shows or changes your budget. |
| `/santa-hint <your gift>` | Posts one cryptic public hint. One per day. |
| `/santa-guess [name]` | Your agent works out who your Santa is from the hints. |
| `/santa-reveal` | After the organiser opens the reveal. |

`/santa-setup` needs a Unix-like shell (Linux, macOS, WSL). Elsewhere, put 32 or more random letters and digits in `.santa-token` and copy `vibe.example.md` to `vibe.md` by hand.

## Run the game (organiser)

Needs [Bun](https://bun.sh).

```sh
cd server
bun install
SANTA_HOST=0.0.0.0 SANTA_INVITE_CODE=pick-one bun run start   # serves /mcp on port 8787
```

Before you share the folder, put the address players can reach in `santa-server.txt` (one line, for example `https://santa.example.org/mcp`). Put the server behind HTTPS if it leaves your own network: tokens travel in a header.

```sh
bun run admin status   # phase, who joined, counts
bun run admin remove NAME   # before the draw: undo a typo or a lost token
bun run admin draw     # once, when everyone has joined (4 players or more)
bun run admin reveal   # on the day
```

Server settings (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SANTA_MIN_BUDGET` | `20` | Smallest budget a player may set. There is no upper limit. |
| `SANTA_CURRENCY` | `EUR` | Label shown next to amounts. |
| `SANTA_MAX_PLAYERS` | `200` | Joining stops at this number. |
| `SANTA_INVITE_CODE` | none | If set, players need it to join. |
| `SANTA_HOST`, `SANTA_PORT` | `127.0.0.1`, `8787` | Where the server listens. |
| `SANTA_DB` | `data/santa.db` | The game's database file. |

Budget: each player sets their own, at or above the minimum. A budget is private; no other player sees it, before or after the reveal.

## What stays secret, and from whom

- Players and their agents see only their own receiver. Questions and hints carry no sender.
- No tool, log line or admin command shows who gives to whom before the reveal.
- The pairs are stored in the SQLite file on the server. Whoever can open that file can read them, so the organiser must not look. Keep the file; deleting it ends the game.

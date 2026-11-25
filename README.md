# Santa's Agents

Secret Santa where every player takes part through an agent in opencode. The agents ask each other anonymous questions, post cryptic hints and guess who their Santa is. People still choose and buy the gifts.

- [Guide for players](#guide-for-players)
- [Guide for the host](#guide-for-the-host)
- [Running your own server](#running-your-own-server)
- [What stays secret, and from whom](#what-stays-secret-and-from-whom)

## Guide for players

### What you need

- opencode installed, with a model that works (if you can chat with it, you are set).
- git, to get this folder.
- The invite code from the host.

### Join the game (once, about five minutes)

1. Get the folder and go into it:
   ```sh
   git clone https://github.com/amazarache/ssanta.git
   cd ssanta
   ```
2. Start opencode in that folder:
   ```sh
   opencode
   ```
3. Type `/santa-setup` and press Enter. This creates two files in the folder:
   - `.santa-token`: your identity in the game. Never share it, never delete it.
   - `vibe.md`: what your agent knows about you.
4. Open `vibe.md` in any editor and fill it in. A filled-in example:
   ```markdown
   - **Name in the game:** Ana
   - **Agent persona:** burnt-out elf
   - **Things I like:** oolong tea, mechanical keyboards, bouldering
   - **Current obsession:** sourdough
   - **Hard no's:** nuts (allergy), mugs, scented candles
   - **My budget for the gift I give:** 30
   - **Gifts must be:** physical
   ```
   Your agent answers your Santa's questions from this file and from nothing else, so write only what you are happy to share. The budget is a plain number, at least the game minimum (20 EUR), with no upper limit. Nobody else sees it.
5. Quit opencode and start it again, so that it picks up your token.
6. Type `/santa-join` followed by the invite code, for example `/santa-join a1b2c3`. Your agent confirms the name you joined under.

You are in. Nothing more happens until the host runs the draw.

### After the draw

Open opencode in the same folder and use these commands. A good rhythm is one `/santa-checkin` per day.

| When | Command | What happens |
| --- | --- | --- |
| Every day | `/santa-checkin` | Your agent tells you who you give to, answers the questions other agents sent it, and shows new replies and the hints about your gift. |
| When you need to know more | `/santa-ask` or `/santa-ask does she like board games` | Sends one anonymous question to your receiver's agent. You have five in the whole game. The reply shows up in a later check-in. |
| When you want ideas | `/santa-ideas` | Three gift ideas inside your budget: safe, funny, wildcard. You choose and buy; the agent never buys anything. |
| Once you have the gift | `/santa-hint a small cast-iron teapot` | Your agent turns your gift into one cryptic public hint. One per day. |
| Any time | `/santa-guess` or `/santa-guess Bogdan` | Your agent works out who your Santa is from the hints. You can change the guess until the reveal. |
| Any time | `/santa-budget` or `/santa-budget 45` | Shows or changes your budget. |
| On reveal day | `/santa-reveal` | Who your Santa was, and who guessed right. |

### Rules of the game

- Do not tell anyone who you give to.
- Do not put your own name in a question or a hint. The server refuses it anyway.
- Keep `.santa-token`. If you lose it after the draw, you are out of the game.
- Play from one folder on one computer. A second clone would be a second player.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| The agent says the santa tools are missing, or `opencode mcp list` shows `santa` as failed with HTTP 401 | The token was not picked up. Check that `.santa-token` exists, then restart opencode. |
| "Wrong invite code" | Ask the host for the code again. |
| "The name ... is taken" | Change the name in `vibe.md` and run `/santa-join <code>` again. |
| "The budget must be at least ..." | Raise the budget in `vibe.md` and join again. |
| "Joining is closed" | The draw has already happened. Tell the host. |
| You joined under a wrong name | Ask the host to remove you (before the draw), then join again. |
| `/santa-setup` does nothing (Windows without WSL) | Create `.santa-token` yourself with 32 or more random letters and digits on one line, and copy `vibe.example.md` to `vibe.md`. |

## Guide for the host

The game server already runs on the k3s cluster and is reachable at `https://santa.mazarache.org/mcp`. All host commands are run from a machine with `kubectl` access to that cluster.

### Before you invite anyone

1. Check that the server is up. This must print `ok`:
   ```sh
   curl https://santa.mazarache.org/healthz
   ```
2. Check that the lobby is in the state you expect:
   ```sh
   kubectl -n santa exec deploy/santa -- bun /app/admin.js status
   ```
   It prints the phase (`lobby`), the names that joined, and counts.
3. Read the invite code:
   ```sh
   kubectl -n santa get secret santa-invite -o jsonpath='{.data.code}' | base64 -d; echo
   ```
4. Go through the [player steps](#join-the-game-once-about-five-minutes) yourself, so you know what players will see. If you play, you are a normal player from here on; being host gives your agent no extra view.

### Invite the players

5. Send the team three things: the repository link, the invite code, and the date by which they must join. A message you can adapt:
   > Secret Santa, played by our agents. Clone https://github.com/amazarache/ssanta, open opencode in it and follow "Guide for players" in the README. Invite code: `<code>`. Minimum budget 20 EUR, no upper limit. Join by `<date>`; the draw is on `<date>`, the reveal on `<date>`.
6. Watch the lobby fill up with the `status` command from step 2.
7. If someone joined under a wrong name or lost their token, remove them so they can join again. This works only before the draw:
   ```sh
   kubectl -n santa exec deploy/santa -- bun /app/admin.js remove "Ana"
   ```

### The draw

8. When everyone is in, run the draw:
   ```sh
   kubectl -n santa exec deploy/santa -- bun /app/admin.js draw
   ```
   Before you press Enter, know that:
   - it needs at least 4 players;
   - it cannot be repeated or undone;
   - nobody can join or be removed afterwards.

   The command prints only the number of players. It never shows who gives to whom.
9. Tell the team the draw is done and that they should run `/santa-checkin`.

### While the game runs

10. Nothing is required from you. `status` shows how many questions, hints and guesses exist, which tells you whether people are playing. A reminder to run `/santa-checkin` daily helps: agents answer questions only when their owner checks in.
11. Do not open the database file. The pairs are stored in it unencrypted.

### The reveal

12. On the day, when the gifts are handed over, open the reveal:
    ```sh
    kubectl -n santa exec deploy/santa -- bun /app/admin.js reveal
    ```
    This also cannot be undone. From then on questions, hints and guesses are closed.
13. Tell everyone to run `/santa-reveal`.

### Changing the settings

Minimum budget, currency and the player limit are in `deploy/kustomization.yaml`. After a change:

```sh
deploy/build.sh && kubectl apply --server-side -k deploy/
```

A new minimum applies to players who join or change their budget afterwards; budgets already accepted stay as they are. To change the invite code, replace the `santa-invite` secret and restart the server with `kubectl -n santa rollout restart deploy/santa`.

### If something goes wrong

| What you see | What to do |
| --- | --- |
| `curl .../healthz` does not print `ok` | `kubectl -n santa get pods` should show one `santa` pod and two `cloudflared` pods, all Running. `kubectl -n santa logs deploy/santa` shows the server's log. |
| A player cannot connect, others can | It is on the player's side: missing `.santa-token` or opencode not restarted. |
| A player lost their token after the draw | They cannot be restored. Their receiver still has a Santa on paper, so arrange that gift by hand. |

### After the game

To remove everything from the cluster, including the database and the tunnel: `kubectl delete namespace santa`. Then delete the tunnel in the Cloudflare dashboard.

## Running your own server

Needs [Bun](https://bun.sh).

```sh
cd server
bun install
SANTA_HOST=0.0.0.0 SANTA_INVITE_CODE=pick-one bun run start   # serves /mcp on port 8787
bun run admin status                                          # also: draw, reveal, remove NAME
```

Put the address players can reach in `santa-server.txt` (one line, ending in `/mcp`) before you share the folder. Use HTTPS outside your own network: tokens travel in a header.

### On Kubernetes

`deploy/` holds a kustomize setup: the server is bundled into one file, mounted from a ConfigMap into the stock Bun image, with a 1Gi volume for the database and an ingress.

```sh
deploy/build.sh                                   # bundle server and admin into deploy/dist
kubectl create namespace santa
kubectl -n santa create secret generic santa-invite --from-literal=code=pick-one   # optional
kubectl apply --server-side -k deploy/            # --server-side is needed: the bundle is too big for client-side apply
```

Change the host name in `deploy/santa.yaml` and the storage class if you do not run Longhorn. `deploy/cloudflared.yaml` adds a Cloudflare Tunnel; the steps are in its first lines.

### Server settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SANTA_MIN_BUDGET` | `20` | Smallest budget a player may set. There is no upper limit. |
| `SANTA_CURRENCY` | `EUR` | Label shown next to amounts. |
| `SANTA_MAX_PLAYERS` | `200` | Joining stops at this number. |
| `SANTA_INVITE_CODE` | none | If set, players need it to join. |
| `SANTA_HOST`, `SANTA_PORT` | `127.0.0.1`, `8787` | Where the server listens. |
| `SANTA_DB` | `data/santa.db` | The game's database file. |

## What stays secret, and from whom

- Players and their agents see only their own receiver. Questions and hints carry no sender.
- A player's budget is never shown to another player, before or after the reveal.
- No tool, log line or admin command shows who gives to whom before the reveal.
- The pairs are stored in the SQLite file on the server. Whoever can open that file can read them, so the host must not look.

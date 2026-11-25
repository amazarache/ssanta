// Organiser commands. Run on the machine that holds the database.
// Nothing here prints who gives to whom.

import { Game, GameError } from "./game.ts";
import { openDb } from "./db.ts";

const game = new Game(openDb(process.env.SANTA_DB ?? "data/santa.db"));
const cmd = process.argv[2];
// The first argument after the command that is not a flag, so `confirm --rebind EMAIL` works too.
const target = process.argv.slice(3).find((a) => !a.startsWith("--"));
// Addresses are typed by players. Never let one move the cursor or hide a line on the host's screen.
const safe = (text: string) => text.replace(/[^\x20-\x7e]/g, "?");

try {
  if (cmd === "status") {
    console.log(JSON.stringify(game.adminStatus(), null, 2));
  } else if (cmd === "draw") {
    const { players } = game.draw();
    console.log(`Draw done for ${players} players. Each player can now read their own assignment.`);
  } else if (cmd === "reveal") {
    game.openReveal();
    console.log("Reveal is open. Players can now call the reveal tool.");
  } else if (cmd === "pending") {
    const rows = game.adminPending();
    if (rows.length === 0) console.log("Nobody is waiting for a confirmation.");
    for (const r of rows) {
      console.log(safe(`${r.email}  wants the name "${r.requested_name}"  asked ${r.minutes_ago} min ago${r.note ? `  [${r.note}]` : ""}`));
    }
    if (rows.length) console.log("\nBefore you confirm, check with the player directly that they just ran /santa-join.");
  } else if (cmd === "confirm" && target) {
    const name = game.adminConfirm(target, { rebind: process.argv.includes("--rebind") });
    console.log(safe(`Confirmed. They play as ${name}.`));
  } else if (cmd === "reject" && target) {
    game.adminReject(target);
    console.log("Cleared. The player can run /santa-join again now.");
  } else if (cmd === "remove" && target) {
    game.removePlayer(target);
    console.log(safe(`Removed ${target}. They can join again.`));
  } else {
    console.log("Usage: bun run admin <status|draw|reveal|remove NAME|pending|confirm EMAIL [--rebind]|reject EMAIL>");
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  if (!(err instanceof GameError)) throw err;
  console.error(err.message);
  process.exit(1);
}

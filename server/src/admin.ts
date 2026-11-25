// Organiser commands. Run on the machine that holds the database.
// Nothing here prints who gives to whom, and nothing prints a request's reference.

import { dbPath, gameOptions } from "./config.ts";
import { openDb } from "./db.ts";
import { Game, GameError } from "./game.ts";

const USAGE = `Usage: bun run admin <command>
  status                         phase, who joined, counts
  pending                        join requests waiting for confirmation
  confirm EMAIL REF [--rebind]   let a player in by hand; REF is the reference the player reads to you
  reject EMAIL | --all | --late  clear pending requests and their mail limits (--late: only the unlisted ones)
  remove NAME                    before the draw: take a player out
  draw                           once, when everyone has joined
  reveal                         on the day`;

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
// Only these flags exist. Anything else, such as "draw --help", must print the usage and do nothing.
const KNOWN_FLAGS: Record<string, string[]> = { confirm: ["--rebind"], reject: ["--all", "--late"] };
const unknownFlag = [...flags].find((f) => !(KNOWN_FLAGS[cmd ?? ""] ?? []).includes(f));
// Flags may come before or after the other arguments.
const args = rest.filter((a) => !a.startsWith("--"));
// Names and addresses are typed by players. Whatever they hold, it must not move the cursor or hide a line here.
const safe = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?");

try {
  if (unknownFlag) {
    console.error(`Unknown option ${safe(unknownFlag)}. Nothing was done.\n`);
    console.error(USAGE);
    process.exit(1);
  }
  const game = new Game(openDb(dbPath()), gameOptions());
  if (cmd === "status" && args.length === 0) {
    const status = game.adminStatus();
    console.log(JSON.stringify({ ...status, players: status.players.map(safe) }, null, 2));
  } else if (cmd === "draw" && args.length === 0) {
    const { players } = game.draw();
    console.log(`Draw done for ${players} players. Each player can now read their own assignment.`);
  } else if (cmd === "reveal" && args.length === 0) {
    game.openReveal();
    console.log("Reveal is open. Players can now call the reveal tool.");
  } else if (cmd === "pending" && args.length === 0) {
    const { requests, too_late } = game.adminPending();
    if (requests.length === 0) console.log("Nobody is waiting for a confirmation.");
    for (const r of requests) {
      console.log(safe(`${r.email}  wants the name "${r.requested_name}"  asked ${r.minutes_ago} min ago${r.note ? `  [${r.note}]` : ""}`));
    }
    if (requests.length) {
      console.log("\nTo confirm one, ask that player for their address and the reference their agent showed them,");
      console.log("on a channel where you know it is them. Then: confirm EMAIL REF");
    }
    if (too_late) {
      console.log(`\n${too_late} request(s) are not listed: the draw is done and their address is not in the game, so they cannot join.`);
      console.log("Clear them with: reject --late");
    }
  } else if (cmd === "confirm" && args.length === 2) {
    const name = game.adminConfirm(args[0]!, args[1]!, { rebind: flags.has("--rebind") });
    console.log(safe(`Confirmed. They play as ${name}.`));
  } else if (cmd === "confirm" && args.length === 1) {
    console.error("confirm needs the address and the reference: confirm EMAIL REF");
    console.error("The reference is shown to the player by their agent when they run /santa-join. Ask them for it.");
    process.exit(1);
  } else if (cmd === "reject" && flags.size === 1 && args.length === 0) {
    const n = game.adminReject(flags.has("--all") ? "all" : "unlisted");
    console.log(`Cleared ${n} pending request(s).${flags.has("--all") ? " Players who were waiting can run /santa-join again." : ""}`);
  } else if (cmd === "reject" && flags.size === 0 && args.length === 1) {
    console.log(`Cleared ${game.adminReject({ email: args[0]! })} pending request(s). The player can run /santa-join again now.`);
  } else if (cmd === "remove" && args.length === 1) {
    game.removePlayer(args[0]!);
    console.log(safe(`Removed ${args[0]}. They can join again.`));
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  // GameError: a rule said no. Error from config: a setting is wrong. Both are messages for the host, not crashes.
  if (!(err instanceof GameError) && !(err instanceof Error && /^SANTA_/.test(err.message))) throw err;
  console.error(safe(err.message));
  process.exit(1);
}

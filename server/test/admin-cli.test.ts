import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "../src/game.ts";

// The admin command runs as a second process on the same database file, as it does on the cluster.
function world(env: Record<string, string> = {}) {
  const db = join(mkdtempSync(join(tmpdir(), "santa-")), "s.db");
  const game = new Game(new Database(db), { inviteCode: "elf", mailer: async () => {}, minPlayers: 3 });
  const admin = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", "run", "src/admin.ts", ...args], { env: { ...process.env, SANTA_DB: db, ...env } });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  const ask = (token: string, name: string, email: string) => game.requestJoin(token, name, 20, email, "elf");
  return { game, admin, ask };
}

test("confirm needs address and reference; flags may come first; mistakes exit with 1", async () => {
  const { admin, ask } = world();
  const ref = (await ask("t1", "Ana", "ana@example.org")).request_ref;

  const list = admin("pending");
  expect(list.out).toContain('ana@example.org  wants the name "Ana"  asked 0 min ago');
  expect(list.out).toContain("confirm EMAIL REF");
  expect(list.out).not.toContain(ref);

  expect(admin("confirm", "ana@example.org")).toMatchObject({ code: 1, out: expect.stringContaining("confirm EMAIL REF") });
  expect(admin("confirm", "ana@example.org", "ZZZZZZ")).toMatchObject({ code: 1, out: expect.stringContaining("No pending request matches") });
  expect(admin("reject", "ana@exmaple.org")).toMatchObject({ code: 1, out: expect.stringContaining("Nothing is pending") });
  expect(admin("reject")).toMatchObject({ code: 1, out: expect.stringContaining("Usage") });
  expect(admin("confirm", "--rebind", "ana@example.org", ref.toLowerCase())).toMatchObject({
    code: 0,
    out: expect.stringContaining("They play as Ana"),
  });
  expect(admin("confirm", "ana@example.org", ref)).toMatchObject({ code: 1 });
  expect(JSON.parse(admin("status").out)).toMatchObject({ phase: "lobby", players: ["Ana"], pending_confirmations: 0 });
  expect(admin("pending").out).toContain("Nobody is waiting");
  expect(admin("nonsense")).toMatchObject({ code: 1, out: expect.stringContaining("Usage") });
});

test("names with accents print as they are; anything that could steer the terminal does not", async () => {
  const { admin, ask } = world();
  await ask("t1", "Ștefan Bălan", "stefan@example.org");
  expect(admin("pending").out).toContain('wants the name "Ștefan Bălan"');
  expect(admin("remove", "x\u001b[2Jy\u202e")).toMatchObject({ code: 1, out: expect.stringContaining("Nobody called x?[2Jy? has joined") });
});

test("reject --all clears the list", async () => {
  const { admin, ask } = world();
  await ask("t1", "Ana", "ana@example.org");
  await ask("t2", "Bo", "bo@example.org");
  expect(admin("reject", "--all").out).toContain("Cleared 2 pending request(s)");
  expect(admin("pending").out).toContain("Nobody is waiting");
});

test("the admin command enforces the same settings as the server", async () => {
  const { admin, ask, game } = world({ SANTA_MAX_PLAYERS: "1" });
  const a = (await ask("t1", "Ana", "ana@example.org")).request_ref;
  const b = (await ask("t2", "Bo", "bo@example.org")).request_ref;
  expect(admin("confirm", "ana@example.org", a).code).toBe(0);
  expect(admin("confirm", "bo@example.org", b)).toMatchObject({ code: 1, out: expect.stringContaining("The game is full") });
  expect(game.adminStatus().players).toEqual(["Ana"]);
  const bad = world({ SANTA_MAX_PLAYERS: "lots" });
  expect(bad.admin("status")).toMatchObject({ code: 1, out: expect.stringContaining("SANTA_MAX_PLAYERS must be a number") });
});

test("an option the command does not know stops it before anything happens", async () => {
  const { admin, ask, game } = world();
  for (const [t, n] of [["a", "Ana"], ["b", "Bo"], ["c", "Cy"]] as const) {
    const ref = (await ask(t, n, `${n.toLowerCase()}@example.org`)).request_ref;
    expect(admin("confirm", `${n.toLowerCase()}@example.org`, ref).code).toBe(0);
  }
  for (const args of [["draw", "--help"], ["draw", "--dry-run"], ["reveal", "--anything"], ["status", "--all"], ["reject", "--all", "--late"], ["confirm", "--force", "a@b.co", "K7Q42M"]]) {
    expect(admin(...args)).toMatchObject({ code: 1, out: expect.stringContaining("Usage") });
  }
  expect(game.phase()).toBe("lobby");
  expect(admin("draw", "extra")).toMatchObject({ code: 1 });
  expect(game.phase()).toBe("lobby");
});

test("reject --late clears only what the list does not show", async () => {
  const { admin, ask, game } = world();
  for (const [t, n] of [["a", "Ana"], ["b", "Bo"], ["c", "Cy"], ["e", "Ema"]] as const) {
    game.adminConfirm(`${n.toLowerCase()}@example.org`, (await ask(t, n, `${n.toLowerCase()}@example.org`)).request_ref);
  }
  await ask("d", "Di", "di@example.org"); // asked in time, never confirmed
  expect(admin("draw").code).toBe(0);
  const list = admin("pending").out;
  expect(list).toContain("1 request(s) are not listed");
  expect(list).not.toContain("came after the draw");
  expect(admin("reject", "--late").out).toContain("Cleared 1 pending request(s)");
  expect(admin("pending").out).not.toContain("not listed");
});

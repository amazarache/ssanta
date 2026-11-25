import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game } from "../src/game.ts";

// The admin CLI runs as a second process on the same database file, as it does on the cluster.
test("admin CLI: flag order, safe printing, and exit codes", async () => {
  const db = join(mkdtempSync(join(tmpdir(), "santa-")), "s.db");
  const game = new Game(new Database(db), { mailer: async () => {}, minPlayers: 3 });
  await game.requestJoin("t1", "Ana", 20, "ana@example.org");
  const admin = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", "run", "src/admin.ts", ...args], { env: { ...process.env, SANTA_DB: db } });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  };
  expect(admin("pending").out).toContain('ana@example.org  wants the name "Ana"');
  expect(admin("reject", "ana@exmaple.org")).toMatchObject({ code: 1 });
  expect(admin("confirm", "--rebind", "ana@example.org").out).toContain("They play as Ana");
  expect(admin("confirm", "ana@example.org")).toMatchObject({ code: 1 });
  expect(admin("status").out).toContain('"Ana"');
});

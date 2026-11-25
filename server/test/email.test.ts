import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Game } from "../src/game.ts";
import { cloudflareMailer, MailError } from "../src/mail.ts";

function setup(opts = {}) {
  let t = Date.parse("2026-12-01T10:00:00Z");
  const sent: { to: string; code: string }[] = [];
  const logs: string[] = [];
  const db = new Database(":memory:");
  const game = new Game(db, {
    now: () => new Date(t),
    mailer: async (to, code) => void sent.push({ to, code }),
    log: (l) => logs.push(l),
    ...opts,
  });
  const wait = (ms: number) => (t += ms);
  const signUp = async (token: string, name: string, email: string) => {
    await game.requestJoin(token, name, 20, email);
    wait(61_000);
    return game.confirm(token, sent.at(-1)!.code);
  };
  return { game, db, sent, logs, wait, signUp };
}

describe("joining by email", () => {
  test("a code is mailed and confirming it joins the lobby", async () => {
    const { game, sent } = setup();
    const reply = await game.requestJoin("t1", "Ana", 25, " Ana@Example.org ");
    expect(reply.confirmation_sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("ana@example.org");
    expect(sent[0]!.code).toMatch(/^\d{6}$/);
    expect(game.status("t1").you).toBeNull();
    expect(game.confirm("t1", sent[0]!.code)).toMatchObject({ joined_as: "Ana", your_budget: 25 });
    expect(game.status("t1").you).toBe("Ana");
    expect(() => game.confirm("t1", sent[0]!.code)).toThrow(/no code waiting/);
  });

  test("plain join is refused, and input is checked before any mail goes out", async () => {
    const { game, sent } = setup({ inviteCode: "elf" });
    expect(() => game.join("t1", "Ana", 20, "elf")).toThrow(/email/);
    await expect(game.requestJoin("t1", "Ana", 20, "a@b.co")).rejects.toThrow(/invite/);
    await expect(game.requestJoin("t1", "Ana", 20, "not-an-address", "elf")).rejects.toThrow(/email address/);
    await expect(game.requestJoin("t1", "Ana", 5, "a@b.co", "elf")).rejects.toThrow(/at least 20/);
    await expect(game.requestJoin("t1", "<b>", 20, "a@b.co", "elf")).rejects.toThrow(/letters/);
    expect(sent).toHaveLength(0);
  });

  test("the code works only for the token that asked, has five tries and expires", async () => {
    const { game, sent, wait } = setup();
    await game.requestJoin("t1", "Ana", 20, "ana@example.org");
    const code = sent[0]!.code;
    const wrong = code === "000000" ? "000001" : "000000";
    expect(() => game.confirm("other-token", code)).toThrow(/no code waiting/);
    expect(() => game.confirm("t1", "12345")).toThrow(/six digits/);
    for (let i = 4; i >= 0; i--) expect(() => game.confirm("t1", wrong)).toThrow(`${i} tries left`);
    expect(() => game.confirm("t1", code)).toThrow(/no longer valid/);

    wait(61_000);
    await game.requestJoin("t1", "Ana", 20, "ana@example.org");
    wait(15 * 60_000 + 1);
    expect(() => game.confirm("t1", sent[1]!.code)).toThrow(/no longer valid/);
  });

  test("codes keep leading zeros", async () => {
    const { game, sent } = setup({ rand: () => 42 });
    await game.requestJoin("t1", "Ana", 20, "ana@example.org");
    expect(sent[0]!.code).toBe("000042");
    expect(game.confirm("t1", "000042").joined_as).toBe("Ana");
  });

  test("limits: one mail a minute and five a day per address, and a daily total", async () => {
    const { game, sent, wait } = setup({ mailDailyCap: 7 });
    await game.requestJoin("t1", "Ana", 20, "ana@example.org");
    await expect(game.requestJoin("t2", "Ana2", 20, "ana@example.org")).rejects.toThrow(/less than a minute/);
    for (let i = 0; i < 4; i++) {
      wait(61_000);
      await game.requestJoin("t1", "Ana", 20, "ana@example.org");
    }
    wait(61_000);
    await expect(game.requestJoin("t1", "Ana", 20, "ana@example.org")).rejects.toThrow(/Too many codes/);
    await game.requestJoin("t3", "Bo", 20, "bo@example.org");
    await game.requestJoin("t4", "Cy", 20, "cy@example.org");
    await expect(game.requestJoin("t5", "Di", 20, "di@example.org")).rejects.toThrow(/email limit for today/);
    expect(sent).toHaveLength(7);
    wait(24 * 3600_000);
    await game.requestJoin("t5", "Di", 20, "di@example.org");
    expect(sent).toHaveLength(8);
  });

  test("one address is one player; confirming again from a new token moves the player", async () => {
    const { game, sent, signUp, wait } = setup({ minPlayers: 3 });
    await signUp("t1", "Ana", "ana@example.org");
    await signUp("t2", "Bo", "bo@example.org");
    await signUp("t3", "Cy", "cy@example.org");
    game.draw();
    const before = game.myAssignment("t1");

    // Lost token after the draw: same address, new installation, different name typed.
    wait(61_000);
    const reply = await game.requestJoin("t1-new", "Somebody Else", 99, "ana@example.org");
    expect(game.confirm("t1-new", sent.at(-1)!.code).joined_as).toBe("Ana");
    expect(game.myAssignment("t1-new")).toEqual(before);
    expect(() => game.myAssignment("t1")).toThrow(/not joined/);
    expect(game.adminStatus().players).toEqual(["Ana", "Bo", "Cy"]);

    // After the draw an unknown address gets the same reply, no mail, and cannot get in.
    const mails = sent.length;
    expect(await game.requestJoin("t9", "Late", 20, "late@example.org")).toEqual(reply);
    expect(sent).toHaveLength(mails);
    expect(() => game.adminConfirm("late@example.org")).toThrow(/closed/);
  });

  test("a taken name is refused at confirmation and nothing is half-created", async () => {
    const { game, sent, signUp, wait } = setup();
    await signUp("t1", "Ana", "ana@example.org");
    await game.requestJoin("t2", "ana", 20, "other@example.org");
    expect(() => game.confirm("t2", sent.at(-1)!.code)).toThrow(/taken/);
    wait(61_000);
    await game.requestJoin("t2", "Ana B", 20, "other@example.org");
    expect(game.confirm("t2", sent.at(-1)!.code).joined_as).toBe("Ana B");
  });

  test("mail failures give the player a plain message and log only codes", async () => {
    for (const [err, msg] of [
      [new MailError(403, 10208), /verified addresses.*saved/],
      [new MailError(429, 10004), /limit is reached/],
      [new Error("boom"), /could not be sent/],
    ] as const) {
      const { game, logs } = setup({
        mailer: async () => {
          throw err;
        },
      });
      await expect(game.requestJoin("t1", "Ana", 20, "ana@example.org")).rejects.toThrow(msg);
      expect(game.adminPending()).toEqual(["ana@example.org"]);
      expect(game.adminConfirm("ana@example.org")).toBe("Ana");
      expect(logs.join()).not.toMatch(/ana|example/i);
      expect(logs[0]).toMatch(/^mail failed \d+\/(\d+|-)$/);
    }
  });

  test("the host can list pending addresses and confirm one by hand", async () => {
    const { game } = setup();
    await game.requestJoin("t1", "Ana", 20, "ana@example.org");
    expect(game.adminPending()).toEqual(["ana@example.org"]);
    expect(game.adminConfirm("ANA@example.org")).toBe("Ana");
    expect(game.adminPending()).toEqual([]);
    expect(() => game.adminConfirm("nobody@example.org")).toThrow(/No pending/);
  });

  test("no player-facing output contains an email address", async () => {
    const { game, signUp } = setup({ minPlayers: 3 });
    await signUp("t1", "Ana", "ana@example.org");
    await signUp("t2", "Bo", "bo@example.org");
    await signUp("t3", "Cy", "cy@example.org");
    game.draw();
    game.postHint("t1", "It hums.");
    game.ask("t1", "Tea?");
    game.openReveal();
    const out = [game.status("t2"), game.inbox("t2"), game.feed("t2", "today"), game.reveal("t2"), game.adminStatus()];
    expect(JSON.stringify(out)).not.toContain("@");
  });
});

test("a database from before email confirmation is upgraded in place", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
           token_hash TEXT NOT NULL UNIQUE, budget REAL NOT NULL);
           INSERT INTO players (name, name_key, token_hash, budget) VALUES ('Old', 'old', 'old-token', 20);`);
  const game = new Game(db);
  expect(game.status("old-token").you).toBe("Old");
  expect(game.join("t2", "New", 20).joined_as).toBe("New");
  new Game(db); // opening twice is fine
});

describe("Cloudflare mail request", () => {
  test("matches the documented REST shape", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const send = cloudflareMailer({
      accountId: "acc123",
      token: "cfut_secret",
      from: "santa@example.org",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Response.json({ success: true, errors: [], result: {} });
      }) as never,
    });
    await send("ana@example.org", "000042");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer cfut_secret", "Content-Type": "application/json" });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(Object.keys(body).sort()).toEqual(["from", "html", "subject", "text", "to"]);
    expect(body).toMatchObject({ to: "ana@example.org", from: "santa@example.org" });
    expect(body.text).toContain("000042");
    expect(body.html).toContain("000042");
  });

  test("turns error replies into a status and Cloudflare code", async () => {
    const failing = (status: number, body: unknown) =>
      cloudflareMailer({
        accountId: "a",
        token: "t",
        from: "f@example.org",
        fetch: (async () => Response.json(body, { status })) as never,
      });
    const e1 = await failing(403, { success: false, errors: [{ code: 10208 }] })("x@example.org", "1").catch((e) => e);
    expect(e1).toBeInstanceOf(MailError);
    expect([e1.status, e1.code]).toEqual([403, 10208]);
    const e2 = await failing(500, "oops")("x@example.org", "1").catch((e) => e);
    expect([e2.status, e2.code]).toEqual([500, null]);
  });
});

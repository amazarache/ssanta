import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Game, type GameOptions } from "../src/game.ts";
import { cloudflareMailer, MailError } from "../src/mail.ts";

const INVITE = "elf-invite";
const REF = /^[0-9A-HJKMNP-TV-Z]{6}$/;

function setup(opts: GameOptions = {}) {
  let t = Date.parse("2026-12-01T10:00:00Z");
  const sent: { to: string; code: string }[] = [];
  const logs: string[] = [];
  const db = new Database(":memory:");
  const game = new Game(db, {
    now: () => new Date(t),
    inviteCode: INVITE,
    mailer: async (to, code) => void sent.push({ to, code }),
    log: (l) => logs.push(l),
    ...opts,
  });
  const wait = (ms: number) => (t += ms);
  /** Files a join request the way a player's agent does. */
  const ask = (token: string, name: string, email: string, budget = 20) => game.requestJoin(token, name, budget, email, INVITE);
  /** The same, but an error becomes its message: what the player gets to read either way. */
  const said = (token: string, name: string, email: string, budget = 20) =>
    ask(token, name, email, budget).then(JSON.stringify, (e: Error) => `error: ${e.message}`);
  const signUp = async (token: string, name: string, email: string) => {
    await ask(token, name, email);
    wait(61_000);
    return game.confirm(token, sent.at(-1)!.code);
  };
  const lastCode = () => sent.at(-1)!.code;
  const wrongCode = () => (sent.at(-1)?.code === "000000" ? "000001" : "000000");
  return { game, db, sent, logs, wait, ask, said, signUp, lastCode, wrongCode };
}

/** The reference as the player reads it, from a reply or from an error message. */
function refIn(text: string): string {
  return /reference: ([0-9A-Z]{6})/.exec(text)![1]!;
}

const mailDown = async () => {
  throw new Error("mail is down");
};

describe("joining by email", () => {
  test("a code is mailed, the reply carries a reference, and confirming the code joins the lobby", async () => {
    const { game, sent, ask } = setup();
    const reply = await ask("t1", "Ana", " Ana@Example.org ", 25);
    expect(reply.confirmation_sent).toBe(true);
    expect(reply.request_ref).toMatch(REF);
    expect(reply.note).toContain(`reference: ${reply.request_ref}`);
    expect(sent).toEqual([{ to: "ana@example.org", code: expect.stringMatching(/^\d{6}$/) }]);
    expect(game.status("t1").you).toBeNull();
    expect(game.confirm("t1", sent[0]!.code)).toMatchObject({ joined_as: "Ana", your_budget: 25, players: 1 });
    expect(game.status("t1").you).toBe("Ana");
    expect(() => game.confirm("t1", sent[0]!.code)).toThrow(/no code waiting/);
  });

  test("input is checked before anything is saved or sent", async () => {
    const { game, sent, ask } = setup();
    expect(() => game.join("t1", "Ana", 20, INVITE)).toThrow(/email/);
    await expect(game.requestJoin("t1", "Ana", 20, "a@b.co")).rejects.toThrow(/invite/);
    await expect(game.requestJoin("t1", "Ana", 20, "a@b.co", "elf-invitE")).rejects.toThrow(/invite/);
    await expect(ask("t1", "Ana", "a@b.co", 5)).rejects.toThrow(/at least 20/);
    await expect(ask("t1", "<b>", "a@b.co")).rejects.toThrow(/letters/);
    const badAddresses = [
      "not-an-address",
      "a@b",
      "a b@example.org",
      "a\tb@example.org",
      "x\x1b[1A\x1b[2K@a.bc", // terminal escape: would erase a line on the host's screen
      "a​b@example.org", // zero-width space
      "a‮b@example.org", // right-to-left override
      "аna@example.org", // Cyrillic letter that looks like a Latin one
      "a$(id)@example.org", // shell syntax: the host may paste an address into a command
      "a`id`@example.org",
      "a;b@example.org",
      "a|b@example.org",
      "a&b@example.org",
      "o'brien@example.org",
      '"a"@example.org',
      "a@@example.org",
      "--all@example.org", // would read as an option of the host's command
      "-x@example.org",
      "a@example.org\n",
    ];
    for (const bad of badAddresses.slice(0, -1)) await expect(ask("t1", "Ana", bad)).rejects.toThrow(/email address/);
    expect((await ask("t1", "Ana", badAddresses.at(-1)!)).confirmation_sent).toBe(true); // surrounding whitespace is trimmed
    expect(sent).toHaveLength(1);
    expect(game.adminPending().requests.map((r) => r.email)).toEqual(["a@example.org"]);
  });

  test("with email confirmation and no invite code, joining is off", async () => {
    const { game, sent } = setup({ inviteCode: undefined });
    expect(game.joinBlocked).toMatch(/invite code/);
    await expect(game.requestJoin("t1", "Ana", 20, "ana@example.org")).rejects.toThrow(/switched off/);
    await expect(game.requestJoin("t1", "Ana", 20, "ana@example.org", "")).rejects.toThrow(/switched off/);
    expect(sent).toHaveLength(0);
    expect(setup().game.joinBlocked).toBeNull();
  });

  test("the code works only for the installation that asked, has five tries and expires", async () => {
    const { game, ask, lastCode, wrongCode, wait } = setup();
    await ask("t1", "Ana", "ana@example.org");
    const code = lastCode();
    expect(() => game.confirm("other-token", code)).toThrow(/no code waiting/);
    expect(() => game.confirm("t1", "12345")).toThrow(/six digits/);
    // The tries are counted although confirm runs in a transaction that an error would roll back.
    for (let left = 4; left >= 0; left--) expect(() => game.confirm("t1", wrongCode())).toThrow(`${left} tries left`);
    expect(() => game.confirm("t1", code)).toThrow(/no longer valid/);

    wait(61_000);
    await ask("t1", "Ana", "ana@example.org");
    wait(15 * 60_000 + 1);
    expect(() => game.confirm("t1", lastCode())).toThrow(/no longer valid/);
  });

  test("codes keep leading zeros", async () => {
    const { game, sent, ask } = setup({ rand: (n) => (n === 1_000_000 ? 42 : 0) });
    await ask("t1", "Ana", "ana@example.org");
    expect(sent[0]!.code).toBe("000042");
    expect(game.confirm("t1", "000042").joined_as).toBe("Ana");
  });

  test("the limits stop mail, never the request: one a minute and five a day per address, and a daily total", async () => {
    const { game, sent, ask, said, wait } = setup({ mailDailyCap: 7 });
    await ask("t1", "Ana", "ana@example.org");
    const cooled = await said("t2", "Ana2", "ana@example.org");
    expect(cooled).toMatch(/^error: A code was sent to this address less than a minute ago.*Your request is saved.*reference: [0-9A-Z]{6}$/);
    for (let i = 0; i < 4; i++) {
      wait(61_000);
      await ask("t1", "Ana", "ana@example.org");
    }
    wait(61_000);
    expect(await said("t1", "Ana", "ana@example.org")).toMatch(/^error: Too many codes.*Your request is saved/);
    await ask("t3", "Bo", "bo@example.org");
    await ask("t4", "Cy", "cy@example.org");
    expect(await said("t5", "Di", "di@example.org")).toMatch(/^error: The server reached its email limit.*Your request is saved/);
    expect(sent).toHaveLength(7);
    // Every one of them is on the host's list, mailed or not.
    expect(game.adminPending().requests.map((r) => r.email)).toEqual([
      "ana@example.org",
      "ana@example.org",
      "bo@example.org",
      "cy@example.org",
      "di@example.org",
    ]);
    wait(24 * 3600_000);
    await ask("t5", "Di", "di@example.org");
    expect(sent).toHaveLength(8);
  });

  test("a retry refused by a limit keeps the mailed code, and does not hand out fresh tries", async () => {
    const { game, ask, said, lastCode, wrongCode } = setup();
    const first = await ask("t1", "Ana", "ana@example.org");
    const code = lastCode();
    expect(() => game.confirm("t1", wrongCode())).toThrow("4 tries left");
    expect(() => game.confirm("t1", wrongCode())).toThrow("3 tries left");
    // Asking again inside the minute sends nothing. The reference and the code stay as they were.
    expect(refIn(await said("t1", "Ana", "ana@example.org"))).toBe(first.request_ref);
    expect(() => game.confirm("t1", wrongCode())).toThrow("2 tries left");
    expect(game.confirm("t1", code).joined_as).toBe("Ana");
  });

  test("a code mailed to one address cannot confirm another", async () => {
    const { game, ask, said, lastCode } = setup();
    const first = await ask("t1", "Ana", "ana@example.org");
    const codeForAna = lastCode();
    // Bo's address is inside its cooldown, so when t1 switches to it no new code goes out.
    await ask("t2", "Bo", "bo@example.org");
    const switched = await said("t1", "Ana", "bo@example.org");
    expect(switched).toMatch(/less than a minute ago/);
    expect(refIn(switched)).not.toBe(first.request_ref);
    expect(() => game.confirm("t1", codeForAna)).toThrow(/no longer valid/);
    expect(game.status("t1").you).toBeNull();
    // The other way round as well: with no limit in the way, the new address gets a new code.
    const { game: g2, ask: ask2, lastCode: last2 } = setup();
    await ask2("t1", "Ana", "ana@example.org");
    const old = last2();
    await ask2("t1", "Ana", "ana2@example.org");
    if (last2() !== old) expect(() => g2.confirm("t1", old)).toThrow(/Wrong code/);
  });

  test("when mail is down, every request is still saved for the host, whatever the daily cap", async () => {
    const { game, said, wait, logs } = setup({ mailDailyCap: 3, mailer: mailDown });
    const texts: string[] = [];
    for (let i = 0; i < 5; i++) {
      texts.push(await said(`t${i}`, `P${i}`, `p${i}@example.org`));
      wait(1000);
    }
    expect(texts.slice(0, 3).every((x) => /could not be sent.*Your request is saved.*reference: /.test(x))).toBe(true);
    expect(texts.slice(3).every((x) => /email limit for today.*Your request is saved.*reference: /.test(x))).toBe(true);
    expect(game.adminPending().requests).toHaveLength(5);
    expect(game.adminConfirm("p4@example.org", refIn(texts[4]!))).toBe("P4");
    expect(logs.join()).not.toMatch(/example|P\d/);
    expect(logs.filter((l) => /^mail failed \d+\/(\d+|-)$/.test(l))).toHaveLength(3);
  });

  test("mail failures give the player a plain message with the reference", async () => {
    for (const [err, msg] of [
      [new MailError(403, 10208), /verified addresses.*saved.*reference: [0-9A-Z]{6}$/],
      [new MailError(429, 10004), /limit is reached.*saved.*reference: [0-9A-Z]{6}$/],
      [new Error("boom"), /could not be sent.*saved.*reference: [0-9A-Z]{6}$/],
    ] as const) {
      const { ask } = setup({
        mailer: async () => {
          throw err;
        },
      });
      await expect(ask("t1", "Ana", "ana@example.org")).rejects.toThrow(msg);
    }
  });

  test("the number of waiting requests is capped, and an installation that already waits can still update", async () => {
    const { game, ask, said, wait } = setup({ maxPending: 2 });
    await ask("t1", "Ana", "ana@example.org");
    await ask("t2", "Bo", "bo@example.org");
    expect(await said("t3", "Cy", "cy@example.org")).toMatch(/Too many join requests are waiting/);
    wait(61_000);
    expect((await ask("t1", "Ana Maria", "ana@example.org")).confirmation_sent).toBe(true);
    expect(game.adminPending().requests.map((r) => r.requested_name)).toEqual(["Ana Maria", "Bo"]);
    expect(game.adminReject(null)).toBe(2);
    expect((await ask("t3", "Cy", "cy@example.org")).confirmation_sent).toBe(true);
  });

  test("a taken name is refused at confirmation and nothing is half-created", async () => {
    const { game, ask, signUp, lastCode, wait } = setup();
    await signUp("t1", "Ana", "ana@example.org");
    await ask("t2", "ana", "other@example.org");
    expect(() => game.confirm("t2", lastCode())).toThrow(/taken/);
    expect(game.adminStatus().players).toEqual(["Ana"]);
    wait(61_000);
    await ask("t2", "Ana B", "other@example.org");
    expect(game.confirm("t2", lastCode()).joined_as).toBe("Ana B");
  });

  test("one address is one player; a new installation with the same address takes the player over", async () => {
    const { game, ask, signUp, lastCode, wait } = setup({ minPlayers: 3 });
    await signUp("a", "Ana", "ana@example.org");
    await signUp("b", "Bo", "bo@example.org");
    await signUp("c", "Cy", "cy@example.org");
    game.draw();
    const anaGives = game.myAssignment("a");
    // Lost token after the draw: same address, new installation, another name typed.
    wait(61_000);
    await ask("a-new", "Somebody Else", "ana@example.org", 99);
    expect(game.confirm("a-new", lastCode()).joined_as).toBe("Ana");
    expect(game.myAssignment("a-new")).toEqual(anaGives);
    expect(() => game.myAssignment("a")).toThrow(/not joined/);
    expect(game.adminStatus().players).toEqual(["Ana", "Bo", "Cy"]);
  });
});

describe("confirming by hand", () => {
  test("needs the address and the reference, which only the requester is shown", async () => {
    const { game, said } = setup({ mailer: mailDown });
    const ref = refIn(await said("t1", "Ana", "ana@example.org"));
    const list = game.adminPending();
    expect(list).toEqual({ requests: [{ email: "ana@example.org", requested_name: "Ana", minutes_ago: 0, note: "" }], too_late: 0 });
    expect(JSON.stringify(list)).not.toContain(ref);
    expect(JSON.stringify(game.adminStatus())).not.toContain(ref);

    const other = ref.startsWith("Z") ? `Y${ref.slice(1)}` : `Z${ref.slice(1)}`;
    expect(() => game.adminConfirm("ana@example.org", other)).toThrow(/No pending request matches/);
    expect(() => game.adminConfirm("bo@example.org", ref)).toThrow(/No pending request matches/);
    expect(() => game.adminConfirm("ana@example.org", "K7Q4")).toThrow(/six letters and digits/);
    expect(() => game.adminConfirm("ana@example.org", "")).toThrow(/six letters and digits/);
    expect(game.status("t1").you).toBeNull();
    expect(game.adminConfirm(" ANA@example.org ", ref)).toBe("Ana");
    expect(game.adminPending().requests).toEqual([]);
    expect(() => game.adminConfirm("ana@example.org", ref)).toThrow(/No pending request matches/);
  });

  test("the reference survives being read out: case, dashes, and O, I, L for 0, 1, 1", async () => {
    const digits = [0, 1, 0, 1, 10, 11]; // "0101AB"
    const { game, ask } = setup({ rand: (n) => (n === 32 ? digits.shift()! : 7) });
    const reply = await ask("t1", "Ana", "ana@example.org");
    expect(reply.request_ref).toBe("0101AB");
    expect(game.adminConfirm("ana@example.org", " oIo-L ab ")).toBe("Ana");
  });

  test("a request filed by someone else under a player's address cannot be confirmed", async () => {
    const { game, ask, said, signUp, wait } = setup({ minPlayers: 3 });
    await signUp("a", "Ana", "ana@example.org");
    await signUp("b", "Bo", "bo@example.org");
    await signUp("c", "Cy", "cy@example.org");
    game.draw();
    const anaGives = game.myAssignment("a");
    wait(61_000);

    // Someone with the invite code asks under Ana's address. Only they see their reference.
    const intruderRef = (await ask("intruder", "Ana", "ana@example.org")).request_ref;
    // Ana, who really lost her token, asks inside the same minute. No mail goes out, but she is recorded.
    const anaRef = refIn(await said("a-new", "Ana", "ana@example.org"));
    expect(anaRef).not.toBe(intruderRef);
    const { requests } = game.adminPending();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.note).toMatch(/2 installations asked.*already plays as Ana.*--rebind/);

    // The host has Ana's reference, from Ana. Without --rebind nothing moves.
    expect(() => game.adminConfirm("ana@example.org", anaRef)).toThrow(/already plays as Ana.*--rebind/s);
    expect(game.myAssignment("a")).toEqual(anaGives);
    expect(game.adminConfirm("ana@example.org", anaRef, { rebind: true })).toBe("Ana");
    expect(game.myAssignment("a-new")).toEqual(anaGives);
    expect(() => game.myAssignment("intruder")).toThrow(/not joined/);
    expect(() => game.myAssignment("a")).toThrow(/not joined/);
    // Both requests for the address are gone, the intruder's too.
    expect(game.adminPending().requests).toEqual([]);
  });

  test("if the owner's request was never recorded, the other one still cannot be confirmed", async () => {
    const { game, ask, said, signUp, wait } = setup({ minPlayers: 3 });
    await signUp("a", "Ana", "ana@example.org");
    await signUp("b", "Bo", "bo@example.org");
    await signUp("c", "Cy", "cy@example.org");
    game.draw();
    wait(61_000);
    await ask("intruder", "Ana", "ana@example.org");
    // Ana's own request is refused for a reason that has nothing to do with the address. She gets no reference.
    const anaSaw = await said("a-new", "Ana", "ana@example.org", 5);
    expect(anaSaw).toMatch(/at least 20/);
    expect(anaSaw).not.toMatch(/reference/);
    // The host sees one request for her address, and has nothing from Ana to type. Guessing does not help.
    expect(game.adminPending().requests).toHaveLength(1);
    for (const guess of ["000000", "ZZZZZZ", "K7Q42M"]) {
      expect(() => game.adminConfirm("ana@example.org", guess, { rebind: true })).toThrow(/No pending request matches/);
    }
    expect(() => game.myAssignment("intruder")).toThrow(/not joined/);
  });

  test("a request that changes its address gets a new reference, so an approval cannot be redirected", async () => {
    const { game, ask, signUp, wait } = setup();
    await signUp("b", "Bo", "bo@example.org");
    const own = (await ask("t", "Tom", "tom@example.org")).request_ref; // Tom gives the host this, honestly
    wait(61_000);
    const moved = (await ask("t", "Tom", "bo@example.org")).request_ref; // then points the request at Bo's address
    expect(moved).not.toBe(own);
    expect(() => game.adminConfirm("tom@example.org", own)).toThrow(/No pending request matches/);
    expect(() => game.adminConfirm("bo@example.org", own, { rebind: true })).toThrow(/No pending request matches/);
    expect(game.status("b").you).toBe("Bo");
    expect(game.status("t").you).toBeNull();
  });

  test("reject clears an address's requests and its mail limits; --all clears everything", async () => {
    const { game, sent, ask, said } = setup();
    await ask("t1", "Ana", "ana@example.org");
    expect(await said("t1", "Ana", "ana@example.org")).toMatch(/less than a minute/);
    expect(() => game.adminReject("ana@exmaple.org")).toThrow(/Nothing is pending/);
    expect(game.adminReject(" ANA@example.org ")).toBe(1);
    expect(game.adminPending().requests).toEqual([]);
    expect((await ask("t1", "Ana", "ana@example.org")).confirmation_sent).toBe(true); // at once: the cooldown went too
    expect(sent).toHaveLength(2);
    await ask("t2", "Bo", "bo@example.org");
    expect(game.adminReject(null)).toBe(2);
    expect(game.adminReject(null)).toBe(0);
  });

  test("a request outlives its code and stays for seven days; the host commands tidy up by themselves", async () => {
    const { game, ask, lastCode, wait } = setup();
    const ref = (await ask("t1", "Ana", "ana@example.org")).request_ref;
    wait(20 * 60_000);
    expect(() => game.confirm("t1", lastCode())).toThrow(/no longer valid/);
    expect(game.adminPending().requests.map((r) => [r.email, r.minutes_ago])).toEqual([["ana@example.org", 20]]);
    wait(6 * 24 * 3600_000);
    expect(game.adminPending().requests).toHaveLength(1);
    wait(2 * 24 * 3600_000);
    expect(game.adminPending().requests).toEqual([]);
    expect(() => game.adminConfirm("ana@example.org", ref)).toThrow(/No pending request matches/);
    // Asking again brings it back, with a new reference.
    expect((await ask("t1", "Ana", "ana@example.org")).request_ref).not.toBe(ref);
  });
});

describe("after the draw", () => {
  async function drawn(opts: GameOptions = {}) {
    const s = setup({ minPlayers: 3, rand: (n) => (n === 1_000_000 ? 123456 : Math.floor(Math.random() * n)), ...opts });
    // Confirmed by hand, so this works whatever the mailer of the test does.
    for (const [t, n] of [["a", "Ana"], ["b", "Bo"], ["c", "Cy"]] as const) {
      const ref = refIn(await s.said(t, n, `${n.toLowerCase()}@example.org`));
      s.game.adminConfirm(`${n.toLowerCase()}@example.org`, ref);
    }
    s.game.draw();
    s.wait(24 * 3600_000);
    return s;
  }
  const blank = (text: string) => text.replace(/(reference: |"request_ref":")[0-9A-Z]{6}/g, "$1REF");

  /** Everything a caller can see when asking for an address and then trying codes. */
  async function transcript(s: Awaited<ReturnType<typeof drawn>>, email: string): Promise<string[]> {
    const tok = `probe ${email}`;
    const out: string[] = [];
    const tryCode = () => {
      try {
        out.push(JSON.stringify(s.game.confirm(tok, "000000")));
      } catch (e) {
        out.push(`error: ${(e as Error).message}`);
      }
    };
    out.push(await s.said(tok, "Probe", email));
    out.push(await s.said(tok, "Probe", email)); // inside the cooldown
    for (let i = 0; i < 6; i++) tryCode();
    s.wait(61_000);
    out.push(await s.said(tok, "Probe", email));
    tryCode();
    s.wait(16 * 60_000);
    tryCode();
    for (let i = 0; i < 5; i++) {
      out.push(await s.said(tok, "Probe", email)); // runs into the per-address limit
      s.wait(61_000);
    }
    return out.map(blank);
  }

  test("nothing a caller sees depends on whether the address plays", async () => {
    for (const mailer of [undefined, mailDown]) {
      const s = await drawn(mailer ? { mailer } : {});
      const plays = await transcript(s, "ana@example.org");
      const unknown = await transcript(s, "nobody@example.org");
      expect(plays).toEqual(unknown);
      // The transcript really went through every kind of answer.
      const all = plays.join("\n");
      for (const part of ["confirmation_sent", "less than a minute", "4 tries left", "0 tries left", "no longer valid", "Too many codes"]) {
        expect(all).toContain(part);
      }
    }
  });

  test("the reply does not wait for the mail, so its speed says nothing either; in the lobby it does wait", async () => {
    let release = () => {};
    let hang = false;
    // Sends at once until told to hang; then a mail stays in flight until release() is called.
    const never = () => (hang ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve());
    const s = await drawn({ mailer: never });
    hang = true;
    const settled = async (p: Promise<unknown>) => {
      let done = false;
      void p.then(
        () => (done = true),
        () => (done = true),
      );
      await new Promise((r) => setTimeout(r, 15));
      return done;
    };
    expect(await settled(s.ask("x", "X", "ana@example.org"))).toBe(true); // plays: mail goes out behind the reply
    expect(await settled(s.ask("y", "Y", "nobody@example.org"))).toBe(true);
    release();

    const lobby = setup({ mailer: never });
    const pending = lobby.ask("t1", "Ana", "ana@example.org");
    expect(await settled(pending)).toBe(false);
    release();
    expect((await pending).confirmation_sent).toBe(true);
  });

  test("a mail failure behind the reply is logged and nothing else", async () => {
    const s = await drawn({ mailer: mailDown });
    s.logs.length = 0;
    expect((await s.ask("x", "X", "ana@example.org")).confirmation_sent).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(s.logs).toEqual(["mail failed 0/-"]);
    // A mailer that throws before returning a promise is handled the same way.
    const t = await drawn({
      mailer: (() => {
        throw new MailError(500, 10002);
      }) as never,
    });
    t.logs.length = 0;
    expect((await t.ask("x", "X", "bo@example.org")).confirmation_sent).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.logs).toEqual(["mail failed 500/10002"]);
  });

  test("a late request cannot join, is kept off the host's list, and is only counted", async () => {
    const s = await drawn();
    const ref = (await s.ask("late", "Late", "late@example.org")).request_ref;
    expect(s.sent.filter((m) => m.to === "late@example.org")).toEqual([]);
    expect(s.game.adminPending()).toEqual({ requests: [], too_late: 1 });
    expect(s.game.adminStatus().pending_confirmations).toBe(0);
    expect(() => s.game.adminConfirm("late@example.org", ref)).toThrow(/Joining is closed/);
    expect(s.game.adminStatus().players).toEqual(["Ana", "Bo", "Cy"]);
  });

  test("a request left over from the lobby cannot slip in after the draw", async () => {
    const s = setup({ minPlayers: 3 });
    await s.signUp("a", "Ana", "ana@example.org");
    await s.signUp("b", "Bo", "bo@example.org");
    await s.signUp("c", "Cy", "cy@example.org");
    const ref = (await s.ask("d", "Di", "di@example.org")).request_ref;
    const code = s.lastCode();
    s.game.draw();
    expect(() => s.game.confirm("d", code)).toThrow(/Joining is closed/);
    expect(() => s.game.adminConfirm("di@example.org", ref)).toThrow(/Joining is closed/);
    expect(s.game.adminPending()).toEqual({ requests: [], too_late: 1 });
    expect(s.game.adminStatus().players).toEqual(["Ana", "Bo", "Cy"]);
  });
});

describe("privacy", () => {
  test("no player-facing output contains an email address or a reference", async () => {
    const { game, ask, signUp } = setup({ minPlayers: 3 });
    await signUp("t1", "Ana", "ana@example.org");
    await signUp("t2", "Bo", "bo@example.org");
    await signUp("t3", "Cy", "cy@example.org");
    const ref = (await ask("t4", "Di", "di@example.org")).request_ref;
    game.draw();
    game.postHint("t1", "It hums.");
    game.ask("t1", "Tea?");
    game.openReveal();
    const out = JSON.stringify([game.status("t2"), game.inbox("t2"), game.feed("t2", "today"), game.reveal("t2"), game.status("t4")]);
    expect(out).not.toContain("@");
    expect(out).not.toContain(ref);
    expect(JSON.stringify(game.adminStatus())).not.toContain("@");
  });

  test("someone who has not joined sees how many play, not who", async () => {
    const { game, signUp } = setup();
    await signUp("t1", "Ana", "ana@example.org");
    await signUp("t2", "Bo", "bo@example.org");
    const outside = game.status("some-new-token");
    expect(outside).toEqual({ phase: "lobby", player_count: 2, you: null, your_budget: null, min_budget: 20, currency: "EUR" });
    expect(JSON.stringify(outside)).not.toMatch(/Ana|Bo/);
    expect(game.status("t1")).toMatchObject({ you: "Ana", players: ["Ana", "Bo"], player_count: 2 });
  });
});

/** Every byte SQLite keeps for a database: the file and its write-ahead log. */
function onDisk(path: string): string {
  return [path, `${path}-wal`].filter(existsSync).map((f) => readFileSync(f).toString("latin1")).join("");
}

describe("addresses at rest", () => {
  test("a player's address is kept as a fingerprint, the mail log too; only a waiting request holds it readable", async () => {
    const { game, db, ask, signUp } = setup();
    await signUp("t1", "Ana", "ana@example.org");
    await ask("t2", "Bo", "bo@example.org");
    const dump = (table: string) => JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
    expect(dump("players")).not.toContain("@");
    expect(dump("mail_log")).not.toContain("@");
    expect(dump("players")).toMatch(/"email_fp":"[0-9a-f]{64}"/);
    expect(dump("registrations")).toContain("bo@example.org");
    expect(dump("registrations")).not.toContain("ana@example.org");
    // The fingerprint still does its job: the address is recognised when it comes back.
    expect(game.adminPending().requests[0]!.note).toBe("");
    await ask("t3", "Ana again", "ana@example.org").catch(() => {});
    expect(game.adminPending().requests.find((r) => r.email === "ana@example.org")!.note).toMatch(/already plays as Ana/);
  });

  test("once a request is confirmed, its address is gone from the file itself", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "santa-")), "s.db");
    const db = new Database(path);
    const sent: string[] = [];
    const game = new Game(db, { inviteCode: INVITE, mailer: async (_to, code) => void sent.push(code) });
    await game.requestJoin("t1", "Ana", 20, "ana.unique.marker@example.org", INVITE);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(onDisk(path)).toContain("ana.unique.marker@example.org");
    game.confirm("t1", sent[0]!);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(onDisk(path)).not.toContain("ana.unique.marker");
    expect(game.status("t1").you).toBe("Ana");
  });

  test("two connections to one file agree on the fingerprints", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "santa-")), "s.db");
    const sent: string[] = [];
    const opts = { inviteCode: INVITE, mailer: async (_to: string, code: string) => void sent.push(code) };
    const server = new Game(new Database(path), opts);
    const admin = new Game(new Database(path), opts); // as the admin command does
    await server.requestJoin("t1", "Ana", 20, "ana@example.org", INVITE);
    server.confirm("t1", sent[0]!);
    const ref = (await server.requestJoin("t2", "X", 20, "ana@example.org", INVITE).catch((e: Error) => ({ request_ref: refIn(e.message) }))).request_ref;
    expect(admin.adminPending().requests[0]!.note).toMatch(/already plays as Ana/);
    expect(() => admin.adminConfirm("ana@example.org", ref)).toThrow(/already plays as Ana/);
  });
});

describe("databases made by earlier versions", () => {
  test("from before email confirmation", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
             token_hash TEXT NOT NULL UNIQUE, budget REAL NOT NULL);
             INSERT INTO players (name, name_key, token_hash, budget) VALUES ('Old', 'old', 'old-token', 20);`);
    const game = new Game(db);
    expect(game.status("old-token").you).toBe("Old");
    expect(game.join("t2", "New", 20).joined_as).toBe("New");
    new Game(db); // opening twice is fine
  });

  test("from the version that confirmed by address alone", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "santa-")), "old.db");
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    const t0 = Date.parse("2026-12-01T10:00:00Z");
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('phase', 'lobby');
      CREATE TABLE players (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        token_hash TEXT NOT NULL UNIQUE, budget REAL NOT NULL, email TEXT);
      CREATE UNIQUE INDEX players_email ON players(email) WHERE email IS NOT NULL;
      INSERT INTO players (name, name_key, token_hash, budget, email) VALUES ('MAZA', 'maza', 'maza-token', 30, 'maza@example.org');
      CREATE TABLE registrations (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, budget REAL NOT NULL,
        code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
      INSERT INTO registrations VALUES ('waiting-token', 'ana@example.org', 'Ana', 25, 'abc', ${t0 + 15 * 60_000}, 0);
      CREATE TABLE mail_log (email TEXT NOT NULL, sent_at INTEGER NOT NULL);
      INSERT INTO mail_log VALUES ('ana@example.org', ${t0});
      CREATE TABLE join_attempts (email TEXT NOT NULL, token_hash TEXT NOT NULL, at INTEGER NOT NULL);
      INSERT INTO join_attempts VALUES ('ana@example.org', 'waiting-token', ${t0});
    `);
    let t = t0 + 5 * 60_000;
    const sent: string[] = [];
    const open = () => new Game(db, { now: () => new Date(t), inviteCode: INVITE, mailer: async (_to, code) => void sent.push(code) });
    const game = open();
    open(); // a second start changes nothing more

    expect(game.status("maza-token")).toMatchObject({ you: "MAZA", your_budget: 30 });
    // The player's address was readable in the old file. Now it is a fingerprint, and the old bytes are gone too.
    expect(JSON.stringify(db.query("SELECT * FROM players").all())).not.toContain("@");
    expect(JSON.stringify(db.query("SELECT * FROM mail_log").all())).not.toContain("@");
    expect(onDisk(path)).not.toContain("maza@example.org");
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'join_attempts'").get()).toBeNull();
    // The request that was waiting is still there, five minutes old, and now has a reference.
    expect(game.adminPending().requests).toEqual([{ email: "ana@example.org", requested_name: "Ana", minutes_ago: 5, note: "" }]);
    const row = db.query("SELECT ref FROM registrations").get() as { ref: string };
    expect(row.ref).toMatch(REF);
    // The player learns it by asking again; the same address keeps the same reference.
    const reply = await game.requestJoin("waiting-token", "Ana", 25, "ana@example.org", INVITE);
    expect(reply.request_ref).toBe(row.ref);
    expect(game.adminConfirm("ana@example.org", reply.request_ref)).toBe("Ana");
    // The player from before is still tied to their address: a new installation takes them over, it does not add a second player.
    t += 61_000;
    await game.requestJoin("maza-new", "Whatever", 20, "maza@example.org", INVITE);
    expect(game.confirm("maza-new", sent.at(-1)!).joined_as).toBe("MAZA");
    expect(game.adminStatus().players).toEqual(["Ana", "MAZA"]);
  });
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

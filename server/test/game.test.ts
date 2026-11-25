import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Game, GameError } from "../src/game.ts";

function setup(names = ["Ana", "Bogdan", "Carmen", "Dan"], opts = {}) {
  let day = "2026-12-01";
  const game = new Game(new Database(":memory:"), { now: () => new Date(`${day}T10:00:00Z`), ...opts });
  const tok = (n: string) => `hash-${n}`;
  for (const n of names) game.join(tok(n), n, 20);
  return { game, tok, setDay: (d: string) => (day = d) };
}

describe("lobby", () => {
  test("rejects duplicate names, bad names and double joins", () => {
    const { game } = setup();
    expect(() => game.join("x", "ana", 20)).toThrow(/taken/);
    expect(() => game.join("x", "<script>", 20)).toThrow(GameError);
    expect(() => game.join("hash-Ana", "Other", 20)).toThrow(/already joined/);
  });

  test("invite code is enforced when set", () => {
    const game = new Game(new Database(":memory:"), { inviteCode: "elf" });
    expect(() => game.join("a", "Ana", 20)).toThrow(/invite/);
    expect(game.join("a", "Ana", 20, "elf").joined_as).toBe("Ana");
  });

  test("nothing game-related works before the draw", () => {
    const { game, tok } = setup();
    expect(() => game.myAssignment(tok("Ana"))).toThrow(/draw has not happened/);
    expect(() => game.ask(tok("Ana"), "hi?")).toThrow(GameError);
    expect(() => game.feed(tok("Ana"))).toThrow(GameError);
  });
});

describe("budget", () => {
  test("has a configurable minimum, no upper limit, and stays private", () => {
    const game = new Game(new Database(":memory:"), { minBudget: 30, currency: "RON" });
    expect(() => game.join("a", "Ana", 29.99)).toThrow(/at least 30 RON/);
    expect(() => game.join("a", "Ana", Number.NaN)).toThrow(/must be a number/);
    expect(game.join("a", "Ana", 5_000_000).your_budget).toBe(5_000_000);
    game.join("b", "Bogdan", 30);
    expect(game.status("b")).toMatchObject({ your_budget: 30, min_budget: 30, currency: "RON" });
    expect(JSON.stringify(game.status("b"))).not.toContain("5000000");
    expect(() => game.setBudget("b", 10)).toThrow(/at least 30/);
    expect(game.setBudget("b", 45.5).your_budget).toBe(45.5);
  });

  test("default minimum is 20 EUR", () => {
    const { game } = setup();
    expect(() => game.join("x", "Zed", 19)).toThrow(/at least 20 EUR/);
  });
});

describe("draw", () => {
  test("needs four players by default", () => {
    const { game } = setup(["Ana", "Bogdan", "Carmen"]);
    expect(() => game.draw()).toThrow(/At least 4/);
  });

  test("a player can be removed in the lobby only", () => {
    const { game } = setup();
    game.removePlayer("ana");
    expect(game.join("new-token", "Ana", 20).joined_as).toBe("Ana");
    expect(() => game.removePlayer("Nobody")).toThrow(/has joined/);
    game.draw();
    expect(() => game.removePlayer("Ana")).toThrow(/before the draw/);
  });

  test("is a derangement, every time", () => {
    for (let run = 0; run < 200; run++) {
      const names = ["Ana", "Bogdan", "Carmen", "Dan", "Ema"].slice(0, 3 + (run % 3));
      const { game, tok } = setup(names, { minPlayers: 3 });
      game.draw();
      const receivers = names.map((n) => game.myAssignment(tok(n)).you_give_to);
      names.forEach((n, i) => expect(receivers[i]).not.toBe(n));
      expect([...receivers].sort()).toEqual([...names].sort());
    }
  });

  test("works for 100 players, and status stays small", () => {
    const names = Array.from({ length: 100 }, (_, i) => `Player ${i + 1}`);
    const { game, tok } = setup(names);
    expect(game.draw()).toEqual({ players: 100 });
    const receivers = names.map((n) => game.myAssignment(tok(n)).you_give_to);
    names.forEach((n, i) => expect(receivers[i]).not.toBe(n));
    expect(new Set(receivers).size).toBe(100);
    for (const n of names) game.postHint(tok(n), "A hint of the full two hundred characters. ".repeat(4));
    expect(game.feed(tok(names[0]!)).hints).toHaveLength(1);
    expect(game.feed(tok(names[0]!), "today").hints).toHaveLength(100);
    expect(JSON.stringify(game.status(tok(names[0]!))).length).toBeLessThan(2500);
  });

  test("happens once, closes joining, and returns no mapping", () => {
    const { game } = setup();
    expect(game.draw()).toEqual({ players: 4 });
    expect(() => game.draw()).toThrow(/already happened/);
    expect(() => game.join("late", "Late", 20)).toThrow(/closed/);
    expect(JSON.stringify(game.adminStatus())).not.toMatch(/giver|receiver|you_give_to/);
  });

  test("survives a restart on the same database", () => {
    const db = new Database(":memory:");
    const a = new Game(db, { minPlayers: 3 });
    ["Ana", "Bogdan", "Carmen"].forEach((n) => a.join(`h-${n}`, n, 20));
    a.draw();
    const before = a.myAssignment("h-Ana");
    const b = new Game(db);
    expect(b.phase()).toBe("playing");
    expect(b.myAssignment("h-Ana")).toEqual(before);
  });
});

describe("playing", () => {
  // Fixed rand gives a known cycle, so tests can name giver and receiver.
  function drawn() {
    const s = setup(["Ana", "Bogdan", "Carmen"], { minPlayers: 3 });
    s.game.draw();
    const to = (n: string) => s.game.myAssignment(s.tok(n)).you_give_to;
    return { ...s, to };
  }

  test("unknown tokens get nothing", () => {
    const { game } = drawn();
    for (const call of [
      () => game.myAssignment("stranger"),
      () => game.inbox("stranger"),
      () => game.feed("stranger"),
      () => game.ask("stranger", "q?"),
      () => game.reveal("stranger"),
    ]) {
      expect(call).toThrow(/not joined/);
    }
    const outside = game.status("stranger");
    expect(outside.you).toBeNull();
    expect(outside.player_count).toBe(3);
    expect("players" in outside).toBe(false);
  });

  test("question goes to the receiver only, with no trace of the asker", () => {
    const { game, tok, to } = drawn();
    const receiver = to("Ana");
    const other = ["Bogdan", "Carmen"].find((n) => n !== receiver)!;
    game.ask(tok("Ana"), "Tea or coffee?");
    const inbox = game.inbox(tok(receiver));
    expect(inbox.questions_for_you).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toContain("Ana");
    expect(Object.keys(inbox.questions_for_you[0] as object).sort()).toEqual(["question", "question_id"]);
    expect(game.inbox(tok(other)).questions_for_you).toHaveLength(0);
    expect(JSON.stringify(game.status(tok(receiver)))).not.toMatch(/giver|santa/i);
  });

  test("only the addressee can answer, once; the asker sees the reply", () => {
    const { game, tok, to } = drawn();
    const receiver = to("Ana");
    const other = ["Bogdan", "Carmen"].find((n) => n !== receiver)!;
    game.ask(tok("Ana"), "Tea or coffee?");
    const id = (game.inbox(tok(receiver)).questions_for_you[0] as { question_id: number }).question_id;
    expect(() => game.answer(tok(other), id, "Tea")).toThrow(/No open question/);
    expect(() => game.answer(tok("Ana"), id, "Tea")).toThrow(/No open question/);
    game.answer(tok(receiver), id, "Tea, always");
    expect(() => game.answer(tok(receiver), id, "Coffee")).toThrow(/No open question/);
    expect(game.inbox(tok("Ana")).replies_to_your_questions).toEqual([{ question: "Tea or coffee?", answer: "Tea, always" }]);
    expect(game.inbox(tok(other)).replies_to_your_questions).toHaveLength(0);
  });

  test("questions and hints that name their author are refused; limits hold", () => {
    const { game, tok } = drawn();
    expect(() => game.ask(tok("Ana"), "This is ANA asking, what do you like?")).toThrow(/own name/);
    expect(() => game.postHint(tok("Ana"), "From ana with love")).toThrow(/own name/);
    game.ask(tok("Ana"), "Do you like bananas?"); // "ana" inside a word is fine
    for (let i = 0; i < 4; i++) game.ask(tok("Ana"), `q${i}?`);
    expect(() => game.ask(tok("Ana"), "one more?")).toThrow(/used all 5/);
    expect(() => game.ask(tok("Bogdan"), "x".repeat(301))).toThrow(/too long/);
    expect(() => game.ask(tok("Bogdan"), " \n ")).toThrow(/empty/);
  });

  test("one hint per day, shown by receiver and never by giver", () => {
    const { game, tok, to, setDay } = drawn();
    game.postHint(tok("Ana"), "It hums.");
    expect(() => game.postHint(tok("Ana"), "It also glows.")).toThrow(/already posted/);
    setDay("2026-12-02");
    game.postHint(tok("Ana"), "It also glows.");
    expect(game.feed(tok("Ana")).hints).toHaveLength(0);
    expect(game.feed(tok("Bogdan"), "today").hints).toHaveLength(1);
    const feed = game.feed(tok(to("Ana")));
    expect(feed.hints).toEqual([
      { day: "2026-12-01", hint_for: to("Ana"), hint: "It hums." },
      { day: "2026-12-02", hint_for: to("Ana"), hint: "It also glows." },
    ]);
  });

  test("guess rules and reveal gating", () => {
    const { game, tok, to } = drawn();
    expect(() => game.guess(tok("Ana"), "Ana")).toThrow(/own Santa/);
    expect(() => game.guess(tok("Ana"), "Nobody")).toThrow(/is playing/);
    expect(() => game.reveal(tok("Ana"))).toThrow(/not open/);
    const santaOf = (n: string) => ["Ana", "Bogdan", "Carmen"].find((g) => to(g) === n)!;
    game.guess(tok("Ana"), "bogdan");
    game.guess(tok("Ana"), santaOf("Ana")); // change of mind
    game.openReveal();
    const r = game.reveal(tok("Ana"));
    expect(r.your_santa).toBe(santaOf("Ana"));
    expect(r.pairs).toHaveLength(3);
    expect(r.pairs.find((p) => p.receiver === "Ana")!.guessed_right).toBe(true);
    expect(r.pairs.filter((p) => p.receiver !== "Ana").every((p) => !p.guessed_right)).toBe(true);
    expect(() => game.ask(tok("Ana"), "late?")).toThrow(/game is over/);
  });
});

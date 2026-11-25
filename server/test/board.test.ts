import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BOARD_REFRESH_MS, daysAway, renderBoard } from "../src/board.ts";
import { boardSettings } from "../src/config.ts";
import { Game } from "../src/game.ts";
import { createHandler } from "../src/server.ts";

const settings = { joinBy: "2026-12-05", drawOn: "2026-12-06", revealOn: "2026-12-18", minBudget: 20, currency: "EUR" };

function world() {
  let t = Date.parse("2026-12-01T10:00:00Z");
  const game = new Game(new Database(":memory:"), { now: () => new Date(t), minPlayers: 3 });
  const names = ["Ana Maria", "Bogdan", "Ștefan"];
  for (const n of names) game.join(`tok-${n}`, n, 20);
  const handler = createHandler(game, () => {}, { board: settings, now: () => new Date(t) });
  const get = async (path = "/board") => handler(new Request(`http://x${path}`));
  return { game, names, get, wait: (ms: number) => (t += ms) };
}

test("the board shows the phase, the numbers and the dates, and never who or what", async () => {
  const { game, names, get, wait } = world();
  let page = await (await get()).text();
  expect(page).toContain('<li class="now" aria-current="step"><span class="dot"></span>Joining</li>');
  expect(page).toContain('<div class="value">3</div><div class="label">players</div>');
  expect(page).not.toContain("questions asked"); // nothing to count before the draw
  expect(page).toContain("5 December 2026");
  expect(page).toContain("in 4 days");
  expect(page).toContain("from 20 EUR upwards");

  game.draw();
  const giver = "tok-Bogdan";
  const receiver = `tok-${game.myAssignment(giver).you_give_to}`;
  game.ask(giver, "Tea or coffee? SECRETQUESTION");
  game.answer(receiver, (game.inbox(receiver).questions_for_you[0] as { question_id: number }).question_id, "SECRETANSWER");
  game.ask(giver, "Second one?");
  game.postHint(giver, "It hums. SECRETHINT");
  game.guess(receiver, "Bogdan");
  wait(BOARD_REFRESH_MS);
  page = await (await get()).text();
  expect(page).toContain('<li class="now" aria-current="step"><span class="dot"></span>Playing</li>');
  expect(page).toContain('<div class="value">2</div><div class="label">questions asked</div><div class="note">1 answered</div>');
  expect(page).toContain('<div class="value">1</div><div class="label">hints posted</div>');
  expect(page).toContain('<div class="value">1</div><div class="label">guesses made</div><div class="note">of 3 players</div>');
  for (const secret of [...names, "Ana", "tefan", "SECRET", "Tea or coffee", "It hums", "tok-"]) expect(page).not.toContain(secret);
  expect(page).not.toMatch(/[\w.]+@[\w-]+\.\w+/); // nothing shaped like an address
  expect(JSON.stringify(game.boardCounts())).toBe('{"phase":"playing","players":3,"questions":2,"answers":1,"hints":1,"guesses":1}');
});

test("the numbers are a snapshot, renewed only every five minutes", async () => {
  const { game, get, wait } = world();
  const first = await (await get()).text();
  game.join("tok-late", "Dan", 20);
  wait(BOARD_REFRESH_MS - 1000);
  expect(await (await get()).text()).toBe(first); // same numbers, same time stamp
  wait(1000);
  const next = await (await get()).text();
  expect(next).toContain('<div class="value">4</div><div class="label">players</div>');
  expect(next).toContain("10:05 UTC");
});

test("the page is plain: no script, nothing from other sites, and headers that keep it that way", async () => {
  const { get } = world();
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const page = await res.text();
  expect(page).not.toMatch(/<script|<img|<link|<iframe|url\(|@import/i);
  expect((await get("/")).status).toBe(200);
  expect(await (await get("/")).text()).toContain('href="/board"');
  // Only GET, and only when the host's settings were given.
  const bare = createHandler(new Game(new Database(":memory:")));
  expect((await bare(new Request("http://x/board"))).status).toBe(404);
});

test("dates: wording, missing dates, and settings that are not dates", () => {
  const now = new Date("2026-12-05T23:30:00Z");
  expect(["2026-12-04", "2026-12-05", "2026-12-06", "2026-12-18"].map((d) => daysAway(d, now))).toEqual(["passed", "today", "tomorrow", "in 13 days"]);
  const counts = { phase: "revealed" as const, players: 1, questions: 0, answers: 0, hints: 0, guesses: 0 };
  const bare = renderBoard(counts, { minBudget: 20, currency: "<b>&" }, now);
  expect(bare).toContain("The host has not announced the dates yet.");
  expect(bare).toContain("&lt;b&gt;&amp;");
  expect(bare).toContain('<div class="label">player</div>');
  expect(boardSettings({ SANTA_REVEAL_ON: "2026-12-18", SANTA_MIN_BUDGET: "25" })).toEqual({
    joinBy: undefined,
    drawOn: undefined,
    revealOn: "2026-12-18",
    minBudget: 25,
    currency: "EUR",
  });
  for (const bad of ["18.12.2026", "2026-13-40", "soon"]) expect(() => boardSettings({ SANTA_DRAW_ON: bad })).toThrow(/SANTA_DRAW_ON must be a date/);
});

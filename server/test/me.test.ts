// A player's own web page: who may open it, for how long, and what it holds.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { publicUrl } from "../src/config.ts";
import { Game } from "../src/game.ts";
import { createHandler } from "../src/server.ts";

const BASE = "https://santa.example.org";
const settings = { revealOn: "2026-12-18", minBudget: 20, currency: "EUR" };

function world() {
  let t = Date.parse("2026-12-01T10:00:00Z");
  const sent: string[] = [];
  const logs: string[] = [];
  const game = new Game(new Database(":memory:"), {
    now: () => new Date(t),
    minPlayers: 3,
    inviteCode: "elf",
    mailer: async (_to, code) => void sent.push(code),
  });
  const handler = createHandler(game, (l) => logs.push(l), { board: settings, publicUrl: BASE, now: () => new Date(t) });
  const wait = (ms: number) => (t += ms);
  const join = async (token: string, name: string) => {
    await game.requestJoin(token, name, 20, `${name.toLowerCase().replace(/[^a-z]/g, "")}@example.org`, "elf");
    wait(61_000);
    game.confirm(token, sent.at(-1)!);
  };
  /** What a browser does. Cookies are kept by hand, as a browser would keep them. */
  const browser = () => {
    let cookie = "";
    const send = async (method: string, path: string, form?: Record<string, string>) => {
      const res = await handler(
        new Request(`${BASE}${path}`, {
          method,
          headers: { ...(cookie ? { cookie } : {}), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
          body: form ? new URLSearchParams(form).toString() : undefined,
        }),
      );
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.includes("Max-Age=0") ? "" : set.split(";")[0]!;
      return { status: res.status, headers: res.headers, text: await res.text() };
    };
    const open = async (link: string) => {
      const ticket = new URL(link).searchParams.get("t")!;
      const posted = await send("POST", "/me", { t: ticket });
      return posted.status === 303 ? send("GET", posted.headers.get("location")!) : posted;
    };
    return { send, open, setCookie: (c: string) => (cookie = c), cookie: () => cookie };
  };
  const link = (token: string) => `${BASE}/me?t=${game.issuePageTicket(token)}`;
  return { game, handler, logs, wait, join, browser, link };
}

async function threePlaying() {
  const w = world();
  await w.join("tok-a", "Ana");
  await w.join("tok-b", "Bo");
  await w.join("tok-c", "Cy");
  w.game.draw();
  const gives = (t: string) => w.game.myAssignment(t).you_give_to;
  const tokenOf: Record<string, string> = { Ana: "tok-a", Bo: "tok-b", Cy: "tok-c" };
  const santaOf = (name: string) => Object.keys(tokenOf).find((n) => gives(tokenOf[n]!) === name)!;
  return { ...w, gives, tokenOf, santaOf };
}

test("only a player gets a link, and only when the host has set the public address", async () => {
  const w = world();
  await w.join("tok-a", "Ana");
  expect(() => w.game.issuePageTicket("stranger")).toThrow(/not joined/);
  // Without a public address the route does not exist at all.
  const bare = createHandler(w.game, () => {}, { board: settings });
  expect((await bare(new Request(`${BASE}/me`))).status).toBe(404);
  expect(publicUrl({ SANTA_PUBLIC_URL: "https://santa.example.org/" })).toBe("https://santa.example.org");
  expect(publicUrl({})).toBeUndefined();
  for (const bad of ["http://santa.example.org", "https://santa.example.org/game", "santa.example.org", "https://a b"]) {
    expect(() => publicUrl({ SANTA_PUBLIC_URL: bad })).toThrow(/SANTA_PUBLIC_URL/);
  }
});

test("fetching the link uses nothing up; pressing the button opens the page, once", async () => {
  const w = await threePlaying();
  const link = w.link("tok-a");
  const b = w.browser();
  // A web filter, a chat preview or the player's first look: a button, and nothing about the game.
  for (let i = 0; i < 3; i++) {
    const gate = await b.send("GET", new URL(link).pathname + new URL(link).search);
    expect(gate.status).toBe(200);
    expect(gate.text).toContain("Open my page");
    expect(gate.text).not.toMatch(/Ana|Bo|Cy/);
  }
  const page = await b.open(link);
  expect(page.status).toBe(200);
  expect(page.text).toContain("Hello, Ana");
  expect(b.cookie()).toMatch(/^__Host-santa=\d+\.\d+\.[0-9a-f]{64}$/);
  // The same link in another browser: used.
  const second = await w.browser().open(link);
  expect(second.status).toBe(403);
  expect(second.text).toContain("already used or is too old");
  expect(second.text).not.toMatch(/Ana|Bo|Cy/);
  // A reload keeps working on the cookie alone.
  expect((await b.send("GET", "/me")).text).toContain("Hello, Ana");
});

test("a link expires after ten minutes, a newer link replaces an older one, and nonsense opens nothing", async () => {
  const w = await threePlaying();
  const old = w.link("tok-a");
  const newer = w.link("tok-a");
  expect((await w.browser().open(old)).status).toBe(403);
  w.wait(10 * 60_000 + 1);
  expect((await w.browser().open(newer)).status).toBe(403);
  for (const junk of ["", "spg_", "spg_" + "0".repeat(32), "x".repeat(500), "spg_' OR 1=1 --"]) {
    expect((await w.browser().send("POST", "/me", { t: junk })).status).toBe(403);
  }
  expect((await w.browser().send("GET", "/me")).status).toBe(401);
  expect((await w.browser().send("PUT", "/me")).status).toBe(405);
});

test("the session ends after eight hours, when it is tampered with, when the player recovers, and when they are removed", async () => {
  const w = await threePlaying();
  const b = w.browser();
  await b.open(w.link("tok-a"));
  const good = b.cookie();
  const [name, value] = [good.slice(0, good.indexOf("=")), good.slice(good.indexOf("=") + 1)];
  const [id, exp, sig] = value.split(".") as [string, string, string];

  const tryWith = async (v: string) => {
    const x = w.browser();
    x.setCookie(`${name}=${v}`);
    return (await x.send("GET", "/me")).status;
  };
  expect(await tryWith(value)).toBe(200);
  expect(await tryWith(`${Number(id) + 1}.${exp}.${sig}`)).toBe(401); // another player's id
  expect(await tryWith(`${id}.${Number(exp) + 1}.${sig}`)).toBe(401); // a longer life
  expect(await tryWith(`${id}.${exp}.${"0".repeat(64)}`)).toBe(401);
  expect(await tryWith("garbage")).toBe(401);

  // Ana recovers with a new installation: whoever held the old one, and its page, is out.
  w.wait(61_000);
  const ref = (await w.game.requestJoin("tok-a2", "Ana", 20, "ana@example.org", "elf")).request_ref;
  const unused = w.link("tok-a");
  w.game.adminConfirm("ana@example.org", ref, { rebind: true });
  expect(await tryWith(value)).toBe(401);
  expect((await w.browser().open(unused)).status).toBe(403); // a link the old installation had not used yet
  const fresh = w.browser();
  expect((await fresh.open(w.link("tok-a2"))).status).toBe(200);
  w.wait(8 * 3600_000 + 1);
  expect((await fresh.send("GET", "/me")).status).toBe(401);

  // Removal (lobby only) ends it too.
  const lobby = world();
  await lobby.join("tok-a", "Ana");
  const lb = lobby.browser();
  expect((await lb.open(lobby.link("tok-a"))).status).toBe(200);
  const waiting = lobby.link("tok-a");
  lobby.game.removePlayer("Ana");
  expect((await lb.send("GET", "/me")).status).toBe(401);
  expect((await lobby.browser().open(waiting)).status).toBe(403);
});

test("the page holds the hints about your gift and your guess, and none of the secrets", async () => {
  const w = await threePlaying();
  const me = "Ana";
  const santa = w.santaOf(me);
  const receiver = w.gives("tok-a");
  w.game.postHint(w.tokenOf[santa]!, "It hums. <script>alert(1)</script> & \"quotes\"");
  w.game.ask(w.tokenOf[santa]!, "SECRETQUESTION tea or coffee?");
  w.game.ask("tok-a", "MYQUESTION what do you like?");
  w.game.postHint("tok-a", "MYHINT about the gift I give");
  w.game.setBudget("tok-a", 77.5);
  w.game.guess("tok-a", santa === "Bo" ? "Cy" : "Bo");
  const b = w.browser();
  const page = await b.open(w.link("tok-a"));
  const text = page.text;

  expect(text).toContain("It hums. &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;");
  expect(text).not.toContain("<script");
  expect(text).toContain("Tuesday 1 December"); // the day of the hint, not who or when
  expect(text).toContain(`You think your Santa is <strong>${santa === "Bo" ? "Cy" : "Bo"}</strong>`);
  expect(text).toContain("1 question from your Santa&#39;s agent waits for an answer");
  expect(text).toContain("Your agent can still ask 4 questions.");
  // The roster is there, but nothing ties a name to a role.
  for (const n of ["Ana", "Bo", "Cy"]) expect(text).toContain(`>${n}</li>`);
  for (const secret of ["SECRETQUESTION", "MYQUESTION", "MYHINT", "77.5", "@", "ana@example.org", "tok-a", "you give", "gives to", "You give"]) {
    if (secret === "@") expect(text).not.toMatch(/[\w.]+@[\w-]+\.\w+/);
    else expect(text).not.toContain(secret);
  }
  expect(JSON.stringify(w.game.playerPage(1))).not.toContain(receiver === "Ana" ? "never" : `"receiver"`);
  expect(Object.keys(w.game.playerPage(1)!).sort()).toEqual(["guess", "hints", "name", "open", "phase", "players", "reveal"]);
  // Before the reveal the page data names the Santa nowhere outside the roster.
  const data = w.game.playerPage(1)!;
  expect(data.reveal).toBeNull();
  expect(JSON.stringify(data.hints)).not.toContain(santa);
});

test("in the lobby the page shows who has joined; after the reveal, your Santa and the table", async () => {
  const lobby = world();
  await lobby.join("tok-a", "Ana");
  await lobby.join("tok-b", "Ștefan");
  const lobbyPage = (await lobby.browser().open(lobby.link("tok-a"))).text;
  expect(lobbyPage).toContain("Players are joining");
  expect(lobbyPage).toContain(">Ștefan</li>");
  expect(lobbyPage).not.toContain("Hints about your gift");
  expect(lobbyPage).toContain("18 December 2026");

  const w = await threePlaying();
  const santa = w.santaOf("Ana");
  w.game.guess("tok-a", santa);
  w.game.openReveal();
  const text = (await w.browser().open(w.link("tok-a"))).text;
  expect(text).toContain(`<span class="big">${santa}</span>`);
  expect(text).toContain("You guessed right.");
  expect(text).toContain("Who gave to whom");
  expect((text.match(/<tr><td>/g) ?? []).length).toBe(3);
  expect(text).toContain(`<td>${santa}</td><td>Ana</td><td class="right">${santa} ✓</td>`);
  expect(text).not.toContain("Still open");
});

test("everything under /me is private: not cached, not framed, not indexed, and the cookie is locked down", async () => {
  const w = await threePlaying();
  const link = w.link("tok-a");
  const b = w.browser();
  const ticket = new URL(link).searchParams.get("t")!;
  const responses = [
    await w.handler(new Request(link)),
    await w.handler(new Request(`${BASE}/me`, { method: "POST", body: `t=${ticket}`, headers: { "content-type": "application/x-www-form-urlencoded" } })),
    await w.handler(new Request(`${BASE}/me`)),
    await w.handler(new Request(`${BASE}/me`, { method: "POST", body: "t=nope" })),
    await w.handler(new Request(`${BASE}/me/leave`, { method: "POST" })),
    await w.handler(new Request(`${BASE}/me/anything`)),
  ];
  for (const r of responses) {
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  }
  const set = responses[1]!.headers.get("set-cookie")!;
  for (const part of ["__Host-santa=", "Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=28800"]) expect(set).toContain(part);
  expect(set).not.toContain("Domain");
  expect(responses[4]!.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(responses[4]!.status).toBe(303);
  void b;
  // The log says that a page was opened or refused, and never carries a ticket or a name.
  expect(w.logs.filter((l) => l.startsWith("page"))).toEqual(["page open ok", "page open refused"]);
  expect(w.logs.join()).not.toMatch(/spg_|Ana/);
});

test("the tool hands the link to its owner, and a link can never be relayed to other players", async () => {
  const w = await threePlaying();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: w.handler });
  const tokens: Record<string, string> = { Ana: "A".repeat(40), outsider: "Z".repeat(40) };
  // Give Ana a real token over HTTP by recovering her seat with it.
  const call = async (who: string, tool: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens[who]}` } } }));
    try {
      const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return r.isError ? `error: ${r.content[0]!.text}` : r.content[0]!.text;
    } finally {
      await client.close();
    }
  };
  try {
    w.wait(61_000);
    const joined = await call("Ana", "join", { name: "Ana", budget: 20, email: "ana@example.org", invite_code: "elf" });
    w.game.adminConfirm("ana@example.org", JSON.parse(joined).request_ref, { rebind: true });

    expect(await call("outsider", "my_page")).toMatch(/not joined/);
    const reply = JSON.parse(await call("Ana", "my_page"));
    expect(reply.link).toMatch(/^https:\/\/santa\.example\.org\/me\?t=spg_[0-9a-f]{32}$/);
    const ticket = new URL(reply.link).searchParams.get("t")!;
    for (const text of [reply.link, `look: ${ticket}`, ticket.split("").join(" "), ticket.toUpperCase().replace("_", "-")]) {
      expect(await call("Ana", "post_hint", { hint: text.slice(0, 200) })).toMatch(/contains a link to a player's page/);
      expect(await call("Ana", "ask", { question: text.slice(0, 300) })).toMatch(/contains a link to a player's page/);
    }
    expect(await call("Ana", "post_hint", { hint: "It is special, I promise." })).toContain('"posted": true');
    expect((await w.browser().open(reply.link)).status).toBe(200);
  } finally {
    server.stop(true);
  }
});

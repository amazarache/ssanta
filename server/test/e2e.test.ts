// Three players talk to the real HTTP server through the MCP client. No model involved.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Game } from "../src/game.ts";
import { createHandler } from "../src/server.ts";

let server: ReturnType<typeof Bun.serve>;
let game: Game;
const logs: string[] = [];
const names = ["Ana", "Bogdan", "Carmen"];
const tokens: Record<string, string> = Object.fromEntries(names.map((n) => [n, `${n}-token-`.padEnd(40, "x")]));

beforeAll(() => {
  game = new Game(new Database(":memory:"), { minPlayers: 3 });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHandler(game, (l) => logs.push(l)) });
});
afterAll(() => server.stop(true));

async function call(name: string, tool: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[name]}` } },
    }),
  );
  try {
    const res = (await client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = res.content[0]!.text;
    return res.isError ? { error: text } : JSON.parse(text);
  } finally {
    await client.close();
  }
}

test("without a valid token the server connects but every tool points to setup", async () => {
  expect((await fetch(`http://127.0.0.1:${server.port}/mcp`)).status).toBe(405);
  for (const bad of ["", "short"]) {
    tokens["NoToken"] = bad;
    for (const tool of ["status", "my_assignment", "feed", "reveal"]) {
      expect((await call("NoToken", tool)).error).toMatch(/santa-setup/);
    }
    expect((await call("NoToken", "join", { name: "Eve", budget: 20 })).error).toMatch(/santa-setup/);
  }
  expect(game.adminStatus().players).toEqual([]);
});

test("a full game over HTTP", async () => {
  for (const n of names) expect((await call(n, "join", { name: n, budget: 25 })).joined_as).toBe(n);
  expect((await call("Ana", "my_assignment")).error).toMatch(/draw has not happened/);

  game.draw();

  const gives: Record<string, string> = {};
  for (const n of names) gives[n] = (await call(n, "my_assignment")).you_give_to;
  const santaOf = (n: string) => names.find((g) => gives[g] === n)!;

  expect((await call("Ana", "ask", { question: "Sweet or savoury?" })).sent).toBe(true);
  const receiver = gives["Ana"]!;
  const inbox = await call(receiver, "inbox");
  expect(inbox.questions_for_you).toHaveLength(1);
  expect(JSON.stringify(inbox)).not.toContain("Ana");
  await call(receiver, "answer", { question_id: inbox.questions_for_you[0].question_id, answer: "Savoury." });
  expect((await call("Ana", "inbox")).replies_to_your_questions[0].answer).toBe("Savoury.");

  await call("Ana", "post_hint", { hint: "Crunchy, and legally a snack." });
  const feed = await call(receiver, "feed");
  expect(feed.hints).toEqual([{ day: feed.hints[0].day, hint_for: receiver, hint: "Crunchy, and legally a snack." }]);

  await call(receiver, "guess", { name: "Ana" });
  expect((await call(receiver, "reveal")).error).toMatch(/not open/);
  game.openReveal();
  const reveal = await call(receiver, "reveal");
  expect(reveal.your_santa).toBe(santaOf(receiver));
  expect(reveal.pairs.find((p: { receiver: string }) => p.receiver === receiver).guessed_right).toBe(true);

  // Log lines hold a tool name and an outcome, nothing else.
  expect(logs.length).toBeGreaterThan(10);
  for (const l of logs) expect(l).toMatch(/^[a-z_]+ (ok|refused [a-z_]+|failed)$/);
});

test("joining by email over HTTP", async () => {
  const sent: string[] = [];
  const mailGame = new Game(new Database(":memory:"), { inviteCode: "elf", mailer: async (_to, code) => void sent.push(code) });
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createHandler(mailGame) });
  const old = server;
  server = s;
  try {
    expect((await call("Ana", "join", { name: "Ana", budget: 25, invite_code: "elf" })).error).toMatch(/email address/);
    expect((await call("Ana", "join", { name: "Ana", budget: 25, email: "ana@example.org" })).error).toMatch(/invite/);
    const reply = await call("Ana", "join", { name: "Ana", budget: 25, email: "ana@example.org", invite_code: "elf" });
    expect(reply.confirmation_sent).toBe(true);
    expect(reply.request_ref).toMatch(/^[0-9A-Z]{6}$/);
    expect(sent).toHaveLength(1);
    // Inside the cooldown the tool answers with an error, and the error still carries the reference.
    expect((await call("Ana", "join", { name: "Ana", budget: 25, email: "ana@example.org", invite_code: "elf" })).error).toContain(
      `reference: ${reply.request_ref}`,
    );
    expect((await call("Bogdan", "confirm", { code: sent[0] })).error).toMatch(/no code waiting/);
    expect((await call("Ana", "confirm", { code: sent[0] })).joined_as).toBe("Ana");
    expect((await call("Ana", "status")).you).toBe("Ana");
    expect((await call("Bogdan", "status")).players).toBeUndefined();
  } finally {
    server = old;
    s.stop(true);
  }
});

test("the stdio bridge relays MCP messages to the server", async () => {
  const proc = Bun.spawn(["node", new URL("../../santa/bridge.mjs", import.meta.url).pathname], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "", SANTA_URL: `http://127.0.0.1:${server.port}/mcp`, NO_PROXY: "*" },
  });
  proc.stdin.write(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]
      .map((m) => JSON.stringify(m))
      .join("\n") + "\n",
  );
  proc.stdin.end();
  const replies = (await new Response(proc.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
  expect(replies.map((r) => r.id)).toEqual([1, 2]);
  expect(replies[0].result.serverInfo.name).toBe("secret-santa");
  expect(replies[1].result.tools.length).toBeGreaterThan(10);
});

test("the root address describes the service", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("Secret Santa");
  expect((await fetch(`http://127.0.0.1:${server.port}/robots.txt`)).status).toBe(200);
});

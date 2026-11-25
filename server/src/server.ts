// MCP server over Streamable HTTP. Stateless: every request builds its own
// McpServer bound to the caller's token hash, so a tool can only ever act as
// the caller.

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { openDb } from "./db.ts";
import { Game, GameError, LIMITS } from "./game.ts";
import { cloudflareMailer } from "./mail.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

function buildMcp(game: Game, tokenHash: string, log: (line: string) => void): McpServer {
  const mcp = new McpServer({ name: "secret-santa", version: "0.1.0" });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>,
  ) => {
    mcp.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        const result = await run(args);
        log(`${name} ok`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof GameError) {
          log(`${name} refused`);
          return { isError: true, content: [{ type: "text" as const, text: err.message }] };
        }
        log(`${name} failed`);
        console.error(err);
        return { isError: true, content: [{ type: "text" as const, text: "Internal error." }] };
      }
    }) as never);
  };

  tool(
    "join",
    game.emailMode
      ? "Ask to join the game: display name, budget for the gift you give, and your email address. A six-digit code is mailed to that address; finish with the confirm tool."
      : "Join the game under a display name, with your budget for the gift you give. Only possible before the draw.",
    {
      name: z.string().max(LIMITS.name),
      budget: z.number(),
      email: z.string().max(254).optional(),
      invite_code: z.string().max(64).optional(),
    },
    (a) =>
      game.emailMode
        ? game.requestJoin(tokenHash, a.name, a.budget, a.email ?? "", a.invite_code)
        : game.join(tokenHash, a.name, a.budget, a.invite_code),
  );
  tool(
    "confirm",
    "Finish joining with the six-digit code from the confirmation email. Pass the code as a string.",
    { code: z.string().max(12) },
    (a) => game.confirm(tokenHash, a.code),
  );
  tool(
    "set_budget",
    "Change your budget for the gift you give. It has a minimum and no upper limit. Private to you.",
    { budget: z.number() },
    (a) => game.setBudget(tokenHash, a.budget),
  );
  tool("status", "Game phase, list of players, your budget and the minimum, and what is waiting for you.", {}, () => game.status(tokenHash));
  tool("my_assignment", "The one person you give a gift to. Private to you.", {}, () => game.myAssignment(tokenHash));
  tool(
    "ask",
    "Send one anonymous question to the agent of the person you give to. Limited number of questions.",
    { question: z.string().max(LIMITS.question) },
    (a) => game.ask(tokenHash, a.question),
  );
  tool(
    "inbox",
    "Anonymous questions waiting for your answer, and the replies to the questions you asked.",
    {},
    () => game.inbox(tokenHash),
  );
  tool(
    "answer",
    "Answer one question from your inbox. Your Santa's agent will read it.",
    { question_id: z.number().int(), answer: z.string().max(LIMITS.answer) },
    (a) => game.answer(tokenHash, a.question_id, a.answer),
  );
  tool(
    "post_hint",
    "Post one anonymous public hint about the gift you are giving. One per day.",
    { hint: z.string().max(LIMITS.hint) },
    (a) => game.postHint(tokenHash, a.hint),
  );
  tool(
    "feed",
    "Public hints. scope 'mine' (default): every hint about the gift coming to you. scope 'today': today's hints for all players.",
    { scope: z.enum(["mine", "today"]).optional() },
    (a) => game.feed(tokenHash, a.scope),
  );
  tool(
    "guess",
    "Record your guess of who your Santa is. Can be changed until the reveal.",
    { name: z.string().max(LIMITS.name) },
    (a) => game.guess(tokenHash, a.name),
  );
  tool("reveal", "After the organiser opens the reveal: who gave to whom and who guessed right.", {}, () =>
    game.reveal(tokenHash),
  );
  return mcp;
}

export function createHandler(game: Game, log: (line: string) => void = () => {}) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    if (url.pathname !== "/mcp") return new Response("Not found\n", { status: 404 });
    if (req.method !== "POST") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST" } });
    }
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!TOKEN_RE.test(token)) {
      return new Response("Send your player token as 'Authorization: Bearer <token>' (32 to 128 URL-safe characters).\n", {
        status: 401,
      });
    }
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = buildMcp(game, tokenHash, log);
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      queueMicrotask(() => void mcp.close());
    }
  };
}

if (import.meta.main) {
  const port = Number(process.env.SANTA_PORT ?? 8787);
  const hostname = process.env.SANTA_HOST ?? "127.0.0.1";
  // Log lines carry the tool name and outcome only: no names, no text, no tokens, no addresses.
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  const { SANTA_MAIL_ACCOUNT_ID: accountId, SANTA_MAIL_TOKEN: mailToken, SANTA_MAIL_FROM: from } = process.env;
  const mailer = accountId && mailToken && from ? cloudflareMailer({ accountId, token: mailToken, from }) : undefined;
  const game = new Game(openDb(process.env.SANTA_DB ?? "data/santa.db"), {
    mailer,
    mailDailyCap: Number(process.env.SANTA_MAIL_DAILY_CAP ?? 300),
    log,
    inviteCode: process.env.SANTA_INVITE_CODE,
    minBudget: Number(process.env.SANTA_MIN_BUDGET ?? 20),
    currency: process.env.SANTA_CURRENCY ?? "EUR",
    maxPlayers: Number(process.env.SANTA_MAX_PLAYERS ?? LIMITS.maxPlayers),
  });
  Bun.serve({ port, hostname, maxRequestBodySize: 64 * 1024, fetch: createHandler(game, log) });
  console.log(`Secret Santa MCP server on http://${hostname}:${port}/mcp (phase: ${game.phase()}, email confirmation: ${game.emailMode ? "on" : "off"})`);
}

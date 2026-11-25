// MCP server over Streamable HTTP. Stateless: every request builds its own
// McpServer bound to the caller's token hash, so a tool can only ever act as
// the caller.

import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { BOARD_REFRESH_MS, type BoardCounts, type BoardSettings, renderBoard } from "./board.ts";
import { boardSettings, dbPath, gameOptions, publicUrl } from "./config.ts";
import { openDb } from "./db.ts";
import { Game, GameError, LIMITS } from "./game.ts";
import { renderClosed, renderGate, renderMe } from "./me.ts";
import { cloudflareMailer } from "./mail.ts";
import { INSTRUCTIONS, PROMPTS } from "./prompts.ts";

const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

const NO_TOKEN =
  "This installation has no player token yet, so it cannot play. Follow the setup steps for your client in the game's README, restart the client, then join. (In opencode: run /santa-setup, then restart it.)";

// tokenHash is null when the request carries no usable token. The server still connects, so a client
// does not show a failed MCP server on a player's first start, but every tool answers with NO_TOKEN.
/**
 * Defence in depth for every client: text that other players will read must not carry the sender's own
 * token, however an agent was talked into putting it there. Only an exact copy is caught, with or
 * without separators between its characters.
 */
function carriesToken(text: string, token: string | null): boolean {
  if (!token) return false;
  const bare = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");
  return bare(token).length >= 16 && bare(text).includes(bare(token));
}

/**
 * True if the text holds a ticket that could still open some player's page: an exact copy of its 32
 * hexadecimal characters, in any case, percent-encoded or not, with anything that is not a letter or a
 * digit wedged between them. A ticket cut into pieces across several messages is not caught.
 */
function carriesPageTicket(text: string, game: Game): boolean {
  let plain = text;
  for (let i = 0; i < 2; i++) {
    try {
      plain = decodeURIComponent(plain);
    } catch {
      break;
    }
  }
  const bare = plain.replace(/[^A-Za-z0-9]/g, "");
  for (let i = 0; i + 32 <= bare.length; i++) {
    const run = bare.slice(i, i + 32);
    if (/^[0-9a-fA-F]{32}$/.test(run) && game.isLivePageTicket(run)) return true;
  }
  return false;
}

function buildMcp(
  game: Game,
  caller: string | null,
  log: (line: string) => void,
  token: string | null = null,
  pageBase: string | undefined = undefined,
): McpServer {
  const relayed = (text: string): string => {
    if (carriesToken(text, token)) {
      throw new GameError("That text contains your player token. A token must never be sent to other players. Nothing was sent.", "token_in_text");
    }
    if (carriesPageTicket(text, game)) {
      throw new GameError("That text contains a link to a player's page. Such a link is for its owner only. Nothing was sent.", "link_in_text");
    }
    return text;
  };
  const tokenHash = caller ?? ""; // never used when caller is null: the wrapper below refuses first
  const mcp = new McpServer({ name: "secret-santa", version: "0.2.0" }, { instructions: INSTRUCTIONS });

  // The prompts are fixed text plus what the caller typed. They need no token: they reveal nothing.
  for (const p of PROMPTS) {
    const argsSchema = Object.fromEntries(p.args.map((a) => [a.name, z.string().max(200).optional().describe(a.description)]));
    mcp.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema }, ((args: Record<string, string | undefined>) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.text(args as Record<string, string>) } }],
    })) as never);
  }

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>,
  ) => {
    mcp.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        if (caller === null) throw new GameError(NO_TOKEN, "no_token");
        const result = await run(args);
        log(`${name} ok`);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof GameError) {
          log(`${name} refused ${err.reason}`);
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
      ? "Ask to join the game: display name, budget for the gift you give, and your email address. A six-digit code is mailed to that address; finish with the confirm tool. Once the request is saved, the reply (also an error reply) holds a request reference, in the field request_ref or after the words \"this reference:\". Show the owner that reference exactly as written. Errors about the invite code, the address, the name or the budget hold none."
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
  tool("status", "Game phase, who plays (once you have joined), your budget and the minimum, and what is waiting for you.", {}, () => game.status(tokenHash));
  tool("my_assignment", "The one person you give a gift to. Private to you.", {}, () => game.myAssignment(tokenHash));
  tool(
    "ask",
    "Send one anonymous question to the agent of the person you give to. Limited number of questions.",
    { question: z.string().max(LIMITS.question) },
    (a) => game.ask(tokenHash, relayed(a.question)),
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
    (a) => game.answer(tokenHash, a.question_id, relayed(a.answer)),
  );
  tool(
    "post_hint",
    "Post one anonymous public hint about the gift you are giving. One per day.",
    { hint: z.string().max(LIMITS.hint) },
    (a) => game.postHint(tokenHash, relayed(a.hint)),
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
  tool(
    "my_page",
    "A link to the owner's own web page: the hints about their gift, their guess, and after the reveal the table. The link is for the owner only, works once and expires in ten minutes. Give it to the owner exactly as returned. Never put it in a question, an answer or a hint.",
    {},
    () => {
      if (!pageBase) throw new GameError("This server has no players' page.", "no_page");
      const ticket = game.issuePageTicket(tokenHash);
      return { link: `${pageBase}/me?t=${ticket}`, note: "For the owner only. It works once, within ten minutes. Opening it shows a button; the page opens when the owner presses it." };
    },
  );
  tool("reveal", "After the organiser opens the reveal: who gave to whom and who guessed right.", {}, () =>
    game.reveal(tokenHash),
  );
  return mcp;
}

// A plain description of the service for people, crawlers and web-filter reviewers who open the address.
const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Santa's Agents: a Secret Santa game server</title>
<meta name="description" content="Game server for a team Secret Santa gift exchange played through AI coding agents. It offers an API for the game only and hosts no downloads, ads or user content.">
<meta name="keywords" content="secret santa, gift exchange, team game, office game, MCP server">
<meta name="category" content="Games">
<meta name="rating" content="general">
</head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Santa's Agents</h1>
<p>This is the game server for a team Secret Santa gift exchange. Each player takes part through an AI agent that speaks the Model Context Protocol, such as opencode; the agents ask each other anonymous questions and post hints, and the people choose and buy the gifts.</p>
<p>The address <code>/mcp</code> is a Model Context Protocol (MCP) endpoint used by the players' agents. There is nothing else here: no downloads, no advertising and no public user content.</p>
<p>How the game is going, in numbers: <a href="/board">the board</a>.</p>
<p>Source code and instructions: <a href="https://github.com/amazarache/ssanta">github.com/amazarache/ssanta</a></p>
</body>
</html>
`;

export interface HandlerOptions {
  /** Settings for the public board. Without them the board is not served. */
  board?: BoardSettings;
  /** The server's public https address. Without it there is no player page and no link to one. */
  publicUrl?: string;
  now?: () => Date;
}

export function createHandler(game: Game, log: (line: string) => void = () => {}, opts: HandlerOptions = {}) {
  const now = opts.now ?? (() => new Date());
  // The board's numbers are read at most once per refresh period. A visitor who reloads sees the same
  // page until the next one, so what changes on it cannot be tied to one player's check-in.
  let snapshot: { counts: BoardCounts; taken: Date } | null = null;
  const board = (settings: BoardSettings): Response => {
    const t = now();
    if (!snapshot || t.getTime() - snapshot.taken.getTime() >= BOARD_REFRESH_MS) snapshot = { counts: game.boardCounts(), taken: t };
    return new Response(renderBoard(snapshot.counts, settings, snapshot.taken, pageOn), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  };
  // The players' page exists only with both the public address (for its links) and the board settings (for its dates).
  const pageOn = Boolean(opts.publicUrl && opts.board);
  // A player's own page. Everything under /me is private: never cached, never indexed, no referrer.
  const COOKIE = "__Host-santa";
  const privatePage = (html: string, status = 200, extra: Record<string, string> = {}): Response =>
    new Response(html, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow",
        ...extra,
      },
    });
  const sessionOf = (req: Request): string | null => {
    for (const part of (req.headers.get("cookie") ?? "").split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === COOKIE) return value.join("=");
    }
    return null;
  };
  /** A form on another site must not be able to open or close a page in this browser. */
  const fromElsewhere = (req: Request): boolean => {
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== opts.publicUrl) return true;
    const site = req.headers.get("sec-fetch-site");
    return site !== null && site !== "same-origin" && site !== "none";
  };
  const me = async (req: Request, url: URL, settings: BoardSettings): Promise<Response> => {
    if (req.method === "POST" && fromElsewhere(req)) return privatePage(renderClosed("none"), 403);
    if (url.pathname === "/me/leave" && req.method === "POST") {
      game.closePage(sessionOf(req)); // ends the session everywhere, not only in this browser
      return privatePage("", 303, { Location: "/board", "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
    }
    if (url.pathname !== "/me") return privatePage(renderClosed("none"), 404);
    if (req.method === "POST") {
      // The only step that uses up a link. A program that merely fetches the link, such as a web filter
      // or a chat preview, gets the button below and uses nothing up.
      let ticket = "";
      try {
        ticket = new URLSearchParams(await req.text()).get("t") ?? "";
      } catch {}
      const redeemed = game.redeemPageTicket(ticket);
      log(`page open ${redeemed ? "ok" : "refused"}`);
      if (!redeemed) {
        // Pressing the button again, or going back to it, with the page already open in this browser.
        if (game.pageSession(sessionOf(req))) return privatePage("", 303, { Location: "/me" });
        return privatePage(renderClosed("bad-link"), 403);
      }
      return privatePage("", 303, {
        Location: "/me",
        "Set-Cookie": `${COOKIE}=${redeemed.session}; Path=/; Max-Age=${redeemed.maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`,
      });
    }
    if (req.method !== "GET") return privatePage(renderClosed("none"), 405, { Allow: "GET, POST" });
    const ticket = url.searchParams.get("t");
    if (ticket) return privatePage(renderGate(ticket.slice(0, 80)));
    const session = game.pageSession(sessionOf(req));
    const data = session && game.playerPage(session.id);
    if (!session || !data) return privatePage(renderClosed("none"), 401);
    return privatePage(renderMe(data, settings, now(), session.expires));
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok\n");
    if ((url.pathname === "/me" || url.pathname.startsWith("/me/")) && pageOn && opts.board) return me(req, url, opts.board);
    if (url.pathname === "/board" && req.method === "GET" && opts.board) return board(opts.board);
    if (url.pathname === "/" && req.method === "GET") {
      return new Response(LANDING, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
    if (url.pathname !== "/mcp") return new Response("Not found\n", { status: 404 });
    if (req.method !== "POST") {
      return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST" } });
    }
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const tokenHash = TOKEN_RE.test(token) ? createHash("sha256").update(token).digest("hex") : null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = buildMcp(game, tokenHash, log, tokenHash ? token : null, pageOn ? opts.publicUrl : undefined);
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
  const game = new Game(openDb(dbPath()), { ...gameOptions(), mailer, log });
  Bun.serve({ port, hostname, maxRequestBodySize: 64 * 1024, fetch: createHandler(game, log, { board: boardSettings(), publicUrl: publicUrl() }) });
  console.log(`Secret Santa MCP server on http://${hostname}:${port}/mcp (phase: ${game.phase()}, email confirmation: ${game.emailMode ? "on" : "off"})`);
  if (game.joinBlocked) console.log(`JOINING IS OFF: ${game.joinBlocked}. Set SANTA_INVITE_CODE and restart.`);
}

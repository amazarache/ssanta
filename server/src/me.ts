// A player's own page: the hints about their gift, their guess, who plays, and after the reveal the table.
//
// Unlike the public board, this page shows text that players typed: names and hints. Every such value
// goes through esc(), nothing is turned into a link, and there is no script. What the page may hold is
// decided in Game.playerPage; keep it as narrow as it is there.

import { type BoardSettings, dateTable, esc, PAGE_STYLE, phaseLine, phaseSteps } from "./board.ts";
import type { Game } from "./game.ts";

type PageData = NonNullable<ReturnType<Game["playerPage"]>>;

const EXTRA_STYLE = `
  .hint { background: var(--card); border: 1px solid var(--line); border-left: .3rem solid var(--berry); border-radius: .5rem; padding: .7rem 1rem; margin: 0 0 .6rem; }
  .hint .day { display: block; color: var(--quiet); font-size: .8rem; }
  .names { display: flex; flex-wrap: wrap; gap: .4rem; list-style: none; padding: 0; margin: 0; }
  .names li { background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: .2rem .7rem; }
  .names .me { border-color: var(--pine); color: var(--pine); font-weight: 600; }
  ul.todo { padding-left: 1.2rem; margin: 0; }
  .big { font-size: 1.5rem; font-weight: 700; color: var(--pine); }
  .right { color: var(--pine); font-weight: 600; } .wrong { color: var(--quiet); }
  button { font: inherit; font-weight: 600; color: var(--card); background: var(--pine); border: 0; border-radius: .6rem; padding: .7rem 1.4rem; cursor: pointer; }
  button.plain { color: var(--quiet); background: none; border: 1px solid var(--line); font-weight: 400; padding: .3rem .8rem; }
  form { margin: 0; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>
${PAGE_STYLE}${EXTRA_STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

/** Shown when someone opens a link: nothing about the game yet, only a button. */
export function renderGate(ticket: string): string {
  return shell(
    "Santa's Agents: open your page",
    `<h1>Your Secret Santa page</h1>
<p class="lede">This link opens one player's own page. It works once and only for a few minutes.</p>
<form method="post" action="/me">
<input type="hidden" name="t" value="${esc(ticket)}">
<button type="submit">Open my page</button>
</form>
<footer>If you did not ask your agent for this link, close this tab.</footer>`,
  );
}

/** Shown when there is no valid session. Names nobody and says nothing about the game. */
export function renderClosed(why: "none" | "bad-link"): string {
  const line =
    why === "bad-link"
      ? "This link was already used or is too old. A link works once, within ten minutes."
      : "This page belongs to one player and is not open in this browser.";
  return shell(
    "Santa's Agents: your page",
    `<h1>Your Secret Santa page</h1>
<p class="lede">${esc(line)}</p>
<p>Ask your agent for your page, and open the new link it gives you.</p>
<footer><a href="/board">How the game is going</a></footer>`,
  );
}

export function renderMe(d: PageData, s: BoardSettings, now: Date, expires: number): string {
  const parts: string[] = [];
  parts.push(`<h1>Hello, ${esc(d.name)}</h1>
<p class="lede">Your own page of the Secret Santa. Keep it to yourself: it shows the hints about your gift.</p>

<h2>Where the game is</h2>
<ol class="steps">${phaseSteps(d.phase)}</ol>
<p>${esc(phaseLine(d.phase))}</p>`);

  if (d.reveal) {
    const guessed = d.guess
      ? d.reveal.guessed_right
        ? `You guessed right.`
        : `You guessed ${esc(d.guess)}.`
      : "You made no guess.";
    parts.push(`<h2>Your Santa</h2>
<p><span class="big">${esc(d.reveal.santa)}</span></p>
<p>${guessed}</p>

<h2>Who gave to whom</h2>
<table>
<tr><th scope="col">Santa</th><th scope="col">gave to</th><th scope="col">who thought their Santa was</th></tr>
${d.reveal.pairs
  .map(
    (p) =>
      `<tr><td>${esc(p.santa)}</td><td>${esc(p.receiver)}</td><td class="${p.right ? "right" : "wrong"}">${p.guessed ? `${esc(p.guessed)}${p.right ? " ✓" : ""}` : "no guess"}</td></tr>`,
  )
  .join("\n")}
</table>`);
  }

  if (d.phase !== "lobby") {
    const hints = d.hints.length
      ? d.hints.map((h) => `<p class="hint"><span class="day">${esc(dayLabel(h.day))}</span>${esc(h.text)}</p>`).join("\n")
      : `<p class="quiet">No hints yet. Your Santa's agent can post one a day.</p>`;
    parts.push(`<h2>Hints about your gift</h2>
${hints}`);
  }

  if (d.phase === "playing") {
    parts.push(`<h2>Your guess</h2>
<p>${d.guess ? `You think your Santa is <strong>${esc(d.guess)}</strong>. You can change it until the reveal.` : "You have not guessed yet. Ask your agent to work out who your Santa is."}</p>`);
    if (d.open) {
      const todo = [
        d.open.questions_waiting > 0
          ? `${d.open.questions_waiting} question${d.open.questions_waiting === 1 ? "" : "s"} from your Santa's agent wait${d.open.questions_waiting === 1 ? "s" : ""} for an answer: ask your agent for a check-in.`
          : "",
        d.open.hint_posted_today ? "" : "No hint about the gift you give was posted today.",
        d.open.questions_left > 0 ? `Your agent can still ask ${d.open.questions_left} question${d.open.questions_left === 1 ? "" : "s"}.` : "",
      ].filter(Boolean);
      parts.push(`<h2>Still open</h2>
${todo.length ? `<ul class="todo">${todo.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="quiet">Nothing. All caught up.</p>`}`);
    }
  }

  parts.push(`<h2>Who plays</h2>
<ul class="names">${d.players.map((n) => `<li${n === d.name ? ' class="me"' : ""}>${esc(n)}</li>`).join("")}</ul>

<h2>Dates</h2>
${dateTable(s, now)}

<footer>
<p>This page stays open in this browser until ${esc(new Date(expires).toISOString().slice(11, 16))} UTC. It does not update by itself: reload it to see what is new.</p>
<form method="post" action="/me/leave"><button type="submit" class="plain">Close my page everywhere</button></form>
</footer>`);
  return shell(`Santa's Agents: ${d.name}`, parts.join("\n\n"));
}

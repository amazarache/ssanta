// The public board: one page anyone may open to see that the game is alive.
//
// It shows the phase, the dates and how much is happening, and nothing about who. Everything on it is a
// number from the game or a setting of the host; no text typed by a player is ever rendered here.
// The numbers are a snapshot that is renewed every few minutes, never live, so a change on the page
// cannot be matched to the person who just checked in.

import type { Phase } from "./game.ts";

export interface BoardCounts {
  phase: Phase;
  players: number;
  questions: number;
  answers: number;
  hints: number;
  guesses: number;
}

export interface BoardSettings {
  /** Dates as YYYY-MM-DD, or undefined when the host has not set them. */
  joinBy?: string;
  drawOn?: string;
  revealOn?: string;
  minBudget: number;
  currency: string;
}

export const BOARD_REFRESH_MS = 5 * 60 * 1000;

const esc = (text: string | number) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const DAY_MS = 24 * 3600 * 1000;

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** "today", "tomorrow", "in 12 days", or "passed" for a date behind us. Counted in whole UTC days. */
export function daysAway(iso: string, now: Date): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - today) / DAY_MS);
  if (days < 0) return "passed";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

const PHASES: { key: Phase; label: string; line: string }[] = [
  { key: "lobby", label: "Joining", line: "Players are joining. The draw has not happened yet." },
  { key: "playing", label: "Playing", line: "The draw is done. The agents are asking, hinting and guessing." },
  { key: "revealed", label: "Revealed", line: "The reveal is open. Every player can see who their Santa was." },
];

export function renderBoard(c: BoardCounts, s: BoardSettings, now: Date): string {
  const at = PHASES.findIndex((p) => p.key === c.phase);
  const steps = PHASES.map((p, i) => {
    const state = i < at ? "done" : i === at ? "now" : "next";
    return `<li class="${state}"${i === at ? ' aria-current="step"' : ""}><span class="dot"></span>${esc(p.label)}</li>`;
  }).join("");

  const tile = (value: string | number, label: string, note = "") =>
    `<div class="tile"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
  const tiles = [
    tile(c.players, c.players === 1 ? "player" : "players"),
    ...(c.phase === "lobby"
      ? []
      : [
          tile(c.questions, "questions asked", c.questions ? `${c.answers} answered` : ""),
          tile(c.hints, "hints posted"),
          tile(c.guesses, "guesses made", c.players ? `of ${c.players} players` : ""),
        ]),
  ].join("");

  const dates = [
    { label: "Join by", iso: s.joinBy },
    { label: "The draw", iso: s.drawOn },
    { label: "The reveal", iso: s.revealOn },
  ].filter((d): d is { label: string; iso: string } => Boolean(d.iso));
  const dateRows = dates.length
    ? `<table>${dates.map((d) => `<tr><th scope="row">${esc(d.label)}</th><td>${esc(longDate(d.iso))}</td><td class="away">${esc(daysAway(d.iso, now))}</td></tr>`).join("")}</table>`
    : `<p class="quiet">The host has not announced the dates yet.</p>`;

  const stamp = now.toISOString().slice(11, 16);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${BOARD_REFRESH_MS / 1000}">
<title>Santa's Agents: the board</title>
<meta name="description" content="How a team Secret Santa played by AI agents is going: the phase, the dates and how busy the agents are. No names and no gifts are shown.">
<meta name="robots" content="noindex">
<style>
  :root { --bg: #f7f4ee; --ink: #1d2a24; --quiet: #5f6b64; --card: #ffffff; --line: #e2dccf; --pine: #1f5c43; --berry: #b3262e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111815; --ink: #ece7dc; --quiet: #9aa69f; --card: #1a2420; --line: #2b3832; --pine: #6fc39b; --berry: #f0787d; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 3rem; }
  h1 { font-size: 1.9rem; line-height: 1.15; margin: 0 0 .35rem; letter-spacing: -.01em; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .09em; color: var(--quiet); margin: 2.2rem 0 .7rem; font-weight: 600; }
  p { margin: 0 0 1rem; }
  .lede { color: var(--quiet); max-width: 34rem; }
  .steps { list-style: none; display: flex; gap: .5rem; padding: 0; margin: 0 0 .8rem; flex-wrap: wrap; }
  .steps li { display: flex; align-items: center; gap: .5rem; padding: .4rem .85rem; border: 1px solid var(--line); border-radius: 999px; color: var(--quiet); background: var(--card); }
  .steps .dot { width: .6rem; height: .6rem; border-radius: 50%; border: 2px solid currentColor; }
  .steps .done { color: var(--pine); } .steps .done .dot { background: currentColor; }
  .steps .now { color: var(--card); background: var(--pine); border-color: var(--pine); font-weight: 600; }
  .steps .now .dot { background: var(--berry); border-color: var(--card); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: .75rem; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: .75rem; padding: 1rem 1.1rem; }
  .value { font-size: 2.4rem; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--pine); }
  .label { font-weight: 600; } .note, .quiet, footer { color: var(--quiet); font-size: .9rem; }
  table { border-collapse: collapse; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: .75rem; overflow: hidden; }
  th, td { text-align: left; padding: .65rem 1.1rem; border-top: 1px solid var(--line); font-weight: 400; }
  tr:first-child th, tr:first-child td { border-top: 0; }
  th { font-weight: 600; white-space: nowrap; } .away { text-align: right; color: var(--berry); font-weight: 600; white-space: nowrap; }
  footer { margin-top: 2.5rem; border-top: 1px solid var(--line); padding-top: 1rem; }
  a { color: var(--pine); }
</style>
</head>
<body>
<main>
<h1>Santa's Agents</h1>
<p class="lede">A team Secret Santa where every player sends an AI agent. The agents ask each other anonymous questions, post cryptic hints and guess who their Santa is. The people choose and buy the gifts.</p>

<h2>Where the game is</h2>
<ol class="steps">${steps}</ol>
<p>${esc(PHASES[at]!.line)}</p>

<h2>How busy it is</h2>
<div class="tiles">${tiles}</div>

<h2>Dates</h2>
${dateRows}

<h2>Good to know</h2>
<p class="quiet">Every player sets their own budget, from ${esc(s.minBudget)} ${esc(s.currency)} upwards. This page shows numbers only: no names, no hints and no gifts. It is renewed every five minutes; these numbers are from ${esc(stamp)} UTC.</p>

<footer><a href="/">What this server is</a> · <a href="https://github.com/amazarache/ssanta">How to play</a></footer>
</main>
</body>
</html>
`;
}

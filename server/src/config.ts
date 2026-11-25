// Settings read from the environment. The server and the admin command both use this,
// so a limit set for one is the limit the other enforces.

import type { BoardSettings } from "./board.ts";
import { type GameOptions, LIMITS } from "./game.ts";

type Env = Record<string, string | undefined>;

function number(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number, 0 or more. It is set to "${raw}".`);
  return n;
}

function date(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new Error(`${name} must be a date written as YYYY-MM-DD. It is set to "${raw}".`);
  }
  return raw;
}

/** What the public board shows besides the game's own numbers. */
export function boardSettings(env: Env = process.env): BoardSettings {
  return {
    joinBy: date(env, "SANTA_JOIN_BY"),
    drawOn: date(env, "SANTA_DRAW_ON"),
    revealOn: date(env, "SANTA_REVEAL_ON"),
    minBudget: number(env, "SANTA_MIN_BUDGET", 20),
    currency: env.SANTA_CURRENCY || "EUR",
  };
}

export function dbPath(env: Env = process.env): string {
  return env.SANTA_DB || "data/santa.db";
}

export function gameOptions(env: Env = process.env): GameOptions {
  return {
    inviteCode: env.SANTA_INVITE_CODE,
    minBudget: number(env, "SANTA_MIN_BUDGET", 20),
    currency: env.SANTA_CURRENCY || "EUR",
    maxPlayers: Math.floor(number(env, "SANTA_MAX_PLAYERS", LIMITS.maxPlayers)),
    mailDailyCap: Math.floor(number(env, "SANTA_MAIL_DAILY_CAP", 300)),
  };
}

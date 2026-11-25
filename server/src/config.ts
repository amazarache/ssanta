// Settings read from the environment. The server and the admin command both use this,
// so a limit set for one is the limit the other enforces.

import { type GameOptions, LIMITS } from "./game.ts";

type Env = Record<string, string | undefined>;

function number(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number, 0 or more. It is set to "${raw}".`);
  return n;
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

// Sends the confirmation code through the Cloudflare Email Service REST API.
// The message holds fixed text and the code only: nothing typed by a player.

export type Mailer = (to: string, code: string) => Promise<void>;

export class MailError extends Error {
  constructor(
    public status: number,
    public code: number | null,
  ) {
    super(`mail failed ${status}/${code ?? "-"}`);
  }
}

export interface CloudflareMailOptions {
  accountId: string;
  token: string;
  from: string;
  fetch?: typeof fetch;
}

export function cloudflareMailer(opts: CloudflareMailOptions): Mailer {
  const doFetch = opts.fetch ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/email/sending/send`;
  return async (to, code) => {
    const text =
      `Your Secret Santa confirmation code is ${code}\n\n` +
      `It expires in 15 minutes. In opencode, run:\n\n    /santa-confirm ${code}\n\n` +
      `If you did not ask to join, ignore this email.\n`;
    const html =
      `<p>Your Secret Santa confirmation code is</p><p style="font-size:28px;letter-spacing:4px"><b>${code}</b></p>` +
      `<p>It expires in 15 minutes. In opencode, run <code>/santa-confirm ${code}</code></p>` +
      `<p>If you did not ask to join, ignore this email.</p>`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to, from: opts.from, subject: "Your Secret Santa confirmation code", text, html }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MailError(0, null);
    }
    if (res.ok) return;
    let code_: number | null = null;
    try {
      const body = (await res.json()) as { errors?: { code?: number }[] };
      code_ = body.errors?.[0]?.code ?? null;
    } catch {}
    throw new MailError(res.status, code_);
  };
}

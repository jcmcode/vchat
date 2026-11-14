// Email sign-in codes and invite emails, sent through Resend (https://resend.com).
// Works on Node 20+ and Cloudflare Workers (fetch + WebCrypto only). Nothing is stored, and no
// address, code or token is ever logged.

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

/** Trimmed, lowercased address, or null if it doesn't look like one. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** EMAIL_FROM: `invites@example.com` or `Name <invites@example.com>`. */
export function isValidSender(value: string): boolean {
  const v = value.trim();
  const m = v.match(/^([^<>"\r\n]{1,100}?)\s*<([^<>\s]+)>$/);
  return normalizeEmail(m ? m[2] : v) !== null;
}

/** A uniformly random 6-digit code (rejection sampling, no modulo bias). */
export function randomCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

export function isCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Header-safe single line. */
function oneLine(value: string): string {
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim();
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function layout(body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">${body}</div></body></html>`;
}

function codeBlock(code: string): string {
  return `<p style="font-size:32px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,Menlo,Consolas,monospace;margin:16px 0">${escapeHtml(code)}</p>`;
}

export function loginCodeEmail(to: string, code: string): EmailMessage {
  return {
    to,
    subject: 'Your sign-in code',
    text: `Your vchat sign-in code is: ${code}\n\nIt expires in 10 minutes.\n\nIf you didn't ask for this, ignore this email.\n`,
    html: layout(
      `<p>Your vchat sign-in code is:</p>${codeBlock(code)}<p>It expires in 10 minutes.</p><p style="color:#666">If you didn't ask for this, ignore this email.</p>`
    ),
  };
}

/** "2026-11-14 18:30 UTC" */
export function formatUtc(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function inviteEmail(to: string, opts: { link: string; code: string; label?: string; exp: number }): EmailMessage {
  const what = opts.label ? oneLine(opts.label) : 'a video call';
  const expires = formatUtc(opts.exp);
  const instructions = 'Open the link, enter the code, and the host will let you in.';
  return {
    to,
    subject: oneLine(`You're invited to ${what}`),
    text: [
      `You're invited to ${what}.`,
      '',
      `Join the call: ${opts.link}`,
      '',
      `Your code: ${opts.code}`,
      '',
      instructions,
      '',
      `This invite expires ${expires}.`,
      '',
    ].join('\n'),
    html: layout(
      `<p>You're invited to <strong>${escapeHtml(what)}</strong>.</p>` +
        `<p><a href="${escapeHtml(opts.link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Join the call</a></p>` +
        `<p>Your code:</p>${codeBlock(opts.code)}` +
        `<p>${escapeHtml(instructions)}</p>` +
        `<p style="color:#666">This invite expires ${escapeHtml(expires)}.</p>`
    ),
  };
}

export interface ResendEnv {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/** Send one email through Resend. Throws a generic error on failure (no provider details). */
export async function sendEmail(env: ResendEnv, message: EmailMessage): Promise<void> {
  let res: Response;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM!.trim(),
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Email provider unreachable');
  }
  // Drain the body without reading it into logs.
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`Email provider returned ${res.status}`);
}

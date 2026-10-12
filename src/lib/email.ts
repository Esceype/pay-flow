import { env } from "./env";
import { log } from "./logger";

// Outbound email through Resend's HTTP API (ADR-010). Plain fetch rather
// than an SDK: it is one POST, and that keeps this module free of anything
// that would need lazy construction (see ADR-005).

export interface Email {
  to: string;
  subject: string;
  text: string;
}

export type SendResult = { status: "sent"; id: string } | { status: "skipped" };

export class EmailError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    // True when sending the same request again cannot succeed (a rejected
    // recipient, a bad API key) — as opposed to the provider being
    // rate-limited or briefly down.
    readonly permanent: boolean
  ) {
    super(message);
    this.name = "EmailError";
  }
}

// The value from .env, or undefined if email isn't set up. `.env.example`
// ships the placeholder "re_...", and a copied placeholder must behave like
// "not configured", not like a key that fails every send.
export function resendApiKeyFrom(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key && key !== "re_..." ? key : undefined;
}

// One email, at most once per idempotency key: Resend remembers a key for
// 24 hours and answers a repeat with the original result instead of sending
// again. That is what makes it safe for a job to retry after a timeout,
// when it can't know whether the first request got through.
export async function postToResend(
  config: { apiKey: string; from: string },
  email: Email,
  idempotencyKey: string
): Promise<{ id: string }> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: config.from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
    }),
    // Don't let a hung connection hold a worker slot indefinitely.
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 408/429 and 5xx can succeed later, and so can 409 (a conflict on the
    // idempotency key, such as the same key still being processed). Every
    // other 4xx is a request that is wrong and will stay wrong.
    const retryable = response.status >= 500 || [408, 409, 429].includes(response.status);
    throw new EmailError(
      `Resend responded ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      !retryable
    );
  }

  return (await response.json()) as { id: string };
}

// Sends an email, or — with no provider configured — logs it and reports
// "skipped". Local development and CI run without an API key, and nothing
// about the pipeline that leads up to an email should behave differently
// because of that.
export async function sendEmail(email: Email, idempotencyKey: string): Promise<SendResult> {
  const apiKey = resendApiKeyFrom(env.RESEND_API_KEY);
  if (!apiKey) {
    log.info("email not sent: no provider configured", { to: email.to, subject: email.subject });
    return { status: "skipped" };
  }

  const { id } = await postToResend({ apiKey, from: env.EMAIL_FROM }, email, idempotencyKey);
  return { status: "sent", id };
}

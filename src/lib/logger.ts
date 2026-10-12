import { AsyncLocalStorage } from "node:async_hooks";

// Structured logging: one JSON object per line, so a log aggregator (or
// `docker logs | grep`) can filter by field instead of parsing sentences.
//
// The point of this module is the context. A Stripe event passes through
// the webhook route, a queue, a processor, and then triggers a stats
// recompute and maybe an email — in two processes and four jobs. Each of
// those wraps its work in withLogContext({ stripeEventId, ... }), and from
// then on every log line written anywhere underneath carries those fields
// automatically, without each function having to be handed an id to print.
// `stripeEventId` is the correlation id: grep for one and you get the whole
// story of that event.

type Fields = Record<string, unknown>;
type Level = "info" | "warn" | "error";

const context = new AsyncLocalStorage<Fields>();

// Runs `fn` with `fields` added to every log line written inside it,
// including after awaits. Contexts nest: inner fields are added to (and
// override) the outer ones for the duration of the inner call only.
export function withLogContext<T>(fields: Fields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

// Adds fields to the current context from here on — for facts that only
// become known partway through (the tenant, once it has been resolved).
// Outside any context it does nothing.
export function addLogContext(fields: Fields): void {
  const store = context.getStore();
  if (store) Object.assign(store, fields);
}

// Errors don't survive JSON.stringify (their own properties aren't
// enumerable), and Stripe/Prisma errors carry the useful part in extra
// fields such as `code` and `type`.
function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const extra = err as Error & { code?: unknown; type?: unknown; statusCode?: unknown };
  return {
    name: err.name,
    message: err.message,
    ...(extra.code !== undefined && { code: extra.code }),
    ...(extra.type !== undefined && { type: extra.type }),
    ...(extra.statusCode !== undefined && { statusCode: extra.statusCode }),
    stack: err.stack,
  };
}

function write(level: Level, msg: string, fields?: Fields): void {
  const { err, ...rest } = fields ?? {};
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...context.getStore(),
    ...rest,
    ...(err !== undefined && { err: serializeError(err) }),
  });
  // Through console, so stdout/stderr are split the usual way and anything
  // that captures console output (Docker, a test) keeps working.
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// `msg` is a short, stable description; everything variable goes in
// `fields` (pass a caught error as `err`). Stable messages are what make
// "count occurrences of this message" possible.
export const log = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

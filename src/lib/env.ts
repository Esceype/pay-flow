import { z } from "zod";

// Required: database, Redis, and the Auth.js pair. Stripe/email values stay
// optional so the infra (and `next build`) can boot without real
// credentials — each call site fails with a clear error when it actually
// needs one that's missing.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  // Signing secret of the Connect webhook endpoint (every event from
  // connected accounts, account.updated included — ADR-003), routed
  // through the outbox + BullMQ pipeline.
  STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
  // Platform fee on each invoice payment, in basis points (250 = 2.5%),
  // taken via application_fee_amount on the direct charge. 0 disables it.
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),

  RESEND_API_KEY: z.string().optional(),
  // Required as of Phase 1: NEXTAUTH_SECRET signs session JWTs, and
  // NEXTAUTH_URL is the base URL used to build the Stripe Connect
  // redirect_uri (see src/lib/stripe-connect.ts).
  NEXTAUTH_SECRET: z.string().min(1),
  NEXTAUTH_URL: z.string().url(),

  BULL_BOARD_USER: z.string().optional(),
  BULL_BOARD_PASSWORD: z.string().optional(),
  WORKER_HTTP_PORT: z.coerce.number().default(3001),
  WORKER_CONCURRENCY: z.coerce.number().default(5),
});

type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

function load(): Env {
  return (cached ??= envSchema.parse(process.env));
}

// Lazy on purpose: this module is imported by route handlers that Next.js
// partially evaluates during `next build` ("Collecting page data"), before
// any of these variables exist — Docker Compose injects them at container
// start, not at image build time. A Proxy defers validation until a
// property is actually read, which only happens from inside request
// handling, never from merely importing the module.
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return load()[prop as keyof Env];
  },
});

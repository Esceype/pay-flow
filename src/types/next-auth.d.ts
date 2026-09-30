import type { DefaultSession } from "next-auth";

// Auth.js's default Session/JWT types don't carry our User.id — every
// consumer of `auth()` needs it (Connect routes, dashboard), so it's added
// here once instead of re-casting at every call site.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
  }
}

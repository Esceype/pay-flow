import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "./prisma";
import { verifyPassword } from "./password";
import { env } from "./env";

// Lazy config (a function, not a plain object): NextAuth calls this per
// request rather than once at import time. That matters because
// `next build`'s page-data collection partially evaluates route modules —
// including this one — before any real env vars exist (see env.ts). A
// plain object literal here would read env.NEXTAUTH_SECRET immediately at
// import time and break the Docker build the same way prisma.ts did.
export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  // Credentials provider is incompatible with database sessions in
  // Auth.js — JWT is the only option, and it's the right one anyway: no
  // NextAuth Account/Session/VerificationToken tables needed on top of our
  // own tenant-shaped `User` model.
  session: { strategy: "jwt" },
  secret: env.NEXTAUTH_SECRET,
  // Required off Vercel (we run in Docker behind our own host/proxy) —
  // without this, Auth.js rejects requests with an UntrustedHost error.
  trustHost: true,
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") return null;

        // Normalized the same way as on signup (trim + lowercase).
        const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
        if (!user?.hashedPassword) return null;

        const valid = await verifyPassword(password, user.hashedPassword);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user) session.user.id = token.id as string;
      return session;
    },
  },
}));

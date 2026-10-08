import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8),
  name: z.string().trim().min(1).optional(),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid signup payload" }, { status: 400 });
  }

  const { email, password, name } = parsed.data;

  const hashedPassword = await hashPassword(password);

  // Insert-first, not check-then-insert (same pattern as the webhook
  // handlers): two concurrent signups for one email can't both pass a
  // prior existence check — the unique constraint decides.
  try {
    const user = await prisma.user.create({
      data: { email, hashedPassword, name },
      select: { id: true, email: true },
    });
    return Response.json({ user }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Deliberately vague — do not reveal whether the email is registered.
      return Response.json({ error: "Could not create account" }, { status: 400 });
    }
    throw err;
  }
}

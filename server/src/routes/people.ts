import { Router } from "express";
import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody, parseQuery } from "../lib/http.js";

const upsertPersonSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().max(256).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
});

const listPeopleQuerySchema = z.object({
  email: z.string().max(320).optional(),
});

export const peopleRouter = Router({ mergeParams: true });

async function ensureAccount(accountId: string): Promise<void> {
  const [account] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (!account) throw new HttpError(404, "account_not_found");
}

peopleRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    await ensureAccount(accountId);
    const body = parseBody(upsertPersonSchema, req);
    const [person] = await db
      .insert(schema.people)
      .values({
        accountId,
        email: body.email,
        name: body.name,
        avatarUrl: body.avatarUrl,
      })
      .onConflictDoUpdate({
        target: [schema.people.accountId, schema.people.email],
        set: {
          name: body.name ?? null,
          avatarUrl: body.avatarUrl ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    res.status(200).json({ person });
  }),
);

peopleRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    await ensureAccount(accountId);
    const query = parseQuery(listPeopleQuerySchema, req);
    const where = query.email
      ? and(
          eq(schema.people.accountId, accountId),
          ilike(schema.people.email, `%${query.email}%`),
        )
      : eq(schema.people.accountId, accountId);
    const people = await db.select().from(schema.people).where(where);
    res.json({ people });
  }),
);

peopleRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const accountId = req.params.accountId;
    const [person] = await db
      .select()
      .from(schema.people)
      .where(
        and(eq(schema.people.accountId, accountId), eq(schema.people.id, req.params.id)),
      );
    if (!person) throw new HttpError(404, "person_not_found");
    res.json({ person });
  }),
);

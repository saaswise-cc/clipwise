import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { asyncHandler, HttpError, parseBody } from "../lib/http.js";
import { slugify, slugWithSuffix } from "../lib/slug.js";

const createAccountSchema = z.object({
  name: z.string().min(1).max(256),
  slug: z.string().min(1).max(128).optional(),
});

export const accountsRouter = Router();

accountsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = parseBody(createAccountSchema, req);
    const slug = body.slug ? slugify(body.slug) : slugWithSuffix(body.name);
    const [account] = await db
      .insert(schema.accounts)
      .values({ name: body.name, slug })
      .returning();
    res.status(201).json({ account });
  }),
);

accountsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const accounts = await db.select().from(schema.accounts);
    res.json({ accounts });
  }),
);

accountsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const [account] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, req.params.id));
    if (!account) throw new HttpError(404, "account_not_found");
    res.json({ account });
  }),
);

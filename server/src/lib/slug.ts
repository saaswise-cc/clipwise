import { randomBytes } from "node:crypto";

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function slugWithSuffix(input: string): string {
  const base = slugify(input) || "item";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

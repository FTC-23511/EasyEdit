import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rowsOf, type DB } from "@/db";
import type { Actor } from "@/lib/actor";
import { LIMITS } from "@/lib/limits";
import { createProject, getOpsSince, type OpsPage } from "@/lib/projects/service";
import { makeTestDb } from "../helpers/db";

const viewer: Actor = { userId: "u1", email: "u1@gmail.com", role: "viewer" };
const editor: Actor = { ...viewer, role: "editor" };

// Writes log rows straight into the database, each about `kb` kilobytes, and sets the project's version to match.
async function logWithSizes(db: DB, sizesKb: number[]): Promise<string> {
  const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
  for (const [i, kb] of sizesKb.entries()) {
    const ops = JSON.stringify([{ op: "set_format", format: "long_16x9", pad: "x".repeat(kb * 1000) }]);
    await db.execute(sql`insert into project_ops (project_id, version, ops, inverse, actor) values (${id}, ${i + 1}, ${ops}::jsonb, '[]'::jsonb, 'u1')`);
  }
  await db.execute(sql`update projects set version = ${sizesKb.length} where id = ${id}`);
  return id;
}

async function walk(db: DB, id: string): Promise<{ pages: number[][]; last: OpsPage }> {
  const pages: number[][] = [];
  let since = 0;
  let page: OpsPage;
  do {
    page = (await getOpsSince(db, viewer, id, since))!;
    pages.push(page.entries.map((e) => e.version));
    since = page.version;
  } while (page.hasMore);
  return { pages, last: page };
}

describe("op-log pages are bounded by bytes", () => {
  it("a page stops before the entry that would pass 2 MiB, and resumes from there", async () => {
    const db = await makeTestDb();
    const id = await logWithSizes(db, [700, 700, 700, 10]);
    const first = (await getOpsSince(db, viewer, id, 0))!;
    expect(first.entries.map((e) => e.version)).toEqual([1, 2]);
    expect(first).toMatchObject({ version: 2, hasMore: true });
    const next = (await getOpsSince(db, viewer, id, first.version))!;
    expect(next.entries.map((e) => e.version)).toEqual([3, 4]);
    expect(next).toMatchObject({ version: 4, hasMore: false });
  });

  it("walking byte-limited pages returns every entry exactly once", async () => {
    const db = await makeTestDb();
    const id = await logWithSizes(db, [900, 900, 900, 5, 5, 1500, 600, 600, 1]);
    const { pages, last } = await walk(db, id);
    expect(pages).toEqual([[1, 2], [3, 4, 5], [6], [7, 8, 9]]);
    expect(last).toMatchObject({ version: 9, hasMore: false });
  });

  it("an entry larger than the whole budget is still returned, alone", async () => {
    const db = await makeTestDb();
    const id = await logWithSizes(db, [2500, 1]);
    const first = (await getOpsSince(db, viewer, id, 0))!;
    expect(first.entries.map((e) => e.version)).toEqual([1]);
    expect(first).toMatchObject({ version: 1, hasMore: true });
    const { pages } = await walk(db, id);
    expect(pages).toEqual([[1], [2]]);
  });

  it("a page that fills the size limit exactly keeps its last entry, and one byte more leaves it out", async () => {
    const db = await makeTestDb();
    // Seeds three log rows whose `pad` strings have the given lengths.
    const seed = async (pads: number[]) => {
      const { id } = await createProject(db, editor, { name: "P", format: "short_9x16" });
      for (const [i, n] of pads.entries()) {
        const ops = JSON.stringify([{ op: "set_format", format: "long_16x9", pad: "x".repeat(n) }]);
        await db.execute(sql`insert into project_ops (project_id, version, ops, inverse, actor) values (${id}, ${i + 1}, ${ops}::jsonb, '[]'::jsonb, 'u1')`);
      }
      await db.execute(sql`update projects set version = ${pads.length} where id = ${id}`);
      return id;
    };
    // The stored size of a row with an empty pad: its ops text plus "[]" for the inverse.
    const empty = JSON.stringify([{ op: "set_format", format: "long_16x9", pad: "" }]);
    const rows = rowsOf<{ n: number }>(await db.execute(sql`select octet_length(${empty}::jsonb::text) + 2 as n`));
    const base = Number(rows[0].n);
    const first = 1_000_000;
    const second = LIMITS.opsPageBytes - 2 * base - first; // rows 1 and 2 together are exactly the limit

    const exact = (await getOpsSince(db, viewer, await seed([first, second, 1]), 0))!;
    expect(exact.entries.map((e) => e.version)).toEqual([1, 2]);
    expect(exact).toMatchObject({ version: 2, hasMore: true });

    const over = (await getOpsSince(db, viewer, await seed([first, second + 1, 1]), 0))!;
    expect(over.entries.map((e) => e.version)).toEqual([1]);
    expect(over).toMatchObject({ version: 1, hasMore: true });
  });

  it("a page with exactly as many entries as the limit is the last page", async () => {
    const db = await makeTestDb();
    const id = await logWithSizes(db, [1, 1, 1]);
    const page = (await getOpsSince(db, viewer, id, 0, 3))!;
    expect(page.entries.map((e) => e.version)).toEqual([1, 2, 3]);
    expect(page).toMatchObject({ version: 3, hasMore: false });
  });

  it("the count limit still applies when the entries are small", async () => {
    const db = await makeTestDb();
    const id = await logWithSizes(db, [1, 1, 1]);
    const page = (await getOpsSince(db, viewer, id, 0, 2))!;
    expect(page.entries.map((e) => e.version)).toEqual([1, 2]);
    expect(page).toMatchObject({ version: 2, hasMore: true });
  });
});

import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from "@modelcontextprotocol/client";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rowsOf, type DB } from "@/db";
import { removeEntry } from "@/lib/allowlist/service";
import { makeOpsHandlers } from "@/lib/projects/handlers";
import { applyProjectOps, getProject } from "@/lib/projects/service";
import { BASE_URL, MCP_URL, startConnectorApp, type ConnectorApp } from "../helpers/connector";
import { addText } from "../mcp/context";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));

let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
});
afterAll(() => app.stop());

const TOOLS = ["add_text", "create_project", "edit_timeline", "get_editing_guide", "get_project", "list_projects", "undo_change"];

// A conversation: one connected client, and a helper that calls a tool and returns its text.
async function converse(email: string) {
  const c = await app.connect(email);
  const client = await app.mcpClient(c.accessToken);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
    return { text, isError: result.isError === true };
  };
  const person = { userId: c.userId, email, role: "editor" as const };
  return { c, client, call, person };
}

// The newer client, pinned to the newer protocol revision, talking to the same route in-process.
async function modernClient(token: string) {
  const client = new ModernClient({ name: "test-client", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new ModernTransport(new URL(MCP_URL), { fetch: app.fetch, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const idIn = (text: string) => /\(id ([^)]+)\)/.exec(text)![1];
const clipIn = (text: string) => /clip (\S+) on track/.exec(text)![1];
const logRows = async (id: string) => rowsOf<{ version: number; actor: string }>(await app.db.execute(sql`select version, actor from project_ops where project_id = ${id} order by version`));

describe("Claude and the website on one project", () => {
  it("offers exactly the seven tools, in a list small enough to load into every conversation", async () => {
    const { client } = await converse("ada@gmail.com");
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
      expect(JSON.stringify(tools).length).toBeLessThan(12_000);
      for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(["get_editing_guide", "get_project", "list_projects"].includes(t.name));
      const getProject = tools.find((t) => t.name === "get_project");
      expect(Object.keys(getProject?.inputSchema.properties ?? {}).sort()).toEqual(["cursor", "project_id", "version"]);
      expect(getProject?.description).toMatch(
        / Long projects come in pages: to read on, pass the cursor and the version that the last line of a page names\. If the project changed in between, you are told to start again\.$/,
      );
    } finally {
      await client.close();
    }
  });

  it("Claude creates and edits a project; the website lists the changes as Claude's and can undo one", async () => {
    const { c, client, call } = await converse("kid@gmail.com");
    try {
      const created = await call("create_project", { name: "Qualifier recap", format: "short_9x16" });
      const id = idIn(created.text);
      const added = await call("add_text", { project_id: id, expected_version: 0, items: [{ text: "GO SOLVERS" }] });
      const clipId = clipIn(added.text);
      const edited = await call("edit_timeline", { project_id: id, expected_version: 1, ops: [{ op: "update_clip", clipId, patch: { text: "GO SOLVERS, GO" } }] });
      expect(edited.text.split("\n")[0]).toBe("Applied 1 op as version 2.");
      expect((await call("list_projects")).text).toContain(`${id}  "Qualifier recap"  Short 9:16  version 2  changed just now by Claude (for Kid)`);

      // What the editor's Activity list reads, through the website's own route.
      const site = makeOpsHandlers({ db: () => app.db, auth: async () => ({ id: c.userId, email: "kid@gmail.com", name: "Kid", image: null, role: "editor" as const }) });
      const ctx = { params: Promise.resolve({ id }) };
      const page = await (await site.getSince(new Request(`${BASE_URL}/api/projects/${id}/ops?since=0`), ctx)).json();
      expect(page.entries.map((e: { actor: string; actorName: string }) => [e.actor, e.actorName])).toEqual([
        [`claude:${c.userId}`, "Claude (for Kid)"], [`claude:${c.userId}`, "Claude (for Kid)"],
      ]);

      // "Undo this change" in the editor sends the stored inverse back as an ordinary edit.
      const undone = await site.postOps(new Request(`${BASE_URL}/api/projects/${id}/ops`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseVersion: 2, ops: page.entries[1].inverse }),
      }), ctx);
      expect(undone.status).toBe(200);
      const read = await call("get_project", { project_id: id });
      expect(read.text).toContain('"GO SOLVERS"  font="Geist"');
      expect(read.text).toContain("· version 3");
    } finally {
      await client.close();
    }
  });

  it("a person and Claude take turns: Claude never overwrites an edit it has not seen", async () => {
    const { client, call, person } = await converse("grace@gmail.com");
    try {
      const id = idIn((await call("create_project", { name: "Turns", format: "short_9x16" })).text);
      const clipId = clipIn((await call("add_text", { project_id: id, expected_version: 0, items: [{ text: "TITLE" }] })).text);
      // The person retypes the title in the editor.
      await applyProjectOps(app.db, person, { projectId: id, baseVersion: 1, ops: [{ op: "update_clip", clipId, patch: { text: "BY A PERSON" } }] });

      const refused = await call("edit_timeline", { project_id: id, expected_version: 1, ops: [{ op: "update_clip", clipId, patch: { text: "BY CLAUDE" } }] });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("It is now at version 2.");
      expect(refused.text).toContain("  version 2 · Grace · Edited a clip");
      expect(refused.text).toContain('"BY A PERSON"');
      expect((await getProject(app.db, person, id))!.version).toBe(2);

      const moved = await call("edit_timeline", { project_id: id, expected_version: 2, ops: [{ op: "move_clip", clipId, start: 30 }] });
      expect(moved.isError).toBe(false);
      expect(moved.text).toContain('frames 30–120  "BY A PERSON"');
    } finally {
      await client.close();
    }
  });

  it("a repeated call through the real client lands once", async () => {
    const { client, call } = await converse("linus@gmail.com");
    try {
      const id = idIn((await call("create_project", { name: "Twice", format: "short_9x16" })).text);
      const args = { project_id: id, expected_version: 0, ops: [addText(0)] };
      const first = await call("edit_timeline", args);
      expect(await call("edit_timeline", args)).toEqual(first);
      expect(await logRows(id)).toHaveLength(1);
      const again = await call("create_project", { name: "Twice", format: "short_9x16" });
      expect(idIn(again.text)).toBe(id);
    } finally {
      await client.close();
    }
  });

  it("a wrong batch is refused whole and the corrected one lands", async () => {
    const { client, call, person } = await converse("margaret@gmail.com");
    try {
      const id = idIn((await call("create_project", { name: "Fix it", format: "short_9x16" })).text);
      // Seconds where frames belong, in the second op of two.
      const wrong = await call("edit_timeline", { project_id: id, expected_version: 0, ops: [addText(0), addText(2.5)] });
      expect(wrong.isError).toBe(true);
      expect(wrong.text.split("\n")[0]).toBe("Edit refused: ops[1] (add_clip) failed with INVALID.");
      expect(wrong.text).toContain("Times are whole frames.");
      expect((await getProject(app.db, person, id))!.version).toBe(0);
      const right = await call("edit_timeline", { project_id: id, expected_version: 0, ops: [addText(0), addText(75)] });
      expect(right.text.split("\n")[0]).toBe("Applied 2 ops as version 1.");
    } finally {
      await client.close();
    }
  });

  it("removal cuts off a client in the middle of a conversation, and nothing more is written", async () => {
    const { c, client, call } = await converse("katherine@gmail.com");
    const id = idIn((await call("create_project", { name: "Cut off", format: "short_9x16" })).text);
    await removeEntry(app.db, "katherine@gmail.com");
    await expect(client.callTool({ name: "edit_timeline", arguments: { project_id: id, expected_version: 0, ops: [addText(0)] } })).rejects.toThrow();
    await client.close().catch(() => {});
    expect((await app.rpc(c.accessToken, "tools/call", { name: "list_projects", arguments: {} })).status).toBe(403);
    expect((await app.token({ grant_type: "refresh_token", refresh_token: c.refreshToken!, client_id: c.clientId })).ok).toBe(false);
    expect(await logRows(id)).toEqual([]);
  });

  it("a viewer's Claude can read and cannot write", async () => {
    const editor = await converse("dorothy@gmail.com");
    const id = idIn((await editor.call("create_project", { name: "Read only", format: "short_9x16" })).text);
    await editor.client.close();
    const viewer = await app.connect("joan@gmail.com", "viewer");
    expect((await app.callTool(viewer.accessToken, "get_project", { project_id: id })).isError).toBe(false);
    for (const [name, args] of [
      ["create_project", { name: "Mine", format: "short_9x16" }],
      ["edit_timeline", { project_id: id, expected_version: 0, ops: [addText(0)] }],
      ["add_text", { project_id: id, expected_version: 0, items: [{ text: "X" }] }],
      ["undo_change", { project_id: id, expected_version: 0, version: 1 }],
    ] as const) {
      const r = await app.callTool(viewer.accessToken, name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/^Your role is viewer\./);
    }
    expect(await logRows(id)).toEqual([]);
  });

  it("the tools answer the same in the newer protocol revision", async () => {
    const c = await app.connect("barbara@gmail.com");
    const client = await modernClient(c.accessToken);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS);
      const result = await client.callTool({ name: "list_projects", arguments: {} });
      const text = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
      expect(text.split("\n")[0]).toMatch(/^Signed in as /);
    } finally {
      await client.close();
    }
  });

  it("input the schema refuses comes back as a readable error, not a crash", async () => {
    const { client, call } = await converse("frances@gmail.com");
    try {
      const r = await call("edit_timeline", { project_id: "x", expected_version: -1, ops: [] });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("edit_timeline");
    } finally {
      await client.close();
    }
  });
});

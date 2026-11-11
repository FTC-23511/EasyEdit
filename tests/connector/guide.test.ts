import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { EDIT_DESCRIPTION, SERVER_INSTRUCTIONS, buildEditingGuide } from "@/lib/mcp/guide";
import { startConnectorApp, type ConnectorApp } from "../helpers/connector";

let testDb: DB;
vi.mock("@/db", async (original) => ({ ...(await original<typeof import("@/db")>()), getDb: () => testDb }));

let app: ConnectorApp;
beforeAll(async () => {
  app = await startConnectorApp();
  testDb = app.db;
});
afterAll(() => app.stop());

describe("the guide, through the endpoint", () => {
  it("reaches Claude as instructions, a tool, a prompt and a resource, all with the same text", async () => {
    const c = await app.connect("ada@gmail.com", "viewer");
    const client = await app.mcpClient(c.accessToken);
    try {
      expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);

      const tools = (await client.listTools()).tools;
      expect(tools.find((t) => t.name === "edit_timeline")?.description).toBe(EDIT_DESCRIPTION);
      const viaTool = await client.callTool({ name: "get_editing_guide", arguments: {} });
      expect(viaTool.content).toEqual([{ type: "text", text: buildEditingGuide() }]);

      expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["editing-guide"]);
      const viaPrompt = await client.getPrompt({ name: "editing-guide" });
      expect(viaPrompt.messages).toEqual([{ role: "user", content: { type: "text", text: buildEditingGuide() } }]);

      expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(["easyedit://editing-guide"]);
      const viaResource = await client.readResource({ uri: "easyedit://editing-guide" });
      expect(viaResource.contents).toEqual([expect.objectContaining({ uri: "easyedit://editing-guide", text: buildEditingGuide() })]);
    } finally {
      await client.close();
    }
  });
});

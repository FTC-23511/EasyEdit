import { vi } from "vitest";

// Claude identifies itself by a client metadata document, which the sign-in server fetches through this transport.
// Loaded before every test file, so no import order can reach the network: tests serve documents from this store.
export type ClientDocuments = { served: Map<string, unknown>; asked: string[] };

const globalForDocuments = globalThis as typeof globalThis & { __clientDocuments?: ClientDocuments };

export function clientDocuments(): ClientDocuments {
  globalForDocuments.__clientDocuments ??= { served: new Map(), asked: [] };
  return globalForDocuments.__clientDocuments;
}

vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: async (input: RequestInfo | URL) => {
    const documents = clientDocuments();
    const url = new Request(input).url;
    documents.asked.push(url);
    const doc = documents.served.get(url);
    if (doc === undefined) throw new TypeError(`no document at ${url}`);
    return Response.json(doc, { headers: { "cache-control": "max-age=60" } });
  },
}));

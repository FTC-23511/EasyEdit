import type { ProjectApi } from "@/lib/editor/api";
import type { ActivityEntry } from "@/lib/editor/types";
import { OpError, applyOps, prepareOps, type Op, type OpInput, type TimelineDoc } from "@/lib/timeline";

type Failure = "network" | "signed-out" | "forbidden" | "not-found" | "conflict";

// What survives the trip over the network: keys set to undefined are dropped, and nothing is shared by reference.
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// An in-memory stand-in for the projects API, built on the real applyOps. Edits posted through `api` are by user u1.
export function makeFakeServer(initial: TimelineDoc, startVersion: number) {
  let doc = structuredClone(initial);
  let version = startVersion;
  const log: ActivityEntry[] = [];
  const calls: string[] = [];
  let failures: Failure[] = [];
  let loseAnswer = false;
  let remoteCount = 0;

  function write(ops: Op[], actor: string, actorName: string, requestId: string | null = null) {
    const result = applyOps(doc, ops);
    doc = result.doc;
    version += 1;
    log.push({ version, ops, inverse: result.inverse, actor, actorName, requestId, createdAt: new Date(0).toISOString() });
    return result.inverse;
  }
  // Records the call, and fails it without touching the project when a failure is queued.
  function failed(name: string) {
    calls.push(name);
    const kind = failures.shift();
    if (!kind) return null;
    return kind === "conflict" ? ({ ok: false, kind, currentVersion: version } as const) : ({ ok: false, kind } as const);
  }

  const api: ProjectApi = {
    async postOps(input) {
      const { ops, requestId } = wire(input);
      const failure = failed("post");
      if (failure) return failure;
      // A repeated request id gets the first write's answer again, and nothing is applied.
      const prior = requestId === undefined ? undefined : log.find((e) => e.requestId === requestId);
      if (prior) return { ok: true, version: prior.version, inverse: prior.inverse ?? [] };
      try {
        const inverse = write(ops, "u1", "Ada", requestId);
        if (loseAnswer) {
          loseAnswer = false;
          return { ok: false, kind: "network" };
        }
        return { ok: true, version, inverse };
      } catch (error) {
        if (error instanceof OpError) return { ok: false, kind: "op", code: error.code, message: error.message, opIndex: error.opIndex };
        throw error;
      }
    },
    async getVersion() {
      return failed("version") ?? { ok: true, version };
    },
    async getOpsSince(since, limit = 100) {
      const failure = failed("ops");
      if (failure) return failure;
      const after = log.filter((e) => e.version > since);
      const entries = after.slice(0, limit);
      const hasMore = after.length > limit;
      return wire({ ok: true, version: hasMore ? entries[entries.length - 1].version : version, entries, hasMore });
    },
    async getProject() {
      return failed("project") ?? { ok: true, doc: structuredClone(doc), version, name: "Qual recap" };
    },
  };

  return {
    api, calls, log,
    doc: () => doc,
    version: () => version,
    // A teammate's edit, sent with its own request id.
    remote(ops: OpInput[], actor = "u2", actorName = "Grace") { write(prepareOps(ops), actor, actorName, `remote-${String(++remoteCount).padStart(4, "0")}`); },
    fail(kind: Failure, times = 1) { failures = failures.concat(Array<Failure>(times).fill(kind)); },
    loseNextAnswer() { loseAnswer = true; }, // the next post is applied, then reported as a network failure
  };
}

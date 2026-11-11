import { getDb } from "@/db";
import { requireUserApi } from "@/lib/access";
import { makeOpsHandlers } from "@/lib/projects/handlers";

const handlers = makeOpsHandlers({ db: getDb, auth: (req) => requireUserApi(req, "viewer") });

export const GET = handlers.getSince;
export const POST = handlers.postOps;

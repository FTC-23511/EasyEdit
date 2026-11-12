import { getDb } from "@/db";
import { requireUserApi } from "@/lib/access";
import { appBaseUrl } from "@/lib/connector/config";
import { getDrive } from "@/lib/drive";
import { makeMediaHandlers } from "@/lib/media/handlers";

const handlers = makeMediaHandlers({ db: getDb, auth: (req) => requireUserApi(req, "viewer"), drive: getDrive, origin: appBaseUrl });

export const GET = handlers.list;
export const POST = handlers.open;

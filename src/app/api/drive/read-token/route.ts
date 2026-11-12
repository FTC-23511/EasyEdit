import { getDb } from "@/db";
import { requireUserApi } from "@/lib/access";
import { appBaseUrl } from "@/lib/connector/config";
import { getDrive } from "@/lib/drive";
import { makeReadTokenHandler } from "@/lib/media/handlers";

export const POST = makeReadTokenHandler({ db: getDb, auth: (req) => requireUserApi(req, "viewer"), drive: getDrive, origin: appBaseUrl });

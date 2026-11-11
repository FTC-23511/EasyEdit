import { unstable_rethrow } from "next/navigation";
import { CROSS_ORIGIN_BODY, INTERNAL_BODY } from "@/lib/api-errors";
import { ServiceError } from "@/lib/service-error";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const firstValue = (value: string | null) => value?.split(",")[0].trim() || null;

// req.url carries the server's own hostname, not the address the browser used, so the expected
// origin comes from the host headers. A page on another site cannot set these in a victim's browser.
function expectedOrigin(req: Request): string {
  const host = firstValue(req.headers.get("x-forwarded-host")) ?? firstValue(req.headers.get("host"));
  if (!host) return new URL(req.url).origin;
  const scheme = firstValue(req.headers.get("x-forwarded-proto")) ?? new URL(req.url).protocol.slice(0, -1);
  return `${scheme}://${host}`;
}

export function crossOriginResponse(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin === null || origin === expectedOrigin(req)) return null;
  return Response.json(CROSS_ORIGIN_BODY, { status: 403 });
}

export function apiRoute<Rest extends unknown[]>(
  handler: (req: Request, ...rest: Rest) => Promise<Response>,
): (req: Request, ...rest: Rest) => Promise<Response> {
  return async (req, ...rest) => {
    if (!SAFE_METHODS.has(req.method.toUpperCase())) {
      const refused = crossOriginResponse(req);
      if (refused) return refused;
    }
    try {
      return await handler(req, ...rest);
    } catch (error) {
      if (error instanceof ServiceError) return Response.json(error.toBody(), { status: error.status });
      unstable_rethrow(error);
      console.error("Unhandled API error", error);
      return Response.json(INTERNAL_BODY, { status: 500 });
    }
  };
}

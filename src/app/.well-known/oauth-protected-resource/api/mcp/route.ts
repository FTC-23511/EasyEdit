import { getAuth } from "@/lib/auth";

// Says which sign-in server issues tokens for /api/mcp. The auth plugin answers this path itself.
export function GET(request: Request) {
  return getAuth().handler(request);
}

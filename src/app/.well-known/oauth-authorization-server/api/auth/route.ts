import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";

// The sign-in server's own description. Its issuer has a path, so clients look in more than one place.
export function GET(request: Request) {
  return oauthProviderAuthServerMetadata(getAuth())(request);
}

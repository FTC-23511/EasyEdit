import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";

// The plugin sends the signed request in the page address along with sign-in and consent, so the sign-in server
// can carry on with Claude's request afterwards.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });

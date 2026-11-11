import { authClient } from "@/lib/auth-client";

// Sends the member's choice. The auth client adds the signed request from the page address.
export async function decideConsent(accept: boolean): Promise<{ url: string } | { error: true }> {
  try {
    const { data } = await authClient.oauth2.consent({ accept });
    return typeof data?.url === "string" ? { url: data.url } : { error: true };
  } catch {
    return { error: true };
  }
}

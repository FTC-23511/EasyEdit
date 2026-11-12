// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConsentPage from "@/app/(auth)/consent/page";
import LoginPage from "@/app/(auth)/login/page";
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/access";
import { readConsentRequest, type ConsentRequest, type SearchParams } from "@/lib/connector/consent";
import { render, screen } from "../helpers/dom";

vi.mock("@/lib/access", () => ({ getCurrentUser: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/connector/consent", async (original) => ({
  ...(await original<typeof import("@/lib/connector/consent")>()),
  readConsentRequest: vi.fn(),
}));
vi.mock("@/lib/connector/consent-client", () => ({ decideConsent: vi.fn() }));
vi.mock("@/lib/env", () => ({ requiredEnv: () => "test-secret" }));
vi.mock("@/db", () => ({ getDb: () => ({}) }));

const ada: CurrentUser = { id: "u1", email: "ada@gmail.com", name: "Ada", image: null, role: "editor" };
const signedRequest: SearchParams = { client_id: "c1", sig: "s", exp: "1" };

// What the page sees for a request: the async component, awaited, then rendered.
type Page = (props: { params: Promise<object>; searchParams: Promise<SearchParams> }) => Promise<React.ReactNode>;
async function show(page: Page, searchParams: SearchParams) {
  render(await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  vi.mocked(getCurrentUser).mockReset();
  vi.mocked(requireUser).mockReset().mockResolvedValue(ada);
  vi.mocked(readConsentRequest).mockReset();
});

describe("the login page", () => {
  it("sends a signed-in member to the dashboard, and shows no Claude line", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ada);
    await expect(show(LoginPage, {})).rejects.toMatchObject({ digest: expect.stringContaining("/dashboard") });
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    await show(LoginPage, {});
    expect(screen.queryByText("Sign in to connect Claude.")).toBeNull();
  });

  it("keeps a signed-in member on the page while connecting Claude, and says so", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(ada);
    vi.mocked(readConsentRequest).mockResolvedValue({ ok: true, view: { clientName: "Claude", verifiedHost: "claude.ai" } });
    await show(LoginPage, signedRequest);
    expect(screen.getByText("Sign in to connect Claude.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(readConsentRequest)).toHaveBeenCalledWith(expect.anything(), "test-secret", signedRequest);
  });

  it("says so when the connect request has expired or was changed", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    vi.mocked(readConsentRequest).mockResolvedValue({ ok: false });
    await show(LoginPage, signedRequest);
    expect(screen.getByRole("alert").textContent).toBe("This connection request has expired. Go back to Claude and connect again.");
    expect(screen.getByRole("alert").className).toContain("text-red-800");
    expect(screen.queryByText("Sign in to connect Claude.")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
  });

  it("checks no connect request on a plain visit", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    await show(LoginPage, {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(readConsentRequest)).not.toHaveBeenCalled();
  });
});

describe("the consent page", () => {
  const ok = (view: Extract<ConsentRequest, { ok: true }>["view"]): ConsentRequest => ({ ok: true, view });

  it("tells an editor what Claude can do and names the host it trusts", async () => {
    vi.mocked(readConsentRequest).mockResolvedValue(ok({ clientName: "Claude", verifiedHost: "claude.ai" }));
    await show(ConsentPage, signedRequest);
    expect(screen.getByRole("heading").textContent).toBe("Connect Claude");
    expect(screen.getByText("Claude is asking to use EasyEdit as you.")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "It will be able to see the team's projects.",
      "It will be able to create projects and change them. Each change is listed in the editor as “Claude (for Ada)” and can be undone there.",
    ]);
    expect(screen.getByText("Signed in as ada@gmail.com.")).toBeTruthy();
    expect(screen.getByText("The request comes from claude.ai.")).toBeTruthy();
    expect(screen.getByText(/^Only allow this if you just added the connector in your own Claude settings\./).textContent).toBe(
      "Only allow this if you just added the connector in your own Claude settings. If someone sent you a link to this page, choose Don't allow.",
    );
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't allow" })).toBeTruthy();
    expect(vi.mocked(requireUser)).toHaveBeenCalledWith();
    expect(vi.mocked(readConsentRequest)).toHaveBeenCalledWith(expect.anything(), "test-secret", signedRequest);
  });

  it("tells a viewer Claude cannot change anything, and does not vouch for a self-named app", async () => {
    vi.mocked(requireUser).mockResolvedValue({ ...ada, role: "viewer" });
    vi.mocked(readConsentRequest).mockResolvedValue(ok({ clientName: "Helper", verifiedHost: null }));
    await show(ConsentPage, signedRequest);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "It will be able to see the team's projects.",
      "Your role is viewer, so it will not be able to change anything.",
    ]);
    expect(screen.getByText("The request comes from an app that calls itself “Helper”. EasyEdit cannot confirm who runs it.")).toBeTruthy();
  });

  it("shows only that the request has expired when it cannot be read", async () => {
    vi.mocked(readConsentRequest).mockResolvedValue({ ok: false });
    await show(ConsentPage, signedRequest);
    expect(document.body.textContent).toBe("This request has expired. Go back to Claude and connect again.");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

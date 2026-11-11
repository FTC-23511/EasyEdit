// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { ConsentButtons } from "@/app/(auth)/consent/consent-buttons";
import { decideConsent } from "@/lib/connector/consent-client";
import { fireEvent, render, screen, waitFor } from "../helpers/dom";

vi.mock("@/lib/connector/consent-client", () => ({ decideConsent: vi.fn() }));
const decide = vi.mocked(decideConsent);

it("Allow sends yes and goes where the server says", async () => {
  decide.mockResolvedValueOnce({ url: "https://claude.ai/api/mcp/auth_callback?code=c1" });
  const navigate = vi.fn();
  render(<ConsentButtons navigate={navigate} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://claude.ai/api/mcp/auth_callback?code=c1"));
  expect(decide).toHaveBeenCalledWith(true);
});

it("Don't allow sends no", async () => {
  decide.mockResolvedValueOnce({ url: "https://claude.ai/api/mcp/auth_callback?error=access_denied" });
  const navigate = vi.fn();
  render(<ConsentButtons navigate={navigate} />);
  fireEvent.click(screen.getByRole("button", { name: "Don't allow" }));
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  expect(decide).toHaveBeenCalledWith(false);
});

it("a failure says so and goes nowhere", async () => {
  decide.mockResolvedValueOnce({ error: true });
  const navigate = vi.fn();
  render(<ConsentButtons navigate={navigate} />);
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That didn't work. Go back to Claude and connect again.");
  expect(navigate).not.toHaveBeenCalled();
});

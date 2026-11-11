// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KeepSignedIn } from "@/components/keep-signed-in";
import { act, render } from "../helpers/dom";

const HOUR = 60 * 60 * 1000;
let visibility: DocumentVisibilityState;
let fetchMock: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;

async function show(state: DocumentVisibilityState) {
  visibility = state;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  fetchMock = vi.fn(async () => new Response("null"));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("asks the sign-in endpoint once when a signed-in page opens", async () => {
  await act(async () => {
    render(<KeepSignedIn />);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/get-session");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
});

it("asks again when the tab is shown six hours later, and not before", async () => {
  await act(async () => {
    render(<KeepSignedIn />);
  });
  vi.advanceTimersByTime(6 * HOUR - 1000);
  await show("hidden");
  await show("visible");
  expect(fetchMock).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(1000);
  await show("hidden");
  await show("visible");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("waits for a tab opened in the background to be shown", async () => {
  visibility = "hidden";
  await act(async () => {
    render(<KeepSignedIn />);
  });
  expect(fetchMock).not.toHaveBeenCalled();
  await show("visible");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("tries again the next time the tab is shown after a check that failed", async () => {
  fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
  await act(async () => {
    render(<KeepSignedIn />);
  });
  await show("hidden");
  await show("visible");
  await show("hidden");
  await show("visible");
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await show("hidden");
  await show("visible");
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("stops listening when the page is left", async () => {
  let unmount = () => {};
  await act(async () => {
    ({ unmount } = render(<KeepSignedIn />));
  });
  unmount();
  vi.advanceTimersByTime(7 * HOUR);
  await show("visible");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

/**
 * An OS-popup click arrives over IPC (Electron). The bridge must run it through
 * the shared open-notification code, and distrust what it was handed.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const markNotificationRead = vi.fn(async () => undefined);
let deliver: (click: { notificationId: string; path: string | null }) => void = () => {};
const onNotificationClick = vi.fn((cb: typeof deliver) => {
  deliver = cb;
  return () => {};
});
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: { markNotificationRead }, config: { onNotificationClick } }) }));

import { NotificationClickBridge } from "./NotificationClickBridge";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHANNEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MESSAGE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/app/mail"]}>
        <NotificationClickBridge />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("NotificationClickBridge", () => {
  it("marks the notification read and opens its target, message included", async () => {
    markNotificationRead.mockClear();
    const view = mount();
    deliver({ notificationId: ID, path: `/app/channels/${CHANNEL}?m=${MESSAGE}` });
    expect(markNotificationRead).toHaveBeenCalledWith(ID);
    await vi.waitFor(() => expect(view.getByTestId("where").textContent).toBe(`/app/channels/${CHANNEL}?m=${MESSAGE}`));
  });

  it("marks it read but stays put when it leads nowhere", () => {
    markNotificationRead.mockClear();
    const view = mount();
    deliver({ notificationId: ID, path: null });
    expect(markNotificationRead).toHaveBeenCalledWith(ID);
    expect(view.getByTestId("where").textContent).toBe("/app/mail");
  });

  it("refuses a route the app could not have produced, but still marks it read", () => {
    markNotificationRead.mockClear();
    const view = mount();
    deliver({ notificationId: ID, path: "//evil.example" });
    expect(markNotificationRead).toHaveBeenCalledWith(ID);
    expect(view.getByTestId("where").textContent).toBe("/app/mail");
  });

  it("ignores a click whose id is not a UUID", () => {
    markNotificationRead.mockClear();
    const view = mount();
    deliver({ notificationId: "../../x", path: `/app/channels/${CHANNEL}` });
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(view.getByTestId("where").textContent).toBe("/app/mail");
  });
});

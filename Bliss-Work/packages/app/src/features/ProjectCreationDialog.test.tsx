/**
 * The standalone "+ New Project" dialog (Section 6.4): a name plus one or
 * more existing channels, created with no task involved. Covers the
 * client-side member-count pre-check, submission payload, and success/error
 * handling — POST /api/v1/projects's own validation is covered server-side
 * in task-svc's tests/integration/test_create_project_standalone.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeChannels, pagedChannels, stubScrollGeometry } from "../test/pagedPickerApi";

const h = vi.hoisted(() => ({ api: { channelsPage: vi.fn(), createProject: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from "sonner";
import { ProjectCreationDialog } from "./ProjectCreationDialog";

const onClose = vi.fn();
const onCreated = vi.fn();
let restoreGeometry: () => void;

function mount(open = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ProjectCreationDialog open={open} onClose={onClose} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  restoreGeometry = stubScrollGeometry();
  h.api.channelsPage.mockReset().mockImplementation(pagedChannels(makeChannels(10, 1)));
  h.api.createProject.mockReset().mockResolvedValue({
    id: "proj-1",
    name: "Website Redesign",
    channelId: "team-000",
    channelIds: ["team-000"],
    status: "ACTIVE",
    canComplete: true,
  });
  onClose.mockReset();
  onCreated.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
});
afterEach(() => restoreGeometry());

describe("validation", () => {
  it("refuses to submit with no name", async () => {
    const user = mount();
    await user.click(await screen.findByRole("checkbox", { name: /team-001/ }));
    // The name field's own `required` attribute would otherwise block a real
    // click via native constraint validation before React ever sees the
    // submit — firing the form's submit event directly reaches the JS-level
    // check instead (same trap as CreateTaskDialog.test.tsx).
    fireEvent.submit(document.querySelector("form")!);
    expect(toast.error).toHaveBeenCalledWith("Give the project a name");
    expect(h.api.createProject).not.toHaveBeenCalled();
  });

  it("refuses to submit with no channel picked", async () => {
    const user = mount();
    await user.type(screen.getByPlaceholderText("Name this project"), "Website Redesign");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(toast.error).toHaveBeenCalledWith("Pick at least one channel");
    expect(h.api.createProject).not.toHaveBeenCalled();
  });

  it("refuses to pick a channel with fewer than 2 members, client-side, before ever submitting", async () => {
    h.api.channelsPage.mockReset().mockResolvedValue([
      { id: "lonely", name: "lonely-channel", memberCount: 1, lastMessage: null, lastMessageAt: null },
    ]);
    const user = mount();
    await user.click(await screen.findByRole("checkbox", { name: /lonely-channel/ }));
    expect(toast.error).toHaveBeenCalledWith("#lonely-channel needs at least 2 members to be part of a project");
    expect(screen.getByRole("checkbox", { name: /lonely-channel/ })).not.toBeChecked();
  });
});

describe("creating", () => {
  it("creates the project with the picked name and channels, and reports it", async () => {
    const user = mount();
    await user.type(screen.getByPlaceholderText("Name this project"), "Website Redesign");
    await user.click(await screen.findByRole("checkbox", { name: /team-001/ }));
    await user.click(screen.getByRole("checkbox", { name: /team-002/ }));

    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(h.api.createProject).toHaveBeenCalledTimes(1));
    const [name, channelIds] = h.api.createProject.mock.calls[0]!;
    expect(name).toBe("Website Redesign");
    expect(channelIds.sort()).toEqual(makeChannels(2, 1).map((c) => c.id).sort());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "proj-1" })));
    expect(onClose).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Project "Website Redesign" created');
  });

  it("a failure keeps the dialog open with the selection intact", async () => {
    h.api.createProject.mockRejectedValueOnce(new Error("boom"));
    const user = mount();
    await user.type(screen.getByPlaceholderText("Name this project"), "Website Redesign");
    await user.click(await screen.findByRole("checkbox", { name: /team-001/ }));
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not create project", expect.anything()));
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: /team-001/ })).toBeChecked();
  });

  it("does not fetch channels at all while closed", () => {
    mount(false);
    expect(h.api.channelsPage).not.toHaveBeenCalled();
  });

  it("un-ticking a picked channel removes it from the submission", async () => {
    const user = mount();
    await user.type(screen.getByPlaceholderText("Name this project"), "Solo Channel Project");
    const checkbox = await screen.findByRole("checkbox", { name: /team-001/ });
    await user.click(checkbox);
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(toast.error).toHaveBeenCalledWith("Pick at least one channel");
  });
});

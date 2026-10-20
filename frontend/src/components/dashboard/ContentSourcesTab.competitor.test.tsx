import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMockContentSourcesClient } from "../../lib/contentSourcesMock";

// Competitor mode sits behind its own build setting, VITE_COMPETITOR_MODE_ENABLED, off unless it is exactly "true".
// The section is a stub here: these tests only pin whether the tab shows it.

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("./CompetitorSection");
});

async function renderTab(flag: string | undefined, onRefreshPosts = vi.fn()) {
  vi.resetModules();
  if (flag === undefined) vi.stubEnv("VITE_COMPETITOR_MODE_ENABLED", "");
  else vi.stubEnv("VITE_COMPETITOR_MODE_ENABLED", flag);
  vi.doMock("./CompetitorSection", () => ({
    default: ({ onSaved }: { onSaved?: () => void }) => (
      <button type="button" onClick={onSaved}>
        COMPETITOR SECTION STUB
      </button>
    ),
  }));
  const { ContentSourcesTab } = await import("./ContentSourcesTab");
  const handlers = { onReviewAndEdit: vi.fn(), onApproveToCalendar: vi.fn(), onPurge: vi.fn() };
  render(<ContentSourcesTab posts={[]} brands={[]} client={createMockContentSourcesClient()} onRefreshPosts={onRefreshPosts} {...handlers} />);
  await screen.findByRole("heading", { name: "Add a source" });
  return { onRefreshPosts };
}

describe("the competitor mode build setting", () => {
  it.each([undefined, "false", "TRUE", "1", "yes"])("shows nothing of it when the setting is %j", async (flag) => {
    await renderTab(flag);
    expect(screen.queryByText("COMPETITOR SECTION STUB")).toBeNull();
  });

  it("shows the section, and hands it the post refresh, when the setting is exactly true", async () => {
    const { onRefreshPosts } = await renderTab("true");
    const stub = await screen.findByText("COMPETITOR SECTION STUB");
    stub.click();
    await waitFor(() => expect(onRefreshPosts).toHaveBeenCalledTimes(1));
  });
});

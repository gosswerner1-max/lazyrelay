import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PlatformOptions } from "./PlatformOptions";
import { optionGroupsFor, type PostOptions } from "../lib/postOptions";

vi.mock("../lib/api", () => ({ api: { uploadMedia: vi.fn(async () => ({ url: "https://cdn/deck.pdf" })) } }));
afterEach(cleanup);

// A tiny host that keeps the options in state like the composer does.
function Host({ platforms, mediaUrl = null, hasExtraMedia = false, onValue }: { platforms: string[]; mediaUrl?: string | null; hasExtraMedia?: boolean; onValue?: (v: PostOptions) => void }) {
  const [value, setValue] = useState<PostOptions>({});
  return (
    <PlatformOptions
      groups={optionGroupsFor(platforms)}
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
      mediaUrl={mediaUrl}
      hasExtraMedia={hasExtraMedia}
      onError={() => {}}
    />
  );
}

describe("PlatformOptions", () => {
  it("shows nothing when no selected platform has options", () => {
    const { container } = render(<Host platforms={["pinterest", "tumblr"]} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a group only for the platforms selected", () => {
    render(<Host platforms={["tiktok", "youtube"]} />);
    expect(screen.getByText(/AI-generated \(adds TikTok's AI label\)/)).toBeTruthy();
    expect(screen.getByText("Who can see it")).toBeTruthy();
    expect(screen.queryByText("Thread (", { exact: false })).toBeNull();
  });

  it("YouTube: choosing unlisted and a kids answer updates the options; leaving kids on channel default sends nothing", async () => {
    const seen: PostOptions[] = [];
    render(<Host platforms={["youtube"]} onValue={(v) => seen.push(v)} />);
    await userEvent.selectOptions(screen.getByLabelText("Who can see it"), "unlisted");
    await userEvent.selectOptions(screen.getByLabelText("Made for kids?"), "no");
    expect(seen.at(-1)?.youtube).toEqual({ privacy: "unlisted", madeForKids: false });
    await userEvent.selectOptions(screen.getByLabelText("Made for kids?"), "");
    expect(seen.at(-1)?.youtube).toEqual({ privacy: "unlisted" });
  });

  it("YouTube tags are split on commas", async () => {
    const seen: PostOptions[] = [];
    render(<Host platforms={["youtube"]} onValue={(v) => seen.push(v)} />);
    await userEvent.type(screen.getByLabelText(/^Tags/), "how to, tips");
    expect(seen.at(-1)?.youtube?.tags).toEqual(["how to", "tips"]);
  });

  it("Instagram: Story is offered only with a single media file, Reel and trial only for a video", async () => {
    const { unmount } = render(<Host platforms={["instagram"]} mediaUrl="https://x/a.jpg" />);
    const select = screen.getByLabelText("Post as") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["Feed post", "Story"]);
    expect(screen.queryByText(/Trial reel/)).toBeNull();
    unmount();
    render(<Host platforms={["instagram"]} mediaUrl="https://x/a.mp4" />);
    expect([...(screen.getByLabelText("Post as") as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Reel (the default for a video)", "Reel", "Story"]);
    expect(screen.getByText(/Trial reel/)).toBeTruthy();
  });

  it("Instagram: no Story when several images are attached", () => {
    render(<Host platforms={["instagram"]} mediaUrl="https://x/a.jpg" hasExtraMedia />);
    expect([...(screen.getByLabelText("Post as") as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Feed post"]);
  });

  it("thread: add, edit and remove follow-ups, with the shortest limit shown", async () => {
    const seen: PostOptions[] = [];
    render(<Host platforms={["threads", "bluesky"]} onValue={(v) => seen.push(v)} />);
    expect(screen.getByText(/Each can be up to 300 characters/)).toBeTruthy();
    await userEvent.click(screen.getByText("Add a follow-up post"));
    await userEvent.type(screen.getByPlaceholderText("Follow-up 1"), "Part two");
    expect(seen.at(-1)?.chain).toEqual(["Part two"]);
    await userEvent.click(screen.getByText("Remove"));
    expect(seen.at(-1)?.chain).toEqual([]);
  });

  it("LinkedIn: attaching a PDF stores its address; not offered while an image is attached", async () => {
    const { unmount } = render(<Host platforms={["linkedin"]} />);
    await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, new File(["%PDF"], "deck.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/PDF attached/)).toBeTruthy();
    unmount();
    render(<Host platforms={["linkedin"]} mediaUrl="https://x/a.jpg" />);
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/PDF or images, not both/)).toBeTruthy();
  });
});

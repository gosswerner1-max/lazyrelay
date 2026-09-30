import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MoreImages } from "./MoreImages";
import { carouselPlan } from "../lib/carousel";

const uploadMedia = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ api: { uploadMedia } }));

// Vitest globals are off here, so testing-library does not auto-clean between tests.
afterEach(() => {
  cleanup();
  uploadMedia.mockReset();
});

const file = (name: string) => new File(["x"], name, { type: "image/png" });

describe("MoreImages", () => {
  it("explains the limits of the selected platforms", () => {
    render(<MoreImages plan={carouselPlan(["instagram", "bluesky", "tiktok"])} urls={[]} setUrls={() => {}} onError={() => {}} />);
    expect(screen.getByText(/Up to 3 more \(Instagram 10, Bluesky 4 in total\)\. Images only\. TikTok will post the main image only\./)).toBeTruthy();
  });

  it("uploads chosen files in order and hands back the new list", async () => {
    uploadMedia.mockResolvedValueOnce({ url: "https://cdn/x1.png" }).mockResolvedValueOnce({ url: "https://cdn/x2.png" });
    const setUrls = vi.fn();
    render(<MoreImages plan={carouselPlan(["instagram"])} urls={["https://cdn/a.png"]} setUrls={setUrls} onError={() => {}} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, [file("1.png"), file("2.png")]);
    await waitFor(() => expect(setUrls).toHaveBeenCalledWith(["https://cdn/a.png", "https://cdn/x1.png", "https://cdn/x2.png"]));
  });

  it("only takes as many files as fit", async () => {
    uploadMedia.mockResolvedValue({ url: "https://cdn/new.png" });
    const setUrls = vi.fn();
    // Bluesky allows 4 in total: 3 extras, 2 already added, so only 1 more fits.
    render(<MoreImages plan={carouselPlan(["bluesky"])} urls={["https://cdn/a.png", "https://cdn/b.png"]} setUrls={setUrls} onError={() => {}} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, [file("1.png"), file("2.png"), file("3.png")]);
    await waitFor(() => expect(setUrls).toHaveBeenCalled());
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(setUrls.mock.calls[0][0]).toHaveLength(3);
  });

  it("hides the add button when full, and removing an image works", async () => {
    const setUrls = vi.fn();
    render(<MoreImages plan={carouselPlan(["bluesky"])} urls={["https://cdn/a.png", "https://cdn/b.png", "https://cdn/c.png"]} setUrls={setUrls} onError={() => {}} />);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    await userEvent.click(screen.getAllByText("Remove")[1]);
    expect(setUrls).toHaveBeenCalledWith(["https://cdn/a.png", "https://cdn/c.png"]);
  });

  it("offers videos only where every selected platform allows them", () => {
    const { unmount } = render(<MoreImages plan={carouselPlan(["instagram", "threads"])} urls={[]} setUrls={() => {}} onError={() => {}} />);
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).accept).toContain("video/mp4");
    unmount();
    render(<MoreImages plan={carouselPlan(["instagram", "facebook"])} urls={[]} setUrls={() => {}} onError={() => {}} />);
    expect((document.querySelector('input[type="file"]') as HTMLInputElement).accept).not.toContain("video");
  });

  it("reports an upload failure instead of losing it", async () => {
    uploadMedia.mockRejectedValueOnce(new Error("File too large"));
    const onError = vi.fn();
    render(<MoreImages plan={carouselPlan(["instagram"])} urls={[]} setUrls={() => {}} onError={onError} />);
    await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, [file("big.png")]);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("File too large"));
  });
});

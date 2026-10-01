import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ applyForReferralProgram: vi.fn() }));
vi.mock("../lib/api", () => ({ api }));

import { ReferralApplicationModal } from "./ReferralApplicationModal";

afterEach(cleanup);
beforeEach(() => {
  api.applyForReferralProgram.mockReset();
  api.applyForReferralProgram.mockResolvedValue(undefined);
});

describe("ReferralApplicationModal", () => {
  it("asks the vetting questions and sends every answer", async () => {
    render(<ReferralApplicationModal onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Name"), "Sam");
    await userEvent.type(screen.getByLabelText("Channel or handle"), "@sam");
    await userEvent.type(screen.getByLabelText("Platform"), "YouTube");
    await userEvent.type(screen.getByLabelText("Link to your channel or website"), "https://youtube.com/@sam");
    await userEvent.type(screen.getByLabelText("Audience size"), "12,000 subscribers");
    await userEvent.type(screen.getByLabelText("Where is your audience mainly?"), "South Africa");
    await userEvent.type(screen.getByLabelText("How would you promote LazyRelay?"), "A video review");
    await userEvent.selectOptions(screen.getByLabelText("Which plan interests you?"), "B");
    await userEvent.type(screen.getByLabelText("Email"), "sam@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Submit application" }));
    await waitFor(() => expect(api.applyForReferralProgram).toHaveBeenCalledTimes(1));
    expect(api.applyForReferralProgram).toHaveBeenCalledWith({
      name: "Sam",
      channel: "@sam",
      platform: "YouTube",
      email: "sam@example.org",
      message: "",
      channelLink: "https://youtube.com/@sam",
      audienceSize: "12,000 subscribers",
      audienceCountries: "South Africa",
      preferredPlan: "B",
      howPromote: "A video review",
    });
    expect(await screen.findByText(/we'll review it/)).toBeInTheDocument();
  });

  it("does not send until the required questions are answered", async () => {
    render(<ReferralApplicationModal onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText("Name"), "Sam");
    await userEvent.click(screen.getByRole("button", { name: "Submit application" }));
    expect(api.applyForReferralProgram).not.toHaveBeenCalled();
  });

  it("tells applicants how their details are used", () => {
    render(<ReferralApplicationModal onClose={() => {}} />);
    expect(screen.getByText(/only to review your application/)).toBeInTheDocument();
  });
});

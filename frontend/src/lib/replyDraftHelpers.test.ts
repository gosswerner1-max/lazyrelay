import { describe, it, expect } from "vitest";
import { canApprove, categoryLabel, currentText, editedTextToSend, excerpt, expiryLabel, wordingState } from "./replyDraftHelpers";

const draft = (over: Partial<{ id: string; draftText: string | null; replyLimit: number }> = {}) => ({ id: "d1", draftText: "Thanks for asking!", replyLimit: 300, ...over });

describe("wordingState", () => {
  it("counts without the spaces at either end", () => {
    expect(wordingState("  hello  ", 300)).toEqual({ count: 5, limit: 300, empty: false, over: false });
  });
  it("empty and spaces-only are empty", () => {
    expect(wordingState("", 300).empty).toBe(true);
    expect(wordingState("   \n ", 300).empty).toBe(true);
  });
  it("exactly the limit fits, one more does not", () => {
    expect(wordingState("a".repeat(300), 300).over).toBe(false);
    expect(wordingState("a".repeat(301), 300).over).toBe(true);
  });
});

describe("currentText", () => {
  it("typed text wins, then the suggestion, then nothing", () => {
    expect(currentText(draft(), { d1: "mine" })).toBe("mine");
    expect(currentText(draft(), {})).toBe("Thanks for asking!");
    expect(currentText(draft({ draftText: null }), {})).toBe("");
  });
  it("an emptied box stays empty: clearing the text is not 'fall back to the suggestion'", () => {
    expect(currentText(draft(), { d1: "" })).toBe("");
  });
  it("only this draft's typed text is used", () => {
    expect(currentText(draft(), { other: "not mine" })).toBe("Thanks for asking!");
  });
});

describe("canApprove", () => {
  it("allows the suggestion as it is", () => expect(canApprove(draft(), {})).toBe(true));
  it("blocks an emptied box, spaces only, and a reply over the platform limit", () => {
    expect(canApprove(draft(), { d1: "" })).toBe(false);
    expect(canApprove(draft(), { d1: "   " })).toBe(false);
    expect(canApprove(draft({ replyLimit: 10 }), { d1: "this is way too long" })).toBe(false);
  });
  it("a 'needs input' draft cannot be approved until the owner writes something", () => {
    expect(canApprove(draft({ draftText: null }), {})).toBe(false);
    expect(canApprove(draft({ draftText: null }), { d1: "Yes, we do." })).toBe(true);
  });
});

describe("editedTextToSend", () => {
  it("sends nothing when the suggestion is kept exactly", () => {
    expect(editedTextToSend(draft(), {})).toBeNull();
    expect(editedTextToSend(draft(), { d1: "Thanks for asking!" })).toBeNull();
    expect(editedTextToSend(draft(), { d1: "  Thanks for asking!  " })).toBeNull();
  });
  it("sends the owner's own wording, trimmed", () => {
    expect(editedTextToSend(draft(), { d1: "  Thanks, see you soon  " })).toBe("Thanks, see you soon");
  });
  it("a 'needs input' draft always sends what the owner wrote", () => {
    expect(editedTextToSend(draft({ draftText: null }), { d1: "Yes, we do." })).toBe("Yes, we do.");
    expect(editedTextToSend(draft({ draftText: null }), {})).toBeNull();
  });
});

describe("expiryLabel", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  it.each([
    ["2026-10-07T18:00:00Z", "Expires today"],
    ["2026-10-08T18:00:00Z", "Expires tomorrow"],
    ["2026-10-12T13:00:00Z", "Expires in 5 days"],
    ["2026-10-07T11:00:00Z", "Expired"],
    ["nonsense", ""],
  ])("%s", (when, label) => expect(expiryLabel(when, now)).toBe(label));
});

describe("small text helpers", () => {
  it("labels the comment kinds and falls back for unknown ones", () => {
    expect(categoryLabel("sales_question")).toBe("Sales question");
    expect(categoryLabel("question")).toBe("Question");
    expect(categoryLabel("routine")).toBe("Routine");
    expect(categoryLabel("something_new")).toBe("Comment");
  });
  it("cuts a long post to one short line", () => {
    expect(excerpt("a\n\nb   c")).toBe("a b c");
    const cut = excerpt("x".repeat(500), 140);
    expect(cut.length).toBe(140);
    expect(cut.endsWith("…")).toBe(true);
    expect(excerpt("short")).toBe("short");
  });
});

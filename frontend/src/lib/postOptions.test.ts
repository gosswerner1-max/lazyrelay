import { describe, it, expect } from "vitest";
import { optionGroupsFor, chainLimitFor, cleanOptions, optionsFieldFor, optionsFieldForDraft, parseTagList, describeOptions } from "./postOptions";

describe("optionGroupsFor", () => {
  it("shows a group only for the platforms selected", () => {
    const g = optionGroupsFor(["tiktok", "threads", "bluesky", "pinterest"]);
    expect(g).toMatchObject({ tiktok: true, youtube: false, instagram: false, facebook: false, linkedin: false });
    expect(g.chainPlatforms).toEqual(["threads", "bluesky"]);
  });
  it("copes with nothing selected", () => {
    expect(optionGroupsFor([undefined])).toMatchObject({ tiktok: false, chainPlatforms: [] });
  });
});

describe("chainLimitFor", () => {
  it("uses the shortest limit so one text fits every selected thread platform", () => {
    expect(chainLimitFor(["threads", "mastodon"])).toBe(500);
    expect(chainLimitFor(["threads", "bluesky", "x"])).toBe(280);
    expect(chainLimitFor([])).toBe(0);
  });
});

describe("cleanOptions", () => {
  it("drops empty settings and blank follow-ups", () => {
    expect(cleanOptions({ tiktok: { aiGenerated: false }, youtube: { title: "", tags: [] }, chain: [" a ", "", "b"] })).toEqual({ chain: ["a", "b"] });
  });
  it("keeps real values, including a made-for-kids answer of false", () => {
    expect(cleanOptions({ youtube: { privacy: "unlisted", madeForKids: false, aiGenerated: false } })).toEqual({ youtube: { privacy: "unlisted", madeForKids: false } });
  });
});

describe("optionsFieldFor", () => {
  const all = { tiktok: { aiGenerated: true }, chain: ["two"], instagram: { placement: "story" as const } };
  it("sends only the key the post's own platform reads", () => {
    expect(optionsFieldFor("tiktok", all)).toEqual({ options: { tiktok: { aiGenerated: true } } });
    expect(optionsFieldFor("bluesky", all)).toEqual({ options: { chain: ["two"] } });
    expect(optionsFieldFor("instagram", all)).toEqual({ options: { instagram: { placement: "story" } } });
  });
  it("sends nothing for a platform with no options, or when unset", () => {
    expect(optionsFieldFor("pinterest", all)).toEqual({});
    expect(optionsFieldFor("youtube", all)).toEqual({});
    expect(optionsFieldFor(undefined, all)).toEqual({});
  });
});

describe("optionsFieldForDraft and parseTagList", () => {
  it("a draft keeps every group", () => {
    expect(optionsFieldForDraft({ tiktok: { aiGenerated: true }, chain: ["x"] })).toEqual({ options: { tiktok: { aiGenerated: true }, chain: ["x"] } });
  });
  it("splits the tags box", () => {
    expect(parseTagList("#Tips, how to,tips, ")).toEqual(["Tips", "how to", "tips"]);
  });
});

describe("describeOptions", () => {
  it("says nothing for none", () => {
    expect(describeOptions(null)).toEqual([]);
    expect(describeOptions({})).toEqual([]);
  });
  it("describes the choices in plain words", () => {
    expect(describeOptions({ youtube: { privacy: "unlisted", madeForKids: true }, instagram: { placement: "story" }, facebook: { placement: "story" } })).toEqual([
      "YouTube: unlisted",
      "Made for kids",
      "Instagram Story",
      "Facebook Story",
    ]);
    expect(describeOptions({ instagram: { trialReel: true, trialGraduation: "auto" } })).toEqual(["Trial reel (graduates automatically)"]);
  });
  it("shows how a thread went", () => {
    const o = { chain: ["b", "c", "d"] };
    expect(describeOptions(o)).toEqual(["Thread: 4 posts"]);
    expect(describeOptions(o, { posted: 3, error: null })).toEqual(["Thread: 4 posts"]);
    expect(describeOptions(o, { posted: 1, error: "Duplicate content" })).toEqual(["Thread: 1 of 3 follow-ups posted (Duplicate content)"]);
  });
});

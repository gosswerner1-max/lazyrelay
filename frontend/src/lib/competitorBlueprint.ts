// The blueprint the service sends back, read with care, and the plain words the screen and the copy button use.
// Nothing here talks to a network. Only the lazily loaded competitor section imports this file.

export const BASED_ON_TEXT = "Based on the public text of the page. AI can make mistakes.";
const NO_SECTIONS = "No clear sections were found.";
const NO_ADJUSTMENTS = "No changes to suggest for this page.";

export type HookType = "question" | "statistic" | "bold_claim" | "story" | "how_to" | "list" | "problem_agitate" | "social_proof" | "offer" | "other";
export type CtaPlacement = "top" | "middle" | "bottom" | "multiple" | "none";

export interface BlueprintSection {
  order: number;
  role: string;
  summary: string;
}

export interface Blueprint {
  hook: { type: HookType; note: string };
  sections: BlueprintSection[];
  cta: { placement: CtaPlacement; style: string; count: number };
  adjustments: string[];
}

export interface CompetitorBlueprint {
  kind: "page";
  sourceUrl: string;
  title: string;
  blueprint: Blueprint;
  creditsUsed: number;
}

export const HOOK_LABELS: Record<HookType, string> = {
  question: "Opens with a question",
  statistic: "Opens with a statistic",
  bold_claim: "Opens with a bold claim",
  story: "Opens with a story",
  how_to: "Opens by promising how to do something",
  list: "Opens with a list",
  problem_agitate: "Opens with a problem and why it hurts",
  social_proof: "Opens with proof from other people",
  offer: "Opens with an offer",
  other: "Opens in its own way",
};

export const CTA_PLACEMENT_LABELS: Record<CtaPlacement, string> = {
  top: "Near the top",
  middle: "In the middle",
  bottom: "At the bottom",
  multiple: "In several places",
  none: "No clear call to action",
};

const isHookType = (v: unknown): v is HookType => typeof v === "string" && Object.hasOwn(HOOK_LABELS, v);
const isPlacement = (v: unknown): v is CtaPlacement => typeof v === "string" && Object.hasOwn(CTA_PLACEMENT_LABELS, v);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");

export const hookLabel = (type: HookType): string => HOOK_LABELS[type];

/** How many action links were found, in plain words. The count is the page's own total, so repeats are possible. */
function linksFound(count: number): string {
  if (count === 0) return "No action links found";
  if (count === 1) return "One action link found";
  return `About ${count} action links found on the page (some repeat)`;
}

/** The call to action in one plain line, for example "At the bottom. A single button. One action link found." */
export function ctaLine(cta: Blueprint["cta"]): string {
  const label = CTA_PLACEMENT_LABELS[cta.placement];
  if (cta.placement === "none" && cta.style === "" && cta.count === 0) return `${label}.`;
  const parts = [label];
  if (cta.style !== "") parts.push(cta.style.replace(/[.\s]+$/, ""));
  parts.push(linksFound(cta.count));
  return `${parts.join(". ")}.`;
}

function readSections(v: unknown): BlueprintSection[] {
  if (!Array.isArray(v)) return [];
  const found: BlueprintSection[] = [];
  for (const row of v) {
    if (!isObject(row) || typeof row.order !== "number" || !Number.isFinite(row.order)) continue;
    if (typeof row.role !== "string" || typeof row.summary !== "string") continue;
    found.push({ order: row.order, role: row.role, summary: row.summary });
  }
  return found.sort((a, b) => a.order - b.order);
}

function readCta(v: unknown): Blueprint["cta"] {
  const cta = isObject(v) ? v : {};
  const count = typeof cta.count === "number" && Number.isFinite(cta.count) && cta.count > 0 ? Math.floor(cta.count) : 0;
  return { placement: isPlacement(cta.placement) ? cta.placement : "none", style: text(cta.style), count };
}

/** The service's answer, or null when it is not a blueprint at all. Missing or odd parts inside it become empty, never a crash. */
export function readBlueprint(v: unknown): CompetitorBlueprint | null {
  if (!isObject(v) || !isObject(v.blueprint)) return null;
  const { kind, sourceUrl, title, creditsUsed, blueprint } = v;
  if (kind !== "page" || typeof sourceUrl !== "string" || typeof title !== "string") return null;
  if (typeof creditsUsed !== "number" || !Number.isFinite(creditsUsed)) return null;
  const hook = isObject(blueprint.hook) ? blueprint.hook : {};
  return {
    kind,
    sourceUrl,
    title,
    creditsUsed,
    blueprint: {
      hook: isHookType(hook.type) ? { type: hook.type, note: text(hook.note) } : { type: "other", note: "" },
      sections: readSections(blueprint.sections),
      cta: readCta(blueprint.cta),
      adjustments: Array.isArray(blueprint.adjustments) ? blueprint.adjustments.filter((a): a is string => typeof a === "string") : [],
    },
  };
}

/** Both columns as plain text, for the Copy blueprint button. Holds only what is on the screen. */
export function blueprintToText(result: CompetitorBlueprint): string {
  const { hook, sections, cta, adjustments } = result.blueprint;
  const opening = [hookLabel(hook.type) + ".", hook.note].filter((s) => s !== "").join(" ");
  const lines = [
    "Competitor content blueprint",
    result.title,
    result.sourceUrl,
    "",
    "Competitor structure",
    `Opening: ${opening}`,
    "Sections:",
    ...(sections.length === 0 ? [NO_SECTIONS] : sections.map((s, i) => `${i + 1}. ${s.role}: ${s.summary}`)),
    `Call to action: ${ctaLine(cta)}`,
    "",
    "Recommended adjustments",
    ...(adjustments.length === 0 ? [NO_ADJUSTMENTS] : adjustments.map((a) => `- ${a}`)),
    "",
    BASED_ON_TEXT,
  ];
  return lines.join("\n");
}

export { NO_ADJUSTMENTS, NO_SECTIONS };

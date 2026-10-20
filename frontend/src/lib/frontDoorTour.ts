// The "Help me set up" tour of the competitor front door. Targets are marked with data-tour attributes. Step 3 needs the
// balance widget on the page and a balance passed in; without either it is left out.

import type { TourStep } from "./guidedTour";

export const TOUR_TARGET = {
  link: "competitor-link",
  analyze: "competitor-analyze",
  balance: "balance",
} as const;

const target = (name: string) => `[data-tour="${name}"]`;

function creditsText(balance: number): string {
  const noun = balance === 1 ? "credit" : "credits";
  return `You have ${balance.toLocaleString("en-US")} ${noun}. A post costs 1 credit, however many channels it goes to, and a competitor page teardown costs 10 credits.`;
}

export function frontDoorTourSteps(creditBalance?: number): TourStep[] {
  return [
    {
      id: "link",
      selector: target(TOUR_TARGET.link),
      title: "Step 1: Target a Competitor",
      text: "Paste a link to any public website page here. We will show you how it is built: its opening hook, the order of its sections and where its calls to action sit.",
    },
    {
      id: "analyze",
      selector: target(TOUR_TARGET.analyze),
      title: "Step 2: Safety Check",
      text: "When you click Analyze, we ask you to confirm this run is for public market research. No website verification and no password is needed.",
    },
    {
      id: "credits",
      selector: target(TOUR_TARGET.balance),
      title: "Step 3: Your Credits",
      text: creditsText(creditBalance ?? 0),
      onlyIf: () => creditBalance !== undefined,
    },
  ];
}

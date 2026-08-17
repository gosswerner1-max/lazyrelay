// Tests who a support-widget escalation gets attributed to.
//
// Run: npx tsx src/test-support-chat.ts
//
// Why this file exists: three defects landed in the escalation-identity logic
// on 2026-08-17 alone, and every one of them was caught only by pushing a real
// conversation through live production -- a deploy and a row in the support
// inbox per attempt. The logic is pure, so none of that was ever necessary.
//
// The header line these cases exercise is what a human (or the email agent)
// reads first when deciding whether an escalation can be replied to at all.
// Getting it wrong doesn't fail loudly; it produces a confident, wrong
// "Customer:" line that reads exactly like a real lead.
import { extractSelfReportedEmail, type ChatTurn } from "./support/escalationIdentity.js";

type Case = {
  name: string;
  messages: ChatTurn[];
  expected: string | undefined;
};

const user = (content: string): ChatTurn => ({ role: "user", content });
const assistant = (content: string): ChatTurn => ({ role: "assistant", content });

const cases: Case[] = [
  {
    // The live regression. Verbatim from support@ uid 33, 2026-08-17 09:08 UTC.
    // The old code reported "support@lazyrelay.com" as the customer's own
    // self-reported address; it was our own, quoted by the assistant.
    name: "REGRESSION (uid 33) — assistant names our support address, customer never gives one",
    messages: [
      user(
        "For our vendor security file I need to know exactly which data centre region LazyRelay data is stored in, plus the physical address of that facility. Can you confirm both?"
      ),
      assistant(
        "I don't have that information available—I'm an AI assistant with access to product features and troubleshooting docs, not infrastructure or security details. For a vendor security file, you'll need a proper response from our team. Please reach out to **support@lazyrelay.com** or use the contact form on our website."
      ),
      user("No thanks, I'd rather not share that."),
    ],
    expected: undefined,
  },
  {
    // The control for the case above: same shape, no address in the assistant
    // turn. uid 34 already reported this one correctly, so it must stay correct.
    name: "CONTROL (uid 34) — same refusal, assistant prints no address",
    messages: [
      user("For our vendor security file I need the data centre region and physical address."),
      assistant("I don't have that. What's your name and email? I'll pass this to the right people."),
      user("No thanks, I'd rather not share that."),
    ],
    expected: undefined,
  },
  {
    name: "customer hands over their address when asked",
    messages: [
      user("Do you have a SOC 2 report?"),
      assistant("I can't speak to compliance. What's your name and email?"),
      user("Sam Okonkwo, sam.okonkwo@northgate.co.uk"),
    ],
    expected: "sam.okonkwo@northgate.co.uk",
  },
  {
    name: "assistant names our address AND customer gives theirs — theirs wins",
    messages: [
      user("Who do I talk to about a DPA?"),
      assistant("Please email support@lazyrelay.com and they'll help."),
      user("Fine — reach me at priya@acmecorp.example"),
    ],
    expected: "priya@acmecorp.example",
  },
  {
    name: "customer quotes OUR address in their own turn — not a self-report",
    messages: [
      user("I already emailed support@lazyrelay.com about this last week and heard nothing."),
    ],
    expected: undefined,
  },
  {
    name: "customer quotes ours then gives theirs in the SAME turn — theirs wins",
    messages: [
      user("I wrote to support@lazyrelay.com already. Try me on marcus.webb@northgate-test.example instead."),
    ],
    expected: "marcus.webb@northgate-test.example",
  },
  {
    name: "our mail. subdomain is ours too (noreply@mail.lazyrelay.com)",
    messages: [user("I got a mail from noreply@mail.lazyrelay.com and can't reply to it.")],
    expected: undefined,
  },
  {
    // The 2026-08-17 morning fix. Kept covered so it can't silently regress.
    name: "sentence-ending period is not swallowed into the address",
    messages: [user("You can reach me at e2e-verify@example.com.")],
    expected: "e2e-verify@example.com",
  },
  {
    name: "address given several turns earlier still found",
    messages: [
      user("Hi, I'm dana@zephyr.io — quick question about Instagram posting."),
      assistant("Happy to help. What's happening?"),
      user("Posts just stop going out after a while."),
      assistant("That's usually an expired connection."),
      user("Still broken."),
    ],
    expected: "dana@zephyr.io",
  },
  {
    name: "no addresses anywhere",
    messages: [
      user("Why won't my Pinterest board show up?"),
      assistant("Which board are you picking?"),
      user("The one I made yesterday."),
    ],
    expected: undefined,
  },
];

let passed = 0;
let failed = 0;

for (const testCase of cases) {
  const actual = extractSelfReportedEmail(testCase.messages);
  const ok = actual === testCase.expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${testCase.name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${testCase.name}`);
    console.log(`          expected: ${testCase.expected ?? "(none)"}`);
    console.log(`          actual:   ${actual ?? "(none)"}`);
  }
}

console.log(`\n${passed}/${cases.length} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);

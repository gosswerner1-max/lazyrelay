require("dotenv").config();
require("should");
const zapier = require("zapier-platform-core");

const App = require("../index");
const appTester = zapier.createAppTester(App);

// Schedules a REAL post against a real test account (5 minutes out, so it's
// inspectable in the dashboard before it fires) — same "test against the
// real thing, don't mock" pattern the rest of this codebase uses. Requires
// LAZYRELAY_API_KEY and TEST_SOCIAL_ACCOUNT_ID in .env; skips itself rather
// than failing noisily if either is missing (e.g. in a generic CI run).
const canRunLiveTest = process.env.LAZYRELAY_API_KEY && process.env.TEST_SOCIAL_ACCOUNT_ID;

(canRunLiveTest ? describe : describe.skip)("creates.schedule_post", () => {
  it("should schedule a real post on the test account", async () => {
    const bundle = {
      authData: { apiKey: process.env.LAZYRELAY_API_KEY },
      inputData: {
        socialAccountId: process.env.TEST_SOCIAL_ACCOUNT_ID,
        content: "Zapier integration test post — safe to delete.",
        scheduledFor: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    };
    const result = await appTester(App.creates.schedule_post.operation.perform, bundle);
    result.should.have.property("id");
    result.status.should.eql("pending");
  });
});

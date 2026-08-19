require("dotenv").config();
require("should");
const zapier = require("zapier-platform-core");

const App = require("../index");
const appTester = zapier.createAppTester(App);

// Both are genuinely side-effecting against a real account (cancelling a
// real post / posting a real public reply), so both skip themselves unless
// a real test fixture is supplied — same "don't fabricate a live test"
// principle as creates.schedulePost.test.js.
const canRunCancelTest = process.env.LAZYRELAY_API_KEY && process.env.TEST_CANCELLABLE_POST_ID;
const canRunReplyTest = process.env.LAZYRELAY_API_KEY && process.env.TEST_MENTION_POST_ID && process.env.TEST_MENTION_COMMENT_ID;

(canRunCancelTest ? describe : describe.skip)("creates.cancel_post", () => {
  it("should cancel a real pending post", async () => {
    const bundle = {
      authData: { apiKey: process.env.LAZYRELAY_API_KEY },
      inputData: { postId: process.env.TEST_CANCELLABLE_POST_ID },
    };
    const result = await appTester(App.creates.cancel_post.operation.perform, bundle);
    result.cancelled.should.eql(true);
  });
});

(canRunReplyTest ? describe : describe.skip)("creates.reply_to_mention", () => {
  it("should post a real reply to a real comment", async () => {
    const bundle = {
      authData: { apiKey: process.env.LAZYRELAY_API_KEY },
      inputData: {
        postId: process.env.TEST_MENTION_POST_ID,
        commentId: process.env.TEST_MENTION_COMMENT_ID,
        text: "Zapier integration test reply — safe to delete.",
      },
    };
    const result = await appTester(App.creates.reply_to_mention.operation.perform, bundle);
    result.success.should.eql(true);
  });
});

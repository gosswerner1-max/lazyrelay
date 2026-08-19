require("dotenv").config();
require("should");
const zapier = require("zapier-platform-core");

const App = require("../index");
const appTester = zapier.createAppTester(App);

describe("triggers.new_mention", () => {
  it("should fetch a flattened list of comments (may be empty on a fresh test account)", async () => {
    const bundle = { authData: { apiKey: process.env.LAZYRELAY_API_KEY } };
    const results = await appTester(App.triggers.new_mention.operation.perform, bundle);
    Array.isArray(results).should.eql(true);
    results.forEach((mention) => {
      mention.should.have.property("id");
      mention.should.have.property("postId");
      mention.should.have.property("commentId");
    });
  });
});

require("dotenv").config();
require("should");
const zapier = require("zapier-platform-core");

const App = require("../index");
const appTester = zapier.createAppTester(App);

describe("triggers.new_post_published", () => {
  it("should fetch a list of published posts (may be empty on a fresh test account)", async () => {
    const bundle = { authData: { apiKey: process.env.LAZYRELAY_API_KEY } };
    const results = await appTester(App.triggers.new_post_published.operation.perform, bundle);
    Array.isArray(results).should.eql(true);
    results.forEach((post) => {
      post.should.have.property("id");
      post.should.have.property("content");
      post.should.have.property("verifiedLive");
    });
  });
});

describe("triggers.list_social_accounts", () => {
  it("should fetch connected social accounts for the dynamic dropdown", async () => {
    const bundle = { authData: { apiKey: process.env.LAZYRELAY_API_KEY } };
    const results = await appTester(App.triggers.list_social_accounts.operation.perform, bundle);
    Array.isArray(results).should.eql(true);
    results.forEach((account) => {
      account.should.have.property("id");
      account.should.have.property("label");
    });
  });
});

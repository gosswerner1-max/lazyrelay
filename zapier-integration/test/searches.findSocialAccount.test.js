require("dotenv").config();
require("should");
const zapier = require("zapier-platform-core");

const App = require("../index");
const appTester = zapier.createAppTester(App);

describe("searches.find_social_account", () => {
  it("should return accounts optionally filtered by platform", async () => {
    const bundle = { authData: { apiKey: process.env.LAZYRELAY_API_KEY }, inputData: {} };
    const results = await appTester(App.searches.find_social_account.operation.perform, bundle);
    Array.isArray(results).should.eql(true);
    results.forEach((account) => {
      account.should.have.property("id");
      account.should.have.property("platform");
    });
  });
});

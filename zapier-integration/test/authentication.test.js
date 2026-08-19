require("dotenv").config();
require("should");
const zapier = require("zapier-platform-core");

const App = require("../index");
const appTester = zapier.createAppTester(App);

describe("authentication", () => {
  it("should authenticate against a real LazyRelay account", async () => {
    const bundle = { authData: { apiKey: process.env.LAZYRELAY_API_KEY } };
    const response = await appTester(App.authentication.test, bundle);
    response.status.should.eql(200);
  });

  it("should reject a bad key", async () => {
    const bundle = { authData: { apiKey: "lr_not_a_real_key" } };
    let threw = false;
    try {
      await appTester(App.authentication.test, bundle);
    } catch (err) {
      threw = true;
    }
    threw.should.eql(true);
  });
});

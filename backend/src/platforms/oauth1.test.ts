// OAuth 1.0a signing (RFC 5849) against the published example vectors: nothing here touches the network.

import { describe, it, expect } from "vitest";
import { baseStringUri, normalizeParams, oauth1Header, oauth1Params, percentEncode, signatureBaseString } from "./oauth1.js";
import { createXSignedFetch } from "./xApi.js";
import { X_TEST_BUNDLE } from "./xTestKit.js";

describe("percentEncode (RFC 3986)", () => {
  it("leaves only the unreserved characters alone", () => {
    expect(percentEncode("AZaz09-._~")).toBe("AZaz09-._~");
  });
  it("encodes what encodeURIComponent leaves alone, and the rest, with upper-case hex", () => {
    expect(percentEncode("!*'()")).toBe("%21%2A%27%28%29");
    expect(percentEncode("Ladies + Gentlemen")).toBe("Ladies%20%2B%20Gentlemen");
    expect(percentEncode("a/b=c&d@e")).toBe("a%2Fb%3Dc%26d%40e");
    expect(percentEncode("é")).toBe("%C3%A9");
  });
});

describe("RFC 5849 section 3.4.1 example", () => {
  // POST /request?b5=%3D%253D&a3=a&c%40=&a2=r%20b with the form body "c2&a3=2+q" and the oauth_* values from the RFC.
  const url = "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b";
  const pairs: Array<[string, string]> = [
    ...new URL(url).searchParams.entries(),
    ...new URLSearchParams("c2&a3=2+q").entries(),
    ["oauth_consumer_key", "9djdj82h48djs9d2"],
    ["oauth_token", "kkk9d7dh3k39sjv7"],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", "137131201"],
    ["oauth_nonce", "7d8f3e4a"],
  ];

  it("normalises the parameters exactly as the RFC prints them", () => {
    expect(normalizeParams(pairs)).toBe(
      "a2=r%20b&a3=2%20q&a3=a&b5=%3D%253D&c%40=&c2=&oauth_consumer_key=9djdj82h48djs9d2&oauth_nonce=7d8f3e4a&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201&oauth_token=kkk9d7dh3k39sjv7",
    );
  });

  it("builds the signature base string exactly as the RFC prints it", () => {
    expect(signatureBaseString("POST", url, pairs)).toBe(
      "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
    );
  });

  it("normalises the base string URI (case, default port, no query)", () => {
    expect(baseStringUri("HTTP://EXAMPLE.COM:80/r%20v/X?id=123")).toBe("http://example.com/r%20v/X");
    expect(baseStringUri("https://EXAMPLE.net:8080/?q=1")).toBe("https://example.net:8080/");
    expect(baseStringUri("https://api.x.com:443/2/tweets")).toBe("https://api.x.com/2/tweets");
  });
});

describe("X documentation example (Creating a signature)", () => {
  const creds = {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  };
  const input = {
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    formParams: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: "1318622958",
  };

  it("produces the signature X publishes for these inputs", () => {
    expect(oauth1Params(creds, input).oauth_signature).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });

  it("writes an Authorization header with sorted, percent-encoded parameters", () => {
    const header = oauth1Header(creds, input);
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });

  it("changes when a signed query or form value changes, and when a secret changes", () => {
    const base = oauth1Params(creds, input).oauth_signature;
    expect(oauth1Params(creds, { ...input, url: input.url.replace("true", "false") }).oauth_signature).not.toBe(base);
    expect(oauth1Params(creds, { ...input, formParams: { status: "other" } }).oauth_signature).not.toBe(base);
    expect(oauth1Params({ ...creds, tokenSecret: "x" }, input).oauth_signature).not.toBe(base);
    expect(oauth1Params({ ...creds, consumerSecret: "x" }, input).oauth_signature).not.toBe(base);
  });

  it("uses a fresh nonce and the current time when none is forced", () => {
    const a = oauth1Params(creds, { method: "GET", url: "https://api.x.com/2/users/me" });
    const b = oauth1Params(creds, { method: "GET", url: "https://api.x.com/2/users/me" });
    expect(a.oauth_nonce).not.toBe(b.oauth_nonce);
    expect(Math.abs(Number(a.oauth_timestamp) - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe("what is and is not signed on an X request", () => {
  it("signs the query string but not a JSON or multipart body", async () => {
    const seen: Array<{ url: string; auth: string; body: unknown }> = [];
    const signed = createXSignedFetch(X_TEST_BUNDLE, (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: init.body });
      return new Response("{}");
    }) as never);

    await signed({ method: "POST", url: "https://api.x.com/2/tweets", json: { text: "hello & goodbye" } });
    await signed({ method: "GET", url: "https://api.x.com/2/tweets/1?tweet.fields=public_metrics" });
    const form = new FormData();
    form.append("media", new Blob(["x"]));
    await signed({ method: "POST", url: "https://api.x.com/2/media/upload/9/append", multipart: form });

    for (const s of seen) {
      const nonce = /oauth_nonce="([^"]+)"/.exec(s.auth)![1];
      const ts = /oauth_timestamp="([^"]+)"/.exec(s.auth)![1];
      const method = s.url.endsWith("/tweets") || s.url.endsWith("/append") ? "POST" : "GET";
      // Recompute from the URL alone: if the body had been part of the signature this would not match.
      const expected = oauth1Params(
        { consumerKey: X_TEST_BUNDLE.apiKey, consumerSecret: X_TEST_BUNDLE.apiSecret, token: X_TEST_BUNDLE.accessToken, tokenSecret: X_TEST_BUNDLE.accessTokenSecret },
        { method, url: s.url, nonce, timestamp: ts },
      ).oauth_signature;
      expect(decodeURIComponent(/oauth_signature="([^"]+)"/.exec(s.auth)![1])).toBe(expected);
    }
    expect(typeof seen[0].body).toBe("string");
    expect(seen[1].body).toBeUndefined();
    expect(seen[2].body).toBeInstanceOf(FormData);
  });
});

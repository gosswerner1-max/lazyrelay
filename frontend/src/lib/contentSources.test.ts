import { describe, expect, it } from "vitest";
import { URL_MAX_LENGTH, hostIsInternal } from "./contentSources";

// The one thing left here that the competitor box depends on besides the service plumbing: the shared check for private and
// local addresses (the competitor link is checked with it before anything is sent).

describe("URL_MAX_LENGTH", () => {
  it("stays 2048", () => {
    expect(URL_MAX_LENGTH).toBe(2048);
  });
});

describe("hostIsInternal", () => {
  it("is true for localhost, private, link-local and loopback literals", () => {
    const internal = [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "app.localhost",
      "127.0.0.1",
      "127.5.5.5",
      "0.0.0.0",
      "10.0.0.5",
      "192.168.1.10",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254",
      "100.64.0.1",
      "224.0.0.1",
      "[::1]",
      "[::]",
      "[fe80::1]",
      "[fd00::1]",
      "[fc00::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:10.1.2.3]",
    ];
    for (const host of internal) expect(hostIsInternal(host), host).toBe(true);
  });

  it("is false for public names and addresses", () => {
    for (const host of ["example.com", "www.rival.example", "93.184.216.34", "172.32.0.1", "100.128.0.1", "[2606:4700::1111]"]) {
      expect(hostIsInternal(host), host).toBe(false);
    }
  });
});

import { describe, it, expect } from "vitest";
import { isSafeMediaUrl } from "./urlSafety.js";

// Literal IPs need no DNS, so these run offline.
const safe = async (ip: string) => (await isSafeMediaUrl(`https://${ip}/x`)).safe;

describe("isSafeMediaUrl on literal addresses", () => {
  it("blocks private, loopback, link-local and metadata addresses", async () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.1.1", "192.0.0.5", "100.64.0.1", "0.0.0.0"]) {
      expect(await safe(ip), ip).toBe(false);
    }
  });
  it("allows public addresses, including WordPress.com hosting in 192.0.64.0/18", async () => {
    for (const ip of ["8.8.8.8", "192.0.66.108", "192.0.80.1"]) {
      expect(await safe(ip), ip).toBe(true);
    }
  });
  it("requires https", async () => {
    expect((await isSafeMediaUrl("http://8.8.8.8/x")).safe).toBe(false);
  });
});

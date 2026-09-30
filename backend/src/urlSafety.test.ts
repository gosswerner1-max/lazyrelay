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
  it("blocks private IPv6 and every form that hides a private IPv4 (mapped, compatible, NAT64, 6to4)", async () => {
    for (const ip of ["[::1]", "[::]", "[fd00::1]", "[fe80::1]", "[fec0::1]", "[ff02::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::127.0.0.1]", "[64:ff9b::7f00:1]", "[64:ff9b::a9fe:a9fe]", "[2002:7f00:1::]", "[2002:a9fe:a9fe::1]", "[2001:0:4136:e378:8000:63bf:3fff:fdd2]", "[2001:db8::1]"]) {
      expect(await safe(ip), ip).toBe(false);
    }
  });
  it("allows public IPv6 and public IPv4 carried inside IPv6 forms", async () => {
    for (const ip of ["[2606:4700:4700::1111]", "[2a00:1450:4001:81b::200e]", "[::ffff:8.8.8.8]", "[64:ff9b::808:808]", "[2002:808:808::1]"]) {
      expect(await safe(ip), ip).toBe(true);
    }
  });
  it("requires https", async () => {
    expect((await isSafeMediaUrl("http://8.8.8.8/x")).safe).toBe(false);
  });
});

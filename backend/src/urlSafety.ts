import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/** Blocks LazyRelay's own backend from being used as an SSRF proxy via any
 *  customer-supplied URL that the server itself fetches server-side (today:
 *  mediaUrl/coverImageUrl on a scheduled post, which the scheduler passes to
 *  each platform adapter's own fetch() call). Requires https:// and rejects
 *  any hostname that resolves to a private, loopback, link-local, or other
 *  non-public address — including the 169.254.169.254 cloud metadata
 *  endpoint, which is exactly the kind of target this exists to block.
 *
 *  Resolves the hostname itself (rather than only pattern-matching it)
 *  since a customer could point a public-looking hostname at a private IP
 *  via their own DNS. This doesn't fully close DNS-rebinding (a hostname
 *  could still resolve differently between this check and the adapter's
 *  later fetch()) — that would need every adapter's fetch to reuse this
 *  same resolved address, which is a larger change. Fail-closed on any DNS
 *  lookup failure rather than assuming safety. */
export async function isSafeMediaUrl(rawUrl: string): Promise<{ safe: true } | { safe: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "must be a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { safe: false, reason: "must use https" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { safe: false, reason: "must not point at a local address" };
  }

  const literalIpType = isIP(hostname);
  const addressesToCheck: string[] = [];
  if (literalIpType) {
    addressesToCheck.push(hostname);
  } else {
    try {
      const records = await dns.lookup(hostname, { all: true, verbatim: true });
      if (records.length === 0) return { safe: false, reason: "could not resolve" };
      addressesToCheck.push(...records.map((r) => r.address));
    } catch {
      return { safe: false, reason: "could not resolve" };
    }
  }

  for (const address of addressesToCheck) {
    if (isPrivateOrReservedIp(address)) {
      return { safe: false, reason: "must not point at a private, internal, or reserved address" };
    }
  }

  return { safe: true };
}

function isPrivateOrReservedIp(address: string): boolean {
  const type = isIP(address);
  if (type === 4) return isPrivateIpv4(address);
  if (type === 6) return isPrivateIpv6(address);
  return true; // not a recognizable literal IP at all — reject rather than guess
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const a = address.toLowerCase();
  if (a === "::1" || a === "::") return true; // loopback / unspecified
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // fc00::/7 unique local
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) return true; // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4 address too.
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

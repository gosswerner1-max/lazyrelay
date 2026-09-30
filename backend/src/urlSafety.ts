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
 *  via their own DNS. On success, returns the exact resolved address(es) so
 *  the caller can pin the actual fetch() to one of them (fetchMediaForStreaming
 *  does this) — closing the DNS-rebinding gap that existed when the caller's
 *  own fetch() re-resolved the hostname independently. Fail-closed on any DNS
 *  lookup failure rather than assuming safety. */
export async function isSafeMediaUrl(
  rawUrl: string,
): Promise<{ safe: true; addresses: string[] } | { safe: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "must be a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { safe: false, reason: "must use https" };
  }

  // URL keeps the brackets on an IPv6 literal ([::1]); isIP and the range checks need them removed.
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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

  return { safe: true, addresses: addressesToCheck };
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
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  // 192.0.0.0/24 only (IETF protocol assignments). The rest of 192.0.0.0/16 is public:
  // 192.0.64.0/18 is WordPress.com hosting, so blocking all of 192.0.* refused real sites.
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  return false;
}

/** Expands any textual IPv6 address to its 8 sixteen-bit groups, or null if it is not a valid one. Handles :: and a trailing dotted IPv4. */
function expandIpv6(address: string): number[] | null {
  let a = address.toLowerCase().split("%")[0]; // drop a zone id such as %eth0
  const v4 = a.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    a = a.slice(0, a.length - v4[0].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = a.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill("0") : []), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateIpv6(address: string): boolean {
  const g = expandIpv6(address);
  if (!g) return true; // not a recognizable IPv6 literal, reject rather than guess
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1 loopback
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // Forms that carry an IPv4 address: judge them by the IPv4 they carry.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return isPrivateIpv4(v4FromGroups(g6, g7)); // ::ffff:a.b.c.d (mapped)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4(v4FromGroups(g6, g7)); // ::a.b.c.d (compatible)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIpv4(v4FromGroups(g6, g7)); // 64:ff9b::/96 NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g0 === 0x2002) return isPrivateIpv4(v4FromGroups(g1, g2)); // 2002::/16 6to4
  if (g0 === 0x2001 && g1 === 0) return true; // 2001::/32 Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // 2001:db8::/32 documentation
  return false;
}

import { isSafeMediaUrl } from "./urlSafety.js";

let failures = 0;
function report(label: string, pass: boolean, detail?: string) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  console.log("=== isSafeMediaUrl checks ===\n");

  const cases: { url: string; expectSafe: boolean; label: string }[] = [
    { url: "http://example.com/x.jpg", expectSafe: false, label: "http (not https) rejected" },
    { url: "https://169.254.169.254/latest/meta-data/", expectSafe: false, label: "cloud metadata IP rejected" },
    { url: "https://127.0.0.1/x", expectSafe: false, label: "loopback IP rejected" },
    { url: "https://localhost/x", expectSafe: false, label: "localhost hostname rejected" },
    { url: "https://10.0.0.5/x", expectSafe: false, label: "10.0.0.0/8 private IP rejected" },
    { url: "https://172.16.0.1/x", expectSafe: false, label: "172.16.0.0/12 private IP rejected" },
    { url: "https://192.168.1.1/x", expectSafe: false, label: "192.168.0.0/16 private IP rejected" },
    { url: "https://100.64.0.1/x", expectSafe: false, label: "100.64.0.0/10 CGNAT IP rejected" },
    { url: "https://[::1]/x", expectSafe: false, label: "IPv6 loopback rejected" },
    { url: "https://[fe80::1]/x", expectSafe: false, label: "IPv6 link-local rejected" },
    { url: "https://[fd00::1]/x", expectSafe: false, label: "IPv6 unique-local rejected" },
    { url: "https://[::ffff:169.254.169.254]/x", expectSafe: false, label: "IPv4-mapped IPv6 metadata address rejected" },
    { url: "not a url at all", expectSafe: false, label: "garbage input rejected" },
    { url: "https://8.8.8.8/x", expectSafe: true, label: "real public IP (Google DNS) accepted" },
    { url: "https://example.com/real-image.jpg", expectSafe: true, label: "real public hostname accepted" },
  ];

  for (const c of cases) {
    const result = await isSafeMediaUrl(c.url);
    report(c.label, result.safe === c.expectSafe, JSON.stringify(result));
  }

  console.log(`\n=== ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

import { useEffect, useState } from "react";
import { API_BASE_URL } from "../lib/apiDocsContent";

interface GrowthStats {
  postsVerifiedLive: number;
  verificationAccuracy: number | null;
  verificationIntervalSeconds: number;
}

// Not wired into any page yet -- built and verified, deploy is a separate,
// deliberate decision. See project-seo-aeo-paid-search-launch.md,
// "Social posting cadence decided for after Meta clears", 2026-08-18.
// Real numbers only: no customer/account counts (none of that data exists
// yet), no completion-time claims (only the real 30s poll interval, not a
// guarantee), and verificationAccuracy deliberately excludes posts that
// never reached a platform (bad file format/size, missing scope, etc. --
// see the backend route's own comment for the exact query boundary).
export default function GrowthStatsCounter() {
  const [stats, setStats] = useState<GrowthStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE_URL}/public/growth-stats`)
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then(setStats)
      .catch(() => setError(true));
  }, []);

  if (error || !stats) return null;

  return (
    <div className="growth-stats-counter">
      <div className="growth-stat">
        <div className="growth-stat-value">{stats.postsVerifiedLive.toLocaleString()}</div>
        <div className="growth-stat-label">
          Posts verified live
        </div>
      </div>
      <div className="growth-stat">
        <div className="growth-stat-value">
          {stats.verificationAccuracy !== null ? `${stats.verificationAccuracy}%` : "—"}
        </div>
        <div className="growth-stat-label">
          Verification accuracy<sup>*</sup>
        </div>
      </div>
      <div className="growth-stat">
        <div className="growth-stat-value">{stats.verificationIntervalSeconds}s</div>
        <div className="growth-stat-label">
          Verification intervals
        </div>
      </div>
      <p className="growth-stats-footnote">
        <sup>*</sup>Of posts LazyRelay successfully sent to the platform. Excludes attempts that never reached
        the platform at all (invalid file format, size, or missing account permissions).
      </p>
    </div>
  );
}

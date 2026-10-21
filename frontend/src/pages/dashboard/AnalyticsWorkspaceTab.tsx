// The Insights workspace tab: accounts, brands and posts come from the dashboard state (the same source every other tab uses); the numbers come from the
// existing analytics endpoint. This tab keeps its own range and brand choice and fetches for itself, because the dashboard only loads its analytics
// state while the Overview or Analytics tab is open. Read-only: nothing is written. Shown only when VITE_ANALYTICS_WORKSPACE_ENABLED is "true".

import { useEffect, useMemo, useState } from "react";
import { api, type AnalyticsSummary } from "../../lib/api";
import { AnalyticsWorkspace } from "../../components/dashboard/AnalyticsWorkspace";
import { derivePrevious, type BrandCount, type PreviousFigures, type RangeDays } from "../../lib/analyticsModel";
import { useDashboard } from "./DashboardContext";

interface Loaded {
  summary: AnalyticsSummary | null;
  previous: PreviousFigures | null;
  brandCounts: BrandCount[];
  error: string | null;
  /** Which request this answers; while it differs from the current one, the numbers on screen are for an earlier choice and a load is in progress. */
  key: string;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function AnalyticsWorkspaceTab() {
  const { accounts, brands, posts } = useDashboard();
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [brand, setBrand] = useState("");
  const [loaded, setLoaded] = useState<Loaded>({ summary: null, previous: null, brandCounts: [], error: null, key: "" });

  const brandNames = useMemo(() => brands.map((b) => b.name).sort((a, b) => a.localeCompare(b)), [brands]);
  const brandKey = brandNames.join("\u0000");
  const requestKey = `${rangeDays}|${brand}|${brandKey}`;

  useEffect(() => {
    let cancelled = false;
    const names = brandKey ? brandKey.split("\u0000") : [];
    const forBrand = brand || undefined;
    (async () => {
      const [current, doubled, ...perBrand] = await Promise.allSettled([
        api.getAnalyticsSummary(rangeDays, forBrand),
        api.getAnalyticsSummary(rangeDays * 2, forBrand),
        ...names.map((n) => api.getAnalyticsSummary(rangeDays, n)),
      ]);
      if (cancelled) return;
      const summary = current.status === "fulfilled" ? current.value : null;
      const brandCounts: BrandCount[] = [];
      let brandFailure = false;
      perBrand.forEach((r, i) => {
        if (r.status === "fulfilled") brandCounts.push({ name: names[i], published: r.value.byStatus?.posted ?? 0 });
        else brandFailure = true;
      });
      let error: string | null = null;
      if (current.status === "rejected") error = messageOf(current.reason);
      else if (brandFailure) error = "Some brand numbers could not be loaded.";
      // The earlier window is only used for the growth figures: if it fails the tiles show N/A instead of a guess.
      const previous = doubled.status === "fulfilled" ? derivePrevious(summary, doubled.value) : null;
      setLoaded({ summary, previous, brandCounts, error, key: requestKey });
    })();
    return () => {
      cancelled = true;
    };
  }, [rangeDays, brand, brandKey, requestKey]);

  return (
    <AnalyticsWorkspace
      rangeDays={rangeDays}
      onRangeChange={setRangeDays}
      brands={brandNames}
      brand={brand}
      onBrandChange={setBrand}
      summary={loaded.summary}
      previous={loaded.previous}
      brandCounts={loaded.brandCounts}
      posts={posts}
      accounts={accounts}
      loading={loaded.key !== requestKey}
      error={loaded.error}
    />
  );
}

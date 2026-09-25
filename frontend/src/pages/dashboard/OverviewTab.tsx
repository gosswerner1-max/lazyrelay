// The "Overview" tab — extracted verbatim from the original single-file Dashboard.tsx
// (split 2026-09-25, pure mechanical move: same JSX, same handlers, same
// state — nothing added, removed, or reworded). State and handlers still
// live in one place (useDashboardState.tsx, called once by Dashboard.tsx)
// and reach this file through DashboardContext.

import { OverviewPanel } from "../../components/Charts";
import { BrandFilterSelect } from "./dashboardComponents";
import { useDashboard } from "./DashboardContext";

export function OverviewTab() {
  const {
    accounts,
    setTab,
    brandFilter,
    setBrandFilter,
    analytics,
    analyticsLoading,
  } = useDashboard();

  return (
      <>
        <BrandFilterSelect accounts={accounts} value={brandFilter} onChange={setBrandFilter} />
        <OverviewPanel
          analytics={analytics}
          loading={analyticsLoading}
          hasAccounts={accounts.length > 0}
          onConnectAccount={() => setTab("Social Platforms")}
        />
      </>
  );
}

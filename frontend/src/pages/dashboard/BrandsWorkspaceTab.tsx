// The Brands workspace tab: reads accounts, brands, posts and the plan limit from the dashboard state (the same source every other tab uses) and saves a
// brand's voice through the existing brand API only when the customer presses Save. Brand creation and account assignment stay in Social Platforms.
// Shown only when VITE_BRANDS_WORKSPACE_ENABLED is "true".

import { api } from "../../lib/api";
import { BrandsWorkspace } from "../../components/dashboard/BrandsWorkspace";
import { useDashboard } from "./DashboardContext";

export function BrandsWorkspaceTab() {
  const { accounts, brands, posts, brandCapacity, refresh } = useDashboard();

  async function saveVoice(brandId: string, brandName: string, voice: string | null) {
    await api.updateBrand(brandId, brandName, voice);
    await refresh();
  }

  return (
    <BrandsWorkspace
      accounts={accounts}
      brands={brands}
      posts={posts}
      brandCapacity={brandCapacity}
      onSaveVoice={saveVoice}
    />
  );
}

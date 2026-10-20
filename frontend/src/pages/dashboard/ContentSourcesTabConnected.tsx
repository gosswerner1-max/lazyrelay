// Joins the Content Sources tab to the dashboard's own posts (for the posting queue state) and the default service client
// (for the readiness check). The competitor box brings its own client.

import { ContentSourcesTab } from "../../components/dashboard/ContentSourcesTab";
import { defaultContentSourcesClient } from "../../lib/contentSourcesDefault";
import { useDashboard } from "./DashboardContext";

export default function ContentSourcesTabConnected() {
  const { posts } = useDashboard();
  return <ContentSourcesTab posts={posts} client={defaultContentSourcesClient} />;
}

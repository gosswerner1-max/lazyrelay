// The Content Sources tab: a research page. The competitor box is the front door and comes first; under it sits the honest
// status panel. The tab asks for nothing else: no website, no key, no password. It reads nothing itself; the box and the
// readiness check talk to the companion service through their own clients.

import { useId } from "react";
import type { ScheduledPost } from "../../lib/api";
import type { ContentSourcesClient } from "../../lib/contentSources";
import CompetitorSection from "./CompetitorSection";
import { ContentSourcesStatus } from "./ContentSourcesStatus";
import "../../styles/byok-panels.css";
import "../../styles/content-sources.css";

export interface ContentSourcesTabProps {
  /** All the account's posts. Only the posting queue state is read from them. */
  posts: ScheduledPost[];
  /** The companion service, for the readiness check. The dashboard hands in the real one; tests hand in a fake. */
  client: ContentSourcesClient;
}

export function ContentSourcesTab({ posts, client }: ContentSourcesTabProps) {
  const titleId = useId();
  return (
    <section className="byok-panels content-sources" aria-labelledby={titleId}>
      <header className="cs-head">
        <h2 id={titleId}>Competitor research</h2>
        <p>Paste a link to a competitor's page and see how it is built. Nothing is posted or saved.</p>
      </header>
      <CompetitorSection />
      <ContentSourcesStatus posts={posts} client={client} />
    </section>
  );
}

export default ContentSourcesTab;

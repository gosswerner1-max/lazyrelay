// DEV ONLY. The real competitor front door (CompetitorPanel) wired to a fake in-memory client, so the whole flow can be
// reviewed on /dev/billing-mockup: the tour, the consent dialog and the result window. Nothing is sent anywhere.

import { CompetitorPanel } from "../components/dashboard/CompetitorPanel";
import { fakeClient } from "./fakeCompetitorClient";
import "../styles/byok-panels.css";
import "../styles/content-sources.css";

export function FrontDoorPreview({ creditBalance }: { creditBalance: number }) {
  return (
    <section className="byok-panels content-sources" aria-labelledby="bm-front-door-title">
      <h2 className="bm-front-door__title" id="bm-front-door-title">
        Front door preview
      </h2>
      <p className="bm-front-door__note">The real front door with a fake service. Any public link gets a sample result after 1.5 seconds.</p>
      <CompetitorPanel client={fakeClient} creditBalance={creditBalance} />
    </section>
  );
}

// Joins competitor mode to the app: the service client the build setting names. The blueprint is read and copied on
// screen; nothing here saves, schedules or posts anything.

import { defaultCompetitorClient } from "../../lib/competitorDefault";
import { CompetitorPanel } from "./CompetitorPanel";

export default function CompetitorSection() {
  return <CompetitorPanel client={defaultCompetitorClient} />;
}

// Joins competitor mode to the app: the service client the build setting names, and the app's own draft call. A saved
// draft is an ordinary draft (no account, no time), so it can never be scheduled or posted from here.

import { api } from "../../lib/api";
import { defaultCompetitorClient } from "../../lib/competitorDefault";
import { CompetitorPanel } from "./CompetitorPanel";
import type { DraftToSave } from "./CompetitorResult";

export default function CompetitorSection({ onSaved }: { onSaved?: () => void | Promise<void> }) {
  async function saveDraft(draft: DraftToSave) {
    await api.saveDraft({ content: draft.content, tags: draft.tags });
    try {
      await onSaved?.(); // the new draft shows under Drafts for review; a late list is not a failed save
    } catch (err) {
      console.error(err);
    }
  }
  return <CompetitorPanel client={defaultCompetitorClient} onSaveDraft={saveDraft} />;
}

// DEV ONLY page at /dev/billing-mockup. A fake dark nav bar with the balance indicator, and the billing tab body under it,
// driven by fixed mock scenarios and a fixed "now". Loaded by App.tsx only behind import.meta.env.DEV.

import { useId, useState } from "react";
import { BalanceIndicator } from "../../components/billing/BalanceIndicator";
import { BillingCard } from "../../components/billing/BillingCard";
import { ExpirationBanner } from "../../components/billing/ExpirationBanner";
import { FrontDoorPreview } from "../../dev/FrontDoorPreview";
import { MOCK_NOW, MOCK_SCENARIOS } from "../../dev/billingMockScenarios";
import { totalCredits } from "../../lib/billingSummary";
import "../../styles/byok-panels.css";
import "../../styles/billing-mockup.css";

const NOW = new Date(MOCK_NOW);

export function BillingMockupPage() {
  const selectId = useId();
  const [scenarioId, setScenarioId] = useState(MOCK_SCENARIOS[0]!.id);
  const scenario = MOCK_SCENARIOS.find((s) => s.id === scenarioId) ?? MOCK_SCENARIOS[0]!;
  return (
    <div className="billing-mock byok-panels">
      <header className="bm-nav">
        <p className="bm-nav__brand">Dashboard (mockup)</p>
        <BalanceIndicator lots={scenario.lots} now={NOW} />
      </header>
      <main className="bm-main">
        <div className="bm-dev">
          <label className="bm-dev__label" htmlFor={selectId}>
            Mock scenario (fixed date 2026-10-20)
          </label>
          <select id={selectId} className="bm-dev__select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            {MOCK_SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div key={scenario.id} className="bm-tab">
          <ExpirationBanner lots={scenario.lots} now={NOW} />
          <BillingCard lots={scenario.lots} now={NOW} />
        </div>
        <FrontDoorPreview creditBalance={totalCredits(scenario.lots, NOW)} />
      </main>
    </div>
  );
}

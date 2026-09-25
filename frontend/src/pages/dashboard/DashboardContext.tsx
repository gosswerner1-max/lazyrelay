// Hands the Dashboard's single useDashboardState() result (plus nothing
// else) down to the per-tab components the 2026-09-25 split extracted from
// Dashboard.tsx, instead of threading hundreds of individual props.

import { createContext, useContext } from "react";
import type { useDashboardState } from "./useDashboardState";

export type DashboardState = ReturnType<typeof useDashboardState>;

export const DashboardContext = createContext<DashboardState | null>(null);

export function useDashboard(): DashboardState {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard() must be used inside <DashboardContext.Provider> (Dashboard.tsx)");
  return ctx;
}

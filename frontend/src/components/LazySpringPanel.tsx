import { lazy, Suspense } from "react";

// Code-splits the spring panel (and the `motion` library it pulls in) out of the entry chunk. The panel renders nothing
// while closed, so the chunk is fetched right after load, well before a visitor can open a menu.
const Panel = lazy(() => import("./SpringPanel").then((mod) => ({ default: mod.SpringPanel })));

export function LazySpringPanel(props: import("./SpringPanel").SpringPanelProps) {
  return (
    <Suspense fallback={null}>
      <Panel {...props} />
    </Suspense>
  );
}

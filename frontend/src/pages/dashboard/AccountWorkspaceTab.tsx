// The Account workspace tab: the same Settings sections, with the same wording, fields and buttons, inside a dark Midnight Canvas shell with a section list
// on the left. It adds no logic of its own: every action (security, billing, wallet) is still handled by SettingsTab exactly as before.
// Shown only when VITE_ACCOUNT_WORKSPACE_ENABLED is "true".

import { useEffect, useRef, useState } from "react";
import { SettingsTab } from "./SettingsTab";
import "../../components/dashboard/AccountWorkspace.css";

export function AccountWorkspaceTab() {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [titles, setTitles] = useState<string[]>([]);

  // Read the section headings once the sections have rendered, and again if sections appear later (they load in as the account data arrives).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const read = () => setTitles(Array.from(el.querySelectorAll("section > h2")).map((h) => (h.textContent ?? "").trim()).filter(Boolean));
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  function jump(index: number) {
    const heads = bodyRef.current?.querySelectorAll("section > h2");
    heads?.[index]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="ac-root">
      <nav className="ac-nav" aria-label="Account sections">
        <h2 className="ac-title">Account</h2>
        {titles.map((t, i) => (
          <button key={`${i}-${t}`} type="button" className="ac-nav__item" onClick={() => jump(i)}>{t}</button>
        ))}
      </nav>
      <div className="ac-body" ref={bodyRef}>
        <SettingsTab />
      </div>
    </div>
  );
}

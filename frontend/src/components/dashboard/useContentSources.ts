// The state and the actions behind the Content Sources tab: what the companion service says about the customer's key and
// sources, and one function per thing the customer can do. Every failure becomes a plain message (the client only ever
// rejects with a ContentSourcesError); an error of any other kind is shown in the console and as a generic line.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ContentSourcesError,
  describeVerifyReasons,
  type ContentSourcesClient,
  type CreatableSourceType,
  type CredentialStatus,
  type ServiceSource,
  type Verification,
  type VerifyReasonLine,
} from "../../lib/contentSources";

export interface Msg {
  tone: "ok" | "bad" | "info";
  text: string;
  /** Kept so the screen can add a link for the plan limit. */
  code?: ContentSourcesError["code"];
}

export type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "blocked"; error: ContentSourcesError };

export type CheckState =
  | { sourceId: string; kind: "ok" }
  | { sourceId: string; kind: "reasons"; lines: VerifyReasonLine[] }
  | { sourceId: string; kind: "error"; text: string };

export interface ProofState {
  sourceId: string;
  verification: Verification;
}

function toError(err: unknown): ContentSourcesError {
  if (err instanceof ContentSourcesError) return err;
  console.error(err); // not one of ours: the raw error stays visible, the customer gets the plain line
  return new ContentSourcesError("unknown");
}

const bad = (err: ContentSourcesError): Msg => ({ tone: "bad", text: err.message, code: err.code });
const ok = (text: string): Msg => ({ tone: "ok", text });

// After Run now the service works in the background, so the screen asks again until the run has left a mark (a new sync time
// or a new problem), then gives up after two minutes. The customer never has to reload the page.
const POLL_EVERY_MS = 4000;
const POLL_FOR_MS = 120_000;

export interface ContentSourcesHookOptions {
  /** Called once when a run has finished (or the wait is over), so the screen can fetch the new drafts. */
  onRunFinished?: () => void | Promise<void>;
}

export function useContentSources(client: ContentSourcesClient, options: ContentSourcesHookOptions = {}) {
  const onRunFinished = useRef(options.onRunFinished);
  onRunFinished.current = options.onRunFinished;
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [credential, setCredential] = useState<CredentialStatus>({ registered: false, keyHint: null });
  const [sources, setSources] = useState<ServiceSource[]>([]);
  const [keyMsg, setKeyMsg] = useState<Msg | null>(null);
  const [formMsg, setFormMsg] = useState<Msg | null>(null);
  const [listMsg, setListMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [proof, setProof] = useState<ProofState | null>(null);
  const [check, setCheck] = useState<CheckState | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const [cred, list] = await Promise.all([client.getCredentials(), client.listSources()]);
      if (!alive.current) return;
      setCredential(cred);
      setSources(list);
      setPhase({ kind: "ready" });
    } catch (err) {
      if (alive.current) setPhase({ kind: "blocked", error: toError(err) });
    }
  }, [client]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [load]);

  function finishRun() {
    void Promise.resolve(onRunFinished.current?.()).catch((err) => console.error(err)); // the drafts may be a little late, never a broken tab
  }

  function watchRun(id: string, before: ServiceSource | undefined) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const started = Date.now();
    const tick = async () => {
      pollTimer.current = null;
      if (!alive.current) return;
      let finished = false;
      try {
        const list = await client.listSources();
        if (!alive.current) return;
        setSources(list);
        const now = list.find((s) => s.id === id);
        finished = !now || now.lastSyncedAt !== (before?.lastSyncedAt ?? null) || now.lastError !== (before?.lastError ?? null) || now.consecutiveFailures !== (before?.consecutiveFailures ?? 0);
      } catch (err) {
        console.error(err); // one missed look is fine, the next one tries again
      }
      if (finished || Date.now() - started >= POLL_FOR_MS) {
        finishRun();
        return;
      }
      pollTimer.current = setTimeout(() => void tick(), POLL_EVERY_MS);
    };
    pollTimer.current = setTimeout(() => void tick(), POLL_EVERY_MS);
  }

  /** Runs one action with a busy marker. A failure goes to `onError`; the service being switched off mid session blocks the tab. */
  async function run<T>(marker: string, action: () => Promise<T>, onError: (m: Msg) => void): Promise<T | undefined> {
    setBusy(marker);
    try {
      return await action();
    } catch (err) {
      const e = toError(err);
      if (e.code === "not_connected") setPhase({ kind: "blocked", error: e });
      else onError(bad(e));
      return undefined;
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  const forgetSource = (id: string) => {
    setSources((list) => list.filter((s) => s.id !== id));
    setProof((p) => (p?.sourceId === id ? null : p));
    setCheck((c) => (c?.sourceId === id ? null : c));
  };

  // A failed source action that says the source is gone also takes it off the list.
  const onSourceError = (id: string) => (m: Msg) => {
    if (m.code === "not_found") forgetSource(id);
    setListMsg(m);
  };

  async function refreshCredentials() {
    try {
      setCredential(await client.getCredentials());
    } catch (err) {
      console.error(err); // the list is right; only the key line may be out of date until the tab is opened again
    }
  }

  return {
    phase,
    credential,
    sources,
    keyMsg,
    formMsg,
    listMsg,
    busy,
    proof,
    check,
    retry: load,
    closeProof: () => setProof(null),

    async saveKey(key: string): Promise<boolean> {
      setKeyMsg(null);
      const out = await run("key", () => client.saveKey(key), setKeyMsg);
      if (!out) return false;
      setCredential({ registered: true, keyHint: out.keyHint });
      setKeyMsg(ok("Key saved. Content Sources can now make drafts with it."));
      return true;
    },

    async removeKey(): Promise<boolean> {
      setKeyMsg(null);
      const done = await run("key", async () => (await client.removeKey(), true), setKeyMsg);
      if (!done) return false;
      setCredential({ registered: false, keyHint: null });
      setKeyMsg(ok("Key removed. Runs will not start until you save a key again."));
      return true;
    },

    async addSource(input: { sourceType: CreatableSourceType; sourceUrl: string; brandId: string }): Promise<boolean> {
      setFormMsg(null);
      setListMsg(null);
      const body = { sourceType: input.sourceType, sourceUrl: input.sourceUrl, ...(input.brandId ? { brandId: input.brandId } : {}) };
      const out = await run("add", () => client.createSource(body), setFormMsg);
      if (!out) return false;
      setSources((list) => [...list, out.source]);
      setProof({ sourceId: out.source.id, verification: out.verification });
      setCheck(null);
      setFormMsg(ok("Source added. Next, prove you own this website."));
      return true;
    },

    async checkSource(id: string): Promise<void> {
      setListMsg(null);
      setCheck(null);
      const outcome = await run(`check:${id}`, () => client.verifySource(id), (m) => {
        if (m.code === "not_found") onSourceError(id)(m);
        else setCheck({ sourceId: id, kind: "error", text: m.text });
      });
      if (!outcome) return;
      if (outcome.verified) {
        setSources((list) => list.map((s) => (s.id === id ? { ...s, domainVerified: true, verificationMethod: outcome.method, verificationToken: null } : s)));
        setCheck({ sourceId: id, kind: "ok" });
      } else {
        setCheck({ sourceId: id, kind: "reasons", lines: describeVerifyReasons(outcome.reasons) });
      }
    },

    async runSource(id: string): Promise<void> {
      setListMsg(null);
      setCheck(null);
      const before = sources.find((s) => s.id === id);
      const done = await run(`run:${id}`, async () => (await client.runSource(id), true), onSourceError(id));
      if (!done) return;
      setListMsg(ok("Run started. New drafts will show up under Drafts for review when it is done."));
      watchRun(id, before);
    },

    async removeSource(id: string): Promise<boolean> {
      setListMsg(null);
      setCheck(null);
      const done = await run(`remove:${id}`, async () => (await client.deleteSource(id), true), onSourceError(id));
      if (!done) return false;
      forgetSource(id);
      setListMsg(ok("Source removed."));
      await refreshCredentials(); // removing the last source also removes the saved key
      return true;
    },
  };
}

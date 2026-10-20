// Holds the credit wallet for the dashboard. Loads once on mount, offers refresh(), and after a payment completes checks every
// 3 seconds (for at most 60 seconds) until the balance changes, because the credits arrive a few seconds after the card is
// charged. With billing off, or for an exempt (legacy) account, nothing is requested and no timer runs.

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { getBalance, type BalanceResult, type Wallet } from "./walletApi";

export const POLL_EVERY_MS = 3_000;
export const POLL_WINDOW_MS = 60_000;
const MAX_CHECKS = POLL_WINDOW_MS / POLL_EVERY_MS;

export type WalletStatus = "off" | "loading" | "ready" | "exempt" | "error";

export interface WalletView {
  status: WalletStatus;
  wallet: Wallet | null;
  /** Plain words for the person, only while status is "error". */
  error: string | null;
  fetchedAt: Date | null;
  refresh: () => Promise<void>;
  /** True only when billing is on, the wallet loaded and the account is not exempt: the new billing screens show. */
  billingActive: boolean;
}

interface Options {
  enabled: boolean;
  /** Goes up by one each time the payment window reports checkout.completed. */
  checkoutDoneCount: number;
  loadBalance?: () => Promise<BalanceResult>;
  now?: () => Date;
}

type Core = Pick<WalletView, "status" | "wallet" | "error" | "fetchedAt">;
const OFF: Core = { status: "off", wallet: null, error: null, fetchedAt: null };

interface PollArgs {
  enabled: boolean;
  checkoutDoneCount: number;
  walletRef: MutableRefObject<Wallet | null>;
  loadRef: MutableRefObject<() => Promise<BalanceResult>>;
  apply: (result: BalanceResult, quietErrors: boolean) => void;
}

/** After each new checkout.completed: check every 3 seconds for at most 60 seconds, stopping as soon as the balance changes. */
function useCheckoutPoll({ enabled, checkoutDoneCount, walletRef, loadRef, apply }: PollArgs) {
  const seenCount = useRef(checkoutDoneCount);
  useEffect(() => {
    if (!enabled || checkoutDoneCount === seenCount.current) return;
    seenCount.current = checkoutDoneCount;
    const start = walletRef.current;
    if (!start || start.exempt) return;
    let live = true;
    let busy = false;
    let checks = 0;
    const stop = () => {
      live = false;
      clearInterval(timer);
    };
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      checks += 1;
      try {
        const result = await loadRef.current();
        if (!live) return;
        apply(result, true);
        if (result.kind === "ok" && (result.wallet.balance !== start.balance || result.wallet.exempt)) stop();
        else if (result.kind === "unavailable") stop();
      } finally {
        busy = false;
      }
      if (live && checks >= MAX_CHECKS) stop();
    }, POLL_EVERY_MS);
    return stop;
  }, [enabled, checkoutDoneCount, apply, walletRef, loadRef]);
}

export function useWalletBalance({ enabled, checkoutDoneCount, loadBalance = getBalance, now = () => new Date() }: Options): WalletView {
  const [core, setCore] = useState<Core>(enabled ? { ...OFF, status: "loading" } : OFF);
  const walletRef = useRef<Wallet | null>(null);
  const loadRef = useRef(loadBalance);
  const nowRef = useRef(now);
  useEffect(() => {
    loadRef.current = loadBalance;
    nowRef.current = now;
  });

  const apply = useCallback((result: BalanceResult, quietErrors: boolean) => {
    if (result.kind === "ok") {
      walletRef.current = result.wallet;
      setCore({ status: result.wallet.exempt ? "exempt" : "ready", wallet: result.wallet, error: null, fetchedAt: nowRef.current() });
    } else if (result.kind === "unavailable") {
      walletRef.current = null;
      setCore(OFF);
    } else if (!quietErrors) {
      setCore({ status: "error", wallet: walletRef.current, error: result.message, fetchedAt: null });
    }
  }, []);

  const refresh = useCallback(async () => apply(await loadRef.current(), false), [apply]);

  useEffect(() => {
    if (!enabled) {
      walletRef.current = null;
      setCore(OFF);
      return;
    }
    let live = true;
    setCore((c) => (c.status === "off" ? { ...OFF, status: "loading" } : c));
    loadRef.current().then((r) => live && apply(r, false));
    return () => {
      live = false;
    };
  }, [enabled, apply]);

  useCheckoutPoll({ enabled, checkoutDoneCount, walletRef, loadRef, apply });

  return { ...core, refresh, billingActive: core.status === "ready" };
}

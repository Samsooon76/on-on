import { useEffect, useRef, useState, type Dispatch } from "react";
import type { DialerAction, DialerState } from "./powerdialer-model";
import { dialerStorageKey, restoreDialer, serializeDialer } from "./powerdialer-storage";

export function useDialerPersistence(scope: { userId: string; organizationId: string; lineId: string }, visible: boolean, state: DialerState, dispatch: Dispatch<DialerAction>) {
  const key = dialerStorageKey(scope);
  const [ownsSession, setOwnsSession] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [retry, setRetry] = useState(0);
  const acquired = useRef(false);
  const activated = useRef(false);
  if (visible) activated.current = true;
  const active = activated.current && Boolean(scope.userId && scope.organizationId && scope.lineId);
  useEffect(() => {
    if (!active) return;
    if (!navigator.locks) { setLoadError("Ouvrez l’application en HTTPS pour activer la sauvegarde et la protection entre onglets."); return; }
    let cancelled = false;
    let release: (() => void) | undefined;
    setLoadError("");
    void navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
      if (cancelled) return;
      if (!lock) { setLoadError("Cette campagne est ouverte dans un autre onglet. Fermez cet onglet, puis réessayez ici."); return; }
      let restored: DialerState;
      try { restored = restoreDialer(localStorage.getItem(key), new Date().toISOString()); }
      catch { setLoadError("La sauvegarde locale est illisible ou le stockage est indisponible. Son contenu est conservé ; vous pouvez exporter la sauvegarde pour la récupérer."); return; }
      acquired.current = true;
      dispatch({ type: "restore", state: restored }); setOwnsSession(true);
      await new Promise<void>((resolve) => { release = resolve; });
    }).catch(() => { if (!cancelled) setLoadError("Impossible d’ouvrir cette session. Réessayez."); });
    return () => { cancelled = true; acquired.current = false; setOwnsSession(false); release?.(); };
  }, [key, active, retry, dispatch]);
  useEffect(() => {
    if (!ownsSession || !acquired.current) return;
    try { localStorage.setItem(key, serializeDialer(state)); setSaveError(""); }
    catch { setSaveError("Sauvegarde locale impossible : le stockage est plein ou bloqué. Exportez votre bilan avant de fermer cet onglet."); }
    // Countdown ticks do not alter persisted campaign data.
  }, [key, ownsSession, state.entries, state.settings, state.excludedNumbers]);
  return { ownsSession, loadError, saveError, backup: () => { try { return localStorage.getItem(key); } catch { return null; } }, retry: () => setRetry((value) => value + 1) };
}

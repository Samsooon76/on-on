import { useEffect, useRef, useState } from "react";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
export function AutoTranscriptionSettings({ api, base, refreshKey }: { api: Api; base: string; refreshKey: number }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(api); request.current = api;
  useEffect(() => {
    let active = true;
    setEnabled(null); setError("");
    void request.current<{ autoStart: boolean }>(`${base}/transcription`).then(result => {
      if (active) setEnabled(result.autoStart);
    }).catch(() => { if (active) setError("Impossible de charger le réglage de transcription. Actualisez l’administration."); });
    return () => { active = false; };
  }, [base, refreshKey]);
  async function toggle() {
    if (enabled === null || busy) return;
    setBusy(true); setError("");
    try {
      const result = await request.current<{ autoStart: boolean }>(`${base}/transcription`, { method: "PUT", body: JSON.stringify({ autoStart: !enabled }) });
      setEnabled(result.autoStart);
    } catch { setError("Le réglage n’a pas pu être enregistré. Réessayez."); }
    finally { setBusy(false); }
  }
  return <section className="admin-toolbar" aria-label="Transcription automatique">
    <div><h3>Transcription automatique des appels</h3><p>Transcrire en direct dès qu’un appel entrant ou sortant est connecté, pour toute l’organisation.</p><p className="admin-footnote">Le service de transcription doit être configuré. Si l’enregistrement audio est activé, il démarre aussi. Informez vos interlocuteurs avant l’échange.</p>{error && <p role="alert">{error}</p>}</div>
    <label><input type="checkbox" role="switch" checked={enabled === true} disabled={enabled === null || busy} onChange={() => void toggle()} /> Activer automatiquement</label>
  </section>;
}

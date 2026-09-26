import { useEffect, useRef, useState } from "react";
import { ArrowDown, Check, Copy, DownloadSimple, Pause, TextAlignLeft, Waveform } from "@phosphor-icons/react";
import { transcriptPath, transcriptRows, transcriptStatus, transcriptText, transcriptTime, watchTranscript, type TranscriptApi, type TranscriptTarget, type TranscriptionResponse } from "@onoff/api-client";
import "./call-transcript.css";

export function CallTranscript({ api, target, remoteName = "Interlocuteur" }: { api: TranscriptApi; target: TranscriptTarget; remoteName?: string }) {
  const [data, setData] = useState<TranscriptionResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [following, setFollowing] = useState(true);
  const [revision, setRevision] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const path = transcriptPath(target);
  useEffect(() => {
    setData(null); setError(""); setFollowing(true);
    return watchTranscript(api, target, { onData: (next) => { setData(next); setError(""); }, onError: (message, lost) => { setError(message); if (lost) setData(null); } });
  }, [api, path, revision]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const transcript = data?.transcript;
  const rows = transcript ? transcriptRows(transcript) : [];
  useEffect(() => { if (following && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [transcript, following]);
  const live = transcript?.status === "live";
  async function act(stop = false) {
    setBusy(true); setError("");
    try {
      const next = await api<TranscriptionResponse>(stop ? `/v1/calls/${data!.callId}/transcription/stop` : path, { method: "POST" });
      setData(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "La demande a échoué."); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(transcriptText(transcript!, remoteName)); setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 2000); }
    catch { setError("Copie indisponible. Vous pouvez télécharger le texte."); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([transcriptText(transcript!, remoteName)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `transcription-${data!.callId}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="transcript-panel" aria-label="Transcription de l’appel">
    <header className="transcript-heading"><span className="transcript-mark"><TextAlignLeft size={21} /></span><div><h3>Le fil de votre appel</h3><p>Chaque mot, à portée de regard.</p></div><span className={`transcript-badge${live ? " is-live" : ""}`} role="status">{live && <i />}{transcript ? transcriptStatus[transcript.status] : "Transcription"}</span></header>
    {error && <div className="transcript-error" role="alert">{error}<button className="text-button" onClick={() => setRevision((value) => value + 1)}>Actualiser</button></div>}
    {transcript?.error && <p className="transcript-error" role="status">{transcript.error}</p>}
    <div className="transcript-scroll" ref={scroller} tabIndex={0} aria-label="Texte de la conversation" onScroll={(event) => { const el = event.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 70); }}>
      {!rows.length ? <div className="transcript-empty"><span className={`transcript-orbit${live ? " listening" : ""}`}><Waveform size={36} weight="light" /></span><span className="transcript-eyebrow">VOTRE CONVERSATION, EN CLAIR</span><h4>{!data ? "Préparation de la transcription…" : live ? "À l’écoute de votre échange." : transcript ? transcript.status === "completed" ? "Aucune parole transcrite." : transcriptStatus[transcript.status] : data.available && data.callActive && target.providerCallSid ? "Concentrez-vous sur la conversation." : "Aucune transcription disponible."}</h4><p>{!data ? "Nous retrouvons votre appel." : transcript ? "Les phrases apparaissent ici au fil de l’appel." : data.available && data.callActive && target.providerCallSid ? "Les deux voix s’affichent en direct et restent disponibles après l’appel. Informez votre interlocuteur avant de commencer." : !data.available ? "La transcription doit être activée par votre administrateur." : "La transcription n’a pas été démarrée pendant cet appel."}</p>{data?.available && data.callActive && !transcript && target.providerCallSid && <button className="button button-primary" disabled={busy} onClick={() => void act()}><Waveform size={17} />{busy ? "Démarrage…" : "Démarrer la transcription"}</button>}</div> : <ol className="transcript-lines">{rows.map((row) => <li key={row.id} className={`transcript-line ${row.speaker}${row.partial ? " is-partial" : ""}`}><span className="transcript-speaker-icon">{row.speaker === "local" ? "V" : remoteName.slice(0, 1).toUpperCase()}</span><div><div className="transcript-line-meta"><b>{row.speaker === "local" ? "Vous" : remoteName}</b><time>{transcriptTime(row.offsetMs)}</time>{row.partial && <span>En cours</span>}</div><p>{row.text}{row.partial && <span className="transcript-caret" aria-hidden="true" />}</p></div></li>)}</ol>}
    </div>
    {!following && rows.length > 0 && <button className="transcript-follow" onClick={() => setFollowing(true)}><ArrowDown size={14} />Revenir au direct</button>}
    <footer className="transcript-footer"><span><span className="scribe-wordmark" aria-hidden="true">Ⅱ</span> Scribe v2<span className="transcript-footer-detail"> · {transcript?.segments.length ?? 0} passages</span></span><div>{(live || transcript?.status === "starting") && <button className="text-button" disabled={busy} onClick={() => void act(true)}><Pause size={15} />Arrêter</button>}<button className="icon-button" aria-label={copied ? "Texte copié" : "Copier la transcription"} title="Copier" disabled={!transcript?.segments.length} onClick={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />}</button><button className="icon-button" aria-label="Télécharger la transcription" title="Télécharger" disabled={!transcript?.segments.length} onClick={download}><DownloadSimple size={17} /></button></div></footer>
    <span className="sr-only" aria-live="polite">{transcript?.segments.at(-1)?.text}</span>
  </section>;
}

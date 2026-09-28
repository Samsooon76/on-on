import { useEffect, useRef, useState } from "react";
import { CircleNotch, Headphones, Pause, Play } from "@phosphor-icons/react";
import { transcriptTime, type CallRecording } from "@onoff/api-client";

export type LoadCallAudio = (callId: string, signal: AbortSignal) => Promise<Blob>;
export function CallRecordingPlayer({ callId, recording, loadAudio, blocked = false, compact = false }: {
  callId: string; recording: CallRecording | null | undefined; loadAudio: LoadCallAudio; blocked?: boolean; compact?: boolean;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const controller = useRef<AbortController | null>(null);
  const objectUrl = useRef("");
  const [busy, setBusy] = useState(false), [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0), [duration, setDuration] = useState(0), [rate, setRate] = useState(1);
  const [error, setError] = useState("");
  const ready = recording?.status === "ready";
  useEffect(() => {
    const element = audio.current;
    return () => { controller.current?.abort(); element?.pause(); element?.removeAttribute("src"); element?.load(); if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = ""; };
  }, [callId, compact]);
  useEffect(() => { if (blocked) { controller.current?.abort(); audio.current?.pause(); setBusy(false); } }, [blocked]);
  const total = duration || recording?.durationSeconds || 0;
  async function toggle() {
    if (!ready || blocked || !audio.current) return;
    if (playing) { audio.current.pause(); return; }
    setError("");
    const request = new AbortController(); controller.current = request;
    try {
      if (!objectUrl.current) {
        setBusy(true);
        const blob = await loadAudio(callId, request.signal);
        if (request.signal.aborted) return;
        objectUrl.current = URL.createObjectURL(blob); audio.current.src = objectUrl.current;
      }
      if (audio.current.ended) audio.current.currentTime = 0;
      audio.current.playbackRate = rate;
      await audio.current.play();
    } catch (caught) { if (!request.signal.aborted) setError(caught instanceof Error ? caught.message : "La lecture est indisponible. Réessayez."); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  function seek(value: number) { if (audio.current && objectUrl.current) { audio.current.currentTime = value; setPosition(value); } }
  const description = !recording ? "Aucun audio enregistré pour cet appel." : recording.status === "recording" || recording.status === "starting" ? "Enregistrement en cours · écoute après l’appel" : recording.status === "processing" ? "Préparation de votre audio…" : ready ? blocked ? "L’écoute sera disponible après l’appel en cours." : "Les deux voix · depuis le démarrage de la transcription" : recording.error ?? "Aucun audio disponible.";
  if (!recording) return null;
  if (compact) return <section className="call-audio call-audio-compact" aria-label="Enregistrement de l’appel"><Headphones size={15} /><p className="call-audio-caption" role="status">{description}</p></section>;
  return <section className={`call-audio${ready ? " is-ready" : ""}`} aria-label="Enregistrement de l’appel">
    <audio ref={audio} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={() => setPosition(audio.current?.currentTime ?? 0)} onLoadedMetadata={() => { const seconds = audio.current?.duration; if (seconds && Number.isFinite(seconds)) setDuration(seconds); }} onError={() => { setPlaying(false); setBusy(false); setError("Impossible de lire cet audio. Fermez puis rouvrez l’appel pour réessayer."); }} />
    <div className="call-audio-top"><Headphones size={17} /><b>Écouter l’appel</b><span>{recording?.status === "recording" ? <><i />Enregistrement</> : ready ? "Audio de l’appel" : "Audio"}</span></div>
    <div className="call-audio-controls"><button className="call-audio-play" type="button" disabled={!ready || blocked || busy} aria-label={busy ? "Chargement de l’audio" : playing ? "Mettre en pause" : "Écouter l’appel"} onClick={() => void toggle()}>{busy ? <CircleNotch className="call-audio-spinner" size={23} /> : playing ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}</button><div className="call-audio-track"><input type="range" min={0} max={total || 1} step={0.1} value={Math.min(position, total || 1)} disabled={!objectUrl.current || blocked} onChange={(event) => seek(Number(event.target.value))} aria-label="Position dans l’enregistrement" aria-valuetext={transcriptTime(position * 1000)} /><div className="call-audio-times"><time>{transcriptTime(position * 1000)}</time><span>{busy ? "Chargement…" : playing ? "Lecture en cours" : ""}</span><time>{transcriptTime(total * 1000)}</time></div></div><button className="call-audio-speed" type="button" disabled={!ready || blocked} aria-label={`Vitesse de lecture : ${rate} fois`} onClick={() => { const next = [1, 1.25, 1.5, 2][([1, 1.25, 1.5, 2].indexOf(rate) + 1) % 4]!; setRate(next); if (audio.current) audio.current.playbackRate = next; }}>{rate}×</button></div>
    <p className={error ? "call-audio-error" : "call-audio-caption"} role={error ? "alert" : "status"}>{error || description}</p>
  </section>;
}

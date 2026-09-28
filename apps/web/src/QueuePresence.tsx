import { useEffect, useRef, useState } from "react";
import { Headset } from "@phosphor-icons/react";
import "./call-center.css";
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
const errorText = (e: unknown) => e instanceof Error ? e.message : "Une erreur est survenue.";

export function QueuePresence({organizationId,api}:{organizationId:string;api:Api}){
  const [presence,setPresence]=useState<{enrolled:boolean;activity?:string;contactNumber?:string|null}|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);const ref=useRef(api);ref.current=api;
  const base=`/v1/organizations/${organizationId}/center/presence`;
  useEffect(()=>{let alive=true;const read=async()=>{try{const result=await ref.current<typeof presence>(base);if(alive){setPresence(result);setError("");}}catch{if(alive){setPresence(null);setError("Statut des files indisponible.");}}};void read();const timer=setInterval(()=>{if(document.visibilityState==="visible")void read();},15000);return()=>{alive=false;clearInterval(timer);};},[organizationId]);
  if(!presence?.enrolled)return error?<p className="admin-help" role="status">{error}</p>:null;
  return <div className="center-presence"><Headset size={16}/><span>{presence.activity}</span><select aria-label="Mon statut dans les files" disabled={busy} value="" onChange={async e=>{const activity=e.target.value;if(!activity)return;setBusy(true);try{await api(base,{method:"PUT",body:JSON.stringify({activity,contactNumber:presence.contactNumber??null})});const result=await api<typeof presence>(base);setPresence(result);setError("");}catch(e){setError(errorText(e));}finally{setBusy(false);}}}><option value="">Changer mon statut</option><option value="available">Disponible</option><option value="break">En pause</option><option value="offline">Hors ligne</option></select>{error&&<p className="form-error" role="alert">{error}</p>}</div>;
}

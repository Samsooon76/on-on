import { useEffect, useState } from "react";
import { readPagePhones } from "../../src/page.js";
import { normalizePhoneNumber } from "@onoff/contracts";
import { createRoot } from "react-dom/client";
import { createComposeUrl, createTagsUrl, normalizeWebAppUrl } from "../../src/phone.js";
import { ArrowUpRight, CheckCircle, CursorClick, GearSix, Phone, Tag } from "@phosphor-icons/react";
import "@onoff/design-tokens/theme.css";
import "./style.css";

const WEB_APP_URL_KEY = "onoff:web-app-url";
const CALL_DRAFT_KEY = "onoff:call-draft";

function Popup() {
  const [webAppUrl, setWebAppUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(true);
  const [phones, setPhones] = useState<string[]>([]);
  const [scanning, setScanning] = useState(true);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void scanPage();
    void chrome.storage.local.get([WEB_APP_URL_KEY, CALL_DRAFT_KEY]).then((stored) => {
      setWebAppUrl(typeof stored[WEB_APP_URL_KEY] === "string" ? stored[WEB_APP_URL_KEY] : "");
      setDestination(typeof stored[CALL_DRAFT_KEY] === "string" ? stored[CALL_DRAFT_KEY] : "");
      setBusy(false);
    }).catch(() => {
      setNotice("Le stockage local de l’extension est indisponible.");
      setBusy(false);
    });
  }, []);

  async function scanPage() {
    setScanning(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id === undefined) throw new Error();
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPagePhones });
      const numbers = [...new Set((results[0]?.result ?? []).map(normalizePhoneNumber).filter((n): n is string => Boolean(n)))];
      setPhones(numbers);
      if (!numbers.length) setNotice("Aucun numéro détecté. Vous pouvez en saisir un ci-dessous.");
    } catch {
      setNotice("Chrome ne permet pas de lire cette page. Saisissez un numéro ci-dessous.");
    } finally { setScanning(false); }
  }

  async function callNumber(number: string) {
    const base = normalizeWebAppUrl(webAppUrl);
    const phone = normalizePhoneNumber(number);
    if (!base) { setSettingsOpen(true); setNotice("Configurez l’adresse HTTPS de votre application Onoff."); return; }
    if (!phone) { setNotice("Saisissez un numéro valide."); return; }
    // Request access only to the configured application, during the user's click.
    const appUrl = new URL(base);
    const origin = appUrl.origin;
    const originPattern = `${appUrl.protocol}//${appUrl.hostname}/*`;
    if (!await chrome.permissions.request({ origins: [originPattern] }).catch(() => false)) {
      setNotice("Autorisez l’accès à Onoff pour lancer l’appel en un clic."); return;
    }
    setBusy(true);
    setNotice("Connexion à Onoff…");
    let targetId: number | undefined;
    try {
      await chrome.storage.local.set({ [WEB_APP_URL_KEY]: base, [CALL_DRAFT_KEY]: phone });
      const tabs = await chrome.tabs.query({ url: originPattern });
      const existing = tabs.find(tab => tab.url && new URL(tab.url).origin === origin && new URL(tab.url).pathname.replace(/\/+$/, "") === new URL(base).pathname.replace(/\/+$/, ""));
      const target = existing ?? await chrome.tabs.create({ url: createComposeUrl(base, phone)!, active: false });
      targetId = target.id;
      if (targetId === undefined) throw new Error("Onglet Onoff introuvable.");
      let result: string | undefined;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId: targetId }, world: "MAIN", args: [phone],
            func: (destination: string) => {
              if (!document.documentElement.hasAttribute("data-onoff-call-bridge")) return "loading";
              let response = "L’application Onoff ne répond pas.";
              const listener = (event: Event) => { response = (event as CustomEvent<string>).detail; };
              window.addEventListener("onoff:call-result", listener, { once: true });
              window.dispatchEvent(new CustomEvent("onoff:call", { detail: destination }));
              window.removeEventListener("onoff:call-result", listener);
              return response;
            },
          });
          result = injection?.result;
          if (result && result !== "loading") break;
        } catch { /* The application may still be navigating. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      setNotice(result === "started" ? "Appel lancé dans Onoff." : result && result !== "loading" ? result : "Connectez-vous à Onoff, puis relancez l’appel depuis l’extension.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Impossible de lancer l’appel.");
    } finally {
      if (targetId !== undefined) await chrome.tabs.update(targetId, { active: true }).catch(() => undefined);
      setBusy(false);
    }
  }

  async function openTags() {
    const url = createTagsUrl(webAppUrl);
    if (!url) { setSettingsOpen(true); setNotice("Configurez l’adresse HTTPS de votre application Onoff."); return; }
    try {
      await chrome.storage.local.set({ [WEB_APP_URL_KEY]: normalizeWebAppUrl(webAppUrl)! });
      await chrome.tabs.create({ url });
      setNotice("Gestion des tags ouverte dans Onoff.");
    } catch { setNotice("Impossible d’ouvrir les réglages des tags."); }
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <span className="brand-mark" aria-hidden="true">o</span>
        <div><strong>onoff</strong><small>Votre téléphone, à portée de clic.</small></div>
        <button type="button" className={`settings-toggle${settingsOpen ? " active" : ""}`} aria-controls="popup-settings" aria-label="Configurer l’application" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}><GearSix size={19} /></button>
      </header>

      {settingsOpen && (
        <label id="popup-settings" className="field settings-field">Adresse de l’application Onoff
          <input type="url" inputMode="url" value={webAppUrl} onChange={(event) => setWebAppUrl(event.target.value)} placeholder="https://app.exemple.fr" autoComplete="url" />
          <small>HTTPS requis. HTTP est accepté uniquement sur localhost pour le développement.</small>
        </label>
      )}

      <form onSubmit={(event) => void (event.preventDefault(), callNumber(destination))}>
        <div className="form-heading"><span className="call-symbol"><Phone size={23} /></span><span className="eyebrow">NOUVEL APPEL</span><h1>Gardez le contact.</h1><p>Appelez un numéro détecté sur cette page en un clic.</p></div>
        <button className="selection-button" type="button" disabled={busy || scanning} onClick={() => void scanPage()}><CursorClick size={17} /> {scanning ? "Recherche des numéros…" : "Actualiser les numéros"}</button>
        <ul className="detected-phones" aria-label="Numéros détectés">{phones.map(phone => <li key={phone}><span>{phone}</span><button type="button" disabled={busy} onClick={() => void callNumber(phone)} aria-label={`Appeler ${phone}`}><Phone size={15} /> Appeler</button></li>)}</ul>
        <label className="field">Numéro de téléphone
          <input type="tel" inputMode="tel" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="06 12 34 56 78 ou +33…" autoComplete="tel" maxLength={64} />
        </label>
        {notice && <p className="notice" role="status">{notice}</p>}
        <button className="open-button" type="submit" disabled={busy || !destination.trim()}>Appeler <Phone size={18} /></button>
      </form>
      <section className="tags-shortcut"><div className="shortcut-heading"><Tag size={19} /><h2>AI call tag</h2></div><p>Classez vos appels avec Jev à partir des transcriptions et des prompts de vos tags.</p><button type="button" className="selection-button" disabled={busy} onClick={() => void openTags()}>Gérer les tags et l’IA <ArrowUpRight size={16} /></button></section>
      <footer><CheckCircle size={15} /><span>Les numéros sont détectés localement à l’ouverture. L’appel utilise votre ligne active dans Onoff.</span></footer>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Popup root not found.");
createRoot(root).render(<Popup />);

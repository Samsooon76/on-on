import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createComposeUrl, createTagsUrl, extractSelectedPhone, normalizeWebAppUrl } from "../../src/phone.js";
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
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void chrome.storage.local.get([WEB_APP_URL_KEY, CALL_DRAFT_KEY]).then((stored) => {
      setWebAppUrl(typeof stored[WEB_APP_URL_KEY] === "string" ? stored[WEB_APP_URL_KEY] : "");
      setDestination(typeof stored[CALL_DRAFT_KEY] === "string" ? stored[CALL_DRAFT_KEY] : "");
      setBusy(false);
    }).catch(() => {
      setNotice("Le stockage local de l’extension est indisponible.");
      setBusy(false);
    });
  }, []);

  async function readSelection() {
    setNotice("");
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab || tab.id === undefined) throw new Error("Onglet actif introuvable.");
      const tabId = tab.id;
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection()?.toString().slice(0, 2_000) ?? "",
      });
      const phone = extractSelectedPhone(typeof injection?.result === "string" ? injection.result : "");
      if (!phone) {
        setNotice("Sélectionnez un seul numéro valide dans la page, puis réessayez.");
        return;
      }
      setDestination(phone);
      await chrome.storage.local.set({ [CALL_DRAFT_KEY]: phone });
    } catch {
      setNotice("Chrome ne peut pas lire la sélection sur cet onglet. Saisissez le numéro ci-dessous.");
    }
  }

  async function openComposer(event: React.FormEvent) {
    event.preventDefault();
    const safeBaseUrl = normalizeWebAppUrl(webAppUrl);
    const url = createComposeUrl(webAppUrl, destination);
    if (!safeBaseUrl) {
      setSettingsOpen(true);
      setNotice("Configurez l’adresse HTTPS de votre application Onoff.");
      return;
    }
    if (!url) {
      setNotice("Saisissez un numéro international ou un numéro français à 10 chiffres.");
      return;
    }
    try {
      await chrome.storage.local.set({ [WEB_APP_URL_KEY]: safeBaseUrl, [CALL_DRAFT_KEY]: destination });
      await chrome.tabs.create({ url });
      setNotice("Composeur ouvert. Connectez-vous puis vérifiez le numéro avant d’appeler.");
    } catch {
      setNotice("Impossible d’ouvrir le composeur. Vérifiez l’adresse de l’application.");
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

      <form onSubmit={(event) => void openComposer(event)}>
        <div className="form-heading"><span className="call-symbol"><Phone size={23} /></span><span className="eyebrow">NOUVEL APPEL</span><h1>Gardez le contact.</h1><p>Choisissez un numéro dans la page ou saisissez-le directement.</p></div>
        <button className="selection-button" type="button" disabled={busy} onClick={() => void readSelection()}><CursorClick size={17} /> Récupérer la sélection</button>
        <label className="field">Numéro de téléphone
          <input type="tel" inputMode="tel" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="06 12 34 56 78 ou +33…" autoComplete="tel" maxLength={64} />
        </label>
        {notice && <p className="notice" role="status">{notice}</p>}
        <button className="open-button" type="submit" disabled={busy || !destination.trim()}>Ouvrir dans Onoff <ArrowUpRight size={18} /></button>
      </form>
      <section className="tags-shortcut"><div className="shortcut-heading"><Tag size={19} /><h2>AI call tag</h2></div><p>Classez vos appels avec Jev à partir des transcriptions et des prompts de vos tags.</p><button type="button" className="selection-button" disabled={busy} onClick={() => void openTags()}>Gérer les tags et l’IA <ArrowUpRight size={16} /></button></section>
      <footer><CheckCircle size={15} /><span>La page visitée ne transmet que le texte sélectionné. L’appel reste dans l’application Onoff.</span></footer>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Popup root not found.");
createRoot(root).render(<Popup />);

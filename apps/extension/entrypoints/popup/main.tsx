import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createComposeUrl, extractSelectedPhone, normalizeWebAppUrl } from "../../src/phone.js";
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

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <span className="brand-mark" aria-hidden="true">o</span>
        <div><strong>Onoff</strong><small>Click-to-call</small></div>
        <button type="button" className="settings-toggle" aria-label="Configurer l’application" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}>⚙</button>
      </header>

      {settingsOpen && (
        <label className="field settings-field">Adresse de l’application Onoff
          <input type="url" inputMode="url" value={webAppUrl} onChange={(event) => setWebAppUrl(event.target.value)} placeholder="https://app.exemple.fr" autoComplete="url" />
          <small>HTTPS requis. HTTP est accepté uniquement sur localhost pour le développement.</small>
        </label>
      )}

      <form onSubmit={(event) => void openComposer(event)}>
        <div className="form-heading"><span className="eyebrow">NOUVEL APPEL</span><h1>Ouvrir le composeur</h1><p>Choisissez un numéro dans la page ou saisissez-le directement.</p></div>
        <button className="selection-button" type="button" disabled={busy} onClick={() => void readSelection()}><span aria-hidden="true">↳</span> Récupérer la sélection</button>
        <label className="field">Numéro de téléphone
          <input type="tel" inputMode="tel" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="06 12 34 56 78 ou +33…" autoComplete="tel" maxLength={64} />
        </label>
        {notice && <p className="notice" role="status">{notice}</p>}
        <button className="open-button" type="submit" disabled={busy || !destination.trim()}><span aria-hidden="true">↗</span> Ouvrir dans Onoff</button>
      </form>
      <footer>La page visitée ne transmet que le texte sélectionné. L’appel reste dans l’application Onoff.</footer>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Popup root not found.");
createRoot(root).render(<Popup />);

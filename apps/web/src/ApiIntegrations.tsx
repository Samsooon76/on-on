import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, Code, Copy, Plus } from "@phosphor-icons/react";
import {
  webhookEventLabels,
  type WebhookEvent,
  type WebhookEndpoint,
  type WebhookDelivery,
} from "@onoff/contracts";
import { apiBase } from "./backend";
import "./api-integrations.css";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
const statusLabel: Record<WebhookDelivery["status"], string> = {
  pending: "En attente",
  sending: "En cours",
  delivered: "Livré",
  failed: "En échec",
  canceled: "Annulé",
};
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Les webhooks sont momentanément indisponibles.";
export function ApiIntegrations({
  api,
  organizationId,
  isAdmin,
}: {
  api: Api;
  organizationId: string;
  isAdmin: boolean;
}) {
  const apiRef = useRef(api);
  const actionInFlight = useRef(false);
  apiRef.current = api;
  const root = `/v1/organizations/${organizationId}/webhooks`;
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(isAdmin),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [description, setDescription] = useState(""),
    [url, setUrl] = useState(""),
    [events, setEvents] = useState<WebhookEvent[]>([
      "sms.received",
      "call.received",
      "call.connected",
      "call.ended",
    ]);
  const [secret, setSecret] = useState(""),
    [selected, setSelected] = useState(""),
    [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]),
    [confirm, setConfirm] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!isAdmin || !organizationId) return;
      setLoading(true);
      try {
        const result = await apiRef.current<{ items: WebhookEndpoint[] }>(
          root,
          signal ? { signal } : {},
        );
        if (!signal?.aborted) setEndpoints(result.items);
      } catch (caught) {
        if (!signal?.aborted) setError(errorText(caught));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [root, isAdmin, organizationId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  async function action(work: () => Promise<void>) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      actionInFlight.current = false;
      setBusy(false);
      setConfirm("");
    }
  }
  async function history(id: string) {
    const result = await apiRef.current<{ items: WebhookDelivery[] }>(
      `${root}/${id}/deliveries`,
    );
    setSelected(id);
    setDeliveries(result.items);
  }
  return (
    <section className="settings-section api-integrations">
      <div className="settings-section-heading">
        <h3>
          <Code size={20} />
          API & webhooks
        </h3>
        <a
          href={`${apiBase.replace(/\/$/, "")}/docs`}
          target="_blank"
          rel="noreferrer"
        >
          Documentation API ↗
        </a>
      </div>
      <p className="settings-description">
        Connectez vos outils aux contacts, SMS et appels. Recevez les événements
        sur votre serveur pour déclencher vos automatisations.
      </p>
      {!isAdmin && (
        <p className="settings-description">
          Un administrateur de votre organisation peut configurer les webhooks.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="api-notice" role="status">
          {notice}
        </p>
      )}
      {secret && (
        <div className="api-secret" role="status">
          <strong>Copiez votre secret de signature</strong>
          <p>
            Il est affiché une seule fois. Conservez-le sur votre serveur pour
            vérifier les événements reçus.
          </p>
          <code>{secret}</code>
          <div className="api-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(secret)
                  .then(() => setNotice("Secret copié."))
                  .catch(() =>
                    setError(
                      "La copie est indisponible. Sélectionnez le secret pour le copier.",
                    ),
                  )
              }
            >
              <Copy size={16} />
              Copier
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setSecret("")}
            >
              J’ai conservé le secret
            </button>
          </div>
        </div>
      )}
      {isAdmin && (
        <>
          <div className="api-actions">
            <button
              type="button"
              className="text-button"
              disabled={busy || loading}
              onClick={() =>
                void action(async () => {
                  await load();
                  if (selected) await history(selected);
                })
              }
            >
              <ArrowClockwise size={16} />
              Actualiser
            </button>
            <span className="settings-description">
              {endpoints.length} / 10 webhooks
            </span>
          </div>
          {loading && <p role="status">Chargement des webhooks…</p>}
          {!loading && !error && endpoints.length === 0 && (
            <p className="settings-description">
              Aucun webhook configuré. Ajoutez votre premier endpoint
              ci-dessous.
            </p>
          )}
          {endpoints.map((endpoint) => (
            <article key={endpoint.id} className="api-endpoint">
              <div className="api-endpoint-title">
                <strong>{endpoint.description}</strong>
                <span
                  className={`api-badge ${endpoint.enabled ? "enabled" : ""}`}
                >
                  {endpoint.enabled ? "Actif" : "Suspendu"}
                </span>
              </div>
              <p className="api-url">{endpoint.url}</p>
              <p className="settings-description">
                {endpoint.events
                  .map((event) => webhookEventLabels[event])
                  .join(" · ")}
              </p>
              <div className="api-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy || !endpoint.enabled}
                  onClick={() =>
                    void action(async () => {
                      await apiRef.current(`${root}/${endpoint.id}/test`, {
                        method: "POST",
                      });
                      setNotice(
                        "Événement de test mis en file. Actualisez les livraisons pour voir le résultat.",
                      );
                      await history(endpoint.id);
                    })
                  }
                >
                  Envoyer un test
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void action(() => history(endpoint.id))}
                >
                  Livraisons
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await apiRef.current(`${root}/${endpoint.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ enabled: !endpoint.enabled }),
                      });
                      await load();
                      if (selected === endpoint.id) await history(endpoint.id);
                    })
                  }
                >
                  {endpoint.enabled ? "Suspendre" : "Réactiver"}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setConfirm(`rotate:${endpoint.id}`)}
                >
                  Renouveler le secret
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setConfirm(`delete:${endpoint.id}`)}
                >
                  Supprimer
                </button>
              </div>
              {confirm.endsWith(`:${endpoint.id}`) && (
                <div className="api-confirm">
                  <p>
                    {confirm.startsWith("rotate")
                      ? "Le secret actuel cessera de fonctionner. Mettez à jour votre serveur avec le nouveau secret après confirmation."
                      : "Ce webhook sera supprimé et les livraisons en attente seront annulées."}
                  </p>
                  <div className="api-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          if (confirm.startsWith("rotate")) {
                            const result = await apiRef.current<{
                              secret: string;
                            }>(`${root}/${endpoint.id}/rotate-secret`, {
                              method: "POST",
                            });
                            setSecret(result.secret);
                          } else {
                            await apiRef.current(`${root}/${endpoint.id}`, {
                              method: "DELETE",
                            });
                            if (selected === endpoint.id) {
                              setSelected("");
                              setDeliveries([]);
                            }
                            await load();
                          }
                        })
                      }
                    >
                      Confirmer
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => setConfirm("")}
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              )}
              {selected === endpoint.id && (
                <div className="api-deliveries">
                  <h4>50 dernières livraisons · 7 jours</h4>
                  {!deliveries.length ? (
                    <p className="settings-description">
                      Aucune livraison pour le moment.
                    </p>
                  ) : (
                    <div className="api-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Événement / date</th>
                            <th>État</th>
                            <th>Tentatives</th>
                            <th>HTTP</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {deliveries.map((delivery) => (
                            <tr key={delivery.id}>
                              <td>
                                <code>{delivery.eventType}</code>
                                <small>
                                  {new Date(delivery.createdAt).toLocaleString(
                                    "fr-FR",
                                  )}
                                </small>
                              </td>
                              <td>
                                {statusLabel[delivery.status]}
                                {delivery.lastError && (
                                  <small>{delivery.lastError}</small>
                                )}
                              </td>
                              <td>{delivery.attempts} / 8</td>
                              <td>{delivery.httpStatus ?? "—"}</td>
                              <td>
                                {delivery.status === "failed" && (
                                  <button
                                    type="button"
                                    className="text-button"
                                    disabled={busy || !endpoint.enabled}
                                    onClick={() =>
                                      void action(async () => {
                                        await apiRef.current(
                                          `${root}/${endpoint.id}/deliveries/${delivery.id}/retry`,
                                          { method: "POST" },
                                        );
                                        await history(endpoint.id);
                                        setNotice(
                                          "Livraison remise en file avec le même identifiant d’événement.",
                                        );
                                      })
                                    }
                                  >
                                    Relancer
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
          <details className="api-create">
            <summary>
              <Plus size={16} />
              Ajouter un webhook
            </summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void action(async () => {
                  const result = await apiRef.current<
                    WebhookEndpoint & { secret: string }
                  >(root, {
                    method: "POST",
                    body: JSON.stringify({ description, url, events }),
                  });
                  setSecret(result.secret);
                  setDescription("");
                  setUrl("");
                  setNotice(
                    "Webhook créé. Configurez le secret sur votre serveur, puis envoyez un test.",
                  );
                  await load();
                });
              }}
            >
              <label className="field-label">
                Nom
                <input
                  required
                  maxLength={120}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="CRM · Équipe commerciale"
                />
              </label>
              <label className="field-label">
                URL de réception HTTPS
                <input
                  required
                  type="url"
                  maxLength={2048}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://votre-serveur.fr/webhooks/onoff"
                />
              </label>
              <fieldset>
                <legend>Événements à recevoir</legend>
                <div className="api-event-grid">
                  {Object.entries(webhookEventLabels).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={events.includes(key as WebhookEvent)}
                        onChange={(event) =>
                          setEvents((current) =>
                            event.target.checked
                              ? [...current, key as WebhookEvent]
                              : current.filter((item) => item !== key),
                          )
                        }
                      />
                      <span>
                        {label}
                        <small>{key}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="settings-description">
                Les événements concernent toutes les lignes de cette
                organisation. Les SMS incluent leur contenu. La disponibilité
                décrit la réception dans l’application, indépendamment du statut
                dans les files d’attente.
              </p>
              <button
                className="button button-primary"
                disabled={
                  busy || loading || !events.length || endpoints.length >= 10
                }
              >
                {busy ? "Enregistrement…" : "Créer le webhook"}
              </button>
            </form>
          </details>
        </>
      )}
    </section>
  );
}

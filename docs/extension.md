# Extension Chrome click-to-call

À l’ouverture du popup, l’extension détecte les numéros français et internationaux dans le texte visible de la page et les liens `tel:`. Elle normalise et déduplique les résultats. Le bouton **Actualiser les numéros** relit les pages qui ont changé. Une saisie manuelle reste disponible, notamment sur les pages internes de Chrome qui interdisent l’injection. Les iframes ne sont pas parcourues.

## Installation

1. Lancer `pnpm --filter @onoff/extension build`.
2. Dans `chrome://extensions`, activer le mode développeur et charger `apps/extension/.output/chrome-mv3` (ou recharger l’extension existante).
3. Configurer l’adresse de l’application dans les réglages du popup. HTTPS est requis hors localhost.
4. Ouvrir une page contenant des numéros, puis le popup Onoff.
5. Cliquer **Appeler** à côté du numéro. Au premier appel, Chrome demande l’accès au domaine de l’application Onoff.

Le clic réutilise un onglet Onoff existant ou en ouvre un. L’application web doit inclure le pont d’appel ajouté dans `App.tsx`. Elle utilise la session, l’organisation et la ligne actives, puis le parcours normal d’intention serveur et de microphone. Une connexion, une autorisation de microphone ou une ligne indisponible peut nécessiter une intervention. Aucun appel n’est mis en attente après une erreur : relancer explicitement depuis le popup.

## Permissions et données

Les permissions permanentes sont `activeTab`, `scripting` et `storage`. La lecture de page a lieu uniquement à l’ouverture du popup ou à son actualisation. Seuls les candidats téléphoniques sont retournés au popup, jamais le texte complet. Le numéro choisi et l’adresse de l’application sont stockés localement.

L’accès optionnel au domaine de l’application permet d’y injecter le geste d’appel. Les liens `callTo` seuls restent des brouillons et ne lancent aucun appel. L’extension ne stocke aucun secret d’API ou jeton de session.

Archive : `pnpm --filter @onoff/extension zip`.

Validation automatisée : extraction, normalisation, URLs, vérifications TypeScript et build. L’appel réel et le dialogue de permission Chrome doivent être vérifiés avec une session et une ligne configurées.

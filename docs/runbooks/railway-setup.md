# Déploiement sur Railway

Le projet Railway privé `onoffv2` se trouve dans l'espace `Hugo Samson's Projects` (ID `bcf5f5a8-4a85-4f5a-bf97-26ffd7cb9155`), environnement `production` (ID `862837d5-580b-4602-adc6-b8f831e84347`). Les services API et Web sont reliés à `Samsooon76/on-on`, branche `main`, racine `/`, et déployés. Les mises à jour de `main` déclenchent leurs déploiements.

| Service | URL | État |
|---|---|---|
| Web | <https://web-production-bcb2b.up.railway.app> | `SUCCESS` |
| API | <https://api-production-b35d.up.railway.app> | `SUCCESS` |

Le Web sert l'écran de connexion. Les comptes sont créés par un administrateur; aucun utilisateur ni ligne de démonstration n'a été ajouté aux données hébergées.

## Configuration des services

### API

- Build : `pnpm --filter @onoff/contracts build && pnpm --filter @onoff/api build`
- Start : `pnpm --filter @onoff/api start`
- Healthcheck : `/health/ready` (Auth Supabase et endpoint PostgREST)
- Veille : désactivée pour garder les webhooks Twilio disponibles.
- `API_PORT` peut rester absent : l'API utilise le `PORT` injecté par Railway.

### Web

- Build : `pnpm --filter @onoff/contracts build && pnpm --filter @onoff/api-client build && pnpm --filter @onoff/voice-contract build && pnpm --filter @onoff/voice-web build && pnpm --filter @onoff/web build`
- Start : `pnpm --filter @onoff/web start`
- Healthcheck : `/health/live`
- Le serveur statique `apps/web/server.mjs` sert `dist`, les routes SPA et les fichiers immuables avec leurs en-têtes de cache.

### Worker (en attente des credentials)

- Build : `pnpm --filter @onoff/contracts build && pnpm --filter @onoff/api build && pnpm --filter @onoff/worker build`
- Start : `pnpm --filter @onoff/worker start`
- Réplicas : un seul au départ; les appels Twilio sont retrouvés à partir des `call_legs` persistés, puis les prochaines vérifications sont espacées en base.
- Variables : mêmes `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID` et `TWILIO_API_KEY_SECRET` du même environnement; optionnellement `WORKER_POLL_INTERVAL_MS` (30 secondes par défaut).
- Le worker refuse une URL Supabase locale, ne journalise ni numéros ni contenu, rattrape les appels actifs auprès de Twilio et expire les intentions/réservations préparatoires échues.
- Les erreurs Twilio reviennent avec backoff borné (jusqu'à une heure); le prochain essai est persisté sur la jambe d'appel. Les callbacks réussis et ce worker partagent `apply_call_status`, qui déduplique les événements fournisseur.
- Le worker n'est pas encore créé dans Railway : il échoue volontairement au démarrage sans clé serveur Supabase et credentials Twilio. Le déployer après avoir fourni `SUPABASE_SECRET_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID` et `TWILIO_API_KEY_SECRET`. Le worker est distinct de l'API et doit utiliser le projet Supabase correspondant à son environnement.

## Variables

Variables déjà définies sur **API** et **Web** dans `production` :

```text
APP_ENV=production
API_HOST=0.0.0.0
API_PUBLIC_URL=https://api-production-b35d.up.railway.app
WEB_PUBLIC_URL=https://web-production-bcb2b.up.railway.app
ALLOWED_ORIGINS=https://web-production-bcb2b.up.railway.app
SUPABASE_URL=https://mzqycbxnbyxeivdduhrl.supabase.co
SUPABASE_PUBLISHABLE_KEY=<clé publishable configurée dans Railway>
VOICE_ENABLED=false
SMS_ENABLED=false
OPERATIONS_PAUSED=false
```

`SUPABASE_SECRET_KEY` et les secrets Twilio ne sont pas encore configurés. Voix et SMS restent désactivés. Ajouter les secrets côté Railway uniquement après rotation des anciennes valeurs et vérification de la ligne. Pour autoriser le mobile, définir aussi les SID de credentials push iOS/Android décrits dans [twilio-setup.md](twilio-setup.md). Ne jamais mettre une clé secrète dans le service Web.

Définir sur le service **Web** (disponibles au build Vite) :

```text
VITE_API_BASE_URL=https://api-production-b35d.up.railway.app
VITE_SUPABASE_URL=https://mzqycbxnbyxeivdduhrl.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<clé publishable configurée dans Railway>
```

Les origines Web et API correspondent aux domaines Railway. Configurer les URLs Auth Supabase et les webhooks Twilio avant le smoke test.

## Procédure de déploiement

1. Les services API et Web sont reliés à `Samsooon76/on-on@main`; ne pas recréer le projet.
2. Ajouter la clé serveur Supabase et les credentials Twilio au worker après leur obtention sécurisée.
3. Ajouter le compte administrateur et la ligne de test dans le projet Supabase hébergé.
4. Configurer les URLs Auth Supabase et les webhooks Twilio avec les domaines ci-dessus.
5. Garder voix/SMS désactivés jusqu'à la validation des credentials, de la limite de 10 € et du destinataire autorisé en France.
6. Réaliser le smoke test contrôlé à partir de [demo-scenarios.md](../demo-scenarios.md) et consigner son résultat.

Railway recommande désormais Infrastructure as Code avec un unique `.railway/railway.ts` pour un monorepo; son ancien format `railway.toml` est en fin de support et ne doit pas être ajouté à un nouveau projet. La configuration IaC finale doit référencer le dépôt GitHub confirmé avant son application, car une définition partielle peut créer ou modifier des ressources Railway.

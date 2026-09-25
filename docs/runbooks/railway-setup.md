# Déploiement de démonstration sur Railway

L'application est préparée pour deux services Railway construits depuis la racine du monorepo. Le dépôt cible `Samsooon76/on-on` a été fourni, mais n'a pas pu être lu ni configuré comme remote : la résolution DNS de `github.com` échoue dans cet environnement, le jeton `gh` présent est invalide et le dossier `.git` du checkout est en lecture seule. Aucun service Onoff n'a été créé; les deux projets Railway visibles (`soothing-peace` et `compassionate-patience`) ne correspondent pas à ce dépôt.

Railway exige que le dépôt GitHub soit connecté à son intégration pour le premier déploiement. Une fois l'accès rétabli, connecter `Samsooon76/on-on` avant de lancer `railway_create_deployment`; ne pas sélectionner un autre dépôt ni réutiliser un projet existant. Après création du service, régler son répertoire racine sur `/` pour conserver le contexte pnpm du monorepo.

## Services

### API

- Build : `pnpm --filter @onoff/contracts build && pnpm --filter @onoff/api build`
- Start : `pnpm --filter @onoff/api start`
- Healthcheck : `/health/ready`
- Veille : désactivée pour garder les webhooks Twilio disponibles.
- `API_PORT` peut rester absent : l'API utilise le `PORT` injecté par Railway.

### Web

- Build : `pnpm --filter @onoff/contracts build && pnpm --filter @onoff/api-client build && pnpm --filter @onoff/voice-contract build && pnpm --filter @onoff/voice-web build && pnpm --filter @onoff/web build`
- Start : `pnpm --filter @onoff/web start`
- Healthcheck : `/health/live`
- Le serveur statique `apps/web/server.mjs` sert `dist`, les routes SPA et les fichiers immuables avec leurs en-têtes de cache.

### Worker

- Build : `pnpm --filter @onoff/contracts build && pnpm --filter @onoff/api build && pnpm --filter @onoff/worker build`
- Start : `pnpm --filter @onoff/worker start`
- Réplicas : un seul au départ; les appels Twilio sont retrouvés à partir des `call_legs` persistés, puis les prochaines vérifications sont espacées en base.
- Variables : mêmes `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID` et `TWILIO_API_KEY_SECRET` du même environnement; optionnellement `WORKER_POLL_INTERVAL_MS` (30 secondes par défaut).
- Le worker refuse une URL Supabase locale, ne journalise ni numéros ni contenu, rattrape les appels actifs auprès de Twilio et expire les intentions/réservations préparatoires échues.
- Les erreurs Twilio reviennent avec backoff borné (jusqu'à une heure); le prochain essai est persisté sur la jambe d'appel. Les callbacks réussis et ce worker partagent `apply_call_status`, qui déduplique les événements fournisseur.
- N'ajouter les credentials Twilio qu'après rotation des anciennes valeurs. Le worker est distinct de l'API et doit utiliser le projet Supabase correspondant à son environnement.

## Variables

Définir les variables sur le service **API** dans l'environnement `demo` :

```text
APP_ENV=demo
API_HOST=0.0.0.0
API_PUBLIC_URL=https://<domaine-api>
WEB_PUBLIC_URL=https://<domaine-web>
ALLOWED_ORIGINS=https://<domaine-web>
SUPABASE_URL=https://<projet-demo>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<clé-publishable-du-projet-demo>
SUPABASE_SECRET_KEY=<clé-secrète-du-projet-demo>
VOICE_ENABLED=false
SMS_ENABLED=false
OPERATIONS_PAUSED=false
OPERATIONS_PAUSE_MESSAGE=Les créations d’appels et de SMS sont temporairement suspendues pour maintenance. Réessayez un peu plus tard.
```

Ajouter les secrets Twilio uniquement après leur rotation et après vérification de la ligne. Pour autoriser le mobile, définir aussi les SID de credentials push iOS/Android décrits dans [twilio-setup.md](twilio-setup.md). Ne jamais mettre une clé secrète dans le service Web.

Définir sur le service **Web** (disponibles au build Vite) :

```text
VITE_API_BASE_URL=https://<domaine-api>
VITE_SUPABASE_URL=https://<projet-demo>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<clé-publishable-du-projet-demo>
```

Les origines Web et API doivent correspondre exactement aux domaines Railway obtenus. Après génération des domaines, synchroniser `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `ALLOWED_ORIGINS`, les URLs Auth Supabase et les webhooks Twilio avant le smoke test.

## Procédure après rétablissement de l'accès GitHub

1. Relier le dépôt confirmé `Samsooon76/on-on` à Railway et choisir la branche de livraison.
2. Créer un **nouveau** projet Railway de démonstration, puis relier deux services au même dépôt et à la branche, racine `/`.
3. Poser les commandes build/start et healthchecks ci-dessus; générer un domaine public pour les deux services.
4. Créer/choisir le projet Supabase de démonstration et configurer Auth, puis appliquer ses migrations contrôlées avant d'ajouter les utilisateurs de test.
5. Définir les variables de secrets dans Railway, laisser voix/SMS coupés, puis déployer et vérifier les healthchecks.
6. Configurer exactement les domaines dans Supabase Auth, CORS et Twilio; activer les services seulement après rotation des anciennes clés, limites de coûts et validation des destinataires.
7. Réaliser le smoke test contrôlé à partir de [demo-scenarios.md](../demo-scenarios.md) et consigner son résultat.

Railway recommande désormais Infrastructure as Code avec un unique `.railway/railway.ts` pour un monorepo; son ancien format `railway.toml` est en fin de support et ne doit pas être ajouté à un nouveau projet. La configuration IaC finale doit référencer le dépôt GitHub confirmé avant son application, car une définition partielle peut créer ou modifier des ressources Railway.

# Onoffv2

Prototype privé de téléphonie multicanal : React/Vite pour le web, Fastify pour l'API, Supabase pour l'identité et les données, Twilio pour la voix et les SMS.

## Démarrage

1. Utiliser Node.js 24.21.0 LTS et pnpm 11.9.0 (`.nvmrc` et `packageManager` épinglent leurs versions respectives).
2. Copier `.env.example` vers `.env` et renseigner les variables de développement. `dev` cible le projet Supabase hébergé `onoffv2` en eu-west-1. Les secrets API restent côté serveur.
3. Installer les dépendances avec `pnpm install`.
4. Les migrations et types sont gérés sur le projet Supabase en ligne : `pnpm db:migrations:online`, `pnpm db:push:online` et `pnpm db:types:online`. Vérifier le projet affiché avant toute migration.
5. Lancer `pnpm dev`. L'API écoute sur `http://localhost:4100`; le web écoute sur `http://localhost:5173`.
6. Pour le mobile, copier `apps/mobile/.env.example` vers `apps/mobile/.env`, puis lancer `pnpm --filter @onoff/mobile start`. Le SDK vocal natif Twilio exige un development build iOS/Android; Expo Go ne suffit pas. Voir [la procédure mobile](docs/mobile-compatibility.md).
7. Pour l'extension Chrome, lancer `pnpm --filter @onoff/extension dev`, puis charger `apps/extension/.output/chrome-mv3-dev` dans `chrome://extensions` avec le mode développeur. Renseigner l'URL HTTPS de l'application dans les réglages de l'extension. Voir [le guide click-to-call](docs/extension.md).

Le worker d'exploitation s'exécute séparément avec `pnpm --filter @onoff/worker dev` ou `pnpm --filter @onoff/worker start`. Il requiert des credentials serveur Supabase et Twilio rotatés, et refuse explicitement une URL Supabase locale.

Les appels et SMS sont désactivés tant que les valeurs Twilio vérifiées de l'environnement ne sont pas configurées. Les valeurs secrètes ne sont pas stockées dans ce dépôt.

## Scripts

`pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:migrations:online`, `pnpm db:push:online` et `pnpm db:types:online`.

## Documentation

- [Connecteur MCP utilisateurs : fonctionnalités et activation](docs/runbooks/mcp-setup.md)

- [Administration, rôles, permissions et IVR](docs/administration.md)

- [Périmètre MVP](docs/mvp-scope.md)
- [Scénarios de démonstration](docs/demo-scenarios.md)
- [Architecture](docs/architecture.md)
- [Décision mobile Expo](docs/decisions/002-mobile-runtime.md)
- [Modèle de données](docs/data-model.md)
- [API](docs/api.md)
- [Limitations connues](docs/known-limitations.md)
- [Configuration Twilio](docs/runbooks/twilio-setup.md)
- [Commande de numéros depuis l’interface](docs/runbooks/number-provisioning.md)
- [Rotation des secrets](docs/runbooks/secrets-rotation.md)
- [Sauvegarde et restauration Supabase](docs/runbooks/backup-and-restore.md)
- [Déploiement Railway](docs/runbooks/railway-setup.md)
- [Diagnostic et reprise](docs/runbooks/incident-diagnostics.md)
- [État d'implémentation](docs/implementation-status.md)
- [Compatibilité mobile](docs/mobile-compatibility.md)
- [Extension Chrome click-to-call](docs/extension.md)
- [Rapport de build et smoke tests](docs/test-reports/2026-09-25-build-and-smoke.md)

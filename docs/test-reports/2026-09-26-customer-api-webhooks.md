# Vérification API clients et webhooks — 26 septembre 2026

## Livré dans le code

- Documentation publique `/docs` avec recherche et 30 opérations documentées ; OpenAPI 3.1 sur `/openapi.json`, produit à partir des schémas des routes.
- Réglages « API & webhooks » : création, choix des événements, suspension, suppression, rotation de secret, test, historique et relance d’échec.
- 12 types d’événements métier, plus l’événement de test.
- File transactionnelle PostgreSQL, réservations de travail, reprises bornées, signatures HMAC-SHA256, secrets chiffrés, rétention de 7 jours.
- Exemple Node.js de réception avec stockage PostgreSQL avant réponse.

## Contrôles exécutés

Runtime des builds et tests : Node.js 24.21.0, pnpm 11.9.0.

- `pnpm build` : succès pour tous les packages et applications du build racine. Avertissement Vite existant sur la taille des bundles.
- `pnpm test` : 189 tests réussis, zéro échec. Un test de configuration supplémentaire ajouté ensuite porte la suite API à 96 tests, tous réussis.
- Après les dernières modifications : compilation contrats/API, vérification des types worker/web, puis suite API complète réussies.
- `pnpm test:admin:db` : 31 migrations appliquées dans PostgreSQL isolé via PGlite. Suites administration/IVR, centre d’appels, MCP et webhooks réussies.
- Chromium : documentation et réglages sur desktop puis viewport 390 × 844. Recherche « webhooks » : 8 opérations affichées. Pas de débordement horizontal de la page. Formulaire, affichage du secret et relance d’une livraison vérifiés avec un adaptateur API de démonstration.

## Cas vérifiés

Isolation entre organisations ; refus des non-administrateurs et organisations suspendues ; absence de secret dans les listes ; validation des UUID ; chiffrement et authentification du secret ; signature des octets bruts ; refus de signature altérée/expirée/dans le futur ; blocage d’adresses privées, loopback, multicast, IPv4 mappées et réponses DNS mixtes.

Événements annulés avec la transaction métier ; absence de doublon sur un statut inchangé ; distinction sonnerie/connexion ; appel manqué ; message vocal ; rôle utilisateur ; expiration silencieuse de la présence web ; absence de répétition des heartbeats.

Réservation exclusive d’une livraison ; reprise après expiration ; refus d’un ancien token de réservation ; temporisation persistée ; arrêt après huit tentatives ; relance conservant l’identifiant d’événement ; suspension annulant la file ; révocation du créateur ; purge du contenu et de l’historique après rétention.

## Périmètre de validation

Aucune migration appliquée à Supabase hébergé, aucun déploiement, aucun SMS/appel ni POST à un serveur client réel. Le transport externe est simulé dans les tests. L’activation doit suivre [le guide d’exploitation](../webhooks.md#activation-de-linstance-équipe-produit), puis un test signé vers le récepteur cible.

Captures locales : `output/playwright/api-docs-desktop.png`, `api-docs-mobile.png`, `api-webhooks-settings.png`, `api-webhooks-mobile.png`.

# Administration web

L’onglet **Administration** est réservé aux administrateurs actifs de l’organisation sélectionnée. Il reste utilisable depuis un navigateur mobile. L’application mobile native conserve ses écrans de téléphonie ; elle reçoit les appels IVR et applique les mêmes permissions serveur, sans nouvelle version mobile requise pour ces changements.

## Utilisateurs et permissions

- **Administrateur** : gestion des comptes, rôles, affectations de lignes, achats, menus IVR et historique d’administration.
- **Membre** : utilisation des contacts et des lignes qui lui sont attribuées.
- Les droits **Appels** et **SMS** sont indépendants, attribués par utilisateur et par numéro. Un administrateur a lui aussi besoin d’une affectation pour utiliser une ligne.
- La création demande un nom, un email unique et un mot de passe initial d’au moins 12 caractères. Le compte est créé côté serveur avec Supabase Auth. Aucun email automatique n’est envoyé et un compte existant n’est jamais remplacé. Le mot de passe doit être communiqué confidentiellement ; l’utilisateur peut utiliser « Mot de passe oublié » pour le remplacer.
- La suspension coupe l’accès à l’organisation en conservant les affectations. La réactivation conserve ces droits ; l’appareil doit se réenregistrer pour recevoir des appels. Le retrait d’accès révoque aussi les affectations. Le compte Auth reste disponible pour ses autres organisations. Les appels déjà connectés peuvent se terminer.
- Le dernier administrateur actif ne peut pas être suspendu, révoqué ou rétrogradé. La vérification s’effectue sous verrou dans la transaction PostgreSQL.
- Les modifications de membre et d’IVR utilisent la version `updated_at` : une modification concurrente retourne `409`, sans écraser l’autre administrateur.

## Numéros et IVR

**Numéros & IVR** affiche toutes les lignes de l’organisation, même celles qui ne sont pas affectées à l’administrateur. **Ajouter un numéro** réutilise l’achat existant : devis, conformité, confirmation du coût et reprise des commandes incertaines.

L’éditeur IVR configure un menu à un niveau : message d’accueil, langue (français ou anglais), touches 0–9 uniques, destination par touche (un utilisateur ou toute la ligne), attente de 3–15 secondes, une à trois tentatives, puis sonnerie de toute la ligne ou annonce de fin d’appel. Les consignes des touches sont lues automatiquement. Les destinations individuelles doivent avoir le droit Appels sur la ligne.

Le webhook signé `/webhooks/twilio/voice/inbound` journalise l’appel avant le menu. Le choix revient sur `/webhooks/twilio/voice/ivr?attempt=N`. La configuration est figée pour cet appel, les appareils sont réservés après le choix et les permissions sont revérifiées à ce moment. Les retries sont sérialisés par CallSid ; rejouer une requête ne consomme pas une tentative supplémentaire. Si aucun appareil n’est disponible, l’appel se termine avec une annonce et reste dans l’historique.

Désactiver le menu rétablit la sonnerie directe pour les nouveaux appels. Les menus en cours gardent leur configuration. Un menu ne peut pas être enregistré comme actif sans touche ni sur une ligne sans capacité vocale.

Le périmètre ne comprend pas les transferts vers un numéro externe, les sous-menus, les horaires ni la messagerie vocale enregistrée.

## API

Toutes ces routes exigent un Bearer token et un administrateur actif de `orgId` :

| Méthode | Route | Usage |
| --- | --- | --- |
| GET | `/v1/organizations/:orgId/admin` | Utilisateurs, lignes, affectations et 50 dernières actions |
| POST | `/v1/organizations/:orgId/admin/members` | Créer un compte et son adhésion |
| PATCH | `/v1/organizations/:orgId/admin/members/:userId` | Nom, rôle, statut et version |
| PUT | `/v1/organizations/:orgId/admin/lines/:lineId/ivr` | Configuration complète et version |
| PUT / DELETE | `/v1/organizations/:orgId/lines/:lineId/assignments/:userId` | Affecter ou révoquer les droits Appels/SMS |

Les mutations et la lecture des emails sont réservées aux RPC `service_role`. Les rôles navigateur ne peuvent ni invoquer ces RPC, ni écrire directement les adhésions ou les configurations. Aucune clé serveur ne part dans le client.

## Vérification et mise en ligne

`pnpm test:admin:db` applique toutes les migrations dans PostgreSQL embarqué (PGlite), puis teste les permissions, le dernier administrateur, les conflits de version, l’isolation RLS, les menus, les reprises Twilio, les destinations mobiles et les suspensions en cours de menu. Ce test crée uniquement une base en mémoire. Les services réseau Auth et Realtime sont exclus de ce test ; leurs dépendances sont simulées dans les tests API.

`pnpm --filter @onoff/api test`, `pnpm --filter @onoff/web test`, `pnpm typecheck` et `pnpm build` complètent la vérification. L’aperçu navigateur a été vérifié avec des données fictives sur ordinateur et en largeur 390 px.

Les migrations `20260926091137_manage_line_assignments.sql` et `20260926091147_web_administration_and_ivr.sql` doivent être appliquées dans cet ordre au projet Supabase `mzqycbxnbyxeivdduhrl`, puis l’API et le web doivent être déployés. Tous les IVR restent désactivés par défaut. L’ancienne signature `begin_inbound_call` est conservée pour le déploiement progressif ; n’activer aucun IVR avant que la nouvelle API soit en ligne. Régénérer ensuite les types avec `pnpm db:types:online`.

Ces deux migrations ont été appliquées en production le 26 septembre 2026. Leurs noms de fichiers correspondent aux versions enregistrées par Supabase. Après application, la lecture d’administration et les permissions des sept RPC concernées ont été vérifiées, puis l’onglet Administration a chargé le compte administrateur dans le navigateur de production. Une API déployée sans ces migrations peut répondre `503 admin_unavailable`, même si son contrôle de santé général réussit.

Après déploiement, vérifier un compte membre et un compte admin puis effectuer un appel réel vers une ligne IVR avec un appareil web et un appareil mobile enregistré. Aucun compte réel, achat de numéro ou appel payant n’est nécessaire pour les tests automatisés.

Références : [création serveur Supabase Auth](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [collecte DTMF Twilio](https://www.twilio.com/docs/voice/twiml/gather), [identité et paramètres du destinataire Twilio](https://www.twilio.com/docs/voice/twiml/client#custom-parameters).

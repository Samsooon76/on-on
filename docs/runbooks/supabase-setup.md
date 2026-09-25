# Runbook — Supabase hébergé

Ce dépôt utilise le projet Supabase hébergé `onoffv2` (`mzqycbxnbyxeivdduhrl`, région eu-west-1). Les commandes de migration et de génération des types ciblent ce projet. Ne démarrez pas de base Supabase locale et ne réinitialisez pas la base en ligne.

## Préparer Auth

1. Dans le tableau de bord du projet, ouvrez **Authentication → URL Configuration**.
2. Définissez **Site URL** sur l’origine HTTPS exacte de l’application web déployée.
3. Ajoutez cette origine à **Redirect URLs** et ajoutez les origines précises des environnements de développement utilisés pour les liens de récupération. Évitez les jokers larges en production.
4. Dans **Authentication → Providers → Email**, désactivez les inscriptions publiques. L’application ne propose pas de formulaire de création de compte.
5. Créez les utilisateurs de test avec l’action **Invite user** du tableau de bord. Confirmez ensuite l’adresse et créez une appartenance active à une organisation via le processus d’administration approuvé.
6. Vérifiez le modèle d’e-mail d’invitation et de récupération, puis testez les liens sur le domaine déployé. L’écran web utilise `resetPasswordForEmail` avec l’origine courante et accepte le retour `PASSWORD_RECOVERY`.

La configuration d'Auth est décrite dans [la configuration générale Supabase Auth](https://supabase.com/docs/guides/auth/general-configuration) et dans [la gestion des utilisateurs](https://supabase.com/docs/guides/auth/users).

Supabase Auth applique des quotas natifs sur ses endpoints (notamment OTP et renouvellement de session). Avant une démonstration, vérifier les seuils effectifs dans **Authentication → Rate Limits** et les adapter au mode d'envoi e-mail/SMS choisi; un dépassement renvoie `429`. Ces quotas complètent le rate limiting partagé de l'API pour les tokens Voice, intentions d'appel, SMS et diagnostics. [Documentation Supabase des limites Auth](https://supabase.com/docs/guides/auth/rate-limits).

## Migrations et types

Depuis la racine du dépôt :

```sh
pnpm db:migrations:online
pnpm db:push:online
pnpm db:types:online
```

Avant `db:push:online`, relisez la migration et vérifiez le projet ciblé dans le tableau de bord. Après l'application, contrôlez l'historique en ligne et les advisors. Le dépôt conserve une copie des migrations sous `supabase/migrations/`; ne modifiez pas une migration déjà appliquée, ajoutez-en une nouvelle.

Pour inspecter le schéma via l'intégration Supabase, sélectionnez explicitement `mzqycbxnbyxeivdduhrl`. N'utilisez pas `supabase start`, `supabase stop`, `supabase db reset` ou des tests contre une base locale pour ce projet.

## Clés et données

- `SUPABASE_URL` et la clé publishable sont utilisables par le web/API.
- La clé secrète Supabase reste exclusivement dans les secrets API/worker. Elle ne doit jamais être préfixée `VITE_` ni copiée dans une application cliente.
- Authentifiez les routes avec le JWT utilisateur et conservez les vérifications RLS.
- Ne créez pas d'utilisateurs, d'organisations, de lignes ou de messages fictifs dans le projet partagé.
- Pour des tests RLS avec plusieurs rôles, utilisez un projet ou une branche distante isolée, jamais les tables de test de `onoffv2`.

## État vérifié le 2026-09-25

Vingt-cinq migrations sont présentes dans le projet hébergé `onoffv2` (dernière : `20260925152637_restore_guarded_user_rpc_access`). Les 19 tables `public` ont RLS active. La table `api_rate_limit_windows` n'accorde aucun privilège aux rôles `anon` et `authenticated`; son RPC et ses accès directs sont réservés à `service_role`. Les advisors signalent quatre fonctions `SECURITY DEFINER` appelables par les utilisateurs authentifiés : `issue_call_intent`, `prepare_outbound_message`, `list_pending_outbound_messages` et `set_device_voice_state`. Leurs grants restent limités à `authenticated`; leurs identifiants appelant/utilisateur, appartenances et affectations sont vérifiés dans chaque fonction, et `search_path` est vide. L'accès authentifié est nécessaire au contrat actuel car l'API transmet le JWT utilisateur à ces RPC. L'advisor performance signale 35 index inutilisés sur une base de test encore vide, dont les index de reprise; ne supprimez pas les index avant d'avoir observé une charge représentative.

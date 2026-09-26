# Passe fonctionnelle de la webapp — 26 septembre 2026

Corrections appliquées au code local. Les changements préexistants du dépôt ont été conservés. Aucun déploiement, achat de numéro, appel ou SMS n’a été effectué pendant cette passe. Aucune donnée de démonstration n’a été ajoutée à la base hébergée.

## Corrections

- Ajout de `GET /v1/services`, authentifié et sans cache, pour exposer la configuration effective des appels, SMS, administration, achats et maintenance, sans secrets. Cet état décrit la configuration ; il ne garantit pas la disponibilité de Twilio.
- Les actions du web respectent ces capacités, les permissions de ligne, la présence vocale et le réseau. Les services désactivés sont signalés, les actions impossibles sont désactivées. Le carnet reste utilisable sans téléphonie.
- Suppression des annonces de fonctions non livrées : enregistrements/transcriptions dans les conversations, qualification JEV dans le powerdialer et panneaux statistiques annonçant des mesures futures.
- Pagination du carnet et recherche serveur dans la nouvelle conversation. Les recherches devenues obsolètes sont annulées et isolées par compte, organisation et requête. La recherche accepte les noms, emails contenant `@` et numéros complets normalisés.
- La modification du téléphone principal conserve les numéros secondaires et leurs libellés ; leur présence est indiquée dans le formulaire. La recherche par numéro renvoie tous les téléphones du contact.
- Le client API utilise le jeton actuel sans recréer l’appareil vocal lors d’un renouvellement de session. Ajout d’une action de reconnexion vocale explicite.
- Le SDK vocal ne déclare plus la sonnerie avant confirmation du fournisseur. Les événements de reconnexion sont relayés, une fin d’appel n’est émise qu’une fois et les événements tardifs d’un ancien appel ne modifient plus l’appel suivant. Une connexion qui arrive après une annulation est fermée.
- Les réponses HTTP réussies contenant du HTML ou un JSON invalide sont rejetées au lieu d’être présentées comme une écriture réussie.
- L’actualisation de l’espace recharge aussi les organisations et capacités ; celle du centre d’appels est raccordée au bouton global.
- Les messages sont rechargés au retour au premier plan et à la reconnexion Realtime. Un onglet masqué ne les marque plus comme lus. Une erreur d’enregistrement de lecture n’efface plus un chargement de messages réussi.
- Les erreurs de restauration de session et de déconnexion sont affichées. Le formulaire de récupération bloque les soumissions concurrentes. Le client Supabase est isolé du module React pour éviter sa recréation à chaque modification du composant en développement.
- La modification d’un agent déjà en pause conserve ce statut.

## Vérifications réalisées

- `pnpm test` : 144 tests réussis, dont 17 nouveaux tests sur les capacités serveur, la recherche de contacts, la conservation des numéros, les réponses API et le cycle vocal. Les doublures de fournisseurs restent exclusivement dans les tests.
- `pnpm typecheck` : tous les packages passent.
- Build de l’API, des packages partagés et de la webapp : réussi. Le build web signale encore un bundle principal supérieur à 500 Ko ; ce point concerne les performances de chargement.
- `pnpm test:admin:db` : 29 migrations appliquées à PostgreSQL isolé, assertions administration/IVR et centre d’appels réussies.
- Runtime des vérifications finales : Node 24.19.0, fourni par l’environnement.
- API locale : `/health/ready` confirme que Supabase Auth et PostgREST répondent.
- Supabase hébergé : les 29 migrations locales sont présentes. RLS est activée sur les contacts, téléphones, appels, messages et affectations. Les requêtes anonymes aux contacts et téléphones sont refusées (401 / 42501).
- Navigateur réel : écran de connexion local chargé, validation « adresse email requise » vérifiée sans envoi d’email, aucune erreur JavaScript après rechargement. La session de production existante a été inspectée en lecture ; elle affiche une version antérieure aux corrections locales.

## Conditions encore manquantes pour une recette complète

La base hébergée contient une organisation et un membre actif, mais aucune ligne active, aucun contact, appel ou SMS à la date du contrôle. Le fichier d’environnement local désactive voix et SMS et ne contient ni clé serveur Supabase ni identifiants Twilio. Ces constats portent sur la configuration locale ; les secrets Railway n’ont pas été inspectés.

La connexion au compte réel en local a été demandée pour poursuivre la recette navigateur. Sans cette session et sans ligne/service téléphonique configuré, les parcours authentifiés complets, appels entrants/sortants, réception/livraison SMS, commandes payantes et supervision Twilio ne sont pas validés de bout en bout. Les tests automatisés ne remplacent pas ces essais.

Références techniques consultées : [événements du SDK vocal Twilio](https://www.twilio.com/docs/voice/sdks/javascript/twiliocall) et [filtres Supabase](https://supabase.com/docs/reference/javascript/using-filters).

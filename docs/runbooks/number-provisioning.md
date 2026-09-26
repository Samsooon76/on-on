# Commander un numéro depuis le Web

Le bouton **Ajouter un numéro** est visible pour les administrateurs de l’organisation, y compris quand aucune ligne n’est encore attribuée. Le parcours sélectionne un pays, affiche jusqu’à huit numéros locaux compatibles voix et le tarif mensuel renvoyé par Twilio, puis demande une confirmation explicite. La commande est facturée au compte Twilio configuré côté API. La ligne est attribuée au compte connecté et le bouton **Passer un appel** sélectionne cette ligne dans le composeur.

La première version propose France, Belgique, Royaume-Uni et États-Unis. La disponibilité dépend du stock Twilio; aucun numéro ni prix n’est simulé en production. Les frais d’usage et les taxes sont distincts de l’abonnement mensuel affiché. La commande utilise `IncomingPhoneNumbers.create`, pas une simple insertion locale.

## Configuration initiale du serveur

- Appliquer `20260925211610_number_provisioning.sql` (déjà appliquée au projet hébergé `onoffv2`). Les nouvelles tables et fonctions sont réservées au rôle serveur; les rôles navigateur n’ont aucun accès direct.
- Fournir `SUPABASE_SECRET_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN` et `TWILIO_TWIML_APP_SID` uniquement au service API.
- Utiliser une clé Twilio qui autorise la recherche et l’achat de numéros, la lecture de la tarification, des réglementations, des bundles, des adresses et de la TwiML App. Le client désactive les retries automatiques des achats.
- Définir `API_PUBLIC_URL` en HTTPS et la requête vocale de la TwiML App sur `POST <API_PUBLIC_URL>/webhooks/twilio/voice/outbound`, puis activer `VOICE_ENABLED`. L’API bloque la commande si la voix n’est pas configurée. `OPERATIONS_PAUSED` bloque aussi les nouvelles commandes, sans empêcher la récupération d’un achat existant.
- Vérifier le solde du compte Twilio et les destinations autorisées pour les premiers appels selon [twilio-setup.md](twilio-setup.md). Le parcours d’achat ne lance aucun appel.

## Dossier d’identité, une fois par organisation et pays

L’API interroge les réglementations Twilio pour les numéros **locaux** du pays choisi. Quand un dossier est requis, enregistrer dans `number_provisioning_profiles` le `organization_id`, le `country` ISO, le `end_user_type` réel (`business` ou `individual`), le `bundle_sid` approuvé et, si nécessaire, le `address_sid`.

Ces références sont configurées par l’exploitant côté serveur, jamais demandées à l’utilisateur dans le formulaire d’achat. Le bundle doit décrire l’utilisateur final réel de cette organisation. Ne pas réutiliser le dossier d’une autre organisation. L’API vérifie l’état `twilio-approved`, la réglementation du bundle et le compte de l’adresse; Twilio vérifie également les contraintes locales au moment de la commande.

La collecte des justificatifs et la revue Twilio restent une configuration initiale dans la Console Twilio. Si le dossier ou l’adresse manque, le formulaire affiche le blocage avant tout achat. Aucune procédure de vérification d’identité n’est contournée ou simulée.

## API

- `GET /v1/organizations/:orgId/number-offers?country=FR` renvoie des offres nominatives valables dix minutes, avec prix, devise et capacités. Le serveur conserve le prix et les références fournisseur; le client ne peut pas les imposer.
- `POST /v1/organizations/:orgId/number-orders`, corps `{ "quoteId": "…" }`, en-tête `Idempotency-Key` UUID : vérifie à nouveau le prix, la disponibilité, les droits, le dossier et la TwiML App. Enregistre la commande avant le POST payant, configure les webhooks entrants voix/SMS et le callback vocal, puis crée la ligne et son attribution dans une transaction.
- `GET /v1/organizations/:orgId/number-orders` retourne les dix dernières commandes de cet administrateur dans cette organisation et vérifie les commandes encore incertaines auprès de Twilio. Aucun autre utilisateur ou espace n’est exposé.

## Reprise d’une commande incertaine

Une seule commande non résolue est autorisée par utilisateur et organisation. Une contrainte unique protège aussi le numéro sur le compte fournisseur. La fenêtre conserve la clé de requête dans le stockage du navigateur et vérifie les commandes serveur à chaque ouverture. Une réponse perdue, un rechargement ou deux onglets ne déclenchent pas un second achat.

Les numéros achetés portent `FriendlyName=onoff-order:<orderId>`. Une reprise ne peut rattacher qu’un numéro dont le numéro exact, le compte et cette référence correspondent. Elle ne réémet **jamais** le POST d’achat. Une réponse Twilio 4xx définitive marque l’échec; un timeout ou une réponse 5xx conserve `pending`. Si l’écriture locale échoue après l’achat, la vérification suivante termine l’attribution sans racheter de numéro.

Cas limite : si le processus s’arrête après l’enregistrement de la commande mais avant son envoi à Twilio, la commande reste en attente. L’exploitant doit vérifier l’absence du numéro et d’une requête fournisseur encore en cours avant de la clôturer en échec. Ne jamais libérer automatiquement un numéro payé ni relancer automatiquement l’achat pour résoudre un état incertain. Conserver les offres liées à des commandes; les offres expirées sans commande peuvent être purgées.

## Validation réalisée

Les tests API utilisent un fournisseur simulé : droits administrateur, prix, commande concurrente, réponse perdue, reprise après échec de base, refus Twilio, devis étranger/expiré/modifié et validation du corps. Les fonctions SQL de création/rejeu/finalisation et l’attribution ont été exercées sur le projet hébergé dans une transaction annulée. Le parcours Web est vérifié dans un navigateur avec toutes les API externes simulées. Aucun achat ni appel réel n’est exécuté pendant ces vérifications.

Références : [achat de numéros Twilio](https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource), [tarification](https://www.twilio.com/docs/phone-numbers/pricing), [dossiers réglementaires](https://www.twilio.com/docs/phone-numbers/regulatory/api/bundles).

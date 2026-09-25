# Plan de réalisation — Prototype de téléphonie multicanal

twilio sid  : [REDACTED — rotate this credential]
twilio key  : [REDACTED — rotate this credential]
twilio accout sid : [REDACTED — rotate this credential]
primary auth token twilio  : [REDACTED — rotate this credential]

Document de travail basé sur `project.md`, établi le 24 septembre 2026.

**Résultat visé :** une application permettant à des utilisateurs authentifiés d'appeler, de recevoir des appels, d'envoyer et de recevoir des SMS compatibles, et de retrouver leurs contacts et leur historique sur le web, iOS, Android, Windows et macOS. Une extension Chrome permet d'ouvrir le composeur depuis une page web.

**Ordre directeur :** un véritable appel web de bout en bout → faisabilité mobile → fiabilité des appels et des données → MVP web/mobile → distribution desktop et extension → fonctions avancées.

Au moment de l'analyse, le dossier ne contenait que `project.md` : aucune application ni configuration Git locale n'était présente. Les éventuels comptes et ressources distantes restent à inventorier. Les chemins, routes, scripts et paramètres ci-dessous sont des éléments **à créer**, pas des composants déjà disponibles. Les choix complémentaires sont des propositions d'implémentation ; les capacités dépendant de Twilio ou des systèmes mobiles doivent être vérifiées lors des essais indiqués.

**Accès rapide :** [préparation et installation](#preparation) · [premiers appels et essai mobile](#premiers-appels) · [fiabilité multi-appareils](#fiabilite) · [contacts, SMS et synchronisation](#produit) · [application mobile](#mobile) · [reprises et déploiement](#exploitation) · [desktop et extension](#distribution) · [recette](#recette) · [fonctions avancées](#avance) · [routes API](#api) · [premiers travaux](#demarrage) · [estimation](#estimation).

## 1. Comment utiliser ce plan

1. Réaliser les phases dans l'ordre indiqué, en tenant compte des dépendances.
2. Transformer chaque sous-phase en ticket ; conserver ses cases à cocher comme critères de réalisation.
3. Terminer chaque phase par sa preuve de fonctionnement, pas seulement par un build réussi.
4. Consigner les décisions techniques dans `docs/decisions/` avec leur raison et les résultats d'essais.
5. Ne pas développer une plateforme supplémentaire tant que le jalon précédent reste incertain.
6. Relire les documentations des versions réellement installées et enregistrer ces versions dans le dépôt.

Un **jalon** est un résultat démontrable. Un **spike** est un essai technique court destiné à lever un risque. Une **tranche fonctionnelle** traverse l'interface, l'API, les autorisations, Twilio et la persistance.

### Jalons et dépendances

| Jalon | Phases | Résultat à montrer | Condition pour poursuivre |
|---|---|---|---|
| J0 — Projet exécutable | 0 à 3 | Connexion utilisateur, organisation, ligne de test, API et migrations | Droits et configuration vérifiés |
| J1 — Téléphonie faisable | 4 et 5 | Appels web réels et essais iPhone/Android | Décision Expo ou projets natifs documentée |
| J2 — Cœur fiable | 6 | Plusieurs appareils sonnent ; un seul prend l'appel ; historique cohérent | Courses, doublons et événements désordonnés couverts |
| J3 — MVP utilisable | 7 à 10 | Contacts, SMS, historique, synchronisation et application mobile | Recette web/mobile réussie |
| J4 — Démonstration hébergée | 11 | Environnement de démonstration autonome et observable | Redéploiement et reprise vérifiés |
| J5 — Distribution complète | 12 à 14 | Applications desktop et extension installables | Recette des plateformes et documentation livrées |
| J6 — Démonstration avancée | 15, facultative | Enregistrement, transcription, résumé, export | J5 stable et règles d'accès/conservation définies |

Les démarches Apple, les certificats, l'accès aux numéros et les validations de comptes démarrent dès la phase 1. Elles peuvent avancer pendant le développement. Le spike mobile commence dès que la petite API vocale de la phase 4 est disponible : il ne doit pas attendre la finition du MVP web.

## 2. Hypothèses de départ et décisions proposées

| Sujet | Proposition pour démarrer | Ce qui reste à vérifier |
|---|---|---|
| Public | Démonstration privée avec utilisateurs et destinataires autorisés | Nombre de testeurs et conditions de diffusion |
| Organisations | Deux organisations de test dès le début pour prouver l'isolation | Pas de portail commercial de création d'entreprise |
| Rôles | `admin` et `member` | Un administrateur gère les affectations ; utiliser une ligne exige une affectation explicite |
| Contacts | Carnet partagé à l'échelle de l'organisation | Les appels et messages restent soumis aux droits de ligne |
| Lignes | Une ligne opérationnelle pour le premier essai ; une autre pour tester les refus d'accès | Pays, disponibilité, Voice, SMS entrant/sortant |
| Appareils | Identité vocale distincte par installation ou instance autorisée | Gestion des onglets, révocation et enregistrement push |
| Concurrence | Un appel actif par utilisateur au MVP ; pas de double appel | Réservation serveur et comportement si déjà occupé |
| Routage entrant | Sonnerie simultanée sur les appareils éligibles de la ligne | Petit groupe plafonné ; aucune file d'attente complexe |
| Refus d'appel | Refuser sur un appareil ne doit pas empêcher un autre de répondre | Vérifier le comportement réel du SDK et du routage |
| Absence de réponse | Fin de tentative, historique « manqué » | Message vocal d'indisponibilité facultatif ; pas de messagerie vocale MVP |
| Authentification | Comptes invités/précréés, email et mot de passe | Réinitialisation et liens de retour de chaque plateforme |
| Accès métier | Les interfaces appellent Fastify ; Supabase fournit Auth et Realtime | Aucune écriture métier directe autorisée aux clients |
| Base et transactions | Migrations SQL Supabase ; fonctions SQL restreintes pour les opérations atomiques | Éviter d'ajouter un ORM sans besoin identifié |
| Contrats API | TypeScript + schémas de validation compatibles Fastify ; Zod proposé | Fixer une seule méthode de génération JSON Schema/OpenAPI |
| Stockage local | Cache de lecture ; pas d'envoi d'appels ou de SMS différé hors ligne | Politique de purge à la déconnexion |
| Distribution initiale | Web privé, builds mobiles internes, installateurs desktop, extension non répertoriée/localement chargée | Publication publique traitée séparément |
| Enregistrements | Désactivés jusqu'à la phase 15 | Information, accès, conservation et suppression |

### Architecture à conserver

```text
Web / Electron / React Native / Extension
           │
           ├── Supabase Auth : connexion et renouvellement de session
           │
           └── Fastify : droits, contacts, lignes, intentions d'appel, SMS
                       ├── PostgreSQL : données et transactions
                       ├── Twilio : tokens, instructions vocales, envoi SMS
                       └── Queue / worker : traitements différés si utiles

Twilio ── webhooks HTTPS signés ──> Fastify ──> PostgreSQL
PostgreSQL ── notifications Realtime privées ──> clients autorisés
SDK Voice web/natif <──────── audio ────────> Twilio <──> téléphone
```

Fastify ne transporte pas l'audio. Le serveur reste l'autorité sur les droits et les données métier. Le SDK fournit l'état immédiat de la communication ; les callbacks Twilio et la réconciliation servent à établir l'historique persistant.

### Points documentaires qui influencent le plan

- Le dépôt officiel Twilio documente une intégration Expo par config plugin avec development build. Son tableau consulté décrit la branche 1.8.0 et précise une couverture incomplète de l'enregistrement et des appels entrants iOS dans ses propres essais. **Expo est donc un candidat à tester**, pas une garantie à supposer. [SDK React Native officiel](https://github.com/twilio/twilio-voice-react-native).
- Un `<Dial>` peut appeler simultanément plusieurs clients ; Twilio connecte le premier qui répond et annule les autres tentatives. La limite documentée est de dix destinations `<Client>`/`<Number>` au total. Le prototype proposera un plafond inférieur et vérifiera le comportement sur les vrais appareils. [Routage TwiML Client](https://www.twilio.com/docs/voice/twiml/client).
- Un canal Realtime privé demande une autorisation propre au canal. La RLS des tables métier ne suffit pas à elle seule pour sécuriser Broadcast. [Autorisation Realtime](https://supabase.com/docs/guides/realtime/authorization).

<a id="preparation"></a>

## 3. Phase 0 — Verrouiller le scénario de démonstration

**But :** savoir exactement ce que le prototype doit permettre avant de créer des composants.

### 0.1. Écrire les parcours à démontrer

- [x] Décrire le parcours : se connecter → sélectionner une ligne → appeler un numéro autorisé → échanger de l'audio → raccrocher → retrouver l'appel.
- [x] Décrire le parcours entrant : un téléphone appelle la ligne → web et mobile sonnent → le mobile répond → le web cesse de sonner.
- [x] Décrire le parcours SMS : envoyer → afficher le statut fournisseur → recevoir une réponse → retrouver la conversation sur un autre appareil.
- [x] Décrire le parcours contact : créer un contact sur le web → le retrouver sur le mobile → appeler son numéro.
- [x] Décrire le parcours de reconnexion : fermer une interface → créer une activité ailleurs → rouvrir → retrouver les données serveur.
- [x] Décrire le parcours de refus : un utilisateur tente de consulter une autre organisation ou d'utiliser une ligne non affectée → la requête est refusée.

### 0.2. Définir les limites du MVP

- [x] Fixer un petit nombre de testeurs, de lignes et d'appareils.
- [x] Choisir la France et un mobile de test communiqué et autorisé par le propriétaire; ne pas copier son numéro dans le dépôt.
- [x] Fixer les plafonds proposés : appareils qui sonnent, appels simultanés, durée maximale, SMS par jour.
- [x] Fixer un plafond de dépense de 10 € pour les essais; le propriétaire du compte Twilio surveille le budget et les alertes avant l'activation.
- [x] Confirmer les exclusions de `project.md` : portabilité, appels d'urgence, transfert entre appareils, moteur audio d'extension, CRM avancé.
- [x] Écrire ce que signifie « disponible » : autorisé et enregistré ; une présence Realtime seule ne prouve pas la joignabilité vocale.
- [x] Préciser le comportement hors ligne et lorsque l'application a été arrêtée par l'utilisateur.

**Livrables :** `docs/mvp-scope.md`, `docs/demo-scenarios.md`, première liste des risques et paramètres de démonstration.

**Validation :** les parcours peuvent être expliqués sans ambiguïté ; aucun scénario ne suppose une fonctionnalité hors périmètre.

## 4. Phase 1 — Préparer les comptes, les appareils et les environnements

**Dépendance :** phase 0. **But :** lever tôt les blocages externes.

### 1.1. Préparer les outils locaux

- [x] Installer Git et créer le dépôt local avec branche principale `main`.
- [x] Créer le dépôt distant `Samsooon76/on-on`, ajouter l'URL `origin` et pousser le commit initial sur `main`; `.env` reste ignoré et hors de l'historique.
- [ ] Confirmer si le dépôt doit être privé : il est actuellement public; choix demandé au propriétaire avant tout changement de visibilité.
- [ ] Installer Node.js 24.21.0 LTS sur l'hôte et valider le dépôt avec ce runtime; le patch est épinglé dans `.nvmrc` et la CI.
- [x] Partir de Node.js 24 LTS comme candidat à la date du plan, sous réserve de compatibilité avec la chaîne mobile retenue. [Versions Node.js](https://nodejs.org/en/about/previous-releases).
- [x] Installer et fixer pnpm ; enregistrer sa version dans `packageManager`.
- [x] Installer la CLI Supabase comme dépendance de développement versionnée et l'utiliser uniquement avec le projet hébergé autorisé.
- [ ] Préparer Xcode, les outils iOS, Android Studio, les SDK Android et le JDK exigé par la version React Native.
- [ ] Disposer d'un iPhone réel, d'un Android réel et d'un téléphone externe pouvant appeler les numéros de test.
- [ ] Prévoir plus tard une machine Windows réelle pour la validation du desktop.

Le propriétaire a demandé d'utiliser Supabase en ligne sans démarrer d'instance Supabase locale. Le développement des applications reste local, mais les migrations, l'introspection et les types ciblent explicitement le projet hébergé `onoffv2`. Les tests SQL multi-organisation devront utiliser un projet ou une branche distante isolée, jamais des fixtures dans le projet partagé.

### 1.2. Créer les environnements

| Environnement | Usage | Supabase | Twilio | Exposition |
|---|---|---|---|---|
| `dev` | Développement local des applications et intégration hébergée | Projet Supabase en ligne `onoffv2` (eu-west-1), demandé par le propriétaire | Doubles en CI ; ressources dédiées après rotation/configuration | API HTTPS stable pour les webhooks |
| `demo` | Démonstration et recette finale | Projet distant séparé | Ressources/numéros séparés, idéalement sous-compte dédié | Web et API HTTPS stables |

- [ ] Définir les noms, régions, URLs et propriétaires des environnements.
- [ ] Créer le projet Supabase de développement ; préparer la création du projet de démonstration avant la phase 11.
- [ ] Documenter si Twilio est séparé par sous-comptes ou par comptes distincts ; ne pas réutiliser les identifiants entre environnements.
- [ ] Prévoir une URL d'API stable dès les premiers appels. Un tunnel peut dépanner, mais son changement exige de mettre à jour les webhooks.
- [x] Définir une convention explicite pour éviter de lancer une migration sur le mauvais environnement; aucune commande Supabase locale ou de réinitialisation n'est fournie.

### 1.3. Préparer Twilio

- [ ] Créer/configurer le compte et vérifier ses possibilités réelles selon son statut.
- [ ] Vérifier dans la Console les capacités exactes du numéro envisagé : appels entrants, appels sortants, SMS entrants, SMS sortants.
- [ ] Vérifier les destinations, les éventuelles restrictions de compte d'essai et les formalités demandées pour le pays.
- [ ] Faire les démarches nécessaires avant de promettre un numéro local précis. [Numéros Twilio](https://www.twilio.com/docs/phone-numbers) et [exigences par pays](https://www.twilio.com/en-us/guidelines).
- [ ] Provisionner une ligne de test adaptée ; si voix et SMS ne sont pas disponibles sur la même ligne, consigner la différence produit et adapter la démonstration explicitement.
- [ ] Créer une TwiML App destinée aux SDK Voice.
- [ ] Créer une clé API serveur compatible avec l'émission des Access Tokens et les opérations retenues.
- [ ] Conserver séparément l'Account SID, l'API Key SID/secret, l'Auth Token de validation des webhooks et le TwiML App SID.
- [ ] Configurer des restrictions de destinations, des alertes de consommation et les paramètres d'appels nécessaires.
- [ ] Garder les enregistrements désactivés.
- [x] Consigner dans `docs/runbooks/twilio-setup.md` les paramètres convenus, le statut des ressources et la procédure de configuration, sans recopier les valeurs secrètes.

### 1.4. Préparer le mobile en avance

- [ ] Préparer le compte Apple Developer, les identifiants d'application et les possibilités de signature sur iPhone.
- [ ] Préparer APNs/PushKit et les credentials attendus par Twilio, avec distinction des environnements de push.
- [ ] Créer le projet Firebase destiné à Android et préparer FCM conformément au guide du SDK retenu.
- [ ] Choisir les identifiants de bundle/package de développement et de démonstration.
- [ ] Planifier une première installation sur appareils réels pendant le spike, sans attendre les écrans définitifs.

### 1.5. Organiser les variables et secrets

| Variable proposée | Destination | Sensibilité / usage |
|---|---|---|
| `APP_ENV` | API et builds | Sélection explicite de l'environnement |
| `API_PUBLIC_URL` | API | URL HTTPS exacte employée pour les webhooks |
| `WEB_PUBLIC_URL` | API | Domaine web autorisé et liens de retour |
| `SUPABASE_URL` | API et clients | URL publique du projet |
| `SUPABASE_PUBLISHABLE_KEY` | Clients et API de lecture | Clé publique ; ne remplace pas le JWT utilisateur |
| `SUPABASE_SECRET_KEY` | API et worker seulement | Clé privilégiée, à isoler strictement |
| `DATABASE_URL` | Migration / accès SQL serveur si utilisé | Secret ; jamais dans un build client |
| `TWILIO_ACCOUNT_SID` | API | Identifiant du compte de l'environnement |
| `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` | API | Identifiants serveur Twilio |
| `TWILIO_AUTH_TOKEN` | API | Secret de validation selon la configuration Twilio retenue |
| `TWILIO_TWIML_APP_SID` | API | Application vocale liée aux tokens |
| `TWILIO_PUSH_CREDENTIAL_SID_IOS` / `_ANDROID` | API | Credentials de push selon plateforme/environnement |
| `TWILIO_ALLOWED_DESTINATIONS` | API | Préfixes de pays autorisés pour les appels et SMS sortants |
| `SMS_ALLOWED_RECIPIENTS` | API seulement | Destinataires exacts E.164 autorisés pour les SMS de démonstration; configurer dans le gestionnaire de secrets, pas dans le dépôt |
| `ALLOWED_ORIGINS` | API | Liste fermée des origines autorisées |
| `VOICE_ENABLED` / `SMS_ENABLED` | API | Coupe-circuits des nouvelles opérations |

- [x] Créer des `.env.example` par application lorsque celle-ci apparaît.
- [x] Valider les variables au démarrage et échouer clairement si un secret obligatoire manque.
- [ ] Utiliser un stockage de secrets de l'hébergeur et de la CI pour les environnements distants.
- [x] Vérifier les exports de variables des outils de build : toute variable injectée dans Vite, mobile ou extension est récupérable par l'utilisateur.
- [x] Prévoir la rotation des secrets et un journal de configuration sans leurs valeurs.

Pour un nouveau projet, utiliser les catégories actuelles de clés publiques/privilégiées Supabase et vérifier les noms réellement fournis par le projet. [Clés API Supabase](https://supabase.com/docs/guides/getting-started/api-keys).

**Validation :** accès aux comptes disponibles, ligne identifiée avec ses capacités, environnement de développement défini et appareils prêts à recevoir un build.

## 5. Phase 2 — Initialiser le monorepo et le squelette exécutable

**Dépendance :** outils de la phase 1. **But :** démarrer web et API avec une seule procédure reproductible.

### 2.1. Créer seulement les premiers dossiers utiles

```text
apps/
  api/src/
    config/
    plugins/
    modules/
    integrations/
  web/src/
packages/
  contracts/src/
supabase/
  migrations/
  tests/
docs/
  decisions/
  runbooks/
  test-reports/
scripts/
```

- [x] Créer `package.json` racine avec `private: true`, `packageManager` et `engines`.
- [x] Créer `pnpm-workspace.yaml` couvrant `apps/*` et `packages/*`.
- [x] Choisir une convention de noms, par exemple `@onoff/api`, `@onoff/web`, `@onoff/contracts`.
- [x] Utiliser `workspace:*` pour les dépendances internes. [Workspaces pnpm](https://pnpm.io/workspaces).
- [x] Créer `.gitignore`, `.editorconfig`, la configuration TypeScript commune, le formatage et le lint.
- [x] Activer TypeScript strict et fixer un format de modules cohérent pour chaque runtime.
- [x] Créer React + Vite dans `apps/web` et Fastify dans `apps/api` avec versions exactes enregistrées.
- [x] Ne créer `desktop`, `extension`, `worker` et les packages UI partagés qu'au moment où ils ont un consommateur.

### 2.2. Faire démarrer l'API

- [x] Séparer la construction de l'application Fastify de son écoute réseau, afin de tester les routes en mémoire.
- [x] Ajouter la validation de configuration.
- [x] Ajouter `GET /health/live` pour vérifier que le processus répond.
- [x] Ajouter `GET /health/ready` pour vérifier les dépendances indispensables, sans révéler de secrets.
- [x] Ajouter un identifiant de requête et des logs JSON avec masquage des tokens et des données sensibles.
- [x] Configurer CORS avec une liste fermée et une politique proxy cohérente avec l'hébergement.
- [x] Définir les limites de taille des corps, les délais et l'arrêt propre du serveur.
- [x] Séparer routes utilisateur sous `/v1` et webhooks sous `/webhooks/twilio`.
- [x] Ajouter une gestion uniforme des erreurs : code stable, message public, identifiant de requête.

### 2.3. Poser les contrats et la CI

- [x] Créer les premiers schémas : identifiants, pagination, erreurs et réponse de santé.
- [x] Choisir un pont maintenu entre les schémas partagés et la validation Fastify ; vérifier sa compatibilité avant installation (`@fastify/type-provider-zod@1.0.0`, Fastify 5.12.5 et Zod 4.5.4).
- [x] Définir aussi les schémas de réponse pour éviter d'exposer accidentellement des colonnes internes (`apps/api/src/response-schemas.ts`; les réponses JSON `/v1` sont sérialisées selon leur contrat). [Validation Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/).
- [x] Ajouter les scripts racine `dev`, `lint`, `typecheck`, `test`, `build`.
- [x] Ajouter les scripts de liste, application et génération de types explicitement ciblés vers Supabase hébergé; aucune commande Supabase locale n'est fournie.
- [x] Créer une CI : installation avec lockfile figé → lint → types → tests pertinents → build.
- [x] Vérifier que la CI n'envoie aucun SMS et ne lance aucun appel réel.
- [x] Écrire un premier README : outils requis, installation, variables et lancement.

### 2.4. Définir les frontières du code

| Zone | Peut dépendre de | Ne doit pas importer |
|---|---|---|
| `contracts`, `core` | TypeScript et bibliothèques portables | Secrets, Node spécifique, DOM, React Native |
| `api-client` | Contrats, transport HTTP, session injectée | SDK Twilio serveur, clé Supabase privilégiée |
| `voice-web` | Contrat vocal, SDK Voice JS | Modules natifs mobiles |
| `voice-native` | Contrat vocal, SDK React Native | Electron, DOM |
| API / worker | Contrats, métier, intégrations serveur | Écrans et navigation client |
| UI | Contrats et adaptateurs autorisés | Base de données privilégiée et logique de facturation fournisseur |

**Validation :** un nouveau checkout peut être installé, démarré et compilé ; la page web obtient la santé de l'API ; la CI est verte.

## 6. Phase 3 — Construire le socle de données et les autorisations

**Dépendance :** phase 2. **But :** interdire dès le départ l'accès à la mauvaise organisation ou à la mauvaise ligne.

### 3.1. Créer les premières tables

Créer d'abord `organizations`, `memberships`, `lines`, `line_assignments` et `devices`. Les autres tables sont ajoutées avec leur fonctionnalité ; le tableau suivant donne le modèle cible pour anticiper les relations.

| Table | Données essentielles | Contraintes et responsabilité |
|---|---|---|
| `organizations` | `id`, nom, paramètres de démonstration | Unité d'isolation |
| `memberships` | organisation, utilisateur Auth, rôle, état | Unicité organisation/utilisateur ; membre actif requis |
| `lines` | organisation, numéro E.164, compte/SID Twilio, capacités, état | Numéro/SID uniques dans leur contexte fournisseur |
| `line_assignments` | organisation, ligne, membre, droits voix/SMS | Affectation à une ligne de la même organisation |
| `devices` | organisation, utilisateur, plateforme, identité vocale, état, dernière activité | Identité générée côté serveur ; révocation explicite |
| `contacts` | organisation, nom, email facultatif, version | Carnet partagé selon la politique du MVP |
| `contact_phones` | contact, organisation, numéro normalisé, libellé | Plusieurs numéros possibles ; index de recherche |
| `call_intents` | utilisateur, appareil, ligne, destination, expiration, état | Une intention autorisée avant tout appel sortant |
| `calls` | organisation, ligne, sens, correspondant, état, dates, résultat | Un appel métier affiché dans l'historique |
| `call_reservations` | utilisateur, appel, état de réservation, échéance de préparation | Une réservation active par utilisateur ; commune à ses appareils |
| `call_legs` | appel, SID Twilio, SID parent, appareil éventuel, état fournisseur | Plusieurs connexions pour un même appel métier |
| `provider_events` | fournisseur, compte, ressource, type, clé de déduplication, dates | Journal technique borné, utile au diagnostic et au rejeu |
| `conversations` | organisation, ligne, numéro distant, dernière activité | Unicité ligne/numéro distant pour les SMS du MVP |
| `messages` | conversation, sens, texte, statut, SID Twilio, dates | Un message métier ; idempotence des envois |
| `conversation_reads` | conversation, utilisateur, dernier message lu | État de lecture de l'application, distinct du transport SMS |
| `idempotency_requests` | acteur, opération, clé, empreinte du contenu, résultat | Même clé + même contenu → même résultat |
| `audit_events` | acteur, action sensible, cible, résultat, date | Affectations, révocations et opérations d'administration |
| `recordings` | appel, stockage privé, état, expiration | Phase 15 uniquement |

### 3.2. Écrire des migrations reproductibles

- [x] Utiliser UUID internes, dates `timestamptz` et heures UTC.
- [x] Ajouter `organization_id` aux ressources métier concernées.
- [x] Utiliser des clés étrangères composites ou des contrôles équivalents pour empêcher les liens entre organisations.
- [x] Ajouter les index des requêtes fréquentes : organisation/date, ligne/date, conversations et SID fournisseur.
- [x] Prévoir pagination par curseur et ordre stable `(created_at, id)` pour les historiques.
- [x] Ajouter `updated_at` et une version aux ressources éditables pour détecter les modifications concurrentes.
- [x] Préférer une désactivation de ligne/appareil à une suppression cassant les références historiques.
- [x] Conserver dans l'historique le numéro correspondant même si le contact est modifié ou supprimé.
- [x] Préparer des comptes A/B et affectations sur une branche Supabase distante isolée avant les tests multi-organisation; les fixtures de test sont annulées dans une transaction et ne sont pas injectées dans le projet partagé `onoffv2`.
- [x] Vérifier que l'historique des migrations du dépôt correspond aux migrations appliquées au projet Supabase en ligne.

### 3.3. Choisir une stratégie d'accès simple et explicite

Proposition : les lectures métier passent par l'API avec un client Supabase portant le JWT utilisateur, afin de bénéficier de la RLS. Les écritures métier passent par des services serveur privilégiés après contrôle explicite des droits. Les rôles clients n'obtiennent pas de droits d'écriture directe ni d'exécution des fonctions sensibles.

- [x] Activer la RLS sur les tables exposées et partir d'un refus par défaut.
- [x] Écrire les politiques de lecture selon l'appartenance active et, pour appels/messages, les affectations de ligne.
- [x] Éviter les politiques d'appartenance récursives sur `memberships` ; si un helper privilégié est nécessaire, le limiter au contrôle de l'utilisateur authentifié et tester son accès.
- [x] Restreindre les grants SQL de mutation et l'exécution des fonctions privilégiées pour `anon` et `authenticated`.
- [x] Conserver `provider_events`, intentions sensibles et clés d'idempotence hors lecture client.
- [ ] Regrouper toutes les écritures privilégiées dans des repositories/services explicitement nommés et testés.
- [x] Inclure l'organisation et la ligne dans les filtres serveur ; les accès par identifiant vérifient l'appartenance active, et l'historique exige une affectation active à la ligne. Tests API de scoping ajoutés.
- [x] Utiliser des fonctions SQL transactionnelles restreintes au serveur pour réserver un appel ou traiter plusieurs écritures atomiques.
- [x] Pour toute fonction `SECURITY DEFINER`, fixer le `search_path`, qualifier les tables et limiter les droits d'exécution.
- [x] Tester l'accès direct avec le rôle `authenticated` sur une branche distante isolée: un membre A ne voit pas les données de B; contrôler aussi les refus de lecture anonyme et des événements fournisseur. Les requêtes HTTP avec vrais JWT restent dans la recette d'intégration.

**Point important :** une clé Supabase privilégiée peut contourner la RLS. La sécurité des écritures serveur repose donc aussi sur les vérifications de l'API et leurs tests ; on ne présentera pas la RLS comme une protection automatique de ces opérations. [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security).

### 3.4. Ajouter l'authentification

- [ ] Configurer Supabase Auth et les URLs de retour autorisées.
- [ ] Précréer/inviter les utilisateurs de démonstration par une procédure serveur, sans inscription publique automatique au MVP.
- [x] Implémenter connexion, déconnexion, restauration de session et réinitialisation du mot de passe.
- [x] Vérifier les JWT côté API avec la méthode officielle adaptée aux clés du projet : signature, expiration, émetteur et audience attendue. Ne pas simplement décoder le token. [JWT Supabase](https://supabase.com/docs/guides/auth/jwts).
- [x] À chaque opération sensible, relire l'appartenance active et l'affectation de ligne.
- [x] Exposer `GET /v1/me` et `GET /v1/organizations` avec les droits utiles au client.
- [x] Lors d'un changement d'organisation, vider le cache métier, fermer les abonnements précédents et recréer le contexte vocal.
- [x] À la déconnexion, nettoyer les tokens vocaux en mémoire, le cache et l'enregistrement SDK lorsque possible.

### 3.5. Ajouter les appareils et lignes

- [x] Exposer les lignes autorisées à l'utilisateur.
- [x] Créer un endpoint d'enregistrement d'appareil, sans faire confiance à un `userId` transmis par le client.
- [x] Générer une identité Twilio opaque compatible avec les SDK, par exemple un préfixe suivi d'un UUID sans tirets.
- [x] Séparer identité utilisateur, identité appareil et numéro de ligne.
- [x] Conserver un état révoqué et un état d'enregistrement vocal distinct de la simple dernière activité.
- [x] Prévoir une page minimale d'appareils avec révocation de ses propres installations.
- [ ] Réserver l'affectation des lignes aux administrateurs, via procédure serveur puis interface minimale si nécessaire.

**Validation :** A ne peut pas lire B ; un membre non affecté ne peut pas utiliser la ligne ; un appareil révoqué ne peut pas obtenir un nouveau token vocal ; ces cas sont automatisés.

<a id="premiers-appels"></a>

## 7. Phase 4 — Réaliser les premiers appels web réels

**Dépendance :** phase 3 et ligne Twilio opérationnelle. **But :** prouver toute la chaîne avec une interface minimale.

### 4.1. Créer le contrat vocal et l'adaptateur web

- [x] Créer `packages/voice-contract` avec `VoiceClient` et les opérations de `project.md`.
- [x] Définir les événements communs : prêt, indisponible, invitation entrante, connexion, appel actif, fin et erreur.
- [x] Ajouter la libération des ressources et le désabonnement, même si ce sont des méthodes internes au cycle de vie de l'adaptateur.
- [x] Définir les capacités : sélection audio, DTMF, intégration système, enregistrement push.
- [x] Définir l'association entre identifiant métier, identifiant de tentative locale et SID fournisseur lorsqu'il devient disponible.
- [x] Créer `packages/voice-web` avec `@twilio/voice-sdk` versionné.
- [x] Mapper chaque méthode du contrat sur l'API documentée de cette version ; ne pas exporter directement les objets SDK dans les écrans.
- [x] Gérer demande de microphone, refus de permission et absence de périphérique.
- [x] Gérer enregistrement, renouvellement du token et destruction du SDK sans multiplier les listeners.

Références à utiliser lors du mapping : [Twilio.Device](https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice) et [Twilio.Call](https://www.twilio.com/docs/voice/sdks/javascript/twiliocall).

### 4.2. Émettre les tokens vocaux côté serveur

- [x] Créer `POST /v1/voice/token` protégé par authentification.
- [x] Vérifier appartenance, appareil actif, lignes disponibles et activation du service.
- [x] Déterminer l'identité vocale côté serveur ; refuser une identité arbitraire fournie par le client.
- [x] Générer un Access Token de courte durée, avec les grants nécessaires et la TwiML App de l'environnement.
- [x] Fournir `expiresAt` pour permettre le renouvellement avant expiration.
- [x] Ajouter les credentials de push appropriés lorsque le client est mobile.
- [x] Limiter la fréquence d'émission et ne jamais journaliser le token.

Les Access Tokens SDK sont émis par le backend et restent distincts des clés API de compte. [Tokens Twilio](https://www.twilio.com/docs/iam/access-tokens).

### 4.3. Construire l'intention d'appel sortant

- [x] Créer les migrations minimales `call_intents`, `calls`, `call_reservations`, `call_legs` et idempotence.
- [x] Créer `POST /v1/call-intents` avec ligne, appareil, destination et clé d'idempotence.
- [x] Normaliser la destination au format E.164 avec pays explicite si le numéro est saisi au format local.
- [x] Vérifier droits voix, numéro autorisé, pays permis, coupe-circuit et plafonds.
- [x] Refuser les destinations hors périmètre et les numéros courts/services non pris en charge.
- [x] Réserver atomiquement une tentative pour éviter deux créations concurrentes par le même utilisateur.
- [x] Stocker destination et numéro appelant côté serveur ; retourner un identifiant opaque d'intention à durée limitée.
- [x] Faire démarrer le SDK avec cet identifiant ; le client ne choisit pas librement le `callerId` effectif.
- [x] Expirer la réservation si le client ne démarre jamais l'appel.

### 4.4. Construire le webhook vocal sortant

- [x] Exposer `POST /webhooks/twilio/voice/outbound`.
- [x] Accepter le format de corps envoyé par Twilio et vérifier sa signature avant tout effet métier.
- [x] Vérifier le compte fournisseur attendu et l'identité d'origine attestée par Twilio ; les paramètres personnalisés restent des entrées non fiables.
- [x] Rattacher l'appel à l'intention, à son utilisateur et à son appareil ; vérifier l'expiration et les droits actuels.
- [x] Lier atomiquement l'intention au `CallSid` : un rejeu du même appel retrouve sa réponse ; un nouveau `CallSid` ne peut pas réutiliser l'intention consommée.
- [x] Générer le TwiML avec le SDK serveur, le `callerId` de la ligne autorisée et la destination enregistrée.
- [x] Configurer les callbacks de statut et l'action de fin de `<Dial>` nécessaires.
- [x] Implémenter un premier endpoint de statut signé qui rattache les connexions et enregistre le résultat ; la phase 6 complète sa gestion des courses et du désordre.
- [x] Répondre rapidement avec du XML ; aucun appel de transcription, export ou traitement lourd dans ce chemin.

Les signatures dépendent notamment de l'URL publique exacte et des paramètres reçus. Utiliser le validateur Twilio, préserver les paramètres requis et vérifier la configuration derrière proxy/tunnel. [Sécurité des webhooks](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

### 4.5. Ajouter un appel entrant vers un seul appareil

- [x] Exposer `POST /webhooks/twilio/voice/inbound`.
- [ ] Associer ce webhook à un numéro Twilio de développement et en valider la capacité voix réelle.
- [x] Résoudre la ligne à partir du compte attendu et du numéro appelé.
- [x] Créer/retrouver l'appel métier par la connexion racine Twilio.
- [x] Sélectionner un appareil autorisé, puis produire un `<Dial><Client>`.
- [x] Afficher une invitation dans l'interface et permettre accepter/refuser.
- [x] Gérer un utilisateur indisponible et l'absence de réponse sans attente indéfinie.
- [x] Stocker un historique minimal et le relire via l'API.

### 4.6. Livrer une interface de preuve

- [x] Afficher compte, ligne active et disponibilité vocale.
- [x] Ajouter champ de numéro, bouton Appeler, réponse, refus, raccrochage, mute et clavier DTMF.
- [x] Afficher les états de préparation, sonnerie, conversation et fin avec erreurs compréhensibles.
- [x] Empêcher les doubles clics tout en conservant la protection serveur.
- [x] Garder le contrôle d'appel monté lors d'un changement de page.

**Validation J1, partie web :** un appel sortant et un appel entrant réels avec audio bidirectionnel, raccrochage correct et historique persistant. Consigner appareils, réseau, versions, heure et identifiants techniques dans `docs/test-reports/web-voice-spike.md` sans secret.

## 8. Phase 5 — Valider la faisabilité mobile avant la construction des écrans

**Dépendance :** endpoints vocaux de la phase 4. **But :** décider Expo/projets natifs sur des résultats concrets.

### 5.1. Fixer une matrice de compatibilité

- [ ] Relever la version publiée du SDK Twilio, React Native, Expo candidat, iOS cible, Android cible et outillage natif.
- [ ] Vérifier les guides et problèmes connus de ces versions ; ne pas extrapoler la compatibilité d'une branche Git à un paquet publié.
- [x] Enregistrer les versions exactes dans `docs/mobile-compatibility.md`.
- [ ] Tester Expo avec son config plugin officiel et un development build si la combinaison est supportée.
- [ ] Fixer une durée maximale à cet essai, par exemple deux jours d'investigation avant décision technique.
- [ ] Préparer le repli React Native avec projets `ios/` et `android/` gérés directement si l'intégration native ne passe pas.

Le plugin configure des éléments natifs ; Expo Go ne suffit pas pour ce SDK. [Configuration Expo officielle Twilio](https://github.com/twilio/twilio-voice-react-native/blob/main/docs/expo/app-config.md).

### 5.2. Construire une application technique minimale

- [x] Créer `apps/mobile` avec seulement connexion, statut vocal et commandes d'appel.
- [x] Réutiliser `contracts` et `voice-contract`, puis créer `voice-native`.
- [x] Injecter le token utilisateur dans les appels API et demander le token Twilio à l'API commune.
- [x] Stocker la session avec un mécanisme sécurisé approprié au système.
- [ ] Implémenter les permissions et le cycle de vie natif avant tout design élaboré.

### 5.3. Valider iOS sur iPhone

- [ ] Configurer signature, bundle ID, capacités et environnement APNs correspondant.
- [ ] Brancher PushKit et CallKit selon le guide de la version retenue.
- [ ] Vérifier l'enregistrement vocal et le lien entre identité Twilio et push.
- [ ] Tester appel entrant application ouverte, en arrière-plan et écran verrouillé.
- [ ] Tester acceptation depuis l'interface native, refus et annulation par l'appelant.
- [ ] Tester un démarrage à froid autorisé par iOS et distinguer ce cas d'une fermeture forcée par l'utilisateur.
- [ ] Tester sortie audio, écouteur, haut-parleur et interruption par un appel système.
- [ ] Refaire les tests avec le mode de signature utilisé pour la distribution interne.

Référence : [initialisation iOS du SDK](https://github.com/twilio/twilio-voice-react-native/blob/main/docs/getting-started-ios.md).

### 5.4. Valider Android sur appareil réel

- [ ] Configurer Firebase/FCM et les credentials attendus par Twilio.
- [ ] Configurer microphone, notifications et les composants natifs requis par le SDK et la version Android ciblée.
- [ ] Tester appel entrant application ouverte, arrière-plan et écran verrouillé.
- [ ] Tester notification/action native d'appel et annulation de la notification après réponse ailleurs.
- [ ] Tester économie d'énergie, changement de réseau et interruptions audio.
- [ ] Consigner le comportement après retrait des applications récentes et après arrêt forcé dans les paramètres : ce ne sont pas les mêmes cas.
- [ ] Vérifier le comportement avec permissions refusées puis réaccordées.

Référence : [initialisation Android du SDK](https://github.com/twilio/twilio-voice-react-native/blob/main/docs/getting-started-android-kotlin.md).

### 5.5. Prendre une décision écrite

- [ ] Produire un tableau scénario/appareil/version/résultat/anomalie.
- [x] Choisir Expo ou projets natifs gérés directement et expliquer pourquoi.
- [x] Documenter les limites du système au lieu de promettre un réveil dans tous les états.
- [ ] Si les appels entrants mobiles restent bloqués, poursuivre les travaux web indépendants, mais conserver J1 mobile comme non validé.

**Validation J1 complète :** appels entrants et sortants réels sur iPhone et Android ; arrière-plan, écran verrouillé et annulation testés ; architecture mobile retenue et reproductible. Realtime n'est jamais utilisé comme mécanisme de réveil des appels.

<a id="fiabilite"></a>

## 9. Phase 6 — Fiabiliser les appels et la sonnerie multi-appareils

**Dépendances :** phases 4 et 5 pour la validation complète. **But :** avoir une seule réalité métier même si Twilio et les appareils produisent plusieurs événements.

### 6.1. Séparer les états locaux, les connexions et l'appel métier

- [x] Conserver l'état SDK local pour les commandes immédiates : sonnerie, mute, périphérique, raccrochage.
- [x] Conserver l'état de chaque connexion Twilio dans `call_legs`, sans le confondre avec l'appel affiché.
- [x] Définir les états métier de l'appel (`initiated`, `ringing`, `answered` puis état terminal) séparément des états de connexion.
- [x] Garder le résultat du fournisseur dans `result_code`, distinct du statut métier.
- [x] Définir explicitement les transitions dans le mapping des callbacks plutôt que comparer les statuts comme des nombres.
- [x] Interdire le retour d'un appel terminé vers sonnerie ou actif.
- [x] Permettre d'enrichir un état terminé avec une durée ou un code d'erreur reçu plus tard sans rouvrir l'appel.
- [x] Déterminer la durée de conversation à partir de la connexion enfant terminée, pas de la seule connexion initiale au SDK.
- [x] Considérer un appel « manqué » seulement quand aucune connexion enfant n'a répondu et que l'action agrégée du routage annonce une absence de réponse.
- [x] Ne pas transformer l'annulation d'une connexion perdante en appel manqué global.

### 6.2. Construire le traitement durable des événements

- [x] Créer un format normalisé d'événement fournisseur conservant compte, ressource, type, heure de réception et résultat d'application.
- [x] Définir une clé de déduplication par famille de callback à partir des identifiants réellement disponibles.
- [x] Utiliser une combinaison compte/ressource/type d'événement lorsque le webhook ne fournit pas d'identifiant d'événement propre.
- [x] Ne pas supposer que tous les webhooks possèdent un identifiant universel ni que deux livraisons HTTP sont deux événements métier.
- [x] Appliquer contraintes uniques et transaction pour enregistrer l'événement et actualiser les projections.
- [x] Persister l'intention, la connexion racine et le contexte de routage avant que les callbacks des connexions enfants soient appliqués.
- [x] Rattacher les connexions enfants via leur parent et le contexte créé au routage.
- [x] Stocker séparément heure de l'événement fournisseur et heure de réception serveur.
- [x] Exploiter les séquences d'un même `CallSid` quand elles sont présentes, sans supposer un ordre global entre connexions.
- [x] Sur doublon, répondre correctement sans créer de nouvel historique ni répéter un effet externe.
- [x] Si la persistance échoue, ne pas accuser réception comme si le traitement était durable ; répondre en erreur pour que la stratégie de reprise documentée s'applique.
- [ ] Définir la rétention et le masquage des corps de webhooks : pas de conservation illimitée de numéros ou contenus.

La ressource Call et ses callbacks fournissent les éléments de corrélation à mapper pour la version utilisée. [API Call Twilio](https://www.twilio.com/docs/voice/api/call-resource).

### 6.3. Configurer un vrai groupe de sonnerie

- [x] Construire la liste des appareils à partir des membres actifs, affectations de ligne, révocations et états d'enregistrement.
- [x] Inclure les mobiles enregistrés pour les notifications même s'ils n'ont pas de connexion Realtime ouverte.
- [x] Plafonner le groupe à quatre appareils dans le prototype (maximum de cinq prévu) et choisir de façon stable par activité puis identifiant.
- [x] Utiliser des identités distinctes pour chaque appareil ciblé dans le même `<Dial>`.
- [x] Laisser Twilio arbitrer la connexion gagnante ; ne pas inventer un second arbitrage indépendant par Realtime.
- [x] Enregistrer l'appareil gagnant lorsque le fournisseur confirme la connexion.
- [x] Transformer les événements d'annulation des autres SDK en fermeture de leur interface de sonnerie.
- [x] Utiliser Realtime pour accélérer la mise à jour des écrans, sans en dépendre pour annuler l'audio ou la notification native.
- [ ] Tester explicitement un refus local pendant qu'un autre appareil sonne. Si le SDK impose un comportement différent, adapter l'action et son libellé avant validation.
- [x] Gérer une ligne sans appareil éligible et une expiration du délai de sonnerie.

### 6.4. Éviter les doubles appels et les conflits

- [x] Pour un sortant, acquérir atomiquement la réservation de l'utilisateur à la création d'intention.
- [x] Pour un entrant, réserver chaque utilisateur éligible avant d'inclure ses appareils dans le routage ; tous ses appareils partagent la réservation du même appel. Ne pas attendre le callback de réponse pour arbitrer deux appels concurrents.
- [x] Après réponse, conserver la réservation du gagnant et libérer celles des autres utilisateurs ; après expiration/annulation, libérer celles de la tentative terminée.
- [x] Définir le traitement d'une arrivée d'appel pendant un appel actif : indisponible au MVP, sans attente complexe.
- [ ] Vérifier les collisions sortant/sortant, entrant/sortant et deux entrants rapprochés.
- [x] Libérer les réservations sur fin confirmée, échec de démarrage et expiration contrôlée.
- [x] Ne pas libérer une réservation active sur simple perte d'un heartbeat client.
- [x] Pour le web, réserver l'enregistrement vocal à un seul onglet par utilisateur et profil navigateur ; les autres affichent un état explicite.
- [x] Coordonner les onglets avec Web Locks et transférer la réservation au prochain onglet lorsque le propriétaire se ferme.
- [ ] Valider la coordination et la reprise sur les navigateurs ciblés.
- [x] Empêcher un changement de ligne ou de compte pendant un appel sans comportement défini : les fonctions de sélection le refusent et l'application mobile désactive aussi les sélecteurs tant que l'appel n'est pas terminé.

### 6.5. Prévoir annulation, révocation et reprise

- [x] Permettre d'annuler une intention non utilisée sans appeler Twilio inutilement.
- [ ] Pour un raccrochage serveur, vérifier les droits sur l'appel et terminer la connexion appropriée, en couvrant les connexions enfants concernées.
- [ ] Définir ce que fait une révocation pendant une sonnerie ou un appel : bloquer les nouvelles opérations et interrompre les connexions concernées si cette politique est retenue.
- [ ] Tenir compte de la durée de vie résiduelle d'un token déjà émis ; l'expiration du token et la fin d'un appel actif sont des mécanismes distincts.
- [x] Ajouter une tâche de réconciliation des appels bloqués en cours : interroger Twilio avec limites de fréquence, puis corriger l'historique.
- [ ] Tester le redémarrage de l'API pendant une communication : les prochains callbacks et la réconciliation doivent retrouver l'appel.
- [ ] Ne pas supposer que Twilio réessaie tous les échecs indéfiniment ; configurer et tester les politiques applicables.

Les webhooks vocaux sont soumis à une limite de réponse documentée de 15 secondes ; viser un budget interne nettement inférieur, par exemple un p95 sous une seconde dans l'environnement de démonstration. C'est un objectif de mesure, pas une performance déjà acquise. [Délais et retries Twilio](https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides).

### 6.6. Faire la recette du routage

- [ ] Web et iPhone sonnent ; iPhone répond ; web cesse de sonner.
- [ ] Web et Android sonnent ; web répond ; Android retire sa notification native.
- [ ] iPhone et Android répondent presque simultanément ; une seule conversation et un seul gagnant sont retenus.
- [ ] L'appelant raccroche avant réponse ; tous les appareils s'arrêtent.
- [ ] Un appareil refuse ; l'autre conserve la possibilité de répondre selon la politique validée.
- [ ] Aucun appareil ne répond ; un seul appel manqué est affiché.
- [ ] Rejouer plusieurs fois chaque callback, puis inverser leur ordre ; l'historique ne régresse pas.
- [ ] Révoquer un appareil puis rappeler la ligne ; l'appareil ne reçoit plus de nouvelle tentative de routage.

**Validation J2 :** rapport `docs/test-reports/multi-device-routing.md`, aucun appel métier dupliqué et aucune sonnerie persistante après fin ou réponse ailleurs dans la matrice supportée.

<a id="produit"></a>

## 10. Phase 7 — Ajouter contacts et messagerie SMS

**Dépendance :** socle des droits et événements de phase 6. **But :** compléter la valeur produit sans contourner le backend commun.

### 7.1. Construire les contacts

- [x] Ajouter `contacts` et `contact_phones` avec migrations et politiques de lecture.
- [x] Ajouter création, consultation, modification, recherche et archivage selon les droits retenus.
- [x] Normaliser les numéros à l'entrée au format E.164 utilisé par l'interface.
- [x] Gérer les homonymes, plusieurs numéros et plusieurs contacts utilisant éventuellement le même numéro.
- [x] Prévoir une alerte de doublon utile sans fusion automatique destructive.
- [x] Détecter les modifications concurrentes avec version ou condition équivalente ; retourner un conflit clair.
- [x] Afficher un contact associé aux appels/messages sans altérer leurs numéros historiques.
- [x] Ajouter les actions Appeler et Envoyer un SMS depuis une fiche.
- [x] Différer import massif, synchronisation du carnet système et CRM.

### 7.2. Construire les conversations

- [x] Ajouter `conversations`, `messages` et `conversation_reads`.
- [x] Définir une conversation par ligne et numéro distant pour le MVP.
- [x] Indexer la dernière activité et paginer les messages.
- [x] Préserver l'ordre stable avec date serveur et identifiant ; ne pas utiliser seulement l'heure du téléphone client.
- [x] Séparer état du transport SMS, erreur fournisseur et lecture interne par l'utilisateur.
- [x] Vérifier les permissions sur la ligne de la conversation à chaque lecture et écriture.

### 7.3. Implémenter un envoi robuste

- [x] Créer `POST /v1/messages` avec ligne/conversation, destinataire, texte et clé d'idempotence.
- [x] Vérifier capacité SMS de la ligne, affectation, destination autorisée, contenu non vide, taille et quotas.
- [x] Créer l'enregistrement métier avant l'appel fournisseur et réserver le quota atomiquement.
- [x] Enregistrer un état `submitting` pendant la tentative fournisseur.
- [x] Envoyer par l'API Messaging avec le numéro autorisé et une URL de callback liée au message interne.
- [x] Enregistrer `MessageSid` dès qu'il est connu, y compris si un callback le fournit avant la réponse HTTP d'envoi.
- [x] Si le fournisseur refuse clairement la création, enregistrer un échec et appliquer la règle de quota : toute tentative persistée avant l'appel fournisseur compte dans le plafond quotidien de démonstration, même si Twilio la refuse; les refus d'autorisation ou de plafond avant préparation ne le consomment pas.
- [x] Si la requête expire après avoir pu être acceptée, passer en état `unknown` et déclencher une réconciliation ; ne pas renvoyer aveuglément.
- [x] Réutiliser la même clé pour les reprises de la même action ; refuser même clé avec un contenu différent.
- [x] Conserver l'action incertaine après fermeture de l'application et restaurer sa clé uniquement pour son auteur autorisé.
- [x] Vérifier les garanties d'idempotence réellement disponibles sur l'endpoint fournisseur avant de compter dessus; la création d'un Message Twilio n'expose pas de clé d'idempotence documentée, donc l'application ne s'appuie pas dessus.
- [x] Donner à l'utilisateur un état « vérification de l'envoi » lorsque le résultat est incertain.

**Limite à concevoir explicitement :** une transaction PostgreSQL ne peut pas rendre atomique un envoi externe Twilio. Une ligne en base plus une clé d'idempotence ne suffisent pas à garantir un envoi exactement une fois après un timeout réseau. Le traitement des résultats incertains fait donc partie du MVP.

### 7.4. Recevoir les messages et statuts

- [x] Exposer `POST /webhooks/twilio/messages/inbound` avec validation de signature.
- [x] Identifier la ligne par le compte et le numéro destinataire, puis créer/retrouver la conversation.
- [x] Dédupliquer par identifiant fournisseur et conserver le texte reçu comme donnée à afficher de façon sûre.
- [x] Répondre avec la réponse TwiML attendue sans déclencher de réponse automatique non demandée.
- [x] Exposer `POST /webhooks/twilio/messages/status`.
- [x] Mapper les statuts pertinents : attente, envoyé, livré, non livré, échec.
- [x] Tolérer doublons et désordre des callbacks ; ne pas remplacer `delivered` par un ancien `sent`.
- [x] Conserver les codes d'erreur fournisseur pour le diagnostic avec un message produit compréhensible.
- [x] Ne jamais afficher « lu par le destinataire » sur la base d'un simple accusé SMS.
- [x] Traiter les restrictions ou refus d'envoi remontés par le fournisseur sans boucle de retry automatique.

Les callbacks de statut peuvent arriver dans un ordre différent de leur émission. `sent` et `delivered` représentent des étapes distinctes ; les confirmations disponibles dépendent du canal et du réseau. [Suivi des statuts SMS](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status) et [ressource Message](https://www.twilio.com/docs/messaging/api/message-resource).

### 7.5. Ajouter les écrans et valider

- [x] Écran de conversations avec ligne concernée, correspondant, dernier message et non-lus.
- [x] Écran conversation avec composition, envoi, état incertain, échec et statuts disponibles.
- [x] Indiquer l'impact des messages longs/Unicode sur les segments à titre informatif, sans inventer un prix fixe.
- [ ] Tester un envoi réel et une réponse réelle sur les destinations autorisées.
- [x] Tester avec un fournisseur simulé les accents français, emoji, textes longs GSM-7/Unicode et plusieurs actions rapprochées; les essais réels restent séparés.
- [x] Tester double soumission/idempotence, timeout API, callback anticipé et dupliqué, et refus de ligne non autorisée avec Supabase/Twilio simulés; l'essai réel reste distinct.
- [x] Conserver des tests contractuels avec fournisseur simulé dans la CI ; distinguer explicitement ces tests des essais réels (succès, refus Twilio définitif et timeout incertain couverts par l'API).

**Validation :** contacts persistants, conversations stables, SMS réels démontrés lorsque la ligne le permet et aucun renvoi automatique susceptible de dupliquer un SMS au résultat incertain.

## 11. Phase 8 — Synchroniser les clients et terminer le MVP web

**Dépendance :** phase 7. **But :** montrer les mêmes données sur chaque appareil et fournir une interface utilisable.

### 8.1. Ajouter le client API partagé

- [x] Créer `packages/api-client` avec une fonction de lecture du token injectée selon la plateforme.
- [x] Centraliser sérialisation, erreurs, pagination, annulation des requêtes et identifiants de corrélation.
- [ ] Créer des clés TanStack Query incluant organisation et, si nécessaire, ligne.
- [ ] Partager les hooks compatibles avec web et React Native ; garder le stockage et le cycle de vie spécifiques aux plateformes.
- [ ] Réserver Zustand à l'état local utile : composeur, vue active, préférences temporaires ; ne pas dupliquer toute la base dans un second store.
- [x] Désactiver les retries automatiques dangereux des mutations ; distinguer lecture rejouable et opération à effet externe.

### 8.2. Définir les canaux privés

- [x] Créer des topics ciblés : `org:{id}:contacts`, `line:{id}:voice`, `line:{id}:sms` et `user:{id}:devices`.
- [x] Écrire les règles de lecture sur `realtime.messages` selon membre actif, rôle et affectation de ligne.
- [x] Refuser aux clients la publication d'événements métier autoritaires sur ces topics.
- [x] Configurer chaque abonnement avec `private: true` et fermer les accès publics inutiles.
- [x] Préférer de petits événements d'invalidation : identifiant, type de ressource, version et date ; relire le contenu via l'API.
- [x] Publier depuis une modification transactionnelle de la base pour ne pas annoncer une écriture finalement annulée.
- [ ] Tester qu'un utilisateur de A ne peut pas souscrire aux topics de B, même en devinant leur nom.

Les publications depuis la base et leur caractère privé doivent être configurés de façon cohérente côté serveur et client. [Broadcast Supabase](https://supabase.com/docs/guides/realtime/broadcast).

### 8.3. Gérer le cycle de vie et les changements de droits

- [x] Rafraîchir le token utilisé par Realtime lors du renouvellement de session.
- [x] Après reconnexion réseau, réabonnement ou retour au premier plan, relire les données actives depuis l'API.
- [x] Invalider les listes et détails concernés sans recharger toute l'application à chaque événement.
- [x] Mettre à jour l'interface si une ressource a été supprimée ou si une ligne n'est plus autorisée.
- [x] Au changement de compte/organisation, supprimer cache, abonnements et données persistées correspondants.
- [ ] Tenir compte du cache d'autorisation des canaux : définir la fenêtre de révocation et une stratégie de renouvellement/reconnexion.
- [x] Ne pas diffuser de texte de SMS ou d'autre contenu sensible dans des invalidations pouvant être reçues par une session dont les droits viennent de changer.
- [x] Bloquer les lectures API après retrait des droits et actualiser l'interface au prochain événement, retour au premier plan ou renouvellement de canal.

### 8.4. Construire les écrans du MVP web

- [x] Connexion, état de session expirée et réinitialisation du mot de passe.
- [x] Sélecteur d'organisation et de ligne lorsque plusieurs sont disponibles.
- [x] Historique d'appels : sens, numéro, résultat, date, durée et rappel.
- [x] Composeur : saisie, normalisation, clavier, ligne sortante visible et disponibilité.
- [x] Interface d'appel persistante : invitation, répondre, refuser, mute, DTMF, raccrocher.
- [x] Contacts : recherche, liste et édition.
- [x] SMS : conversations, composition, reprise et statuts.
- [x] Réglages : appareils, périphériques audio disponibles et informations de diagnostic non sensibles.
- [x] États de chargement, vides, hors ligne, permission refusée, ligne indisponible et service désactivé.
- [x] Accessibilité clavier, focus cohérent, libellés des boutons d'appel et contrastes lisibles.

### 8.5. Tester la récupération des données

- [ ] Modifier un contact sur une interface ; constater sa mise à jour sur l'autre.
- [ ] Déconnecter temporairement un client ; créer appels/messages ailleurs ; le reconnecter et retrouver tout l'historique.
- [ ] Suspendre un onglet ou laisser le token expirer ; vérifier reconnexion et renouvellement.
- [ ] Tester deux modifications concurrentes du même contact.
- [ ] Supprimer une affectation de ligne pendant une session ouverte ; les prochaines lectures/opérations sont refusées.
- [ ] Vérifier qu'une notification Realtime perdue ne laisse pas le client définitivement incohérent.

**Validation :** le web constitue une application démontrable et retrouve les données correctes après une interruption, même sans avoir reçu tous les événements.

<a id="mobile"></a>

## 12. Phase 9 — Transformer le spike mobile en application utilisable

**Dépendances :** choix technique validé en phase 5 et contrats stables des phases 7/8.

### 9.1. Construire la navigation et les composants natifs

- [ ] Mettre en place navigation native, zones sûres, gestion du clavier et liens de retour d'authentification.
- [ ] Créer `design-tokens` lorsque les premières valeurs visuelles doivent être communes au web et au mobile.
- [ ] Créer `ui-mobile` uniquement pour les composants réellement répétés.
- [x] Réaliser les vues Appels, Contacts, Messages et Réglages.
- [ ] Garder les écrans d'appel cohérents avec CallKit et l'interface Android, y compris quand l'application s'ouvre depuis un appel entrant.
- [ ] Réutiliser les règles, contrats et requêtes ; ne pas chercher à partager les composants DOM avec React Native.

### 9.2. Gérer sessions, permissions et appareils

- [x] Implémenter restauration et renouvellement de session avec stockage sécurisé.
- [x] Reconnecter Realtime lors des transitions de l'application et invalider les données au retour au premier plan.
- [x] Renouveler les tokens vocaux et mettre à jour l'enregistrement push quand le système renouvelle son token.
- [ ] Gérer déconnexion, changement d'utilisateur, réinstallation et révocation d'un ancien appareil.
- [x] Ne pas conserver un enregistrement de l'ancien utilisateur après changement de compte sur le même téléphone.
- [ ] Expliquer les permissions au moment utile et proposer un accès aux réglages après un refus.
- [x] Ne pas demander l'accès au carnet système tant que l'import de contacts n'existe pas.

### 9.3. Gérer le cycle de vie d'appel

- [x] Faire vivre le moteur vocal hors du cycle de montage d'un écran.
- [x] Synchroniser action native Répondre/Refuser et état de l'interface React Native.
- [x] Restaurer la vue d'appel au retour au premier plan lorsque le SDK expose un appel à reprendre.
- [x] Traiter la réception d'un push d'annulation avant que l'écran ne soit prêt.
- [x] Gérer Bluetooth, haut-parleur, écouteur et changement de périphérique selon les capacités exposées.
- [ ] Tester interruptions audio et interactions avec un appel cellulaire ou une autre application audio.
- [ ] Afficher les états de reconnexion et de fin réelle sans promettre une récupération transparente impossible à garantir.

### 9.4. Livrer les builds internes

- [ ] Produire un build iOS installable avec la chaîne de signature choisie.
- [ ] Produire un build Android interne signé.
- [ ] Séparer identifiants/configurations `dev` et `demo`, notamment les credentials push.
- [ ] Tester les builds de distribution sur appareils réels, en plus des development builds.
- [ ] Documenter installation, mise à jour, permissions et anomalies connues.
- [ ] Garder les anciennes versions mobiles compatibles avec les évolutions additives de l'API.

**Validation :** les parcours essentiels de `docs/demo-scenarios.md` passent sur iPhone et Android avec les mêmes comptes et données que le web.

<a id="exploitation"></a>

## 13. Phase 10 — Ajouter les reprises, les limites et l'observabilité

**Dépendance :** un besoin réel de traitement différé identifié. La réconciliation des appels/messages bloqués justifie généralement cette phase avant la démonstration finale.

### 10.1. Introduire le worker de manière ciblée

- [x] Créer `apps/worker` comme processus Node séparé lorsqu'une tâche doit survivre au cycle HTTP de l'API.
- [x] Créer les files Supabase nécessaires par migration et limiter leurs permissions au serveur.
- [x] Commencer par deux types de tâches : réconciliation fournisseur et nettoyage/expiration des réservations.
- [ ] Définir un payload versionné, un identifiant métier et une clé d'idempotence par job.
- [x] Faire écrire donnée métier et tâche en une transaction lorsque leur cohérence l'exige ; sinon utiliser une petite outbox transactionnelle.
- [ ] Configurer délai de visibilité, tentatives, backoff, arrêt après échec répété et archivage des jobs en erreur.
- [x] Acquitter une tâche après son succès durable, pas avant l'appel fournisseur.
- [ ] Tester un crash avant et après l'effet externe ; le traitement rejoué doit vérifier ce qui a déjà été fait.
- [x] Déclencher les recherches périodiques de ressources bloquées avec un mécanisme persistant documenté, pas un timer de navigateur.
- [x] Pour les SMS au résultat incertain, privilégier une vérification fournisseur et une intervention explicite si nécessaire, sans envoi supplémentaire automatique.

Supabase Queues fournit une file durable ; le code métier doit tout de même tolérer les reprises et les effets externes partiellement réalisés. [Supabase Queues](https://supabase.com/docs/guides/queues).

### 10.2. Installer les protections de consommation

- [ ] Vérifier/configurer le rate limiting Auth natif Supabase et couvrir les commandes d'administration si elles sont ajoutées; tokens Voice, intentions d'appel, SMS et diagnostics ont déjà des fenêtres partagées côté API.
- [x] Stocker les plafonds métier dans un mécanisme atomique partagé, pas seulement dans la mémoire d'un processus.
- [x] Limiter destinations, durée des appels, appels concurrents et volume de SMS.
- [x] Prévoir `VOICE_ENABLED` et `SMS_ENABLED` côté serveur pour bloquer les nouvelles opérations rapidement.
- [x] Documenter séparément la manière d'arrêter les appels déjà actifs ; un coupe-circuit de création ne les termine pas.
- [ ] Ajouter alertes de consommation et rapprochement périodique avec les données de facturation disponibles.
- [ ] Prévoir une marge : une alerte de budget n'est pas un plafond de dépense instantané.

### 10.3. Installer logs et mesures utiles

- [x] Corréler `requestId`, organisation, ligne, `callId`, `CallSid`, `messageId`, `MessageSid` et `jobId` sans exposer leurs secrets associés.
- [x] Masquer numéros et contenu sensible dans les logs courants ; réserver l'accès aux diagnostics détaillés.
- [x] Mesurer temps de réponse des webhooks, erreurs de signature, échecs fournisseur et ressources en attente anormale.
- [x] Mesurer les échecs d'enregistrement vocal et le délai observé entre la fin côté client et le rafraîchissement de l'historique; événements bornés et débit limité par utilisateur.
- [x] Suivre profondeur des files, âge des tâches et échecs permanents.
- [ ] Ajouter alertes sur indisponibilité API, hausse des erreurs voix/SMS et consommation inattendue.
- [x] Écrire une procédure de diagnostic allant d'un appel affiché jusqu'à ses connexions fournisseur.

### 10.4. Vérifier les défaillances importantes

- [ ] API interrompue temporairement pendant des callbacks.
- [ ] Base indisponible lors d'une intention d'appel ou d'un webhook.
- [ ] Fournisseur indisponible ou timeout de création de SMS.
- [ ] Worker interrompu au milieu d'une tâche.
- [ ] Client recevant deux fois un événement ou reconnecté après plusieurs minutes.
- [ ] Expiration de JWT et de token vocal avec et sans appel actif.
- [ ] Reprise après redémarrage sans perte des verrous/réservations métier.

**Validation J3 :** un MVP web/mobile utilisable, dont les principaux incidents produisent des états explicites et une reprise observable.

## 14. Phase 11 — Déployer une démonstration autonome

**Dépendances :** J3. L'API de développement fonctionne déjà depuis les premiers essais ; cette phase rend la livraison de démonstration reproductible.

### 11.1. Choisir et configurer l'hébergement

- [ ] Choisir un hébergeur statique pour le web et un hébergement Node persistant pour l'API.
- [ ] Vérifier processus durable, HTTPS, gestion des secrets, logs, région et absence de mise en veille incompatible avec les webhooks.
- [ ] Déployer le worker séparément s'il est utilisé.
- [ ] Créer le projet Supabase `demo` et les ressources Twilio dédiées prévues en phase 1.
- [ ] Définir les domaines de démonstration, certificats HTTPS et URLs publiques canoniques.
- [ ] Configurer Auth, CORS, callbacks, credentials mobiles et origines autorisées pour ces domaines exacts.
- [ ] Documenter les régions et traitements de données réellement utilisés ; ne pas déduire leur localisation de la seule région PostgreSQL.

### 11.2. Créer les pipelines de livraison

- [ ] API : contrôles → artefact immutable → migrations compatibles → déploiement → santé → smoke test.
- [ ] Web : contrôles → build statique → déploiement → parcours de connexion.
- [ ] Worker : contrôles → déploiement indépendant → vérification de consommation d'une tâche de test sans effet externe.
- [ ] Mobile : build par plateforme → signature → distribution interne → validation sur appareil.
- [ ] Restreindre les secrets par environnement et protéger les branches de livraison.
- [x] Vérifier qu'un changement de package partagé relance les builds/tests de ses consommateurs.
- [x] Ajouter une version d'application visible dans les diagnostics et une version API documentée.

### 11.3. Préparer les mises à jour et retours arrière

- [ ] Déployer les changements de schéma de manière additive avant de supprimer/remplacer une colonne.
- [ ] Maintenir la compatibilité avec les builds mobiles encore distribués.
- [ ] Conserver l'artefact de la version précédente pour revenir en arrière sur l'application.
- [x] Documenter les migrations irréversibles : un retour applicatif ne suffit pas toujours à annuler un changement de données (`docs/runbooks/backup-and-restore.md`, migrations forward-only et stratégie expand/migrate/contract).
- [ ] Activer la sauvegarde disponible pour l'environnement retenu et effectuer un essai de restauration dans une base distincte.
- [x] Documenter la rotation de clés Twilio/Supabase et la procédure de remplacement des credentials push (`docs/runbooks/secrets-rotation.md`).
- [x] Ajouter un mode maintenance compréhensible lorsque les créations d'appels/SMS sont temporairement bloquées (`OPERATIONS_PAUSED`, réponse API `503 operations_paused` et texte affiché dans les clients).

### 11.4. Effectuer un smoke test réel contrôlé

- [ ] Se connecter avec un compte de démonstration et vérifier sa ligne.
- [ ] Effectuer un appel sortant court vers un numéro autorisé.
- [ ] Recevoir un appel et répondre sur mobile pendant que le web sonne.
- [ ] Envoyer/recevoir un SMS compatible puis vérifier la synchronisation.
- [ ] Contrôler historique, logs corrélés, absence de secrets et compte Twilio réellement utilisé.
- [ ] Redéployer l'API et répéter les vérifications de santé et d'accès.

**Validation J4 :** la démonstration fonctionne sans dépendre du terminal du développeur ni d'un tunnel éphémère.

<a id="distribution"></a>

## 15. Phase 12 — Ajouter Windows et macOS avec Electron

**Dépendance :** MVP web fiable et API déployée. **But :** réutiliser les écrans web tout en gérant le système et la distribution.

### 12.1. Extraire le partage utile

- [ ] Déplacer progressivement les écrans communs de `apps/web` vers `packages/web-app`.
- [ ] Créer `ui-web` pour les composants effectivement communs au web, desktop et extension.
- [ ] Garder `apps/web` comme point d'entrée du navigateur et `apps/desktop` comme point d'entrée Electron.
- [ ] Injecter navigation, stockage sécurisé et intégrations système par des interfaces limitées.
- [ ] Réutiliser `voice-web` ; ne pas créer un nouveau backend ou une seconde logique d'appel.

### 12.2. Construire une coquille sécurisée

- [ ] Séparer processus principal, preload et renderer.
- [ ] Activer `contextIsolation` et sandbox ; désactiver `nodeIntegration` dans le renderer.
- [ ] Exposer une API preload minimale avec validation des paramètres et de l'émetteur IPC.
- [ ] Restreindre navigations, nouvelles fenêtres, liens externes et permissions audio aux origines prévues.
- [ ] Définir une CSP adaptée et ne pas désactiver la sécurité web pour contourner un problème d'intégration.
- [ ] Choisir un chargement de l'interface packagée avec une origine/protocole approprié et testé pour les APIs média.
- [ ] Gérer les tokens avec un stockage système adapté et une passerelle limitée, sans exposer les secrets serveur.

Ces mesures suivent les recommandations d'isolation des processus et de permissions Electron. [Sécurité Electron](https://www.electronjs.org/docs/latest/tutorial/security).

### 12.3. Gérer les usages desktop

- [ ] Ajouter notifications d'appel et retour au premier plan.
- [ ] Définir ce que fait la fermeture de la fenêtre : quitter ou rester en zone de notification ; le comportement doit être visible.
- [ ] Gérer instance unique et activation d'une instance déjà ouverte.
- [ ] Tester veille/réveil, perte réseau et changement de microphone/casque.
- [ ] Ajouter le protocole de lien profond si la liaison extension → desktop le nécessite.
- [ ] Valider strictement tout lien profond ; un lien reçu ne constitue pas une autorisation de lancer un appel.
- [ ] Tester connexion, rappel, SMS et appels entrants sur Windows et macOS réels.

### 12.4. Distribuer

- [ ] Préparer builds par système/architecture retenus et installateurs.
- [ ] Configurer signature Windows et signature/notarisation macOS selon le mode de distribution.
- [ ] Tester installation sur machine propre avec permissions microphone et notifications.
- [ ] Tester mise à jour, conservation de session et désinstallation.
- [ ] Choisir soit mises à jour automatiques authentifiées/signées, soit procédure manuelle explicite pour le prototype.
- [x] Documenter la politique de version API minimale et le comportement d'un ancien client avant toute distribution (`docs/api-compatibility.md`; aucun minimum n'est imposé avant les premiers builds signés).

**Validation :** la même fonctionnalité métier fonctionne dans les deux applications desktop, avec appels réels et intégrations système testées.

## 16. Phase 13 — Ajouter l'extension Chrome click-to-call

**Dépendances :** composeur web stable ; desktop disponible pour l'option de lancement desktop. **But :** ouvrir un numéro et son contexte dans l'application authentifiée.

### 13.1. Créer l'extension minimale

- [ ] Créer `apps/extension` avec WXT + React, puis fixer les versions. [Installation WXT](https://wxt.dev/guide/installation.html).
- [ ] Utiliser Manifest V3 et une popup simple.
- [ ] Ajouter une action explicite : sélectionner un numéro puis « Ouvrir dans le composeur ».
- [ ] Normaliser les numéros avec le même contrat que l'application.
- [ ] Limiter les permissions à celles réellement nécessaires, par exemple `activeTab`, `scripting`, `storage` et `contextMenus` selon les fonctions retenues.
- [ ] Éviter une lecture permanente de tous les sites ; demander une permission de domaine seulement pour une fonction qui l'exige.
- [ ] Transmettre uniquement le numéro sélectionné et le contexte utile, pas le contenu complet de la page.

`activeTab` fournit un accès temporaire à l'onglet après une action de l'utilisateur ; son fonctionnement doit correspondre au parcours retenu. [Permission activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

### 13.2. Implémenter d'abord le parcours simple

- [ ] Ouvrir l'application web sur une route de composeur avec le numéro prérempli et sans token de session dans l'URL.
- [ ] Si aucune session n'existe, connecter l'utilisateur puis restaurer ce brouillon.
- [ ] Rechercher le contact depuis l'application authentifiée ; ne pas donner un accès au carnet à la page web visitée.
- [ ] Demander à l'utilisateur de choisir sa ligne et d'appuyer sur Appeler dans l'application.
- [ ] Passer alors par la création normale d'intention d'appel et toutes les vérifications serveur.
- [ ] Tester l'encodage, les numéros invalides, les champs trop longs et les paramètres malveillants.

Ce premier parcours satisfait le click-to-call sans moteur audio dans l'extension et sans protocole d'authentification supplémentaire inutile. Le lien transporte un brouillon non fiable ; l'autorisation existe dans la session de l'application cible.

### 13.3. Ajouter la liaison authentifiée avancée seulement si nécessaire

- [ ] Si l'extension doit afficher elle-même un contact ou piloter une fenêtre existante, créer un appairage explicite depuis l'application connectée.
- [ ] Utiliser un code court dans le temps, à usage unique, lié à l'utilisateur et à l'instance de l'extension.
- [ ] Échanger ce code contre des droits limités à la fonction, révocables et sans clé Twilio.
- [ ] Vérifier strictement origine, destinataire, identifiants d'extension et anti-rejeu des messages.
- [ ] Pour le desktop, transmettre une commande opaque à réclamer via une session authentifiée ; ne jamais appeler directement depuis un simple lien non vérifié.
- [ ] Donner le choix web/desktop et une solution de repli si l'application desktop n'est pas installée.
- [ ] Garder l'appel et son audio dans web/Electron, conformément à `project.md`.

### 13.4. Tester et distribuer

- [ ] Tester pages classiques, numéros internationaux, sélection de texte et liens `tel:`.
- [ ] Gérer proprement les pages où Chrome interdit l'injection.
- [ ] Tester popup fermée et redémarrage du service worker sans perte d'une commande durable.
- [ ] Ne pas stocker l'état indispensable uniquement dans des variables globales du service worker. [Cycle de vie Chrome](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
- [ ] Tester utilisateur déconnecté, session expirée, commande déjà consommée et tentative depuis un site non autorisé.
- [ ] Produire le paquet d'extension et un guide de chargement interne ; préparer la fiche de publication seulement si la diffusion publique est décidée.

**Validation :** un numéro sélectionné ouvre le bon composeur et son contact autorisé, puis un appel réel peut être lancé sans audio ni secret privilégié dans l'extension.

<a id="recette"></a>

## 17. Phase 14 — Faire la recette finale et livrer le projet

**Dépendance :** phases requises pour les plateformes effectivement annoncées.

### 14.1. Définir les niveaux de test

| Niveau | Ce qui est vérifié | Exécution |
|---|---|---|
| Unitaire | Normalisation, transitions, permissions pures, clés d'idempotence | Chaque PR |
| Intégration API/SQL | Auth, RLS, transactions, callbacks, courses, contraintes | Chaque PR concernée |
| Parcours web automatisé | Connexion, contacts, composeur, historique, erreurs | CI, avec double vocal explicitement simulé |
| Contrat fournisseur | Parsing de payloads documentés, signatures et statuts | Fixtures synthétiques/signées ; pas de secrets réels |
| Téléphonie réelle | Audio, push, routage, DTMF et délivrabilité réelle | Recette contrôlée avec budget |
| Distribution | Installation, permissions, signature, reprise et mise à jour | Avant chaque livraison concernée |

### 14.2. Exécuter la matrice fonctionnelle

| Scénario | Web | iOS | Android | Windows | macOS | Résultat attendu |
|---|---|---|---|---|---|---|
| Appeler un numéro autorisé | Oui | Oui | Oui | Oui | Oui | Audio bidirectionnel, bon numéro appelant |
| Recevoir et répondre | Oui | Oui | Oui | Oui | Oui | Un gagnant, arrêt des autres tentatives |
| Refuser / raccrocher | Oui | Oui | Oui | Oui | Oui | État cohérent et ressources libérées |
| Mute / DTMF | Oui | Oui | Oui | Oui | Oui | Commandes effectives, pas seulement changement visuel |
| Perdre puis retrouver le réseau | Oui | Oui | Oui | Oui | Oui | État explicite et historique récupéré |
| Appel écran verrouillé | Selon navigateur/OS | Oui | Oui | Selon OS | Selon OS | Résultat documenté pour chaque état supporté |
| SMS entrant/sortant | Oui | Oui | Oui | Oui | Oui | Conversation et statuts cohérents |
| Contact modifié ailleurs | Oui | Oui | Oui | Oui | Oui | Actualisation ou resynchronisation correcte |
| Session expirée / appareil révoqué | Oui | Oui | Oui | Oui | Oui | Nouvelles opérations refusées et parcours de reprise clair |
| Accès autre organisation | Oui | Oui | Oui | Oui | Oui | Aucune donnée ni action autorisée |

L'extension a sa propre recette de la phase 13 ; elle n'est pas une sixième plateforme audio. Ajouter le navigateur, la version OS, le modèle et le réseau à chaque résultat réel. Une case non exécutée reste « non testée », jamais « validée ».

### 14.3. Vérifier les invariants de sécurité et de fiabilité

- [ ] JWT manquant, invalide, expiré, d'un autre projet et utilisateur désactivé.
- [ ] Membre sans ligne, mauvaise organisation, rôle insuffisant et ressource inexistante.
- [ ] Écriture directe Supabase et tentative d'exécution d'une fonction serveur depuis un client.
- [ ] Webhook sans signature, corps modifié, mauvais compte et URL canonique incorrecte.
- [ ] Rejeu d'intention depuis un autre appareil ou pour un second appel.
- [ ] Deux créations simultanées de SMS ou d'appel avec la même clé.
- [ ] Même clé d'idempotence avec un corps différent.
- [ ] Callbacks reçus dans tous les ordres significatifs et connexions perdantes annulées.
- [ ] Callback perdu suivi d'une réconciliation.
- [ ] Canal Realtime d'une autre organisation et retrait de droits pendant une connexion ouverte.
- [ ] Absence de secret privilégié dans les bundles, source maps livrées et journaux.
- [ ] Limites de consommation et coupe-circuits réellement appliqués côté serveur.

### 14.4. Livrer la documentation

- [x] `README.md` : installation et lancement local avec Supabase hébergé.
- [x] `.env.example` : variables documentées, sans secret et par application concernée.
- [x] `docs/architecture.md` : flux, frontières et responsabilité de chaque application/package.
- [x] `docs/data-model.md` : tables, relations, droits, transitions et rétention actuelle documentée; durée métier encore à décider.
- [x] `docs/api.md` : routes, contrats, auth, erreurs, pagination et idempotence.
- [x] `docs/decisions/` : Expo, identité par appareil, accès aux données, routage et extension.
- [x] `docs/runbooks/` : Twilio, push, déploiement, diagnostic, sauvegarde, rotation et arrêt d'urgence des dépenses.
- [x] `docs/test-reports/` : résultats des vérifications exécutées, essais réels non réalisés clairement identifiés et matrice des plateformes supportées.
- [x] `docs/demo-scenarios.md` : script de démonstration et limites, sans données d'authentification.
- [x] `docs/known-limitations.md` : réseau, fermeture forcée, capacités SMS, plafonds et fonctionnalités exclues.
- [x] Notes de version et liste des prochaines tâches classées par valeur/risque.

### 14.5. Répéter une démonstration complète

1. Ouvrir web et mobile sur le même compte et la même ligne.
2. Créer un contact sur le web et le retrouver sur le mobile.
3. Appeler ce contact et afficher l'historique après raccrochage.
4. Appeler la ligne depuis un téléphone externe.
5. Montrer plusieurs appareils qui sonnent, répondre sur un seul, constater l'arrêt des autres.
6. Envoyer un SMS et recevoir une réponse compatible avec la ligne.
7. Mettre un appareil hors ligne, créer une activité ailleurs, puis montrer sa resynchronisation.
8. Sélectionner un numéro dans Chrome et l'ouvrir dans le composeur.
9. Montrer un refus d'accès à une ligne non affectée.
10. Retrouver un appel dans les diagnostics sans révéler de token ni de contenu privé inutile.

**Validation J5 :** le projet peut être installé, testé, déployé et démontré par une autre personne à partir du dépôt et de la documentation.

<a id="avance"></a>

## 18. Phase 15 — Ajouter les fonctions avancées après stabilisation

Cette phase est facultative et ne bloque pas la livraison du MVP défini dans `project.md`.

### 15.1. Enregistrements

- [ ] Définir les parcours d'information et les règles applicables aux participants avant activation.
- [ ] Choisir qui peut activer, consulter, télécharger et supprimer un enregistrement.
- [ ] Définir une durée de conservation et le traitement des demandes de suppression.
- [ ] Ajouter la configuration d'enregistrement Twilio et les callbacks dédiés seulement après vérification documentaire ciblée.
- [ ] Créer la table `recordings` et un bucket privé ; éviter les URLs publiques permanentes.
- [ ] Faire récupérer le média par le worker avec les credentials serveur puis le stocker selon la politique choisie.
- [ ] Contrôler l'accès avant chaque URL temporaire de lecture.
- [ ] Tester suppression sur tous les emplacements réellement utilisés, y compris la copie fournisseur si elle est conservée.

### 15.2. Transcription et résumé

- [ ] Choisir le fournisseur, les langues, les exigences de traitement des données et le budget.
- [ ] Créer des tâches asynchrones versionnées, idempotentes et observables.
- [ ] Conserver les états en attente/en cours/terminé/échec avec une reprise explicite.
- [ ] Lier résultat, version et source au bon appel et à sa bonne organisation.
- [ ] Présenter le résumé comme un contenu généré à vérifier ; permettre une correction.
- [ ] Appliquer les mêmes droits d'accès et règles de suppression aux données dérivées.

### 15.3. Export CRM

- [ ] Commencer par un export simple d'une activité choisie, avec mapping explicite des champs.
- [ ] Si une intégration native est nécessaire, ajouter OAuth, stockage serveur des credentials, révocation et état de synchronisation.
- [ ] Empêcher les doublons par identifiant d'activité externe et clé d'idempotence.
- [ ] Enregistrer les erreurs exportables/rejouables sans bloquer les appels.
- [ ] Tester la révocation de connexion et la séparation des organisations.

**Validation J6 :** les fonctions avancées restent isolées du chemin critique téléphonique et respectent les mêmes autorisations.

<a id="api"></a>

## 19. Inventaire cible des routes API

Les noms ci-dessous sont une proposition de contrat propre au projet. Ce ne sont pas des méthodes supposées des SDK Twilio ou Supabase. Créer chaque route au moment de sa phase, avec son schéma d'entrée, son schéma de sortie et ses tests d'autorisation.

### Routes utilisées par les interfaces

| Méthode et route | Responsabilité | Autorisation / protection |
|---|---|---|
| `GET /health/live` | Processus vivant | Pas de donnée interne |
| `GET /health/ready` | Dépendances disponibles | Réponse publique minimale |
| `GET /v1/me` | Identité et contexte autorisé | JWT valide, compte actif |
| `GET /v1/organizations` | Organisations accessibles | Appartenances actives |
| `GET /v1/organizations/:orgId/lines` | Lignes visibles et utilisables | Membre actif ; droits calculés |
| `GET /v1/organizations/:orgId/members` | Membres utiles à l'administration | Administrateur |
| `PUT /v1/lines/:lineId/assignments/:userId` | Affectation explicite d'une ligne | Administrateur, même organisation, audit |
| `DELETE /v1/lines/:lineId/assignments/:userId` | Retrait d'affectation | Administrateur, invalidation des droits, audit |
| `POST /v1/devices` | Créer/retrouver son appareil | Utilisateur courant ; plateforme validée |
| `GET /v1/devices` | Consulter ses appareils | Utilisateur courant |
| `POST /v1/devices/:id/revoke` | Révoquer un appareil | Propriétaire ou rôle autorisé, audit |
| `POST /v1/voice/token` | Émettre un token vocal | Appareil actif, droits, rate limit |
| `POST /v1/call-intents` | Préparer un appel sortant | Affectation, destination, budget, idempotence |
| `POST /v1/call-intents/:id/cancel` | Annuler une tentative non consommée | Propriétaire et état compatible |
| `GET /v1/lines/:lineId/calls` | Historique paginé | Droit de lecture sur la ligne |
| `GET /v1/calls/:id` | Détail d'un appel | Droits sur sa ligne et organisation |
| `POST /v1/calls/:id/hangup` | Terminaison serveur de secours si nécessaire | Droit sur cet appel ; action idempotente |
| `GET /v1/organizations/:orgId/contacts` | Recherche et liste paginée | Membre actif |
| `POST /v1/organizations/:orgId/contacts` | Créer un contact | Droit d'édition, validation |
| `GET /v1/contacts/:id` | Lire une fiche | Même organisation |
| `PATCH /v1/contacts/:id` | Modifier avec version attendue | Même organisation, gestion des conflits |
| `DELETE /v1/contacts/:id` | Supprimer selon politique | Droit d'édition ; historique préservé |
| `GET /v1/lines/:lineId/conversations` | Liste des conversations | Affectation avec lecture SMS |
| `GET /v1/conversations/:id/messages` | Messages paginés | Droits sur la ligne de la conversation |
| `GET /v1/messages/pending` | Restaurer les SMS incertains de l'utilisateur et leurs clés de reprise | Auteur, appartenance active et affectation SMS active |
| `POST /v1/messages` | Envoyer un SMS | Capacité ligne, droits, quotas, idempotence |
| `PUT /v1/conversations/:id/read` | Position de lecture personnelle | Utilisateur courant, conversation accessible |

Accepter/refuser, mute et DTMF sont normalement des actions du SDK dans `VoiceClient`. Ajouter un endpoint pour chacune sans besoin serveur réel compliquerait inutilement le chemin d'appel.

### Routes fournisseur

| Route | Réponse attendue | Rôle |
|---|---|---|
| `POST /webhooks/twilio/voice/outbound` | TwiML | Utiliser une intention autorisée pour connecter le destinataire |
| `POST /webhooks/twilio/voice/inbound` | TwiML | Résoudre la ligne et router vers les appareils |
| `POST /webhooks/twilio/voice/status` | Accusé rapide après traitement durable | Mettre à jour les connexions et l'appel métier |
| `POST /webhooks/twilio/voice/dial-action` | TwiML de fin/repli | Traiter la fin du routage et éviter les continuations indésirables |
| `POST /webhooks/twilio/messages/inbound` | TwiML adapté | Enregistrer le SMS entrant |
| `POST /webhooks/twilio/messages/status` | Accusé rapide après traitement durable | Mettre à jour le transport SMS |
| `POST /webhooks/twilio/recordings/status` | Accusé rapide | Phase 15 uniquement |

Ces routes n'utilisent pas le JWT des utilisateurs : elles vérifient l'authenticité fournisseur, le compte attendu et la cohérence des ressources ciblées. Aucune ne doit être transformée en webhook public sans authentification pour faciliter un test.

### Conventions communes

- `Authorization: Bearer ...` pour les routes utilisateur ; validation complète côté API.
- `Idempotency-Key` pour les créations à effet externe. Conserver l'empreinte du corps et scoper la clé par acteur/opération.
- `400` pour une entrée invalide, `401` pour une authentification absente/invalide, `403` pour un refus de droit, `404` selon la politique choisie de non-divulgation des ressources.
- `409` pour une version conflictuelle, une réservation incompatible ou une clé réutilisée avec un autre corps.
- `429` pour une limite atteinte ; message d'attente compréhensible côté interface.
- Corps d'erreur stable, par exemple `code`, `message`, `requestId`, et éventuellement détails de validation autorisés.
- Pagination avec limites maximales et curseur stable ; aucun historique illimité par défaut.
- Dates UTC ISO 8601 dans l'API ; localisation uniquement à l'affichage.
- OpenAPI et tests de contrat mis à jour avec les routes ; évolutions additives sous `/v1` pour les anciens clients.

## 20. Exemples de transactions métier à spécifier avant codage

### Transaction A — Autoriser un appel

1. Charger l'appartenance active et l'affectation de ligne.
2. Vérifier destination, capacité et limites.
3. Chercher la clé d'idempotence et comparer son empreinte.
4. Acquérir la réservation d'appel de l'utilisateur de manière atomique.
5. Créer l'intention à durée limitée et le contexte métier nécessaire.
6. Enregistrer la réponse rejouable liée à la clé.
7. Valider la transaction, puis retourner l'intention au client.

L'émission de l'intention ne signifie pas qu'un appel a été facturé ou même commencé. Le webhook sortant lie ensuite l'intention à la connexion réelle.

### Transaction B — Projeter un callback

1. Vérifier signature, compte et format hors transaction autant que possible.
2. Insérer l'événement avec sa clé de déduplication.
3. Si l'événement est déjà appliqué, retrouver le résultat sans nouvel effet.
4. Verrouiller ou mettre à jour conditionnellement les connexions et l'appel concernés.
5. Appliquer les transitions autorisées et recalculer le résultat global.
6. Enregistrer l'invalidation Realtime et/ou la tâche de suivi dans le même commit si nécessaire.
7. Valider puis renvoyer la réponse attendue.

Prévoir séparément le rejeu d'un webhook demandant du TwiML : un doublon doit retrouver des instructions cohérentes, pas simplement une réponse HTTP vide.

### Transaction C — Préparer un SMS

1. Vérifier droits, capacités, destination et clé d'idempotence.
2. Créer/retrouver la conversation et le message sortant.
3. Réserver les limites métier et enregistrer la tentative.
4. Valider la transaction.
5. Appeler Twilio hors verrou SQL prolongé.
6. Enregistrer succès, échec certain ou résultat incertain dans une seconde transaction.
7. Laisser callback/réconciliation compléter le résultat lorsque nécessaire.

Un verrou SQL tenu pendant toute une requête réseau fournisseur rallonge les contentions et ne supprime pas le risque d'effet externe partiellement confirmé.

<a id="demarrage"></a>

## 21. Les premiers travaux à lancer concrètement

### Première séquence : installation et dépôt

Ces commandes sont à exécuter **lors du démarrage de l'implémentation**, après installation des outils. Ce plan ne les a pas exécutées.

```bash
cd /Users/hugo/Downloads/onoffv2
git init -b main
pnpm init
mkdir -p apps/api/src apps/web/src packages/contracts/src
mkdir -p supabase/migrations supabase/tests docs/decisions docs/runbooks docs/test-reports scripts
```

Puis, dans cet ordre :

1. Ajouter `.gitignore` avant de créer les fichiers de secrets ; exclure notamment `.env`, variantes locales, clés/certificats, `node_modules`, sorties de build et données locales.
2. Configurer le package racine comme privé et fixer Node/pnpm.
3. Ajouter `pnpm-workspace.yaml` :

   ```yaml
   packages:
     - 'apps/*'
     - 'packages/*'
   ```

4. Initialiser API, web et contrats avec les versions vérifiées ; si un générateur est utilisé, fixer aussi sa version et préserver les fichiers existants.
5. Ajouter les configurations TypeScript et scripts de chaque workspace.
6. Installer les dépendances, générer `pnpm-lock.yaml` et le versionner.
7. Créer les routes de santé et la page qui les appelle.
8. Ajouter la CI et vérifier le build depuis un checkout propre.
9. Vérifier l'identifiant du projet Supabase hébergé autorisé, puis appliquer les migrations versionnées par la CLI/MCP distante.
10. Ajouter les premiers comptes et organisations de test, puis l'authentification.
11. Mettre l'API de développement en HTTPS avec les contrôles de webhook déjà prévus.
12. Implémenter la première intention d'appel et effectuer l'appel web réel avant d'élargir le design.

### Découpage proposé des premiers lots de code

| Lot | Contenu | Preuve attendue |
|---|---|---|
| 1 | Monorepo, scripts, TypeScript, CI | Install + typecheck + build reproductibles |
| 2 | API, configuration, santé, logs | Requête web → API visible et corrélée |
| 3 | Migrations organisations/membres/lignes | Schéma hébergé, historique distant et types vérifiés |
| 4 | Authentification et autorisations | Tests A/B et lignes non affectées |
| 5 | Appareils et tokens vocaux | Appareil enregistré sans secret client |
| 6 | Intention, webhook et appel sortant | Audio bidirectionnel réel |
| 7 | Appel entrant et historique minimal | Appel entrant réel puis historique |
| 8 | Spike mobile et décision technique | Rapport iOS/Android sur appareils réels |
| 9 | Événements durables et routage multiple | Réponse sur un seul appareil, doublons maîtrisés |
| 10 | Contacts, SMS et synchronisation | Scénario complet sur deux appareils |

Chaque lot doit rester révisable. Éviter un seul changement contenant toutes les plateformes et des centaines de fichiers sans appel réel déjà validé.

<a id="estimation"></a>

## 22. Estimation de charge et suivi

Il s'agit d'un **ordre de grandeur de planification**, établi sans connaissance du niveau de l'équipe ni de ses comptes existants. Hypothèse : une personne expérimentée TypeScript, avec une capacité réelle à diagnostiquer iOS/Android, travaillant à temps plein ; interface sobre de prototype et faible nombre d'utilisateurs. Les délais de vérification des comptes, disponibilité de numéros et validation de distribution ne sont pas inclus.

| Ensemble | Charge indicative additionnelle |
|---|---:|
| Phases 0–3 : cadrage, comptes, monorepo, données/auth | 6–10 jours de travail |
| Phases 4–5 : vrais appels web et spike mobile | 7–12 jours |
| Phase 6 : fiabilité et routage multi-appareils | 5–9 jours |
| Phases 7–8 : contacts, SMS, synchronisation, web | 7–12 jours |
| Phases 9–10 : mobile complet, reprise et observabilité | 10–18 jours |
| Phase 11 : livraison de démonstration | 3–5 jours |
| Phases 12–13 : desktop et extension | 7–12 jours |
| Phase 14 : recette finale et transfert | 3–5 jours |
| **Total J5, hors fonctions avancées** | **48–83 jours de travail** |

Repères cumulés : faisabilité J1 vers 13–22 jours ; MVP web/mobile J3 vers 35–61 jours ; ensemble J5 vers 48–83 jours. À cinq jours par semaine, J5 représente environ 10–17 semaines avant marge et délais externes. Ajouter une réserve de 20–30 % tant que le spike mobile et les capacités des lignes ne sont pas validés. Une équipe découvrant la téléphonie native doit réestimer après J1.

Pour livrer plus tôt, réduire le nombre de plateformes de la première démonstration et reporter les fonctions avancées. Garder les tests de permissions, les webhooks authentifiés et les essais réels : ils conditionnent la validité du prototype.

### Suivi hebdomadaire proposé

- Jalon en cours et scénario réellement démontrable.
- Tâches terminées avec preuve de fonctionnement.
- Anomalies bloquantes et responsable de résolution.
- Résultats des essais iOS/Android et numéros réellement compatibles.
- Consommation Twilio, nombre de tests et plafonds restants.
- Décisions nouvelles et effet sur charge/périmètre.
- Prochain petit livrable de bout en bout.

### Budget opérationnel à préparer avant les essais

Collecter les prix réels au moment de provisionner, sans appliquer un forfait générique supposé :

| Poste | Informations à relever |
|---|---|
| Numéros | Pays, type, quantité, location et capacités disponibles |
| Appels | Tarifs des connexions utilisées, destinations, durées et volume des tests |
| SMS | Destination, sens, segments, éventuels frais liés à l'expéditeur |
| Supabase | Environnements, taille, sauvegardes, Realtime et stockage utiles |
| Hébergement | API persistante, worker éventuel, trafic et logs |
| Distribution | Comptes développeur, signature et services de build éventuels |
| Phase avancée | Enregistrements, conservation, transcription et génération |

Documenter un plafond opérationnel et un contrôle régulier. Les coûts dépendent du pays et de l'usage réellement testé ; aucun achat ou engagement de service n'est effectué par ce plan.

## 23. Principaux risques et solutions de repli

| Risque | Signal de détection | Réponse prévue |
|---|---|---|
| Numéro ciblé sans SMS bidirectionnels | Vérification Console + essai réel phase 1/7 | Ligne compatible alternative ; limite produit annoncée |
| Compte ou formalités bloquants | Provisionnement impossible phase 1 | Démarches démarrées tôt ; poursuivre socle avec tests synthétiques clairement identifiés |
| Expo incompatible avec la combinaison retenue | Build ou push en échec phase 5 | Repli vers projets React Native natifs ; versions fixées |
| Push iOS/Android instable | Matrice écran verrouillé/arrière-plan en échec | Vérifier credentials, signature, intégration native et limites OS avant UI complète |
| Plusieurs appareils restent en sonnerie | Essais de réponse simultanée phase 6 | Examiner annulations SDK/push et routage fournisseur, sans dépendre de Realtime |
| Historique erroné | Callback tardif ou connexion enfant mal corrélée | Reducer de transitions testé + réconciliation fournisseur |
| SMS potentiellement envoyé deux fois | Timeout au moment de création | État incertain et vérification ; pas de retry aveugle |
| Fuite entre organisations | Tests négatifs API, RLS ou Realtime | Bloquer le jalon et corriger avant élargissement |
| Consommation inattendue | Quotas ou alertes franchis | Coupe-circuit nouvelles opérations, inspection des appels actifs et rotation si nécessaire |
| Ancien mobile incompatible | Nouvelle API rompant les contrats | Évolutions additives, versionnement et période de compatibilité |
| Trop d'abstractions dès le début | Packages sans consommateurs ni preuve réelle | Extraire seulement après apparition du besoin |
| Démonstration dépendante du poste local | Tunnel/terminal indispensable | Environnement `demo` autonome avant annonce de livraison |

## 24. Définition finale de « terminé »

Le projet correspondant au périmètre MVP/distribution de `project.md` est terminé lorsque toutes les conditions suivantes sont prouvées :

- [ ] Un nouveau développeur peut installer le dépôt et reconstruire les environnements documentés.
- [ ] Les migrations, seeds de test et configurations sont versionnés et reproductibles.
- [ ] Les secrets privilégiés restent côté serveur et les bundles clients ont été vérifiés.
- [ ] Un utilisateur autorisé peut appeler et être appelé sur les plateformes annoncées avec de l'audio réel.
- [ ] Plusieurs appareils peuvent sonner et une réponse sur l'un termine les autres tentatives.
- [ ] Les fonctions de refus, raccrochage, mute et DTMF fonctionnent effectivement.
- [ ] Contacts, messages compatibles et historique sont partagés sans doublons ni régression d'état.
- [ ] Un client retrouve les données exactes après reconnexion, même s'il a manqué des événements Realtime.
- [ ] Les utilisateurs non autorisés ne peuvent ni lire une autre organisation ni utiliser sa ligne.
- [ ] Les doublons, callbacks désordonnés, résultats d'envoi incertains et reprises sont testés.
- [ ] Les limites de consommation, diagnostics et procédures d'incident sont utilisables.
- [ ] Les builds mobiles/desktop et l'extension peuvent être installés suivant la documentation.
- [ ] L'environnement de démonstration fonctionne indépendamment du poste de développement.
- [ ] Les limites connues sont consignées et les essais non réalisés sont clairement identifiés.
- [ ] Les enregistrements, transcriptions et intégrations avancées restent désactivés tant que leur phase spécifique n'est pas validée.

Le premier objectif concret à poursuivre est **J1 : un vrai appel web entrant/sortant et une preuve mobile sur iPhone et Android**. Une fois ce risque levé, le reste du plan s'appuie sur un socle téléphonique vérifié.

# Projet — Prototype de téléphonie multicanal basé sur Twilio

## 1. Objectif

Créer un prototype inspiré d’Onoff Business pour démontrer des possibilités produit : appels, SMS, contacts et historique, accessibles depuis plusieurs appareils.

**Principe : un produit, un monorepo TypeScript, un backend commun et plusieurs interfaces.** Partager la logique et les données sans imposer la même interface sur toutes les plateformes.

Le prototype fonctionne en VoIP via Twilio. Il ne vise pas à reconstruire une infrastructure d’opérateur mobile.

## 2. Stack retenu

| Élément | Choix |
|---|---|
| Organisation | Monorepo TypeScript avec pnpm workspaces |
| Web | React + Vite |
| Windows / macOS | Electron réutilisant l’interface web |
| iPhone / Android | React Native avec SDK Twilio natif |
| Extension Chrome | WXT + React ; click-to-call et contexte contact |
| Backend | Node.js + Fastify ; monolithe modulaire |
| Données / identité | Supabase : PostgreSQL, Auth, Realtime privé, Storage privé |
| État client | TanStack Query ; Zustand pour l’état local nécessaire |
| Téléphonie / SMS | Twilio Voice, Messaging et numéros compatibles |
| Traitements différés | Worker Node.js + Supabase Queues, lorsque nécessaire |

**Expo reste à valider**, pas une dépendance imposée. Tester la compatibilité du SDK Twilio dans un development build sur de vrais appareils ; Expo Go n’est pas la cible. Repli : React Native avec projets natifs gérés directement.

## 3. Architecture

```text
Web ────────┐
Electron ───┤
Mobile ─────┼── API Fastify ── Supabase
Chrome ─────┘       │              │
                    │          Realtime → clients autorisés
                    │          Queues → worker
                    ▼
                  Twilio
                    │
                    └── Webhooks → API → PostgreSQL

Audio : SDK web ou natif ↔ Twilio ↔ destinataire
        Le son ne passe pas par Fastify ou Supabase.
```

Le backend contrôle les autorisations, l’accès aux lignes, le routage, les tokens Twilio, l’envoi des SMS et les événements téléphoniques. PostgreSQL conserve les données métier et l’historique.

Le worker traite les tâches non urgentes. Aucun traitement lourd ne doit bloquer un webhook qui attend des instructions d’appel.

## 4. Organisation du code

```text
apps/
  web/              # Application navigateur
  desktop/          # Electron et intégrations système
  mobile/           # Application React Native iOS / Android
  extension/        # Extension Chrome
  api/              # API et webhooks Fastify
  worker/           # Traitements asynchrones

packages/
  contracts/        # Types et schémas de validation
  core/             # Logique métier partageable
  api-client/       # Client API et hooks communs
  web-app/          # Écrans partagés entre web et Electron
  ui-web/           # Composants web et extension
  ui-mobile/        # Composants natifs
  design-tokens/    # Identité visuelle commune
  voice-contract/   # Interface téléphonique commune
  voice-web/        # Adaptateur SDK Twilio JavaScript
  voice-native/     # Adaptateur SDK Twilio React Native

supabase/
  migrations/
  tests/
```

Créer les applications et packages progressivement, uniquement lorsqu’ils sont utilisés. Les secrets et modules serveur ne doivent jamais entrer dans les bundles clients.

## 5. Mutualisation et synchronisation

Partager les contrats, validations, modèles, appels API, hooks compatibles et règles métier communes. Garder spécifiques la navigation mobile, les permissions, les notifications, les périphériques audio et les intégrations système.

Les écrans utilisent un contrat `VoiceClient` : `register`, `startCall`, `acceptCall`, `rejectCall`, `hangUp`, `setMuted`, `sendDigits`, `subscribeToCallEvents`. Les adaptateurs web et natif implémentent ce contrat ; les capacités propres à chaque plateforme restent explicites.

**Données :** modification → API → PostgreSQL → notification Realtime privée → actualisation des clients autorisés. Après reconnexion ou retour au premier plan, relire les données serveur : les événements temps réel ne remplacent pas une synchronisation.

**Code :** une modification partagée bénéficie aux applications lors de leurs builds. Web, desktop, mobile et extension gardent des publications distinctes. Préserver la compatibilité de l’API avec les anciennes versions mobiles.

## 6. Flux essentiels

### Appel sortant

L’application demande une intention d’appel à l’API. Le serveur vérifie la ligne, la destination et les droits. Le SDK démarre l’appel ; Twilio consulte le webhook vocal, reçoit les instructions TwiML et connecte le destinataire. Les callbacks actualisent l’historique.

### Appel entrant

Twilio contacte le webhook. Le backend identifie la ligne et les appareils autorisés, puis déclenche le routage. Le premier appareil qui répond prend l’appel ; les autres cessent de sonner.

Sur mobile, prévoir les intégrations natives : APNs/PushKit et CallKit sur iOS, FCM et gestion native des appels sur Android. Ne pas compter sur Realtime pour réveiller l’application. Tester les limites liées au réseau, à l’arrière-plan et à l’arrêt forcé.

### SMS et extension

Les SMS sortants passent par le backend. Les messages entrants et statuts reviennent par webhook, sont enregistrés puis synchronisés.

L’extension ouvre ou pilote le composeur web/desktop via une liaison authentifiée. **Pas de moteur audio autonome dans l’extension au MVP.**

## 7. Données et fiabilité

Modèles principaux : organisations, membres et rôles ; lignes et affectations ; appareils ; contacts ; conversations et messages ; appels ; connexions d’appel (`call_legs`) ; événements et enregistrements éventuels.

Distinguer utilisateur, ligne et appareil. Distinguer également un appel métier de ses connexions Twilio : plusieurs `CallSid` peuvent appartenir au même appel affiché.

Les webhooks doivent être authentifiés, idempotents et tolérer les événements désordonnés. Une notification tardive ne doit pas faire revenir un appel terminé à l’état « sonnerie ».

## 8. Périmètre et ordre de réalisation

| Étape | Livrable et validation |
|---|---|
| 1. Socle et faisabilité | Authentification, une ligne de test, appels web entrants/sortants ; test technique mobile sur iPhone et Android réels avant investissement UI important |
| 2. MVP démontrable | Contacts, composeur, accepter/refuser/raccrocher, mute, DTMF, SMS compatibles et historique ; synchronisation et sonnerie multi-appareils validées |
| 3. Distribution | Application Electron et extension click-to-call réutilisant le socle |
| 4. Démonstration avancée | Enregistrement, transcription, résumé et export CRM, après validation du cœur téléphonique |

Hors MVP : portabilité, remplacement complet d’une ligne mobile, commercialisation opérateur, appels d’urgence, transfert d’un appel en cours entre appareils, moteur audio d’extension et intégrations CRM avancées.

Vérifier les capacités, disponibilités et conditions d’usage des numéros Twilio ciblés avant de promettre une équivalence avec Onoff. Utiliser des données, numéros et destinataires de test autorisés.

## 9. Consignes pour l’IA de développement

- **Construire une tranche fonctionnelle de bout en bout avant d’élargir les plateformes.** Pas de microservices, Kubernetes ou abstractions inutiles.
- Vérifier les SDK dans leur documentation officielle et fixer leurs versions. Ne pas inventer une méthode Twilio ni présenter une simulation comme un appel réel.
- Vérifier les tokens Supabase côté API, les droits par organisation et ligne, les politiques RLS et les signatures des webhooks. Les clés privilégiées restent côté serveur.
- Prévoir limites de consommation, restrictions de destinations, logs corrélés et protection contre les doubles actions. Ne pas journaliser de secrets.
- Isoler le contexte Electron et limiter les permissions Chrome. Pour les enregistrements, définir l’accès, la conservation et le parcours d’information avant activation.
- Livrer migrations versionnées, `.env.example` sans secret, README de démarrage et tests des autorisations, du routage et des événements dupliqués/désordonnés.

## 10. Déploiement et critères de réussite

Web sur hébergement statique ; API Node persistante avec webhooks HTTPS publics ; worker séparé si nécessaire ; Supabase commun à chaque environnement. Séparer développement et démonstration. Chaque application possède son pipeline de build dans le même dépôt.

Le MVP est validé lorsqu’un utilisateur peut appeler et être appelé, retrouver contacts/messages/historique sur ses appareils, reprendre une session sans incohérence et répondre sur un appareil sans laisser sonner les autres. Vérifier aussi qu’un utilisateur non autorisé ne peut ni consulter une autre organisation ni utiliser sa ligne.

**Priorité : téléphonie fiable et données communes, puis multiplication des interfaces.**

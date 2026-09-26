# IVR et centre d’appels Twilio

## Parcours

Ouvrir **IVR & files d’attente** dans la navigation administrateur. **Créer un IVR** ouvre directement l’arbre du parcours quand un seul numéro vocal est disponible ; sinon, choisir le numéro. Cliquer sur **Ajouter une branche**, nommer le choix, puis sélectionner sa destination dans le panneau : agent, file, numéro externe, sous-menu, messagerie ou raccrochage. Le petit **+** sous une destination ajoute un sous-menu en conservant cette destination. Les niveaux se parcourent avec **Ouvrir les branches** et le fil de navigation.

Les agents et les nouvelles files peuvent être configurés dans le panneau de la branche. Une file créée depuis l’éditeur est synchronisée avec TaskRouter lors de l’enregistrement. **Enregistrer** conserve le parcours en brouillon ; **Publier le parcours** connecte le webhook vocal du numéro et active le parcours pour les nouveaux appels. **Annuler / rétablir** permet de récupérer les branches supprimées, y compris leurs sous-menus. Les horaires, délais, annonces et règles sans réponse restent accessibles depuis les blocs et **Réglages**. Aucun utilisateur, numéro, appel ou compteur fictif n’est injecté dans l’application.

Les agents doivent déjà être membres actifs avec le droit Appels sur le numéro. Ils sont créés hors ligne dans TaskRouter. Ils activent la réception dans l’application, puis choisissent **Disponible** dans leur barre de statut. L’administrateur peut aussi configurer un numéro de réception externe et changer leur activité. Une file comportant un seul agent permet un routage individuel.

- Menus à plusieurs niveaux, touches uniques, annonces textuelles ou audio HTTPS, langue, temporisation et tentatives limitées.
- Horaires par jours de la semaine et fuseau IANA, y compris une plage franchissant minuit et les changements d’heure.
- Files TaskRouter, agents, sonnerie par agent, musique/annonce d’attente, annonce de position et débordement vers renvoi, messagerie ou raccrochage.
- Brouillon distinct de la configuration publiée. Les appels déjà démarrés gardent leur configuration de menu.
- Supervision interrogée auprès de Twilio toutes les 10 secondes lorsque la page est visible : appels en attente, réservés, en conversation, âge, priorité, agent affecté et activités.
- Transfert immédiat d’un appel en file ou en conversation vers une autre file du même numéro, un numéro externe, la messagerie ou le raccrochage. L’ancien agent quitte la conversation ; il ne s’agit pas d’un transfert avec consultation.
- Enregistrement des messages laissés par les appelants via Twilio Record, notification de disponibilité et écoute administrateur authentifiée. Aucun enregistrement automatique des conversations entre deux personnes.

Les renvois respectent `TWILIO_ALLOWED_DESTINATIONS`. Les numéros déjà gérés par l’application ne peuvent pas servir de destination externe, pour éviter les boucles entre lignes. Les numéros externes sont présentés avec le numéro Twilio de l’entreprise.

## Déploiement

1. Appliquer `supabase/migrations/20260926095957_live_call_center.sql` avant la nouvelle API. L’ancien IVR et les appels directs restent compatibles tant qu’aucun parcours avancé n’est publié.
2. Déployer les builds API et Web du même changement. Aucun nouveau secret n’est nécessaire : les credentials Twilio et Supabase serveur existants sont utilisés. L’API doit avoir `VOICE_ENABLED=true`, un `API_PUBLIC_URL` HTTPS accessible par Twilio, et une clé Twilio autorisée à gérer TaskRouter, les numéros, les appels et les enregistrements.
3. Un numéro Twilio vocal actif doit être attaché à une ligne de l’organisation. La publication contrôle que le compte et le webhook correspondent. Le bouton de publication ne modifie pas les réglages SMS.
4. Activer le centre et créer les files depuis l’application. Les SID sont persistés côté serveur ; les noms déterministes permettent de retrouver les ressources après une réponse réseau perdue. Une configuration de file non synchronisée est indiquée dans l’interface et ne peut pas être publiée.
5. Publier le parcours souhaité et rendre les agents disponibles, puis réaliser un appel de recette réel.

Les credentials présents dans Railway sont masqués par le connecteur. Leur présence ne prouve ni leur validité ni les permissions TaskRouter. Le numéro et la réception des agents sont nécessaires pour la recette audio.

## API

Toutes les routes de configuration et de supervision sont sous `/v1/organizations/:orgId/center` et exigent une session administrateur active de cette organisation. `/presence` permet uniquement à un membre actif de consulter/changer son propre statut. La modification du numéro externe de réception reste réservée à un administrateur.

| Méthode | Suffixe | Fonction |
|---|---|---|
| GET | `/` | Configuration et état Twilio actuel, ou indisponibilité explicite |
| POST | `/setup` | Créer/retrouver le Workspace et ses activités |
| PUT / DELETE | `/queues/:id` | Synchroniser / supprimer une file sans référence ni appel actif |
| PUT | `/flows/:lineId` | Sauvegarder ou publier, avec contrôle de version |
| POST | `/lines/:lineId/connect` | Connecter le webhook du numéro existant |
| PUT | `/agents/:userId` | Statut et destination d’un agent |
| GET / PUT | `/presence` | Statut personnel de réception |
| POST | `/tasks/transfer` | Transférer un appel réel, avec identifiant d’opération |
| PATCH | `/tasks/priority` | Modifier la priorité d’une tâche Twilio |
| GET | `/voicemails/:id/audio` | Lire un enregistrement via un proxy serveur authentifié |

Les webhooks `/webhooks/twilio/center/*` sont signés par Twilio et vérifient le compte. Les callbacks agent de l’instruction TaskRouter `dequeue` utilisent **GET**, y compris la query string dans la validation de signature. Les autres callbacks utilisent POST. Ne pas changer cette méthode dans un reverse proxy.

## Fiabilité

Les réservations d’agents sont transactionnelles et partagées avec les appels directs et sortants. Elles recontrôlent les droits, l’état du membre et la présence récente d’un appareil. Une notification ancienne ne peut libérer qu’une réservation portant le même SID Twilio. Les callbacks de l’ancien routage sont ignorés après un transfert. Les ressources sont privées au serveur, avec RLS activée et aucun accès direct pour `anon` ou `authenticated`.

Un échec de lecture Twilio ne produit jamais de compteurs à zéro prétendument en direct. Les compteurs deviennent indisponibles. Les données de configuration restent visibles pour diagnostiquer le problème.

Les messages vocaux sont conservés chez Twilio jusqu’à leur suppression selon la politique du compte. La suppression/archivage de ces messages, les jours fériés, les plages horaires multiples par jour, les transferts avec consultation, l’écoute superviseur et le coaching ne sont pas implémentés par ce changement.

## Validation

- `pnpm --filter @onoff/contracts build && pnpm --filter @onoff/api build`
- `pnpm --filter @onoff/api test` : contrats de routage, webhooks signés, contrôles d’accès, statuts, heures/DST et traitement des erreurs fournisseur ; doublures de fournisseur uniquement dans les tests.
- `pnpm test:admin:db` : application des migrations à PostgreSQL isolé et assertions SQL sur isolation, concurrence, publication, appels rejoués et réservations. Aucune fixture n’est écrite sur la base hébergée.
- `pnpm --filter @onoff/web build`
- `pnpm --filter @onoff/web test` : suppression et restauration structurelle des branches, conservation des menus partagés et des retours, destinations en dehors des horaires, allocation des touches et files réellement référencées.

Vérification navigateur locale effectuée sur le composant réel : ajout et nommage d’une branche, choix d’un renvoi, ajout et ouverture d’un sous-menu, suppression et annulation. Cet aperçu isolé n’écrit ni dans Twilio ni dans la base hébergée.

Recette réelle à consigner séparément : appeler la ligne, tester une touche valide/invalide et sans saisie, recevoir sur un agent disponible, laisser l’appel attendre sans agent, vérifier le débordement et la messagerie, transférer en cours de conversation, puis couper et vérifier la libération de l’agent. Les tests logiciels ne constituent pas une validation audio Twilio.

# Journal des modifications

Les changements importants du prototype sont consignés ici. Aucune version n'a encore été publiée.

## [Non publié] — 2026-09-25

### Ajouté

- Règles de routage, réservation et gagnant d'appel pour les appels entrants multi-appareils.
- Capture du CallSid enfant, durée fiable des appels terminés et tri des callbacks Twilio désordonnés.
- Annulation d'une intention d'appel non consommée via l'API authentifiée et libération de sa réservation.
- Verrou de propriété Web par utilisateur et écran d'attente d'un onglet concurrent.
- État de chargement, erreur de synchronisation et perte réseau visibles dans le Web.
- Demande d'accès microphone au lancement d'un appel, avec message d'aide en cas de refus.
- Indicateurs de focus clavier, navigation active annoncée, libellés du clavier téléphonique et états de bouton muet.
- Renouvellement sérialisé des tokens Voice mobiles au retour au premier plan et toutes les 50 minutes.
- Logs API/worker corrélés par requête, organisation, ligne, activité et identifiant fournisseur, sans numéros, contenu SMS ou erreurs brutes.
- Mesure structurée de la latence et des résultats webhook, des refus de signature, de l'âge/profondeur de la reprise et de la durée des cycles worker.
- Diagnostics vocaux Web/Mobile : échecs d'enregistrement et durée du rafraîchissement d'historique, avec champs bornés et débit limité sur Supabase hébergé.
- Pause de maintenance API avec message visible pour les nouvelles créations d'appels/SMS.
- Politique d'évolution additive de `/v1` et de transition vers une future version incompatible documentée avant distribution des clients.
- Version du serveur exposée par les routes de santé; versions Web et Mobile visibles dans les réglages de diagnostic.
- Contrats de corps et de réponses Fastify reliés à Zod avec `@fastify/type-provider-zod@1.0.0`; les réponses JSON des routes `/v1` n'exposent que les champs déclarés.
- Frontière Supabase/Twilio injectable dans les tests API et scénarios contractuels SMS simulés pour l'acceptation, le refus certain et le timeout au résultat incertain.
- Sélecteurs de ligne et d'organisation mobiles indisponibles pendant une communication en cours; leur état sélectionné est exposé à l'accessibilité.
- Arrêt du worker réactif à `SIGTERM`/`SIGINT` au lieu d'attendre la fin de son intervalle de polling entre deux cycles.
- Réponse SMS qui reflète le statut projeté en base, même si un callback Twilio `delivered` arrive avant la réponse de création.

### Sécurité et exploitation

- 25 migrations appliquées au projet Supabase hébergé `onoffv2` jusqu'à `20260925152637`; les 19 tables `public` ont RLS activée et aucune instance Supabase locale n'a été utilisée.
- Les permissions de la fonction d'annulation d'intention ont été vérifiées en ligne.
- Les quatre RPC `SECURITY DEFINER` accessibles aux utilisateurs restent limités aux rôles authentifiés et valident l'identité et les affectations dans leur corps; les deux migrations de vérification ACL préservent le contrat JWT actuel de l'API.
- Le rapport de build distingue les bundles compilés des essais réels non effectués.

### Vérifications

- TypeScript : Contracts, API, Web, Mobile et Worker.
- Production Web : build Vite sous Node 24.19.0.
- Mobile : export Expo/Hermes pour iOS et Android sous Node 24.19.0.
- API : typecheck et 17 tests API réussis sous Node 24.19.0, dont cinq scénarios SMS avec fournisseurs simulés (rejeu et callback anticipé inclus); aucun appel ou SMS réel.

### En attente

- Aucun appel ou SMS réel n'a été exécuté. Credentials Twilio neufs, ligne, webhook HTTPS, utilisateurs et appareils de recette requis.
- APNs/FCM, builds mobiles signés et essais physiques requis avant d'annoncer le support iOS/Android.
- Le dépôt cible `Samsooon76/on-on` est maintenant fourni; le remote et le déploiement restent bloqués par l'absence de résolution réseau GitHub et un jeton `gh` invalide sur cet hôte.
- Tests unitaires/integration ciblés, lecteur d'écran et essais de permissions restent à réaliser.

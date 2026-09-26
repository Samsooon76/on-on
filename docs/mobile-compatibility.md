# Compatibilité mobile vérifiée

## Design iOS aligné sur le web — 26 septembre 2026

Les écrans partagent désormais le fond blanc, le vert `#246653` et les surfaces neutres du web. La typographie système utilise des graisses plus légères, avec des titres de 28 pt et des contrôles aux arrondis de 8–12 pt. Les filtres sont soulignés, les avatars sont discrets et le clavier rejoint l’alignement de la barre de navigation. Les conversations, formulaires, réglages et le clavier utilisent ces mêmes styles.

Les cibles tactiles conservent au moins 44 pt. Les contrastes des textes secondaires et des boutons actifs sont supérieurs à 4,5:1. Vérifications : TypeScript, 16 tests mobile, export Hermes iOS et contrôle visuel de l’accueil dans le simulateur iPhone 17 Pro. Aperçu : [Conversations](../output/ios/onoff-refined-conversations.png).

## Conversations sur iOS — 26 septembre 2026

L’onglet Conversations ouvre désormais l’application. Il regroupe les appels et SMS par numéro et par ligne avec la même logique que le web, extraite dans `@onoff/api-client`. Un fil existe dès le premier appel et conserve son identité au premier SMS.

- Recherche par nom, numéro ou aperçu ; filtres Toutes, Non lues et Manqués.
- Historique commun, séparateurs de dates, filtres Tout/SMS/Appels, rappel et composition de SMS dans le fil.
- Ouverture depuis un contact ou un appel récent ; avertissement avant de remplacer un brouillon.
- Chargement des pages précédentes ; actualisation au retour au premier plan et sur les événements temps réel.
- Les réponses tardives d’un autre fil sont ignorées. Seul le fil visible au premier plan est marqué comme lu. La reprise des SMS incertains conserve la clé d’idempotence existante.

Validation : tests mobile (regroupement, recherche, pagination, changement de fil pendant une requête, lecture et reprise après erreur), tests web et client API, vérifications TypeScript, build web et export Hermes iOS. Le nouvel écran d’accueil a été observé dans le simulateur iPhone 17 Pro. La session disponible n’avait aucune ligne attribuée : le parcours complet avec échanges réels reste à vérifier sur un compte équipé d’une ligne et sur iPhone physique.

## Vérification initiale du socle mobile

État au 2026-09-25. Cette vérification confirme la compilation TypeScript, la résolution Expo, la génération des projets natifs et les bundles JavaScript. Elle ne remplace pas une installation ni un appel sur iPhone et Android physiques.

## Versions retenues

| Composant | Version épinglée |
|---|---:|
| Expo SDK | 57.0.25 |
| React Native | 0.86.3 |
| React | 19.2.3 |
| Twilio Voice React Native SDK | 1.8.0 |
| Expo Dev Client | 57.0.19 |
| Expo SecureStore | 57.0.4 |
| Expo Linking | 57.0.11 |
| Node demandé par le dépôt | 24.21.0 |
| Node de l'hôte pendant cette vérification | 26.0.0 |

Le paquet Twilio documente son config plugin Expo et requiert un development build. Expo Go ne contient pas les modules natifs Twilio. La version 1.8.0 est la branche retenue après lecture de la documentation officielle; ses limites publiées imposent toujours un essai réel de chaque flux entrant.

## Résultats techniques

- `tsc --noEmit -p apps/mobile/tsconfig.json` : réussi.
- `expo config --type public` : réussi, schéma `onoff://`, identifiants dev `com.onoffv2.mobile.dev`, plugin Twilio et permission microphone présents.
- `expo prebuild --no-install` : réussi pour iOS et Android; le plugin a généré l'entitlement APNs iOS `aps-environment=development`, les hooks natifs Twilio et les projets Expo.
- `expo export --platform all` : bundles Hermes iOS et Android générés avec succès après l'extraction du SDK Twilio dans `@onoff/voice-native`.
- Le client natif restaure les appels/invitations du SDK au lancement et au retour au premier plan, renouvelle le VoiceGrant enregistré au retour au premier plan et toutes les 50 minutes, puis appelle `Voice.register()` avec le JWT neuf afin que le SDK utilise le token push natif courant. Les renouvellements sont sérialisés et les réponses arrivant après un changement de compte/appareil sont ignorées.
- Le SDK initialise PushKit au démarrage iOS et remet à l'adaptateur les invitations annulées; l'état entrant est donc remis à zéro même si aucune vue d'appel n'était montée. Le client expose les périphériques audio natifs, permet de passer au périphérique suivant et présente le sélecteur système iOS.
- Ces chemins sont implémentés mais ne sont pas validés sur appareil. Le renouvellement APNs/FCM, les invitations annulées en arrière-plan, le Bluetooth et les interruptions audio restent à confirmer dans la matrice d'essais physiques.

L'hôte n'a pas Xcode complet (seuls les Command Line Tools sont sélectionnés), pas de simulateur iOS, pas d'Android SDK/ADB et seulement Java 8. Aucune compilation native installable, signature ou recette sur appareil n'a donc été réalisée.

## Push et essais réels requis

- iOS : compte Apple Developer, Team ID, signature, App ID avec Push Notifications, entitlement PushKit/VoIP et credential APNs Twilio correspondant à l'environnement. Les profils EAS développement et démo sélectionnent les environnements APNs development et production.
- Android : projet Firebase, `google-services.json` privé correspondant au package, FCM activé et credential FCM Twilio. Fournir son chemin via `GOOGLE_SERVICES_FILE`; ne pas versionner le fichier.
- API : définir `TWILIO_PUSH_CREDENTIAL_SID_IOS` et `TWILIO_PUSH_CREDENTIAL_SID_ANDROID` dans le gestionnaire de secrets serveur. L'API inclut le SID correspondant dans le VoiceGrant natif; l'appareil n'est annoncé comme joignable qu'après son enregistrement.
- Auth : ajouter `onoff://**` ou les URI précises générées aux Redirect URLs Supabase pour la récupération de mot de passe.
- Construire les profils `development` puis `preview` de [apps/mobile/eas.json](../apps/mobile/eas.json); vérifier appels entrants au premier plan, arrière-plan, écran verrouillé, après arrêt forcé, annulation sur un autre appareil, audio Bluetooth/haut-parleur, interruptions système et changement réseau.

Le résultat de faisabilité est **Expo retenu pour le spike** : configuration et bundles passent avec le SDK publié; le verdict de réception mobile reste **non validé** jusqu'à la matrice d'essais physiques ci-dessus.

## Sources primaires

- [SDK Twilio Voice React Native](https://github.com/twilio/twilio-voice-react-native)
- [Config plugin Expo Twilio](https://github.com/twilio/twilio-voice-react-native/blob/main/docs/expo/app-config.md)
- [Access Tokens et credential push Voice](https://www.twilio.com/docs/iam/access-tokens)

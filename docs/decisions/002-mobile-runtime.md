# Décision 002 — Runtime mobile

- Date : 2026-09-25
- Statut : Expo prébuild retenu pour le prototype; compatibilité native encore à valider
- Versions épinglées : Expo SDK 57.0.25, React Native 0.86.3, React 19.2.3 et `@twilio/voice-react-native-sdk` 1.8.0.
- Éléments vérifiés : configuration Expo, config plugin Twilio, génération des projets iOS/Android et export Metro/Hermes.
- Limite : ces contrôles ne produisent pas un build signé et n'établissent pas le fonctionnement CallKit/PushKit/FCM sur un téléphone. Xcode complet, SDK Android récent, clés de signature, credentials APNs/FCM et appareils restent requis.
- Suite : produire un development build et vérifier appels entrants en premier plan, arrière-plan, écran verrouillé et après fermeture forcée sur des appareils réels avant d'annoncer la plateforme comme prise en charge.

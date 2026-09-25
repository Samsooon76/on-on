# Configuration Twilio

## Paramètres de démonstration convenus

- Première destination : France (`FR`), vers le mobile de test communiqué et autorisé par le propriétaire du projet. Conserver le numéro complet dans les secrets API (`SMS_ALLOWED_RECIPIENTS`) et la Console Twilio, jamais dans le dépôt ou un rapport.
- Plafond global des premiers appels et SMS réels : **10 €**. Le propriétaire du compte vérifie les restrictions de destination et configure les alertes de consommation avant d'activer les opérations.
- Pour un essai SMS, régler `TWILIO_ALLOWED_DESTINATIONS=+33` et `SMS_ALLOWED_RECIPIENTS` avec le ou les destinataires exacts autorisés, au format E.164, dans les secrets API. L'API refuse un SMS si le préfixe pays ou le numéro exact ne correspond pas.
- Compte, numéro Twilio, TwiML App, clés dédiées, URL API publique et credentials push : non configurés dans cet environnement au 2026-09-25. Les appels et SMS restent désactivés jusqu'à leur configuration et leur vérification.

1. Révoquer les credentials écrits en clair dans l'ancienne version de `PLAN_IMPLEMENTATION.md`; ils ont été retirés du dépôt de travail et ne doivent pas être réutilisés.
2. Créer une clé API dédiée à l'environnement, une TwiML App et un numéro qui prend en charge les canaux à tester. La ligne, son numéro, son compte et ses capacités sont enregistrés côté serveur dans `lines`; aucun numéro global n'est lu depuis l'environnement.
3. Déployer l'API sur une URL HTTPS stable et définir `API_PUBLIC_URL` avec cette URL canonique. Dans la TwiML App, configurer la requête vocale vers `POST /webhooks/twilio/voice/outbound`. Sur le numéro, configurer les appels entrants vers `POST /webhooks/twilio/voice/inbound` et les SMS entrants vers `POST /webhooks/twilio/messages/inbound`.
4. Les callbacks de statut d'appel, fin de `<Dial>` et état des SMS sont fournis par l'API dans les requêtes TwiML/API sortantes. Vérifier qu'ils sont accessibles publiquement en HTTPS et que l'URL externe vue par Twilio correspond exactement à `API_PUBLIC_URL`.
5. Ajouter `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_TWIML_APP_SID` et `SUPABASE_SECRET_KEY` dans le gestionnaire de secrets de l'API et du worker. La clé Twilio doit autoriser la création des SMS et la lecture d'une ressource Message pour la réconciliation. Pour le mobile, créer des credentials Push Credential Twilio séparés pour APNs/PushKit et FCM, puis définir leurs SID dans `TWILIO_PUSH_CREDENTIAL_SID_IOS` et `TWILIO_PUSH_CREDENTIAL_SID_ANDROID`. Le serveur place le SID adapté à la plateforme dans le VoiceGrant. Ne jamais ajouter les credentials push aux variables `VITE_*` ou `EXPO_PUBLIC_*`.
6. Vérifier les restrictions de destination, alertes de coût, plafonds quotidiens configurés dans les paramètres de l'organisation et capacités réelles de la ligne avant d'activer `VOICE_ENABLED` ou `SMS_ENABLED`.
7. Les webhooks doivent passer la validation de signature Twilio et le contrôle du `AccountSid`. Tester d'abord les payloads/signatures synthétiques, sans envoyer de vrai appel ni SMS.
8. Garder les enregistrements désactivés. Toute rotation se fait dans Twilio, puis dans les secrets de l'environnement, avant suppression des anciennes valeurs.

## Appels entrants mobiles

Le SDK natif utilise PushKit/CallKit sur iOS et FCM sur Android. Configurer le compte Apple Developer et la signature iOS avec le bon environnement APNs. Pour Android, fournir `google-services.json` au build depuis un stockage de secrets, avec `GOOGLE_SERVICES_FILE`; ne pas le versionner. Après configuration, enregistrer chaque installation dans Twilio et vérifier les essais au premier plan, en arrière-plan, écran verrouillé, après arrêt forcé et lors d'une réponse sur un autre appareil. Sans le credential push de sa plateforme, l'API permet toujours le token sortant mais ne déclare pas l'appareil joignable pour les appels entrants.

Voir [la matrice de compatibilité mobile](../mobile-compatibility.md) pour les versions épinglées et les vérifications locales déjà réalisées.

Ne jamais copier de valeur secrète dans un fichier versionné, une variable `VITE_*`, un log ou un rapport de recette.

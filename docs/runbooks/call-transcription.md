# Transcription des appels — ElevenLabs Scribe v2 Realtime

## Activation

Appliquer `supabase/migrations/20260926164938_call_transcriptions.sql` puis `supabase/migrations/20260926173257_call_recording_playback.sql` sur le projet cible, puis configurer le service API :

```dotenv
VOICE_ENABLED=true
TRANSCRIPTION_ENABLED=true
CALL_RECORDING_ENABLED=true
ELEVENLABS_API_KEY=<secret serveur>
API_PUBLIC_URL=https://votre-api.example.com
# Facultatif. Sans ce paramètre, Scribe détecte la langue.
# ELEVENLABS_LANGUAGE_CODE=fr
```

Les credentials Twilio/Supabase existants restent requis. La clé ElevenLabs nécessite l’accès Speech to Text et un quota disponible. Aucun secret ElevenLabs ne doit être ajouté aux variables `VITE_*` ou `EXPO_PUBLIC_*`. Le proxy doit accepter les upgrades WebSocket sur `/webhooks/twilio/transcription/:id`. Aucune capture audio supplémentaire, permission microphone ou modification des webhooks vocaux existants n’est nécessaire sur iOS.

### Démarrage automatique

Appliquer aussi `supabase/migrations/20260928113944_automatic_call_transcription.sql`, puis activer **Administration → Transcription automatique des appels → Activer automatiquement**. Le réglage est réservé aux administrateurs actifs et s’applique à toute leur organisation. Il est désactivé par défaut.

Les callbacks Twilio signés lancent la transcription dès la connexion du correspondant, pour les appels entrants, sortants, les files et les renvois du centre d’appels. Cela fonctionne sans ouvrir le panneau de transcription, sur web comme sur mobile. Les sonneries et l’attente dans l’IVR ne déclenchent pas la transcription. Si l’enregistrement audio est configuré, il démarre également. Prévoir l’information des interlocuteurs avant l’échange : cette option ne diffuse pas d’annonce vocale.

La désactivation concerne les prochains démarrages ; les sessions en cours restent contrôlables avec **Arrêter**. Les callbacks répétés et le bouton manuel partagent le verrou d’une session par appel. Une erreur de transcription ne doit pas interrompre l’appel. Le réglage ne remplace pas `TRANSCRIPTION_ENABLED` et les credentials serveur.

Dans un appel connecté : ouvrir **Transcription** puis **Transcrire et enregistrer**. L’interface invite l’utilisateur à informer son interlocuteur de la transcription et de l’enregistrement. Ce bouton ne diffuse pas d’annonce vocale automatique. La transcription et l’enregistrement commencent à cet instant, sans récupérer rétroactivement le début de l’appel. **Arrêter** finalise le texte et l’audio sans raccrocher. Une session par appel, sans redémarrage après l’arrêt. L’historique des appels et les conversations permettent de relire le texte, le copier/télécharger sur le web, ou le partager via la feuille iOS. Si `CALL_RECORDING_ENABLED=false`, le bouton conserve son comportement de transcription seule.

Le lecteur apparaît au-dessus du texte sur le web et iOS : lecture/pause, position, durée et vitesse de 1× à 2×. La lecture devient possible après la fin de l’appel et la préparation du fichier par Twilio. Elle est suspendue pendant un nouvel appel et à la fermeture du panneau. iOS utilise `expo-audio` : installer les pods et reconstruire l’application native ; un ancien development build reste utilisable mais invite à sa mise à jour pour écouter l’audio.

## Fonctionnement

1. Le SDK Twilio web/natif fournit son `CallSid` dès la connexion. L’API retrouve la jambe correspondante côté serveur et vérifie l’accès à l’appel via le client Supabase de l’utilisateur et les règles RLS existantes.
2. Un enregistrement unique par appel sert de verrou partagé entre les réplicas. L’API lance un Media Stream **unidirectionnel**, `both_tracks`, sur la jambe du SDK. Elle ne remplace pas le TwiML de l’appel.
3. Le handshake WebSocket vérifie la signature Twilio avec l’URL publique **WSS** fournie à Media Streams, même si Railway termine TLS et transmet un upgrade HTTP à l’API. La variante avec slash final documentée par Twilio est aussi vérifiée. Le domaine vient de la configuration serveur, jamais des en-têtes proxy. Les callbacks de statut conservent leur validation HTTPS et leur corps de formulaire signé. Le message `start` doit correspondre au compte, à la jambe, au stream et à la session attendus. Un verrou atomique empêche l’ouverture de deux sessions payantes pour un même stream.
4. Deux connexions serveur Scribe utilisent `scribe_v2_realtime`, `audio_format=ulaw_8000`, `commit_strategy=vad`. Sur la jambe SDK, la piste `inbound` porte la voix de l’utilisateur et `outbound` celle de son interlocuteur. Cette séparation fournit les libellés sans dépendre d’une diarisation du modèle. Elle représente les deux pistes de l’appel, pas chaque intervenant d’une conférence ou d’un transfert.
5. Les `partial_transcript` remplacent la phrase provisoire. Les `committed_transcript` l’ajoutent une fois au texte conservé. Les événements additionnels de timestamps ne sont pas réinsérés. Les temps affichés sont des repères approximatifs depuis le début d’appel, pas des alignements de mots.
6. Les snapshots texte sont coalescés toutes les 400 ms et sauvegardés dans Supabase. Les écrans les lisent par HTTP authentifié toutes les 800 ms, sans requêtes concurrentes, avec annulation à la fermeture et temporisation en cas d’erreur. Ce transport fonctionne entre réplicas et avec le `fetch` natif iOS. Il ajoute jusqu’à environ 1,2 s à la latence du moteur, hors réseau. En arrière-plan iOS, l’affichage suspend les requêtes puis se resynchronise au retour ; la transcription serveur continue.
7. À l’arrêt, le relais envoie un commit avec silence μ-law et attend le dernier texte (3,5 s maximum), puis ferme les connexions Scribe. Les erreurs/quota ne coupent pas l’appel. Un worker disparu est détecté à la lecture après 25 s sans heartbeat ; l’interface affiche une interruption, en conservant le texte reçu.
8. Quand l’enregistrement est activé, le même verrou déclenche une seule création de Recording Twilio sur la jambe SDK, avec les deux pistes et deux canaux. L’audio continue même si Scribe échoue. Le bouton **Arrêter** arrête aussi le Recording ; raccrocher le finalise automatiquement. Le callback signé vérifie le compte, la jambe et l’identifiant d’enregistrement avant de marquer l’audio disponible. Si le callback manque, les lectures de statut consultent Twilio au plus toutes les huit secondes. Un arrêt reçu avant la réponse de création est mémorisé puis exécuté dès que l’identifiant est connu.
9. Le fichier est servi par un endpoint authentifié de l’API qui revérifie les droits RLS sur l’appel. L’API construit elle-même l’URL Twilio, ignore toute `RecordingUrl` fournie et conserve les credentials côté serveur. Le MP3 demandé mélange les deux canaux pour écouter les deux voix. Le web charge un Blob privé à la demande et le libère à la fermeture ; iOS lit le flux HTTP avec son jeton d’accès. Les requêtes Range sont transmises au fournisseur ; le proxy limite chaque réponse à 64 Mio et interdit sa mise en cache. Le lecteur reste indépendant de l’état du texte.

## Données et exploitation

`call_transcriptions` conserve le texte final, le dernier état provisoire et les métadonnées de l’enregistrement. Le fichier audio est conservé chez Twilio, pas dans Supabase. RLS reprend l’accès à l’appel : une attribution vocale et une adhésion actives sont nécessaires. Les clients ont uniquement SELECT ; les écritures sont réservées au service serveur. La suppression d’un appel supprime sa transcription et ses métadonnées par cascade, mais ne supprime pas le Recording chez Twilio. Il n’y a pas de purge automatique du texte ou des fichiers dans cette version : appliquer la politique de conservation de l’organisation dans la base et chez Twilio. Les conditions de traitement/conservation d’ElevenLabs restent celles du compte configuré. L’enregistrement entraîne les coûts Twilio de capture et de stockage correspondants.

Le relais maintient deux sessions Scribe par appel transcrit : dimensionner le quota et le coût en conséquence. Le tampon de démarrage est borné, les doublons de chunks sont ignorés et un dépassement provoque une erreur explicite. Les snapshots complets conviennent aux appels actuellement limités par `MAX_ACTIVE_CALL_SECONDS` ; pour des volumes élevés, prévoir des segments paginés et un transport push. La transcription d’un appel terminé reste consultable via `/v1/calls/:id/transcription`.

## API

- `GET /v1/voice/calls/:providerSid/transcription` : disponibilité, état et texte de l’appel du SDK.
- `POST /v1/voice/calls/:providerSid/transcription` : démarrage idempotent pendant un appel connecté.
- `GET /v1/calls/:callId/transcription` : lecture dans l’historique.
- `POST /v1/calls/:callId/transcription/stop` : arrêt et finalisation sans raccrocher.
- `GET /v1/calls/:callId/recording/audio` : MP3 privé, après autorisation sur l’appel.
- `GET /webhooks/twilio/transcription/:sessionId` : upgrade WebSocket signé Twilio.
- `POST /webhooks/twilio/transcription/:sessionId/status` : erreurs Media Streams signées.
- `POST /webhooks/twilio/transcription/:sessionId/recording` : statut du Recording signé Twilio.

Les réponses publiques n’exposent ni clé, ni identifiant de stream, ni corps d’erreur brut du fournisseur. Un accès révoqué efface le texte affiché à la prochaine requête active.

## Vérification

Les tests unitaires couvrent le format audio, les deux pistes, le buffering borné, les commits finaux et les erreurs fournisseur. Les tests d’intégration ouvrent un vrai WebSocket local via l’application complète avec des sockets Scribe simulés : signatures WSS avec/sans slash final, refus des signatures HTTPS/absentes/invalides et d’un domaine falsifié, callbacks HTTPS signés, sauvegarde live puis lecture après l’appel. Les tests d’enregistrement couvrent le démarrage unique, les deux canaux, les callbacks désordonnés, l’arrêt concurrent à la création ou à une confirmation tardive après timeout, la réconciliation sans callback et l’autorisation avant accès au MP3. Les tests PostgreSQL couvrent RLS, révocation, absence d’écriture cliente et unicité du démarrage, y compris les métadonnées audio. Le lecteur web est vérifié dans Chrome avec un fichier de parole synthétique : lecture, pause, déplacement, vitesse et arrêt à la fermeture.

Diagnostic : un `403` sur `GET /webhooks/twilio/transcription/:id` accompagné de `Twilio webhook signature rejected` bloque le flux avant ElevenLabs. Vérifier l’URL publique WSS et le token Twilio, sans désactiver la validation. Les callbacks `stream-error` journalisent uniquement un code fournisseur assaini. Si `stream_connected=false` et aucun segment n’a été reçu, l’historique conserve l’échec. Les anciens appels sans Recording ne peuvent pas être écoutés ni reconstruits après coup. Pour les nouveaux appels enregistrés, un échec de transcription n’empêche pas l’accès à un audio finalisé ; aucune retranscription automatique du fichier n’est effectuée.

```sh
pnpm test
pnpm test:admin:db
pnpm typecheck
pnpm build
```

Pour la recette externe après configuration : passer un appel sortant puis entrant depuis le web et un development build iOS, prononcer une phrase de chaque côté, vérifier les deux libellés, arrêter en milieu de phrase, puis relire depuis l’historique. Après le raccrochage, attendre que l’audio soit prêt, écouter les deux voix, changer la position/vitesse et fermer le lecteur. Tester aussi un retour d’arrière-plan iOS et une interruption réseau. La lecture d’un véritable Recording Twilio reste à valider avec un nouvel appel enregistré ; les essais automatisés utilisent un fournisseur simulé.

Le 26 septembre 2026, la clé serveur a été validée auprès de l’endpoint ElevenLabs de jeton Scribe Realtime (HTTP 200, sans envoi d’audio). La migration de transcription a été appliquée en production et ses permissions vérifiées. Les deux migrations antérieures `mcp_user_integrations` et `customer_webhooks` restent hors de cette activation : ne pas lancer un `db push --include-all` sans vérifier leur périmètre. Un appel réel reste nécessaire pour valider la chaîne complète Twilio → Scribe → web/iOS.

Après le diagnostic du refus de signature, le relais de production a aussi été exécuté localement contre ElevenLabs avec une phrase synthétique convertie en μ-law 8 kHz, envoyée en chunks de 20 ms. Les deux pistes ont restitué la phrase complète et finalisé leurs segments. Aucun audio utilisateur n’a été utilisé pour ce contrôle.

## Documentation consultée

- [ElevenLabs : protocole Scribe Realtime](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
- [ElevenLabs : événements Realtime](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference)
- [Twilio : Streams REST](https://www.twilio.com/docs/voice/api/stream-resource)
- [Twilio : messages Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
- [Twilio : signatures et particularités des handshakes WSS](https://www.twilio.com/docs/usage/security)
- [Twilio : enregistrements d’appels](https://www.twilio.com/docs/voice/api/recording)
- [Expo : lecteur audio natif](https://docs.expo.dev/versions/latest/sdk/audio/)
- [Supabase : Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

Le 26 septembre 2026, la migration d’enregistrement a été appliquée seule en production et `CALL_RECORDING_ENABLED=true` a été configuré sur l’API. Les 218 tests, les tests PostgreSQL isolés, le build web/API, les vérifications TypeScript et la compilation native iOS simulateur passent. Le lecteur web a été vérifié avec un audio synthétique ; la recette d’un nouvel appel enregistré reste nécessaire.

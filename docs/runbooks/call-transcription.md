# Transcription des appels — ElevenLabs Scribe v2 Realtime

## Activation

Appliquer `supabase/migrations/20260926164938_call_transcriptions.sql` sur le projet cible, puis configurer le service API :

```dotenv
VOICE_ENABLED=true
TRANSCRIPTION_ENABLED=true
ELEVENLABS_API_KEY=<secret serveur>
API_PUBLIC_URL=https://votre-api.example.com
# Facultatif. Sans ce paramètre, Scribe détecte la langue.
# ELEVENLABS_LANGUAGE_CODE=fr
```

Les credentials Twilio/Supabase existants restent requis. La clé ElevenLabs nécessite l’accès Speech to Text et un quota disponible. Aucun secret ElevenLabs ne doit être ajouté aux variables `VITE_*` ou `EXPO_PUBLIC_*`. Le proxy doit accepter les upgrades WebSocket sur `/webhooks/twilio/transcription/:id`. Aucune capture audio supplémentaire, permission microphone ou modification des webhooks vocaux existants n’est nécessaire sur iOS.

Dans un appel connecté : ouvrir **Transcription** puis **Démarrer la transcription**. L’interface invite l’utilisateur à informer son interlocuteur. Ce bouton ne diffuse pas d’annonce vocale automatique. La transcription commence à cet instant, sans récupérer rétroactivement le début de l’appel. **Arrêter** finalise le texte sans raccrocher. Une session par appel, sans redémarrage après l’arrêt. L’historique des appels et les conversations permettent de relire le texte, le copier/télécharger sur le web, ou le partager via la feuille iOS.

## Fonctionnement

1. Le SDK Twilio web/natif fournit son `CallSid` dès la connexion. L’API retrouve la jambe correspondante côté serveur et vérifie l’accès à l’appel via le client Supabase de l’utilisateur et les règles RLS existantes.
2. Un enregistrement unique par appel sert de verrou partagé entre les réplicas. L’API lance un Media Stream **unidirectionnel**, `both_tracks`, sur la jambe du SDK. Elle ne remplace pas le TwiML de l’appel.
3. Le handshake WebSocket vérifie la signature Twilio avec l’URL publique **WSS** fournie à Media Streams, même si Railway termine TLS et transmet un upgrade HTTP à l’API. La variante avec slash final documentée par Twilio est aussi vérifiée. Le domaine vient de la configuration serveur, jamais des en-têtes proxy. Les callbacks de statut conservent leur validation HTTPS et leur corps de formulaire signé. Le message `start` doit correspondre au compte, à la jambe, au stream et à la session attendus. Un verrou atomique empêche l’ouverture de deux sessions payantes pour un même stream.
4. Deux connexions serveur Scribe utilisent `scribe_v2_realtime`, `audio_format=ulaw_8000`, `commit_strategy=vad`. Sur la jambe SDK, la piste `inbound` porte la voix de l’utilisateur et `outbound` celle de son interlocuteur. Cette séparation fournit les libellés sans dépendre d’une diarisation du modèle. Elle représente les deux pistes de l’appel, pas chaque intervenant d’une conférence ou d’un transfert.
5. Les `partial_transcript` remplacent la phrase provisoire. Les `committed_transcript` l’ajoutent une fois au texte conservé. Les événements additionnels de timestamps ne sont pas réinsérés. Les temps affichés sont des repères approximatifs depuis le début d’appel, pas des alignements de mots.
6. Les snapshots texte sont coalescés toutes les 400 ms et sauvegardés dans Supabase. Les écrans les lisent par HTTP authentifié toutes les 800 ms, sans requêtes concurrentes, avec annulation à la fermeture et temporisation en cas d’erreur. Ce transport fonctionne entre réplicas et avec le `fetch` natif iOS. Il ajoute jusqu’à environ 1,2 s à la latence du moteur, hors réseau. En arrière-plan iOS, l’affichage suspend les requêtes puis se resynchronise au retour ; la transcription serveur continue.
7. À l’arrêt, le relais envoie un commit avec silence μ-law et attend le dernier texte (3,5 s maximum), puis ferme les connexions Scribe. Les erreurs/quota ne coupent pas l’appel. Un worker disparu est détecté à la lecture après 25 s sans heartbeat ; l’interface affiche une interruption, en conservant le texte reçu.

## Données et exploitation

`call_transcriptions` conserve le texte final et le dernier état provisoire, pas l’audio. RLS reprend l’accès à l’appel : une attribution vocale et une adhésion actives sont nécessaires. Les clients ont uniquement SELECT ; les écritures sont réservées au service serveur. La suppression d’un appel supprime sa transcription par cascade. Il n’y a pas de purge automatique du texte dans cette version ; appliquer la politique de conservation de l’organisation. Les conditions de traitement/conservation d’ElevenLabs restent celles du compte configuré.

Le relais maintient deux sessions Scribe par appel transcrit : dimensionner le quota et le coût en conséquence. Le tampon de démarrage est borné, les doublons de chunks sont ignorés et un dépassement provoque une erreur explicite. Les snapshots complets conviennent aux appels actuellement limités par `MAX_ACTIVE_CALL_SECONDS` ; pour des volumes élevés, prévoir des segments paginés et un transport push. La transcription d’un appel terminé reste consultable via `/v1/calls/:id/transcription`.

## API

- `GET /v1/voice/calls/:providerSid/transcription` : disponibilité, état et texte de l’appel du SDK.
- `POST /v1/voice/calls/:providerSid/transcription` : démarrage idempotent pendant un appel connecté.
- `GET /v1/calls/:callId/transcription` : lecture dans l’historique.
- `POST /v1/calls/:callId/transcription/stop` : arrêt et finalisation sans raccrocher.
- `GET /webhooks/twilio/transcription/:sessionId` : upgrade WebSocket signé Twilio.
- `POST /webhooks/twilio/transcription/:sessionId/status` : erreurs Media Streams signées.

Les réponses publiques n’exposent ni clé, ni identifiant de stream, ni corps d’erreur brut du fournisseur. Un accès révoqué efface le texte affiché à la prochaine requête active.

## Vérification

Les tests unitaires couvrent le format audio, les deux pistes, le buffering borné, les commits finaux et les erreurs fournisseur. Les tests d’intégration ouvrent un vrai WebSocket local via l’application complète avec des sockets Scribe simulés : signatures WSS avec/sans slash final, refus des signatures HTTPS/absentes/invalides et d’un domaine falsifié, callbacks HTTPS signés, sauvegarde live puis lecture après l’appel. Les tests PostgreSQL couvrent RLS, révocation, absence d’écriture cliente et unicité du démarrage.

Diagnostic : un `403` sur `GET /webhooks/twilio/transcription/:id` accompagné de `Twilio webhook signature rejected` bloque le flux avant ElevenLabs. Vérifier l’URL publique WSS et le token Twilio, sans désactiver la validation. Les callbacks `stream-error` journalisent uniquement un code fournisseur assaini. Si `stream_connected=false` et aucun segment n’a été reçu, l’historique conserve l’échec : aucun audio n’est stocké pour reconstruire cet appel après coup.

```sh
pnpm test
pnpm test:admin:db
pnpm typecheck
pnpm build
```

Pour la recette externe après configuration : passer un appel sortant puis entrant depuis le web et un development build iOS, prononcer une phrase de chaque côté, vérifier les deux libellés, arrêter en milieu de phrase, puis relire depuis l’historique. Tester aussi un retour d’arrière-plan iOS et une interruption réseau.

Le 26 septembre 2026, la clé serveur a été validée auprès de l’endpoint ElevenLabs de jeton Scribe Realtime (HTTP 200, sans envoi d’audio). La migration de transcription a été appliquée en production et ses permissions vérifiées. Les deux migrations antérieures `mcp_user_integrations` et `customer_webhooks` restent hors de cette activation : ne pas lancer un `db push --include-all` sans vérifier leur périmètre. Un appel réel reste nécessaire pour valider la chaîne complète Twilio → Scribe → web/iOS.

Après le diagnostic du refus de signature, le relais de production a aussi été exécuté localement contre ElevenLabs avec une phrase synthétique convertie en μ-law 8 kHz, envoyée en chunks de 20 ms. Les deux pistes ont restitué la phrase complète et finalisé leurs segments. Aucun audio utilisateur n’a été utilisé pour ce contrôle.

## Documentation consultée

- [ElevenLabs : protocole Scribe Realtime](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
- [ElevenLabs : événements Realtime](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference)
- [Twilio : Streams REST](https://www.twilio.com/docs/voice/api/stream-resource)
- [Twilio : messages Media Streams](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
- [Twilio : signatures et particularités des handshakes WSS](https://www.twilio.com/docs/usage/security)
- [Supabase : Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

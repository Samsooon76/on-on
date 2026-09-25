# Runbook — Diagnostic et reprise

## Arrêter rapidement les nouveaux appels et SMS

Sur le service API, régler `OPERATIONS_PAUSED=true`, puis redéployer. Les routes de création d'appel et de SMS répondent alors `503 operations_paused`; Web et Mobile présentent le message de maintenance (`OPERATIONS_PAUSE_MESSAGE`). Cette pause ne révoque pas les tokens existants, ne désactive pas les appels entrants et ne raccroche pas les appels déjà actifs. Pour couper aussi les nouvelles émissions/réceptions Voice ou l'envoi SMS, régler les coupe-circuits `VOICE_ENABLED=false` et/ou `SMS_ENABLED=false`. Pour terminer immédiatement une jambe active, retrouver son `CallSid` dans l'historique ou les journaux contrôlés, puis la terminer depuis les outils de gestion des appels Twilio. Ne jamais copier une clé secrète dans une commande ou un ticket.

## Vérifier la chaîne

1. Appeler `/health/live` sur Web et `/health/ready` sur l'API. Les deux réponses incluent la version du package API pour comparer le processus actif à la version distribuée.
2. Dans les logs API, partir du `requestId` UUID; l'API n'accepte un `x-request-id` entrant que s'il respecte ce format et masque toujours cet en-tête, les URLs complètes, l'adresse réseau, le referrer, les cookies, les jetons et la signature Twilio. Les événements d'appel ajoutent `organizationId`, `lineId`, `callId`, `CallSid`, `parentCallSid` et le statut fournisseur. Les événements SMS ajoutent `organizationId`, `lineId`, `conversationId`, `messageId`, `MessageSid` et le statut. Les clients envoient au plus 10 diagnostics vocaux par utilisateur sur 5 minutes : catégories de registration, succès/échec du rafraîchissement historique, plateforme, version et durée observée depuis la fin locale de l'appel jusqu'au chargement des listes. Ils n'envoient ni message d'erreur libre, ni numéro, ni identifiant d'appel. Chaque webhook produit sa durée, son statut HTTP et son résultat; un refus de signature précise seulement la route et une raison générique. Les événements de réconciliation worker ajoutent `workerId`, `jobId` (l'identifiant persistant de jambe ou de message), organisation et identifiants fournisseur. Les instantanés de file indiquent le volume dû et l'âge du plus ancien élément inclus dans le lot. Les journaux applicatifs n'écrivent ni numéro, ni identité d'appareil, ni corps SMS, ni JWT/token, ni clé ou message d'exception brut. Les codes fournisseur sont limités aux codes numériques; les erreurs non reconnues sont ramenées à leur nom standard ou `unknown`.
3. Dans Supabase hébergé uniquement, vérifier l'état d'une jambe voix :

   ```sql
   select id, call_id, provider_call_sid, status, reconcile_after,
          reconcile_attempts, last_reconciled_at
   from public.call_legs
   where status in ('initiated', 'ringing', 'answered')
   order by reconcile_after
   limit 50;
   ```

   Pour les SMS qui nécessitent une vérification, consulter les identifiants et échéances opérationnels sans lire le contenu des messages :

   ```sql
   select task.message_id, message.status, message.provider_message_sid,
          task.next_attempt_at, task.attempts, task.last_attempt_at,
          task.manual_review_required
   from public.message_reconciliation_tasks task
   join public.messages message on message.organization_id = task.organization_id and message.id = task.message_id
   order by task.next_attempt_at
   limit 50;
   ```

4. Vérifier que le worker tourne à une seule réplique et qu'il utilise le même compte Twilio et le même projet Supabase que l'API. Ses logs structurés portent `workerId`, `jobId`, identifiant métier, identifiant fournisseur, statut, tâche et code d'erreur; une panne fournisseur augmente le backoff jusqu'à une heure. Restreindre l'accès aux journaux avec les rôles du fournisseur d'hébergement. La clé API Twilio doit autoriser la lecture d'une ressource Message pour la réconciliation.
5. Le worker vérifie `submitting`/`unknown` après deux minutes quand un `MessageSid` est disponible; il interroge aussi les messages `sent` restés sans statut final après douze heures. Les nouvelles tentatives de lecture suivent un backoff avec jitter, sans nouvelle création de SMS.
6. Si un SMS n'a pas de `MessageSid` après deux minutes, ou si sept lectures Twilio échouent, le worker laisse le message incertain, positionne `manual_review_required` et écrit une seule alerte contenant le `messageId`. Vérifier dans la Console Twilio si un message a été créé avant de décider d'une action. Ne jamais cliquer de nouveau sur Envoyer tant que l'acceptation initiale n'est pas écartée.

## Interpréter les limites

Les fenêtres persistées par utilisateur sont de 30 tokens Voice/minute, 5 intentions d'appel/minute et 10 SMS/minute; une limite retourne HTTP 429. Les quotas quotidiens d'appels et de SMS restent atomiques par organisation dans leurs fonctions métier SQL. Les intentions et réservations préparatoires expirées sont nettoyées à chaque cycle du worker. `MAX_ACTIVE_CALL_SECONDS` fixe la durée maximale du `<Dial>` (900 secondes par défaut); `MAX_RINGING_DEVICES` limite le groupe entrant.

Le `<Dial>` TwiML prend en charge `timeLimit` pour terminer une communication à la durée configurée ([référence Twilio](https://www.twilio.com/docs/voice/twiml/dial)). Les alertes de consommation Twilio/Railway et l'alerte de disponibilité externe ne sont pas configurées tant qu'un environnement de démonstration n'est pas déployé.

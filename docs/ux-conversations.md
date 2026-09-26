# Interface centrée sur les conversations

La refonte concerne l’application web et sa présentation responsive. L’application React Native conserve son interface actuelle.

## Parcours

- **Conversations** est l’accueil : une boîte de réception regroupe les SMS et les appels par interlocuteur, pour la ligne sélectionnée. Un appel sans SMS crée aussi une entrée dans cette vue.
- Un fil mélange les messages et appels par date. Les filtres Tout, SMS et Appels permettent de retrouver un échange. Les filtres de la boîte de réception proposent Toutes, Non lues (SMS) et Manqués (appels entrants).
- Le nom, le numéro, les ressources et l’ajout au répertoire se trouvent dans un panneau de détails ouvert à la demande.
- Nouvelle conversation accepte un contact ou un numéro. Le clavier téléphonique s’ouvre depuis Nouvel appel ou depuis un interlocuteur. Un appel en cours reste accessible si sa fenêtre est fermée.
- Contacts conserve la recherche, la création, la modification et l’archivage. Les formulaires s’ouvrent dans des fenêtres dédiées.
- Réglages rassemble le compte, les lignes, les appareils et l’état des appels. Le parcours existant d’achat de numéro est conservé.
- Sur téléphone, la liste et le fil sont deux vues successives, avec un bouton de retour et une navigation inférieure.

## Présentation

Fond blanc, navigation gris clair, accent vert, bordures fines, rayons discrets. Police Geist auto-hébergée et icônes Phosphor en graisse légère. Les grands bandeaux, compteurs de tableau de bord, ornements et actions inactives ont été retirés. Les fenêtres utilisent des éléments `dialog` natifs avec focus, fermeture au clavier et retour au déclencheur.

## Données et comportement

`conversation-model.ts` construit une vue unifiée à partir des ressources autorisées de l’API existante. L’identité de présentation associe la ligne au numéro normalisé. L’identifiant de conversation SMS reste distinct et n’est pas inventé pour un fil composé uniquement d’appels. Aucun changement de schéma n’est nécessaire pour cette vue.

Les brouillons restent en mémoire par ligne et destinataire durant la session. Ils sont vidés à la déconnexion et ne sont pas conservés après rechargement. Un SMS au résultat incertain verrouille son destinataire et son contenu ; la reprise conserve la même clé d’idempotence. Les appels entrants utilisent le numéro de l’appelant pour identifier le contact.

Les historiques utilisent la pagination existante. La recherche et les filtres portent sur les conversations chargées ; le bouton de chargement permet de remonter dans l’historique. Les événements temps réel complètent les échanges déjà chargés. Les réponses périmées sont écartées lors des changements de conversation ou de ligne.

## Enregistrements et transcriptions

Ils sont annoncés « À venir » dans les détails de la conversation. Aucune capture audio ni transcription n’est activée par cette refonte. Leur intégration devra ajouter des événements au même fil et une source API autorisée, avec leurs états de disponibilité et leurs liens aux appels.

## Vérification

- `pnpm --filter @onoff/web build` : compilation TypeScript et build Vite réussis.
- `pnpm --filter @onoff/web test` : 7 tests couvrant le regroupement appels/SMS, les fils sans SMS, l’isolation par ligne, l’ordre chronologique, les appels manqués et l’identité des événements.
- 34 contrôles navigateur sur données de test : navigation, filtres, brouillons, premier SMS, changement de ligne, détails, contacts, clavier, accès à l’achat de numéro, reprise idempotente, erreur et récupération des messages, appel entrant, microphone et fermeture d’appel.
- Rendu contrôlé à 1440 px, 390 px et 320 px. Les transports SMS et voix étaient simulés pour ces contrôles ; aucun appel, SMS ou achat réel n’a été effectué.

Captures et scripts de vérification locale : `output/playwright/` (ignoré par Git). L’environnement de vérification utilisait Node 26, alors que le dépôt déclare Node 24 ; les commandes ont terminé avec succès. Vite signale également un bundle principal dépassant son seuil indicatif de 500 kB.

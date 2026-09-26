# Powerdialer web : campagnes CSV et relances

## Parcours

1. Ouvrir **Powerdialer**, puis **Importer CSV** ou **Ajouter des contacts** depuis le répertoire. La liste peut contenir 1 000 numéros uniques ; l’import ne crée pas de fiches dans le répertoire partagé.
2. Dans l’import, vérifier la correspondance téléphone, nom, prénom, entreprise, email et notes. Seul le téléphone est obligatoire. L’aperçu présente les cinq premiers contacts valides et compte séparément les doublons, les lignes invalides et les exclusions. Un rapport CSV des lignes écartées est téléchargeable.
3. Dans **Réglages**, nommer la campagne, définir le rythme, activer les règles de relance et éventuellement ajouter des horaires et un script. Les règles de relance sont désactivées par défaut.
4. Démarrer la session. Un seul appel est lancé à la fois via les intentions d’appel et le transport vocal existants.
5. Prendre des notes et qualifier : **Intéressé**, **À rappeler**, **Pas intéressé**, **Sans réponse**, **Répondeur**, **Occupé**, **Mauvais numéro**, **Ne plus appeler**. Une qualification pendant l’appel raccroche ; la file n’avance qu’après l’événement de fin du transport. Un raccrochage simple attend la qualification.
6. Consulter **Bilan de session** : notes, résultat courant, historique des tentatives, rappels à reporter ou annuler. Export CSV pour exploitation tabulaire ; export JSON pour le contexte complet. **Exporter et vider** télécharge le JSON puis réinitialise la campagne, en conservant les exclusions locales.

## Import CSV

- UTF-8 avec ou sans BOM, virgule, point-virgule ou tabulation, fins de ligne LF/CRLF/CR, cellules entre guillemets, guillemets échappés et notes multilignes. La directive Excel `sep=;` est acceptée.
- 2 Mo, 1 000 lignes de contacts et 100 colonnes maximum ; une cellule trop longue ou des guillemets mal fermés empêchent l’import. Le dépassement de capacité refuse l’ajout entier : aucune troncature silencieuse.
- Option « Première ligne = en-têtes » pour les fichiers sans titres. Reconnaissance des titres usuels français/anglais ; correspondance manuelle si nécessaire. Une colonne ne peut remplir deux champs.
- Les numéros internationaux `+…` et `00…` sont normalisés. L’option France accepte les numéros nationaux `06…`. Le mode international exige un indicatif. Les numéros tronqués ou convertis en notation scientifique par Excel sont signalés, sans reconstruction incertaine.
- Déduplication après normalisation, dans le fichier et contre tous les numéros déjà présents dans la campagne. Un numéro traité reste exclu des ajouts à cette même campagne.
- Nom, entreprise et email limités à 250 caractères par champ ; notes à 5 000. Les champs trop longs sont signalés, pas tronqués à l’import.
- Le fichier modèle contient une ligne de démonstration explicitement à remplacer. Importer prépare la file sans déclencher d’appel.
- Les exports CSV protègent les cellules susceptibles d’être interprétées comme des formules dans un tableur.

## Rythme et relances

Le délai d’enchaînement est de 5 secondes par défaut, réglable de 3 à 120 secondes. Le mode manuel conserve un bouton pour chaque appel. **Appeler maintenant** anticipe uniquement la pause entre deux contacts déjà éligibles ; il ne contourne ni une échéance ni les horaires.

Les relances automatiques ont un plafond de 1 à 10 tentatives **premier appel inclus**. Chaque résultat a son propre délai de 1 minute à 30 jours et peut être désactivé séparément :

| Résultat | Règle proposée lorsque les relances sont activées |
| --- | --- |
| Sans réponse | Après 60 minutes |
| Occupé | Après 15 minutes |
| Répondeur | Désactivée |
| Intéressé / Pas intéressé / Mauvais numéro / Ne plus appeler | Aucune relance |

Le délai court à partir de la fin/qualification de la tentative. Le contact est affiché comme planifié, avec sa date, et ne devient appelable qu’à cette échéance. Les nouveaux contacts passent en premier par défaut ; une option donne la priorité aux relances dues. Au plafond, le contact est clôturé et l’historique reste disponible.

Une erreur de préparation (microphone, ligne indisponible) suspend la session sans consommer une tentative. Un appel réellement terminé exige toujours une qualification explicite ; aucun résultat commercial ni répondeur n’est déduit de la durée ou du SDK.

Une modification de délai concerne les prochaines qualifications, sans déplacer les échéances déjà enregistrées. Désactiver les relances, une règle ou abaisser le plafond annule les relances automatiques devenues inéligibles. Les rappels explicitement demandés sont conservés.

## Rappels demandés et horaires

**À rappeler** ouvre un choix de date et heure futures, dans le fuseau du navigateur. La planification met la campagne en pause. Les rappels demandés passent avant les nouveaux contacts et les relances dès qu’ils sont dus ; ils sont indépendants du plafond des relances automatiques. Ils peuvent être reportés ou annulés dans le bilan.

Les horaires optionnels définissent des jours, une plage quotidienne et un fuseau IANA, communs à toute la campagne. L’heure de début est incluse, celle de fin exclue. Les changements d’heure sont pris en compte. Une plage traversant minuit n’est pas acceptée. Les contrôles s’appliquent aussi aux rappels et sont revérifiés pendant la préparation d’un appel. Une conversation en cours peut se poursuivre après la fin de la plage.

**Quand plus aucun contact n’est immédiatement appelable, la session se met en attente et exige une reprise explicite.** Une échéance rend le contact disponible mais ne réactive jamais à elle seule une session en pause. Pendant une session continue, le prochain contact dû est sélectionné après qualification de l’appel en cours.

Il n’y a pas de tâche de fond, de notification ni d’appel lorsque la campagne est fermée. Les rappels sont des éléments de la file locale, pas des événements de calendrier ni des appels programmés côté serveur.

## Conservation et protections

La campagne (file, réglages, notes, échéances et tentatives) est sauvegardée dans le stockage du navigateur, sous une clé distincte pour chaque **utilisateur / organisation / ligne**. Elle survit au rechargement, à la fermeture et au changement de contexte sur ce même navigateur. Elle n’est pas synchronisée avec un autre appareil ou un autre agent et disparaît si le stockage du navigateur est effacé. Les appels eux-mêmes continuent à être historisés par le système existant.

- Un verrou Web Locks exclusif empêche deux onglets d’écrire la même campagne. Le second invite à fermer le premier puis réessayer. HTTPS ou localhost est nécessaire.
- À la restauration, l’enchaînement est toujours arrêté. Un appel interrompu est présenté en qualification obligatoire, sans rappel automatique ni déduction de son résultat.
- Un échec de sauvegarde est affiché ; l’utilisateur peut exporter. Une sauvegarde illisible n’est pas écrasée automatiquement.
- **Ne plus appeler** conserve une exclusion locale pour ce compte, cette organisation et cette ligne, y compris après réinitialisation de la campagne. Elle bloque les prochains imports et ajouts du répertoire dans ce contexte. Ce n’est pas une liste d’opposition partagée entre agents, lignes ou appareils, et elle ne bloque pas les appels ordinaires hors powerdialer.
- Les tentatives conservent leur intention d’appel, début, fin, résultat choisi et notes au moment de la qualification. Les événements tardifs restent associés à la bonne tentative.
- Double clic, préparation en cours et appel déjà actif ne peuvent lancer un deuxième appel.
- Navigation, onglet masqué, appel entrant, déconnexion réseau ou indisponibilité vocale mettent la session en pause. Ouvrir une boîte de dialogue interrompt également l’enchaînement.
- Le contexte utilisateur/organisation/ligne est revérifié pendant la préparation via le parcours vocal existant. Changer de ligne ou d’organisation est bloqué pendant un appel, une qualification et l’enchaînement.
- Une alerte navigateur protège la fermeture pendant un appel, une qualification ou un échec de sauvegarde.

Les raccourcis **1 à 8** qualifient, **Espace** démarre/met en pause et **Échap** suspend. Ils ne capturent ni la saisie dans les champs ni les interactions dans une fenêtre modale. La file et la fiche sont côte à côte sur ordinateur et empilées sur mobile.

## Comparaison du marché

Recherche du 26 septembre 2026, sur les documentations officielles. Il s’agit des fonctionnalités documentées, sans reprise des promesses de performance commerciales.

| Produit | Fonctions observées | Choix pour Onoff |
| --- | --- | --- |
| [Aircall Workspace](https://support.aircall.io/fr-fr/articles/23996034990493) | Liste importée par CSV, saisie ou extension, 1 000 numéros, enchaînement avec pause | Import accessible directement dans le powerdialer, plafond lisible, enchaînement/pause existants |
| [JustCall : import CSV](https://help.justcall.io/en/articles/9916769-creating-a-campaign-from-a-csv-file-in-sales-dialer) | Correspondance des colonnes, noms et champs complémentaires, indicatif par défaut, revue avant lancement | Correspondance de six champs, normalisation France/international et aperçu avant ajout |
| [JustCall : priorités](https://help.justcall.io/en/articles/9324024-setting-priorities-for-reattempt-rules-and-new-leads-in-campaigns) | Priorité aux nouveaux prospects ou aux relances | Option explicite dans les règles de campagne |
| [JustCall : rappels](https://help.justcall.io/en/articles/5959137-scheduled-calls-in-sales-dialer-campaigns) | Rappel à date/heure choisies, associé à l’agent et conditionné par une campagne active | Date future, file prioritaire, report/annulation et reprise explicite |
| [JustCall : power dialer](https://justcall.io/product/power-dialer/) | Délais entre appels, plafonds de tentatives et fenêtres horaires | Réglages séparés pour rythme, tentatives et horaires |
| [CloudTalk : campagnes](https://help.cloudtalk.io/en/articles/5782017-using-campaigns-with-power-dialer) | Fiche contact, scripts, qualifications, démarrer/mettre en pause/arrêter | Script optionnel dans la fiche, huit qualifications et bilan par tentative |

CloudTalk indique que son ancien Power Dialer n’est plus enrichi et oriente vers son AI Sales Dialer. La comparaison retient ici le parcours séquentiel d’un commercial disponible, cohérent avec le transport actuel d’Onoff.

Les campagnes partagées côté serveur, la synchronisation CRM, les exclusions globales, les notifications de rappel et la détection automatique de répondeur constituent des intégrations supplémentaires. JEV reste hors périmètre : aucune analyse, qualification ou statistique commerciale fictive n’est produite.

## Vérification

La suite web couvre le parsing CSV, les formats, limites et erreurs, les exports sûrs, les règles et plafonds, les priorités, les rappels, les horaires/fuseaux/changements d’heure, les exclusions, la restauration, l’isolation des contextes et les protections du transport existant.

Les contrôles Playwright utilisent une API, un répertoire et un transport vocal simulés. Aucun appel, SMS ou achat réel n’est effectué. Les captures et exports de vérification sont dans `output/playwright/` (ignoré par Git).

Validation locale du 26 septembre 2026 : build web et 60 tests web réussis (35 propres au powerdialer). Parcours navigateur vérifiés : import avec rejets, réglages, relance au plafond, rappel daté, exclusion après réinitialisation, export CSV/JSON, restauration au repos et après appel interrompu, blocage d’un deuxième verrou, horaires fermés et récupération d’un CSV d’une ligne sans en-têtes. Aucun débordement horizontal dans l’import à 1 440, 390 et 320 px, ni dans les réglages à 320 px. Environnement Node 26 ; le dépôt cible Node 24. Vite conserve son avertissement sur la taille du bundle principal.

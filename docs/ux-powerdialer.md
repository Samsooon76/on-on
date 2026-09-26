# Powerdialer web

## Objectif

Permettre à un commercial d’enchaîner une liste de contacts sans ouvrir un clavier ni une fiche après chaque appel. L’interface reprend le répertoire, la ligne active et le client vocal existants.

## Parcours livré

1. Ouvrir **Powerdialer**, puis sélectionner des contacts. La recherche et la pagination interrogent le répertoire autorisé de l’organisation. La sélection persiste entre les recherches ; « Toute la liste affichée » sélectionne uniquement les résultats chargés. Les numéros invalides sont exclus et les doublons de numéro sont supprimés. Plusieurs numéros d’un contact sont proposés séparément.
2. Démarrer la session. Le microphone est demandé par le parcours vocal existant. Un seul appel est lancé à la fois.
3. Consulter le dernier appel chargé et écrire des notes sur la même fiche. Microphone et clavier DTMF restent accessibles.
4. Choisir **Intéressé**, **À rappeler**, **Pas intéressé**, **Sans réponse** ou **Répondeur**. Pendant l’appel, ce clic retient le résultat et raccroche. Le prochain contact n’est préparé qu’après l’événement de fin du transport vocal. Après un raccrochage simple, le résultat reste à choisir.
5. Le prochain appel part après cinq secondes par défaut. Délai réglable à 3, 5, 10 ou 15 secondes ; **Appeler maintenant** permet de l’anticiper. **Pause** interrompt l’enchaînement sans couper une conversation. Le mode manuel conserve un bouton pour chaque appel suivant.
6. Le bilan regroupe résultats et notes. Son export JSON contient le contexte utilisateur/organisation/ligne, le contact, le numéro, l’intention d’appel, les dates de tentative et de fin, les notes et la source manuelle de qualification. « Exporter et vider la file » termine la session locale.

**À rappeler est un résultat, pas un rappel programmé.** L’utilisateur peut préciser une échéance dans ses notes. Aucun rendez-vous ni notification n’est créé.

## Réduction des interactions

- Après le démarrage : un résultat = un clic pour raccrocher et enchaîner.
- Touches **1 à 5** : résultats dans l’ordre affiché.
- **Espace** : démarrage ou pause ; **Échap** : pause.
- Les raccourcis ne capturent pas la saisie dans les champs ni les interactions dans une fenêtre modale. Espace conserve son comportement natif lorsqu’un bouton a le focus.
- Les notes sont conservées au fil de la saisie dans la session : aucun bouton Enregistrer.
- La file et la fiche sont côte à côte sur ordinateur ; sur petit écran, la file devient horizontale et les commandes restent accessibles en bas.

## Arrêts et cas particuliers

- Double clic, préparation en cours et appel déjà actif ne peuvent lancer un deuxième appel.
- Changement d’écran, onglet masqué, appel entrant, déconnexion réseau ou indisponibilité vocale mettent la session en pause. Le retour à l’écran ne relance jamais un appel automatiquement.
- Un appel entrant pendant la préparation empêche le lancement sortant. Les événements de fin d’un appel ordinaire ou entrant ne qualifient pas un contact du powerdialer.
- Pendant les attentes asynchrones de préparation, le contexte utilisateur/organisation/ligne et l’autorisation de poursuivre sont revérifiés avant de démarrer le transport.
- Le changement de ligne et d’organisation est désactivé pendant un appel, une qualification en attente et l’enchaînement automatique.
- Une erreur de préparation conserve le contact courant pour une reprise explicite. Une erreur du transport suspend l’enchaînement.
- « Ignorer » passe un contact sans créer d’appel ni de résultat. Un numéro traité reste exclu des ajouts à la même session.
- Aucun résultat commercial ni appel argumenté n’est déduit de la durée ou de l’état `active` du SDK.

## Périmètre et conservation

Le lancement des appels réutilise l’API des intentions et le client vocal existants. Cette livraison n’ajoute pas de route de qualification ni de table serveur.

**La file, les notes et les résultats restent en mémoire dans cet espace, pour cet utilisateur, cette organisation et cette ligne.** Ils sont conservés lors de la navigation entre écrans, mais perdus au rechargement, à la déconnexion ou au changement de contexte. Un avertissement navigateur protège le rechargement/la fermeture lorsqu’une tentative ou une note existe ; l’export permet de conserver le bilan. Ce périmètre est affiché dans l’interface. Les appels eux-mêmes continuent à être historisés par le système existant.

Le chronomètre mesure le temps écoulé depuis le lancement, sonnerie et préparation comprises. L’historique affiché porte sur les appels déjà chargés.

## Suite : JEV et persistance partagée

JEV est annoncé « À venir ». Aucun enregistrement, transfert audio, tag automatique ou score fictif n’est activé.

L’intégration devra :

- Persister les sessions, les tentatives et les qualifications avec les autorisations de ligne ; relier chaque `intentId` à l’appel serveur effectivement créé.
- Conserver séparément le **résultat choisi par le commercial**, les **call tags** multiples et la **détection d’appel argumenté**. Un appel argumenté n’implique pas forcément un prospect intéressé.
- Recevoir l’analyse JEV de façon asynchrone sans bloquer l’appel suivant. Prévoir les états en attente, en cours, disponible et indisponible.
- Associer chaque suggestion à son appel, avec sa source, sa version et ses éléments justificatifs. Une analyse arrivée tardivement ne doit jamais modifier la fiche de l’appel courant ni écraser une correction manuelle.
- Permettre de corriger une suggestion dans le bilan et dans la conversation. La qualification manuelle reste utilisable lorsque JEV est indisponible.
- Définir le vocabulaire de tags et les critères d’un appel argumenté avec l’équipe commerciale avant de calculer des indicateurs.
- Ajouter ensuite rappels planifiés, imports de listes et reprise d’une session sur un autre appareil.

## Vérification

Tests unitaires : dédoublonnage, ordre et transitions de file, résultat en un clic, attente de fin effective, pause, erreurs, absence de qualification implicite, événements répétés, intention résolue après une fin rapide et protection du contact actif.

Les contrôles navigateur utilisent un répertoire et un transport vocal simulés. Aucun appel, SMS ou achat réel n’est nécessaire pour les exécuter. Les scénarios et captures locales sont dans `output/playwright/` (ignoré par Git).

Validation locale du 26 septembre 2026 : build web et 19 tests web réussis (dont 12 propres au powerdialer). 33 contrôles navigateur réussis couvrent le parcours, les erreurs, un appel entrant pendant la préparation, l’export, le mode manuel et les formats 1366 × 820, 390 et 320 px. Les captures de démonstration utilisent uniquement des données simulées. L’environnement utilise Node 26 alors que le dépôt cible Node 24 ; Vite conserve son avertissement sur la taille du bundle principal.

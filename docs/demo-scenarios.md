# Scénarios de démonstration

## Connexion et droits

1. Se connecter avec un compte de démonstration précréé.
2. Choisir l'organisation et la ligne attribuée.
3. Vérifier que le compte ne voit ni les contacts d'une autre organisation ni une ligne sans affectation.

## Appel

1. Saisir un numéro autorisé et vérifier le numéro appelant affiché.
2. Démarrer, répondre, couper/rétablir le micro, envoyer un DTMF et raccrocher.
3. Retrouver une seule ligne d'historique avec sens, durée et résultat.
4. En entrant, faire sonner plusieurs appareils; répondre sur l'un et vérifier que les autres cessent de sonner.

## Contact et SMS

1. Créer un contact et un numéro normalisé sur le web.
2. Ouvrir la même fiche depuis un second appareil.
3. Envoyer un SMS contrôlé, recevoir une réponse et vérifier les états disponibles.
4. Confirmer qu'un timeout ambigu n'est pas suivi d'un nouvel envoi automatique.

## Reconnexion

1. Déconnecter un client ou fermer l'onglet.
2. Créer une activité depuis un autre client.
3. Revenir en ligne et vérifier que le client relit l'état complet depuis l'API.

## Refus d'accès

1. Se connecter avec un compte membre et confirmer l'organisation et les lignes affichées.
2. Avec une requête portant un autre identifiant d'organisation ou de ligne, vérifier que l'API/RLS renvoie un refus ou une ressource absente sans contenu privé.
3. Révoquer l'appareil depuis les réglages; vérifier que ses nouvelles opérations sont refusées et qu'il n'est plus inclus dans le routage futur.

Ces scénarios décrivent le comportement attendu. Ils ne constituent pas une preuve d'essai réel tant que des comptes de test isolés et les appareils ne sont pas configurés.

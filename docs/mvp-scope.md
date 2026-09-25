# Périmètre de démonstration

## Cible

Prototype privé pour cinq testeurs au maximum, deux organisations de démonstration, une ligne compatible voix/SMS pour les essais, et quatre appareils qui peuvent sonner par appel. Une seule conversation vocale active est autorisée par utilisateur. Ces plafonds sont des valeurs initiales prudentes et restent configurables côté serveur.

Le premier livrable vise le web. Les expériences iOS et Android doivent être validées sur appareil réel avant d'annoncer ces plateformes. Windows, macOS et l'extension Chrome viennent après le MVP web/mobile.

## Parcours

- Connexion par email et mot de passe avec un compte créé/invité par un administrateur.
- Choix de l'organisation et d'une ligne explicitement affectée.
- Appel sortant vers un numéro de test autorisé, puis historique persistant.
- Appel entrant routé aux appareils actifs; le premier appareil qui répond gagne.
- Contact partagé dans l'organisation et conversation SMS liée à une ligne.
- Actualisation après reconnexion depuis le serveur; Realtime accélère les mises à jour mais n'est pas la source de vérité.
- Refus systématique d'un utilisateur d'une autre organisation ou sans affectation de ligne.

## Scénarios et état « disponible »

Les étapes de démonstration sont détaillées dans [demo-scenarios.md](demo-scenarios.md). Le périmètre initial reste limité à cinq testeurs, deux organisations, une ligne compatible voix/SMS et quatre appareils en sonnerie au maximum.

Un appareil est candidat au routage quand il est associé à un membre actif, affecté à la ligne, non révoqué et enregistré auprès du SDK vocal. Une présence Realtime ou un heartbeat seul ne garantit pas qu'un système d'exploitation acceptera de réveiller l'application. Pour le web, la présence expire après 90 secondes sans renouvellement; pour le mobile, les appels en arrière-plan dépendent aussi des credentials push natifs valides.

## Limites sûres de départ

- Appels de démonstration plafonnés à 15 minutes; aucune redial automatique après un résultat fournisseur incertain.
- SMS sortants plafonnés à 20 par ligne et par période glissante de 24 heures par défaut, vers les destinations autorisées uniquement; l'organisation peut ajuster cette limite jusqu'à 100.
- Jusqu'à quatre appareils actifs en sonnerie par ligne.
- Voix et SMS sont désactivés par défaut et peuvent être coupés indépendamment.
- Enregistrements désactivés. Pas de portabilité, appels d'urgence, transfert en cours, file d'attente, CRM, inscription publique ni audio dans l'extension.
- Hors ligne : lecture du cache déjà chargé seulement; aucune action d'appel/SMS mise en attente.
- Une application arrêtée de force ou sans push valide n'est pas considérée joignable.

## Budget et responsabilités

Le plafond global convenu pour les premiers essais réels est de **10 €**. La France est le premier pays cible et un mobile de test a été communiqué et autorisé par le propriétaire. Son numéro complet reste dans les secrets de l'environnement API (`SMS_ALLOWED_RECIPIENTS`) et dans la configuration Twilio, jamais dans le dépôt. Le propriétaire du compte surveille la consommation, vérifie les destinations dans la Console et configure les alertes avant l'activation.

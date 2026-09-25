# Matrice des plateformes

Mise à jour le 2026-09-25. « Build généré » confirme seulement que la chaîne locale a produit un artefact; « recette réelle » exige une installation et un parcours sur le système/appareil indiqué. Cette matrice ne déclare aucune plateforme prête à la distribution.

| Cible | Build / préparation constaté | Installation et parcours réels | État de support |
|---|---|---|---|
| Web, navigateur moderne | Build Vite et serveur statique passés; routes de santé et chargement SPA vérifiés | Connexion avec un utilisateur réel, audio WebRTC bidirectionnel et SMS Twilio non exécutés | Prototype compilé; non validé en recette téléphonique |
| iOS | Expo export Hermes et projet natif générés avec le plugin Twilio | Non testé sur simulateur ou iPhone; Xcode complet, signature, APNs/PushKit et credentials de push absents | Non supporté pour distribution à ce stade |
| Android | Expo export Hermes et projet natif générés avec le plugin Twilio | Non testé sur émulateur ou téléphone; SDK Android, JDK récent, signature et FCM absents | Non supporté pour distribution à ce stade |
| macOS desktop | Aucun client desktop dans le dépôt | Non testé | Non implémenté |
| Windows desktop | Aucun client desktop dans le dépôt | Non testé | Non implémenté |
| Chrome extension | Aucun client extension dans le dépôt | Non testé | Non implémentée |

## Règle de mise à jour

Après chaque recette, ajouter système/version, modèle/appareil, réseau, versions d'application et API, parcours exécuté, résultat et anomalie. Ne pas inscrire de numéros personnels, secret, token ou corps SMS. Une cible ne passe à « validée » qu'après les parcours et critères correspondants de [la recette du plan](../../PLAN_IMPLEMENTATION.md#recette), y compris les essais vocaux réels lorsque la plateforme annonce les appels.

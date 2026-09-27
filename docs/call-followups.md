# Créer depuis un appel

Le composeur web propose un bouton **+ Créer** pendant un appel entrant ou sortant et sur l’écran **Après l’appel**. L’extension Chrome ouvre ce même composeur via `callTo`, sans nouvelle permission Chrome.

- **Ticket** : titre, description et priorité.
- **Deal** : titre, notes et montant estimé facultatif en euros.
- **Contact** : nom et email facultatif, avec le numéro de l’appel prérempli.

Le formulaire reste ouvert quand l’appel se termine. Les commandes de micro et de raccrochage restent disponibles pendant la saisie. Une erreur conserve les champs pour réessayer. Un contact déjà associé au numéro empêche la création d’un doublon depuis ce bouton.

Le Powerdialer propose les mêmes actions pendant l’appel et sa qualification. Il reprend les notes saisies dans le formulaire du ticket ou du deal. Ouvrir la création met l’enchaînement automatique en pause et désactive les raccourcis de qualification jusqu’à la fermeture du formulaire.

## Enregistrement et accès

Les tickets et deals sont enregistrés dans `call_followups` et accessibles dans **Tickets & deals**. Un ticket peut être ouvert ou résolu ; un deal peut être en cours, gagné ou perdu.

Chaque suivi référence l’appel d’origine et, lorsqu’il est reconnu, le contact partagé. Le numéro provient de l’appel enregistré côté serveur. Les contacts créés utilisent le carnet partagé existant et sont reconnus par leur numéro.

L’API résout l’appel à partir de son identifiant, du SID fournisseur ou de l’intention d’appel sortant. Elle vérifie ensuite les droits sur cet appel avec le client utilisateur. Si l’appel est encore en cours de synchronisation, le formulaire affiche une erreur permettant de réessayer. Les écritures et lectures sont protégées par RLS : seules les personnes ayant accès à la ligne vocale de l’appel y ont accès. Les clés étrangères empêchent les associations entre organisations.

Un identifiant de formulaire stable évite de créer deux tickets ou deals quand une réponse réseau est perdue. Les créations de contacts revérifient le numéro avant chaque tentative.

## Déploiement

1. Appliquer la migration `20260927074002_call_followups.sql` à l’environnement cible.
2. Compiler et déployer l’API et la webapp avec les nouveaux contrats.
3. Vérifier un appel web et un appel ouvert depuis l’extension, puis les trois actions avant/après raccrochage.

L’extension existante reste compatible. Cette version enregistre les suivis dans Onoff ; elle n’ajoute pas de connecteur CRM externe.

## Vérification locale

- Tests API : `node --test apps/api/test/call-followups.test.js` après compilation de l’API.
- Tests PostgreSQL : `node scripts/test-admin-database.mjs call_followups.test.sql`.
- Parcours navigateur vérifiés avec appels et API simulés : commandes d’appel, saisie conservée au raccrochage, erreur/réessai, contact prérempli, création des deux suivis, changement de statut et pause du Powerdialer.

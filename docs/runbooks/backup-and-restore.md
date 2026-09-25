# Runbook — Sauvegarde et restauration Supabase

Ce dépôt cible le projet Supabase hébergé `onoffv2`. Ce runbook ne démarre ni ne restaure de Supabase local. Une restauration en place interrompt l'accès au projet pendant l'opération; toute répétition doit d'abord se faire dans un projet distinct, avec les coûts et la copie de données approuvés.

## Avant un changement important

1. Ouvrir **Database → Backups** dans le projet hébergé et vérifier la disponibilité, la date et le type de la dernière sauvegarde pour le plan actuel.
2. Vérifier séparément les objets Supabase Storage et toute configuration hors base. Une sauvegarde PostgreSQL ne contient pas les fichiers d'objets.
3. Pour une protection avec une granularité inférieure au jour, lire les options PITR et leur coût courant dans le tableau de bord avant activation; le PITR change aussi la manière de télécharger les sauvegardes.
4. Consigner l'heure cible, l'impact accepté et le responsable de la reprise dans le ticket d'exploitation. Ne pas placer de mot de passe ou de clé dans les notes.

## Retour arrière applicatif et migrations

Les migrations de ce dépôt sont traitées comme **forward-only** : aucune migration inverse automatique n'est fournie. Elles ajoutent des tables/colonnes/index, remplacent des fonctions et déclencheurs, ajustent les permissions et peuvent modifier des échéances ou créer des tâches à partir des lignes existantes. Par exemple, le remplacement d'une signature de fonction suivi du `DROP FUNCTION` de l'ancienne signature, l'ajout des échéances de réconciliation et la mise à jour de l'expiration des clés SMS ne sont pas annulés en redéployant uniquement une ancienne API.

Avant chaque migration distante : vérifier son SQL, l'état des sauvegardes disponibles, la compatibilité avec la version applicative actuellement déployée et le plan de reprise. Préférer une séquence expand/migrate/contract : ajouter d'abord les champs compatibles, déployer le code qui tolère l'ancien et le nouveau schéma, migrer les données si besoin, puis ne retirer une structure qu'après la fin de la période de compatibilité. Si une migration ou son backfill a un effet métier irréversible, prendre une sauvegarde/export approprié avant exécution et écrire une procédure de correction ou de restauration spécifique. En incident, arrêter les nouvelles créations, diagnostiquer puis appliquer une migration corrective en avant; ne pas restaurer ou supprimer des données de production pour faire correspondre une version applicative ancienne sans décision explicite du propriétaire.

## Répéter une restauration

1. Choisir **Restore to a New Project** depuis la sauvegarde source et demander un projet distinct dans la même région. Cette fonction est disponible selon le plan et le mode de sauvegarde en vigueur.
2. Ne pas donner au projet restauré les origines publiques ou les credentials Twilio de production. Une copie contient des données Auth et métier; limiter les administrateurs et la durée de vie.
3. Reconfigurer manuellement les éléments qui ne viennent pas avec une copie de base : Auth et clés API, paramètres Realtime, Storage et fichiers, fonctions Edge et autres réglages de plateforme.
4. Comparer schéma, historique de migration, nombre de lignes par table et échantillons de santé autorisés. N'exposer aucun contenu de SMS dans le rapport.
5. Supprimer la copie temporaire uniquement après validation de l'essai et selon la politique de rétention du projet.

## Incident de perte ou corruption

1. Désactiver les créations d'appels/SMS avec les coupe-circuits API et conserver les logs corrélés.
2. Estimer la fenêtre de perte et vérifier le dernier point réellement restaurable dans le tableau de bord.
3. Restaurer d'abord vers un projet distinct, comparer les données et tester les accès avant toute décision sur l'environnement actif.
4. Une restauration en place doit être planifiée avec le propriétaire du service : elle rend le projet inaccessible pendant le processus et peut perdre les transactions postérieures au point sélectionné.
5. Après restauration, vérifier ou renouveler les mots de passe des rôles personnalisés, confirmer Auth/Realtime/Storage et effectuer un smoke test sans appel/SMS payant.

Les fonctionnalités et limites de sauvegarde dépendent du plan Supabase. Voir [Database Backups](https://supabase.com/docs/guides/platform/backups) et [Restore to a new project](https://supabase.com/docs/guides/platform/clone-project) pour la procédure et les éléments à reconfigurer.

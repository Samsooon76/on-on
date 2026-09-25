# Rotation des secrets

Ne réutilisez pas une valeur qui a été publiée dans un ancien plan, une capture ou un journal. Les anciens identifiants Twilio mentionnés dans la première version du plan doivent être révoqués dans la Console Twilio par le propriétaire du compte.

## Procédure

1. Créer un credential de remplacement dans le fournisseur pour le même environnement et limiter ses permissions aux opérations nécessaires.
2. Mettre à jour le gestionnaire de secrets du service API ou worker concerné; ne pas inscrire la valeur dans un fichier versionné, une variable `VITE_*` ou `EXPO_PUBLIC_*`.
3. Redémarrer/déployer le service, vérifier sa santé, puis valider les webhooks avec une requête synthétique signée.
4. Pour Supabase, régénérer la clé côté projet hébergé `onoffv2`, mettre à jour chaque service serveur et ne révoquer l'ancienne qu'après confirmation de reprise. Ne jamais injecter la clé secrète dans Web ou mobile.
5. Pour APNs/FCM, remplacer le credential Twilio associé à l'environnement de push concerné puis vérifier l'inscription d'un appareil avant de retirer l'ancien.
6. Révoquer l'ancienne valeur, chercher son empreinte/nom de variable dans les journaux accessibles et consigner le résultat.

## Journal de changement sans secret

Noter uniquement : date UTC, fournisseur, environnement, nom de variable ou SID public, responsable, services mis à jour, date de révocation et résultat de la vérification. Ne pas noter le secret, un token, un corps de webhook, un numéro complet ou un fichier de credential.

Une rotation réelle nécessite l'accès du propriétaire aux consoles Twilio, Supabase, Apple/Firebase et à l'hébergeur. Les étapes ci-dessus sont la procédure; elles ne prétendent pas que ces credentials sont actuellement rotatés.

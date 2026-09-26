# AI call tag

## Fonctionnement

Dans **Réglages → AI call tag**, un administrateur crée les tags partagés : nom, couleur, prompt et activation IA individuelle. L’interrupteur global active ou désactive la catégorisation automatique des appels. L’IA est désactivée par défaut. Le seuil initial est de 85 %, réglable entre 50 et 99 %.

À la fin d’une transcription, le serveur envoie à **Jev de TypeSafe AI** :

1. La transcription complète, avec les interventions de chaque interlocuteur.
2. La liste des tags dont l’IA est activée, avec leur nom et leur prompt.
3. Une option « aucun tag » lorsque les informations ne correspondent pas aux critères.

Jev sélectionne au maximum un tag IA. L’application exige que sa confiance et la probabilité du tag choisi atteignent le seuil. Les tags manuels peuvent être multiples. Les contacts ne sont pas analysés.

Ouvrir **Tags et transcription** dans l’historique d’un appel pour voir le résultat, ajouter ou retirer un tag, ou relancer l’analyse. La transcription est démarrée explicitement pendant l’appel, selon le fonctionnement existant. Sans transcription terminée, seuls les tags manuels sont disponibles.

Les corrections manuelles priment : retirer un tag crée une exclusion conservée lors des analyses suivantes ; le réattribuer manuellement annule cette exclusion. Une nouvelle analyse remplace les anciennes attributions IA, en préservant les choix manuels. Désactiver l’IA conserve les tags existants. Les modifications de règles ne relancent pas automatiquement tout l’historique.

## Plateformes

- **Web et iOS** : mêmes réglages, prompts et attributions, stockés dans l’API commune.
- **Chrome** : « Gérer les tags et l’IA » ouvre les réglages dans l’application connectée. Les appels lancés depuis Chrome utilisent la même analyse. L’extension conserve son fonctionnement click-to-call sans stocker de session API ni de clé fournisseur.

## Fournisseur

L’API utilise `POST https://api.typesafe.ai/v1/systemone` avec `state`, `model` et une question `choice`. Chaque tag et son prompt constituent un critère de cette question. La version `jev-1.13.0` est épinglée ; `TYPESAFE_MODEL` permet de la changer explicitement.

Sources officielles : [API et questions Choice](https://docs.typesafe.ai/api), [modèles et langues](https://docs.typesafe.ai/models), [confiance](https://docs.typesafe.ai/confidence). Évaluer les prompts sur des conversations françaises représentatives avant une utilisation importante.

## Configuration serveur

- Appliquer la migration `call_tags` après les migrations de transcription existantes.
- Définir `TYPESAFE_API_KEY` uniquement dans les secrets de l’API serveur. La clé ne doit jamais être dans un bundle web, iOS ou Chrome. `TYPESAFE_MODEL=jev-1.13.0` est la valeur par défaut.
- Déployer l’API et les clients. Pour Chrome, reconstruire/recharger `apps/extension/.output/chrome-mv3`.
- Créer les tags et leurs prompts, puis activer **AI call tag** dans les réglages. L’activation autorise l’envoi des transcriptions et des prompts à TypeSafe AI.

Sans clé fournisseur, l’interface permet les tags manuels et la préparation des prompts. Elle refuse d’activer l’IA et permet toujours de la désactiver.

## Fiabilité et accès

La file persistante est traitée toutes les cinq secondes avec une réservation exclusive de 60 secondes. Les erreurs sont reprises après 30 puis 60 secondes, avec au maximum trois tentatives fournisseur par travail. Une réservation abandonnée peut être reprise après redémarrage. La pause d’exploitation bloque les nouvelles analyses et le traitement de la file.

Les réponses invalides, les tags inconnus et les distributions incohérentes sont refusés. Les requêtes dépassant 100 Ko sont rejetées sans couper la transcription. Le timeout fournisseur est de 12 secondes. La relance explicite est limitée à dix demandes par minute et par utilisateur.

Avant l’application du résultat, le serveur vérifie la révision du catalogue, l’activation et la réservation. Changer un prompt, désactiver l’IA ou modifier la transcription pendant une analyse invalide son résultat. Les attributions suivent les droits de ligne vocale. Seul le serveur écrit les données ; les modifications du catalogue exigent le rôle administrateur.

## API

Toutes les routes nécessitent une session utilisateur et respectent les droits de l’espace et de la ligne.

| Route | Usage |
| --- | --- |
| `GET /v1/organizations/:id/tags` | Catalogue, réglages et disponibilité fournisseur |
| `POST /v1/organizations/:id/tags` | Créer un tag (admin) |
| `PUT /v1/tags/:id` | Modifier un tag (admin) |
| `DELETE /v1/tags/:id` | Supprimer un tag et ses attributions (admin) |
| `PUT /v1/organizations/:id/tag-settings` | Régler `callsEnabled` et `confidenceThreshold` (admin) |
| `GET /v1/tagging/call/:id` | Attributions et état d’analyse |
| `PUT /v1/tagging/call/:id/tags/:tagId` | Ajouter ou retirer un tag, `{ assigned: boolean }` |
| `POST /v1/tagging/call/:id/classify` | Mettre une analyse en file (202) |

Le champ `kind` d’un tag est toujours `call`. Les payloads sont validés dans `packages/contracts/src/tags.ts`. Les nouveaux types de tables restent isolés côté serveur, comme les transcriptions, jusqu’à la prochaine régénération des types Supabase.

# Extension Chrome click-to-call

L'extension sert uniquement à préparer un appel dans l'application web authentifiée. Elle ne lit pas les pages en arrière-plan, ne consulte pas le carnet de contacts et ne contient ni session Supabase ni secret Twilio.

## Développement

1. Depuis la racine, lancer `pnpm --filter @onoff/extension dev`.
2. Ouvrir `chrome://extensions`, activer le mode développeur et charger `apps/extension/.output/chrome-mv3-dev`.
3. Ouvrir l'application web (par exemple `http://localhost:5173`) et cliquer l'icône Onoff.
4. Dans les réglages de l'extension, saisir l'URL de l'application. HTTPS est requis hors développement; HTTP n'est autorisé que pour localhost.
5. Sélectionner un numéro dans une page, ouvrir le popup et choisir « Récupérer la sélection ». Si la page restreint l'injection, saisir le numéro manuellement.
6. Vérifier le numéro puis ouvrir le composeur. L'application retire le paramètre de brouillon de l'URL après l'avoir lu. Sans session, l'utilisateur se connecte normalement; il choisit sa ligne et déclenche l'appel dans l'application.

## Permissions et données

Le manifeste MV3 ne demande que `activeTab`, `scripting` et `storage`. Le script ponctuel lit seulement le texte sélectionné après l'ouverture volontaire du popup; il ne lit ni le DOM complet, ni l'URL, ni le titre de la page. Seul le numéro validé est conservé dans le stockage local de l'extension et passé au composeur comme brouillon non fiable. L'application revalide ce brouillon, trouve éventuellement son contact dans les données de l'organisation authentifiée, et repasse par l'intention d'appel habituelle.

Pour produire les fichiers à charger : `pnpm --filter @onoff/extension build`. Pour générer une archive Chrome : `pnpm --filter @onoff/extension zip`.

Les tests unitaires et le build valident la normalisation et les URLs. L'installation réelle dans Chrome, les pages à injection restreinte, la connexion après expiration et le clic d'appel réel restent à vérifier sur un navigateur configuré avec une URL d'API accessible.

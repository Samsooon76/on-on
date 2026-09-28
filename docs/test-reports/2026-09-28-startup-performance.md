# Chargement web et mobile — 28 septembre 2026

## Causes observées

- Le démarrage appelait `refreshWorkspace`, puis les effets sur l’organisation et la ligne choisies relançaient ce même chargement. Chaque appel incrémentait aussi le compteur de requêtes, ce qui pouvait écarter une réponse utile déjà en cours.
- La vérification des SMS en attente commençait après le chargement de l’historique.
- Le web importait au démarrage les écrans d’administration, de statistiques, de réglages et d’IVR.
- Le serveur web déployé renvoyait le JavaScript sans compression, même avec `Accept-Encoding: br, gzip`.

## Modifications

- Une sélection automatique déjà prise en charge par `refreshWorkspace` ne déclenche plus de nouveau chargement, sur web et mobile. Les changements manuels et les actualisations restent possibles.
- Les SMS en attente sont recherchés en parallèle des organisations. Lorsqu’un SMS est trouvé, sa ligne est chargée directement. Une erreur de vérification conserve le blocage des envois et laisse charger les autres données.
- Les écrans secondaires web sont chargés à leur ouverture. Le statut des files est séparé de l’éditeur IVR pour pouvoir rester actif sans charger cet éditeur.
- Le build produit des fichiers Brotli et gzip. Le serveur respecte les encodages acceptés et conserve le cache immuable des assets, ainsi que le fallback SPA.
- Les autorisations CORS peuvent être réutilisées dix minutes par le navigateur. L’authentification de chaque requête reste inchangée.
- La liste initiale des contacts web n’attend plus le délai de 200 ms réservé à la recherche saisie.

## Mesures

| Mesure | Avant | Après, build local |
|---|---:|---:|
| JavaScript initial, hors SDK vocal différé | 989 194 octets transférés, sans compression | 184 951 octets Brotli, total des deux fichiers initiaux |
| JavaScript initial non compressé | 989 194 octets | 806 204 octets |

La baisse du transfert JavaScript initial est d’environ 81 %. Elle ne représente pas une baisse équivalente du temps de chargement complet : les polices, les styles, les requêtes authentifiées et le réseau interviennent aussi.

Deux sondes publiques ponctuelles ont donné environ 0,43 s pour le HTML web et 0,25 s pour `/health/live`. Elles ne mesurent ni un percentile ni le chargement de données authentifiées.

## Vérifications

- Build web et TypeScript mobile : réussis.
- Tests web : 67 réussis, dont négociation Brotli/gzip, refus `q=0`, HEAD, cache, fallback SPA, asset manquant et protection des chemins.
- Tests mobile : 25 réussis lors du contrôle.
- Tests API ciblés : 22 réussis, dont cache des prévols limité aux origines autorisées et maintien du refus sans authentification.
- Navigateur local avec session fictive et API simulée : une requête par ressource au démarrage (organisations, services, SMS en attente, lignes, appareils, contacts, appels, conversations), aucune erreur JavaScript.
- Changement vers une ligne sans SMS : une lecture des lignes, une des appareils, une des appels ; aucune lecture SMS interdite. Ouverture des réglages différés vérifiée.
- Reprise d’un SMS sur la seconde ligne : chargement direct de cette ligne, brouillon conservé, aucun chargement de l’historique de la première ligne.
- Échec HTTP 503 de la récupération des SMS : autres données chargées, avertissement et action de reprise conservés.
- Échec du téléchargement du module de réglages : erreur contenue dans la rubrique, application toujours montée et navigation vers les contacts fonctionnelle.

Les contrôles ont tourné avec le Node 26 disponible dans l’environnement, qui signale une différence avec le Node 24 déclaré par le projet. Les essais navigateur utilisent des données simulées ; aucun appel ni SMS réel n’a été émis. Les changements ne sont pas déployés par cette intervention et la nouvelle version native n’a pas été installée sur téléphone.

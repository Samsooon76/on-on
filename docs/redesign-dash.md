# Design Onoff inspiré de `dash`

## Direction

La référence est `dash/index.html` : fond blanc, halo lavande en haut à gauche, navigation discrète, cartes aux bordures fines, boutons sombres et accents vert citron. La structure métier reste propre à Onoff : conversations, appels, campagnes, contacts, administration et intégrations.

La densité reste adaptée à un outil de travail. Les transitions sont courtes et respectent la réduction des animations. Le thème reste clair, comme la référence.

## Organisation

- `packages/design-tokens/index.ts` : palette et rayons communs aux trois clients.
- `packages/design-tokens/theme.css` : variables CSS et police Inter locale pour le web et Chrome.
- `packages/design-tokens/assets` : Inter variable pour le navigateur, quatre graisses statiques pour iOS/Android, licence OFL.
- `apps/web/src/dash-theme.css` : disposition, composants, navigation repliable et adaptation aux petits écrans. Les styles des modules utilisent les couleurs communes.
- `apps/mobile/src/theme.tsx` : dégradés natifs et application des graisses Inter. `ui.tsx` porte les composants partagés par tous les écrans natifs.
- `apps/extension/entrypoints/popup` : popup, configuration, sélection d’un numéro et raccourci vers les tags.

Après une modification de la palette, régénérer les variables CSS :

```sh
pnpm exec tsx packages/design-tokens/generate-css.ts
```

Inter est fourni localement, sans requête vers un service de polices. Les icônes utilisent Phosphor sur le web et Chrome, Ionicons sur mobile.

## Couverture

**Web** : connexion et récupération de mot de passe, navigation, conversations et détails, messages, contacts, clavier et dialogues d’appel, transcription et enregistrement, tickets/deals, Powerdialer, statistiques, administration, parcours IVR, numéros, réglages et intégrations.

**iOS et Android** : connexion, navigation, ligne active, appels récents, conversations, messages, contacts, clavier, feuilles modales, compte, appareils, tags et transcriptions. Les boutons natifs gardent une cible d’au moins 44 points.

**Chrome** : popup, champs, messages de retour, réglages, sélection de numéro et tags. Les liens et les permissions du manifeste sont conservés.

Le nouveau dégradé natif utilise `expo-linear-gradient`. Une reconstruction native est nécessaire pour les installations de développement précédentes. Le verrou CocoaPods est à jour et le build iOS du simulateur a été reconstruit.

## Vérification du 27 septembre 2026

- TypeScript : web, mobile et extension validés.
- Builds de production : web et extension Chrome validés.
- Exports Hermes : iOS et Android validés.
- Build natif iOS : réussi, installé sur le simulateur iPhone 17 Pro, iOS 26.5. Écran de conversations observé avec la police et les dégradés natifs.
- Tests existants : **80 réussis**, dont 60 web, 16 mobile et 4 extension.
- Contrôles Playwright : navigation, repli du menu, conversations, contacts, administration, statistiques, centre d’appels, tickets/deals, six rubriques des réglages et dialogue du clavier.
- Largeurs vérifiées : 320, 390, 768 et 1440 pixels. Le débordement provoqué par un libellé accessible hors du conteneur des tableaux a été corrigé.
- Extension : sélection, adresse de l’application, liens du composeur et des tags vérifiés avec des API Chrome simulées, sans démarrer d’appel.

Les fixtures et captures de contrôle restent dans `output/playwright/`. Elles ne sont pas intégrées à l’application.

### Aperçus locaux

- [Conversations web](../output/playwright/dash-conversation-desktop.png)
- [Statistiques](../output/playwright/dash-statistics-desktop.png)
- [Contacts sur petit écran](../output/playwright/dash-contacts-mobile.png)
- [Clavier à 320 px](../output/playwright/dash-dialer-320.png)
- [Simulateur iPhone](../output/playwright/dash-ios.png)
- [Extension Chrome](../output/playwright/dash-extension.png)

### Limites des vérifications

Aucun appareil ou émulateur Android n’est disponible sur cet hôte. L’export du bundle Android réussit, mais sa validation visuelle native reste à faire sur appareil. La recette ne comprend pas de nouveaux appels ou SMS réels.

L’hôte utilise Node 26 alors que le dépôt demande Node 24. Expo signale un décalage préexistant de `expo-build-properties` (57.0.20 installé, 57.0.22 conseillé), et Vite signale la taille du bundle principal. Ces avertissements n’ont pas empêché les validations ci-dessus.

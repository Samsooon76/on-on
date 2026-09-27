# AI call tag — livraison

Commit : `a11f0f5589883862386ddd966184e1e796282b5d`, poussé sur `main`.

- Web : déploiement Railway `d3233b8d-489b-4a48-9747-c9611a2e9abc` réussi.
- API : déploiement Railway `a81ddfd3-c6f8-4510-8519-32afa5d9f74b` réussi.
- Migration Supabase : `20260926223048_call_tags` appliquée.
- CI GitHub : run `36276720699`, succès.
- Healthchecks web/API : succès.
- Vérification en session connectée : catalogue chargé, formulaire nom/prompt/couleur et activation IA accessibles. Brouillon de test annulé.
- Tests locaux : 238 tests, lint, typecheck, build et tests SQL réussis.
- TypeSafe : test réel synthétique réussi avec Jev 1.13.0.
- Aucun secret TypeSafe dans les bundles web, iOS ou Chrome.
- iOS : export Expo validé, aucune publication App Store.
- Chrome : archive `onoff-ai-call-tag-chrome.zip`, aucune publication Chrome Web Store.

L’IA est désactivée par défaut. La configurer dans Réglages → AI call tag.

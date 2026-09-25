# Décision 003 — Routage des appels entrants

- Date : 2026-09-25
- Statut : accepté pour le prototype; comportement Twilio réel à confirmer
- Une ligne entrante ne sonne que sur les appareils actifs explicitement affectés à la ligne et dont la présence vocale est récente.
- Limite opérationnelle initiale : quatre appareils à la fois, sous la limite fournisseur de dix destinations Client/Number pour un `<Dial>`.
- Twilio sonne les appareils éligibles simultanément. Le premier appareil qui répond gagne; la base verrouille l'appel et empêche qu'un second callback remplace le gagnant. Les autres réservations en préparation sont libérées.
- Le refus sur un seul appareil ne doit pas arrêter les autres sonneries. Le résultat fournisseur, y compris réponse tardive ou absence de réponse, reste la source de l'état persistant.
- L'identité vocale est créée par appareil et la connexion Twilio enfant répondue est liée à son appareil via son identité `client:`.
- Aucun appel réel, refus parallèle ni réponse sur deux appareils n'a été essayé; la décision décrit le comportement visé et l'implémentation serveur, pas une garantie opérateur déjà testée.

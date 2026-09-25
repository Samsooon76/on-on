# Décision 004 — Click-to-call depuis Chrome

- Date : 2026-09-25
- Statut : parcours simple retenu pour le MVP; extension non implémentée
- L'action Chrome transmet uniquement le numéro explicitement sélectionné et l'utilisateur ouvre le composeur de l'application Web.
- Le numéro est encodé comme brouillon non fiable dans une route du composeur. Aucun JWT, clé API, secret Twilio, contenu de page ou carnet de contacts ne quitte le navigateur.
- Si la session Web manque ou expire, l'application demande la connexion puis restaure le brouillon; l'utilisateur choisit une ligne et déclenche explicitement l'appel.
- L'appel passe par la route normale d'intention serveur, ses contrôles d'organisation/ligne, son plafond et ses callbacks. L'extension ne possède pas d'audio ni de jeton d'appel.
- Permissions Chrome limitées au geste actif (par exemple `activeTab`); aucun accès permanent à tous les domaines. Les permissions exactes seront validées avec l'implémentation WXT.
- Une liaison extension → application authentifiée ou protocole desktop n'est pas nécessaire à ce parcours et reste reportée tant qu'un besoin concret ne l'exige.
- Les pages malveillantes peuvent fournir un numéro invalide; l'application revalide et normalise le brouillon avant tout appel. La route de composeur et l'extension restent à construire et à tester.

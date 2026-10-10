# Carnet de dépenses de voyage

Version Cloudflare (Workers + D1) de l'app de dépenses partagées, sans Firebase.

- **Connexion** : compte central Kayto (compte.kayto.org, app `depense`), cookie `kc_depense` sur `*.kayto.org`.
- **Données** : table D1 `trips` (un voyage = un code partagé : voyageurs, dépenses), table `prefs` (dernier code utilisé par compte).
- **Synchro** : l'interface interroge `/api/trips/:code` toutes les 5 s (remplace le temps réel Firestore) et garde une copie locale pour le hors-ligne.
- **API** : `GET /api/me`, `PUT /api/me/code`, `GET|PUT /api/trips/:code`.

## Mise en place
1. Créer la base : `wrangler d1 create depense-db`, mettre son identifiant dans `wrangler.toml`, puis `wrangler d1 execute depense-db --remote --file=schema.sql`.
2. Ajouter l'app `depense` (origine `https://depense.kayto.org`) dans le panel admin de compte.kayto.org.
3. Déployer (Workers Builds sur `main`) et rattacher le domaine `depense.kayto.org`.

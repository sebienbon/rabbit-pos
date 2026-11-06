# Sous-tâches laissées de côté

Tout ce qu'on rencontre en chemin et qu'on met de côté pour plus tard, à reprendre avant la fin du projet.
Une entrée par sujet : où ça se corrige, pourquoi, et ce qu'il faut faire. Cocher `[x]` une fois réglé.

## À faire

### 1. [ ] Rapprochement des cartes faux dans Rabbit-System
- **Où :** Rabbit-System (dépôt `sebienbon/Rabbit-System`, `dev/server/30.UI_api.gs`, opération `card_settlement`) — à confier à l'autre IA, pas dans la caisse.
- **Problème :** `card_settlement` compare le total des deux terminaux (`s1 + s2`) uniquement avec les cartes notées dans `Entries` (`cardTotal_`). Les cartes encaissées au bar restent dans la caisse du bar et ne sont pas dans `Entries` : comme les deux terminaux se mélangent entre bar et réception, elles apparaissent comme un écart dans `Settlements`.
- **À faire :** ajouter un champ « Cartes bar » dans le règlement des cartes, et le soustraire du total des terminaux avant le calcul de l'écart.
- **Côté caisse :** déjà prêt. Le total des cartes du bar de la journée est affiché à la clôture du bar et disponible par `GET /api/report/day` (champ `cards`). Plus tard, la caisse pourrait l'envoyer elle-même à Rabbit-System au lieu qu'on le recopie.
- **Noté le :** 06/11/2026

### 2. [ ] Mode `till: 'reception'` (caisse unique) : rattachement au service de la réception
- **Où :** caisse (`server/shift.js`, `server/orders.js`) + règle à décider avec Sébastien.
- **Problème :** en mode caisse unique, les ventes payées devraient compter dans le service de la réception de Rabbit-System, ce qui n'est pas défini.
- **Noté le :** 06/11/2026

## Réglé

_(rien pour l'instant)_

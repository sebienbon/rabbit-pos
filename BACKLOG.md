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

### 3. [ ] Photos ajoutées depuis le PC → GitHub
- **Où :** caisse (back-office, phase 4) + mise à jour du PC.
- **Problème :** les photos sont gardées dans le dossier `photos/` du dépôt GitHub (choix du 06/11). Une photo ajoutée depuis le PC de réception est bien enregistrée dans ce dossier, mais elle n'arrive pas toute seule sur GitHub, et une future mise à jour du PC doit la garder.
- **À faire :** décider comment elles montent sur GitHub (envoi automatique avec un jeton GitHub, ou tu me les envoies et je les ajoute), et réduire chaque photo (~800 px, < 300 Ko) dans l'écran d'ajout.
- **Noté le :** 06/11/2026

### 4. [ ] Commande par QR : les téléphones doivent être sur le wifi de l'hôtel
- **Où :** réseau / matériel.
- **Problème :** le QR ouvre l'adresse du PC de réception sur le wifi (http://192.168…). Un client en 4G ne peut pas commander. L'adresse du PC doit aussi rester fixe (sinon les QR imprimés ne marchent plus).
- **À faire :** donner une adresse IP fixe au PC dans la box (réservation DHCP), imprimer le nom du wifi sur les cartes (prévu sur la page des QR codes).
- **Noté le :** 06/11/2026

### 5. [ ] PC de réception : se mettre à jour tout seul depuis GitHub
- **Où :** installation Windows (phase 6), `start.bat`.
- **Problème :** la caisse tourne sur le PC (imprimantes, hors ligne, commandes en direct), donc son code doit y être copié. Sébastien ne veut pas s'occuper d'un dossier.
- **À faire :** au démarrage, `start.bat` télécharge la dernière version depuis GitHub (sans toucher à `data/` ni aux photos ajoutées sur le PC), puis lance la caisse.
- **Noté le :** 06/11/2026

### 6. [ ] Script « POS Bar » : nom des nouveaux postes + fichier stock.gs
- **Où :** projet Apps Script « POS » (script `POS-Bar-script.gs`).
- **Problème :** la colonne « Bar / Kitchen » de l'onglet POS Bar n'affiche que Bar ou Kitchen. Avec les nouveaux postes (Pizza, Bar plage…), il faut recoller le script mis à jour (`bridge/journal.gs`, en gardant l'ID et le secret) puis Deploy › Manage deployments › Edit › New version.
- **Ajout du 07/11 :** dans le même projet, ajouter le fichier `bridge/stock.gs` (onglets stock du Sheet « Accounting Processor 2026 »), lancer une fois `setupStock`, puis New version.
- **Noté le :** 06/11/2026

## Réglé

_(rien pour l'instant)_

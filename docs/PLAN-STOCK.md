# Plan : postes, fiches techniques, inventaire, achats, saisonnalité

Demande de Sébastien (06/11/2026). Modèle suivi : ce que font les outils de référence (MarketMan, Apicbase,
Toast/xtraCHEF, Supy) — fiches techniques, consommation théorique vs réelle, niveaux de stock (« par »),
commandes suggérées — en version simple pour un petit établissement.

**Règle d'or :** tout ce que fait le staff (compter, recevoir une livraison, noter une perte) se fait en quelques
touches sur téléphone, dans les unités qu'il voit (bouteilles, kilos, cartons). Les fiches techniques, les coûts et
les réglages sont pour le manager et le propriétaire.

## A. Postes et tickets ✅ (en cours)
- Postes de préparation configurables : Bar, Cuisine, et autant d'autres que nécessaire (Pizza, Bar plage…),
  chacun avec son imprimante. Une catégorie (ou un article) choisit son poste.
- Une commande mixte est coupée : chaque poste reçoit seulement ses lignes.
- Option « copie » : un poste peut recevoir une copie de tous les tickets (passe, chef de rang).
- Plusieurs caisses (bar, plage…) : chaque appareil choisit sa caisse ; le reçu sort sur l'imprimante de cette caisse.

## B. Ingrédients et fiches techniques (manager / propriétaire)
- **Base de départ** : `docs/achats-base.json` = les 98 consommables commandés par le staff en 2 ans, revus par
  Sébastien le 07/11/2026 (page « Achats avec Aria ») : nom indonésien, anglais, français, catégorie, mode d'achat,
  lieux de rangement, commentaire. Import direct dans la table des ingrédients. Quelques articles seront à séparer
  en deux (Sébastien le fera dans le back-office).
- **Ingrédient** : nom (indonésien = nom du staff) + anglais + français, catégorie, unité de stock, conditionnement
  d'achat (ex. carton de 24 × 330 ml), prix d'achat → coût par unité, fournisseur, commentaire.
- **Tout est modulable par le owner/manager** (tables de référence, pas de listes figées dans le code) :
  catégories, lieux de rangement, modes d'achat, unités.
- **Modes d'achat** (plusieurs à la fois) : « Avec Aria » (le staff peut le commander à l'acheteur quand il en a
  besoin), « Si urgent » (Aria seulement en dépannage), « Internet » (stock acheté en ligne par le manager pour
  réduire les frais), « Autre » (+ commentaire). Aria + Internet est courant : le staff n'est jamais bloqué, le
  manager fait du stock en parallèle. Règle « ne va pas avec » réglable entre modes (Aria ≠ Si urgent).
- **Lieux de rangement** (plusieurs par ingrédient) : Gudang Atas, Gudang Bawah, Kitchen, Bar, Laundry.
  Ils servent à l'inventaire (D) : chaque lieu a sa liste de comptage.
- **Unités** : table extensible. Départ : pièce (unité), g, kg, ml, cl, L. Chaque unité a une famille (poids, volume,
  pièce) et un facteur vers l'unité de base (g, ml, pièce) pour convertir. Le owner ajoute ses propres unités
  (« botte », « bouteille 1,5 L », « sachet ») avec leur équivalence quand elle est connue ; une unité sans
  équivalence reste comptée telle quelle.
- **Fiche technique** d'un produit vendu (burger, mojito…) : liste d'ingrédients cliquée dans la base, avec quantité
  + unité (et perte/rendement en % facultatif). Sous-recettes (« préparations » : sauce maison, sirop, pâte) faites en lot.
  Les quantités difficiles à mesurer peuvent rester vides : l'estimation (H) les complète.
- Affichage : coût portion, % coût matière, marge ; alerte si le % dépasse l'objectif.

## C. Consommation théorique
- Chaque vente retire les quantités des fiches techniques → stock théorique par ingrédient, en continu.

## D. Inventaire (staff, très simple)
- Comptage par zone (Bar frigo, Bar étagère, Cuisine, Réserve), dans l'ordre des étagères.
- Gros boutons +/−, fractions (½ bouteille), unités naturelles.
- Comptage complet (semaine/mois) et comptage rapide des articles clés (alcools) chaque jour.
- Le manager voit l'écart réel / théorique par ingrédient, en quantité et en roupies.

## E. Pertes et repas du staff
- Une touche : article ou ingrédient, quantité, raison (cassé, périmé, repas staff, offert).

## F. Achats
- Réception d'une livraison : fournisseur, articles, quantités, prix → stock et coûts à jour.
- Commande suggérée par fournisseur = besoin prévu jusqu'à la prochaine livraison + sécurité − stock,
  arrondi au conditionnement. Le manager valide, ajuste, l'envoie (WhatsApp / impression).

## G. Saisonnalité
- Départ : coefficient par mois réglé par le propriétaire (haute / basse saison).
- Ensuite automatique : consommation réelle des semaines passées et de la même période l'an dernier,
  et nombre de clients présents (liste Rabbit-System) → consommation par nuitée.

## H. Estimation de la consommation et prix de revient (owner)
Demande du 07/11/2026. Pour les ingrédients sans grammage fiable (huile de friture, sel, liquide vaisselle…),
la caisse estime elle-même la consommation à partir de l'historique, sans outil externe : elle a déjà les ventes
par produit et par jour, et aura les achats (F) et les comptages (D).
- Données : ventes de chaque produit par semaine (caisse), entrées de stock par ingrédient (achats), stock compté,
  nombre de clients présents (Rabbit-System).
- Calcul : pour chaque ingrédient, une régression simple « quantité utilisée sur la période ≈ Σ (ventes du produit ×
  quantité par produit) + part fixe par nuitée ». Elle donne une quantité moyenne par produit vendu et montre quels
  produits font monter la consommation (ex. l'huile suit les frites, pas les cocktails).
- Le owner voit la proposition à côté de la fiche technique et l'accepte ou la corrige. Fiabilité affichée
  (peu de semaines, ou ingrédient qui ne suit aucun produit = part fixe).
- Prix de revient : coût des ingrédients de la fiche (prix d'achat moyen pondéré des derniers achats) → coût portion,
  marge, % coût matière, par produit et par mois.
- Prix d'achat : import du document de Sébastien (tableau des achats, rempli au fil de l'eau) — format à recevoir ;
  plus tard alimenté automatiquement par un système plus global. L'import est conçu pour accepter plusieurs sources
  (fichier, Google Sheet, API) qui écrivent toutes dans la même table d'achats.
- Le calcul tourne sur le PC la nuit (léger : quelques centaines de lignes par semaine) ; aucun service externe.

## Ce qu'il faudra de Sébastien
- ~~La liste des ingrédients~~ ✅ base de 98 consommables reçue le 07/11 (`docs/achats-base.json`).
- Son document des prix d'achat (pour l'import du prix de revient).
- Fournisseurs et jours de livraison.
- Les coefficients de saison de départ.

## Ordre de travail
A → B → C → D → E → F → G → H. Chaque étape est utilisable seule.

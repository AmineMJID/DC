<p align="center">
  <img src="assets/logo.svg" alt="Logo LLDraw" width="112" height="112">
</p>

<h1 align="center">LLDraw</h1>

<p align="center">
  Application web de planification de baies data center — type draw.io, spécialisée racks.
</p>

---
Glissez-déposez un rack 12U, placez vos devices (avec photo de face avant) et étiquetez
les ports.

## Lancer l'application

Aucune dépendance à installer (Python 3 suffit). Pour bénéficier de la
**sauvegarde permanente côté serveur** — les workspaces ne disparaissent
pas quand on change de navigateur ou qu'on vide le cache — lancez :

```bash
cd DC
python3 server.py          # http://localhost:8080  (ou : python3 server.py 9000)
```

Puis ouvrez <http://localhost:8080>.

Ce serveur fait deux choses : il sert les fichiers statiques **et** il
enregistre l'état de l'application dans un fichier JSON : **`data/state.json`**
(écriture atomique). Sauvegardez/copiez ce fichier pour sauvegarder ou
déplacer vos plans. L'indicateur dans la barre du haut est **☁️** quand
l'enregistrement se fait sur le serveur, et **💾** quand l'application
tourne sans serveur (dans ce cas les données restent dans le navigateur,
via localStorage, en secours).

> Une ancienne sauvegarde présente dans le navigateur est automatiquement
> reprise et envoyée au serveur au premier démarrage avec `server.py`.

## Utilisation

0. **Écran d'accueil** : au lancement, une page d'accueil affiche un bouton
   **« Créer un workspace »** et l'**historique de vos workspaces** (cartes triées
   par date de modification, avec le nombre de baies / devices et la date).
   Cliquez sur une carte pour ouvrir le workspace, ou sur 🗑 pour le supprimer.
   Cliquez sur le **logo** ou le nom **LLDraw** dans la barre du haut pour revenir à l'accueil à tout moment.
   - Chaque workspace possède **son propre board** : baies, devices placés et ports.
   - La **bibliothèque de devices est partagée** : un device créé dans un workspace
     est disponible dans tous les autres.
   - La position et le niveau de zoom du board sont mémorisés par workspace.
   - **Rien n'est jamais supprimé automatiquement** : la suppression d'un workspace,
     d'une baie ou d'un device se fait uniquement via les boutons prévus, avec
     confirmation.
   - La création et la suppression des workspaces se font depuis l'écran d'accueil.
1. **Navigation** : le board est une surface infinie — **molette** pour zoomer
   (centré sur le curseur), **glisser le fond** pour se déplacer. Les boutons
   en bas à droite (`−`, `+`, `⌂`) donnent aussi le zoom et le recentrage.
2. **Racks** : dans le panneau de gauche, choisissez la **taille** (6U à 42U)
   puis glissez la carte **Rack** sur le board. Vous pouvez placer plusieurs
   racks, les déplacer en tirant l'en-tête, **changer leur taille** via le menu
   dans l'en-tête, et les **renommer** en double-cliquant sur le nom.
   L'en-tête affiche des **métriques de capacité** mises à jour en direct :
   espace occupé (`8/12U`, en rouge si plein), **puissance totale** et
   **poids total** des devices (si renseignés). **Double-cliquez sur les
   badges puissance/poids** pour définir un **budget électrique (W)** et une
   **charge maximale (kg)** : le badge passe en rouge en cas de dépassement.
   Les racks sont dessinés comme de vrais racks 19" : montants perforés
   (trous de cage nuts), règle des U et faceplates métalliques.
3. **Recherche globale** : le champ de la barre du haut cherche dans **tous les
   workspaces** (nom de device, nom de port, étiquette — ex. `CAB-SRV-01`).
   Un clic sur un résultat ouvre le bon workspace, centre la vue sur le rack et
   fait **clignoter** le device ou le port trouvé.
4. **Annuler / Rétablir** : **Ctrl+Z** (ou Ctrl+Maj+Z) et **Ctrl+Y** permettent
   d'annuler/rétablir toutes les actions (placement, suppression, « Vider »,
   création de device/workspace…).
5. **Export du plan** : le bouton **Exporter** de la barre du haut ouvre un
   menu permettant d'enregistrer le plan du workspace courant :
   - **Image PNG** / **Plan PDF (1 page)** — rendu haute définition des racks,
     devices et ports ;
   - **Document LLD (PDF)** — le dossier complet, multi-pages : page de garde
     (client, auteur, version, historique des révisions, statistiques), synthèse
     des racks (capacités et budgets), inventaire, plan d'adressage & ports,
     tableau de câblage, registre VLANs & subnets, topologie logique et
     élévations des racks en images. Pieds de page numérotés (date, page X/Y).
     Généré sans dépendance (PDF natif).
   - **Classeur Excel (.xlsx)** — un vrai fichier Excel (écrit sans dépendance)
     avec 4 feuilles : *Inventaire*, *Câblage*, *Ports* et *Racks* (en-têtes
     stylés, largeurs automatiques, première ligne figée) ;
   - **Inventaire (CSV)** — tableau de tous les devices posés (rack, étage,
     taille, marque, modèle, référence, n° série, IP mgmt, VLAN, puissance,
     poids, nombre de ports) ;
   - **Câblage (CSV)** — tableau des cordons (ID, couleur, extrémités A/B :
     rack, device, port, étiquette) ;
   - **Ports & étiquettes (CSV)** — tous les ports avec rack, étage, device,
     nom du port, étiquette, IP, VLAN et câble connecté.
   Les CSV sont au format Excel français (séparateur `;`, UTF-8 BOM).
6. **Créer un device** : cliquez sur **＋ Créer un device**, donnez-lui un nom,
   une taille (1U, 2U…) et importez la **photo 2D de la face avant**.
   Une **fiche d'inventaire** optionnelle complète le modèle : marque, modèle,
   référence constructeur, n° série, IP management, VLAN(s), puissance (W) et
   poids (kg). Ces champs sont recopiés sur chaque exemplaire posé dans un rack
   (et restent modifiables individuellement depuis la fiche de survol).
   - **Détection automatique des ports** : dès l'import de la photo, l'application
     analyse l'image et repère les connecteurs (RJ45, SFP…) — ports noirs sur
     panneau clair, clairs sur panneau sombre, etc. Les ports trouvés sont
     affichés en vert sur l'aperçu ; décochez la case si vous préférez les
     placer à la main. Chaque exemplaire du device posé dans un rack arrive
     avec ces ports déjà étiquetés (numérotés 1, 2, 3…), prêts à être renommés
     en mode Étiquetage ou câblés en mode Câblage.
7. **Placer un device** : glissez-le depuis la bibliothèque vers un rack : il se place
   automatiquement à l'étage (numéro d'U) où vous le déposez. La zone visée est surlignée
   en vert (libre) ou rouge (occupé). Vous pouvez aussi déplacer un device déjà placé,
   ou le retirer avec le bouton ✕ au survol.
   - **Fiche du device au survol** : laissez le curseur un instant sur un device posé
     (hors modes Étiquetage/Câblage) — une fiche s'affiche avec sa photo, son nom, sa
     taille, son étage de départ et son nombre de ports. **Double-cliquez sur une
     valeur pour la modifier** : le nom, la taille en U (replacé automatiquement au
     plus près s'il faut de la place) ou l'étage de départ (avec contrôle de collision).
     Entrée valide, Échap annule.
8. **Port et étiquetage** : le bouton **🔌 Port et étiquetage ▾** propose deux modes :
   **➕ Créer des ports** (cliquez sur la face avant d'un device pour y poser un port,
   icône RJ45) et **✏️ Modifier les ports** (cliquez sur un port existant pour changer
   son **nom** — ex. `Gi0/1` —, son **étiquette** — ex. `CAB-SRV-01` —, son **IP**
   et son **VLAN** (plan d'adressage), ou sa **taille**
   via un curseur en pourcentage de 50 % à 250 %, avec un aperçu en transparence ;
   glissez un port pour le repositionner). Un port peut aussi être supprimé depuis sa
   fenêtre d'édition. Au survol, l'infobulle affiche nom, étiquette, IP et VLAN.
9. Au **survol d'un port**, une infobulle affiche son nom et son étiquette.
10. **Mode Câblage** : l'interrupteur **Câblage** de la barre du haut active le
    mode. Cliquez alors **un port, puis un autre port** pour les relier par un
    cordon (courbe réaliste avec effet de poids). Le câble reçoit un identifiant
    (`CAB-001`…) et une **couleur** modifiables en cliquant sur le câble. Le
    panneau **Connexions** liste tous les câbles du workspace et permet de les
    retrouver (centrage) ou de les supprimer. Les câbles sont inclus dans
    l'export PNG/PDF. Désactiver l'interrupteur masque les câbles et interdit
    leur édition.
11. **Vue Topologie (diagramme logique)** : le sélecteur **📐 Élévations /
    🕸️ Topologie** de la barre du haut bascule le board en diagramme réseau.
    **⚡ Générer depuis les racks** crée un noeud par device posé (nom, marque/
    modèle, rack · étage, IP mgmt) ; **🔌 Importer les câbles** crée un lien par
    câble physique ; **➕ Nouveau lien** relie deux noeuds cliqués l'un après
    l'autre. Un lien (nom, débit, VLAN, style, couleur) se modifie en cliquant
    dessus ; les noeuds se déplacent à la souris ; **double-clic sur un noeud**
    revient en élévations, centré sur le device. La topologie est sauvegardée
    dans le workspace et se recadre automatiquement (⌂).
12. **Infos du dossier LLD** : le bouton **📘** de la barre du haut ouvre la
    fiche du dossier : **client**, **auteur**, **version**, **historique des
    révisions** (tableau ajouté à la page de garde du PDF) et **registre
    VLANs & subnets** (ID, nom, subnet, passerelle, usage). Le bouton
    **🔎 Détecter depuis les ports** ajoute automatiquement les VLANs
    utilisés sur les ports ou les liens logiques mais absents du registre.
    Ces informations alimentent les sections correspondantes du document LLD.

Tout est sauvegardé automatiquement : sur le **serveur (fichier `data/state.json`)**
quand l'application est lancée avec `server.py`, et sinon dans le navigateur
(localStorage) comme solution de secours. Workspaces, boards, bibliothèque de
devices et ports persistent donc entre les sessions — et même d'un navigateur à
l'autre avec le serveur. Un rack se supprime individuellement via son ✕ ; un
workspace entier se supprime depuis l'écran d'accueil.

## Fichiers

- `server.py` — serveur HTTP + persistance JSON (`data/state.json`)
- `index.html` — structure de l'interface
- `styles.css` — thème et mise en page
- `app.js` — logique (drag & drop, racks, devices, ports, câbles, persistance)
- `assets/logo.svg` — logo du projet (icône d'application, défini en vectoriel) ;
  décliné en PNG (`logo-512.png`, `logo-192.png`), favicon (`favicon.ico` /
  `favicon-*.png`) et `apple-touch-icon.png`
- `data/state.json` — état sauvegardé (créé automatiquement, non versionné)

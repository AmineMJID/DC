# DC
# DC Rack Planner

Application web de planification de baies data center (type draw.io, spécialisée racks) :
glisser-déposer un rack 12U, y placer des devices (avec photo de face avant), et étiqueter
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
   Le bouton **⌂** dans la barre du haut permet de revenir à l'accueil à tout moment.
   - Chaque workspace possède **son propre board** : baies, devices placés et ports.
   - La **bibliothèque de devices est partagée** : un device créé dans un workspace
     est disponible dans tous les autres.
   - La position et le niveau de zoom du board sont mémorisés par workspace.
   - **Rien n'est jamais supprimé automatiquement** : la suppression d'un workspace,
     d'une baie ou d'un device se fait uniquement via les boutons prévus, avec
     confirmation.
   - En cours de travail, la barre du haut permet aussi de gérer les workspaces
     (menu déroulant + `＋` nouveau, `✎` renommer, `🗑` supprimer).
1. **Navigation** : le board est une surface infinie — **molette** pour zoomer
   (centré sur le curseur), **glisser le fond** pour se déplacer. Les boutons
   en bas à droite (`−`, `+`, `⌂`) donnent aussi le zoom et le recentrage.
2. **Racks** : dans le panneau de gauche, choisissez la **taille** (6U à 42U)
   puis glissez la carte **Rack** sur le board. Vous pouvez placer plusieurs
   racks, les déplacer en tirant l'en-tête, **changer leur taille** via le menu
   dans l'en-tête, et les **renommer** en double-cliquant sur le nom.
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
   menu permettant d'enregistrer le plan du workspace courant en **image PNG**
   ou en **document PDF** (rendu haute définition des racks, devices et ports).
6. **Créer un device** : cliquez sur **＋ Créer un device**, donnez-lui un nom,
   une taille (1U, 2U…) et importez la **photo 2D de la face avant**.
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
8. **Port et étiquetage** : le bouton **🔌 Port et étiquetage ▾** propose deux modes :
   **➕ Créer des ports** (cliquez sur la face avant d'un device pour y poser un port,
   icône RJ45) et **✏️ Modifier les ports** (cliquez sur un port existant pour changer
   son **nom** — ex. `Gi0/1` —, son **étiquette** — ex. `CAB-SRV-01` — ou sa **taille**
   via un curseur en pourcentage de 50 % à 250 %, avec un aperçu en transparence ;
   glissez un port pour le repositionner). Un port peut aussi être supprimé depuis sa
   fenêtre d'édition.
9. Au **survol d'un port**, une infobulle affiche son nom et son étiquette.
10. **Mode Câblage** : l'interrupteur **Câblage** de la barre du haut active le
    mode. Cliquez alors **un port, puis un autre port** pour les relier par un
    cordon (courbe réaliste avec effet de poids). Le câble reçoit un identifiant
    (`CAB-001`…) et une **couleur** modifiables en cliquant sur le câble. Le
    panneau **Connexions** liste tous les câbles du workspace et permet de les
    retrouver (centrage) ou de les supprimer. Les câbles sont inclus dans
    l'export PNG/PDF. Désactiver l'interrupteur masque les câbles et interdit
    leur édition.

Tout est sauvegardé automatiquement : sur le **serveur (fichier `data/state.json`)**
quand l'application est lancée avec `server.py`, et sinon dans le navigateur
(localStorage) comme solution de secours. Workspaces, boards, bibliothèque de
devices et ports persistent donc entre les sessions — et même d'un navigateur à
l'autre avec le serveur. Un rack se supprime individuellement via son ✕ ; un
workspace entier se supprime via la barre du haut ou l'écran d'accueil.

## Fichiers

- `server.py` — serveur HTTP + persistance JSON (`data/state.json`)
- `index.html` — structure de l'interface
- `styles.css` — thème et mise en page
- `app.js` — logique (drag & drop, racks, devices, ports, câbles, persistance)
- `data/state.json` — état sauvegardé (créé automatiquement, non versionné)
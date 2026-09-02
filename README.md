# DC Rack Planner

Application web de planification de baies data center (type draw.io, spécialisée racks) :
glisser-déposer un rack 12U, y placer des devices (avec photo de face avant), et étiqueter
les ports.

## Lancer l'application

Aucune installation nécessaire — il suffit d'un serveur statique :

```bash
cd DC
python3 -m http.server 8080
```

Puis ouvrir <http://localhost:8080>.

## Utilisation

0. **Workspaces** : la barre du haut permet de gérer plusieurs workspaces
   (menu déroulant + `＋` nouveau, `✎` renommer, `🗑` supprimer).
   - Chaque workspace possède **son propre board** : baies, devices placés et ports.
   - La **bibliothèque de devices est partagée** : un device créé dans un workspace
     est disponible dans tous les autres.
   - La position et le niveau de zoom du board sont mémorisés par workspace.
   - **Rien n'est jamais supprimé automatiquement** : la suppression d'un workspace,
     d'une baie ou d'un device se fait uniquement via les boutons prévus, avec
     confirmation.
1. **Navigation** : le board est une surface infinie — **molette** pour zoomer
   (centré sur le curseur), **glisser le fond** pour se déplacer. Les boutons
   en bas à droite (`−`, `+`, `⌂`) donnent aussi le zoom et le recentrage.
2. **Baie** : dans le panneau de gauche, glissez la carte **Baie 12U** sur le board.
   Vous pouvez placer plusieurs baies et les déplacer en tirant leur en-tête.
   La baie est dessinée comme une vraie baie 19" : montants perforés (trous de
   cage nuts), règle des U et faceplates métalliques.
3. **Créer un device** : cliquez sur **＋ Créer un device**, donnez-lui un nom,
   une taille (1U, 2U…) et importez la **photo 2D de la face avant**.
4. **Placer un device** : glissez-le depuis la bibliothèque vers la baie : il se place
   automatiquement à l'étage (numéro d'U) où vous le déposez. La zone visée est surlignée
   en vert (libre) ou rouge (occupé). Vous pouvez aussi déplacer un device déjà placé,
   ou le retirer avec le bouton ✕ au survol.
5. **Étiquetage des ports** : cliquez sur **🏷️ Étiquetage**, puis cliquez sur la face
   avant d'un device pour y déposer un carré « port ». Renseignez le **nom du port**
   (ex. `Gi0/1`) et son **étiquette** (ex. `CAB-SRV-01`). En cliquant sur un port
   existant vous pouvez le modifier ou le supprimer.
6. Au **survol d'un port**, une infobulle affiche son nom et son étiquette.

Tout est sauvegardé automatiquement dans le navigateur (localStorage) : workspaces,
boards, bibliothèque de devices et ports persistent entre les sessions. Le bouton
« 🧹 Vider » ne vide que le board du workspace courant (sur confirmation).

## Fichiers

- `index.html` — structure de l'interface
- `styles.css` — thème et mise en page
- `app.js` — logique (drag & drop, racks, devices, ports, persistance)

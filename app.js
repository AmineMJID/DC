'use strict';

/* ============================================================
   LLDraw
   - Board navigable : zoom (molette / boutons) et pan (glisser le fond)
   - Glisser-déposer de racks de tailles variables sur le board
   - Création de devices (nom, taille en U, photo de face avant)
   - Drop des devices dans les racks : verrouillage auto à l'étage (U)
   - Mode "Étiquetage" : ports (carrés) + infobulle nom/étiquette
   - Workspaces avec écran d'accueil ; bibliothèque de devices partagée
   - Undo/Redo (Ctrl+Z / Ctrl+Y), export/import JSON, recherche globale
   - Persistance dans localStorage
   ============================================================ */

// Device permanent WatchGuard
const WATCHGUARD_ID = 'watchguard-permanent';

function ensureWatchGuard() {
  const exists = state.devices.some(d => d.id === WATCHGUARD_ID);
  if (!exists) {
    state.devices.unshift({
      id: WATCHGUARD_ID,
      name: 'WatchGuard',
      sizeU: 1,
      photo: null,
      permanent: true,
      brand: 'WatchGuard',
      model: 'Firebox',
      partRef: '',
      serial: '',
      ipMgmt: '',
      vlan: '',
      watts: 25,
      weightKg: 2.5,
      ports: []
    });
    saveState();
  }
}

// Charger l'image WatchGuard depuis le fichier
async function loadWatchGuardPhoto() {
  try {
    const res = await fetch('assets/watchguard.jpg');
    if (!res.ok) return;
    const blob = await res.blob();
    const dataUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    const wg = state.devices.find(d => d.id === WATCHGUARD_ID);
    if (wg) {
      wg.photo = dataUrl;
      saveState();
      renderPalette();
    }
  } catch (e) { /* pas de photo watchguard disponible */ }
}

// Charger la photo au démarrage
loadWatchGuardPhoto();

// ---------- Constantes ----------
const STORAGE_KEY = 'dc-rack-planner-v1';
const DEFAULT_RACK_U = 12;    // taille par défaut d'un rack
const U_H     = 33;          // hauteur d'un U en px (coordonnées board)
const RACK_W  = 356;         // largeur d'un rack
const RACK_SIZES = [6, 9, 12, 15, 18, 22, 27, 32, 42];
const BOARD_W = 8000;
const BOARD_H = 6000;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

// Infos du dossier LLD portées par le workspace (page de garde, révisions, VLANs)
function normLldInfo(w) {
  if (!w.lld || typeof w.lld !== 'object') w.lld = {};
  const L = w.lld;
  for (const k of ['client', 'author', 'version']) {
    if (typeof L[k] !== 'string') L[k] = '';
    L[k] = L[k].slice(0, 80);
  }
  L.revs = Array.isArray(L.revs) ? L.revs.filter(r => r && typeof r === 'object').map(r => ({
    rev: String(r.rev ?? '').slice(0, 10),
    date: String(r.date ?? '').slice(0, 10),
    author: String(r.author ?? '').slice(0, 60),
    note: String(r.note ?? '').slice(0, 120)
  })) : [];
  L.vlans = Array.isArray(L.vlans) ? L.vlans.filter(v => v && typeof v === 'object').map(v => ({
    vid: String(v.vid ?? '').slice(0, 6),
    name: String(v.name ?? '').slice(0, 40),
    subnet: String(v.subnet ?? '').slice(0, 50),
    gw: String(v.gw ?? '').slice(0, 50),
    purpose: String(v.purpose ?? '').slice(0, 60)
  })) : [];
  return L;
}

// Hauteur d'un rack à l'écran (en-tête + rembourrages + U)
function rackHeight(rack) {
  return 28 + 16 + (rack.sizeU || DEFAULT_RACK_U) * U_H;
}

// Formatage de puissance (350 W / 1,4 kW)
function fmtWatts(w) {
  return w >= 1000
    ? (Math.round(w / 100) / 10).toLocaleString('fr-FR') + ' kW'
    : Math.round(w) + ' W';
}

// Champs d'inventaire d'un device (présents sur le modèle ET sur chaque exemplaire)
const DEV_TEXT_FIELDS = ['brand', 'model', 'partRef', 'serial', 'ipMgmt', 'vlan'];
function normInvFields(d) {
  for (const k of DEV_TEXT_FIELDS) if (typeof d[k] !== 'string') d[k] = '';
  d.watts = Number.isFinite(d.watts) ? d.watts : 0;
  d.weightKg = Number.isFinite(d.weightKg) ? d.weightKg : 0;
  return d;
}

// Normalisation d'un rack chargé (rétro-compatibilité)
function normalizeRack(r) {
  r.sizeU = r.sizeU || DEFAULT_RACK_U;
  if (!r.name) r.name = `Rack ${r.sizeU}U`;
  r.instances = Array.isArray(r.instances) ? r.instances : [];
  r.instances.forEach(i => {
    i.ports = Array.isArray(i.ports) ? i.ports : [];
    i.ports.forEach(p => {
      if (typeof p.size !== 'number') p.size = 1;
      if (typeof p.ip !== 'string') p.ip = '';
      if (typeof p.vlan !== 'string') p.vlan = '';
    });
    normInvFields(i);
  });
  r.maxWatts = Number.isFinite(r.maxWatts) ? r.maxWatts : 0;
  r.maxKg = Number.isFinite(r.maxKg) ? r.maxKg : 0;
  return r;
}

// ---------- Helpers ----------
const $  = (sel, root = document) => root.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- État ----------
// Structure :
//   state.devices           -> bibliothèque PARTAGÉE entre workspaces
//   state.workspaces[]      -> un board par workspace (racks, instances, ports, vue)
//   state.activeWorkspaceId -> workspace courant
let state = emptyState();
let labelMode = null;          // null | 'create' | 'edit'
let boardMode = 'elev';        // 'elev' (élévations) | 'topo' (topologie logique)
let topoLinkPending = null;    // noeud de départ pendant la création d'un lien
let dragPayload = null;
let popoverCtx = null;
let suppressPortClick = false;   // true juste après un glisser-déposer de port

// Vue du board (décalage + échelle) — mémorisée par workspace
const view = { x: 80, y: 50, scale: 1 };

function makeWorkspace(name, racks = []) {
  return { id: uid(), name, racks, cables: [], view: null, viewTouched: false, updatedAt: Date.now() };
}

function emptyState() {
  return { devices: [], workspaces: [], activeWorkspaceId: null };
}

// Normalise un état chargé (localStorage ou serveur) : structure,
// migration des anciennes versions et valeurs par défaut.
function normalizeState(s) {
  if (!s || !Array.isArray(s.devices)) {
    return emptyState();
  }

  // Migration d'une ancienne version (racks au niveau global)
  if (!Array.isArray(s.workspaces)) {
    const legacy = (Array.isArray(s.racks) ? s.racks : []).map(normalizeRack);
    if (legacy.length || s.devices.length) {
      const ws = makeWorkspace('Workspace 1', legacy);
      s.workspaces = [ws];
      s.activeWorkspaceId = ws.id;
    } else {
      s.workspaces = [];
      s.activeWorkspaceId = null;
    }
  }
  // Ports pré-détectés sur les modèles de device (détection automatique)
  s.devices.forEach(d => {
    d.ports = Array.isArray(d.ports) ? d.ports : [];
    d.ports.forEach(p => {
      if (typeof p.size !== 'number') p.size = 1;
      if (typeof p.ip !== 'string') p.ip = '';
      if (typeof p.vlan !== 'string') p.vlan = '';
    });
    normInvFields(d);
  });
  // Normalisation rétro-compatible + date de modification
  s.workspaces.forEach(w => {
    w.racks = (Array.isArray(w.racks) ? w.racks : []).map(normalizeRack);
    if (!Array.isArray(w.cables)) w.cables = [];
    if (typeof w.updatedAt !== 'number') w.updatedAt = 0;
    // Vue topologique (diagramme logique) : structure + nettoyage
    if (!w.topology || !Array.isArray(w.topology.nodes) || !Array.isArray(w.topology.links))
      w.topology = { nodes: [], links: [] };
    pruneTopology(w);
    normLldInfo(w);
    // Les anciennes vues par défaut ne sont pas considérées comme personnalisées :
    // l'application recadrera automatiquement sur le contenu à la première ouverture.
    w.viewTouched = !!w.viewTouched;
  });
  if (s.activeWorkspaceId && !s.workspaces.some(w => w.id === s.activeWorkspaceId)) {
    s.activeWorkspaceId = s.workspaces[0]?.id ?? null;
  }
  return s;
}

// État de secours stocké dans le navigateur (utilisé hors-ligne / sans serveur)
function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw));
  } catch (e) { /* état illisible : on repart à vide */ }
  return emptyState();
}

/* ============================================================
   PERSISTANCE — sauvegarde côté serveur (fichier JSON)
   ------------------------------------------------------------
   L'état est envoyé au serveur (data/state.json) à chaque
   modification, ce qui rend les workspaces indépendants du
   navigateur. localStorage reste utilisé comme copie locale de
   secours si le serveur n'est pas joignable.
   ============================================================ */
const SERVER_API = '/api/state';
let serverAvailable = null;     // null = inconnu, true/false après test
let serverPushTimer = null;
let serverPushPending = false;  // une écriture est-elle en cours ?
let serverPushQueued = false;   // une autre écriture est-elle à relancer ?

function hasContent(s) {
  return !!s && (s.workspaces?.length > 0 || s.devices?.length > 0);
}

function setSaveStatus(mode) {
  const el = $('#save-status');
  if (!el) return;
  const map = {
    cloud:  { t: '☁️', c: 'Enregistré sur le serveur',      cls: 'ss-cloud' },
    local:  { t: '💾', c: 'Enregistré dans ce navigateur',  cls: 'ss-local' },
    saving: { t: '⏳', c: 'Enregistrement…',                 cls: 'ss-saving' }
  };
  const m = map[mode] || map.cloud;
  el.textContent = m.t;
  el.title = m.c;
  el.classList.toggle('ss-local', mode === 'local');
  el.classList.toggle('ss-saving', mode === 'saving');
}

// Charge l'état au démarrage : serveur d'abord, sinon navigateur.
async function bootState() {
  let serverState = null;
  try {
    const res = await fetch(SERVER_API, { cache: 'no-store' });
    if (res.ok) serverState = await res.json();
    serverAvailable = res.ok;
  } catch (e) {
    serverAvailable = false;   // fichier ouvert sans le serveur (file://, etc.)
  }

  const srv = normalizeState(serverState);
  if (serverAvailable && hasContent(srv)) {
    state = srv;
    setSaveStatus('cloud');
  } else if (serverAvailable && !hasContent(srv)) {
    // Serveur vide : on y pousse une éventuelle sauvegarde locale existante
    const local = loadLocalState();
    state = hasContent(local) ? local : srv;
    setSaveStatus('cloud');
    if (hasContent(local)) scheduleServerSave(true);
  } else {
    state = loadLocalState();
    setSaveStatus('local');
  }
}

function pushToServer() {
  if (!serverAvailable) return Promise.resolve(false);
  return fetch(SERVER_API, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state)
  })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      serverAvailable = true;
      setSaveStatus('cloud');
      return true;
    })
    .catch(() => {
      // Le serveur a disparu en cours de session : on bascule en local
      serverAvailable = false;
      setSaveStatus('local');
      return false;
    });
}

// Écritures groupées (~600 ms) pour ne pas saturer le serveur
function scheduleServerSave(immediate = false) {
  if (!serverAvailable) return;
  setSaveStatus('saving');
  clearTimeout(serverPushTimer);
  const run = () => {
    if (serverPushPending) { serverPushQueued = true; return; }
    serverPushPending = true;
    pushToServer().finally(() => {
      serverPushPending = false;
      if (serverPushQueued) { serverPushQueued = false; run(); }
    });
  };
  if (immediate) run();
  else serverPushTimer = setTimeout(run, 600);
}

// Workspace courant (peut être absent sur l'écran d'accueil)
function active() {
  return state.workspaces.find(w => w.id === state.activeWorkspaceId) || null;
}

// Marquer un workspace comme modifié (pour l'historique de l'accueil)
function touchWorkspace(ws) {
  if (ws) ws.updatedAt = Date.now();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Sauvegarde locale impossible (quota localStorage ?)', e);
  }
  // Synchronisation avec le serveur (fichier JSON) si disponible
  scheduleServerSave();
}

// Sauvegarde différée (pour la vue, sollicitée pendant le zoom/pan)
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

/* ============================================================
   UNDO / REDO — historique d'instantanés de l'état
   ============================================================ */
const HISTORY_LIMIT = 40;
let undoStack = [];
let redoStack = [];

function cloneState() {
  return JSON.parse(JSON.stringify(state));
}

// À appeler AVANT toute mutation de state (hors vue/zoom-pan)
function pushHistory() {
  undoStack.push(cloneState());
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
}

function refreshAll() {
  const ws = active();
  if (ws) {
    if (ws.viewTouched && ws.view) {
      view.x = ws.view.x;
      view.y = ws.view.y;
      view.scale = ws.view.scale;
      applyView();
    } else {
      fitViewToContent();
    }
  }
  renderPalette();
  renderHomeListSafe();
  const stillExists = ws && state.workspaces.some(w => w.id === ws.id);
  if (stillExists) {
    hideHome();
    renderBoard();
    if (cablingMode) { renderCables(); renderCableList(); }
  } else {
    showHome();
  }
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(cloneState());
  state = undoStack.pop();
  pendingPort = null;
  hideCablePopoverSafe();
  saveState();
  refreshAll();
  if (cablingMode) { renderCables(); renderCableList(); }
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(cloneState());
  state = redoStack.pop();
  pendingPort = null;
  hideCablePopoverSafe();
  saveState();
  refreshAll();
  if (cablingMode) { renderCables(); renderCableList(); }
}

function hideCablePopoverSafe() {
  const el = document.getElementById('cable-popover');
  if (el) el.classList.add('hidden');
  cablePopoverCtx = null;
}

function renderHomeListSafe() {
  if (!homeScreen.classList.contains('hidden')) renderHomeList();
}

// Raccourcis clavier Ctrl+Z / Ctrl+Y (sauf quand on tape dans un champ)
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.target?.closest?.(`input, textarea, select, [contenteditable]`)) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y')) {
    e.preventDefault();
    redo();
  }
});

/* ============================================================
   BOARD — zoom & pan
   ============================================================ */

const viewport = $('#board-viewport');
const board    = $('#board');

function applyView() {
  board.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  $('#z-pct').textContent = Math.round(view.scale * 100) + '%';
  // Mémoriser la vue du workspace courant
  const ws = active();
  if (ws && ws.viewTouched) {
    ws.view = { x: view.x, y: view.y, scale: view.scale };
    scheduleSave();
  }
}

// Marque la vue courante comme personnalisée (l'utilisateur a zoomé/déplacé)
function markViewTouched() {
  const ws = active();
  if (!ws) return;
  ws.viewTouched = true;
  ws.view = { x: view.x, y: view.y, scale: view.scale };
  scheduleSave();
}

// Recentre/zoome la vue sur l'ensemble des racks du workspace. Quand le board
// est vide, le centre du plan virtuel reste au milieu du viewport. forceScale = 1 pour le ⌂.
function fitViewToContent(forceScale = null) {
  const ws = active();
  const rect = viewport.getBoundingClientRect();
  const PAD = 80;

  // Vue topologie : cadrer sur les noeuds du diagramme
  if (boardMode === 'topo') {
    const nodes = ws?.topology?.nodes || [];
    if (!nodes.length) {
      // Même comportement que la vue élévations : un workspace vide démarre
      // au milieu du plan, et non sur son origine en haut à gauche.
      const scale = forceScale ?? 1;
      view.scale = scale;
      view.x = rect.width / 2 - (BOARD_W / 2) * scale;
      view.y = rect.height / 2 - (BOARD_H / 2) * scale;
      applyView();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(n => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + TOPO_NW);
      maxY = Math.max(maxY, n.y + TOPO_NH);
    });
    const cw = maxX - minX, ch = maxY - minY;
    const scale = forceScale ?? Math.max(MIN_SCALE, Math.min(1,
      (rect.width - PAD * 2) / cw, (rect.height - PAD * 2) / ch));
    view.scale = scale;
    view.x = rect.width / 2 - (minX + cw / 2) * scale;
    view.y = rect.height / 2 - (minY + ch / 2) * scale;
    applyView();
    return;
  }

  if (!ws || !ws.racks.length) {
    // Ne pas afficher l'origine (0, 0) du plan : sur un board vide, cela
    // donnait l'impression d'être bloqué dans son coin haut-gauche.
    // Le premier rack déposé au centre apparaîtra donc naturellement centré.
    const scale = forceScale ?? 1;
    view.scale = scale;
    view.x = rect.width / 2 - (BOARD_W / 2) * scale;
    view.y = rect.height / 2 - (BOARD_H / 2) * scale;
    applyView();
    return;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ws.racks.forEach(r => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + RACK_W);
    maxY = Math.max(maxY, r.y + rackHeight(r));
  });
  const cw = maxX - minX, ch = maxY - minY;

  const scale = forceScale ?? Math.max(MIN_SCALE, Math.min(1,
    (rect.width  - PAD * 2) / cw,
    (rect.height - PAD * 2) / ch));
  view.scale = scale;
  view.x = rect.width  / 2 - (minX + cw / 2) * scale;
  view.y = rect.height / 2 - (minY + ch / 2) * scale;
  applyView();
}

// Applique la vue du workspace : la vue mémorisée si l'utilisateur l'a
// personnalisée, sinon un recadrage automatique sur le contenu.
function applyWorkspaceView() {
  const ws = active();
  if (ws && ws.viewTouched && ws.view) {
    view.x = ws.view.x;
    view.y = ws.view.y;
    view.scale = ws.view.scale;
    applyView();
  } else {
    fitViewToContent();
  }
}

// Coordonnées écran -> coordonnées board
function clientToBoard(cx, cy) {
  const r = viewport.getBoundingClientRect();
  return {
    x: (cx - r.left - view.x) / view.scale,
    y: (cy - r.top  - view.y) / view.scale
  };
}

function zoomAt(cx, cy, factor) {
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
  const k = newScale / view.scale;
  // garde le point sous le curseur immobile
  view.x = cx - k * (cx - view.x);
  view.y = cy - k * (cy - view.y);
  view.scale = newScale;
  markViewTouched();
  applyView();
}

// Zoom molette
viewport.addEventListener('wheel', e => {
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
}, { passive: false });

// Pan : glisser le fond (pas sur une baie, un contrôle ou une fenêtre)
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  // NB : tout contrôle interactif posé sur le viewport doit figurer ici,
  // sinon setPointerCapture détourne le clic (le bouton ne le reçoit jamais).
  if (e.target.closest('.rack, .zoom-ctrl, .popover, .tooltip, .topo-toolbar, .topo-node, .topo-empty, .cable-panel, .board-empty')) return;

  const startX = e.clientX, startY = e.clientY;
  const ox = view.x, oy = view.y;
  let panned = false;
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add('panning');

  const onMove = ev => {
    panned = true;
    view.x = ox + ev.clientX - startX;
    view.y = oy + ev.clientY - startY;
    applyView();
  };
  const onUp = () => {
    viewport.classList.remove('panning');
    viewport.removeEventListener('pointermove', onMove);
    viewport.removeEventListener('pointerup', onUp);
    if (panned) markViewTouched();
  };
  viewport.addEventListener('pointermove', onMove);
  viewport.addEventListener('pointerup', onUp);
});

// Boutons de zoom
function zoomCenter(factor) {
  const r = viewport.getBoundingClientRect();
  zoomAt(r.width / 2, r.height / 2, factor);
}
$('#z-in').addEventListener('click', () => zoomCenter(1.2));
$('#z-out').addEventListener('click', () => zoomCenter(1 / 1.2));
$('#z-reset').addEventListener('click', () => {
  // Recentre sur le contenu à 100 %
  fitViewToContent(1);
  markViewTouched();
});

/* ============================================================
   PANNEAU LATÉRAL — palette & devices
   ============================================================ */

function renderPalette() {
  const list = $('#device-list');
  list.innerHTML = '';

  // S'assurer que le WatchGuard permanent existe toujours
  ensureWatchGuard();

  state.devices.forEach(d => {
    const card = document.createElement('div');
    card.className = 'pal-card device-card';
    card.draggable = true;
    card.dataset.deviceId = d.id;
    card.innerHTML = `
      <div class="pal-thumb">
        ${d.photo
          ? `<img src="${d.photo}" alt="" draggable="false">`
          : `<span>${escapeHtml((d.name[0] || '?').toUpperCase())}</span>`}
      </div>
      <div class="pal-meta">
        <strong>${escapeHtml(d.name)}</strong>
        <small>${d.sizeU}U</small>
      </div>
      <div class="pal-actions">
        <button class="mini-edit" title="Modifier ce device">✏️</button>
        ${d.permanent ? '' : '<button class="mini-del" title="Supprimer ce modèle de device">✕</button>'}
      </div>`;

    card.addEventListener('dragstart', e => {
      dragPayload = { kind: 'device', deviceId: d.id, size: d.sizeU };
      e.dataTransfer.setData('application/x-dc-device', d.id);
      e.dataTransfer.effectAllowed = 'copy';
    });

    // Bouton modifier
    card.querySelector('.mini-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openEditDeviceModal(d);
    });

    // Bouton supprimer (seulement pour les devices non-permanents)
    if (!d.permanent) {
      card.querySelector('.mini-del').addEventListener('click', () => {
        if (confirm(`Supprimer le modèle "${d.name}" de la bibliothèque ?\n(Les exemplaires déjà placés sont conservés.)`)) {
          pushHistory();
          state.devices = state.devices.filter(x => x.id !== d.id);
          saveState();
          renderPalette();
        }
      });
    }

    list.appendChild(card);
  });
}

// Rack de la palette (taille choisie dans le menu déroulant)
$('#pal-rack').addEventListener('dragstart', e => {
  const sizeU = parseInt($('#new-rack-size').value, 10) || DEFAULT_RACK_U;
  dragPayload = { kind: 'rack', size: sizeU };
  e.dataTransfer.setData('application/x-dc-rack', '1');
  e.dataTransfer.effectAllowed = 'copy';
});
document.addEventListener('dragend', () => {
  dragPayload = null;
  document.querySelectorAll('.drop-hint').forEach(h => h.classList.add('hidden'));
});
document.addEventListener('dragstart', () => hideDevicePopover());

/* ============================================================
   BOARD — drop des baies
   ============================================================ */

viewport.addEventListener('dragover', e => {
  if (dragPayload && dragPayload.kind === 'rack') {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});

viewport.addEventListener('drop', e => {
  if (!dragPayload || dragPayload.kind !== 'rack') return;
  e.preventDefault();
  const p = clientToBoard(e.clientX, e.clientY);
  const sizeU = dragPayload.size || DEFAULT_RACK_U;
  const rack = normalizeRack({
    id: uid(),
    x: Math.max(0, Math.min(p.x - RACK_W / 2, BOARD_W - RACK_W)),
    y: Math.max(0, p.y - 30),
    sizeU,
    instances: []
  });
  rack.y = Math.max(0, Math.min(rack.y, BOARD_H - rackHeight(rack)));
  const ws = active();
  pushHistory();
  ws.racks.push(rack);
  touchWorkspace(ws);
  dragPayload = null;
  saveState();
  renderBoard();
});

function renderBoard() {
  board.innerHTML = '';
  hideDevicePopover();   // le device affiché vient d'être re-créé (ou supprimé)
  const ws = active();
  const empty = $('#board-empty');
  if (!ws) { empty.classList.add('hidden'); $('#topo-empty')?.classList.add('hidden'); $('#topo-toolbar')?.classList.add('hidden'); return; }
  if (boardMode === 'topo') { renderTopology(ws); return; }
  $('#topo-empty').classList.add('hidden');
  $('#topo-toolbar').classList.add('hidden');
  ws.racks.forEach(rack => board.appendChild(renderRack(rack)));
  empty.classList.toggle('hidden', ws.racks.length > 0);

  // Couche SVG des câbles (recréée à chaque rendu)
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.id = 'cable-svg';
  const temp = document.createElementNS(svgNS, 'path');
  temp.setAttribute('class', 'cable-temp');
  svg.appendChild(temp);
  board.appendChild(svg);

  renderCables();
}

/* ============================================================
   RACK
   ============================================================ */

function renderRack(rack) {
  const el = document.createElement('div');
  el.className = 'rack';
  el.dataset.rackId = rack.id;
  el.style.left = rack.x + 'px';
  el.style.top  = rack.y + 'px';

  // ---- En-tête ----
  const header = document.createElement('div');
  header.className = 'rack-header';
  header.innerHTML = `
    <span class="rack-led"></span>
    <span class="rack-title" title="Double-cliquez pour renommer"></span>
    <select class="rack-size-sel" title="Changer la taille du rack">
      ${RACK_SIZES.map(u => `<option value="${u}">${u}U</option>`).join('')}
    </select>
    <span class="rack-metrics"></span>
    <span class="rack-vents"></span>
    <button class="mini-del" title="Supprimer le rack">✕</button>`;
  el.appendChild(header);

  const titleEl = header.querySelector('.rack-title');
  titleEl.textContent = rack.name;
  const sizeSel = header.querySelector('.rack-size-sel');
  sizeSel.value = String(rack.sizeU);

  // Métriques de capacité : U occupés, puissance, poids (+ budgets, double-clic)
  const metricsEl = header.querySelector('.rack-metrics');
  {
    const usedU = rack.instances.reduce((s, i) => s + i.sizeU, 0);
    const watts = rack.instances.reduce((s, i) => s + (i.watts || 0), 0);
    const kg = rack.instances.reduce((s, i) => s + (i.weightKg || 0), 0);
    const wOver = rack.maxWatts > 0 && watts > rack.maxWatts;
    const kgOver = rack.maxKg > 0 && kg > rack.maxKg;
    let html = `<span class="rm rm-u${usedU >= rack.sizeU ? ' full' : ''}" ` +
      `title="Espace occupé : ${usedU}U sur ${rack.sizeU}U">${usedU}/${rack.sizeU}U</span>`;
    if (watts || rack.maxWatts) {
      html += `<span class="rm rm-w${wOver ? ' over' : ''}" data-metric="maxWatts"` +
        ` title="Puissance estimée : ${fmtWatts(watts)}${rack.maxWatts ? ' / budget ' + fmtWatts(rack.maxWatts) : ''} — double-cliquez pour définir le budget">` +
        `${fmtWatts(watts)}${rack.maxWatts ? ' / ' + fmtWatts(rack.maxWatts) : ''}</span>`;
    }
    if (kg || rack.maxKg) {
      html += `<span class="rm rm-kg${kgOver ? ' over' : ''}" data-metric="maxKg"` +
        ` title="Poids estimé : ${Math.round(kg)} kg${rack.maxKg ? ' / charge max ' + rack.maxKg + ' kg' : ''} — double-cliquez pour définir la charge max">` +
        `${Math.round(kg)} kg${rack.maxKg ? ' / ' + rack.maxKg : ''}</span>`;
    }
    metricsEl.innerHTML = html;
  }

  // Définition des budgets de capacité (double-clic sur un badge)
  metricsEl.addEventListener('dblclick', e => {
    const rm = e.target.closest('.rm[data-metric]');
    if (!rm) return;
    e.stopPropagation();
    const field = rm.dataset.metric;
    const isW = field === 'maxWatts';
    const val = prompt(isW
      ? 'Budget électrique du rack en watts (vide = aucun budget) :'
      : 'Charge maximale du rack en kg (vide = aucune limite) :',
      String(rack[field] || ''));
    if (val === null) return;
    const n = Math.max(0, parseFloat(String(val).replace(',', '.')) || 0);
    if (n === (rack[field] || 0)) return;
    pushHistory();
    rack[field] = n;
    touchWorkspace(active());
    saveState();
    renderBoard();
  });

  // Renommage : double-clic sur le titre
  titleEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    const name = prompt('Nom du rack :', rack.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === rack.name) return;
    pushHistory();
    rack.name = trimmed;
    touchWorkspace(active());
    saveState();
    renderBoard();
  });

  // Changement de taille
  sizeSel.addEventListener('change', e => {
    const newSize = parseInt(e.target.value, 10) || rack.sizeU;
    if (newSize === rack.sizeU) return;

    // Vérifier que les devices placés tiennent toujours
    const overflow = rack.instances.filter(i => i.slot + i.sizeU > newSize);
    if (overflow.length &&
        !confirm(`Passer en ${newSize}U va déloger ${overflow.length} device(s) qui ne tient/tiendront plus. Continuer ?`)) {
      sizeSel.value = String(rack.sizeU);
      return;
    }
    pushHistory();
    rack.sizeU = newSize;
    // Si le nom n'a jamais été personnalisé (forme "Rack 12U"), suivre la taille
    if (/^Rack \d+U$/.test(rack.name)) rack.name = `Rack ${newSize}U`;
    // Repousser les devices qui dépassent
    rack.instances.forEach(i => {
      i.slot = Math.min(i.slot, Math.max(0, newSize - i.sizeU));
    });
    rack.y = Math.max(0, Math.min(rack.y, BOARD_H - rackHeight(rack)));
    touchWorkspace(active());
    saveState();
    renderBoard();
  });

  // Déplacement du rack par son en-tête
  header.addEventListener('pointerdown', e => {
    if (e.target.closest('button, select, input')) return;
    e.stopPropagation(); // ne pas déclencher le pan du board
    const startX = e.clientX, startY = e.clientY;
    const ox = rack.x, oy = rack.y;
    let moved = false;
    header.setPointerCapture(e.pointerId);
    const onMove = ev => {
      moved = true;
      rack.x = Math.max(0, Math.min(ox + (ev.clientX - startX) / view.scale, BOARD_W - RACK_W));
      rack.y = Math.max(0, Math.min(oy + (ev.clientY - startY) / view.scale, BOARD_H - rackHeight(rack)));
      el.style.left = rack.x + 'px';
      el.style.top  = rack.y + 'px';
    };
    const onUp = () => {
      header.removeEventListener('pointermove', onMove);
      header.removeEventListener('pointerup', onUp);
      if (moved) {
        pushHistory();
        saveState();
      }
    };
    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', onUp);
  });

  header.querySelector('.mini-del').addEventListener('click', () => {
    if (confirm(`Supprimer le rack « ${rack.name} » et tous les devices qu'il contient ?`)) {
      pushHistory();
      const ws = active();
      ws.racks = ws.racks.filter(r => r.id !== rack.id);
      touchWorkspace(ws);
      saveState();
      renderBoard();
    }
  });

  // ---- Corps : règle U + montants + zone intérieure ----
  const bodyEl = document.createElement('div');
  bodyEl.className = 'rack-body';

  const frame = document.createElement('div');
  frame.className = 'rack-frame';

  // Règle des U (U<size> en haut … U1 en bas)
  const ruler = document.createElement('div');
  ruler.className = 'u-ruler';
  for (let i = 0; i < rack.sizeU; i++) {
    const u = document.createElement('div');
    u.className = 'u-label';
    u.textContent = rack.sizeU - i;
    ruler.appendChild(u);
  }
  frame.appendChild(ruler);

  // Montant gauche perforé
  const railL = document.createElement('div');
  railL.className = 'rail';
  frame.appendChild(railL);

  // Zone intérieure (hauteur = nombre d'U)
  const inner = document.createElement('div');
  inner.className = 'rack-inner';
  inner.style.height = (rack.sizeU * U_H) + 'px';

  const hint = document.createElement('div');
  hint.className = 'drop-hint hidden';
  inner.appendChild(hint);

  rack.instances.forEach(inst => inner.appendChild(renderDevice(rack, inst)));

  // --- Drag & drop des devices dans la baie ---
  inner.addEventListener('dragover', e => {
    if (!dragPayload || (dragPayload.kind !== 'device' && dragPayload.kind !== 'instance')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dragPayload.kind === 'device' ? 'copy' : 'move';

    const size = dragPayload.size;
    const excludeId = dragPayload.kind === 'instance' ? dragPayload.instId : null;
    const slot = slotFromPointer(inner, e.clientY, size, rack);
    const free = isSlotFree(rack, slot, size, excludeId);

    hint.style.top    = (slot * U_H) + 'px';
    hint.style.height = (size * U_H) + 'px';
    hint.classList.remove('hidden', 'ok', 'bad');
    hint.classList.add(free ? 'ok' : 'bad');
  });

  inner.addEventListener('dragleave', e => {
    if (!inner.contains(e.relatedTarget)) hint.classList.add('hidden');
  });

  inner.addEventListener('drop', e => {
    if (!dragPayload || (dragPayload.kind !== 'device' && dragPayload.kind !== 'instance')) return;
    e.preventDefault();
    e.stopPropagation();
    hint.classList.add('hidden');

    const size = dragPayload.size;
    const slot = slotFromPointer(inner, e.clientY, size, rack);
    const excludeId = dragPayload.kind === 'instance' ? dragPayload.instId : null;

    if (!isSlotFree(rack, slot, size, excludeId)) {
      dragPayload = null;
      return;
    }

    let changed = false;
    if (dragPayload.kind === 'device') {
      const tpl = state.devices.find(d => d.id === dragPayload.deviceId);
      if (tpl) {
        pushHistory();
        rack.instances.push({
          id: uid(),
          deviceId: tpl.id,
          name: tpl.name,
          sizeU: tpl.sizeU,
          photo: tpl.photo,
          slot,
          brand: tpl.brand || '',
          model: tpl.model || '',
          partRef: tpl.partRef || '',
          serial: tpl.serial || '',
          ipMgmt: tpl.ipMgmt || '',
          vlan: tpl.vlan || '',
          watts: tpl.watts || 0,
          weightKg: tpl.weightKg || 0,
          ports: (tpl.ports || []).map(p => ({
            id: uid(), xPct: p.xPct, yPct: p.yPct,
            name: p.name, label: p.label || '', size: p.size || 1,
            ip: p.ip || '', vlan: p.vlan || ''
          }))
        });
        changed = true;
      }
    } else {
      // déplacement d'un device déjà placé (vers un autre étage / un autre rack)
      let oldRack = null;
      for (const w of state.workspaces) {
        oldRack = w.racks.find(r => r.instances.some(i => i.id === dragPayload.instId));
        if (oldRack) break;
      }
      if (oldRack) {
        const inst = oldRack.instances.find(i => i.id === dragPayload.instId);
        const same = oldRack === rack && inst && inst.slot === slot;
        if (!same) {
          pushHistory();
          const idx = oldRack.instances.findIndex(i => i.id === dragPayload.instId);
          const [moved] = oldRack.instances.splice(idx, 1);
          moved.slot = slot;
          rack.instances.push(moved);
          changed = true;
        }
      }
    }

    dragPayload = null;
    if (changed) {
      touchWorkspace(active());
      saveState();
      renderBoard();
    }
  });

  // --- Réamorçage du drag depuis un device placé ---
  inner.addEventListener('dragstart', e => {
    const devEl = e.target.closest('.device');
    if (!devEl || labelMode || cablingMode) { e.preventDefault(); return; }
    const instId = devEl.dataset.instanceId;
    const inst = rack.instances.find(i => i.id === instId);
    if (!inst) return;
    dragPayload = { kind: 'instance', rackId: rack.id, instId, size: inst.sizeU };
    e.dataTransfer.setData('application/x-dc-instance', instId);
    e.dataTransfer.effectAllowed = 'move';
  });

  // --- Clics : retrait device / étiquetage ---
  inner.addEventListener('click', e => {
    const delBtn = e.target.closest('.device-del');
    if (delBtn) {
      const devEl = delBtn.closest('.device');
      pushHistory();
      rack.instances = rack.instances.filter(i => i.id !== devEl.dataset.instanceId);
      touchWorkspace(active());
      saveState();
      renderBoard();
      return;
    }

    const devEl = e.target.closest('.device');
    if (!devEl) return;
    e.stopPropagation();

    const inst = rack.instances.find(i => i.id === devEl.dataset.instanceId);
    if (!inst) return;

    const portEl = e.target.closest('.port');
    const port = portEl ? inst.ports.find(p => p.id === portEl.dataset.portId) : null;

    // Priorité au mode câblage : cliquer un port relie les ports
    if (cablingMode) {
      if (port) handlePortClickCabling(e.clientX, e.clientY, rack, inst, port);
      return;
    }

    // Après un glisser-déposer de port : ignorer le clic qui suit
    if (suppressPortClick) { suppressPortClick = false; return; }

    if (!labelMode) return;

    if (labelMode === 'edit') {
      // Modification : seulement sur un port existant
      if (port) openPortPopover(e.clientX, e.clientY, rack, inst, port);
      return;
    }

    // Création : sur un port existant on l'édite quand même, sinon nouveau port
    if (port) {
      openPortPopover(e.clientX, e.clientY, rack, inst, port);
    } else {
      const r = devEl.getBoundingClientRect();
      const xPct = ((e.clientX - r.left) / r.width) * 100;
      const yPct = ((e.clientY - r.top) / r.height) * 100;
      openPortPopover(e.clientX, e.clientY, rack, inst, null, xPct, yPct);
    }
  });

  frame.appendChild(inner);

  // Montant droit perforé
  const railR = document.createElement('div');
  railR.className = 'rail';
  frame.appendChild(railR);

  bodyEl.appendChild(frame);
  el.appendChild(bodyEl);
  return el;
}

/* ---------- Device (exemplaire monté dans une baie) ---------- */
function renderDevice(rack, inst) {
  const dev = document.createElement('div');
  dev.className = 'device';
  dev.dataset.instanceId = inst.id;
  dev.style.top    = (inst.slot * U_H) + 'px';
  dev.style.height = (inst.sizeU * U_H) + 'px';
  // En mode Port (créer/modifier) et en mode Câblage, les devices ne sont
  // pas déplaçables : cela évite que le glisser natif n'avale les clics de ports.
  dev.draggable = !labelMode && !cablingMode;

  if (inst.photo) {
    const img = document.createElement('img');
    img.src = inst.photo;
    img.alt = inst.name;
    img.draggable = false;
    dev.appendChild(img);
  } else {
    const face = document.createElement('div');
    face.className = 'device-nophoto';
    face.innerHTML = `
      <span class="nophoto-led"></span>
      <span class="nophoto-led dim"></span>
      <span class="nophoto-label">${escapeHtml(inst.name)} · ${inst.sizeU}U</span>`;
    dev.appendChild(face);
  }

  // Ports
  (inst.ports || []).forEach(p => {
    const port = document.createElement('div');
    port.className = 'port' + (cablingMode ? ' connectable' : '');
    port.dataset.portId = p.id;
    port.style.left = p.xPct + '%';
    port.style.top  = p.yPct + '%';
    port.dataset.size = p.size || 1;
    port.style.width = (26 * (p.size || 1)) + 'px';
    port.style.height = (26 * (p.size || 1)) + 'px';
    dev.appendChild(port);
  });

  // Bouton de retrait
  const del = document.createElement('button');
  del.className = 'device-del';
  del.title = 'Retirer du rack';
  del.textContent = '✕';
  dev.appendChild(del);

  return dev;
}

/* ---------- Calcul d'emplacement (indépendant du zoom) ---------- */
function slotFromPointer(inner, clientY, size, rack) {
  const rect = inner.getBoundingClientRect();
  const rackU = rack?.sizeU || DEFAULT_RACK_U;
  // position relative en U (le rect tient compte de l'échelle du board)
  const uPos = ((clientY - rect.top) / rect.height) * rackU;
  // centre du device sur le pointeur
  let slot = Math.round(uPos - size / 2);
  return Math.max(0, Math.min(slot, rackU - size));
}

function isSlotFree(rack, slot, size, excludeInstId) {
  for (let i = slot; i < slot + size; i++) {
    const occupied = rack.instances.find(inst =>
      inst.id !== excludeInstId && inst.slot <= i && i < inst.slot + inst.sizeU);
    if (occupied) return false;
  }
  return true;
}

/* ============================================================
   MODE ÉTIQUETAGE — ports
   ============================================================ */

// Menu "Port et étiquetage" : choix Créer ou Modifier
$('#btn-label').addEventListener('click', e => {
  e.stopPropagation();
  $('#label-menu').classList.toggle('hidden');
});
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.port-mode-wrap')) $('#label-menu').classList.add('hidden');
});

function setLabelMode(mode) {
  labelMode = mode;                       // null | 'create' | 'edit'
  document.body.classList.toggle('label-create', mode === 'create');
  document.body.classList.toggle('label-edit', mode === 'edit');
  document.body.classList.remove('labeling');

  const btn = $('#btn-label');
  btn.classList.toggle('active', mode === 'create');
  btn.classList.toggle('active-edit', mode === 'edit');

  // Coche de l'option active dans le menu
  $('#label-create').classList.toggle('checked', mode === 'create');
  $('#label-edit').classList.toggle('checked', mode === 'edit');

  // Mode câblage exclusif
  if (mode && cablingMode) setCablingMode(false);

  $('#mode-hint').textContent = mode === 'create'
    ? 'Mode Création : cliquez sur la face avant d\'un device pour placer un nouveau port.'
    : mode === 'edit'
    ? 'Mode Modification : cliquez sur un port pour changer son nom, son étiquette ou sa taille. Glissez-le pour le déplacer.'
    : 'Glissez un rack sur le board, puis ajoutez vos devices.';

  hidePortPopover();
  $('#label-menu').classList.add('hidden');
  renderBoard();
}

$('#label-create').addEventListener('click', () => setLabelMode('create'));
$('#label-edit').addEventListener('click', () => setLabelMode('edit'));

function openPortPopover(clientX, clientY, rack, inst, port, xPct = null, yPct = null) {
  const pop = $('#port-popover');
  const isNew = !port;
  popoverCtx = {
    rack, inst, port,
    xPct: port ? port.xPct : xPct,
    yPct: port ? port.yPct : yPct,
    previewEl: null
  };

  $('#pp-title').textContent = isNew ? 'Nouveau port' : 'Modifier le port';
  $('#p-name').value  = port ? port.name  : '';
  $('#p-label').value = port ? port.label : '';
  $('#p-ip').value    = port ? (port.ip || '') : '';
  $('#p-vlan').value  = port ? (port.vlan || '') : '';

  // Curseur de taille en pourcentage (50 % – 250 %)
  const baseSize = port?.size ?? 1;
  const slider = $('#p-size');
  slider.value = String(Math.round(baseSize * 100));
  $('#p-size-val').textContent = slider.value + '%';

  $('#p-delete').classList.toggle('hidden', isNew);
  pop.classList.remove('hidden');

  // --- Aperçu en direct à 50 % de transparence ---
  if (isNew) {
    // Port fantôme créé à l'endroit cliqué, encore non enregistré
    const devEl = board.querySelector(`.device[data-instance-id="${inst.id}"]`);
    const ghost = document.createElement('div');
    ghost.className = 'port port-preview';
    ghost.style.left = xPct + '%';
    ghost.style.top  = yPct + '%';
    applyPortSize(ghost, baseSize);
    devEl?.appendChild(ghost);
    popoverCtx.previewEl = ghost;
  } else {
    // Port existant : on le passe en aperçu transparent pendant le réglage
    const el = board.querySelector(`.port[data-port-id="${port.id}"]`);
    if (el) {
      el.classList.add('port-preview');
      popoverCtx.previewEl = el;
    }
  }

  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = clientX + 14, y = clientY + 14;
  if (x + w > window.innerWidth - 10)  x = clientX - w - 14;
  if (y + h > window.innerHeight - 10) y = clientY - h - 14;
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top  = Math.max(8, y) + 'px';

  $('#p-name').focus();
}

// Applique une taille (facteur d'échelle) à un élément port
function applyPortSize(el, size) {
  const s = 26 * size;
  el.style.width = s + 'px';
  el.style.height = s + 'px';
  el.dataset.size = size;
}

// Réglage en direct de la taille via le curseur
$('#p-size').addEventListener('input', () => {
  const pct = parseInt($('#p-size').value, 10);
  $('#p-size-val').textContent = pct + '%';
  if (popoverCtx?.previewEl) applyPortSize(popoverCtx.previewEl, pct / 100);
});

// Nettoyage de l'aperçu (appelé par enregistrer / annuler / fermer)
function clearPortPreview() {
  if (!popoverCtx) return;
  const { previewEl, port } = popoverCtx;
  if (previewEl) {
    if (!port) {
      // Port fantôme non enregistré -> suppression
      previewEl.remove();
    } else {
      // Port existant -> retrait de l'aperçu et restauration de sa taille réelle
      previewEl.classList.remove('port-preview');
      applyPortSize(previewEl, port.size || 1);
    }
  }
}

function hidePortPopover() {
  clearPortPreview();
  $('#port-popover').classList.add('hidden');
  popoverCtx = null;
}

$('#p-save').addEventListener('click', () => {
  if (!popoverCtx) return;
  const name = $('#p-name').value.trim();
  const label = $('#p-label').value.trim();
  if (!name) { $('#p-name').focus(); return; }
  const ip = $('#p-ip').value.trim().slice(0, 50);
  const vlan = $('#p-vlan').value.trim().slice(0, 30);

  const { inst, port, xPct, yPct } = popoverCtx;
  const size = Math.round(parseInt($('#p-size').value, 10)) / 100 || 1;
  pushHistory();
  if (port) {
    port.name = name;
    port.label = label;
    port.size = size;
    port.ip = ip;
    port.vlan = vlan;
  } else {
    inst.ports.push({ id: uid(), xPct, yPct, name, label, size, ip, vlan });
  }
  hidePortPopover();
  touchWorkspace(active());
  saveState();
  renderBoard();
});

$('#p-delete').addEventListener('click', () => {
  if (!popoverCtx || !popoverCtx.port) return;
  const { inst, port } = popoverCtx;
  pushHistory();
  inst.ports = inst.ports.filter(p => p.id !== port.id);
  hidePortPopover();
  touchWorkspace(active());
  saveState();
  renderBoard();
});

$('#p-cancel').addEventListener('click', hidePortPopover);

// Clic en dehors du popover = annulation
document.addEventListener('pointerdown', e => {
  const pop = $('#port-popover');
  if (popoverCtx && !pop.contains(e.target) && !e.target.closest('.port') &&
      !(labelMode && e.target.closest('.device'))) {
    hidePortPopover();
  }
}, true);

// Entrée = enregistrer, Échap = annuler
$('#port-popover').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#p-save').click();
  if (e.key === 'Escape') hidePortPopover();
});

/* ---------- Infobulle des ports au survol ---------- */
const tooltip = $('#tooltip');

board.addEventListener('mouseover', e => {
  const portEl = e.target.closest('.port');
  if (!portEl) return;
  const rackEl = portEl.closest('.rack');
  const devEl  = portEl.closest('.device');
  const rack = active()?.racks.find(r => r.id === rackEl.dataset.rackId);
  const inst = rack?.instances.find(i => i.id === devEl.dataset.instanceId);
  const port = inst?.ports.find(p => p.id === portEl.dataset.portId);
  if (!port) return;

  tooltip.innerHTML = `
    <div class="tt-name">🔌 ${escapeHtml(port.name)}</div>
    ${port.label ? `<div class="tt-label">${escapeHtml(port.label)}</div>` : ''}
    ${port.ip ? `<div class="tt-meta">🌐 ${escapeHtml(port.ip)}</div>` : ''}
    ${port.vlan ? `<div class="tt-meta">🏷️ VLAN ${escapeHtml(port.vlan)}</div>` : ''}`;
  tooltip.classList.remove('hidden');

  const rect = portEl.getBoundingClientRect();
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let x = rect.left + rect.width / 2 - tw / 2;
  let y = rect.top - th - 9;
  if (y < 8) y = rect.bottom + 9;
  x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  tooltip.style.left = x + 'px';
  tooltip.style.top  = y + 'px';
});

board.addEventListener('mouseout', e => {
  const portEl = e.target.closest('.port');
  if (portEl && (!e.relatedTarget || !portEl.contains(e.relatedTarget))) {
    tooltip.classList.add('hidden');
  }
});

/* ---------- Déplacement d'un port par glisser (mode Port et étiquetage) ---------- */
board.addEventListener('pointerdown', e => {
  if (labelMode !== 'edit' || e.button !== 0) return;
  const portEl = e.target.closest('.port');
  if (!portEl) return;
  // On n'agresse pas le mode câblage
  if (cablingMode) return;
  const devEl = portEl.closest('.device');
  const rackEl = portEl.closest('.rack');
  const ws = active();
  if (!ws) return;
  const rack = ws.racks.find(r => r.id === rackEl.dataset.rackId);
  const inst = rack?.instances.find(i => i.id === devEl.dataset.instanceId);
  const port = inst?.ports.find(p => p.id === portEl.dataset.portId);
  if (!rack || !inst || !port) return;

  e.preventDefault();
  e.stopPropagation();
  tooltip.classList.add('hidden');
  hidePortPopover();
  board.setPointerCapture(e.pointerId);

  const startX = e.clientX, startY = e.clientY;
  let dragging = false;

  const onMove = ev => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    if (!dragging) {
      dragging = true;
      pushHistory();
      portEl.classList.add('dragging');
    }
    const r = devEl.getBoundingClientRect();
    let xPct = ((ev.clientX - r.left) / r.width) * 100;
    let yPct = ((ev.clientY - r.top) / r.height) * 100;
    // Borné au device (le port ne peut pas sortir de la face avant)
    xPct = Math.max(0, Math.min(100, xPct));
    yPct = Math.max(0, Math.min(100, yPct));
    port.xPct = xPct;
    port.yPct = yPct;
    portEl.style.left = xPct + '%';
    portEl.style.top  = yPct + '%';
  };
  const onUp = ev => {
    board.removeEventListener('pointermove', onMove);
    board.removeEventListener('pointerup', onUp);
    portEl.classList.remove('dragging');
    // Empêche le handler de clic de traiter aussi ce relâchement
    suppressPortClick = true;
    setTimeout(() => { suppressPortClick = false; }, 0);

    if (dragging) {
      // Glisser-déposer : déplacement du port
      touchWorkspace(ws);
      saveState();
      renderBoard();   // re-rend pour mettre à jour les câbles
    } else if (labelMode === 'edit') {
      // Simple clic sur un port : ouvrir la fenêtre d'édition
      openPortPopover(ev.clientX, ev.clientY, rack, inst, port);
    }
  };
  board.addEventListener('pointermove', onMove);
  board.addEventListener('pointerup', onUp);
});

/* ============================================================
   DÉTECTION AUTOMATIQUE DE PORTS SUR LA PHOTO DE FACE AVANT
   ------------------------------------------------------------
   Analyse l'image (aucune librairie externe) :
     1. Masques de contraste : localement plus sombre ou plus
        clair que le voisinage (image intégrale), + seuils
        globaux en secours — gère ports noirs sur panneau
        blanc, blancs sur panneau sombre, sombres sur sombre…
     2. Érosion binaire : sépare les ports collés entre eux.
     3. Composantes connexes : un blob = un port candidat.
     4. Filtres géométriques : taille, ratio, remplissage.
     5. Rangées horizontales + chaînes régulières : élimine
        le bruit (aérations, logos, texte).
   Renvoie [{ cx, cy, pw, ph }] en pixels image, triées en
   ordre de lecture (haut→bas, gauche→droite).
   ============================================================ */

const PortDetect = (() => {

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  }

  function grayscale(data, W, H) {
    const g = new Float32Array(W * H);
    for (let i = 0, p = 0; i < g.length; i++, p += 4)
      g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    return g;
  }

  function percentile(g, pct) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i] | 0]++;
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= g.length * pct) return v; }
    return 255;
  }

  // Image intégrale (moyenne locale en O(1) par pixel)
  function integral(g, W, H) {
    const I = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) {
      let rs = 0;
      for (let x = 0; x < W; x++) {
        rs += g[y * W + x];
        I[(y + 1) * (W + 1) + (x + 1)] = I[y * (W + 1) + (x + 1)] + rs;
      }
    }
    return I;
  }
  function localMean(I, W, H, x, y, r) {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
    const x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
    return (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] -
            I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  }

  // Érosion binaire séparable (carré (2r+1)²)
  function erode(mask, W, H, r) {
    if (r <= 0) return mask;
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let on = 1;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= W || !mask[row + xx]) { on = 0; break; }
        }
        tmp[row + x] = on;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let on = 1;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= H || !tmp[yy * W + x]) { on = 0; break; }
        }
        out[y * W + x] = on;
      }
    }
    return out;
  }

  // Composantes connexes 4-connexité (BFS) — bbox + aire
  function blobs(mask, W, H) {
    const labels = new Int32Array(W * H).fill(-1);
    const out = [], stack = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start] !== -1) continue;
      const id = out.length;
      stack.length = 0; stack.push(start); labels[start] = id;
      let minX = W, maxX = 0, minY = H, maxY = 0, area = 0;
      while (stack.length) {
        const idx = stack.pop();
        const x = idx % W, y = (idx / W) | 0;
        area++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x > 0     && mask[idx - 1] && labels[idx - 1] === -1) { labels[idx - 1] = id; stack.push(idx - 1); }
        if (x < W - 1 && mask[idx + 1] && labels[idx + 1] === -1) { labels[idx + 1] = id; stack.push(idx + 1); }
        if (y > 0     && mask[idx - W] && labels[idx - W] === -1) { labels[idx - W] = id; stack.push(idx - W); }
        if (y < H - 1 && mask[idx + W] && labels[idx + W] === -1) { labels[idx + W] = id; stack.push(idx + W); }
      }
      out.push({ minX, minY, maxX, maxY, area,
                 w: maxX - minX + 1, h: maxY - minY + 1,
                 cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 });
    }
    return out;
  }

  function cvGaps(items) {
    const gaps = [];
    for (let i = 1; i < items.length; i++) gaps.push(items[i].cx - items[i - 1].cx);
    const m = median(gaps.filter(x => x > 2));
    if (!m) return 9;
    return Math.sqrt(gaps.reduce((s, x) => s + (x - m) ** 2, 0) / gaps.length) / m;
  }

  // Rangées horizontales par chaînage de membre + garde anti-diagonale
  function buildRows(cands) {
    const sorted = [...cands].sort((a, b) => a.cy - b.cy);
    const rows = [];
    for (const b of sorted) {
      let best = null;
      for (const r of rows) {
        const tol = Math.max(r.phMed * 0.75, 7);
        let nd = 1e9;
        for (const m of r.items) { const d = Math.abs(m.cy - b.cy); if (d < nd) nd = d; }
        if (nd < tol && (!best || nd < best.nd)) best = { r, nd };
      }
      if (best) {
        best.r.items.push(b);
        best.r.phMed = median(best.r.items.map(i => i.ph));
        best.r.cy = best.r.items.reduce((s, i) => s + i.cy, 0) / best.r.items.length;
      } else {
        rows.push({ cy: b.cy, items: [b], phMed: b.ph });
      }
    }
    rows.forEach(r => r.items.sort((a, b) => a.cx - b.cx));
    return rows.filter(r => {
      const ys = r.items.map(i => i.cy);
      return Math.max(...ys) - Math.min(...ys) <= Math.max(r.phMed * 1.3, 8);
    }).sort((a, b) => a.cy - b.cy);
  }

  // Chaînes régulièrement espacées (les îlots isolés sont du bruit)
  function keepChains(items) {
    if (items.length <= 4) return items;
    const gaps = [];
    for (let i = 1; i < items.length; i++) gaps.push(items[i].cx - items[i - 1].cx);
    const pitch = median(gaps.filter(x => x > 2));
    const cs = [[items[0]]];
    for (let i = 1; i < items.length; i++) {
      const gp = items[i].cx - items[i - 1].cx;
      if (gp <= Math.max(pitch * 1.9, pitch + 6)) cs[cs.length - 1].push(items[i]);
      else cs.push([items[i]]);
    }
    const kept = cs.filter(c => c.length >= 2);
    return kept.length ? kept.flat() : cs.sort((a, b) => b.length - a.length)[0];
  }

  function sizeOutliers(items) {
    if (items.length < 5) return items;
    const pwM = median(items.map(i => i.pw)), phM = median(items.map(i => i.ph));
    return items.filter(i => Math.abs(i.pw - pwM) <= pwM * 0.45 && Math.abs(i.ph - phM) <= phM * 0.45);
  }

  // ---- Détection principale : renvoie les rangées retenues ----
  function detect(imageData) {
    const W = imageData.width, H = imageData.height;
    if (W < 220 || H < 60) return null;          // trop petit : pas fiable
    const data = imageData.data;
    const g = grayscale(data, W, H);
    const scale = W / 600;
    const I = integral(g, W, H);
    const minPW = Math.max(5, Math.round(W * 0.022));
    const minPH = Math.max(5, Math.round(W * 0.020));
    const localR = [Math.round(Math.max(8, W / 40)), Math.round(Math.max(8, W / 16))];

    const variants = [];
    for (const type of ['ldark', 'lbright', 'gdark', 'gbright']) {
      for (let vi = 0; vi < 2; vi++) {
        let mask = new Uint8Array(W * H);
        if (type === 'ldark' || type === 'lbright') {
          const r = localR[vi], delta = 12;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const lm = localMean(I, W, H, x, y, r), v = g[y * W + x];
            mask[y * W + x] = type === 'ldark' ? (v < lm - delta ? 1 : 0) : (v > lm + delta ? 1 : 0);
          }
        } else {
          const pct = type === 'gdark' ? (vi === 0 ? 0.18 : 0.32) : (vi === 0 ? 0.82 : 0.68);
          const thr = percentile(g, pct);
          for (let i = 0; i < g.length; i++)
            mask[i] = type === 'gdark' ? (g[i] <= thr ? 1 : 0) : (g[i] >= thr ? 1 : 0);
        }
        for (const r of [Math.max(1, Math.round(scale * 2)), Math.max(1, Math.round(scale * 3))]) {
          const er = erode(mask, W, H, r);
          const cands = [];
          for (const b of blobs(er, W, H)) {
            const pw = b.w + 2 * r, ph = b.h + 2 * r;
            if (pw < minPW || pw > W * 0.30 || ph < minPH || ph > H * 0.55) continue;
            const ar = pw / ph;
            if (ar < 0.5 || ar > 2.8) continue;
            if (b.area / (b.w * b.h) < 0.45) continue;
            cands.push({ ...b, pw, ph });
          }
          variants.push({ cands });
        }
      }
    }

    let best = null;
    for (const v of variants) {
      if (!v.cands.length) continue;
      let rows = buildRows(v.cands)
        .map(r => { r.items = sizeOutliers(keepChains(r.items)); return r; })
        .filter(r => r.items.length);

      let sel = rows.filter(r => r.items.length >= 3 && cvGaps(r.items) <= 0.40);
      let n = sel.reduce((s, r) => s + r.items.length, 0);
      if (n < 12) {
        for (const r2 of rows.filter(r => r.items.length === 2 && !sel.includes(r2))) sel.push(r2);
        n = sel.reduce((s, r) => s + r.items.length, 0);
      }
      if (!n) continue;

      // Cohérence de taille entre rangées (garde-fou anti-bruit)
      if (n >= 12 && sel.length > 1) {
        const all = sel.flatMap(r => r.items);
        const pwG = median(all.map(i => i.pw)), phG = median(all.map(i => i.ph));
        sel = sel.filter(r => {
          const pwM = median(r.items.map(i => i.pw)), phM = median(r.items.map(i => i.ph));
          return Math.abs(pwM - pwG) <= pwG * 0.35 && Math.abs(phM - phG) <= phG * 0.35;
        });
        n = sel.reduce((s, r) => s + r.items.length, 0);
        if (!n) continue;
      }
      if (n > 96) continue;                       // garde-fou : photo type grille d'aération

      let reg = 0, cnt = 0;
      for (const r of sel) if (r.items.length >= 3) { reg += Math.max(0, 1 - cvGaps(r.items)); cnt++; }
      reg = cnt ? reg / cnt : 0.5;
      if (n > 6 && reg < 0.45) continue;          // trop chaotique : on ne devine pas

      const score = n * (0.5 + reg / 2);
      if (!best || score > best.score) best = { rows: sel, n, reg, score };
    }
    return best;
  }

  // ---- API : positions en % + taille suggérée ----
  function portsFromImageData(imageData) {
    const best = detect(imageData);
    if (!best || best.n < 1) return [];
    const W = imageData.width, H = imageData.height;
    const rows = best.rows;                       // triées haut→bas, items gauche→droite
    const maxCols = Math.max(...rows.map(r => r.items.length));
    // taille des carrés « port » selon la densité (pour tenir dans la baie)
    const size = maxCols <= 4 ? 1 : maxCols <= 8 ? 0.8 : maxCols <= 12 ? 0.65
               : maxCols <= 16 ? 0.5 : maxCols <= 26 ? 0.4 : 0.3;
    const ports = [];
    for (const r of rows) for (const it of r.items)
      ports.push({ xPct: (it.cx / W) * 100, yPct: (it.cy / H) * 100, size });
    return ports;
  }

  return { portsFromImageData };
})();

// Charge une dataURL, renvoie l'ImageData correspondante
function imageDataFromUrl(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c.getContext('2d').getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/* ============================================================
   CRÉATION D'UN DEVICE (modale)
   ============================================================ */

let modalPhoto = null;

let modalPorts = [];          // ports détectés sur la photo [{xPct,yPct,size}]

const D_INV_IDS = ['#d-brand', '#d-model', '#d-ref', '#d-serial', '#d-ip', '#d-vlan'];

$('#btn-new-device').addEventListener('click', () => {
  editingDeviceId = null;
  $('#device-modal-title').textContent = 'Nouveau device';
  $('#d-save').textContent = 'Créer le device';
  $('#d-name').value = '';
  $('#d-size').value = '1';
  D_INV_IDS.forEach(id => { $(id).value = ''; });
  $('#d-watts').value = '';
  $('#d-kg').value = '';
  $('#d-photo').value = '';
  $('#d-preview').classList.add('hidden');
  $('#d-detect').classList.add('hidden');
  modalPhoto = null;
  modalPorts = [];
  $('#device-modal').classList.remove('hidden');
  $('#d-name').focus();
});

// Fonction pour ouvrir la modale en mode édition
let editingDeviceId = null;

function openEditDeviceModal(device) {
  editingDeviceId = device.id;
  $('#device-modal-title').textContent = 'Modifier le device';
  $('#d-save').textContent = 'Enregistrer les modifications';
  $('#d-name').value = device.name;
  $('#d-size').value = String(device.sizeU);
  $('#d-brand').value = device.brand || '';
  $('#d-model').value = device.model || '';
  $('#d-ref').value = device.partRef || '';
  $('#d-serial').value = device.serial || '';
  $('#d-ip').value = device.ipMgmt || '';
  $('#d-vlan').value = device.vlan || '';
  $('#d-watts').value = device.watts || '';
  $('#d-kg').value = device.weightKg || '';
  $('#d-photo').value = '';
  modalPhoto = device.photo || null;
  modalPorts = [];

  // Afficher l'aperçu de la photo existante et lancer la détection
  if (modalPhoto) {
    showPhotoPreviewAndDetect(modalPhoto, device.id);
  } else if (device.id === WATCHGUARD_ID) {
    // Pour le WatchGuard, essayer de charger la photo si elle n'est pas encore en mémoire
    loadWatchGuardPhoto().then(() => {
      const wg = state.devices.find(d => d.id === WATCHGUARD_ID);
      if (wg?.photo) {
        modalPhoto = wg.photo;
        showPhotoPreviewAndDetect(modalPhoto, device.id);
      }
    });
  } else {
    $('#d-preview').classList.add('hidden');
    $('#d-detect').classList.add('hidden');
  }

  $('#device-modal').classList.remove('hidden');
  $('#d-name').focus();
}

// Afficher l'aperçu de la photo et lancer la détection de ports
function showPhotoPreviewAndDetect(photoDataUrl, deviceId = null) {
  const prev = $('#d-preview');
  const img = prev.querySelector('img');
  img.src = photoDataUrl;
  prev.classList.remove('hidden');
  // Lancer la détection automatique des ports
  detectPortsFromPhoto(photoDataUrl, deviceId);
}

// Fonction pour détecter les ports depuis une photo (réutilisable)
async function detectPortsFromPhoto(photoDataUrl, deviceId = null) {
  modalPorts = [];
  const detectBox = $('#d-detect');
  detectBox.classList.add('hidden');
  const overlay = $('#d-overlay');
  overlay.innerHTML = '';

  if (!photoDataUrl) return;

  const id = await imageDataFromUrl(photoDataUrl);
  let ports = [];
  try { ports = PortDetect.portsFromImageData(id); } catch (err) { console.warn('Détection de ports échouée', err); }
  
  // Pour le WatchGuard, forcer la taille des ports à 40%
  if (deviceId === WATCHGUARD_ID) {
    ports = ports.map(p => ({ ...p, size: 0.4 }));
  }
  
  modalPorts = ports;

  // Carrés d'aperçu positionnés en % sur la photo
  for (const p of ports) {
    const sq = document.createElement('div');
    sq.className = 'd-dq';
    sq.style.left = p.xPct + '%';
    sq.style.top  = p.yPct + '%';
    overlay.appendChild(sq);
  }
  $('#d-detect-count').textContent = ports.length
    ? `${ports.length} port${ports.length > 1 ? 's' : ''} détecté${ports.length > 1 ? 's' : ''} sur la photo`
    : 'Aucun port détecté — vous pourrez en placer manuellement (mode Étiquetage)';
  $('#d-ports-use').checked = ports.length > 0;
  $('#d-ports-use').disabled = ports.length === 0;
  detectBox.classList.remove('hidden');
}

$('#d-cancel').addEventListener('click', () => $('#device-modal').classList.add('hidden'));
$('#device-modal').addEventListener('click', e => {
  if (e.target === $('#device-modal')) $('#device-modal').classList.add('hidden');
});

$('#d-photo').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  modalPhoto = await readAndDownscale(file);
  const prev = $('#d-preview');
  const img = prev.querySelector('img');
  img.src = modalPhoto;
  // attendre le chargement pour caler le wrapper sur le ratio réel de la photo
  await new Promise(res => {
    if (img.complete && img.naturalWidth) return res();
    img.addEventListener('load', res, { once: true });
    img.addEventListener('error', res, { once: true });
  });
  const inner = $('#d-preview-inner');
  if (img.naturalWidth) {
    const maxW = prev.clientWidth || 300, maxH = 150;
    const ar = img.naturalWidth / img.naturalHeight;
    const h = Math.min(maxH, maxW / ar);
    inner.style.width = Math.round(h * ar) + 'px';
    inner.style.height = Math.round(h) + 'px';
  }
  prev.classList.remove('hidden');

  // --- Détection automatique des ports sur la photo ---
  await detectPortsFromPhoto(modalPhoto, editingDeviceId);
});

$('#d-save').addEventListener('click', () => {
  const name = $('#d-name').value.trim();
  if (!name) { $('#d-name').focus(); return; }
  const sizeU = parseInt($('#d-size').value, 10) || 1;
  const usePorts = $('#d-ports-use').checked && modalPorts.length > 0;
  const inv = {
    brand: $('#d-brand').value.trim().slice(0, 40),
    model: $('#d-model').value.trim().slice(0, 60),
    partRef: $('#d-ref').value.trim().slice(0, 60),
    serial: $('#d-serial').value.trim().slice(0, 60),
    ipMgmt: $('#d-ip').value.trim().slice(0, 45),
    vlan: $('#d-vlan').value.trim().slice(0, 60),
    watts: Math.max(0, parseFloat(String($('#d-watts').value).replace(',', '.')) || 0),
    weightKg: Math.max(0, parseFloat(String($('#d-kg').value).replace(',', '.')) || 0)
  };

  pushHistory();

  if (editingDeviceId) {
    // Mode édition : mettre à jour le device existant
    const device = state.devices.find(d => d.id === editingDeviceId);
    if (device) {
      device.name = name;
      device.sizeU = sizeU;
      Object.assign(device, inv);
      if (modalPhoto !== null) {
        device.photo = modalPhoto;
      }
      if (usePorts) {
        device.ports = modalPorts.map((p, i) => ({
          id: uid(), xPct: p.xPct, yPct: p.yPct, name: String(i + 1), label: '', size: p.size || 1
        }));
      }
    }
  } else {
    // Mode création : ajouter un nouveau device
    state.devices.push({
      id: uid(), name, sizeU, photo: modalPhoto, ...inv,
      ports: usePorts ? modalPorts.map((p, i) => ({
        id: uid(), xPct: p.xPct, yPct: p.yPct, name: String(i + 1), label: '', size: p.size || 1
      })) : []
    });
  }

  saveState();
  renderPalette();
  $('#device-modal').classList.add('hidden');
  editingDeviceId = null;
});

// Lecture + redimensionnement de l'image (pour tenir en localStorage)
function readAndDownscale(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxW = 600;
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/* ============================================================
   POPOVER D'INFOS DEVICE — au survol d'un device posé
   ------------------------------------------------------------
   Affiche une fiche (nom, taille, position, ports) à côté du
   device. Chaque valeur est modifiable en double-cliquant
   dessus (Entrée valide, Échap annule). Les changements de
   taille / d'étage vérifient les collisions dans le rack.
   ============================================================ */

let dpCtx = null;                 // { rackId, instId } du device affiché
let dpShowTimer = null;
let dpHideTimer = null;
let dpErrTimer = null;

function dpFind() {
  const ws = active();
  if (!ws || !dpCtx) return {};
  const rack = ws.racks.find(r => r.id === dpCtx.rackId);
  const inst = rack?.instances.find(i => i.id === dpCtx.instId);
  return { rack, inst };
}

function hideDevicePopover() {
  clearTimeout(dpShowTimer);
  clearTimeout(dpHideTimer);
  dpCtx = null;
  $('#device-popover').classList.add('hidden');
}

function dpPosition(devEl) {
  const pop = $('#device-popover');
  const r = devEl.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = r.right + 14, y = r.top;
  if (x + w > window.innerWidth - 10) x = r.left - w - 14;
  x = Math.max(8, x);
  if (y + h > window.innerHeight - 10) y = window.innerHeight - h - 10;
  y = Math.max(8, y);
  pop.style.left = x + 'px';
  pop.style.top  = y + 'px';
}

function dpSet(id, text) {
  const el = $(id);
  if (el.dataset.editing === '1') return;      // ne pas écraser un champ en édition
  el.textContent = text;
}

function fillDevicePopover() {
  const { rack, inst } = dpFind();
  if (!rack || !inst) { hideDevicePopover(); return; }
  $('#dp-title').textContent = inst.name;
  $('#dp-sub').textContent = `${rack.name} · U${inst.slot + 1}${inst.sizeU > 1 ? '–U' + (inst.slot + inst.sizeU) : ''}`;
  $('#dp-thumb').innerHTML = inst.photo
    ? `<img src="${inst.photo}" alt="">`
    : '<span>▤</span>';
  dpSet('#dp-name', inst.name);
  dpSet('#dp-size', inst.sizeU + 'U');
  dpSet('#dp-slot', 'U' + (inst.slot + 1));
  dpSet('#dp-brand', inst.brand || '—');
  dpSet('#dp-model', inst.model || '—');
  dpSet('#dp-ref', inst.partRef || '—');
  dpSet('#dp-serial', inst.serial || '—');
  dpSet('#dp-ip', inst.ipMgmt || '—');
  dpSet('#dp-vlan', inst.vlan || '—');
  dpSet('#dp-watts', inst.watts ? fmtWatts(inst.watts) : '—');
  dpSet('#dp-kg', inst.weightKg ? String(inst.weightKg).replace('.', ',') + ' kg' : '—');
  dpSet('#dp-ports', String((inst.ports || []).length));
  $('#dp-err').classList.add('hidden');
}

function dpReshow(instId) {
  const el = board.querySelector(`.device[data-instance-id="${instId}"]`);
  if (el) {
    fillDevicePopover();
    $('#device-popover').classList.remove('hidden');
    dpPosition(el);
  } else hideDevicePopover();
}

function showDevicePopover(devEl) {
  const rackEl = devEl.closest('.rack');
  const ws = active();
  const rack = ws?.racks.find(r => r.id === rackEl?.dataset.rackId);
  const inst = rack?.instances.find(i => i.id === devEl.dataset.instanceId);
  if (!rack || !inst) return;
  dpCtx = { rackId: rack.id, instId: inst.id };
  fillDevicePopover();
  $('#device-popover').classList.remove('hidden');
  dpPosition(devEl);
}

function dpError(msg) {
  const err = $('#dp-err');
  err.textContent = msg;
  err.classList.remove('hidden');
  clearTimeout(dpErrTimer);
  dpErrTimer = setTimeout(() => err.classList.add('hidden'), 2600);
}

// Survol du board : montrer la fiche après un petit délai (mode normal uniquement)
board.addEventListener('mouseover', e => {
  if (labelMode || cablingMode) return;
  const devEl = e.target.closest('.device');
  if (!devEl || e.target.closest('.port')) return;   // priorité à l'infobulle port
  clearTimeout(dpHideTimer);
  clearTimeout(dpShowTimer);
  dpShowTimer = setTimeout(() => showDevicePopover(devEl), 300);
});

board.addEventListener('mouseout', e => {
  const devEl = e.target.closest('.device');
  if (!devEl) return;
  const pop = $('#device-popover');
  if (e.relatedTarget && pop.contains(e.relatedTarget)) return;  // on va sur la fiche
  clearTimeout(dpShowTimer);
  clearTimeout(dpHideTimer);
  dpHideTimer = setTimeout(hideDevicePopover, 220);
});

$('#device-popover').addEventListener('mouseenter', () => clearTimeout(dpHideTimer));
$('#device-popover').addEventListener('mouseleave', () => {
  clearTimeout(dpHideTimer);
  dpHideTimer = setTimeout(hideDevicePopover, 160);
});

// La fiche reste au-dessus des clics du board
$('#device-popover').addEventListener('pointerdown', e => e.stopPropagation());

// ---------- Édition en double-clic ----------
function dpEditSpan(sel, makeInput, commit) {
  $(sel).addEventListener('dblclick', e => {
    e.stopPropagation();
    e.preventDefault();
    const span = e.currentTarget;
    if (span.dataset.editing === '1') return;
    const { inst } = dpFind();
    if (!inst) return;
    const input = makeInput(inst);
    input.className = 'dp-input';
    span.dataset.editing = '1';
    span.textContent = '';
    span.appendChild(input);
    input.focus();
    if (input.select) input.select();
    let closed = false;
    const close = ok => {
      if (closed) return;
      closed = true;
      delete span.dataset.editing;
      if (ok) commit(input.value);
      else fillDevicePopover();
    };
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') close(true);
      else if (ev.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  });
}

// Slot libre le plus proche (pour un changement de taille)
function dpNearestFreeSlot(rack, prefer, size, excludeId) {
  const max = rack.sizeU - size;
  if (max < 0) return -1;
  for (let d = 0; d <= rack.sizeU; d++) {
    for (const s of (d === 0 ? [prefer] : [prefer + d, prefer - d])) {
      if (s >= 0 && s <= max && isSlotFree(rack, s, size, excludeId)) return s;
    }
  }
  return -1;
}

function dpAfterChange(inst) {
  const rackId = dpCtx?.rackId;      // renderBoard() remet dpCtx à null
  saveState();
  renderBoard();
  dpCtx = { rackId, instId: inst.id };
  dpReshow(inst.id);
}

dpEditSpan('#dp-name', inst => {
  const i = document.createElement('input');
  i.type = 'text';
  i.value = inst.name;
  i.maxLength = 60;
  return i;
}, val => {
  const { inst } = dpFind();
  if (!inst) return;
  const name = String(val).trim().slice(0, 60);
  if (!name || name === inst.name) { fillDevicePopover(); return; }
  pushHistory();
  inst.name = name;
  dpAfterChange(inst);
});

dpEditSpan('#dp-size', inst => {
  const s = document.createElement('select');
  for (const u of [1, 2, 3, 4, 5, 6, 8, 10, 12]) {
    const o = document.createElement('option');
    o.value = String(u);
    o.textContent = u + 'U';
    if (u === inst.sizeU) o.selected = true;
    s.appendChild(o);
  }
  return s;
}, val => {
  const { rack, inst } = dpFind();
  if (!rack || !inst) return;
  const sizeU = Math.max(1, Math.min(12, parseInt(val, 10) || inst.sizeU));
  if (sizeU === inst.sizeU) { fillDevicePopover(); return; }
  const slot = dpNearestFreeSlot(rack, inst.slot, sizeU, inst.id);
  if (slot < 0) { fillDevicePopover(); dpError(`Pas assez de place pour ${sizeU}U`); return; }
  pushHistory();
  inst.sizeU = sizeU;
  inst.slot = slot;
  dpAfterChange(inst);
});

dpEditSpan('#dp-slot', inst => {
  const { rack } = dpFind();
  const i = document.createElement('input');
  i.type = 'number';
  i.min = '1';
  i.max = String(Math.max(1, (rack?.sizeU || 12) - inst.sizeU + 1));
  i.value = String(inst.slot + 1);
  return i;
}, val => {
  const { rack, inst } = dpFind();
  if (!rack || !inst) return;
  const u = parseInt(val, 10);
  const maxSlot = rack.sizeU - inst.sizeU;
  if (!Number.isFinite(u)) { fillDevicePopover(); return; }
  const slot = Math.max(0, Math.min(u - 1, maxSlot));
  if (slot === inst.slot) { fillDevicePopover(); return; }
  if (!isSlotFree(rack, slot, inst.sizeU, inst.id)) {
    fillDevicePopover();
    dpError(`U${slot + 1} est occupée`);
    return;
  }
  pushHistory();
  inst.slot = slot;
  dpAfterChange(inst);
});

// La fiche suit les changements de vue : on la masque dès que le board bouge
document.addEventListener('wheel', () => hideDevicePopover(), { passive: true });

// ---------- Champs d'inventaire (texte) : édition générique ----------
function dpTextField(sel, field, maxLen) {
  dpEditSpan(sel, inst => {
    const i = document.createElement('input');
    i.type = 'text';
    i.value = inst[field] || '';
    i.maxLength = maxLen;
    return i;
  }, val => {
    const { inst } = dpFind();
    if (!inst) return;
    const v = String(val).trim().slice(0, maxLen);
    if (v === (inst[field] || '')) { fillDevicePopover(); return; }
    pushHistory();
    inst[field] = v;
    dpAfterChange(inst);
  });
}
dpTextField('#dp-brand', 'brand', 40);
dpTextField('#dp-model', 'model', 60);
dpTextField('#dp-ref', 'partRef', 60);
dpTextField('#dp-serial', 'serial', 60);
dpTextField('#dp-ip', 'ipMgmt', 45);
dpTextField('#dp-vlan', 'vlan', 60);

// ---------- Puissance / poids (nombres) ----------
function dpNumField(sel, field, step) {
  dpEditSpan(sel, inst => {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = '0';
    i.step = step;
    i.value = String(inst[field] || '');
    return i;
  }, val => {
    const { inst } = dpFind();
    if (!inst) return;
    const n = Math.max(0, parseFloat(String(val).replace(',', '.')) || 0);
    if (n === (inst[field] || 0)) { fillDevicePopover(); return; }
    pushHistory();
    inst[field] = n;
    dpAfterChange(inst);
  });
}
dpNumField('#dp-watts', 'watts', '1');
dpNumField('#dp-kg', 'weightKg', '0.1');

/* ============================================================
   DIVERS
   ============================================================ */

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (pendingPort) { pendingPort = null; renderCables(); return; }
    hidePortPopover();
    hideCablePopoverSafe();
    hideDevicePopover();
    $('#device-modal').classList.add('hidden');
  }
});
/* ============================================================
   ECRAN D'ACCUEIL — lanceur de workspaces
   - Au démarrage : écran d'accueil avec bouton "Créer un workspace"
     et l'historique des workspaces (triés par date de modification)
   - Le board de chaque workspace est indépendant ; la bibliothèque
     de devices reste partagée
   ============================================================ */

const homeScreen = $('#home-screen');

function showHome() {
  renderHomeList();
  homeScreen.classList.remove('hidden');
}

function hideHome() {
  homeScreen.classList.add('hidden');
}

function formatDate(ts) {
  if (!ts) return 'Jamais modifié';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Aujourd'hui à ${heure}`;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + heure;
}

function renderHomeList() {
  const list = $('#home-list');
  const count = $('#home-count');
  list.innerHTML = '';
  count.textContent = state.workspaces.length || '';

  if (!state.workspaces.length) {
    const empty = document.createElement('div');
    empty.className = 'home-empty';
    empty.textContent = 'Aucun workspace pour le moment. Créez-en un pour commencer.';
    list.appendChild(empty);
    return;
  }

  // Tri : plus récemment modifié d'abord
  const sorted = [...state.workspaces].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  sorted.forEach(w => {
    const nbRacks = w.racks.length;
    const nbDevices = w.racks.reduce((n, r) => n + r.instances.length, 0);

    const card = document.createElement('button');
    card.className = 'ws-card';
    card.innerHTML = `
      <span class="wc-ico">🗄️</span>
      <span class="wc-info">
        <span class="wc-name"></span>
        <span class="wc-meta">
          ${nbRacks} rack${nbRacks > 1 ? 's' : ''}<span class="wc-dot">·</span>${nbDevices} device${nbDevices > 1 ? 's' : ''} placé${nbDevices > 1 ? 's' : ''}
          <span class="wc-dot">·</span>${formatDate(w.updatedAt)}
        </span>
      </span>
      <span class="wc-del" title="Supprimer ce workspace">🗑</span>`;
    card.querySelector('.wc-name').textContent = w.name;

    card.addEventListener('click', () => openWorkspace(w.id));

    card.querySelector('.wc-del').addEventListener('click', e => {
      e.stopPropagation();
      deleteWorkspace(w.id);
    });

    list.appendChild(card);
  });
}

function openWorkspace(id) {
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  state.activeWorkspaceId = ws.id;
  saveState();
  pendingPort = null;
  hideCablePopoverSafe();

  hidePortPopover();
  // Désactive les modes Créer/Modifier en changeant de workspace
  if (labelMode) setLabelMode(null);

  hideHome();
  renderBoard();
  applyWorkspaceView();

  // Le viewport peut finir son recalcul de taille après la fermeture de
  // l'accueil. Un second cadrage garantit que les nouveaux boards vides
  // démarrent bien au centre, quelle que soit la taille de la fenêtre.
  const openedWorkspaceId = ws.id;
  requestAnimationFrame(() => {
    const current = active();
    if (current?.id === openedWorkspaceId && !current.viewTouched) {
      fitViewToContent();
    }
  });
}

function createWorkspace() {
  const name = prompt('Nom du nouveau workspace :', 'Workspace ' + (state.workspaces.length + 1));
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  pushHistory();
  const ws = makeWorkspace(trimmed);
  state.workspaces.push(ws);
  saveState();
  openWorkspace(ws.id);
}

function deleteWorkspace(id) {
  const ws = state.workspaces.find(w => w.id === id);
  if (!ws) return;
  const nbDevices = ws.racks.reduce((n, r) => n + r.instances.length, 0);
  if (!confirm(
    `Supprimer définitivement le workspace « ${ws.name} » ?\n\n` +
    `Il contient ${ws.racks.length} rack(s) et ${nbDevices} device(s) placé(s).\n\n` +
    `La bibliothèque de devices (partagée) est conservée. Cette action est annulable avec Ctrl+Z.`)) return;

  pushHistory();
  state.workspaces = state.workspaces.filter(w => w.id !== id);
  if (state.activeWorkspaceId === id) {
    state.activeWorkspaceId = state.workspaces[0]?.id ?? null;
  }
  saveState();

  if (homeScreen.classList.contains('hidden')) {
    // On était dans ce workspace : retour à l'accueil
    showHome();
  } else {
    renderHomeList();
  }
}

// Créer et gérer les workspaces se fait depuis l'écran d'accueil.
$('#home-new').addEventListener('click', createWorkspace);
// Le logo et le nom de l'application servent de retour vers les workspaces.
$('#btn-workspaces').addEventListener('click', showHome);

/* ============================================================
   MODE CÂBLAGE — relier des ports entre eux par des cordons
   ============================================================ */

const CABLE_COLORS = [
  { name: 'Rouge',    hex: '#e11d48' },
  { name: 'Bleu',     hex: '#2563eb' },
  { name: 'Jaune',    hex: '#eab308' },
  { name: 'Vert',     hex: '#16a34a' },
  { name: 'Orange',   hex: '#ea580c' },
  { name: 'Violet',   hex: '#9333ea' },
  { name: 'Gris',     hex: '#6b7280' },
  { name: 'Noir',     hex: '#1f2937' }
];

let cablingMode = false;
let pendingPort = null;   // 1er port sélectionné en attente du 2e
let cablePopoverCtx = null;
let selectedCableColor = CABLE_COLORS[0].hex;

function cableSvg() { return $('#cable-svg'); }

// Retrouve la position (en coordonnées board) d'un port.
// On utilise la position réelle à l'écran de l'élément .port, convertie
// en coordonnées board : exact quel que soit le zoom ou l'emplacement.
function portBoardPosition(ws, rack, inst, port) {
  const rackEl = board.querySelector(`.rack[data-rack-id="${rack.id}"]`);
  const devEl = rackEl?.querySelector(`.device[data-instance-id="${inst.id}"]`);
  const portEl = devEl?.querySelector(`.port[data-port-id="${port.id}"]`);
  if (!portEl) return null;

  const p = portEl.getBoundingClientRect();   // centre visuel du carré port
  const b = board.getBoundingClientRect();    // origine (0,0) du board à l'écran
  return {
    x: (p.left + p.width  / 2 - b.left) / view.scale,
    y: (p.top  + p.height / 2 - b.top)  / view.scale
  };
}

// Résout un endpoint {rackId, instId, portId}
function resolveEndpoint(ws, ep) {
  if (!ep) return null;
  const rack = ws.racks.find(r => r.id === ep.rackId);
  const inst = rack?.instances.find(i => i.id === ep.instId);
  const port = inst?.ports.find(p => p.id === ep.portId);
  if (!rack || !inst || !port) return null;
  return { rack, inst, port };
}

// Supprime les câbles dont un port a disparu
function pruneCables(ws) {
  if (!ws) return;
  ws.cables = ws.cables.filter(c => resolveEndpoint(ws, c.a) && resolveEndpoint(ws, c.b));
}

// Tracé d'un cordon (Béziers symétrique qui pendouille)
function cablePath(p1, p2) {
  const dx = Math.abs(p2.x - p1.x);
  const sag = Math.min(150, Math.max(18, dx * 0.22 + Math.abs(p2.y - p1.y) * 0.2));
  const c1 = { x: p1.x, y: p1.y + sag };
  const c2 = { x: p2.x, y: p2.y + sag };
  return {
    d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
    mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 + sag * 0.75 }
  };
}

function renderCables() {
  const svg = cableSvg();
  if (!svg) return;
  // Conserver uniquement le tracé temporaire
  const temp = svg.querySelector('.cable-temp');
  [...svg.querySelectorAll('g.cable')].forEach(g => g.remove());
  if (temp) temp.style.display = 'none';

  if (!cablingMode) return;
  const ws = active();
  if (!ws) return;
  pruneCables(ws);

  const svgNS = 'http://www.w3.org/2000/svg';

  ws.cables.forEach(cable => {
    const ea = resolveEndpoint(ws, cable.a);
    const eb = resolveEndpoint(ws, cable.b);
    if (!ea || !eb) return;
    const p1 = portBoardPosition(ws, ea.rack, ea.inst, ea.port);
    const p2 = portBoardPosition(ws, eb.rack, eb.inst, eb.port);
    if (!p1 || !p2) return;
    const { d } = cablePath(p1, p2);

    const g = document.createElementNS(svgNS, 'g');
    g.classList.add('cable');
    g.style.setProperty('--cable-color', cable.color);

    const shadow = document.createElementNS(svgNS, 'path');
    shadow.setAttribute('class', 'cable-shadow');
    shadow.setAttribute('d', d);
    shadow.setAttribute('transform', 'translate(2,3)');

    const jacket = document.createElementNS(svgNS, 'path');
    jacket.setAttribute('class', 'cable-jacket');
    jacket.setAttribute('d', d);

    const hit = document.createElementNS(svgNS, 'path');
    hit.setAttribute('class', 'cable-hit');
    hit.setAttribute('d', d);

    [p1, p2].forEach(p => {
      const cap = document.createElementNS(svgNS, 'circle');
      cap.setAttribute('class', 'cable-cap');
      cap.setAttribute('cx', p.x);
      cap.setAttribute('cy', p.y);
      cap.setAttribute('r', 3.4);
      g.appendChild(cap);
    });

    g.appendChild(shadow);
    g.appendChild(jacket);
    g.appendChild(hit);
    hit.addEventListener('pointerdown', e => {
      e.stopPropagation();
      openCablePopover(cable, e.clientX, e.clientY);
    });
    svg.appendChild(g);
  });
}

function drawTempCable(p1, p2) {
  const svg = cableSvg();
  const temp = svg?.querySelector('.cable-temp');
  if (!temp || !p1 || !p2) { if (temp) temp.style.display = 'none'; return; }
  temp.style.display = '';
  temp.setAttribute('d', cablePath(p1, p2).d);
}

// Port cliqué depuis le handler global (app.js)
function handlePortClickCabling(clientX, clientY, rack, inst, port) {
  if (!cablingMode) return false;

  if (!pendingPort) {
    pendingPort = { rack, inst, port, x: clientX, y: clientY };
    flashPortElement(rack.id, inst.id, port.id, '#2563eb');
    return true;
  }

  // Même port = annulation
  if (pendingPort.port.id === port.id) {
    pendingPort = null;
    renderCables();
    return true;
  }

  // Créer le câble
  const ws = active();
  const existing = ws.cables.find(c =>
    (c.a.portId === pendingPort.port.id && c.b.portId === port.id) ||
    (c.b.portId === pendingPort.port.id && c.a.portId === port.id));
  if (existing) {
    pendingPort = null;
    renderCables();
    renderCableList();
    openCablePopover(existing, clientX, clientY);
    return true;
  }

  const cable = {
    id: uid(),
    name: nextCableId(ws),
    color: selectedCableColor,
    a: { rackId: pendingPort.rack.id, instId: pendingPort.inst.id, portId: pendingPort.port.id },
    b: { rackId: rack.id, instId: inst.id, portId: port.id }
  };

  pushHistory();
  ws.cables.push(cable);
  touchWorkspace(ws);
  pendingPort = null;
  saveState();
  renderCables();
  renderCableList();
  // Proposer l'édition du câble qui vient d'être créé
  openCablePopover(cable, clientX, clientY, true);
  return true;
}

function nextCableId(ws) {
  const n = ws.cables.length + 1;
  let id = 'CAB-' + String(n).padStart(3, '0');
  let i = n;
  while (ws.cables.some(c => c.name === id)) {
    i++;
    id = 'CAB-' + String(i).padStart(3, '0');
  }
  return id;
}

function flashPortElement(rackId, instId, portId, color) {
  const rackEl = board.querySelector(`.rack[data-rack-id="${rackId}"]`);
  const portEl = rackEl?.querySelector(`.device[data-instance-id="${instId}"] .port[data-port-id="${portId}"]`);
  if (!portEl) return;
  portEl.style.filter = `drop-shadow(0 1px 2px rgba(0,0,0,.55)) drop-shadow(0 0 8px ${color})`;
  setTimeout(() => { portEl.style.filter = ''; }, 1200);
}

// Suivi de la souris pour le câble temporaire
viewport.addEventListener('mousemove', e => {
  if (!cablingMode || !pendingPort) return;
  const ws = active();
  const p1 = portBoardPosition(ws, pendingPort.rack, pendingPort.inst, pendingPort.port);
  if (!p1) return;
  const p2 = clientToBoard(e.clientX, e.clientY);
  drawTempCable(p1, p2);
});

/* ---------- Popover câble ---------- */
function openCablePopover(cable, clientX, clientY, isNew = false) {
  hidePortPopover();
  const pop = $('#cable-popover');
  cablePopoverCtx = { cable, isNew };

  $('#cl-title').textContent = isNew ? 'Nouveau câble' : 'Câble';
  $('#c-name').value = cable.name || '';
  selectedCableColor = cable.color || CABLE_COLORS[0].hex;

  const colorsEl = $('#c-colors');
  colorsEl.innerHTML = '';
  CABLE_COLORS.forEach(c => {
    const b = document.createElement('button');
    b.className = 'color-swatch' + (c.hex === selectedCableColor ? ' selected' : '');
    b.style.background = c.hex;
    b.title = c.name;
    b.addEventListener('click', () => {
      selectedCableColor = c.hex;
      colorsEl.querySelectorAll('.color-swatch').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
    });
    colorsEl.appendChild(b);
  });

  $('#c-delete').classList.toggle('hidden', isNew);
  pop.classList.remove('hidden');

  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = clientX + 14, y = clientY + 14;
  if (x + w > window.innerWidth - 10)  x = clientX - w - 14;
  if (y + h > window.innerHeight - 10) y = clientY - h - 14;
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top  = Math.max(8, y) + 'px';
  $('#c-name').focus();
}

function hideCablePopover() {
  $('#cable-popover').classList.add('hidden');
  cablePopoverCtx = null;
}

$('#c-save').addEventListener('click', () => {
  if (!cablePopoverCtx) return;
  const { cable, isNew } = cablePopoverCtx;
  const name = $('#c-name').value.trim() || cable.name;
  if (isNew) {
    // déjà enregistré à la création ; on met juste à jour
  }
  pushHistory();
  cable.name = name;
  cable.color = selectedCableColor;
  hideCablePopover();
  touchWorkspace(active());
  saveState();
  renderCables();
  renderCableList();
});

$('#c-delete').addEventListener('click', () => {
  if (!cablePopoverCtx) return;
  const { cable } = cablePopoverCtx;
  const ws = active();
  pushHistory();
  ws.cables = ws.cables.filter(c => c.id !== cable.id);
  hideCablePopover();
  touchWorkspace(ws);
  saveState();
  renderCables();
  renderCableList();
});

$('#c-cancel').addEventListener('click', () => {
  // Si c'était un câble fraîchement créé et qu'on annule, on le retire
  if (cablePopoverCtx?.isNew) {
    const { cable } = cablePopoverCtx;
    const ws = active();
    ws.cables = ws.cables.filter(c => c.id !== cable.id);
    saveState();
    renderCables();
    renderCableList();
  }
  hideCablePopover();
});

$('#cable-popover').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#c-save').click();
  if (e.key === 'Escape') $('#c-cancel').click();
});

/* ---------- Panneau liste des connexions ---------- */
function renderCableList() {
  const list = $('#cable-list');
  const count = $('#cable-count');
  if (!list) return;
  const ws = active();
  const cables = ws?.cables || [];
  count.textContent = cables.length;
  list.innerHTML = '';

  if (!cables.length) {
    list.innerHTML = `<div class="cp-empty">Aucun câble.<br>Cliquez deux ports pour les relier.</div>`;
    return;
  }

  cables.forEach(cable => {
    const ea = resolveEndpoint(ws, cable.a);
    const eb = resolveEndpoint(ws, cable.b);
    if (!ea || !eb) return;
    const row = document.createElement('button');
    row.className = 'cp-cable';
    row.innerHTML = `
      <span class="cp-dot" style="background:${cable.color}"></span>
      <span class="cp-cable-body">
        <span class="cp-cable-id"></span>
        <span class="cp-cable-path"></span>
      </span>
      <span class="cp-cable-del" title="Supprimer ce câble">✕</span>`;
    row.querySelector('.cp-cable-id').textContent = cable.name || 'Sans ID';
    row.querySelector('.cp-cable-path').textContent =
      `${ea.port.name} (${ea.inst.name}) → ${eb.port.name} (${eb.inst.name})`;

    row.addEventListener('click', e => {
      if (e.target.closest('.cp-cable-del')) return;
      // Centrer sur le câble
      focusOnCable(cable);
    });
    row.querySelector('.cp-cable-del').addEventListener('click', e => {
      e.stopPropagation();
      pushHistory();
      ws.cables = ws.cables.filter(c => c.id !== cable.id);
      touchWorkspace(ws);
      saveState();
      renderCables();
      renderCableList();
    });
    list.appendChild(row);
  });
}

function focusOnCable(cable) {
  const ws = active();
  const ea = resolveEndpoint(ws, cable.a);
  const eb = resolveEndpoint(ws, cable.b);
  if (!ea || !eb) return;
  const p1 = portBoardPosition(ws, ea.rack, ea.inst, ea.port);
  const p2 = portBoardPosition(ws, eb.rack, eb.inst, eb.port);
  if (!p1 || !p2) return;
  const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
  const rect = viewport.getBoundingClientRect();
  view.scale = 1;
  view.x = rect.width / 2 - cx;
  view.y = rect.height / 2 - cy;
  markViewTouched();
  applyView();
  renderBoard();
  requestAnimationFrame(() => {
    const g = [...board.querySelectorAll('#cable-svg g.cable')].find(el => {
      const hit = el.querySelector('.cable-hit');
      return hit && cablePath(p1, p2).d === hit.getAttribute('d');
    });
    g?.classList.add('selected');
    setTimeout(() => g?.classList.remove('selected'), 2000);
  });
}

$('#cable-panel-clear').addEventListener('click', () => {
  const ws = active();
  if (!ws?.cables.length) return;
  if (confirm(`Retirer les ${ws.cables.length} câble(s) de ce workspace ?`)) {
    pushHistory();
    ws.cables = [];
    touchWorkspace(ws);
    pendingPort = null;
    saveState();
    renderCables();
    renderCableList();
  }
});

/* ---------- Interrupteur Câblage ---------- */
$('#cabling-toggle').addEventListener('change', e => {
  setCablingMode(e.target.checked);
});

function setCablingMode(on) {
  cablingMode = on;
  document.body.classList.toggle('cabling', on);
  $('#cable-panel').classList.toggle('hidden', !on);
  $('#cabling-toggle').checked = on;

  if (on) {
    // Les modes Créer/Modifier sont exclusifs
    if (labelMode) setLabelMode(null);
    $('#mode-hint').textContent = 'Mode câblage : cliquez un port, puis un autre port pour les relier par un câble. Cliquez un câble pour l\'éditer.';
    pendingPort = null;
    pruneCables(active());
    renderBoard();    // rend les devices non déplaçables + dessine les câbles
    renderCableList();
  } else {
    $('#mode-hint').textContent = 'Glissez un rack sur le board, puis ajoutez vos devices.';
    pendingPort = null;
    hideCablePopover();
    renderBoard();    // rend les devices déplaçables + masque les câbles
  }
}

/* ============================================================
   INFOS DOSSIER LLD — client, auteur, versions, registre VLANs
   ============================================================ */

const LLD_REV_COLS = [['rev', 'Rév', 52], ['date', 'Date', 108], ['author', 'Auteur', 128], ['note', 'Modifications', 'flex']];
const LLD_VLAN_COLS = [['vid', 'VLAN', 52], ['name', 'Nom', 108], ['subnet', 'Subnet', 132], ['gw', 'Passerelle', 118], ['purpose', 'Usage', 'flex']];

function lldRowsFrom(container) {
  return [...container.querySelectorAll('.lld-row')].map(row => {
    const o = {};
    row.querySelectorAll('input').forEach(inp => { o[inp.dataset.k] = inp.value; });
    return o;
  });
}

function lldAddRow(container, cols, data = {}) {
  const row = document.createElement('div');
  row.className = 'lld-row';
  for (const [k, ph, w] of cols) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.dataset.k = k;
    inp.placeholder = ph;
    if (w !== 'flex') inp.style.width = w + 'px';
    else inp.className = 'lld-flex';
    if (k === 'date') inp.placeholder = 'AAAA-MM-JJ';
    inp.value = data[k] || '';
    row.appendChild(inp);
  }
  const del = document.createElement('button');
  del.className = 'lld-row-del';
  del.textContent = '✕';
  del.title = 'Supprimer cette ligne';
  del.addEventListener('click', () => row.remove());
  row.appendChild(del);
  container.appendChild(row);
}

function openLldModal() {
  const ws = active();
  if (!ws) return;
  const L = normLldInfo(ws);
  $('#lld-client').value = L.client;
  $('#lld-author').value = L.author;
  $('#lld-version').value = L.version;
  const revs = $('#lld-revs');
  revs.innerHTML = '';
  L.revs.forEach(r => lldAddRow(revs, LLD_REV_COLS, r));
  const vlans = $('#lld-vlans');
  vlans.innerHTML = '';
  L.vlans.forEach(v => lldAddRow(vlans, LLD_VLAN_COLS, v));
  $('#lld-modal').classList.remove('hidden');
  $('#lld-client').focus();
}

$('#ws-info').addEventListener('click', openLldModal);
$('#lld-cancel').addEventListener('click', () => $('#lld-modal').classList.add('hidden'));
$('#lld-modal').addEventListener('click', e => {
  if (e.target === $('#lld-modal')) $('#lld-modal').classList.add('hidden');
});
$('#lld-add-rev').addEventListener('click', () => {
  const revs = $('#lld-revs');
  const n = revs.querySelectorAll('.lld-row').length;
  lldAddRow(revs, LLD_REV_COLS, { rev: String(n + 1), date: new Date().toISOString().slice(0, 10) });
  [...revs.querySelectorAll('.lld-row')].pop().querySelector('input').focus();
});
$('#lld-add-vlan').addEventListener('click', () => lldAddRow($('#lld-vlans'), LLD_VLAN_COLS, {}));

// Ajoute au registre les VLANs utilisés sur les ports mais pas encore enregistrés
$('#lld-detect-vlans').addEventListener('click', () => {
  const ws = active();
  if (!ws) return;
  const L = normLldInfo(ws);
  const known = new Set(L.vlans.map(v => v.vid.trim()).filter(Boolean));
  const found = new Set();
  ws.racks.forEach(r => r.instances.forEach(i => (i.ports || []).forEach(p => {
    String(p.vlan || '').split(/[^0-9]+/).forEach(tok => {
      const n = parseInt(tok, 10);
      if (n >= 1 && n <= 4094) found.add(String(n));
    });
  })));
  (ws.topology?.links || []).forEach(l => {
    String(l.vlan || '').split(/[^0-9]+/).forEach(tok => {
      const n = parseInt(tok, 10);
      if (n >= 1 && n <= 4094) found.add(String(n));
    });
  });
  const missing = [...found].filter(v => !known.has(v)).sort((a, b) => a - b);
  if (!missing.length) { alert('Tous les VLANs utilisés sont déjà dans le registre.'); return; }
  const vlans = $('#lld-vlans');
  missing.forEach(vid => lldAddRow(vlans, LLD_VLAN_COLS, { vid }));
  alert(`${missing.length} VLAN(s) ajouté(s) au registre : ${missing.join(', ')}\nRenseignez leur nom, subnet et passerelle.`);
});

$('#lld-save').addEventListener('click', () => {
  const ws = active();
  if (!ws) return;
  pushHistory();
  const L = normLldInfo(ws);
  L.client = $('#lld-client').value.trim().slice(0, 80);
  L.author = $('#lld-author').value.trim().slice(0, 80);
  L.version = $('#lld-version').value.trim().slice(0, 80);
  L.revs = lldRowsFrom($('#lld-revs')).filter(r => r.rev.trim() || r.note.trim());
  L.vlans = lldRowsFrom($('#lld-vlans')).filter(v => v.vid.trim() || v.name.trim());
  touchWorkspace(ws);
  saveState();
  $('#lld-modal').classList.add('hidden');
});

/* ============================================================
   VUE TOPOLOGIE LOGIQUE — diagramme réseau du workspace
   ------------------------------------------------------------
   Deuxième vue du board (boutons 📐 Élévations / 🕸️ Topologie) :
   les devices posés deviennent des noeuds disposés librement,
   reliés par des liens logiques (débit, VLAN…).
   - ⚡ Générer depuis les racks : un noeud par device posé
   - 🔌 Importer les câbles : un lien par câble physique
   - ➕ Nouveau lien : cliquez deux noeuds l'un après l'autre
   Double-clic sur un noeud : retour en élévations, focus device.
   ============================================================ */

const TOPO_NW = 190, TOPO_NH = 64;

function ensureTopology(ws) {
  if (!ws.topology || !Array.isArray(ws.topology.nodes) || !Array.isArray(ws.topology.links))
    ws.topology = { nodes: [], links: [] };
  return ws.topology;
}

// Retire les noeuds pointant vers des devices supprimés + liens orphelins
function pruneTopology(ws) {
  if (!ws?.topology) return false;
  let changed = false;
  const ids = new Set(ws.racks.flatMap(r => r.instances.map(i => i.id)));
  const before = ws.topology.nodes.length;
  ws.topology.nodes = ws.topology.nodes.filter(n => ids.has(n.instId));
  if (ws.topology.nodes.length !== before) changed = true;
  const nids = new Set(ws.topology.nodes.map(n => n.id));
  const bl = ws.topology.links.length;
  ws.topology.links = ws.topology.links.filter(l => nids.has(l.a) && nids.has(l.b) && l.a !== l.b);
  if (ws.topology.links.length !== bl) changed = true;
  return changed;
}

function exitTopoLinking() {
  topoLinkPending = null;
  document.body.classList.remove('topo-linking');
  $('#mode-hint').textContent = 'Topologie : disposez les noeuds et reliez-les (liens logiques).';
}

function setBoardMode(mode) {
  if (boardMode === mode) return;
  boardMode = mode;
  document.body.classList.toggle('topo-mode', mode === 'topo');
  $('#view-elev').classList.toggle('active', mode === 'elev');
  $('#view-topo').classList.toggle('active', mode === 'topo');
  if (mode === 'topo') {
    setLabelMode(null);
    setCablingMode(false);
    exitTopoLinking();
  } else {
    $('#mode-hint').textContent = 'Glissez un rack sur le board, puis ajoutez vos devices.';
  }
  renderBoard();
  fitViewToContent();
}
$('#view-elev').addEventListener('click', () => setBoardMode('elev'));
$('#view-topo').addEventListener('click', () => setBoardMode('topo'));

// Retrouve { rack, inst } d'un noeud
function topoInstOf(ws, node) {
  for (const r of ws.racks) {
    const inst = r.instances.find(x => x.id === node.instId);
    if (inst) return { rack: r, inst };
  }
  return null;
}

function renderTopology(ws) {
  board.innerHTML = '';      // les handlers appellent renderTopology directement
  const topo = ensureTopology(ws);
  if (pruneTopology(ws)) { touchWorkspace(ws); saveState(); }
  $('#board-empty').classList.add('hidden');
  $('#topo-toolbar').classList.remove('hidden');
  $('#topo-empty').classList.toggle('hidden', topo.nodes.length > 0);

  // Couche SVG des liens (sous les noeuds)
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.id = 'topo-svg';
  board.appendChild(svg);

  const nodeById = id => topo.nodes.find(n => n.id === id);

  const drawLinks = () => {
    svg.innerHTML = '';
    for (const l of topo.links) {
      const na = nodeById(l.a), nb = nodeById(l.b);
      if (!na || !nb) continue;
      const x1 = na.x + TOPO_NW / 2, y1 = na.y + TOPO_NH / 2;
      const x2 = nb.x + TOPO_NW / 2, y2 = nb.y + TOPO_NH / 2;
      const color = l.color || '#60a5fa';

      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '2.5');
      if (l.style === 'dashed') line.setAttribute('stroke-dasharray', '7 5');
      svg.appendChild(line);

      const label = [l.label, l.speed, l.vlan && 'VLAN ' + l.vlan].filter(Boolean).join(' · ');
      if (label) {
        const t = document.createElementNS(svgNS, 'text');
        t.setAttribute('x', (x1 + x2) / 2);
        t.setAttribute('y', (y1 + y2) / 2 - 6);
        t.setAttribute('fill', '#e6ecf5');
        t.setAttribute('font-size', '11');
        t.setAttribute('font-weight', '600');
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('paint-order', 'stroke');
        t.setAttribute('stroke', '#0b0d11');
        t.setAttribute('stroke-width', '3.5');
        t.textContent = label;
        svg.appendChild(t);
      }

      // Zone cliquable invisible (édition du lien)
      const hit = document.createElementNS(svgNS, 'line');
      hit.setAttribute('x1', x1); hit.setAttribute('y1', y1);
      hit.setAttribute('x2', x2); hit.setAttribute('y2', y2);
      hit.setAttribute('stroke', 'rgba(0,0,0,0)');
      hit.setAttribute('stroke-width', '14');
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', e => {
        e.stopPropagation();
        openLinkPopover(l, e.clientX, e.clientY, false);
      });
      svg.appendChild(hit);
    }
  };

  for (const n of topo.nodes) {
    const info = topoInstOf(ws, n);
    const inst = info?.inst;
    const el = document.createElement('div');
    el.className = 'topo-node' + (topoLinkPending === n.id ? ' pending' : '');
    el.dataset.nodeId = n.id;
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.innerHTML = `
      <div class="tn-head"><span class="tn-led"></span><span class="tn-name">${escapeHtml(inst?.name || '?')}</span></div>
      <div class="tn-sub">${escapeHtml([inst?.brand, inst?.model].filter(Boolean).join(' ') || '—')}</div>
      <div class="tn-sub2">${escapeHtml(info ? `${info.rack.name} · U${inst.slot + 1}` : '')}${inst?.ipMgmt ? ' · ' + escapeHtml(inst.ipMgmt) : ''}</div>`;

    // Déplacement du noeud
    el.addEventListener('pointerdown', e => {
      if ((e.button !== 0 && e.pointerType === 'mouse') || topoLinkPending) return;
      e.stopPropagation();
      const startX = e.clientX, startY = e.clientY, ox = n.x, oy = n.y;
      el.setPointerCapture(e.pointerId);
      const onMove = ev => {
        n.x = Math.max(0, ox + (ev.clientX - startX) / view.scale);
        n.y = Math.max(0, oy + (ev.clientY - startY) / view.scale);
        el.style.left = n.x + 'px';
        el.style.top = n.y + 'px';
        drawLinks();
      };
      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        touchWorkspace(active());
        saveState();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
    });

    // Création de lien : 1er clic = départ, 2e = arrivée
    el.addEventListener('click', e => {
      if (!document.body.classList.contains('topo-linking')) return;
      e.stopPropagation();
      if (!topoLinkPending) {
        topoLinkPending = n.id;
        el.classList.add('pending');
        return;
      }
      if (topoLinkPending === n.id) { exitTopoLinking(); renderTopology(ws); return; }
      const w = active();
      const t = ensureTopology(w);
      pushHistory();
      const link = { id: uid(), a: topoLinkPending, b: n.id, label: '', speed: '1 Gbps', vlan: '', style: 'solid', color: '#60a5fa' };
      t.links.push(link);
      exitTopoLinking();
      touchWorkspace(w);
      saveState();
      renderTopology(w);
      openLinkPopover(link, e.clientX, e.clientY, true);
    });

    // Double-clic : focus sur le device en vue élévations
    el.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (!info) return;
      setBoardMode('elev');
      const rect = viewport.getBoundingClientRect();
      view.scale = 1;
      view.x = rect.width / 2 - (info.rack.x + RACK_W / 2);
      view.y = rect.height / 2 - (info.rack.y + rackHeight(info.rack) / 2);
      markViewTouched();
      applyView();
      renderBoard();
      requestAnimationFrame(() => {
        const devEl = board.querySelector(`.device[data-instance-id="${inst.id}"]`);
        if (devEl) {
          devEl.classList.remove('flash-target');
          void devEl.offsetWidth;
          devEl.classList.add('flash-target');
          setTimeout(() => devEl.classList.remove('flash-target'), 5500);
        }
      });
    });

    board.appendChild(el);
  }
  drawLinks();
}

// --- Barre d'outils topologie ---
$('#topo-gen').addEventListener('click', () => {
  const ws = active();
  if (!ws) return;
  const topo = ensureTopology(ws);
  pushHistory();
  sortedRacks(ws).forEach((rack, ri) => {
    let row = 0;
    [...rack.instances].sort((a, b) => b.slot - a.slot).forEach(inst => {
      if (!topo.nodes.some(x => x.instId === inst.id))
        topo.nodes.push({ id: uid(), instId: inst.id, x: 80 + ri * 260, y: 80 + row * 110 });
      row++;
    });
  });
  touchWorkspace(ws);
  saveState();
  renderTopology(ws);
  fitViewToContent();
});

$('#topo-import-cables').addEventListener('click', () => {
  const ws = active();
  if (!ws) return;
  const topo = ensureTopology(ws);
  const nodeOfInst = iid => topo.nodes.find(n => n.instId === iid);
  const candidates = [];
  for (const c of (ws.cables || [])) {
    const a = resolveEndpoint(ws, c.a), b = resolveEndpoint(ws, c.b);
    if (!a || !b || a.inst.id === b.inst.id) continue;
    const na = nodeOfInst(a.inst.id), nb = nodeOfInst(b.inst.id);
    if (!na || !nb) continue;
    if (topo.links.some(l => (l.a === na.id && l.b === nb.id) || (l.a === nb.id && l.b === na.id))) continue;
    candidates.push({ na, nb, name: c.name || '' });
  }
  if (!candidates.length) {
    alert('Aucun câble importable (vérifiez que les noeuds existent — « ⚡ Générer » d\'abord).');
    return;
  }
  pushHistory();
  for (const c of candidates)
    topo.links.push({ id: uid(), a: c.na.id, b: c.nb.id, label: c.name, speed: '', vlan: '', style: 'solid', color: '#34d399' });
  touchWorkspace(ws);
  saveState();
  renderTopology(ws);
});

$('#topo-new-link').addEventListener('click', () => {
  const ws = active();
  if (!ws) return;
  const topo = ensureTopology(ws);
  if (!topo.nodes.length) {
    alert('Aucun noeud pour l\'instant : cliquez « ⚡ Générer depuis les racks » d\'abord.');
    return;
  }
  exitTopoLinking();
  document.body.classList.add('topo-linking');
  $('#mode-hint').textContent = 'Nouveau lien : cliquez le premier noeud, puis le second (Échap pour annuler).';
});

// --- Popover d'édition d'un lien ---
let linkCtx = null;

function openLinkPopover(link, clientX, clientY, isNew) {
  linkCtx = { link };
  $('#tl-title').textContent = isNew ? 'Nouveau lien' : 'Modifier le lien';
  $('#tl-label').value = link.label || '';
  $('#tl-speed').value = link.speed || '';
  $('#tl-vlan').value = link.vlan || '';
  $('#tl-style').value = link.style || 'solid';
  $('#tl-color').value = link.color || '#60a5fa';
  $('#tl-delete').classList.toggle('hidden', isNew);
  const pop = $('#link-popover');
  pop.classList.remove('hidden');
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = clientX + 14, y = clientY + 14;
  if (x + w > window.innerWidth - 10) x = clientX - w - 14;
  if (y + h > window.innerHeight - 10) y = clientY - h - 14;
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
  $('#tl-label').focus();
}

function hideLinkPopover() {
  $('#link-popover').classList.add('hidden');
  linkCtx = null;
}

$('#tl-save').addEventListener('click', () => {
  if (!linkCtx) return;
  const { link } = linkCtx;
  pushHistory();
  link.label = $('#tl-label').value.trim().slice(0, 60);
  link.speed = $('#tl-speed').value;
  link.vlan = $('#tl-vlan').value.trim().slice(0, 30);
  link.style = $('#tl-style').value;
  link.color = $('#tl-color').value;
  hideLinkPopover();
  touchWorkspace(active());
  saveState();
  renderTopology(active());
});

$('#tl-delete').addEventListener('click', () => {
  if (!linkCtx) return;
  const ws = active();
  const topo = ensureTopology(ws);
  pushHistory();
  topo.links = topo.links.filter(l => l.id !== linkCtx.link.id);
  hideLinkPopover();
  touchWorkspace(ws);
  saveState();
  renderTopology(ws);
});

$('#tl-cancel').addEventListener('click', hideLinkPopover);
$('#link-popover').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') $('#tl-save').click();
  if (e.key === 'Escape') hideLinkPopover();
});

/* ============================================================
   EXPORT DU PLAN — PNG / PDF (rendu canvas haute définition)
   ============================================================ */

// Dessine le plan du workspace courant sur un canvas et le renvoie
async function renderPlanCanvas() {
  const ws = active();
  if (!ws || !ws.racks.length) return null;

  // Préchargement de toutes les photos de devices
  const imgCache = new Map();
  const imgUrls = new Set();
  ws.racks.forEach(r => r.instances.forEach(i => { if (i.photo) imgUrls.add(i.photo); }));
  await Promise.all([...imgUrls].map(url => new Promise(res => {
    const im = new Image();
    im.onload = () => { imgCache.set(url, im); res(); };
    im.onerror = () => res();
    im.src = url;
  })));

  // Icône de port RJ45
  const rj45 = await new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = 'assets/rj45-port.svg';
  });

  const PAD = 60;
  const innerW = 292;  // .rack-inner width à l'écran

  // Zone englobante des racks
  const minX = Math.min(...ws.racks.map(r => r.x)) - PAD;
  const minY = Math.min(...ws.racks.map(r => r.y)) - PAD;
  const maxX = Math.max(...ws.racks.map(r => r.x + RACK_W)) + PAD;
  const maxY = Math.max(...ws.racks.map(r => r.y + rackHeight(r))) + PAD;
  const W = Math.ceil(maxX - minX);
  const H = Math.ceil(maxY - minY);

  const SCALE = 2;  // netteté (HiDPI)
  const c = document.createElement('canvas');
  c.width = W * SCALE;
  c.height = H * SCALE;
  const ctx = c.getContext('2d');
  ctx.scale(SCALE, SCALE);

  // Fond
  ctx.fillStyle = '#e4e7ee';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#c9cfdb';
  const gap = 24;
  for (let gx = gap / 2; gx < W; gx += gap) {
    for (let gy = gap / 2; gy < H; gy += gap) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const roundRect = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  for (const rack of ws.racks) {
    const x = rack.x - minX;
    const y = rack.y - minY;
    const sizeU = rack.sizeU || DEFAULT_RACK_U;
    const bodyH = 16 + sizeU * U_H;
    const totalH = 28 + bodyH;

    // En-tête
    ctx.fillStyle = '#363b46';
    roundRect(x, y, RACK_W, totalH, 8);
    ctx.fill();
    ctx.fillStyle = '#3b4250';
    roundRect(x, y, RACK_W, 28, 8);
    ctx.fill();
    // LED
    ctx.fillStyle = '#22c55e';
    ctx.beginPath(); ctx.arc(x + 18, y + 14, 3.5, 0, Math.PI * 2); ctx.fill();
    // Titre
    ctx.fillStyle = '#e8ebf1';
    ctx.font = 'bold 12px "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(truncate(ctx, rack.name, RACK_W - 90), x + 30, y + 15);

    // Bâti
    const by = y + 28;
    ctx.fillStyle = '#333842';
    ctx.fillRect(x, by, RACK_W, bodyH);
    const fx = x + 6, fy = by + 8;
    ctx.fillStyle = '#101318';
    ctx.fillRect(fx, fy, RACK_W - 12, sizeU * U_H);

    // Règle des U
    const rulerW = 22, railW = 17;
    ctx.fillStyle = '#e3e6ec';
    ctx.fillRect(fx, fy, rulerW, sizeU * U_H);
    ctx.strokeStyle = '#b3b8c2';
    ctx.fillStyle = '#606673';
    ctx.font = 'bold 9.5px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i < sizeU; i++) {
      const uy = fy + i * U_H;
      ctx.beginPath(); ctx.moveTo(fx, uy + U_H); ctx.lineTo(fx + rulerW, uy + U_H); ctx.stroke();
      ctx.fillText(String(sizeU - i), fx + rulerW / 2, uy + U_H / 2 + 0.5);
    }

    // Montants perforés
    ctx.fillStyle = '#101318';
    const rail1 = fx + rulerW;
    ctx.fillRect(rail1, fy, railW, sizeU * U_H);
    ctx.fillRect(fx + RACK_W - 12 - railW, fy, railW, sizeU * U_H);
    ctx.fillStyle = '#05070a';
    for (let i = 0; i < sizeU; i++) {
      const uy = fy + i * U_H;
      [4, 14, 24].forEach(hy => {
        ctx.fillRect(rail1 + 4, uy + hy, 9, 5);
        ctx.fillRect(fx + RACK_W - 12 - railW + 4, uy + hy, 9, 5);
      });
    }

    // Zone intérieure + devices
    const inX = fx + rulerW + railW;
    const inW = innerW;
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(inX, fy, inW, sizeU * U_H);

    for (const inst of rack.instances) {
      const dy = fy + inst.slot * U_H;
      const dh = inst.sizeU * U_H;
      ctx.save();
      ctx.beginPath(); ctx.rect(inX, dy, inW, dh); ctx.clip();
      const img = inst.photo ? imgCache.get(inst.photo) : null;
      if (img) {
        ctx.drawImage(img, inX, dy, inW, dh);
      } else {
        const grad = ctx.createLinearGradient(0, dy, 0, dy + dh);
        grad.addColorStop(0, '#c9cdd5');
        grad.addColorStop(.45, '#b6bbc6');
        grad.addColorStop(1, '#a7adb9');
        ctx.fillStyle = grad;
        ctx.fillRect(inX, dy, inW, dh);
        ctx.fillStyle = '#22c55e';
        ctx.beginPath(); ctx.arc(inX + 20, dy + dh / 2, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.fillRect(inX + 45, dy + dh / 2 - 9, Math.min(inW - 90, Math.max(90, inst.name.length * 6.4)), 18);
        ctx.strokeStyle = 'rgba(0,0,0,.12)';
        ctx.strokeRect(inX + 45, dy + dh / 2 - 9, Math.min(inW - 90, Math.max(90, inst.name.length * 6.4)), 18);
        ctx.fillStyle = '#3c434f';
        ctx.font = 'bold 10px "Segoe UI", sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(truncate(ctx, `${inst.name} · ${inst.sizeU}U`, inW - 100), inX + 52, dy + dh / 2 + 0.5);
      }
      ctx.restore();

      // Ports (icône RJ45, taille personnalisable)
      (inst.ports || []).forEach(p => {
        const px = inX + (p.xPct / 100) * inW;
        const py = dy + (p.yPct / 100) * dh;
        const size = 26 * (p.size || 1);
        if (rj45) {
          ctx.drawImage(rj45, px - size / 2, py - size / 2, size, size);
        } else {
          ctx.fillStyle = '#fef3c7';
          ctx.strokeStyle = '#d97706';
          ctx.lineWidth = 2;
          ctx.fillRect(px - size / 2, py - size / 2, size, size);
          ctx.strokeRect(px - size / 2, py - size / 2, size, size);
        }
      });

      // séparation
      ctx.strokeStyle = 'rgba(255,255,255,.08)';
      ctx.beginPath(); ctx.moveTo(inX, dy); ctx.lineTo(inX + inW, dy); ctx.stroke();
    }

    // contour de la zone intérieure
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.strokeRect(inX, fy, inW, sizeU * U_H);
  }

  // ---- Câbles (même géométrie que à l'écran) ----
  pruneCables(ws);
  for (const cable of ws.cables) {
    const ea = resolveEndpoint(ws, cable.a);
    const eb = resolveEndpoint(ws, cable.b);
    if (!ea || !eb) continue;
    const ap = exportPortPos(ea, minX, minY);
    const bp = exportPortPos(eb, minX, minY);
    if (!ap || !bp) continue;
    const { d } = cablePath(ap, bp);

    // ombre portée
    ctx.strokeStyle = 'rgba(0,0,0,.28)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.save();
    ctx.translate(3, 4);
    drawBezier(ctx, d);
    ctx.restore();
    // gaine
    ctx.strokeStyle = cable.color;
    ctx.lineWidth = 4;
    drawBezier(ctx, d);
    // extrémités
    ctx.fillStyle = cable.color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    [ap, bp].forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  }

  return c;

  // Position d'un port dans le repère du canvas d'export
  function exportPortPos(ep, minX, minY) {
    const { rack, inst, port } = ep;
    const fx = rack.x - minX + 6;
    const fy = rack.y - minY + 28 + 8;
    const rulerW = 22, railW = 17;
    const inX = fx + rulerW + railW;
    const top = fy + inst.slot * U_H;
    return {
      x: inX + (port.xPct / 100) * innerW,
      y: top + (port.yPct / 100) * (inst.sizeU * U_H)
    };
  }
}

// Dessine la vue topologie sur un canvas et le renvoie
function renderTopoCanvas() {
  const ws = active();
  if (!ws) return null;
  const topo = ws.topology;
  if (!topo || !topo.nodes.length) return null;

  const PAD = 60;
  const NW = 190, NH = 64;

  // Zone englobante des noeuds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  topo.nodes.forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + NW);
    maxY = Math.max(maxY, n.y + NH);
  });
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  const W = Math.ceil(maxX - minX);
  const H = Math.ceil(maxY - minY);

  const SCALE = 2;
  const c = document.createElement('canvas');
  c.width = W * SCALE;
  c.height = H * SCALE;
  const ctx = c.getContext('2d');
  ctx.scale(SCALE, SCALE);

  // Fond
  ctx.fillStyle = '#1a2130';
  ctx.fillRect(0, 0, W, H);

  // Grille de points
  ctx.fillStyle = '#252d3d';
  const gap = 24;
  for (let gx = gap / 2; gx < W; gx += gap) {
    for (let gy = gap / 2; gy < H; gy += gap) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Liens
  const nodeById = id => topo.nodes.find(n => n.id === id);
  for (const l of topo.links) {
    const na = nodeById(l.a), nb = nodeById(l.b);
    if (!na || !nb) continue;
    const x1 = na.x - minX + NW / 2, y1 = na.y - minY + NH / 2;
    const x2 = nb.x - minX + NW / 2, y2 = nb.y - minY + NH / 2;
    const color = l.color || '#60a5fa';

    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    if (l.style === 'dashed') ctx.setLineDash([7, 5]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);

    const label = [l.label, l.speed, l.vlan && 'VLAN ' + l.vlan].filter(Boolean).join(' · ');
    if (label) {
      ctx.fillStyle = '#e6ecf5';
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, (x1 + x2) / 2, (y1 + y2) / 2 - 6);
    }
  }

  // Noeuds
  for (const n of topo.nodes) {
    const info = topoInstOf(ws, n);
    const inst = info?.inst;
    const x = n.x - minX, y = n.y - minY;

    // Fond du noeud
    ctx.fillStyle = '#232b3a';
    ctx.strokeStyle = '#3b465a';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, NW, NH, 10);
    ctx.fill();
    ctx.stroke();

    // Bordure gauche colorée
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(x, y + 10, 4, NH - 20);

    // LED
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(x + 14, y + 16, 4, 0, Math.PI * 2);
    ctx.fill();

    // Nom
    ctx.fillStyle = '#eef2f8';
    ctx.font = 'bold 12.5px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncate(ctx, inst?.name || '?', NW - 30), x + 24, y + 16);

    // Sous-titre
    ctx.fillStyle = '#9fb0c8';
    ctx.font = '10.5px "Segoe UI", sans-serif';
    const sub = [inst?.brand, inst?.model].filter(Boolean).join(' ') || '—';
    ctx.fillText(truncate(ctx, sub, NW - 20), x + 10, y + 34);

    // Sous-titre 2
    ctx.fillStyle = '#7488a3';
    ctx.font = '10px "Segoe UI", sans-serif';
    const sub2 = info ? `${info.rack.name} · U${inst.slot + 1}` : '';
    ctx.fillText(truncate(ctx, sub2, NW - 20), x + 10, y + 48);
  }

  return c;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

// Trace un chemin Bézier SVG-like à partir de sa description "M..C.."
function drawBezier(ctx, d) {
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  // [M x y C x1 y1 x2 y2 x y]
  ctx.beginPath();
  ctx.moveTo(nums[0], nums[1]);
  ctx.bezierCurveTo(nums[2], nums[3], nums[4], nums[5], nums[6], nums[7]);
  ctx.stroke();
}

function truncate(ctx, text, maxW) {
  let t = text;
  while (ctx.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -1);
  return t === text ? t : t.slice(0, -1) + '…';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFileBase() {
  const ws = active();
  const name = (ws?.name || 'plan').replace(/[^a-z0-9-_]+/gi, '_');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${name}-${stamp}`;
}

// --- Menu Exporter ---
$('#btn-export').addEventListener('click', e => {
  e.stopPropagation();
  $('#export-menu').classList.toggle('hidden');
});
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.export-wrap')) $('#export-menu').classList.add('hidden');
});

$('#export-png').addEventListener('click', async () => {
  $('#export-menu').classList.add('hidden');
  const c = await renderPlanCanvas();
  if (!c) { alert('Ce workspace ne contient aucun rack à exporter.'); return; }
  c.toBlob(blob => blob && downloadBlob(blob, exportFileBase() + '.png'), 'image/png');
});

$('#export-pdf').addEventListener('click', async () => {
  $('#export-menu').classList.add('hidden');
  const c = await renderPlanCanvas();
  if (!c) { alert('Ce workspace ne contient aucun rack à exporter.'); return; }
  // Le PDF embarque le rendu en JPEG (une seule page)
  const jpeg = dataURLBytes(c.toDataURL('image/jpeg', 0.92));
  const blob = canvasToPdfBlob(c.width, c.height, jpeg);
  downloadBlob(blob, exportFileBase() + '.pdf');
});

/* ---------- Exports CSV / Excel (inventaire / câblage / ports / racks) ---------- */
// Format CSV « Excel FR » : séparateur « ; », BOM UTF-8, guillemets si besoin
function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  return '\uFEFF' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
}
function downloadCsv(rows, suffix) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, exportFileBase() + '-' + suffix + '.csv');
}
function slotLabel(inst) {
  return inst.sizeU > 1 ? `U${inst.slot + 1}–U${inst.slot + inst.sizeU}` : `U${inst.slot + 1}`;
}
// Racks triés par nom, instances du haut vers le bas du rack
function sortedRackInstances(ws) {
  return [...ws.racks]
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }))
    .flatMap(rack => [...rack.instances].sort((a, b) => b.slot - a.slot)
      .map(inst => ({ rack, inst })));
}
function sortedRacks(ws) {
  return [...(ws?.racks || [])]
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
}

function invRows(ws) {
  const rows = [['Rack', 'Étage', 'Taille', 'Nom', 'Marque', 'Modèle', 'Référence',
                 'N° série', 'IP mgmt', 'VLAN(s)', 'Puissance (W)', 'Poids (kg)', 'Ports']];
  for (const { rack, inst } of sortedRackInstances(ws || { racks: [] })) {
    rows.push([rack.name, slotLabel(inst), inst.sizeU + 'U', inst.name,
               inst.brand || '', inst.model || '', inst.partRef || '', inst.serial || '',
               inst.ipMgmt || '', inst.vlan || '',
               inst.watts || '', inst.weightKg || '', (inst.ports || []).length]);
  }
  return rows;
}
function cablingRows(ws) {
  const rows = [['ID câble', 'Couleur',
                 'Rack A', 'Device A', 'Port A', 'Étiquette A',
                 'Rack B', 'Device B', 'Port B', 'Étiquette B']];
  const epDesc = ep => {
    const d = resolveEndpoint(ws, ep);
    return d ? [d.rack.name, d.inst.name, d.port.name, d.port.label || ''] : ['', '', '', ''];
  };
  for (const c of (ws?.cables || [])) {
    rows.push([c.name || '', c.color || '', ...epDesc(c.a), ...epDesc(c.b)]);
  }
  return rows;
}
function portsRows(ws) {
  const rows = [['Rack', 'Étage', 'Device', 'Port', 'Étiquette', 'IP', 'VLAN', 'Câble']];
  const cableOf = (instId, portId) => {
    const c = (ws?.cables || []).find(cb =>
      (cb.a?.instId === instId && cb.a?.portId === portId) ||
      (cb.b?.instId === instId && cb.b?.portId === portId));
    return c ? c.name : '';
  };
  for (const { rack, inst } of sortedRackInstances(ws || { racks: [] })) {
    for (const p of (inst.ports || [])) {
      rows.push([rack.name, slotLabel(inst), inst.name, p.name, p.label || '',
                 p.ip || '', p.vlan || '', cableOf(inst.id, p.id)]);
    }
  }
  return rows;
}
function racksRows(ws) {
  const rows = [['Rack', 'Taille', 'U occupés', 'U libres',
                 'Puissance totale (W)', 'Budget puissance (W)',
                 'Poids total (kg)', 'Charge max (kg)', 'Devices']];
  for (const rack of sortedRacks(ws)) {
    const usedU = rack.instances.reduce((s, i) => s + i.sizeU, 0);
    rows.push([
      rack.name, rack.sizeU + 'U', usedU, rack.sizeU - usedU,
      rack.instances.reduce((s, i) => s + (i.watts || 0), 0) || '',
      rack.maxWatts || '',
      Math.round(rack.instances.reduce((s, i) => s + (i.weightKg || 0), 0) * 10) / 10 || '',
      rack.maxKg || '',
      rack.instances.length
    ]);
  }
  return rows;
}

$('#export-csv-inv').addEventListener('click', () => {
  $('#export-menu').classList.add('hidden');
  const rows = invRows(active());
  if (rows.length < 2) { alert("Aucun device placé dans ce workspace : l'inventaire serait vide."); return; }
  downloadCsv(rows, 'inventaire');
});

$('#export-csv-cab').addEventListener('click', () => {
  $('#export-menu').classList.add('hidden');
  const rows = cablingRows(active());
  if (rows.length < 2) { alert('Aucun câble dans ce workspace : le tableau de câblage serait vide.'); return; }
  downloadCsv(rows, 'cablage');
});

$('#export-csv-ports').addEventListener('click', () => {
  $('#export-menu').classList.add('hidden');
  const rows = portsRows(active());
  if (rows.length < 2) { alert('Aucun port étiqueté dans ce workspace : l\'export serait vide.'); return; }
  downloadCsv(rows, 'ports');
});

/* ---------- Générateur Excel .xlsx (OOXML minimal, sans dépendance) ----------
   Un classeur = un ZIP contenant des fichiers XML, écrit à la main :
   ZIP « store » (sans compression) + CRC32 + cellules en chaînes inline.
   En-têtes en gras sur fond bleu, largeurs de colonnes auto, 1re ligne figée. */
const XLSX = (() => {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const enc = new TextEncoder();
  const xmlEsc = s => String(s ?? '').replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  function colName(i) {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
    return s;
  }

  function sheetXml(rows) {
    const nCols = Math.max(8, ...rows.map(r => r.length));
    const widths = [];
    for (let c = 0; c < nCols; c++) {
      let m = 8;
      for (const r of rows) {
        const v = r[c];
        if (v !== undefined && v !== null) m = Math.max(m, String(v).length);
      }
      widths.push(Math.min(42, m + 2));
    }
    const cols = '<cols>' + widths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    let body = '';
    rows.forEach((row, ri) => {
      const cells = row.map((v, ci) => {
        if (v === undefined || v === null || v === '') return '';
        const ref = colName(ci) + (ri + 1);
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}>` +
               `<is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      }).join('');
      body += `<row r="${ri + 1}">${cells}</row>`;
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      cols + '<sheetData>' + body + '</sheetData></worksheet>';
  }

  const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const STYLES_XML = XML_DECL +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  // ZIP minimal (méthode « store », sans compression)
  function zip(files) {
    const chunks = [];
    const central = [];
    let offset = 0, cdSize = 0;
    const DOS_TIME = 0;
    const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(8, 0, true);          // store
      lh.setUint16(10, DOS_TIME, true);
      lh.setUint16(12, DOS_DATE, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(lh.buffer), name, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, DOS_TIME, true);
      ch.setUint16(14, DOS_DATE, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + data.length;
      cdSize += 46 + name.length;
    }
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
    const out = new Uint8Array(all.reduce((s, u) => s + u.length, 0));
    let p = 0;
    for (const u of all) { out.set(u, p); p += u.length; }
    return out;
  }

  function build(sheets) {
    const files = [
      { name: '[Content_Types].xml', data: XML_DECL +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>' },
      { name: '_rels/.rels', data: XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>' },
      { name: 'xl/workbook.xml', data: XML_DECL +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets>' + sheets.map((s, i) =>
          `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: XML_DECL +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((s, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>' },
      { name: 'xl/styles.xml', data: STYLES_XML },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) }))
    ];
    const u8 = zip(files);
    return new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  return { build };
})();

$('#export-xlsx').addEventListener('click', () => {
  $('#export-menu').classList.add('hidden');
  const ws = active();
  if (!ws || !ws.racks.length) { alert('Ce workspace ne contient aucun rack à exporter.'); return; }
  const sheets = [
    { name: 'Inventaire', rows: invRows(ws) },
    { name: 'Câblage',    rows: cablingRows(ws) },
    { name: 'Ports',      rows: portsRows(ws) },
    { name: 'Racks',      rows: racksRows(ws) }
  ];
  downloadBlob(XLSX.build(sheets), exportFileBase() + '.xlsx');
});

/* ============================================================
   DOCUMENT LLD (PDF multi-pages)
   ------------------------------------------------------------
   Génère un dossier complet : page de garde + synthèse +
   tableaux (racks, inventaire, adressage, câblage) + élévations.
   Écriture PDF native (polices standard Helvetica, WinAnsi),
   sans dépendance — même approche que l'export Excel.
   ============================================================ */

const WINANSI_EXTRA = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E
};
function pdfEsc(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0);
    let b = null;
    if (cp >= 0x20 && cp <= 0x7E) b = cp;
    else if (cp >= 0xA0 && cp <= 0xFF) b = cp;
    else if (WINANSI_EXTRA[cp] !== undefined) b = WINANSI_EXTRA[cp];
    else if (cp === 0x2026) b = 0x85;
    if (b === null) continue;
    const c = String.fromCharCode(b);
    if (c === '(' || c === ')' || c === '\\') out += '\\' + c;
    else out += c;
  }
  return out;
}
const strBytes = s => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF;
  return u;
};

function buildLldPdf(ws, planJpeg, planW, planH, topoJpeg, topoW, topoH) {
  const PW = 595.28, PH = 841.89, M = 42;
  const pagesOps = [];
  let cur = null, y = 0;

  // Opérations PDF réutilisables (permettent d'ajouter des pieds de page a posteriori)
  const textOp = (x, yy, s, size = 10, bold = false, color = [0.13, 0.16, 0.22]) =>
    `BT ${color.map(c => (+c).toFixed(2)).join(' ')} rg /${bold ? 'F2' : 'F1'} ${(+size).toFixed(1)} Tf 1 0 0 1 ${(+x).toFixed(2)} ${(+yy).toFixed(2)} Tm (${pdfEsc(s)}) Tj ET`;
  const lineOp = (x1, yy, x2, color = [0.82, 0.85, 0.89], lw = 0.7) =>
    `${color.map(c => (+c).toFixed(2)).join(' ')} RG ${lw} w ${(+x1).toFixed(2)} ${(+yy).toFixed(2)} m ${(+x2).toFixed(2)} ${(+yy).toFixed(2)} l S`;

  const txt = (x, yy, s, size, bold, color) => cur.push(textOp(x, yy, s, size, bold, color));
  const rectFill = (x, yy, w, h, color) => {
    cur.push(`${color.map(c => (+c).toFixed(2)).join(' ')} rg ${(+x).toFixed(2)} ${(+yy).toFixed(2)} ${(+w).toFixed(2)} ${(+h).toFixed(2)} re f`);
  };
  const hline = (x1, x2, yy) => cur.push(lineOp(x1, yy, x2));

  const newPage = () => { cur = []; pagesOps.push(cur); y = PH - M; };

  function heading(n, title) {
    if (y < M + 80) newPage();
    else y -= 14;
    txt(M, y - 12, `${n}. ${title}`, 14, true, [0.12, 0.31, 0.47]);
    hline(M, PW - M, y - 20);
    y -= 32;
  }

  function drawTable(rows, widths, size = 7.5) {
    const rowH = 14;
    const W = PW - 2 * M;
    const total = widths.reduce((a, b) => a + b, 0);
    const cw = widths.map(w => w / total * W);
    const drawHeader = () => {
      rectFill(M, y - rowH + 3.5, W, rowH, [0.12, 0.31, 0.47]);
      let x = M + 4;
      rows[0].forEach((h, i) => { txt(x, y - rowH + 3.5 + 4, String(h), size, true, [1, 1, 1]); x += cw[i]; });
      y -= rowH + 3.5;
    };
    drawHeader();
    for (let ri = 1; ri < rows.length; ri++) {
      if (y - rowH < M + 26) { newPage(); drawHeader(); }
      let x = M + 4;
      rows[ri].forEach((c, i) => {
        let s = String(c ?? '');
        const maxChars = Math.max(3, Math.floor(cw[i] / (size * 0.5)));
        if (s.length > maxChars) s = s.slice(0, Math.max(2, maxChars - 1)) + '\u2026';
        txt(x, y - rowH + 4.5, s, size);
        x += cw[i];
      });
      y -= rowH;
      hline(M, M + W, y + 3.5, [0.9, 0.92, 0.94]);
    }
    y -= 8;
  }

  const L = normLldInfo(ws);
  const dateStr = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const dateShort = new Date().toLocaleDateString('fr-FR');

  // ---- Page de garde ----
  newPage();
  y -= 110;
  txt(M, y, 'Dossier LLD', 30, true, [0.12, 0.31, 0.47]); y -= 20;
  txt(M, y, 'Low Level Design \u2014 Datacenter & Infrastructure', 12, false, [0.45, 0.5, 0.58]); y -= 36;
  txt(M, y, ws.name, 20, true); y -= 30;
  const meta = [['Client', L.client], ['Auteur', L.author], ['Version', L.version], ['Date', dateStr]];
  meta.forEach(([k, v]) => {
    if (!v) return;
    txt(M, y, k, 10, false, [0.45, 0.5, 0.58]);
    txt(M + 100, y, v, 10, true);
    y -= 16;
  });
  y -= 22;

  const totU = ws.racks.reduce((s, r) => s + r.sizeU, 0);
  const usedU = ws.racks.reduce((s, r) => s + r.instances.reduce((a, i) => a + i.sizeU, 0), 0);
  const totW = ws.racks.reduce((s, r) => s + r.instances.reduce((a, i) => a + (i.watts || 0), 0), 0);
  const totKg = ws.racks.reduce((s, r) => s + r.instances.reduce((a, i) => a + (i.weightKg || 0), 0), 0);
  const totPorts = ws.racks.reduce((s, r) => s + r.instances.reduce((a, i) => a + (i.ports || []).length, 0), 0);
  const stats = [
    ['Racks', String(ws.racks.length)],
    ['Devices pos\u00e9s', String(ws.racks.reduce((s, r) => s + r.instances.length, 0))],
    ['Ports \u00e9tiquet\u00e9s', String(totPorts)],
    ['C\u00e2bles', String((ws.cables || []).length)],
    ['Occupation', `${usedU}U / ${totU}U`],
    ['Puissance estim\u00e9e', fmtWatts(totW)],
    ['Poids estim\u00e9', `${Math.round(totKg)} kg`],
    ['Liens logiques', String((ws.topology?.links || []).length)]
  ];
  stats.forEach(([k, v]) => {
    txt(M, y, k, 10, false, [0.45, 0.5, 0.58]);
    txt(M + 160, y, v, 10, true);
    y -= 17;
  });

  if (L.revs.length) {
    y -= 16;
    txt(M, y, 'Historique des r\u00e9visions', 12, true, [0.12, 0.31, 0.47]); y -= 8;
    const revRows = [['R\u00e9v', 'Date', 'Auteur', 'Modifications']];
    L.revs.forEach(r => revRows.push([r.rev, r.date, r.author, r.note]));
    drawTable(revRows, [0.8, 1.6, 2.4, 5.2], 8);
  }
  y = Math.min(y, M + 24);
  txt(M, y, 'G\u00e9n\u00e9r\u00e9 par LLDraw', 9, false, [0.6, 0.65, 0.72]);

  // ---- 1. Synthèse des racks ----
  newPage();
  heading(1, 'Synth\u00e8se des racks (capacit\u00e9s)');
  drawTable(racksRows(ws), [3, 1.4, 1.5, 1.4, 2, 2, 2, 2, 1.4]);

  // ---- 2. Inventaire ----
  heading(2, 'Inventaire des devices');
  drawTable(invRows(ws), [1.7, 1.5, 0.9, 2.2, 1.6, 2.2, 1.8, 1.6, 1.4, 1.4, 1.2, 1, 0.9]);

  // ---- 3. Adressage & ports ----
  heading(3, 'Plan d\u2019adressage & ports');
  const pr = portsRows(ws);
  if (pr.length > 1) drawTable(pr, [1.6, 1.3, 2, 1.6, 1.8, 1.8, 1.1, 1.4]);
  else { txt(M, y - 8, 'Aucun port \u00e9tiquet\u00e9.', 9.5, false, [0.45, 0.5, 0.58]); y -= 24; }

  // ---- 4. Câblage ----
  heading(4, 'Tableau de c\u00e2blage');
  const cr = cablingRows(ws);
  if (cr.length > 1) drawTable(cr, [1.3, 1.1, 1.5, 1.8, 1.5, 1.7, 1.5, 1.8, 1.5, 1.7]);
  else { txt(M, y - 8, 'Aucun c\u00e2ble.', 9.5, false, [0.45, 0.5, 0.58]); y -= 24; }

  // ---- 5. Registre VLANs & subnets ----
  heading(5, 'Registre VLANs & subnets');
  if (L.vlans.length) {
    const vr = [['VLAN', 'Nom', 'Subnet', 'Passerelle', 'Usage']];
    L.vlans.forEach(v => vr.push([v.vid, v.name, v.subnet, v.gw, v.purpose]));
    drawTable(vr, [0.9, 2.4, 2.8, 2.4, 3.5], 8);
  } else {
    txt(M, y - 8, 'Aucun VLAN enregistr\u00e9 (bouton \u00ab Infos du dossier \u00bb du workspace).', 9.5, false, [0.45, 0.5, 0.58]);
    y -= 24;
  }

  // ---- 6. Topologie logique ----
  if (topoJpeg && topoW && topoH) {
    newPage();
    heading(6, 'Topologie logique');
    const availW = PW - 2 * M, availH = y - M - 10;
    const k = Math.min(availW / topoW, availH / topoH);
    const iw = topoW * k, ih = topoH * k;
    const ix = M + (availW - iw) / 2, iy = y - ih;
    cur.push(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /Im1 Do Q`);
  }

  // ---- 7. Élévations ----
  if (planJpeg && planW && planH) {
    newPage();
    heading(7, '\u00c9l\u00e9vations des racks');
    const availW = PW - 2 * M, availH = y - M - 10;
    const k = Math.min(availW / planW, availH / planH);
    const iw = planW * k, ih = planH * k;
    const ix = M + (availW - iw) / 2, iy = y - ih;
    cur.push(`q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ix.toFixed(2)} ${iy.toFixed(2)} cm /Im0 Do Q`);
  }

  // ---- Pieds de page (toutes les pages sauf la garde) ----
  const nPages = pagesOps.length;
  const footerName = String(ws.name).slice(0, 60);
  pagesOps.forEach((ops, i) => {
    if (i === 0) return;
    ops.push(lineOp(M, 34, PW - M, [0.85, 0.87, 0.9], 0.6));
    ops.push(textOp(M, 22, `${footerName} \u2014 Dossier LLD`, 8, false, [0.55, 0.58, 0.64]));
    ops.push(textOp(PW - M - 60, 22, `Page ${i + 1} / ${nPages}`, 8, false, [0.55, 0.58, 0.64]));
    ops.push(textOp(PW / 2 - 22, 22, dateShort, 8, false, [0.55, 0.58, 0.64]));
  });

  // ================= Assemblage du fichier PDF =================
  const strBytes = s => {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF;
    return u;
  };

  const parts = [];
  let offset = 0;
  const push = data => {
    const u = typeof data === 'string' ? strBytes(data) : data;
    parts.push(u);
    offset += u.length;
  };
  const offsets = [];
  const addObj = body => {
    offsets.push(offset);
    push(`${offsets.length} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');

  const hasPlan = !!(planJpeg && planW && planH);
  const hasTopo = !!(topoJpeg && topoW && topoH);
  const firstPageObj = 5;
  const contentObjs = [];
  pagesOps.forEach((_, i) => contentObjs.push(firstPageObj + nPages + i));
  const img0Num = firstPageObj + 2 * nPages;
  const img1Num = img0Num + 1;

  addObj(`<< /Type /Catalog /Pages 2 0 R >>`);
  const kids = pagesOps.map((_, i) => `${firstPageObj + i} 0 R`).join(' ');
  addObj(`<< /Type /Pages /Count ${nPages} /Kids [${kids}] >>`);
  addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  addObj(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);

  pagesOps.forEach((ops, i) => {
    let res = `<< /Font << /F1 3 0 R /F2 4 0 R >>`;
    if (hasPlan) res += ` /XObject << /Im0 ${img0Num} 0 R >>`;
    if (hasTopo) res += ` /XObject << /Im1 ${img1Num} 0 R >>`;
    res += ` >>`;
    addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources ${res} /Contents ${contentObjs[i]} 0 R >>`);
  });
  pagesOps.forEach(ops => {
    const body = ops.join('\n');
    addObj(`<< /Length ${strBytes(body).length} >>\nstream\n${body}\nendstream`);
  });
  const addImage = (num, bytes, w, h) => {
    offsets.push(offset); // re-numérotation : voir ci-dessous
    push(`${num} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
    push(bytes);
    push(`\nendstream\nendobj\n`);
  };
  if (hasPlan) addImage(img0Num, planJpeg, planW, planH);
  if (hasTopo) addImage(img1Num, topoJpeg, topoW, topoH);

  const xrefPos = offset;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
  push(xref);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const total = parts.reduce((s, u) => s + u.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const u of parts) { out.set(u, p); p += u.length; }
  return out;
}

$('#export-lld').addEventListener('click', async () => {
  $('#export-menu').classList.add('hidden');
  const ws = active();
  if (!ws || !ws.racks.length) { alert('Ce workspace ne contient aucun rack à exporter.'); return; }
  const c = await renderPlanCanvas();
  let jpeg = null, w = 0, h = 0;
  if (c) {
    jpeg = dataURLBytes(c.toDataURL('image/jpeg', 0.85));
    w = c.width; h = c.height;
  }
  const tc = renderTopoCanvas();
  let tj = null, tw = 0, th = 0;
  if (tc) {
    tj = dataURLBytes(tc.toDataURL('image/jpeg', 0.9));
    tw = tc.width; th = tc.height;
  }
  const u8 = buildLldPdf(ws, jpeg, w, h, tj, tw, th);
  downloadBlob(new Blob([u8], { type: 'application/pdf' }), exportFileBase() + '-LLD.pdf');
});


function dataURLBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// PDF minimal : une page contenant une image JPEG plein format
function canvasToPdfBlob(w, h, jpegBytes) {
  const W = w, H = h;
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = b => { chunks.push(b); pos += b.length; };
  const s = str => push(enc.encode(str));

  s('%PDF-1.4\n');
  offsets[1] = pos;
  s('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n');
  offsets[2] = pos;
  s('2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n');
  offsets[3] = pos;
  s(`3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${W} ${H}]/Resources<</XObject<</Im1 4 0 R>>>>/Contents 5 0 R>>endobj\n`);
  offsets[4] = pos;
  s(`4 0 obj<</Type/XObject/Subtype/Image/Width ${w}/Height ${h}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpegBytes.length}>>stream\n`);
  push(jpegBytes);
  s('\nendstream\nendobj\n');
  offsets[5] = pos;
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q\n`;
  s(`5 0 obj<</Length ${content.length}>>stream\n${content}endstream\nendobj\n`);
  const xrefStart = pos;
  s(`xref\n0 6\n0000000000 65535 f \n`);
  for (let i = 1; i <= 5; i++) {
    s(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }
  s(`trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`);

  return new Blob(chunks, { type: 'application/pdf' });
}

/* ============================================================
   RECHERCHE GLOBALE (device / port / étiquette), tous workspaces
   ============================================================ */

const searchInput = $('#global-search');
const searchResults = $('#search-results');

function doSearch(query) {
  const q = query.trim().toLowerCase();
  const results = [];
  if (!q) return results;

  for (const ws of state.workspaces) {
    for (const rack of ws.racks) {
      for (const inst of rack.instances) {
        // Device (nom)
        if (inst.name.toLowerCase().includes(q)) {
          results.push({
            type: 'device', ws, rack, inst,
            label: inst.name,
            path: `${rack.name} · ${ws.name}`
          });
        }
        // Ports (nom + étiquette)
        (inst.ports || []).forEach(port => {
          if ((port.name || '').toLowerCase().includes(q) ||
              (port.label || '').toLowerCase().includes(q)) {
            results.push({
              type: 'port', ws, rack, inst, port,
              label: `${port.name}${port.label ? ' — ' + port.label : ''}`,
              path: `${inst.name} · ${rack.name} · ${ws.name}`
            });
          }
        });
      }
    }
  }
  return results.slice(0, 30);
}

function renderSearchResults(results, query) {
  searchResults.innerHTML = '';
  if (!results.length) {
    searchResults.innerHTML = `<div class="sr-empty">Aucun résultat pour « ${escapeHtml(query)} »</div>`;
    searchResults.classList.remove('hidden');
    return;
  }
  results.forEach(r => {
    const item = document.createElement('button');
    item.className = 'sr-item';
    item.innerHTML = `
      <span class="sr-type ${r.type === 'port' ? 'port' : ''}">${r.type === 'port' ? 'Port' : 'Device'}</span>
      <span class="sr-body">
        <span class="sr-name"></span>
        <span class="sr-path"></span>
      </span>`;
    item.querySelector('.sr-name').textContent = r.label;
    item.querySelector('.sr-path').textContent = r.path;
    item.addEventListener('click', () => {
      searchResults.classList.add('hidden');
      searchInput.value = r.label.split(' — ')[0];
      focusOnResult(r);
    });
    searchResults.appendChild(item);
  });
  searchResults.classList.remove('hidden');
}

searchInput.addEventListener('input', e => {
  const q = e.target.value;
  if (!q.trim()) { searchResults.classList.add('hidden'); return; }
  renderSearchResults(doSearch(q), q);
});
searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) renderSearchResults(doSearch(searchInput.value), searchInput.value);
});
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('.search-box')) searchResults.classList.add('hidden');
});

// Centre la vue sur un rack et fait clignoter le résultat
function focusOnResult(r) {
  if (state.activeWorkspaceId !== r.ws.id) {
    openWorkspace(r.ws.id);
  }
  hideHome();

  const rect = viewport.getBoundingClientRect();
  const scale = 1;
  view.scale = scale;
  view.x = rect.width  / 2 - (r.rack.x + RACK_W / 2) * scale;
  view.y = rect.height / 2 - (r.rack.y + rackHeight(r.rack) / 2) * scale;
  markViewTouched();
  applyView();
  renderBoard();

  // Laisser le DOM se mettre à jour avant de clignoter
  requestAnimationFrame(() => {
    const rackEl = board.querySelector(`.rack[data-rack-id="${r.rack.id}"]`);
    const devEl = rackEl?.querySelector(`.device[data-instance-id="${r.inst.id}"]`);
    if (!devEl) return;
    if (r.port) {
      const portEl = devEl.querySelector(`.port[data-port-id="${r.port.id}"]`);
      if (portEl) {
        portEl.classList.remove('flash-port');
        void portEl.offsetWidth; // relancer l'animation
        portEl.classList.add('flash-port');
        setTimeout(() => portEl.classList.remove('flash-port'), 5500);
      }
    } else {
      devEl.classList.remove('flash-target');
      void devEl.offsetWidth;
      devEl.classList.add('flash-target');
      setTimeout(() => devEl.classList.remove('flash-target'), 5500);
    }
  });
}

// ---------- Initialisation ----------
async function boot() {
  // Récupère l'état depuis le serveur (JSON) ou, à défaut, le navigateur
  await bootState();
  renderPalette();
  renderBoard();
  // Recadrage automatique sur le contenu du workspace courant (ou vue par défaut)
  applyWorkspaceView();
  // Démarrage sur l'écran d'accueil
  showHome();
}
boot();
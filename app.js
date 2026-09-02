'use strict';

/* ============================================================
   DC Rack Planner
   - Board navigable : zoom (molette / boutons) et pan (glisser le fond)
   - Glisser-déposer de racks de tailles variables sur le board
   - Création de devices (nom, taille en U, photo de face avant)
   - Drop des devices dans les racks : verrouillage auto à l'étage (U)
   - Mode "Étiquetage" : ports (carrés) + infobulle nom/étiquette
   - Workspaces avec écran d'accueil ; bibliothèque de devices partagée
   - Undo/Redo (Ctrl+Z / Ctrl+Y), export/import JSON, recherche globale
   - Persistance dans localStorage
   ============================================================ */

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

// Hauteur d'un rack à l'écran (en-tête + rembourrages + U)
function rackHeight(rack) {
  return 28 + 16 + (rack.sizeU || DEFAULT_RACK_U) * U_H;
}

// Normalisation d'un rack chargé (rétro-compatibilité)
function normalizeRack(r) {
  r.sizeU = r.sizeU || DEFAULT_RACK_U;
  if (!r.name) r.name = `Rack ${r.sizeU}U`;
  r.instances = Array.isArray(r.instances) ? r.instances : [];
  r.instances.forEach(i => {
    i.ports = Array.isArray(i.ports) ? i.ports : [];
    i.ports.forEach(p => { if (typeof p.size !== 'number') p.size = 1; });
  });
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
    d.ports.forEach(p => { if (typeof p.size !== 'number') p.size = 1; });
  });
  // Normalisation rétro-compatible + date de modification
  s.workspaces.forEach(w => {
    w.racks = (Array.isArray(w.racks) ? w.racks : []).map(normalizeRack);
    if (!Array.isArray(w.cables)) w.cables = [];
    if (typeof w.updatedAt !== 'number') w.updatedAt = 0;
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
  renderWorkspaces();
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

// Recentre/zoome la vue sur l'ensemble des racks du workspace (ou s'apprête à
// recevoir un rack au centre si le board est vide). forceScale = 1 pour le ⌂.
function fitViewToContent(forceScale = null) {
  const ws = active();
  const rect = viewport.getBoundingClientRect();
  const PAD = 80;

  if (!ws || !ws.racks.length) {
    view.scale = forceScale ?? 1;
    view.x = rect.width  / 2 - RACK_W / 2;
    view.y = rect.height / 2 - 200;
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
  if (e.target.closest('.rack, .zoom-ctrl, .popover, .tooltip')) return;

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
      <button class="mini-del" title="Supprimer ce modèle de device">✕</button>`;

    card.addEventListener('dragstart', e => {
      dragPayload = { kind: 'device', deviceId: d.id, size: d.sizeU };
      e.dataTransfer.setData('application/x-dc-device', d.id);
      e.dataTransfer.effectAllowed = 'copy';
    });

    card.querySelector('.mini-del').addEventListener('click', () => {
      if (confirm(`Supprimer le modèle "${d.name}" de la bibliothèque ?\n(Les exemplaires déjà placés sont conservés.)`)) {
        pushHistory();
        state.devices = state.devices.filter(x => x.id !== d.id);
        saveState();
        renderPalette();
      }
    });

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
  const ws = active();
  const empty = $('#board-empty');
  if (!ws) { empty.classList.add('hidden'); return; }
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
    <span class="rack-vents"></span>
    <button class="mini-del" title="Supprimer le rack">✕</button>`;
  el.appendChild(header);

  const titleEl = header.querySelector('.rack-title');
  titleEl.textContent = rack.name;
  const sizeSel = header.querySelector('.rack-size-sel');
  sizeSel.value = String(rack.sizeU);

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
          ports: (tpl.ports || []).map(p => ({
            id: uid(), xPct: p.xPct, yPct: p.yPct,
            name: p.name, label: p.label || '', size: p.size || 1
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

  const { inst, port, xPct, yPct } = popoverCtx;
  const size = Math.round(parseInt($('#p-size').value, 10)) / 100 || 1;
  pushHistory();
  if (port) {
    port.name = name;
    port.label = label;
    port.size = size;
  } else {
    inst.ports.push({ id: uid(), xPct, yPct, name, label, size });
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
    ${port.label ? `<div class="tt-label">${escapeHtml(port.label)}</div>` : ''}`;
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

$('#btn-new-device').addEventListener('click', () => {
  $('#d-name').value = '';
  $('#d-size').value = '1';
  $('#d-photo').value = '';
  $('#d-preview').classList.add('hidden');
  $('#d-detect').classList.add('hidden');
  modalPhoto = null;
  modalPorts = [];
  $('#device-modal').classList.remove('hidden');
  $('#d-name').focus();
});

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
  modalPorts = [];
  const detectBox = $('#d-detect');
  detectBox.classList.add('hidden');
  const overlay = $('#d-overlay');
  overlay.innerHTML = '';
  if (modalPhoto) {
    const id = await imageDataFromUrl(modalPhoto);
    let ports = [];
    try { ports = PortDetect.portsFromImageData(id); } catch (err) { console.warn('Détection de ports échouée', err); }
    modalPorts = ports;

    // carrés d'aperçu positionnés en % sur la photo
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
});

$('#d-save').addEventListener('click', () => {
  const name = $('#d-name').value.trim();
  if (!name) { $('#d-name').focus(); return; }
  const sizeU = parseInt($('#d-size').value, 10) || 1;
  const usePorts = $('#d-ports-use').checked && modalPorts.length > 0;
  pushHistory();
  state.devices.push({
    id: uid(), name, sizeU, photo: modalPhoto,
    ports: usePorts ? modalPorts.map((p, i) => ({
      id: uid(), xPct: p.xPct, yPct: p.yPct, name: String(i + 1), label: '', size: p.size || 1
    })) : []
  });
  saveState();
  renderPalette();
  $('#device-modal').classList.add('hidden');
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
   DIVERS
   ============================================================ */

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (pendingPort) { pendingPort = null; renderCables(); return; }
    hidePortPopover();
    hideCablePopoverSafe();
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
  saveState();
  state.activeWorkspaceId = ws.id;
  pendingPort = null;
  hideCablePopoverSafe();

  applyWorkspaceView();

  hidePortPopover();
  // Désactive les modes Créer/Modifier en changeant de workspace
  if (labelMode) setLabelMode(null);

  hideHome();
  renderWorkspaces();
  renderBoard();
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
  renderWorkspaces();

  if (homeScreen.classList.contains('hidden')) {
    // On était dans ce workspace : retour à l'accueil
    showHome();
  } else {
    renderHomeList();
  }
}

// Bouton "Créer un workspace" de l'accueil
$('#home-new').addEventListener('click', createWorkspace);
// Bouton "accueil" de la barre du haut
$('#btn-home').addEventListener('click', showHome);

/* ============================================================
   WORKSPACES (sélecteur dans la barre du haut)
   ============================================================ */

function renderWorkspaces() {
  const sel = $('#ws-select');
  sel.innerHTML = '';
  state.workspaces.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.name;
    sel.appendChild(opt);
  });
  sel.value = state.activeWorkspaceId || '';
}

$('#ws-select').addEventListener('change', e => {
  if (e.target.value) openWorkspace(e.target.value);
});

$('#ws-new').addEventListener('click', createWorkspace);

$('#ws-rename').addEventListener('click', () => {
  const ws = active();
  if (!ws) return;
  const name = prompt('Renommer le workspace :', ws.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === ws.name) return;
  pushHistory();
  ws.name = trimmed;
  ws.updatedAt = Date.now();
  saveState();
  renderWorkspaces();
  renderHomeListSafe();
});

$('#ws-del').addEventListener('click', () => {
  const ws = active();
  if (!ws) return;
  deleteWorkspace(ws.id);
  // S'il reste des workspaces, basculer sur le premier ; sinon accueil
  if (state.workspaces.length) {
    openWorkspace(state.workspaces[0].id);
  } else {
    showHome();
  }
});

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
  renderWorkspaces();
  renderBoard();
  // Recadrage automatique sur le contenu du workspace courant (ou vue par défaut)
  applyWorkspaceView();
  // Démarrage sur l'écran d'accueil
  showHome();
}
boot();
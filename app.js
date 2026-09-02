'use strict';

/* ============================================================
   DC Rack Planner
   - Board navigable : zoom (molette / boutons) et pan (glisser le fond)
   - Glisser-déposer d'une baie 12U sur le board
   - Création de devices (nom, taille en U, photo de face avant)
   - Drop des devices dans les baies : verrouillage auto à l'étage (U)
   - Mode "Étiquetage" : ports (carrés) + infobulle nom/étiquette
   - Persistance dans localStorage
   ============================================================ */

// ---------- Constantes ----------
const STORAGE_KEY = 'dc-rack-planner-v1';
const RACK_U  = 12;
const U_H     = 33;          // hauteur d'un U en px (coordonnées board)
const RACK_W  = 356;         // largeur d'une baie
const RACK_H  = 445;         // hauteur approximative d'une baie
const BOARD_W = 8000;
const BOARD_H = 6000;
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

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
let state = loadState();
let labelingMode = false;
let dragPayload = null;
let popoverCtx = null;

// Vue du board (décalage + échelle) — mémorisée par workspace
const view = { x: 80, y: 50, scale: 1 };

function makeWorkspace(name, racks = []) {
  return { id: uid(), name, racks, view: { x: 80, y: 50, scale: 1 } };
}

function loadState() {
  let s = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) s = JSON.parse(raw);
  } catch (e) { s = null; }

  if (!s || !Array.isArray(s.devices)) {
    return { devices: [], workspaces: [makeWorkspace('Workspace 1')], activeWorkspaceId: null };
  }

  // Migration d'une ancienne version (racks au niveau global)
  if (!Array.isArray(s.workspaces)) {
    const ws = makeWorkspace('Workspace 1', Array.isArray(s.racks) ? s.racks : []);
    s.workspaces = [ws];
    s.activeWorkspaceId = ws.id;
  }
  if (!s.workspaces.length) s.workspaces.push(makeWorkspace('Workspace 1'));
  if (!s.workspaces.some(w => w.id === s.activeWorkspaceId)) {
    s.activeWorkspaceId = s.workspaces[0].id;
  }
  return s;
}

// Workspace courant
function active() {
  return state.workspaces.find(w => w.id === state.activeWorkspaceId) || state.workspaces[0];
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Sauvegarde impossible (quota localStorage ?)', e);
  }
}

// Sauvegarde différée (pour la vue, sollicitée pendant le zoom/pan)
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

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
  if (ws) { ws.view = { x: view.x, y: view.y, scale: view.scale }; }
  scheduleSave();
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
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add('panning');

  const onMove = ev => {
    view.x = ox + ev.clientX - startX;
    view.y = oy + ev.clientY - startY;
    applyView();
  };
  const onUp = () => {
    viewport.classList.remove('panning');
    viewport.removeEventListener('pointermove', onMove);
    viewport.removeEventListener('pointerup', onUp);
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
  view.x = 80; view.y = 50; view.scale = 1;
  applyView();
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
        state.devices = state.devices.filter(x => x.id !== d.id);
        saveState();
        renderPalette();
      }
    });

    list.appendChild(card);
  });
}

// Baie de la palette
$('#pal-rack').addEventListener('dragstart', e => {
  dragPayload = { kind: 'rack' };
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
  const rack = {
    id: uid(),
    x: Math.max(0, Math.min(p.x - RACK_W / 2, BOARD_W - RACK_W)),
    y: Math.max(0, Math.min(p.y - 30,        BOARD_H - RACK_H)),
    instances: []
  };
  active().racks.push(rack);
  dragPayload = null;
  saveState();
  renderBoard();
});

function renderBoard() {
  board.innerHTML = '';
  const ws = active();
  ws.racks.forEach(rack => board.appendChild(renderRack(rack)));
  $('#board-empty').classList.toggle('hidden', ws.racks.length > 0);
}

/* ============================================================
   BAIE (rack)
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
    <span class="rack-title">Baie 12U</span>
    <span class="rack-vents"></span>
    <button class="mini-del" title="Supprimer la baie">✕</button>`;
  el.appendChild(header);

  // Déplacement de la baie par son en-tête
  header.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    e.stopPropagation(); // ne pas déclencher le pan du board
    const startX = e.clientX, startY = e.clientY;
    const ox = rack.x, oy = rack.y;
    header.setPointerCapture(e.pointerId);
    const onMove = ev => {
      rack.x = Math.max(0, Math.min(ox + (ev.clientX - startX) / view.scale, BOARD_W - RACK_W));
      rack.y = Math.max(0, Math.min(oy + (ev.clientY - startY) / view.scale, BOARD_H - RACK_H));
      el.style.left = rack.x + 'px';
      el.style.top  = rack.y + 'px';
    };
    const onUp = () => {
      header.removeEventListener('pointermove', onMove);
      header.removeEventListener('pointerup', onUp);
      saveState();
    };
    header.addEventListener('pointermove', onMove);
    header.addEventListener('pointerup', onUp);
  });

  header.querySelector('.mini-del').addEventListener('click', () => {
    if (confirm('Supprimer cette baie et tous les devices qu\'elle contient ?')) {
      const ws = active();
      ws.racks = ws.racks.filter(r => r.id !== rack.id);
      saveState();
      renderBoard();
    }
  });

  // ---- Corps : règle U + montants + zone intérieure ----
  const bodyEl = document.createElement('div');
  bodyEl.className = 'rack-body';

  const frame = document.createElement('div');
  frame.className = 'rack-frame';

  // Règle des U (U12 en haut … U1 en bas)
  const ruler = document.createElement('div');
  ruler.className = 'u-ruler';
  for (let i = 0; i < RACK_U; i++) {
    const u = document.createElement('div');
    u.className = 'u-label';
    u.textContent = RACK_U - i;
    ruler.appendChild(u);
  }
  frame.appendChild(ruler);

  // Montant gauche perforé
  const railL = document.createElement('div');
  railL.className = 'rail';
  frame.appendChild(railL);

  // Zone intérieure
  const inner = document.createElement('div');
  inner.className = 'rack-inner';

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
    const slot = slotFromPointer(inner, e.clientY, size);
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
    const slot = slotFromPointer(inner, e.clientY, size);
    const excludeId = dragPayload.kind === 'instance' ? dragPayload.instId : null;

    if (!isSlotFree(rack, slot, size, excludeId)) {
      dragPayload = null;
      return;
    }

    if (dragPayload.kind === 'device') {
      const tpl = state.devices.find(d => d.id === dragPayload.deviceId);
      if (tpl) {
        rack.instances.push({
          id: uid(),
          deviceId: tpl.id,
          name: tpl.name,
          sizeU: tpl.sizeU,
          photo: tpl.photo,
          slot,
          ports: []
        });
      }
    } else {
      // déplacement d'un device déjà placé (vers un autre étage / une autre baie)
      let oldRack = null;
      for (const w of state.workspaces) {
        oldRack = w.racks.find(r => r.instances.some(i => i.id === dragPayload.instId));
        if (oldRack) break;
      }
      if (oldRack) {
        const idx = oldRack.instances.findIndex(i => i.id === dragPayload.instId);
        const [inst] = oldRack.instances.splice(idx, 1);
        inst.slot = slot;
        rack.instances.push(inst);
      }
    }

    dragPayload = null;
    saveState();
    renderBoard();
  });

  // --- Réamorçage du drag depuis un device placé ---
  inner.addEventListener('dragstart', e => {
    const devEl = e.target.closest('.device');
    if (!devEl || labelingMode) { e.preventDefault(); return; }
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
      rack.instances = rack.instances.filter(i => i.id !== devEl.dataset.instanceId);
      saveState();
      renderBoard();
      return;
    }

    if (!labelingMode) return;
    const devEl = e.target.closest('.device');
    if (!devEl) return;
    e.stopPropagation();

    const inst = rack.instances.find(i => i.id === devEl.dataset.instanceId);
    if (!inst) return;

    const portEl = e.target.closest('.port');
    if (portEl) {
      const port = inst.ports.find(p => p.id === portEl.dataset.portId);
      if (port) openPortPopover(e.clientX, e.clientY, rack, inst, port);
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
  dev.draggable = !labelingMode;

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
    port.className = 'port';
    port.dataset.portId = p.id;
    port.style.left = p.xPct + '%';
    port.style.top  = p.yPct + '%';
    dev.appendChild(port);
  });

  // Bouton de retrait
  const del = document.createElement('button');
  del.className = 'device-del';
  del.title = 'Retirer de la baie';
  del.textContent = '✕';
  dev.appendChild(del);

  return dev;
}

/* ---------- Calcul d'emplacement (indépendant du zoom) ---------- */
function slotFromPointer(inner, clientY, size) {
  const rect = inner.getBoundingClientRect();
  // position relative en U (le rect tient compte de l'échelle du board)
  const uPos = ((clientY - rect.top) / rect.height) * RACK_U;
  // centre du device sur le pointeur
  let slot = Math.round(uPos - size / 2);
  return Math.max(0, Math.min(slot, RACK_U - size));
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

$('#btn-label').addEventListener('click', () => {
  labelingMode = !labelingMode;
  document.body.classList.toggle('labeling', labelingMode);
  $('#btn-label').classList.toggle('active', labelingMode);
  $('#mode-hint').textContent = labelingMode
    ? 'Mode étiquetage : cliquez sur un device pour placer un port. Cliquez sur un port existant pour le modifier.'
    : 'Glissez une baie sur le board, puis ajoutez vos devices.';
  hidePortPopover();
  renderBoard();
});

function openPortPopover(clientX, clientY, rack, inst, port, xPct = null, yPct = null) {
  const pop = $('#port-popover');
  popoverCtx = {
    rack, inst, port,
    xPct: port ? port.xPct : xPct,
    yPct: port ? port.yPct : yPct
  };

  $('#pp-title').textContent = port ? 'Modifier le port' : 'Nouveau port';
  $('#p-name').value  = port ? port.name  : '';
  $('#p-label').value = port ? port.label : '';
  $('#p-delete').classList.toggle('hidden', !port);

  pop.classList.remove('hidden');

  const w = pop.offsetWidth, h = pop.offsetHeight;
  let x = clientX + 14, y = clientY + 14;
  if (x + w > window.innerWidth - 10)  x = clientX - w - 14;
  if (y + h > window.innerHeight - 10) y = clientY - h - 14;
  pop.style.left = Math.max(8, x) + 'px';
  pop.style.top  = Math.max(8, y) + 'px';

  $('#p-name').focus();
}

function hidePortPopover() {
  $('#port-popover').classList.add('hidden');
  popoverCtx = null;
}

$('#p-save').addEventListener('click', () => {
  if (!popoverCtx) return;
  const name = $('#p-name').value.trim();
  const label = $('#p-label').value.trim();
  if (!name) { $('#p-name').focus(); return; }

  const { inst, port, xPct, yPct } = popoverCtx;
  if (port) {
    port.name = name;
    port.label = label;
  } else {
    inst.ports.push({ id: uid(), xPct, yPct, name, label });
  }
  hidePortPopover();
  saveState();
  renderBoard();
});

$('#p-delete').addEventListener('click', () => {
  if (!popoverCtx || !popoverCtx.port) return;
  const { inst, port } = popoverCtx;
  inst.ports = inst.ports.filter(p => p.id !== port.id);
  hidePortPopover();
  saveState();
  renderBoard();
});

$('#p-cancel').addEventListener('click', hidePortPopover);

// Clic en dehors du popover = annulation
document.addEventListener('pointerdown', e => {
  const pop = $('#port-popover');
  if (popoverCtx && !pop.contains(e.target) && !e.target.closest('.port') &&
      !(labelingMode && e.target.closest('.device'))) {
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
  const rack = active().racks.find(r => r.id === rackEl.dataset.rackId);
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

/* ============================================================
   CRÉATION D'UN DEVICE (modale)
   ============================================================ */

let modalPhoto = null;

$('#btn-new-device').addEventListener('click', () => {
  $('#d-name').value = '';
  $('#d-size').value = '1';
  $('#d-photo').value = '';
  $('#d-preview').classList.add('hidden');
  modalPhoto = null;
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
  prev.querySelector('img').src = modalPhoto;
  prev.classList.remove('hidden');
});

$('#d-save').addEventListener('click', () => {
  const name = $('#d-name').value.trim();
  if (!name) { $('#d-name').focus(); return; }
  const sizeU = parseInt($('#d-size').value, 10) || 1;
  state.devices.push({ id: uid(), name, sizeU, photo: modalPhoto });
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

$('#btn-clear').addEventListener('click', () => {
  const ws = active();
  if (ws.racks.length === 0) return;
  if (confirm(`Vider le board du workspace « ${ws.name} » ? Toutes les baies (devices et ports compris) seront supprimées. La bibliothèque de devices et les autres workspaces sont conservés.`)) {
    ws.racks = [];
    saveState();
    renderBoard();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    hidePortPopover();
    $('#device-modal').classList.add('hidden');
  }
});

/* ============================================================
   WORKSPACES
   - Chaque workspace possède son board (baies + devices placés + ports)
   - La bibliothèque de devices (state.devices) est partagée
   - Rien n'est supprimé sans action explicite de l'utilisateur
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
  sel.value = state.activeWorkspaceId;
}

function switchWorkspace(id) {
  if (id === state.activeWorkspaceId) return;
  // Sauvegarder la vue du workspace qu'on quitte
  saveState();

  state.activeWorkspaceId = id;
  const ws = active();

  // Restaurer la vue mémorisée de ce workspace
  view.x     = ws.view?.x     ?? 80;
  view.y     = ws.view?.y     ?? 50;
  view.scale = ws.view?.scale ?? 1;
  applyView();

  hidePortPopover();
  saveState();
  renderBoard();
  renderWorkspaces();
}

$('#ws-select').addEventListener('change', e => switchWorkspace(e.target.value));

$('#ws-new').addEventListener('click', () => {
  const name = prompt('Nom du nouveau workspace :', 'Workspace ' + (state.workspaces.length + 1));
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const ws = makeWorkspace(trimmed);
  state.workspaces.push(ws);
  saveState();
  switchWorkspace(ws.id);
});

$('#ws-rename').addEventListener('click', () => {
  const ws = active();
  const name = prompt('Renommer le workspace :', ws.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  ws.name = trimmed;
  saveState();
  renderWorkspaces();
});

$('#ws-del').addEventListener('click', () => {
  if (state.workspaces.length <= 1) {
    alert('Impossible de supprimer le dernier workspace. Vous pouvez plutôt le vider avec le bouton « Vider ».');
    return;
  }
  const ws = active();
  const count = ws.racks.reduce((n, r) => n + r.instances.length, 0);
  if (!confirm(
    `Supprimer définitivement le workspace « ${ws.name} » ?\n\n` +
    `Il contient ${ws.racks.length} baie(s) et ${count} device(s) placé(s).\n\n` +
    `Cette action est irréversible. La bibliothèque de devices (partagée) est conservée.`)) return;

  state.workspaces = state.workspaces.filter(w => w.id !== ws.id);
  state.activeWorkspaceId = state.workspaces[0].id;
  const next = active();
  view.x = next.view?.x ?? 80;
  view.y = next.view?.y ?? 50;
  view.scale = next.view?.scale ?? 1;
  saveState();
  applyView();
  hidePortPopover();
  renderBoard();
  renderWorkspaces();
});

// ---------- Initialisation ----------
{
  const ws = active();
  view.x = ws.view?.x ?? 80;
  view.y = ws.view?.y ?? 50;
  view.scale = ws.view?.scale ?? 1;
}
applyView();
renderWorkspaces();
renderPalette();
renderBoard();

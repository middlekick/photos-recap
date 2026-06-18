﻿/* ============================================================
   Rapport photo cordiste — logique applicative
   Vanilla JS · annotations vectorielles · export PDF (jsPDF)
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- État global ---------------- */
  const state = {
    photos: [],        // voir createPhoto()
    activeId: null,    // id de la photo en cours d'édition
    seq: 0,            // compteur d'id
  };

  // Outil d'édition courant (partagé entre sessions d'édition)
  const editor = {
    tool: 'arrow',
    color: '#FF3B30',
    width: 4,
    drawing: false,
    current: null,     // forme en cours de tracé
    start: null,
    target: null,      // la photo réelle (commit à la validation)
    draft: null,       // copie de travail { img, natW, natH, baseW, baseH, annotations }
    moving: null,      // déplacement d'une loupe : { shape, ox, oy }
    cropRect: null,    // recadrage en attente (coord base)
    cropHistory: [],   // pile de snapshots pour annuler un recadrage
    viewZoom: 1,       // zoom d'affichage de l'éditeur (précision)
  };

  const PALETTE = ['#FF3B30', '#FF6B00', '#FFD60A', '#34C759', '#1E6FBF', '#FFFFFF', '#111111'];
  const MAX_EDIT_W = 900;          // largeur d'affichage max dans l'éditeur
  const PDF_RENDER_MAX = 1500;     // côté max au rendu PDF (mémoire / poids)

  /* ---------------- Paramètres entreprise émettrice (persistants) ---------------- */
  const SETTINGS_KEY = 'photorecap.settings';
  const DEFAULT_SETTINGS = {
    name: 'CORDE SYSTEMES',
    contact: 'MIKULIC Marko',
    addr1: '17 rue du Petit Château',
    addr2: '91150 Brières les Scellés',
    gsm: '06 11 26 28 38',
    fax: '01 64 59 88 95',
    email: 'corde.systemes@gmail.com',
    web: 'www.corde-systemes.com',
    signatory: 'M MIKULIC',
    signatoryPhone: '0611262838',
    legal1: 'Entreprise individuelle MIKULIC Marko',
    legal2: 'SIREN 494 318 009 - SIRET 494 318 009 00037 - Code APE 4399D',
    logo: '',           // data URL du logo (optionnel)
    logoRatio: 0,       // hauteur / largeur
    signatureImg: '',   // data URL de la signature manuscrite (optionnel)
    signatureRatio: 0,
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) settings = Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (_) { /* localStorage indisponible : valeurs par défaut */ }
  }
  function persistSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); return true; }
    catch (_) { return false; /* file:// restreint ou quota : on garde en mémoire */ }
  }

  /* ---------------- Raccourcis DOM ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const el = {};

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheDom();
    loadSettings();
    applyBrandLogo();
    bindClientForm();
    bindImport();
    bindEditorControls();
    bindSettings();
    bindHistory();
    bindRichEditor();
    bindPdf();
    // Date du jour par défaut
    el.dateStart.value = new Date().toISOString().slice(0, 10);
  }

  // Affiche le logo dans l'en-tête de l'app (sinon le triangle jaune)
  function applyBrandLogo() {
    const img = document.getElementById('brandLogo');
    const mark = document.getElementById('brandMark');
    if (settings.logo) {
      img.src = settings.logo;
      img.classList.remove('hidden');
      if (mark) mark.classList.add('hidden');
    } else {
      img.classList.add('hidden');
      img.removeAttribute('src');
      if (mark) mark.classList.remove('hidden');
    }
  }

  // Redimensionne une image (fichier) en data URL PNG, renvoie { url, ratio }
  async function fileToScaledPng(file, maxDim) {
    const dataUrl = await blobToDataURL(file);
    const img = await loadImage(dataUrl);
    let w = img.naturalWidth, h = img.naturalHeight;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return { url: c.toDataURL('image/png'), ratio: h / w };
  }

  function cacheDom() {
    el.dropzone   = $('#dropzone');
    el.fileInput  = $('#fileInput');
    el.btnAdd     = $('#btnAddPhotos');
    el.grid       = $('#photoGrid');
    el.gridHint   = $('#gridHint');
    el.photoCount = $('#photoCount');
    el.dateStart  = $('#dateStart');

    // Modal
    el.modal      = $('#editorModal');
    el.modalTitle = $('#editorTitle');
    el.canvas     = $('#editCanvas');
    el.ctx        = el.canvas.getContext('2d');
    el.caption    = $('#captionInput');
    el.typeSelect = $('#typeSelect');
    el.colorPicker= $('#colorPicker');
    el.swatches   = $('#swatches');
    el.widthRange = $('#widthRange');
    el.widthVal   = $('#widthVal');
    el.editorBody = $('#editorBody');
    el.zoomVal    = $('#zoomVal');
    el.cropBar    = $('#cropBar');
    el.btnCropReset = $('#btnCropReset');

    el.btnGenerate = $('#btnGeneratePdf');
  }

  /* ============================================================
     1. FORMULAIRE CLIENT
     ============================================================ */
  function bindClientForm() {
    // Rien de spécial : les valeurs sont lues à la génération.
    // On empêche juste la soumission native du form.
    $('#clientForm').addEventListener('submit', (e) => e.preventDefault());
  }

  function getClientInfo() {
    return {
      company:        $('#company').value.trim(),
      recipientName:  $('#recipientName').value.trim(),
      companyAddress: $('#companyAddress').value.trim(),
      companyPostal:  $('#companyPostal').value.trim(),
      siteAddress:    $('#siteAddress').value.trim(),
      siteContact:    $('#siteContact').value.trim(),
      dateLabel:      $('#dateLabel').value,
      dateStart:      $('#dateStart').value,
      dateEnd:        $('#dateEnd').value,
      reference:      $('#reference').value.trim(),
      description:    $('#description').innerHTML,
      closingText:    $('#closingText').innerHTML,
      devisType:      ($('#devisType') || {}).value || 'devis',
      devisNumber:    $('#devisNumber').value.trim(),
    };
  }

  /* ============================================================
     2. IMPORT + GRILLE PHOTOS
     ============================================================ */
  function bindImport() {
    el.btnAdd.addEventListener('click', () => el.fileInput.click());
    el.dropzone.addEventListener('click', (e) => {
      if (e.target === el.btnAdd) return;
      el.fileInput.click();
    });
    el.dropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
    });

    el.fileInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
      el.fileInput.value = ''; // permet de réimporter le même fichier
    });

    ['dragenter', 'dragover'].forEach((ev) =>
      el.dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        el.dropzone.classList.add('dragover');
      })
    );
    ['dragleave', 'drop'].forEach((ev) =>
      el.dropzone.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'dragleave' && el.dropzone.contains(e.relatedTarget)) return;
        el.dropzone.classList.remove('dragover');
      })
    );
    el.dropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFiles(files);
    });
  }

  const isHeic = (f) => /image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = src;
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(
      (f) => /image\/(jpeg|png|webp)/.test(f.type) || isHeic(f)
    );
    if (!files.length) {
      toast('Aucune image valide (JPG, PNG, WebP ou HEIC).', 'error');
      return;
    }

    let ok = 0, fail = 0;
    for (const file of files) {
      try {
        let blob = file;
        // Les HEIC (iPhone) sont décodés en interne : Chrome/Firefox ne savent
        // pas les afficher directement. 100 % local, fichier d'origine inchangé.
        if (isHeic(file)) {
          if (typeof window.heic2any !== 'function') {
            throw new Error('Lecture HEIC indisponible (connexion requise au 1er usage).');
          }
          const res = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
          blob = Array.isArray(res) ? res[0] : res;
        }
        const dataUrl = await blobToDataURL(blob);
        const img = await loadImage(dataUrl);
        state.photos.push(createPhoto(file.name, dataUrl, img));
        renderGrid();
        ok++;
      } catch (e) {
        console.error('Import échoué :', file.name, e);
        fail++;
      }
    }
    if (ok)   toast(`${ok} photo${ok > 1 ? 's' : ''} ajoutée${ok > 1 ? 's' : ''}.`, 'success');
    if (fail) toast(`${fail} image(s) non importée(s).`, 'error');
  }

  function createPhoto(name, src, img) {
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    // Dimensions « de base » de l'éditeur — repère unique des coordonnées d'annotation
    const scale = Math.min(MAX_EDIT_W / natW, (window.innerHeight * 0.6) / natH, 1);
    return {
      id: ++state.seq,
      name,
      src,
      img,
      natW, natH,
      baseW: Math.round(natW * scale),
      baseH: Math.round(natH * scale),
      annotations: [],
      caption: '',
      type: '',          // '', 'Avant' ou 'Après' (optionnel)
    };
  }

  function getPhoto(id) { return state.photos.find((p) => p.id === id); }

  function renderGrid() {
    el.photoCount.textContent = state.photos.length;
    el.gridHint.classList.toggle('hidden', state.photos.length === 0);
    el.grid.innerHTML = '';

    state.photos.forEach((photo, index) => {
      const card = document.createElement('div');
      card.className = 'photo-card';
      card.draggable = true;
      card.dataset.id = photo.id;

      // Aperçu (canvas avec annotations « cuites »)
      const thumb = document.createElement('canvas');
      drawThumb(thumb, photo);
      card.appendChild(thumb);

      const order = document.createElement('span');
      order.className = 'order-badge';
      order.textContent = index + 1;
      card.appendChild(order);

      if (photo.type) {
        const typeBadge = document.createElement('span');
        typeBadge.className = 'type-badge ' + typeClass(photo.type);
        typeBadge.textContent = photo.type;
        card.appendChild(typeBadge);
      }

      if (photo.annotations.length) {
        const flag = document.createElement('span');
        flag.className = 'annot-flag';
        flag.textContent = '✎';
        flag.title = photo.annotations.length + ' annotation(s)';
        card.appendChild(flag);
      }

      if (photo.caption) {
        const strip = document.createElement('div');
        strip.className = 'caption-strip';
        strip.textContent = photo.caption;
        card.appendChild(strip);
      }

      const del = document.createElement('button');
      del.className = 'del-btn';
      del.textContent = '🗑';
      del.title = 'Supprimer';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removePhoto(photo.id);
      });
      card.appendChild(del);

      card.addEventListener('click', () => openEditor(photo.id));
      attachDnd(card);
      el.grid.appendChild(card);
    });
  }

  // Rend la photo + ses annotations sur un canvas hors-écran (image plein cadre).
  // Réutilisé par la vignette ET l'export PDF -> rendu identique partout.
  function renderAnnotatedCanvas(photo, targetW) {
    const k = targetW / photo.baseW;
    const W = Math.round(photo.baseW * k);
    const H = Math.round(photo.baseH * k);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(photo.img, 0, 0, W, H);
    drawAnnotations(ctx, photo, photo.annotations, k, photo.img);
    return cv;
  }

  // Vignette : on « cover-crop » le rendu plein cadre dans une tuile 4:3
  function drawThumb(canvas, photo) {
    const W = 360, H = 270;            // 4:3
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(0, 0, W, H);

    const src = renderAnnotatedCanvas(photo, photo.baseW);   // plein cadre (k=1)
    const ar = src.width / src.height;
    const target = W / H;
    let sx, sy, sw, sh;
    if (ar > target) { sh = src.height; sw = sh * target; sx = (src.width - sw) / 2; sy = 0; }
    else             { sw = src.width;  sh = sw / target;  sx = 0; sy = (src.height - sh) / 2; }
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
  }

  function removePhoto(id) {
    const i = state.photos.findIndex((p) => p.id === id);
    if (i === -1) return;
    state.photos.splice(i, 1);
    renderGrid();
    toast('Photo supprimée.', 'info');
  }

  /* ---------------- Drag & drop de réordonnancement ---------------- */
  let dragId = null;
  function attachDnd(card) {
    card.addEventListener('dragstart', (e) => {
      dragId = Number(card.dataset.id);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (_) {}
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.photo-card.drop-target')
        .forEach((c) => c.classList.remove('drop-target'));
      dragId = null;
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (Number(card.dataset.id) !== dragId) card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop-target');
      const targetId = Number(card.dataset.id);
      if (dragId == null || dragId === targetId) return;
      const from = state.photos.findIndex((p) => p.id === dragId);
      const to   = state.photos.findIndex((p) => p.id === targetId);
      if (from === -1 || to === -1) return;
      const [moved] = state.photos.splice(from, 1);
      state.photos.splice(to, 0, moved);
      renderGrid();
    });
  }

  /* ============================================================
     3. ÉDITEUR D'ANNOTATION (canvas)
     ============================================================ */
  function bindEditorControls() {
    // Palette de couleurs
    PALETTE.forEach((c) => {
      const sw = document.createElement('span');
      sw.className = 'swatch' + (c === editor.color ? ' active' : '');
      sw.style.background = c;
      sw.dataset.color = c;
      sw.addEventListener('click', () => setColor(c));
      el.swatches.appendChild(sw);
    });
    el.colorPicker.addEventListener('input', (e) => setColor(e.target.value));

    // Épaisseur
    el.widthRange.addEventListener('input', (e) => {
      editor.width = Number(e.target.value);
      el.widthVal.textContent = editor.width;
    });

    // Outils
    document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => {
      b.addEventListener('click', () => setTool(b.dataset.tool));
    });
    setTool(editor.tool);

    // Zoom d'affichage (précision)
    $('#btnZoomIn').addEventListener('click', () => setViewZoom(editor.viewZoom + 0.5));
    $('#btnZoomOut').addEventListener('click', () => setViewZoom(editor.viewZoom - 0.5));
    $('#btnZoomReset').addEventListener('click', () => setViewZoom(1));

    // Recadrage
    $('#cropApply').addEventListener('click', applyCrop);
    $('#cropCancel').addEventListener('click', cancelCrop);
    el.btnCropReset.addEventListener('click', undoCrop);

    // Undo / clear
    $('#btnUndo').addEventListener('click', undo);
    $('#btnClear').addEventListener('click', clearAll);

    // Fermeture / validation
    $('#editorClose').addEventListener('click', closeEditor);
    $('#editorCancel').addEventListener('click', closeEditor);
    $('#editorValidate').addEventListener('click', validateEditor);
    el.modal.addEventListener('mousedown', (e) => {
      if (e.target === el.modal) closeEditor();
    });
    document.addEventListener('keydown', (e) => {
      if (el.modal.classList.contains('hidden')) return;
      if (e.key === 'Escape') { if (editor.cropRect) cancelCrop(); else closeEditor(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      else if (e.key === '+' || e.key === '=') setViewZoom(editor.viewZoom + 0.5);
      else if (e.key === '-') setViewZoom(editor.viewZoom - 0.5);
    });

    // Événements canvas (souris + tactile)
    bindCanvasPointer();
  }

  function setColor(c) {
    editor.color = c;
    el.colorPicker.value = /^#([0-9a-f]{6})$/i.test(c) ? c : '#ff3b30';
    document.querySelectorAll('.swatch').forEach((s) =>
      s.classList.toggle('active', s.dataset.color.toLowerCase() === c.toLowerCase()));
  }

  function setTool(tool) {
    // Quitter l'outil recadrage annule une sélection en attente
    if (tool !== 'crop' && editor.cropRect) { editor.cropRect = null; updateCropButtons(); }
    editor.tool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach((b) =>
      b.classList.toggle('active', b.dataset.tool === tool));
    el.canvas.style.cursor = 'crosshair';
    if (editor.draft) redrawEditor();
  }

  function openEditor(id) {
    const photo = getPhoto(id);
    if (!photo) return;
    state.activeId = id;
    editor.target = photo;
    // Copie de travail (image + dimensions + annotations) — non destructif
    editor.draft = {
      img: photo.img, natW: photo.natW, natH: photo.natH,
      baseW: photo.baseW, baseH: photo.baseH,
      annotations: deepClone(photo.annotations),
    };
    editor.drawing = false; editor.current = null; editor.moving = null;
    editor.cropRect = null; editor.cropHistory = []; editor.viewZoom = 1;

    el.modalTitle.textContent = `Annotation — Photo ${state.photos.indexOf(photo) + 1}`;
    el.caption.value = photo.caption;
    el.typeSelect.value = photo.type;

    el.modal.classList.remove('hidden');
    el.modal.setAttribute('aria-hidden', 'false');
    updateCropButtons();
    applyView();   // dimensionne le canvas + redraw
  }

  function closeEditor() {
    el.modal.classList.add('hidden');
    el.modal.setAttribute('aria-hidden', 'true');
    editor.target = null;
    editor.draft = null;
    editor.cropRect = null;
    editor.cropHistory = [];
    el.cropBar.classList.add('hidden');
  }

  function validateEditor() {
    const photo = editor.target, d = editor.draft;
    if (!photo || !d) return;
    photo.img = d.img;
    photo.natW = d.natW; photo.natH = d.natH;
    photo.baseW = d.baseW; photo.baseH = d.baseH;
    photo.annotations = d.annotations;
    photo.caption = el.caption.value.trim();
    photo.type = el.typeSelect.value;
    closeEditor();
    renderGrid();
    toast('Annotations enregistrées.', 'success');
  }

  function undo() {
    if (!editor.draft || !editor.draft.annotations.length) return;
    editor.draft.annotations.pop();
    redrawEditor();
  }
  function clearAll() {
    if (!editor.draft || !editor.draft.annotations.length) return;
    editor.draft.annotations = [];
    redrawEditor();
  }

  /* ---------------- Zoom d'affichage ---------------- */
  function setViewZoom(z) {
    editor.viewZoom = Math.max(1, Math.min(5, Math.round(z * 2) / 2));
    applyView();
  }

  // Dimensionne le canvas (résolution = base × zoom) et l'affiche ajusté au cadre
  function applyView() {
    const d = editor.draft;
    if (!d) return;
    const z = editor.viewZoom;
    el.canvas.width = Math.round(d.baseW * z);
    el.canvas.height = Math.round(d.baseH * z);
    const body = el.editorBody.getBoundingClientRect();
    const availW = Math.max(120, body.width - 36);
    const availH = Math.max(120, body.height - 36);
    const fit = Math.min(availW / d.baseW, availH / d.baseH, 1) || 1;
    el.canvas.style.maxWidth = 'none';
    el.canvas.style.maxHeight = 'none';
    el.canvas.style.width = Math.round(d.baseW * fit * z) + 'px';
    el.canvas.style.height = Math.round(d.baseH * fit * z) + 'px';
    if (el.zoomVal) el.zoomVal.textContent = Math.round(z * 100) + '%';
    redrawEditor();
  }

  // Rendu de l'éditeur : image + annotations + forme en cours + recadrage
  function redrawEditor() {
    const d = editor.draft;
    if (!d) return;
    const ctx = el.ctx, z = editor.viewZoom;
    ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
    ctx.drawImage(d.img, 0, 0, el.canvas.width, el.canvas.height);
    const shapes = editor.current ? d.annotations.concat([editor.current]) : d.annotations;
    drawAnnotations(ctx, d, shapes, z, d.img);
    if (editor.cropRect) drawCropOverlay(ctx, editor.cropRect, z);
  }

  function drawCropOverlay(ctx, r, k) {
    const x = Math.min(r.x1, r.x2) * k, y = Math.min(r.y1, r.y2) * k;
    const w = Math.abs(r.x2 - r.x1) * k, h = Math.abs(r.y2 - r.y1) * k;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.rect(x, y, w, h);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#FFC400'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
    ctx.strokeRect(x, y, w, h);
    // règle des tiers
    ctx.lineWidth = 0.8; ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,196,0,.6)';
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(x + w * i / 3, y); ctx.lineTo(x + w * i / 3, y + h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + h * i / 3); ctx.lineTo(x + w, y + h * i / 3); ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------- Recadrage ---------------- */
  function updateCropButtons() {
    el.cropBar.classList.toggle('hidden', !editor.cropRect);
    el.btnCropReset.classList.toggle('hidden', !(editor.cropHistory && editor.cropHistory.length));
  }

  function cancelCrop() {
    editor.cropRect = null;
    updateCropButtons();
    redrawEditor();
  }

  function applyCrop() {
    const d = editor.draft, r = editor.cropRect;
    if (!d || !r) return;
    const cx = Math.min(r.x1, r.x2), cy = Math.min(r.y1, r.y2);
    const cw = Math.abs(r.x2 - r.x1), ch = Math.abs(r.y2 - r.y1);
    if (cw < 8 || ch < 8) { cancelCrop(); return; }

    const b2n = d.natW / d.baseW;                    // base -> pixels image
    const nx = Math.round(cx * b2n), ny = Math.round(cy * b2n);
    const nw = Math.round(cw * b2n), nh = Math.round(ch * b2n);

    // snapshot pour annuler le recadrage
    editor.cropHistory.push({
      img: d.img, natW: d.natW, natH: d.natH, baseW: d.baseW, baseH: d.baseH,
      annotations: deepClone(d.annotations),
    });

    // découpe à pleine résolution
    const cc = document.createElement('canvas');
    cc.width = nw; cc.height = nh;
    cc.getContext('2d').drawImage(d.img, nx, ny, nw, nh, 0, 0, nw, nh);

    // nouvelles dimensions de base
    const scale = Math.min(MAX_EDIT_W / nw, (window.innerHeight * 0.6) / nh, 1);
    const nbW = Math.round(nw * scale), nbH = Math.round(nh * scale);
    const fx = nbW / cw, fy = nbH / ch;

    d.annotations.forEach((s) => remapAnnotation(s, cx, cy, fx, fy));
    d.img = cc; d.natW = nw; d.natH = nh; d.baseW = nbW; d.baseH = nbH;

    editor.cropRect = null;
    editor.viewZoom = 1;
    updateCropButtons();
    applyView();
    toast('Photo recadrée.', 'success');
  }

  function undoCrop() {
    if (!editor.cropHistory || !editor.cropHistory.length) return;
    const snap = editor.cropHistory.pop();
    const d = editor.draft;
    d.img = snap.img; d.natW = snap.natW; d.natH = snap.natH;
    d.baseW = snap.baseW; d.baseH = snap.baseH;
    d.annotations = deepClone(snap.annotations);
    editor.cropRect = null; editor.viewZoom = 1;
    updateCropButtons();
    applyView();
    toast('Recadrage annulé.', 'info');
  }

  // Translate (origine du recadrage) puis met à l'échelle toutes les coordonnées
  function remapAnnotation(s, cx, cy, fx, fy) {
    const mx = (x) => (x - cx) * fx;
    const my = (y) => (y - cy) * fy;
    if (s.points) s.points = s.points.map((p) => ({ x: mx(p.x), y: my(p.y) }));
    if ('x1' in s) { s.x1 = mx(s.x1); s.y1 = my(s.y1); s.x2 = mx(s.x2); s.y2 = my(s.y2); }
    if ('dx' in s) { s.dx = mx(s.dx); s.dy = my(s.dy); s.dw *= fx; s.dh *= fy; }
    if (s.width) s.width = Math.max(1, s.width * fx);
  }

  // Renvoie la loupe (forme zoom) dont la boîte agrandie contient le point, sinon null
  function hitZoomCallout(pos) {
    const anns = editor.draft ? editor.draft.annotations : [];
    for (let i = anns.length - 1; i >= 0; i--) {
      const s = anns[i];
      if (s.tool === 'zoom' && s.dw &&
          pos.x >= s.dx && pos.x <= s.dx + s.dw &&
          pos.y >= s.dy && pos.y <= s.dy + s.dh) return s;
    }
    return null;
  }

  /* ---------------- Tracé au pointeur ---------------- */
  function bindCanvasPointer() {
    const c = el.canvas;
    // Coordonnées « base » (indépendantes du zoom d'affichage)
    const getPos = (e) => {
      const r = c.getBoundingClientRect();
      const z = editor.viewZoom || 1;
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x: cx * (c.width / r.width) / z, y: cy * (c.height / r.height) / z };
    };

    const down = (e) => {
      if (!editor.draft) return;
      e.preventDefault();
      const pos = getPos(e);

      // Recadrage : démarre une sélection
      if (editor.tool === 'crop') {
        editor.drawing = true;
        editor.cropRect = { x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y };
        redrawEditor();
        return;
      }
      // Loupe : si on clique dans une loupe existante -> déplacement
      if (editor.tool === 'zoom') {
        const hit = hitZoomCallout(pos);
        if (hit) {
          editor.moving = { shape: hit, ox: pos.x - hit.dx, oy: pos.y - hit.dy };
          editor.drawing = true;
          el.canvas.style.cursor = 'move';
          return;
        }
      }
      // Tracé d'une nouvelle forme
      editor.drawing = true;
      editor.start = pos;
      const base = { tool: editor.tool, color: editor.color, width: editor.width };
      if (editor.tool === 'pen') editor.current = Object.assign(base, { points: [pos] });
      else editor.current = Object.assign(base, { x1: pos.x, y1: pos.y, x2: pos.x, y2: pos.y });
      redrawEditor();
    };

    const move = (e) => {
      if (!editor.draft) return;
      // Déplacement d'une loupe
      if (editor.moving) {
        e.preventDefault();
        const pos = getPos(e), d = editor.draft, s = editor.moving.shape;
        s.dx = Math.max(0, Math.min(pos.x - editor.moving.ox, d.baseW - s.dw));
        s.dy = Math.max(0, Math.min(pos.y - editor.moving.oy, d.baseH - s.dh));
        redrawEditor();
        return;
      }
      // Sélection de recadrage
      if (editor.drawing && editor.tool === 'crop' && editor.cropRect) {
        e.preventDefault();
        const pos = getPos(e);
        editor.cropRect.x2 = pos.x; editor.cropRect.y2 = pos.y;
        redrawEditor();
        return;
      }
      // Tracé en cours
      if (editor.drawing && editor.current) {
        e.preventDefault();
        const pos = getPos(e);
        if (editor.current.tool === 'pen') editor.current.points.push(pos);
        else { editor.current.x2 = pos.x; editor.current.y2 = pos.y; }
        redrawEditor();
        return;
      }
      // Survol : curseur « déplacer » sur une loupe
      if (editor.tool === 'zoom' && !editor.drawing) {
        const pos = getPos(e);
        el.canvas.style.cursor = hitZoomCallout(pos) ? 'move' : 'crosshair';
      }
    };

    const up = () => {
      if (editor.moving) { editor.moving = null; editor.drawing = false; el.canvas.style.cursor = 'crosshair'; return; }
      if (!editor.drawing) return;
      editor.drawing = false;
      // Recadrage : laisse la sélection en attente de confirmation
      if (editor.tool === 'crop') {
        const r = editor.cropRect;
        if (r && (Math.abs(r.x2 - r.x1) < 6 || Math.abs(r.y2 - r.y1) < 6)) editor.cropRect = null;
        updateCropButtons();
        redrawEditor();
        return;
      }
      const s = editor.current;
      editor.current = null;
      if (s && isMeaningful(s)) {
        if (s.tool === 'zoom') finalizeZoom(s, editor.draft);
        editor.draft.annotations.push(s);
      }
      redrawEditor();
    };

    c.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    c.addEventListener('touchstart', down, { passive: false });
    c.addEventListener('touchmove', move, { passive: false });
    c.addEventListener('touchend', up);
  }

  // Évite d'enregistrer un simple clic sans tracé
  function isMeaningful(s) {
    if (s.tool === 'pen') return s.points.length > 1;
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    return Math.hypot(dx, dy) > 4;
  }

  /* ============================================================
     RENDU DES ANNOTATIONS (partagé éditeur / vignette / PDF)
     scale : facteur appliqué aux coordonnées base
     ============================================================ */
  function drawAnnotations(ctx, photo, shapes, scale, img) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    shapes.forEach((s) => {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = Math.max(1, s.width * scale);
      switch (s.tool) {
        case 'pen':     drawPen(ctx, s, scale); break;
        case 'arrow':   drawArrow(ctx, s, scale); break;
        case 'rect':    drawRect(ctx, s, scale); break;
        case 'ellipse': drawEllipse(ctx, s, scale); break;
        case 'focus':   drawFocus(ctx, s, scale, photo, img); break;
        case 'zoom':    drawZoom(ctx, s, scale, photo, img); break;
      }
    });
  }

  function drawPen(ctx, s, k) {
    if (s.points.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(s.points[0].x * k, s.points[0].y * k);
    for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * k, s.points[i].y * k);
    ctx.stroke();
  }

  function drawArrow(ctx, s, k) {
    const x1 = s.x1 * k, y1 = s.y1 * k, x2 = s.x2 * k, y2 = s.y2 * k;
    const w = ctx.lineWidth;
    const head = Math.max(10, w * 3.2);
    const ang = Math.atan2(y2 - y1, x2 - x1);
    // ligne (raccourcie pour ne pas dépasser la pointe)
    const bx = x2 - Math.cos(ang) * head * 0.8;
    const by = y2 - Math.sin(ang) * head * 0.8;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(bx, by); ctx.stroke();
    // tête pleine
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 7), y2 - head * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 7), y2 - head * Math.sin(ang + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }

  function drawRect(ctx, s, k) {
    const x = Math.min(s.x1, s.x2) * k, y = Math.min(s.y1, s.y2) * k;
    const w = Math.abs(s.x2 - s.x1) * k, h = Math.abs(s.y2 - s.y1) * k;
    ctx.strokeRect(x, y, w, h);
  }

  function drawEllipse(ctx, s, k) {
    const cx = (s.x1 + s.x2) / 2 * k, cy = (s.y1 + s.y2) / 2 * k;
    const rx = Math.abs(s.x2 - s.x1) / 2 * k, ry = Math.abs(s.y2 - s.y1) / 2 * k;
    if (rx < 1 || ry < 1) return;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Zone de focus : assombrit tout sauf le rectangle, puis ré-éclaire la zone
  function drawFocus(ctx, s, k, photo, img) {
    const x = Math.min(s.x1, s.x2) * k, y = Math.min(s.y1, s.y2) * k;
    const w = Math.abs(s.x2 - s.x1) * k, h = Math.abs(s.y2 - s.y1) * k;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.save();
    // 1. voile sombre partout
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, cw, ch);
    // 2. redessine l'image (pleine luminosité) uniquement dans la zone
    if (img && w > 2 && h > 2) {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.drawImage(img, 0, 0, cw, ch);
    }
    ctx.restore();
    // 3. liseré autour de la zone
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(2, s.width * k);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // Loupe : duplique la zone sélectionnée en agrandi, reliée à la source.
  // Au lâcher de la souris on calcule l'emplacement (placement = côté opposé).
  function finalizeZoom(s, photo) {
    const sx = Math.min(s.x1, s.x2), sy = Math.min(s.y1, s.y2);
    const sw = Math.abs(s.x2 - s.x1), sh = Math.abs(s.y2 - s.y1);
    const W = photo.baseW, H = photo.baseH;
    let zoom = 2.2;
    // borne le grossissement pour que la loupe tienne dans l'image
    zoom = Math.min(zoom, (W * 0.92) / sw, (H * 0.92) / sh);
    zoom = Math.max(zoom, 1.2);
    const dw = sw * zoom, dh = sh * zoom;
    const gap = Math.max(10, sw * 0.2);
    const cx = sx + sw / 2;
    let dx = cx < W / 2 ? (W - dw - gap) : gap;       // côté opposé à la source
    let dy = sy + sh / 2 - dh / 2;
    dy = Math.max(gap, Math.min(dy, H - dh - gap));
    s.zoom = zoom; s.dx = dx; s.dy = dy; s.dw = dw; s.dh = dh;
  }

  function drawZoom(ctx, s, k, photo, img) {
    const sx = Math.min(s.x1, s.x2), sy = Math.min(s.y1, s.y2);
    const sw = Math.abs(s.x2 - s.x1), sh = Math.abs(s.y2 - s.y1);
    // cadre de la zone source (pointillés) — visible aussi pendant le tracé
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1.5, s.width * k * 0.8);
    ctx.setLineDash([6 * k, 4 * k]);
    ctx.strokeRect(sx * k, sy * k, sw * k, sh * k);
    ctx.restore();
    if (!s.dw || sw < 3 || sh < 3) return;            // pas encore finalisée

    const b2n = photo.natW / photo.baseW;             // base -> pixels image
    const dx = s.dx, dy = s.dy, dw = s.dw, dh = s.dh;

    // trait de liaison source -> loupe (sous les cadres)
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1, s.width * k * 0.6);
    ctx.beginPath();
    ctx.moveTo((sx + sw / 2) * k, (sy + sh / 2) * k);
    ctx.lineTo((dx + dw / 2) * k, (dy + dh / 2) * k);
    ctx.stroke();
    ctx.restore();

    // fond blanc + portion d'image agrandie (échantillonnée en pleine résolution)
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(dx * k, dy * k, dw * k, dh * k);
    ctx.drawImage(img, sx * b2n, sy * b2n, sw * b2n, sh * b2n, dx * k, dy * k, dw * k, dh * k);
    ctx.restore();

    // cadre plein de la loupe
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(2, s.width * k);
    ctx.strokeRect(dx * k, dy * k, dw * k, dh * k);
    ctx.restore();
  }

  /* ============================================================
     PARAMÈTRES ENTREPRISE ÉMETTRICE
     ============================================================ */
  const SETTINGS_FIELDS = {
    setName: 'name', setContact: 'contact', setAddr1: 'addr1', setAddr2: 'addr2',
    setGsm: 'gsm', setFax: 'fax', setEmail: 'email', setWeb: 'web',
    setSignatory: 'signatory', setSignatoryPhone: 'signatoryPhone',
    setLegal1: 'legal1', setLegal2: 'legal2',
  };
  // État de travail des images du formulaire (validé à l'enregistrement)
  let formLogo = { url: '', ratio: 0 };
  let formSig  = { url: '', ratio: 0 };

  function bindSettings() {
    $('#btnSettings').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsCancel').addEventListener('click', closeSettings);
    $('#settingsSave').addEventListener('click', saveSettings);
    $('#settingsReset').addEventListener('click', () => {
      fillSettingsForm(DEFAULT_SETTINGS);
      toast('Valeurs par défaut restaurées (pensez à enregistrer).', 'info');
    });
    $('#settingsModal').addEventListener('mousedown', (e) => {
      if (e.target === $('#settingsModal')) closeSettings();
    });
    document.addEventListener('keydown', (e) => {
      if ($('#settingsModal').classList.contains('hidden')) return;
      if (e.key === 'Escape') closeSettings();
    });

    // Logo
    $('#logoPick').addEventListener('click', () => $('#logoFile').click());
    $('#logoFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { formLogo = await fileToScaledPng(f, 420); updateImgPreviews(); }
      catch (_) { toast('Image de logo illisible.', 'error'); }
    });
    $('#logoRemove').addEventListener('click', () => { formLogo = { url: '', ratio: 0 }; updateImgPreviews(); });

    // Signature manuscrite
    $('#sigPick').addEventListener('click', () => $('#sigFile').click());
    $('#sigFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { formSig = await fileToScaledPng(f, 600); updateImgPreviews(); }
      catch (_) { toast('Image de signature illisible.', 'error'); }
    });
    $('#sigRemove').addEventListener('click', () => { formSig = { url: '', ratio: 0 }; updateImgPreviews(); });
  }

  function updateImgPreviews() {
    const lp = $('#logoPreview'), le = $('#logoEmpty');
    if (formLogo.url) { lp.src = formLogo.url; lp.classList.remove('hidden'); le.classList.add('hidden'); }
    else { lp.classList.add('hidden'); lp.removeAttribute('src'); le.classList.remove('hidden'); }
    const sp = $('#sigPreview'), se = $('#sigEmpty');
    if (formSig.url) { sp.src = formSig.url; sp.classList.remove('hidden'); se.classList.add('hidden'); }
    else { sp.classList.add('hidden'); sp.removeAttribute('src'); se.classList.remove('hidden'); }
  }

  function fillSettingsForm(src) {
    Object.entries(SETTINGS_FIELDS).forEach(([id, key]) => {
      const e = document.getElementById(id);
      if (e) e.value = src[key] || '';
    });
    formLogo = { url: src.logo || '', ratio: src.logoRatio || 0 };
    formSig  = { url: src.signatureImg || '', ratio: src.signatureRatio || 0 };
    updateImgPreviews();
  }
  function openSettings() {
    fillSettingsForm(settings);
    $('#settingsModal').classList.remove('hidden');
    $('#settingsModal').setAttribute('aria-hidden', 'false');
  }
  function closeSettings() {
    $('#settingsModal').classList.add('hidden');
    $('#settingsModal').setAttribute('aria-hidden', 'true');
  }
  function saveSettings() {
    const next = {};
    Object.entries(SETTINGS_FIELDS).forEach(([id, key]) => {
      const e = document.getElementById(id);
      next[key] = e ? e.value.trim() : '';
    });
    next.logo = formLogo.url; next.logoRatio = formLogo.ratio;
    next.signatureImg = formSig.url; next.signatureRatio = formSig.ratio;
    settings = Object.assign({}, DEFAULT_SETTINGS, next);
    const ok = persistSettings();
    applyBrandLogo();
    closeSettings();
    toast(ok ? 'Paramètres enregistrés.' : 'Enregistré pour cette session (stockage local indisponible).', ok ? 'success' : 'info');
  }

  /* ============================================================
     HISTORIQUE DES RAPPORTS
     ============================================================ */
  const HISTORY_KEY = 'photorecap.history';
  const MAX_HISTORY = 20;

  function saveToHistory(info) {
    const history = loadHistory();
    history.unshift({ id: Date.now(), savedAt: new Date().toISOString(), info: Object.assign({}, info) });
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY))); } catch (_) {}
  }

  function loadHistory() {
    try { const r = localStorage.getItem(HISTORY_KEY); return r ? JSON.parse(r) : []; } catch (_) { return []; }
  }

  function deleteHistoryEntry(id) {
    const h = loadHistory().filter((e) => e.id !== id);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch (_) {}
  }

  function bindHistory() {
    $('#btnHistory').addEventListener('click', openHistory);
    $('#historyClose').addEventListener('click', closeHistory);
    $('#historyClose2').addEventListener('click', closeHistory);
    $('#historyClearAll').addEventListener('click', () => {
      try { localStorage.removeItem(HISTORY_KEY); } catch (_) {}
      renderHistoryList();
      toast('Historique effacé.', 'info');
    });
    $('#historyModal').addEventListener('mousedown', (e) => {
      if (e.target === $('#historyModal')) closeHistory();
    });
    document.addEventListener('keydown', (e) => {
      if ($('#historyModal').classList.contains('hidden')) return;
      if (e.key === 'Escape') closeHistory();
    });
  }

  function openHistory() {
    renderHistoryList();
    $('#historyModal').classList.remove('hidden');
    $('#historyModal').setAttribute('aria-hidden', 'false');
  }

  function closeHistory() {
    $('#historyModal').classList.add('hidden');
    $('#historyModal').setAttribute('aria-hidden', 'true');
  }

  function renderHistoryList() {
    const list = $('#historyList'), empty = $('#historyEmpty');
    const history = loadHistory();
    list.innerHTML = '';
    if (!history.length) {
      empty.classList.remove('hidden');
      list.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    list.classList.remove('hidden');
    history.forEach((entry) => {
      const info = entry.info;
      const d = new Date(entry.savedAt);
      const dateStr = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const timeStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const li = document.createElement('li');
      li.className = 'history-item';
      const infoDiv = document.createElement('div');
      infoDiv.className = 'history-item-info';
      infoDiv.innerHTML =
        '<div class="history-item-company">' + escHtml(info.company || '—') + '</div>' +
        '<div class="history-item-meta">' +
        escHtml(info.siteAddress || '') +
        (info.dateStart ? ' · ' + formatDateFr(info.dateStart) : '') +
        '</div>';
      const dateDiv = document.createElement('div');
      dateDiv.className = 'history-item-date';
      dateDiv.textContent = dateStr + ' ' + timeStr;
      const delBtn = document.createElement('button');
      delBtn.className = 'history-del-btn';
      delBtn.title = 'Supprimer';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteHistoryEntry(entry.id);
        renderHistoryList();
        toast('Entrée supprimée.', 'info');
      });
      li.appendChild(infoDiv);
      li.appendChild(dateDiv);
      li.appendChild(delBtn);
      li.addEventListener('click', () => {
        restoreClientInfo(info);
        closeHistory();
        toast('Configuration restaurée. (Les photos ne sont pas sauvegardées.)', 'success');
      });
      list.appendChild(li);
    });
  }

  function restoreClientInfo(info) {
    const set = (id, val) => { const e = document.getElementById(id); if (e) e.value = val || ''; };
    set('company', info.company);
    set('recipientName', info.recipientName);
    set('companyAddress', info.companyAddress);
    set('companyPostal', info.companyPostal);
    set('siteAddress', info.siteAddress);
    set('siteContact', info.siteContact);
    set('reference', info.reference);
    set('dateLabel', info.dateLabel);
    set('dateStart', info.dateStart);
    set('dateEnd', info.dateEnd);
    set('devisType', info.devisType || 'devis');
    set('devisNumber', info.devisNumber);
    const desc = document.getElementById('description');
    if (desc) desc.innerHTML = info.description || '';
    const ct = document.getElementById('closingText');
    if (ct) ct.innerHTML = info.closingText || '';
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ============================================================
     ÉDITEUR DE TEXTE RICHE (réutilisable)
     ============================================================ */
  function bindRichEditor() {
    initRichEditor('closingText', 'richToolbar', 'richColor');
    initRichEditor('description',  'descToolbar',  'descColor');
  }

  function initRichEditor(editorId, toolbarId, colorId) {
    const editor  = document.getElementById(editorId);
    const toolbar = document.getElementById(toolbarId);
    if (!editor || !toolbar) return;

    // Sauvegarde / restauration de la sélection
    // Certains navigateurs (Safari, Chrome mobile…) effacent la sélection
    // dans un contenteditable dès qu'on clique ailleurs, même avec preventDefault.
    let savedRange = null;

    function saveSelection() {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
    }

    function restoreSelection() {
      if (!savedRange) return;
      editor.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }

    function sync() {
      saveSelection();
      updateRichToolbarState(toolbar);
    }

    editor.addEventListener('mouseup', sync);
    editor.addEventListener('keyup', sync);
    editor.addEventListener('input', saveSelection);
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === editor) sync();
    });

    toolbar.querySelectorAll('[data-cmd]').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); });
      btn.addEventListener('click', () => {
        restoreSelection();
        const cmd = btn.dataset.cmd;
        if (cmd === 'foreColor') {
          document.execCommand('foreColor', false, document.getElementById(colorId).value);
        } else {
          document.execCommand(cmd, false, null);
        }
        saveSelection();
        updateRichToolbarState(toolbar);
      });
    });

    document.getElementById(colorId).addEventListener('input', (e) => {
      restoreSelection();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        document.execCommand('foreColor', false, e.target.value);
        saveSelection();
        updateRichToolbarState(toolbar);
      }
    });
  }

  function updateRichToolbarState(toolbar) {
    ['bold', 'italic', 'underline'].forEach((cmd) => {
      const btn = toolbar.querySelector(`[data-cmd="${cmd}"]`);
      if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
    });
  }

  /* ============================================================
     RENDU TEXTE RICHE DANS LE PDF
     ============================================================ */
  function richTextHasContent(html) {
    if (!html) return false;
    const d = document.createElement('div');
    d.innerHTML = html;
    return (d.textContent || d.innerText || '').trim().length > 0;
  }

  function cssColorToRgb(css) {
    if (!css) return null;
    const m = css.match(/rgb[a]?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    if (/^#/.test(css)) {
      const h = css.replace('#', '');
      if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
      if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }

  function extractRichSegments(html) {
    if (!html) return [];
    const div = document.createElement('div');
    div.innerHTML = html;
    const segs = [];
    function walk(node, ctx) {
      if (node.nodeType === 3) {
        if (node.textContent) segs.push(Object.assign({}, ctx, { text: node.textContent }));
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      const nc = Object.assign({}, ctx);
      if (tag === 'b' || tag === 'strong') nc.bold = true;
      if (tag === 'i' || tag === 'em') nc.italic = true;
      if (tag === 'u') nc.underline = true;
      if (tag === 'span' || tag === 'font') {
        const col = node.style.color || node.getAttribute('color');
        if (col) { const rgb = cssColorToRgb(col); if (rgb) nc.color = rgb; }
      }
      if (tag === 'br') { segs.push(Object.assign({}, ctx, { text: '\n' })); return; }
      node.childNodes.forEach((c) => walk(c, nc));
      if (tag === 'div' || tag === 'p') segs.push(Object.assign({}, ctx, { text: '\n' }));
    }
    walk(div, { bold: false, italic: false, underline: false, color: null });
    while (segs.length && segs[segs.length - 1].text === '\n') segs.pop();
    return segs;
  }

  function drawRichTextInPdf(doc, html, x, startY, maxW, LH, defaultColor, maxY) {
    const dc = defaultColor || PDFC.dark;
    const segs = extractRichSegments(html);
    if (!segs.length) return startY;
    const FS = 10;
    let curX = x, curY = startY;
    const yLimit = maxY || 9999;

    function fStyle(b, i) { return (b && i) ? 'bolditalic' : b ? 'bold' : i ? 'italic' : 'normal'; }
    function wordW(word, b, i) {
      doc.setFont('helvetica', fStyle(b, i)); doc.setFontSize(FS);
      return doc.getTextWidth(word);
    }

    for (const seg of segs) {
      const parts = seg.text.split('\n');
      for (let pi = 0; pi < parts.length; pi++) {
        if (pi > 0) { curX = x; curY += LH; }
        if (curY > yLimit) return curY;
        const part = parts[pi];
        if (!part) continue;
        const tokens = part.split(/(\s+)/);
        for (const tok of tokens) {
          if (!tok) continue;
          const w = wordW(tok, seg.bold, seg.italic);
          if (curX + w > x + maxW && curX > x && tok.trim()) {
            curX = x; curY += LH;
            if (curY > yLimit) return curY;
          }
          if (!tok.trim() && curX <= x + 0.1) continue;
          const color = seg.color || dc;
          doc.setFont('helvetica', fStyle(seg.bold, seg.italic));
          doc.setFontSize(FS);
          doc.setTextColor(...color);
          doc.text(tok, curX, curY);
          if (seg.underline && tok.trim()) {
            const tw = doc.getTextWidth(tok);
            doc.setDrawColor(...color);
            doc.setLineWidth(0.25);
            doc.line(curX, curY + 0.9, curX + tw, curY + 0.9);
          }
          curX += w;
        }
      }
    }
    return curY;
  }

  /* ============================================================
     4. GÉNÉRATION DU PDF
     ============================================================ */
  function bindPdf() {
    el.btnGenerate.addEventListener('click', generatePdf);
  }

  // Couleurs PDF (RVB) — charte jaune / noir CORDE SYSTEMES
  const PDFC = {
    ink:     [21, 23, 26],
    yellow:  [255, 196, 0],
    yellowD: [230, 168, 0],
    light:   [240, 243, 247],
    grey:    [120, 130, 142],
    dark:    [40, 46, 54],
    white:   [255, 255, 255],
  };

  // Style (fond / texte) des badges de type — décliné en jaune / noir
  function typeStyle(type) {
    switch (type) {
      case 'Avant':    return { bg: PDFC.ink,            fg: PDFC.yellow };
      case 'Après':    return { bg: PDFC.yellow,         fg: PDFC.ink };
      case 'En cours': return { bg: [58, 63, 71],        fg: PDFC.yellow };
      case 'Détail':   return { bg: [201, 206, 214],     fg: PDFC.ink };
      default:         return { bg: PDFC.ink,            fg: PDFC.yellow };
    }
  }

  function generatePdf() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      toast('Librairie PDF non chargée — vérifiez votre connexion.', 'error');
      return;
    }
    if (!state.photos.length) {
      toast('Ajoutez au moins une photo avant de générer le rapport.', 'error');
      return;
    }
    const info = getClientInfo();
    if (!info.company) {
      toast('Renseignez le nom de l\'entreprise cliente.', 'error');
      $('#company').focus();
      return;
    }

    toast('Génération du rapport en cours…', 'info');
    // Laisse le toast s'afficher avant le travail synchrone lourd
    setTimeout(() => {
      try {
        buildPdf(info);
      } catch (err) {
        console.error(err);
        toast('Erreur lors de la génération du PDF.', 'error');
      }
    }, 60);
  }

  function buildPdf(info) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const PW = 210, PH = 297;
    const M = 16;                 // marge
    const CW = PW - M * 2;        // largeur utile

    /* ---------- Page de couverture ---------- */
    coverPage(doc, info, PW, PH, M);

    /* ---------- Pages photos : mise en page au choix ---------- */
    const layout = (document.querySelector('#layoutSelect') || {}).value || 'flow';
    if (layout === 'grid4')      photoPagesGrid(doc, info, PW, PH, M, 2, 2);
    else if (layout === 'grid6') photoPagesGrid(doc, info, PW, PH, M, 2, 3);
    else                          photoPagesFlow(doc, info, PW, PH, M, CW);

    // Numérotation des pages (toutes sauf couverture)
    paginate(doc, PW, PH, M);

    const fname = buildFilename(info);
    doc.save(fname);
    saveToHistory(info);
    toast('Rapport PDF généré ✔', 'success');
  }

  // Mise en page « standard » : 1 à 2 photos / page selon le ratio, grandes légendes
  function photoPagesFlow(doc, info, PW, PH, M, CW) {
    const gap = 7, captionH = 14, headerH = 14, footerH = 10;
    const topY = M + headerH, maxY = PH - M - footerH;
    const CAP_LANDSCAPE = 103, CAP_PORTRAIT = 200;   // photos plus grandes : moins de blanc

    doc.addPage();
    let y = topY;
    pageChrome(doc, info, PW, PH, M);

    state.photos.forEach((photo, idx) => {
      const data = renderPhotoForPdf(photo);
      const portrait = data.h > data.w;
      const cap = portrait ? CAP_PORTRAIT : CAP_LANDSCAPE;
      let drawW = CW;
      let drawH = drawW * (data.h / data.w);
      if (drawH > cap) { drawH = cap; drawW = drawH * (data.w / data.h); }

      const blockH = drawH + captionH;
      if (y + blockH > maxY) {
        doc.addPage();
        pageChrome(doc, info, PW, PH, M);
        y = topY;
      }

      const x = M + (CW - drawW) / 2;
      doc.addImage(data.url, 'JPEG', x, y, drawW, drawH, undefined, 'FAST');
      doc.setDrawColor(...PDFC.grey);
      doc.setLineWidth(0.2);
      doc.rect(x, y, drawW, drawH);

      // ----- Légende sous la photo (badge optionnel) -----
      const capY = y + drawH + 5;
      let tx = M;
      if (photo.type) {
        const st = typeStyle(photo.type);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5);
        const label = photo.type.toUpperCase();
        const bw = doc.getTextWidth(label) + 8;
        doc.setFillColor(...st.bg);
        doc.roundedRect(M, capY - 3.6, bw, 6, 1.4, 1.4, 'F');
        doc.setTextColor(...st.fg);
        doc.text(label, M + bw / 2, capY + 0.7, { align: 'center' });
        tx = M + bw + 4;
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
      doc.setTextColor(...PDFC.ink);
      doc.text(`Photo ${idx + 1}`, tx, capY + 0.7);

      if (photo.caption) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
        doc.setTextColor(...PDFC.dark);
        const lines = doc.splitTextToSize(photo.caption, CW);
        doc.text(lines.slice(0, 2), M, capY + 6.5);
      }

      y += blockH + gap;
    });
  }

  // Mise en page « compacte / dense » : grille cols × rows par page (gain de papier)
  function photoPagesGrid(doc, info, PW, PH, M, cols, rows) {
    const headerH = 14, footerH = 10;
    const topY = M + headerH, maxY = PH - M - footerH;
    const gapX = 6, gapY = 6, capH = 12;
    const CW = PW - M * 2;
    const cellW = (CW - (cols - 1) * gapX) / cols;
    const cellH = (maxY - topY - (rows - 1) * gapY) / rows;
    const imgAreaH = cellH - capH;
    const perPage = cols * rows;

    state.photos.forEach((photo, idx) => {
      const slot = idx % perPage;
      if (slot === 0) { doc.addPage(); pageChrome(doc, info, PW, PH, M); }
      const col = slot % cols, row = Math.floor(slot / cols);
      const cellX = M + col * (cellW + gapX);
      const cellY = topY + row * (cellH + gapY);

      const data = renderPhotoForPdf(photo);
      const scale = Math.min(cellW / data.w, imgAreaH / data.h);
      const dw = data.w * scale, dh = data.h * scale;
      const ix = cellX + (cellW - dw) / 2;
      const iy = cellY + (imgAreaH - dh) / 2;
      doc.addImage(data.url, 'JPEG', ix, iy, dw, dh, undefined, 'FAST');
      doc.setDrawColor(...PDFC.grey); doc.setLineWidth(0.2);
      doc.rect(ix, iy, dw, dh);

      // ----- Légende compacte (badge optionnel) -----
      const cy = cellY + imgAreaH + 4;
      let nx = cellX;
      if (photo.type) {
        const st = typeStyle(photo.type);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7);
        const label = photo.type.toUpperCase();
        const bw = doc.getTextWidth(label) + 5;
        doc.setFillColor(...st.bg);
        doc.roundedRect(cellX, cy - 3, bw, 4.8, 1, 1, 'F');
        doc.setTextColor(...st.fg);
        doc.text(label, cellX + bw / 2, cy + 0.4, { align: 'center' });
        nx = cellX + bw + 2.5;
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
      doc.setTextColor(...PDFC.ink);
      const num = (idx + 1) + '.';
      doc.text(num, nx, cy + 0.4);

      if (photo.caption) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
        doc.setTextColor(...PDFC.dark);
        const numW = doc.getTextWidth(num + ' ');
        const capLines = doc.splitTextToSize(photo.caption, cellW - (nx - cellX) - numW - 1);
        if (capLines.length) doc.text(capLines.slice(0, 2), nx + numW, cy + 0.4);
      }
    });
  }

  /* ---------- Page de garde façon courrier — en-têtes uniformes ---------- */
  function coverPage(doc, info, PW, PH, M) {
    const topPad = 15;
    const LH = 6.2;        // interligne unique du corps (uniformité)
    const SEC = 3.5;       // espace entre sections

    // --- Émetteur (gauche) : logo optionnel + bloc texte ---
    let textX = M, logoBottom = topPad;
    if (settings.logo && settings.logoRatio) {
      const LW = 26, LHt = LW * settings.logoRatio;
      try { doc.addImage(settings.logo, 'PNG', M, topPad - 2, LW, LHt); } catch (_) {}
      textX = M + LW + 5;
      logoBottom = topPad - 2 + LHt;
    }
    let ly = topPad;
    doc.setTextColor(...PDFC.ink);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text(settings.name || '', textX, ly); ly += 5.2;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...PDFC.dark);
    const left = [];
    if (settings.contact) left.push(settings.contact);
    if (settings.addr1)   left.push(settings.addr1);
    if (settings.addr2)   left.push(settings.addr2);
    if (settings.gsm)     left.push('GSM : ' + settings.gsm);
    if (settings.fax)     left.push('Fax : ' + settings.fax);
    if (settings.email)   left.push(settings.email);
    if (settings.web)     left.push(settings.web);
    left.forEach((l) => { doc.text(l, textX, ly); ly += 4.6; });
    const emitterBottom = Math.max(ly, logoBottom);

    // --- Destinataire (droite, décalé plus bas que l'émetteur) ---
    const rx = PW - M;
    let ry = topPad + 16;
    doc.setTextColor(...PDFC.ink);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text(info.company || '—', rx, ry, { align: 'right' }); ry += 5.2;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...PDFC.dark);
    const right = [];
    if (info.recipientName)  right.push(info.recipientName);
    if (info.companyAddress) right.push(info.companyAddress);
    if (info.companyPostal)  right.push(info.companyPostal);
    right.forEach((l) => { doc.text(l, rx, ry, { align: 'right' }); ry += 4.6; });

    // --- Filet de séparation : noir + accent jaune ---
    let y = Math.max(emitterBottom, ry) + 6;
    doc.setDrawColor(...PDFC.ink); doc.setLineWidth(0.5); doc.line(M, y, PW - M, y);
    doc.setDrawColor(...PDFC.yellow); doc.setLineWidth(1.8); doc.line(M, y + 1.7, PW - M, y + 1.7);

    // --- Titre ---
    y += 15;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(...PDFC.ink);
    doc.text('RAPPORT PHOTOS', PW / 2, y, { align: 'center' });
    const tw = doc.getTextWidth('RAPPORT PHOTOS');
    doc.setDrawColor(...PDFC.yellow); doc.setLineWidth(2.6);
    doc.line(PW / 2 - tw / 2, y + 3, PW / 2 + tw / 2, y + 3);
    y += 14;

    // --- Bloc d'infos : kvLine partout (valeur juste après le label, pas de gros vide) ---
    //     Interligne LH constant ; Objet et Observations sont séparés d'un saut (LH).
    kvLine(doc, 'Chantier :', info.siteAddress || '—', M, y); y += LH;
    if (info.siteContact) {
      // Continuation alignée sur la valeur (largeur de "Chantier :")
      const tab = doc.getTextWidth('Chantier : ') + 0;
      doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...PDFC.grey);
      doc.text('(contact sur place : ' + info.siteContact + ')', M + tab, y);
      y += LH;
    }
    if (info.reference)             { kvLine(doc, 'Référence :', info.reference, M, y); y += LH; }
    const dval = formatDateValue(info);
    if (dval)                       { kvLine(doc, (info.dateLabel || 'Date') + ' :', dval, M, y); y += LH; }

    // --- Objet (séparé par un saut de ligne) ---
    if (richTextHasContent(info.description)) {
      y += LH;                                                           // 1 ligne vide
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PDFC.ink);
      doc.text('Objet :', M, y); y += LH;
      y = drawRichTextInPdf(doc, info.description, M, y, PW - M * 2, LH, PDFC.ink);
    }

    // --- Observations / recommandations ---
    if (richTextHasContent(info.closingText)) {
      y += LH;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PDFC.ink);
      doc.text('Observations / recommandations :', M, y); y += LH;
      y = drawRichTextInPdf(doc, info.closingText, M, y, PW - M * 2, LH, PDFC.dark, PH - 108);
    }

    // — Filet de séparation avant la section de clôture —
    y += LH * 3;
    doc.setDrawColor(...PDFC.light); doc.setLineWidth(0.3);
    doc.line(M, y, PW - M, y);
    y += LH * 1.8;

    // --- Renvoi devis / facture ---
    if (info.devisNumber) {
      const dtype = info.devisType === 'facture' ? 'facture' : 'devis';
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PDFC.ink);
      doc.text('Voir notre ' + dtype + ' n° ' + info.devisNumber + ' joint en annexe.', M, y);
      y += LH * 2.5;
    }

    // --- Cordialement + Signature (sur la 1re page) ---
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(...PDFC.dark);
    doc.text('Restant à votre disposition pour tout complément d’information,', M, y); y += LH;
    doc.text('Cordialement,', M, y); y += LH * 3;
    if (settings.signatureImg && settings.signatureRatio) {
      const sw = 42, sh = sw * settings.signatureRatio;
      if (y + sh + 14 < PH - 22) {
        try { doc.addImage(settings.signatureImg, 'PNG', M, y, sw, sh); } catch (_) {}
        y += sh + 4;
      }
    } else {
      y += 6;
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...PDFC.ink);
    if (settings.signatory) { doc.text(settings.signatory, M, y); y += 6; }
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...PDFC.dark);
    if (settings.signatoryPhone) doc.text(settings.signatoryPhone, M, y);

    // --- Pied de page de garde : méta + mentions légales ---
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...PDFC.grey);
    doc.text('Document généré le ' + formatDateFr(new Date().toISOString().slice(0, 10)), M, PH - 13);
    doc.text(state.photos.length + ' photo(s) au rapport', PW - M, PH - 13, { align: 'right' });
    legalFooter(doc, PW, PH, M);
  }

  // Étiquette en gras suivie de sa valeur, sur une ligne
  function kvLine(doc, label, value, x, y) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...PDFC.ink);
    doc.text(label, x, y);
    const lw = doc.getTextWidth(label + ' ');
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...PDFC.dark);
    doc.text(String(value), x + lw, y);
  }

  // « du X au Y » si plage, sinon la date unique
  function formatDateValue(info) {
    const s = info.dateStart ? formatDateFr(info.dateStart) : '';
    const e = info.dateEnd ? formatDateFr(info.dateEnd) : '';
    if (s && e && e !== s) return 'du ' + s + ' au ' + e;
    return s || '';
  }

  // En-tête + pied discrets sur les pages photos (bandeau noir, accent jaune)
  function pageChrome(doc, info, PW, PH, M) {
    doc.setFillColor(...PDFC.ink);
    doc.rect(0, 0, PW, 10, 'F');
    doc.setFillColor(...PDFC.yellow);
    doc.rect(0, 10, PW, 1.4, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...PDFC.yellow);
    doc.text((settings.name || 'RAPPORT').slice(0, 30), M, 6.7);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...PDFC.white);
    doc.text('RAPPORT PHOTOS', PW / 2, 6.7, { align: 'center' });
    doc.text((info.company || '').slice(0, 34), PW - M, 6.7, { align: 'right' });
    legalFooter(doc, PW, PH, M);
  }

  // Mentions légales (bas de page) — sur toutes les pages
  function legalFooter(doc, PW, PH, M) {
    doc.setDrawColor(...PDFC.light); doc.setLineWidth(0.3);
    doc.line(M, PH - 17, PW - M, PH - 17);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...PDFC.grey);
    if (settings.legal1) doc.text(settings.legal1, PW / 2, PH - 8.5, { align: 'center' });
    if (settings.legal2) doc.text(settings.legal2, PW / 2, PH - 5, { align: 'center' });
  }

  function paginate(doc, PW, PH, M) {
    const n = doc.getNumberOfPages();
    for (let i = 2; i <= n; i++) {        // saute la couverture
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...PDFC.grey);
      doc.text(`Page ${i - 1} / ${n - 1}`, PW - M, PH - 13, { align: 'right' });
    }
  }

  // Rend la photo + annotations, retourne un JPEG base64 (compression mémoire)
  function renderPhotoForPdf(photo) {
    const targetW = Math.min(photo.natW, PDF_RENDER_MAX);
    const cv = renderAnnotatedCanvas(photo, targetW);
    const url = cv.toDataURL('image/jpeg', 0.92);
    return { url, w: cv.width, h: cv.height };
  }

  function buildFilename(info) {
    const company = (info.company || 'Rapport').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
    const date = (info.dateStart || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
    return `Rapport_${company || 'Chantier'}_${date}.pdf`;
  }

  /* ============================================================
     Utilitaires
     ============================================================ */
  function typeClass(type) {
    return 'type-' + type.replace('En cours', 'Encours').replace(/\s+/g, '');
  }

  function formatDateFr(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    if (!y || !m || !d) return iso;
    return `${d}/${m}/${y}`;
  }

  function deepClone(obj) {
    return (typeof structuredClone === 'function')
      ? structuredClone(obj)
      : JSON.parse(JSON.stringify(obj));
  }

  let toastTimer = [];
  function toast(msg, kind = 'info') {
    const c = $('#toastContainer');
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    c.appendChild(t);
    const id = setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 250);
    }, 3200);
    toastTimer.push(id);
  }

})();

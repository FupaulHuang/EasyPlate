(() => {
  'use strict';

  const STORAGE_KEY = 'easyplate.project.v1';
  const DEFAULT_FIELDS = ['cell_line', 'species', 'treatment', 'dose', 'time'];
  const LEGACY_DEFAULT_FIELDS = new Set(['replicate', 'test']);
  const RESERVED_FIELDS = new Set([
    'group', 'plate_id', 'sample_index', 'source_sample', 'plate_position', 'plate_row',
    'plate_column', 'is_occupied', 'barcode', 'well_id', 'well_name', 'well_name_label',
    'well_name_fill_color', 'well_number_label', 'well_number_fill_color',
    'display_feature', 'display_label', 'display_fill_color', '__all__', 'x', 'y', 'total_well'
  ]);
  const PALETTE = [
    '#e2f0e5', '#f8e7d9', '#e4e9f7', '#f4e3eb', '#e0eff2', '#f2edcf',
    '#eee4f5', '#e7eddb', '#f8e4dd', '#dcebe7', '#f3e8d2', '#e6e2f2',
    '#e8e9df', '#f6e2d5', '#dfeaf5', '#f0e5dc'
  ];
  const $ = (selector) => document.querySelector(selector);
  const plateList = $('#plate-list');
  const plateGrid = $('#plate-grid');
  const multiPlateDialog = $('#multi-plate-dialog');
  const toast = $('#toast');
  const wellTooltip = $('#well-tooltip');

  let project;
  let currentPlateId = '';
  let selectedKeys = new Set(['0,0']);
  let currentWindowIndex = 0;
  let selectedFeatures = ['cell_line', 'species'];
  let selectedFeature = 'cell_line';
  let dragAnchor = null;
  let dragging = false;
  let toastTimer = 0;
  let lastPasteSkipped = 0;
  let hoverTimer = 0;
  let hoverCell = null;
  let hoverPoint = { x: 0, y: 0 };

  project = loadProject();
  currentPlateId = project.plates[0].id;
  selectedFeatures = [...(project.settings.displayFeatures || (project.settings.displayFeature ? [project.settings.displayFeature] : []))];
  selectedFeature = selectedFeatures[0] || 'cell_line';

  function makeId() {
    return (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `plate-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function lettersForRow(index) {
    let n = index + 1;
    let label = '';
    while (n > 0) {
      const remainder = (n - 1) % 26;
      label = String.fromCharCode(65 + remainder) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }

  function defaultValues(fields = metadataFields()) {
    return Object.fromEntries(fields.map((field) => [field, '']));
  }

  function makePlate(label, rows = 8, columns = 12, settings = project.settings) {
    const plate = {
      id: makeId(), label: label || `Plate ${project.plates.length + 1}`,
      group: '', sample_index: '', source_sample: '', rows, columns,
      rowLabels: Array.from({ length: rows }, (_, i) => lettersForRow(i)),
      columnLabels: Array.from({ length: columns }, (_, i) => String(i + 1)),
      wells: Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({
        well_id: '', barcode: '', is_occupied: false, values: defaultValues(allMetadataFields())
      })))
    };
    if (settings.autoFillWellIds !== false) assignIdsToPlate(plate, 0, settings);
    return plate;
  }

  function blankProject() {
    const next = {
      version: 5,
      settings: { idPrefix: 'well_dt_', idStart: 1, numberingOrder: 'column', numberingScope: 'reset', autoFillWellIds: true, displayFeature: 'cell_line', displayFeatures: ['cell_line', 'species'], preview: { wellSize: 60, fontSize: 18, showWellId: true, slideWindows: false, windowRows: 6, windowColumns: 8 } },
      fields: [...DEFAULT_FIELDS], plates: []
    };
    project = next;
    const plate = makePlate('Plate 1', 8, 12, next.settings);
    next.plates.push(plate);
    return next;
  }

  function allMetadataFields() {
    return [...(project?.fields || DEFAULT_FIELDS)];
  }

  function normalizeFieldName(value) {
    return String(value || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }

  function boundedNumber(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
  }

  function isAllowedOptionalField(field) {
    return Boolean(field) && (field === 'barcode' || DEFAULT_FIELDS.includes(field) || !RESERVED_FIELDS.has(field));
  }

  function normalizePlate(raw, index) {
    const rows = Math.max(1, Math.min(40, Number(raw.rows) || 8));
    const columns = Math.max(1, Math.min(48, Number(raw.columns) || 12));
    const rowLabels = Array.from({ length: rows }, (_, i) => String(raw.rowLabels?.[i] || lettersForRow(i)));
    const columnLabels = Array.from({ length: columns }, (_, i) => String(raw.columnLabels?.[i] || i + 1));
    const wells = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => {
      const source = raw.wells?.[r]?.[c] || {};
      const values = { ...defaultValues(allMetadataFields()), ...(source.values || source.metadata || {}) };
      delete values.well_name_label;
      const savedBarcode = source.barcode ?? values.barcode ?? '';
      delete values.barcode;
      const inferredOccupied = Boolean(savedBarcode) || Object.values(values).some((value) => String(value ?? '').trim() !== '');
      return {
        well_id: String(source.well_id ?? ''),
        barcode: String(savedBarcode),
        is_occupied: source.is_occupied == null ? inferredOccupied : Boolean(source.is_occupied),
        values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value == null ? '' : String(value)]))
      };
    }));
    return {
      id: String(raw.id || makeId()), label: String(raw.label || raw.plate_id || `Plate ${index + 1}`),
      group: String(raw.group || ''), sample_index: String(raw.sample_index ?? ''),
      source_sample: String(raw.source_sample || ''), rows, columns, rowLabels, columnLabels, wells
    };
  }

  function normalizeProject(raw) {
    const isLegacyProject = Number(raw.version || 1) < 2;
    const isLegacyVisual = Number(raw.version || 1) < 4;
    const savedWellSize = Number(raw.settings?.preview?.wellSize);
    const savedFontSize = Number(raw.settings?.preview?.fontSize);
    const settings = {
      idPrefix: String(raw.settings?.idPrefix ?? 'well_dt_'),
      idStart: Math.max(0, Number(raw.settings?.idStart ?? 1) || 0),
      numberingOrder: raw.settings?.numberingOrder === 'row' ? 'row' : 'column',
      numberingScope: raw.settings?.numberingScope === 'continue' ? 'continue' : 'reset',
      autoFillWellIds: raw.settings?.autoFillWellIds !== false,
      displayFeature: String(raw.settings?.displayFeature || 'cell_line'),
      displayFeatures: Array.isArray(raw.settings?.displayFeatures) ? raw.settings.displayFeatures.map(normalizeFieldName) : null,
      preview: {
        wellSize: Math.max(40, Math.min(160, isLegacyProject && savedWellSize === 72 ? 60 : (savedWellSize || 60))),
        fontSize: Math.max(8, Math.min(30, isLegacyVisual && savedFontSize > 0 && savedFontSize <= 16 ? savedFontSize * 1.5 : (savedFontSize || 18))),
        showWellId: raw.settings?.preview?.showWellId !== false,
        slideWindows: Boolean(raw.settings?.preview?.slideWindows),
        windowRows: Math.max(1, Math.min(40, Number(raw.settings?.preview?.windowRows) || 6)),
        windowColumns: Math.max(1, Math.min(48, Number(raw.settings?.preview?.windowColumns) || 8))
      }
    };
    project = { version: 5, settings, fields: [], plates: [] };
    const legacyFields = [...DEFAULT_FIELDS, ...(Array.isArray(raw.customFields) ? raw.customFields : [])];
    const requestedFields = Array.isArray(raw.fields) ? raw.fields : legacyFields;
    const normalizedFields = requestedFields.map(normalizeFieldName).filter(isAllowedOptionalField);
    const sourcePlates = Array.isArray(raw.plates) ? raw.plates : [];
    const hasBarcodeData = sourcePlates.some((plate) => (plate.wells || []).some((row) => (row || []).some((well) =>
      !isMissingFeatureValue(well?.barcode ?? well?.values?.barcode)
    )));
    const preDerivedWellNameSchema = Number(raw.version || 1) < 5;
    if (hasBarcodeData && !normalizedFields.includes('barcode')) normalizedFields.push('barcode');
    if (isLegacyProject) {
      project.fields = [...new Set([...normalizedFields.filter((field) => !LEGACY_DEFAULT_FIELDS.has(field) && !(preDerivedWellNameSchema && field === 'barcode' && !hasBarcodeData)), 'cell_line', 'species'])];
    } else {
      project.fields = [...new Set(normalizedFields.filter((field) => !(preDerivedWellNameSchema && field === 'barcode' && !hasBarcodeData)))];
    }
    const rawPlates = Array.isArray(raw.plates) && raw.plates.length ? raw.plates : [{}];
    project.plates = rawPlates.map(normalizePlate);
    for (const plate of project.plates) {
      for (const row of plate.wells) {
        for (const well of row) {
          for (const field of allMetadataFields()) if (!(field in well.values)) well.values[field] = '';
        }
      }
    }
    const availableFeatures = [...project.fields, 'well_id', 'is_occupied'];
    let selected = settings.displayFeatures;
    if (!selected) selected = settings.displayFeature === '__all__'
      ? availableFeatures
      : (settings.displayFeature ? [settings.displayFeature] : []);
    if (selected.length === 1 && selected[0] === 'well_name_label') selected = ['cell_line', 'species'];
    settings.displayFeatures = [...new Set(selected.filter((field) => availableFeatures.includes(field)))];
    settings.displayFeature = settings.displayFeatures[0] || '';
    return project;
  }

  function loadProject() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return normalizeProject(JSON.parse(stored));
    } catch (_) { /* Start with a clean project if saved data is unavailable. */ }
    return blankProject();
  }

  function getPlate() {
    return project.plates.find((plate) => plate.id === currentPlateId) || project.plates[0];
  }

  function plateWindow(plate, index = currentWindowIndex) {
    const preview = project.settings.preview;
    const rowsPerWindow = preview.slideWindows ? Math.min(plate.rows, preview.windowRows) : plate.rows;
    const columnsPerWindow = preview.slideWindows ? Math.min(plate.columns, preview.windowColumns) : plate.columns;
    return plateWindowWithSize(plate, index, rowsPerWindow, columnsPerWindow);
  }

  function plateWindowWithSize(plate, index, rowsPerWindow, columnsPerWindow) {
    const rowWindowCount = Math.ceil(plate.rows / rowsPerWindow);
    const columnWindowCount = Math.ceil(plate.columns / columnsPerWindow);
    const total = rowWindowCount * columnWindowCount;
    const safeIndex = Math.max(0, Math.min(total - 1, index));
    const rowWindow = Math.floor(safeIndex / columnWindowCount);
    const columnWindow = safeIndex % columnWindowCount;
    const rowStart = rowWindow * rowsPerWindow;
    const columnStart = columnWindow * columnsPerWindow;
    return {
      index: safeIndex, total,
      rowStart, rowEnd: Math.min(plate.rows, rowStart + rowsPerWindow),
      columnStart, columnEnd: Math.min(plate.columns, columnStart + columnsPerWindow)
    };
  }

  function pdfWindows(plate) {
    const preview = project.settings.preview;
    if (preview.slideWindows) {
      const first = plateWindow(plate, 0);
      return Array.from({ length: first.total }, (_, index) => plateWindow(plate, index));
    }
    const rowsPerPage = Math.min(8, plate.rows);
    const columnsPerPage = Math.min(12, plate.columns);
    const first = plateWindowWithSize(plate, 0, rowsPerPage, columnsPerPage);
    return Array.from({ length: first.total }, (_, index) => plateWindowWithSize(plate, index, rowsPerPage, columnsPerPage));
  }

  function chunkFeatures(fields, size = 2) {
    if (!fields.length) return [[]];
    const chunks = [];
    for (let i = 0; i < fields.length; i += size) chunks.push(fields.slice(i, i + size));
    return chunks;
  }

  function pdfFeatureLines(well, fields) {
    const lines = fields.map((field) => field === 'well_id'
      ? String(well.well_id || '—')
      : String(getValue(well, field) || '—'));
    if (project.settings.preview.showWellId && !fields.includes('well_id')) lines.push(String(well.well_id || 'No well ID'));
    return lines;
  }

  function navigateWindow(index) {
    const view = plateWindow(getPlate(), index);
    currentWindowIndex = view.index;
    selectedKeys = new Set([`${view.rowStart},${view.columnStart}`]);
    renderGrid(); renderInspector();
  }

  function renderWindowNavigation(plate) {
    const view = plateWindow(plate);
    const navigation = $('#window-navigation');
    navigation.hidden = !project.settings.preview.slideWindows;
    $('#window-page').textContent = `Window ${view.index + 1} of ${view.total} · ${plate.rowLabels[view.rowStart]}–${plate.rowLabels[view.rowEnd - 1]}, ${plate.columnLabels[view.columnStart]}–${plate.columnLabels[view.columnEnd - 1]}`;
    $('#previous-window').disabled = view.index === 0;
    $('#next-window').disabled = view.index >= view.total - 1;
  }

  function saveProject() {
    try {
      project.settings.displayFeatures = [...selectedFeatures];
      project.settings.displayFeature = selectedFeatures[0] || '';
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
      $('#save-status').innerHTML = '<span class="save-dot"></span> Saved in this browser';
    } catch (_) {
      $('#save-status').textContent = 'Browser storage is full';
    }
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function featureLabel(field) {
    const known = {
      __all__: 'All features',
      well_name_label: 'Well name', well_id: 'Well ID', barcode: 'Barcode',
      is_occupied: 'Occupied status', treatment: 'Treatment', dose: 'Dose',
      time: 'Time', replicate: 'Replicate'
    };
    return known[field] || String(field).replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function metadataFields() {
    return [...project.fields];
  }

  function displayFields() {
    return [...project.fields, 'well_id', 'is_occupied'];
  }

  function getValue(well, field) {
    if (field === 'well_id') return well.well_id || '';
    if (field === 'barcode') return well.barcode || '';
    if (field === 'is_occupied') return wellIsOccupied(well) ? 'Occupied' : 'Empty';
    return well.values?.[field] ?? '';
  }

  function selectedFeatureLines(well) {
    return selectedFeatures.map((field) => String(getValue(well, field) || '—'));
  }

  function wellLinesForFeatures(well, fields = selectedFeatures) {
    const lines = fields.map((field) => String(getValue(well, field) || '—'));
    if (project.settings.preview.showWellId && !fields.includes('well_id')) lines.push(String(well.well_id || 'No well ID'));
    return lines;
  }

  function wrapCanvasText(context, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text ?? '').split(/\r?\n/)) {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = '';
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (context.measureText(candidate).width <= maxWidth) { line = candidate; continue; }
        if (line) lines.push(line);
        line = '';
        let fragment = '';
        for (const char of word) {
          if (fragment && context.measureText(fragment + char).width > maxWidth) { lines.push(fragment); fragment = ''; }
          fragment += char;
        }
        line = fragment;
      }
      if (line) lines.push(line);
      if (!words.length) lines.push('');
    }
    return lines;
  }

  function displayLabelFor(well) {
    if (!selectedFeatures.length) return '';
    if (selectedFeatures.length === 1) return String(getValue(well, selectedFeatures[0]) || '');
    return selectedFeatureLines(well).join(' | ');
  }

  function gridLabel(well) {
    if (!selectedFeatures.length) return '';
    if (selectedFeatures.length === 1) return String(getValue(well, selectedFeatures[0]) || '—');
    return selectedFeatureLines(well).join('\n') || 'No features selected';
  }

  function displayColorFor(well) {
    if (!selectedFeatures.length) return '#fafbfa';
    if (selectedFeatures.length === 1) {
      const field = selectedFeatures[0];
      return colorFor(String(getValue(well, field)), field);
    }
    const colorFeatures = selectedFeatures.filter((field) => field !== 'well_id').sort();
    const featureValues = colorFeatures.map((field) => [field, String(getValue(well, field) ?? '')]);
    if (featureValues.every(([, value]) => isMissingFeatureValue(value))) return '#fafbfa';
    const signature = JSON.stringify(featureValues);
    return colorFor(signature, '__multi__');
  }

  function selectedDisplayTitle() {
    const options = displayFields();
    if (!selectedFeatures.length) return project.settings.preview.showWellId ? 'Well IDs only' : 'No labels';
    if (selectedFeatures.length === 1) return featureLabel(selectedFeatures[0]);
    if (selectedFeatures.length === options.length && options.every((field) => selectedFeatures.includes(field))) return 'All features';
    return `${selectedFeatures.length} features`;
  }

  function setSelectedFeatures(fields) {
    const available = new Set(displayFields());
    selectedFeatures = [...new Set(fields.filter((field) => available.has(field)))];
    selectedFeature = selectedFeatures[0] || project.fields[0] || 'cell_line';
    project.settings.displayFeatures = [...selectedFeatures];
    project.settings.displayFeature = selectedFeatures[0] || '';
    renderFeatures(); renderGrid(); renderInspector(); saveProject();
  }

  function wellIsOccupied(well) {
    return Boolean(well.is_occupied || well.barcode);
  }

  function fieldOccupiesWell(field) {
    return field !== 'well_id' && field !== 'is_occupied';
  }

  function hashText(value) {
    let hash = 2166136261;
    for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x7feb352d);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, 0x846ca68b);
    hash ^= hash >>> 16;
    return hash >>> 0;
  }

  function colorFor(value, field = selectedFeature) {
    if (!String(value ?? '').trim()) return '#fafbfa';
    if (field === '__multi__') return PALETTE[hashText(value) % PALETTE.length];
    if (field === 'well_id') return '#edf1f5';
    if (field === 'is_occupied') return String(value) === 'Occupied' ? '#e2f0e5' : '#fafbfa';
    if (field === 'barcode') return '#e9edf6';
    return PALETTE[hashText(value) % PALETTE.length];
  }

  function positionLabel(plate, r, c) {
    return `${plate.rowLabels[r] || lettersForRow(r)}${plate.columnLabels[c] || c + 1}`;
  }

  function wellCaption(plate, r, c, well) {
    return !project.settings.preview.showWellId || selectedFeatures.includes('well_id') ? '' : (well.well_id || 'No ID');
  }

  function wellAt(plate, r, c) {
    return plate.wells[r]?.[c];
  }

  function numberingCoordinates(plate) {
    const coords = [];
    if (project.settings.numberingOrder === 'row') {
      for (let r = 0; r < plate.rows; r++) for (let c = 0; c < plate.columns; c++) coords.push([r, c]);
    } else {
      for (let c = 0; c < plate.columns; c++) for (let r = 0; r < plate.rows; r++) coords.push([r, c]);
    }
    return coords;
  }

  function assignIdsToPlate(plate, offset, settings = project.settings) {
    let number = Math.max(0, Number(settings.idStart) || 0) + offset;
    const prefix = String(settings.idPrefix ?? 'well_dt_');
    const coords = settings.numberingOrder === 'row'
      ? Array.from({ length: plate.rows * plate.columns }, (_, i) => [Math.floor(i / plate.columns), i % plate.columns])
      : Array.from({ length: plate.rows * plate.columns }, (_, i) => [i % plate.rows, Math.floor(i / plate.rows)]);
    for (const [r, c] of coords) plate.wells[r][c].well_id = `${prefix}${number++}`;
  }

  function assignUniqueIdsToPlate(plate, otherPlates, startingNumber, settings = project.settings) {
    const prefix = String(settings.idPrefix ?? 'well_dt_');
    const used = new Set();
    for (const other of otherPlates) {
      if (other.id === plate.id) continue;
      for (const row of other.wells) for (const well of row) if (well.well_id) used.add(String(well.well_id));
    }
    let number = Math.max(0, Number(settings.idStart) || 0) + startingNumber;
    for (const [r, c] of numberingCoordinates(plate)) {
      while (used.has(`${prefix}${number}`)) number++;
      plate.wells[r][c].well_id = `${prefix}${number}`;
      used.add(`${prefix}${number++}`);
    }
  }

  function offsetBeforePlate(index) {
    return project.plates.slice(0, index).reduce((total, plate) => total + plate.rows * plate.columns, 0);
  }

  function normalizeSelection() {
    const plate = getPlate();
    const kept = [...selectedKeys].filter((key) => {
      const [r, c] = key.split(',').map(Number);
      return r >= 0 && r < plate.rows && c >= 0 && c < plate.columns;
    });
    selectedKeys = new Set(kept);
  }

  function selectionCoordinates() {
    const plate = getPlate();
    const order = numberingCoordinates(plate);
    const selected = new Set(selectedKeys);
    return order.filter(([r, c]) => selected.has(`${r},${c}`));
  }

  function anchorCoordinate() {
    const coords = selectionCoordinates();
    return coords[0] || [0, 0];
  }

  function renderTabs() {
    plateList.replaceChildren();
    project.plates.forEach((plate, index) => {
      const tab = document.createElement('button');
      tab.type = 'button'; tab.className = `plate-tab${plate.id === currentPlateId ? ' active' : ''}`;
      tab.textContent = plate.label || `Plate ${index + 1}`;
      tab.title = plate.label || `Plate ${index + 1}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(plate.id === currentPlateId));
      tab.addEventListener('click', () => {
        currentPlateId = plate.id; currentWindowIndex = 0; selectedKeys = new Set(['0,0']); renderAll(); saveProject();
      });
      plateList.append(tab);
    });
  }

  function renderSetup() {
    const plate = getPlate();
    $('#plate-label').value = plate.label;
    $('#plate-group').value = plate.group;
    $('#plate-rows').value = plate.rows;
    $('#plate-columns').value = plate.columns;
    $('#plate-sample-index').value = plate.sample_index;
    $('#plate-source-sample').value = plate.source_sample;
    $('#current-plate-title').textContent = plate.label || 'Untitled plate';
  }

  function renderFeatures() {
    const options = $('#feature-options');
    options.replaceChildren();
    const available = displayFields();
    selectedFeatures = selectedFeatures.filter((field) => available.includes(field));
    for (const field of available) {
      const label = document.createElement('label'); label.className = 'feature-option';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = field;
      checkbox.checked = selectedFeatures.includes(field);
      checkbox.addEventListener('change', () => {
        const next = checkbox.checked
          ? [...selectedFeatures, field]
          : selectedFeatures.filter((item) => item !== field);
        setSelectedFeatures(next);
      });
      label.append(checkbox, document.createTextNode(featureLabel(field)));
      options.append(label);
    }
    selectedFeature = selectedFeatures[0] || project.fields[0] || 'cell_line';
    $('#feature-picker-button').textContent = selectedDisplayTitle();
    const allSelected = available.length > 0 && available.every((field) => selectedFeatures.includes(field));
    $('#select-all-features').textContent = allSelected ? 'Deselect all' : 'Select all';
    $('#legend-text').textContent = selectedFeatures.length
      ? `Color and label by ${selectedFeatures.length === 1 ? featureLabel(selectedFeatures[0]).toLowerCase() : `${selectedFeatures.length} selected features`}`
      : 'No label features selected';
  }

  function multiFeatureCellHeight(lineCount) {
    const preview = project.settings.preview;
    return Math.max(preview.wellSize, Math.min(260, 28 + Math.max(1, lineCount) * (preview.fontSize + 5)));
  }

  function renderPreviewControls() {
    const preview = project.settings.preview;
    $('#show-well-id').checked = preview.showWellId !== false;
    $('#well-size').value = preview.wellSize;
    $('#well-size-slider').value = preview.wellSize;
    $('#font-size').value = preview.fontSize;
    $('#font-size-slider').value = preview.fontSize;
    $('#slide-window-mode').checked = preview.slideWindows;
    $('#window-rows').value = preview.windowRows;
    $('#window-columns').value = preview.windowColumns;
    $('#window-rows').disabled = !preview.slideWindows;
    $('#window-columns').disabled = !preview.slideWindows;
  }

  function setPreviewSize(field, value) {
    if (field === 'wellSize') project.settings.preview.wellSize = boundedNumber(value, 60, 40, 160);
    else project.settings.preview.fontSize = boundedNumber(value, 18, 8, 30);
    renderPreviewControls(); renderGrid(); saveProject();
  }

  function renderIdControls() {
    $('#auto-fill-ids').checked = project.settings.autoFillWellIds !== false;
    $('#id-prefix').value = project.settings.idPrefix;
    $('#id-start').value = project.settings.idStart;
    $('#numbering-order').value = project.settings.numberingOrder;
    $('#numbering-scope').value = project.settings.numberingScope;
  }

  function renderGrid() {
    clearWellHover();
    const plate = getPlate();
    const view = plateWindow(plate);
    currentWindowIndex = view.index;
    normalizeSelection();
    plateGrid.replaceChildren();
    plateGrid.style.setProperty('--well-size', `${project.settings.preview.wellSize}px`);
    plateGrid.style.setProperty('--well-font-size', `${project.settings.preview.fontSize}px`);
    plateGrid.style.gridTemplateColumns = `34px repeat(${view.columnEnd - view.columnStart}, ${project.settings.preview.wellSize}px)`;
    plateGrid.setAttribute('aria-rowcount', String(view.rowEnd - view.rowStart + 1));
    plateGrid.setAttribute('aria-colcount', String(view.columnEnd - view.columnStart + 1));
    const corner = document.createElement('span'); corner.className = 'axis-cell'; corner.textContent = '';
    plateGrid.append(corner);
    for (let c = view.columnStart; c < view.columnEnd; c++) {
      const col = document.createElement('span'); col.className = 'axis-cell'; col.textContent = plate.columnLabels[c] || String(c + 1); plateGrid.append(col);
    }
    for (let r = view.rowStart; r < view.rowEnd; r++) {
      const rowLabel = document.createElement('span'); rowLabel.className = 'axis-cell'; rowLabel.textContent = plate.rowLabels[r] || lettersForRow(r); plateGrid.append(rowLabel);
      for (let c = view.columnStart; c < view.columnEnd; c++) {
        const well = plate.wells[r][c];
        const cell = document.createElement('button');
        const isMulti = selectedFeatures.length > 1;
        const value = displayLabelFor(well);
        const lines = isMulti ? selectedFeatureLines(well) : [];
        cell.type = 'button'; cell.className = `well-cell${isMulti ? ' all-features' : ''}${wellIsOccupied(well) ? '' : ' empty'}${selectedKeys.has(`${r},${c}`) ? ' selected' : ''}`;
        if (isMulti) cell.style.height = `${multiFeatureCellHeight(lines.length)}px`;
        cell.dataset.r = String(r); cell.dataset.c = String(c);
        cell.setAttribute('role', 'gridcell'); cell.tabIndex = selectedKeys.has(`${r},${c}`) || (!selectedKeys.size && r === view.rowStart && c === view.columnStart) ? 0 : -1;
        cell.setAttribute('aria-label', `${positionLabel(plate, r, c)} · ${well.well_id || 'No well ID'}${value ? ` · ${value}` : ''}`);
        cell.style.backgroundColor = displayColorFor(well);
        const mark = wellIsOccupied(well) ? '<i class="well-mark" aria-hidden="true"></i>' : '';
        const caption = wellCaption(plate, r, c, well);
        cell.innerHTML = `${mark}<span class="well-label"></span><span class="well-id"></span>`;
        cell.querySelector('.well-label').textContent = gridLabel(well);
        cell.querySelector('.well-id').textContent = caption;
        plateGrid.append(cell);
      }
    }
    renderWindowNavigation(plate);
    updateSelectionSummary();
  }

  function updateGridCell(r, c) {
    const plate = getPlate(); const well = wellAt(plate, r, c);
    const cell = plateGrid.querySelector(`.well-cell[data-r="${r}"][data-c="${c}"]`);
    if (!cell || !well) return;
    const value = displayLabelFor(well);
    cell.querySelector('.well-label').textContent = gridLabel(well);
    cell.querySelector('.well-id').textContent = wellCaption(plate, r, c, well);
    const isMulti = selectedFeatures.length > 1;
    cell.classList.toggle('all-features', isMulti);
    if (isMulti) {
      const lineCount = Math.max(1, selectedFeatureLines(well).length);
      cell.style.height = `${multiFeatureCellHeight(lineCount)}px`;
    } else cell.style.height = '';
    cell.setAttribute('aria-label', `${positionLabel(plate, r, c)} · ${well.well_id || 'No well ID'}${value ? ` · ${value}` : ''}`);
    cell.style.backgroundColor = displayColorFor(well);
    cell.classList.toggle('empty', !wellIsOccupied(well));
    const mark = cell.querySelector('.well-mark');
    if (wellIsOccupied(well) && !mark) cell.insertAdjacentHTML('afterbegin', '<i class="well-mark" aria-hidden="true"></i>');
    if (!wellIsOccupied(well) && mark) mark.remove();
    if (hoverCell === cell && !wellTooltip.hidden) renderWellTooltip();
  }

  function updateSelectionSummary() {
    const count = selectedKeys.size;
    const plate = getPlate();
    $('#selection-summary').textContent = `${count} well${count === 1 ? '' : 's'} selected`;
    $('#selected-count').textContent = String(count);
    const [r, c] = anchorCoordinate();
    $('#select-all-wells-button').textContent = count === plate.rows * plate.columns ? 'Deselect all wells' : 'Select all wells';
    $('#selected-well-title').textContent = count === 0 ? 'No wells selected' : count === 1 ? positionLabel(plate, r, c) : `${count} wells selected`;
    $('#selected-help').textContent = count === 0
      ? 'Select wells in Layout Preview to edit their values.'
      : count === 1
      ? `${wellAt(plate, r, c)?.well_id || 'No well ID'} · Well ID is required; other fields are optional.`
      : 'Edits apply to every selected well. Mixed values appear blank.';
  }

  function appendWellField(container, field, well, multiple) {
    const wrapper = document.createElement('div'); wrapper.className = 'field';
    const heading = document.createElement('div'); heading.className = 'field-heading';
    const caption = document.createElement('label'); caption.textContent = featureLabel(field);
    const fieldId = `well-field-${field}`;
    caption.htmlFor = fieldId;
    if (field === 'well_id') {
      const required = document.createElement('span'); required.className = 'required-mark'; required.textContent = ' *'; caption.append(required);
      caption.title = 'Well ID is required and cannot be removed.';
    }
    heading.append(caption);
    const actions = document.createElement('div'); actions.className = 'field-actions';
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'clear-feature-button';
    clear.textContent = 'Clear values'; clear.title = `Clear ${featureLabel(field)} values from every well`;
    clear.addEventListener('click', () => clearFeatureAcrossAllWells(field)); actions.append(clear);
    if (field !== 'well_id') {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-field-button';
      remove.textContent = 'Remove'; remove.title = `Remove ${featureLabel(field)} from all wells`;
      remove.addEventListener('click', () => removeOptionalField(field)); actions.append(remove);
    }
    heading.append(actions);
    wrapper.append(heading);
    const input = document.createElement('input'); input.id = fieldId; input.type = 'text'; input.autocomplete = 'off'; input.dataset.field = field;
    if (field === 'well_id') { input.required = true; input.setAttribute('aria-required', 'true'); }
    const coords = selectionCoordinates();
    const values = coords.map(([r, c]) => String(getValue(wellAt(getPlate(), r, c), field)));
    const same = values.every((value) => value === values[0]);
    input.value = multiple || !same ? '' : (values[0] || '');
    if (multiple && !same) input.placeholder = 'Mixed values';
    input.addEventListener('input', () => {
      for (const [r, c] of selectionCoordinates()) {
        const target = wellAt(getPlate(), r, c);
        setField(target, field, input.value);
        if (input.value.trim() && fieldOccupiesWell(field)) target.is_occupied = true;
        updateGridCell(r, c);
      }
      updateSelectionSummary(); saveProject();
    });
    if (field === 'well_id') input.addEventListener('change', () => {
      if (!input.value.trim() && project.settings.autoFillWellIds) {
        assignMissingIds(getPlate()); renderGrid(); renderInspector(); saveProject();
      }
    });
    wrapper.append(input); container.append(wrapper);
  }

  function renderInspector() {
    const plate = getPlate(); normalizeSelection();
    const coords = selectionCoordinates();
    const [r, c] = coords[0] || [0, 0];
    const well = wellAt(plate, r, c);
    const fixed = $('#well-fields-fixed'); fixed.replaceChildren();
    const container = $('#well-fields');
    const previousScroll = container.scrollTop;
    container.replaceChildren();
    updateSelectionSummary();
    if (!coords.length) {
      const empty = document.createElement('p'); empty.className = 'selected-help'; empty.textContent = 'No wells selected. Select wells in Layout Preview to edit their values.';
      fixed.append(empty); container.classList.remove('is-scrollable'); container.removeAttribute('tabindex'); return;
    }

    const occupiedLabel = document.createElement('label'); occupiedLabel.className = 'checkbox-field';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    const occupiedCount = coords.filter(([rr, cc]) => wellIsOccupied(wellAt(plate, rr, cc))).length;
    checkbox.checked = occupiedCount > 0;
    checkbox.indeterminate = occupiedCount > 0 && occupiedCount < coords.length;
    checkbox.addEventListener('change', () => {
      for (const [rr, cc] of selectionCoordinates()) { wellAt(plate, rr, cc).is_occupied = checkbox.checked; updateGridCell(rr, cc); }
      saveProject(); renderInspector();
    });
    occupiedLabel.append(checkbox, document.createTextNode(' Mark selected wells as occupied'));
    fixed.append(occupiedLabel);

    appendWellField(fixed, 'well_id', well, coords.length > 1);
    const fields = metadataFields();
    for (const field of fields) appendWellField(container, field, well, coords.length > 1);
    container.classList.toggle('is-scrollable', fields.length > 10);
    if (fields.length > 10) {
      container.tabIndex = 0;
      container.scrollTop = previousScroll;
    } else {
      container.removeAttribute('tabindex');
    }
  }

  function renderAll() {
    renderTabs(); renderSetup(); renderFeatures(); renderPreviewControls(); renderIdControls(); renderGrid(); renderInspector();
    saveProject();
  }

  function setField(well, field, value) {
    const text = String(value ?? '');
    if (field === 'well_name_label') return;
    if (field === 'well_id') well.well_id = text;
    else if (field === 'barcode') { addOptionalField(field); well.barcode = text; }
    else if (field === 'is_occupied') well.is_occupied = /^(1|true|yes|occupied)$/i.test(text.trim());
    else {
      if (!metadataFields().includes(field)) addOptionalField(field);
      well.values[field] = text;
    }
  }

  function addOptionalField(inputName) {
    const field = normalizeFieldName(inputName);
    if (!isAllowedOptionalField(field)) return '';
    if (!project.fields.includes(field)) {
      project.fields.push(field);
      if (field !== 'barcode') for (const plate of project.plates) for (const row of plate.wells) for (const well of row) well.values[field] ??= '';
    }
    return field;
  }

  function removeOptionalField(field) {
    if (!project.fields.includes(field)) return;
    const hasValues = project.plates.some((plate) => plate.wells.some((row) => row.some((well) =>
      String(field === 'barcode' ? well.barcode : well.values[field] || '').trim() !== ''
    )));
    if (hasValues && !window.confirm(`Remove ${featureLabel(field)} from the project and clear its values from every well?`)) return;
    project.fields = project.fields.filter((item) => item !== field);
    for (const plate of project.plates) for (const row of plate.wells) for (const well of row) {
      if (field === 'barcode') well.barcode = '';
      else delete well.values[field];
    }
    setSelectedFeatures(selectedFeatures.filter((item) => item !== field));
    showToast(`${featureLabel(field)} removed.`);
  }

  function clearFeatureAcrossAllWells(field) {
    if (field === 'well_id' && project.settings.autoFillWellIds) {
      const confirmed = window.confirm('Clear all Well ID values? Automatic fill will be turned off and stay off.');
      if (!confirmed) return;
      project.settings.autoFillWellIds = false;
      $('#auto-fill-ids').checked = false;
    } else if (!window.confirm(`Clear ${featureLabel(field)} values from every well? The feature will remain available.`)) {
      return;
    }
    for (const plate of project.plates) for (const row of plate.wells) for (const well of row) {
      if (field === 'well_id') well.well_id = '';
      else if (field === 'barcode') well.barcode = '';
      else well.values[field] = '';
    }
    renderAll(); showToast(`${featureLabel(field)} values cleared from all wells.`);
  }

  function bindEvents() {
    $('#plate-label').addEventListener('input', (event) => { getPlate().label = event.target.value; $('#current-plate-title').textContent = event.target.value || 'Untitled plate'; renderTabs(); saveProject(); });
    $('#plate-group').addEventListener('input', (event) => { getPlate().group = event.target.value; saveProject(); });
    $('#plate-sample-index').addEventListener('input', (event) => { getPlate().sample_index = event.target.value; saveProject(); });
    $('#plate-source-sample').addEventListener('input', (event) => { getPlate().source_sample = event.target.value; saveProject(); });
    $('#plate-rows').addEventListener('change', resizeFromInputs);
    $('#plate-columns').addEventListener('change', resizeFromInputs);

    $('#feature-picker-button').addEventListener('click', () => {
      const menu = $('#feature-menu'); const open = menu.hidden;
      menu.hidden = !open; $('#feature-picker-button').setAttribute('aria-expanded', String(open));
    });
    $('#feature-menu').addEventListener('pointerdown', (event) => event.stopPropagation());
    $('#select-all-features').addEventListener('click', () => {
      const fields = displayFields();
      const allSelected = fields.length > 0 && fields.every((field) => selectedFeatures.includes(field));
      setSelectedFeatures(allSelected ? [] : fields);
    });
    $('#clear-features').addEventListener('click', () => setSelectedFeatures([]));
    document.addEventListener('pointerdown', (event) => {
      if (!$('#feature-picker').contains(event.target)) {
        $('#feature-menu').hidden = true; $('#feature-picker-button').setAttribute('aria-expanded', 'false');
      }
    });
    $('#well-size').addEventListener('change', (event) => setPreviewSize('wellSize', event.target.value));
    $('#well-size-slider').addEventListener('input', (event) => setPreviewSize('wellSize', event.target.value));
    $('#font-size').addEventListener('change', (event) => setPreviewSize('fontSize', event.target.value));
    $('#font-size-slider').addEventListener('input', (event) => setPreviewSize('fontSize', event.target.value));
    $('#show-well-id').addEventListener('change', (event) => {
      project.settings.preview.showWellId = event.target.checked;
      renderGrid(); saveProject();
    });
    $('#slide-window-mode').addEventListener('change', (event) => {
      project.settings.preview.slideWindows = event.target.checked;
      currentWindowIndex = 0; selectedKeys = new Set(['0,0']); renderPreviewControls(); renderGrid(); renderInspector(); saveProject();
    });
    $('#window-rows').addEventListener('change', (event) => {
      project.settings.preview.windowRows = Math.max(1, Math.min(40, Math.floor(Number(event.target.value) || 6)));
      currentWindowIndex = 0; renderPreviewControls(); renderGrid(); renderInspector(); saveProject();
    });
    $('#window-columns').addEventListener('change', (event) => {
      project.settings.preview.windowColumns = Math.max(1, Math.min(48, Math.floor(Number(event.target.value) || 8)));
      currentWindowIndex = 0; renderPreviewControls(); renderGrid(); renderInspector(); saveProject();
    });
    $('#previous-window').addEventListener('click', () => navigateWindow(currentWindowIndex - 1));
    $('#next-window').addEventListener('click', () => navigateWindow(currentWindowIndex + 1));
    $('#id-prefix').addEventListener('input', (event) => { project.settings.idPrefix = event.target.value; saveProject(); });
    $('#id-start').addEventListener('change', (event) => { project.settings.idStart = Math.max(0, Number(event.target.value) || 0); event.target.value = project.settings.idStart; saveProject(); });
    $('#numbering-order').addEventListener('change', (event) => { project.settings.numberingOrder = event.target.value; saveProject(); });
    $('#numbering-scope').addEventListener('change', (event) => { project.settings.numberingScope = event.target.value; saveProject(); });
    $('#auto-fill-ids').addEventListener('change', (event) => {
      project.settings.autoFillWellIds = event.target.checked;
      if (event.target.checked) {
        for (const plate of project.plates) assignMissingIds(plate);
      } else {
        for (const plate of project.plates) for (const row of plate.wells) for (const well of row) well.well_id = '';
      }
      renderGrid(); renderInspector(); saveProject();
      showToast(event.target.checked ? 'Automatic fill assigned IDs to all wells.' : 'Automatic fill is off; all well IDs were cleared.');
    });
    $('#generate-selected-ids-button').addEventListener('click', generateSelectedIds);
    $('#generate-ids-button').addEventListener('click', regenerateAllIds);
    $('#clear-selected-values-button').addEventListener('click', clearSelectedValues);

    $('#add-plate-button').addEventListener('click', addPlate);
    $('#create-multiple-plates-button').addEventListener('click', openMultiPlateDialog);
    $('#duplicate-plate-button').addEventListener('click', duplicatePlate);
    $('#remove-plate-button').addEventListener('click', removePlate);
    $('#select-all-wells-button').addEventListener('click', selectAllWells);
    $('#delete-all-except-first-button').addEventListener('click', deleteAllExceptFirst);
    $('#reset-project-button').addEventListener('click', resetProjectToDefaults);
    $('#apply-plate-to-all-button').addEventListener('click', applyCurrentPlateToAll);
    $('#multi-plate-create').addEventListener('click', createMultiplePlates);
    $('#multi-plate-cancel').addEventListener('click', () => multiPlateDialog.close());
    $('#add-field-button').addEventListener('click', promptForCustomField);
    $('#invert-selection-button').addEventListener('click', invertVisibleSelection);

    plateGrid.addEventListener('pointerdown', onGridPointerDown);
    plateGrid.addEventListener('pointerover', onGridPointerOver);
    plateGrid.addEventListener('pointerover', onWellPointerOver);
    plateGrid.addEventListener('pointerout', onWellPointerOut);
    plateGrid.addEventListener('pointermove', onWellPointerMove);
    window.addEventListener('pointerup', onGridPointerUp);
    plateGrid.addEventListener('paste', onGridPaste);
    plateGrid.addEventListener('keydown', onGridKeydown);

    $('#import-table-button').addEventListener('click', () => $('#table-file').click());
    $('#table-file').addEventListener('change', importTableFile);
    $('#save-project-button').addEventListener('click', downloadProject);
    $('#project-file').addEventListener('change', openProjectFile);
    $('#export-csv-button').addEventListener('click', exportCsv);
    $('#export-png-button').addEventListener('click', exportPng);
    $('#export-pdf-button').addEventListener('click', exportPdf);
  }

  function resizeFromInputs() {
    const plate = getPlate();
    const rows = Math.max(1, Math.min(40, Math.floor(Number($('#plate-rows').value) || 1)));
    const columns = Math.max(1, Math.min(48, Math.floor(Number($('#plate-columns').value) || 1)));
    if (rows === plate.rows && columns === plate.columns) return;
    let discardsData = false;
    for (let r = 0; r < plate.rows; r++) for (let c = 0; c < plate.columns; c++) {
      if ((r >= rows || c >= columns) && wellIsOccupied(plate.wells[r][c])) discardsData = true;
    }
    if (discardsData && !window.confirm('Reducing the plate size will remove data in wells outside the new dimensions. Continue?')) {
      $('#plate-rows').value = plate.rows; $('#plate-columns').value = plate.columns; return;
    }
    const old = plate.wells;
    plate.rows = rows; plate.columns = columns;
    plate.rowLabels = Array.from({ length: rows }, (_, i) => plate.rowLabels[i] || lettersForRow(i));
    plate.columnLabels = Array.from({ length: columns }, (_, i) => plate.columnLabels[i] || String(i + 1));
    plate.wells = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => old[r]?.[c] || ({ well_id: '', barcode: '', is_occupied: false, values: defaultValues(metadataFields()) })));
    if (project.settings.autoFillWellIds) for (const item of project.plates) assignMissingIds(item);
    currentWindowIndex = 0; selectedKeys = new Set(['0,0']); renderAll();
  }

  function addPlate() {
    const current = getPlate();
    const plate = makePlate(`Plate ${project.plates.length + 1}`, current.rows, current.columns);
    plate.group = current.group; plate.sample_index = current.sample_index; plate.source_sample = current.source_sample;
    if (project.settings.autoFillWellIds && project.settings.numberingScope === 'continue') assignIdsToPlate(plate, offsetBeforePlate(project.plates.length));
    project.plates.push(plate); currentPlateId = plate.id; currentWindowIndex = 0; selectedKeys = new Set(['0,0']); renderAll();
  }

  function selectAllWells() {
    const plate = getPlate(); const next = new Set();
    if (selectedKeys.size === plate.rows * plate.columns) {
      selectedKeys = next;
    } else {
      for (let r = 0; r < plate.rows; r++) for (let c = 0; c < plate.columns; c++) next.add(`${r},${c}`);
      selectedKeys = next;
    }
    renderGrid(); renderInspector();
  }

  function deleteAllExceptFirst() {
    if (project.plates.length <= 1) { showToast('The project has only one plate.'); return; }
    const retained = project.plates[0];
    if (!window.confirm(`Delete all plates except ${retained.label}? This removes ${project.plates.length - 1} plate${project.plates.length === 2 ? '' : 's'} and keeps the first plate with its current layout and metadata.`)) return;
    project.plates = [retained]; currentPlateId = retained.id; currentWindowIndex = 0;
    selectedKeys = new Set(['0,0']); renderAll(); showToast(`Kept ${retained.label} and deleted the other plates.`);
  }

  function resetProjectToDefaults() {
    if (!window.confirm('Reset the entire project to its defaults? This clears all plates and metadata, restores Cell line and Species, and returns to one blank 8 × 12 plate.')) return;
    project = blankProject();
    currentPlateId = project.plates[0].id; currentWindowIndex = 0;
    selectedKeys = new Set(['0,0']); selectedFeatures = [...project.settings.displayFeatures];
    selectedFeature = selectedFeatures[0] || 'cell_line'; renderAll();
    showToast('Project reset to defaults.');
  }

  function applyCurrentPlateToAll() {
    if (project.plates.length < 2) { showToast('Create another plate first.'); return; }
    const source = getPlate();
    const idNote = project.settings.autoFillWellIds && project.settings.numberingScope === 'continue'
      ? 'Well IDs will be regenerated across the project to keep numbering continuous.'
      : 'Well IDs will be copied from the selected plate.';
    const confirmed = window.confirm(`Copy ${source.label}'s dimensions, occupancy, and metadata to every other plate? ${idNote} Each plate keeps its own label and source details.`);
    if (!confirmed) return;
    const sourceSnapshot = {
      rows: source.rows, columns: source.columns,
      rowLabels: [...source.rowLabels], columnLabels: [...source.columnLabels],
      wells: source.wells.map((row) => row.map((well) => ({
        well_id: well.well_id, barcode: well.barcode, is_occupied: well.is_occupied, values: { ...well.values }
      })))
    };
    for (const plate of project.plates) {
      if (plate.id === source.id) continue;
      plate.rows = sourceSnapshot.rows; plate.columns = sourceSnapshot.columns;
      plate.rowLabels = [...sourceSnapshot.rowLabels]; plate.columnLabels = [...sourceSnapshot.columnLabels];
      plate.wells = sourceSnapshot.wells.map((row) => row.map((well) => ({
        well_id: well.well_id, barcode: well.barcode, is_occupied: well.is_occupied, values: { ...well.values }
      })));
    }
    if (project.settings.autoFillWellIds && project.settings.numberingScope === 'continue') {
      let offset = 0;
      for (const plate of project.plates) {
        assignIdsToPlate(plate, offset); offset += plate.rows * plate.columns;
      }
    }
    currentWindowIndex = 0; renderAll();
    showToast(`Applied ${source.label}'s layout and metadata to all plates.`);
  }

  function openMultiPlateDialog() {
    $('#multi-plate-count').value = '3';
    $('#multi-plate-prefix').value = 'Plate';
    $('#multi-plate-start').value = String(project.plates.length + 1);
    $('#multi-plate-error').textContent = '';
    multiPlateDialog.showModal();
  }

  function createMultiplePlates() {
    const count = Math.floor(Number($('#multi-plate-count').value));
    const prefix = $('#multi-plate-prefix').value.trim() || 'Plate';
    const start = Math.max(1, Math.floor(Number($('#multi-plate-start').value) || 1));
    if (!Number.isFinite(count) || count < 1 || count > 100) {
      $('#multi-plate-error').textContent = 'Enter a number from 1 to 100.'; return;
    }
    const labels = Array.from({ length: count }, (_, index) => `${prefix} ${start + index}`);
    const existing = new Set(project.plates.map((plate) => plate.label));
    const repeated = labels.find((label, index) => existing.has(label) || labels.indexOf(label) !== index);
    if (repeated) { $('#multi-plate-error').textContent = `Plate label “${repeated}” is already in use.`; return; }
    const template = getPlate(); const newPlates = [];
    for (const label of labels) {
      const plate = makePlate(label, template.rows, template.columns);
      plate.group = template.group; plate.sample_index = template.sample_index; plate.source_sample = template.source_sample;
      if (project.settings.autoFillWellIds && project.settings.numberingScope === 'continue') assignIdsToPlate(plate, offsetBeforePlate(project.plates.length));
      project.plates.push(plate); newPlates.push(plate);
    }
    multiPlateDialog.close(); currentPlateId = newPlates[0].id; currentWindowIndex = 0;
    selectedKeys = new Set(['0,0']); renderAll();
    showToast(`Created ${count} plates.`);
  }

  function duplicatePlate() {
    const current = getPlate();
    const copy = normalizePlate(JSON.parse(JSON.stringify(current)), project.plates.length);
    copy.id = makeId(); copy.label = `${current.label || 'Plate'} copy`;
    if (project.settings.autoFillWellIds && project.settings.numberingScope === 'continue') assignIdsToPlate(copy, offsetBeforePlate(project.plates.length));
    project.plates.push(copy); currentPlateId = copy.id; currentWindowIndex = 0; selectedKeys = new Set(['0,0']); renderAll();
  }

  function removePlate() {
    if (project.plates.length < 2) { showToast('A project must contain at least one plate.'); return; }
    const plate = getPlate();
    if (!window.confirm(`Remove ${plate.label || 'this plate'} from the project?`)) return;
    const index = project.plates.findIndex((item) => item.id === plate.id);
    project.plates.splice(index, 1); currentPlateId = project.plates[Math.max(0, index - 1)].id; currentWindowIndex = 0;
    selectedKeys = new Set(['0,0']); renderAll();
  }

  function regenerateAllIds() {
    const prefix = project.settings.idPrefix;
    const start = project.settings.idStart;
    if (!window.confirm(`Regenerate every well ID using “${prefix}${start}” as the first ID? Existing well IDs will be replaced.`)) return;
    let offset = 0;
    for (const plate of project.plates) {
      assignIdsToPlate(plate, project.settings.numberingScope === 'continue' ? offset : 0);
      if (project.settings.numberingScope === 'continue') offset += plate.rows * plate.columns;
    }
    renderGrid(); renderInspector(); saveProject(); showToast('Well IDs regenerated.');
  }

  function highestIdNumber(plates, prefix) {
    let highest = Math.max(0, Number(project.settings.idStart) || 0) - 1;
    for (const plate of plates) for (const row of plate.wells) for (const well of row) {
      const id = String(well.well_id || '');
      if (!id.startsWith(prefix)) continue;
      const suffix = id.slice(prefix.length);
      if (/^\d+$/.test(suffix)) highest = Math.max(highest, Number(suffix));
    }
    return highest;
  }

  function generateSelectedIds() {
    const plate = getPlate(); const coords = selectionCoordinates();
    if (!coords.length) return;
    const hasIds = coords.some(([r, c]) => String(plate.wells[r][c].well_id || '').trim());
    if (hasIds && !window.confirm(`Generate new IDs for the ${coords.length} selected wells? Existing IDs in the selection will be replaced.`)) return;
    const scope = project.settings.numberingScope === 'continue' ? project.plates : [plate];
    const prefix = String(project.settings.idPrefix ?? 'well_dt_');
    const used = new Set();
    for (const scopedPlate of scope) for (let r = 0; r < scopedPlate.rows; r++) for (let c = 0; c < scopedPlate.columns; c++) {
      if (scopedPlate.wells[r][c].well_id) used.add(String(scopedPlate.wells[r][c].well_id));
    }
    let number = Math.max(0, Number(project.settings.idStart) || 0);
    for (const [r, c] of coords) {
      while (used.has(`${prefix}${number}`)) number++;
      plate.wells[r][c].well_id = `${prefix}${number}`;
      used.add(`${prefix}${number++}`);
    }
    renderGrid(); renderInspector(); saveProject(); showToast(`Generated IDs for ${coords.length} selected wells.`);
  }

  function clearSelectedValues() {
    const plate = getPlate(); const coords = selectionCoordinates();
    if (!coords.length) return;
    const idEffect = project.settings.autoFillWellIds
      ? ' Automatic fill will assign a well ID again to each selected well.'
      : ' Well IDs will remain empty.';
    if (!window.confirm(`Clear the well ID, barcode, occupancy, and every metadata value from ${coords.length} selected well${coords.length === 1 ? '' : 's'}?${idEffect}`)) return;
    for (const [r, c] of coords) {
      const well = plate.wells[r][c];
      well.well_id = ''; well.barcode = ''; well.is_occupied = false;
      well.values = defaultValues(metadataFields());
    }
    if (project.settings.autoFillWellIds) for (const item of project.plates) assignMissingIds(item);
    renderGrid(); renderInspector(); saveProject(); showToast(`Cleared values in ${coords.length} selected wells.`);
  }

  function assignMissingIds(plate) {
    if (project.settings.autoFillWellIds === false) return;
    const scope = project.settings.numberingScope === 'continue' ? project.plates : [plate];
    const prefix = String(project.settings.idPrefix || 'well_dt_');
    const highestNumber = highestIdNumber(scope, prefix);
    let next = highestNumber + 1;
    for (const [r, c] of numberingCoordinates(plate)) {
      if (!plate.wells[r][c].well_id) plate.wells[r][c].well_id = `${prefix}${next++}`;
    }
  }

  function promptForCustomField() {
    const raw = window.prompt('Name the metadata field (for example: cell_line or operator):');
    if (raw == null) return;
    const field = normalizeFieldName(raw);
    if (!field) { showToast('Enter a field name using letters or numbers.'); return; }
    if (!isAllowedOptionalField(field)) { showToast('That field name is reserved for plate structure or well IDs.'); return; }
    if (project.fields.includes(field)) { showToast('That field is already active.'); return; }
    addOptionalField(field);
    renderFeatures(); renderInspector(); saveProject(); showToast(`Added ${featureLabel(field)}.`);
    $(`#well-field-${field}`)?.focus();
  }

  function onGridPointerDown(event) {
    const cell = event.target.closest('.well-cell'); if (!cell) return;
    const r = Number(cell.dataset.r); const c = Number(cell.dataset.c); const key = `${r},${c}`;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      if (selectedKeys.has(key) && selectedKeys.size > 1) selectedKeys.delete(key); else selectedKeys.add(key);
      dragAnchor = null; dragging = false; updateSelectionClasses(); renderInspector(); return;
    }
    dragAnchor = [r, c]; dragging = true; selectedKeys = new Set([key]);
    updateSelectionClasses(); updateSelectionSummary();
  }

  function invertVisibleSelection() {
    const plate = getPlate(); const view = plateWindow(plate); const next = new Set(selectedKeys);
    for (let r = view.rowStart; r < view.rowEnd; r++) for (let c = view.columnStart; c < view.columnEnd; c++) {
      const key = `${r},${c}`;
      if (next.has(key)) next.delete(key); else next.add(key);
    }
    selectedKeys = next; renderGrid(); renderInspector();
  }

  function onGridPointerOver(event) {
    if (!dragging || !dragAnchor) return;
    const cell = event.target.closest('.well-cell'); if (!cell) return;
    const r = Number(cell.dataset.r); const c = Number(cell.dataset.c);
    const [r0, c0] = dragAnchor;
    const next = new Set();
    for (let rr = Math.min(r0, r); rr <= Math.max(r0, r); rr++) {
      for (let cc = Math.min(c0, c); cc <= Math.max(c0, c); cc++) next.add(`${rr},${cc}`);
    }
    selectedKeys = next; updateSelectionClasses(); updateSelectionSummary();
  }

  function clearWellHover() {
    window.clearTimeout(hoverTimer); hoverTimer = 0;
    if (hoverCell) hoverCell.removeAttribute('aria-describedby');
    hoverCell = null; wellTooltip.hidden = true; wellTooltip.replaceChildren();
  }

  function onWellPointerOver(event) {
    if (dragging || (event.pointerType && event.pointerType !== 'mouse')) return;
    const cell = event.target.closest('.well-cell');
    if (!cell || !plateGrid.contains(cell)) return;
    hoverPoint = { x: event.clientX, y: event.clientY };
    if (hoverCell === cell) {
      if (!wellTooltip.hidden) positionWellTooltip();
      return;
    }
    clearWellHover(); hoverCell = cell;
    hoverTimer = window.setTimeout(() => {
      if (hoverCell !== cell || !cell.isConnected) return;
      renderWellTooltip(); wellTooltip.hidden = false;
      cell.setAttribute('aria-describedby', 'well-tooltip');
      positionWellTooltip();
    }, 2000);
  }

  function onWellPointerOut(event) {
    const cell = event.target.closest('.well-cell');
    if (!cell || cell !== hoverCell) return;
    const relatedCell = event.relatedTarget?.closest?.('.well-cell');
    if (relatedCell === cell) return;
    clearWellHover();
  }

  function onWellPointerMove(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    if (!hoverCell || !hoverCell.contains(event.target)) return;
    hoverPoint = { x: event.clientX, y: event.clientY };
    if (!wellTooltip.hidden) positionWellTooltip();
  }

  function appendTooltipRow(key, value) {
    const row = document.createElement('div'); row.className = 'well-tooltip-row';
    const keyNode = document.createElement('span'); keyNode.className = 'well-tooltip-key'; keyNode.textContent = key;
    const valueNode = document.createElement('span'); valueNode.className = 'well-tooltip-value'; valueNode.textContent = String(value ?? '') || '—';
    row.append(keyNode, valueNode); wellTooltip.append(row);
  }

  function renderWellTooltip() {
    if (!hoverCell) return;
    const plate = getPlate(); const r = Number(hoverCell.dataset.r); const c = Number(hoverCell.dataset.c);
    const well = wellAt(plate, r, c); if (!well) return;
    wellTooltip.replaceChildren();
    const title = document.createElement('div'); title.className = 'well-tooltip-title';
    title.textContent = `${plate.label} · ${positionLabel(plate, r, c)}`;
    wellTooltip.append(title);
    appendTooltipRow('Well ID', well.well_id || 'No well ID');
    appendTooltipRow('Occupied', wellIsOccupied(well) ? 'Yes' : 'No');
    if (plate.group) appendTooltipRow('Group', plate.group);
    if (plate.sample_index) appendTooltipRow('Sample index', plate.sample_index);
    if (plate.source_sample) appendTooltipRow('Source sample', plate.source_sample);
    for (const field of metadataFields()) appendTooltipRow(featureLabel(field), getValue(well, field));
  }

  function positionWellTooltip() {
    let left = hoverPoint.x + 14; let top = hoverPoint.y + 14;
    wellTooltip.style.left = `${left}px`; wellTooltip.style.top = `${top}px`;
    const rect = wellTooltip.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - 8) left = hoverPoint.x - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = hoverPoint.y - rect.height - 14;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
    wellTooltip.style.left = `${left}px`; wellTooltip.style.top = `${top}px`;
  }

  function onGridPointerUp() {
    if (!dragging) return;
    dragging = false; dragAnchor = null; renderInspector();
  }

  function updateSelectionClasses() {
    for (const cell of plateGrid.querySelectorAll('.well-cell')) {
      const selected = selectedKeys.has(`${cell.dataset.r},${cell.dataset.c}`);
      cell.classList.toggle('selected', selected); cell.tabIndex = selected ? 0 : -1;
    }
    updateSelectionSummary();
  }

  function onGridKeydown(event) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const cell = event.target.closest('.well-cell'); if (!cell) return;
    event.preventDefault();
    const plate = getPlate(); let r = Number(cell.dataset.r); let c = Number(cell.dataset.c);
    if (event.key === 'ArrowUp') r = Math.max(0, r - 1);
    if (event.key === 'ArrowDown') r = Math.min(plate.rows - 1, r + 1);
    if (event.key === 'ArrowLeft') c = Math.max(0, c - 1);
    if (event.key === 'ArrowRight') c = Math.min(plate.columns - 1, c + 1);
    selectedKeys = new Set([`${r},${c}`]); updateSelectionClasses(); renderInspector();
    plateGrid.querySelector(`.well-cell[data-r="${r}"][data-c="${c}"]`)?.focus();
  }

  function onGridPaste(event) {
    const text = event.clipboardData?.getData('text/plain');
    const cell = event.target.closest('.well-cell');
    if (!text || !cell) return;
    event.preventDefault();
    applyPastedText(text, [Number(cell.dataset.r), Number(cell.dataset.c)], pasteTargetFeature(), true);
  }

  function parseDelimited(text) {
    const cleaned = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const firstLine = cleaned.split('\n', 1)[0] || '';
    const delimiter = firstLine.includes('\t') ? '\t' : ',';
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (char === '"') {
        if (quoted && cleaned[i + 1] === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && char === delimiter) { row.push(cell); cell = ''; }
      else if (!quoted && char === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += char;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every((value) => value === '')) rows.pop();
    return rows;
  }

  function canonicalHeader(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    const aliases = {
      plate: 'plate_id', label: 'plate_id', plate_name: 'plate_id',
      well: 'well_id', well_number: 'well_id', well_dt: 'well_id', well_name: 'well_name_label',
      compound: 'treatment', treatment_name: 'treatment', row: 'plate_row', column: 'plate_column',
      col: 'plate_column', x: 'x', y: 'y', sample: 'source_sample', sample_index: 'sample_index',
      occupied: 'is_occupied', position: 'plate_position'
    };
    return aliases[raw] || normalizeFieldName(raw);
  }

  function isHeaderRow(row) {
    const normalized = row.map(canonicalHeader);
    const known = new Set(['plate_id', 'well_id', 'barcode', 'well_name_label', 'plate_position', 'plate_row', 'plate_column', 'dose', 'time', 'treatment', 'sample_index', 'source_sample', 'x', 'y']);
    return normalized.filter((field) => known.has(field)).length >= 2;
  }

  function applyPastedText(text, start, field, fromClipboard) {
    const matrix = parseDelimited(text);
    if (!matrix.length) return 0;
    if (isHeaderRow(matrix[0])) {
      const count = applyHeaderMatrix(matrix, start);
      lastPasteSkipped = Math.max(0, matrix.slice(1).filter((row) => row.some((value) => String(value).trim())).length - count);
      renderAll(); saveProject();
      if (fromClipboard) showPasteToast(count);
      return count;
    }
    const plate = getPlate();
    const nonemptyRows = matrix.filter((row) => row.length);
    const requested = nonemptyRows.reduce((total, row) => total + row.length, 0);
    const singleColumn = nonemptyRows.every((row) => row.length === 1);
    let count = 0;
    if (singleColumn && selectedKeys.size > 1) {
      const coords = selectionCoordinates();
      nonemptyRows.forEach((row, index) => {
        if (index >= coords.length) return;
        const [r, c] = coords[index]; const well = wellAt(plate, r, c); setField(well, field, row[0]);
        if (row[0].trim() && fieldOccupiesWell(field)) well.is_occupied = true; count++;
      });
    } else {
      let sourceRow = 0;
      for (let r = 0; r < nonemptyRows.length; r++) {
        for (let c = 0; c < nonemptyRows[r].length; c++) {
          const rr = start[0] + r; const cc = start[1] + c;
          if (rr >= plate.rows || cc >= plate.columns) continue;
          const value = nonemptyRows[r][c]; const well = wellAt(plate, rr, cc);
          setField(well, field, value); if (value.trim() && fieldOccupiesWell(field)) well.is_occupied = true; count++;
        }
      }
    }
    lastPasteSkipped = Math.max(0, requested - count);
    renderAll(); saveProject();
    if (fromClipboard) showPasteToast(count);
    return count;
  }

  function showPasteToast(count) {
    showToast(lastPasteSkipped
      ? `Pasted ${count} values; ${lastPasteSkipped} did not fit the selected wells.`
      : `Pasted data into ${count} wells.`);
  }

  function applyHeaderMatrix(matrix, start) {
    const headers = matrix[0].map(canonicalHeader);
    for (const field of headers) {
      if (['x', 'y', 'plate_row', 'plate_column', 'plate_position', 'plate_id', 'sample_index', 'source_sample'].includes(field)) continue;
      if (isAllowedOptionalField(field)) addOptionalField(field);
    }
    const plate = getPlate();
    let sequential = 0; let count = 0;
    const fallbackCoords = selectionKeysOrSequential(plate, start);
    for (const row of matrix.slice(1)) {
      if (row.every((value) => !String(value).trim())) continue;
      const record = Object.fromEntries(headers.map((header, i) => [header, row[i] ?? '']));
      let target = null;
      if (record.well_id) {
        for (let r = 0; r < plate.rows && !target; r++) for (let c = 0; c < plate.columns; c++) {
          if (plate.wells[r][c].well_id.toLowerCase() === String(record.well_id).trim().toLowerCase()) { target = [r, c]; break; }
        }
      }
      if (!target) target = recordCoordinate(record, plate) || fallbackCoords[sequential];
      sequential++;
      if (!target) continue;
      const [r, c] = target; const well = wellAt(plate, r, c); if (!well) continue;
      applyRecordToWell(well, record);
      count++;
    }
    return count;
  }

  function selectionKeysOrSequential(plate, start) {
    if (selectedKeys.size > 1) return selectionCoordinates();
    const order = numberingCoordinates(plate); const key = `${start[0]},${start[1]}`;
    const index = Math.max(0, order.findIndex(([r, c]) => `${r},${c}` === key));
    return order.slice(index);
  }

  function parseRowLabel(value) {
    const text = String(value || '').toUpperCase();
    if (!/^[A-Z]+$/.test(text)) return -1;
    let number = 0; for (const char of text) number = number * 26 + char.charCodeAt(0) - 64;
    return number - 1;
  }

  function recordCoordinate(record, plate) {
    if (record.plate_position) {
      const match = String(record.plate_position).trim().match(/^([A-Za-z]+)\s*0*([0-9]+)$/);
      if (match) return [parseRowLabel(match[1]), Number(match[2]) - 1];
    }
    let r = Number.NaN; let c = Number.NaN;
    if (record.plate_row !== '' && record.plate_row != null) r = Number(record.plate_row) - 1;
    if (record.plate_column !== '' && record.plate_column != null) c = Number(record.plate_column) - 1;
    if (!Number.isFinite(r) && record.y !== '' && record.y != null) r = Number(record.y) - 1;
    if (!Number.isFinite(c) && record.x !== '' && record.x != null) c = Number(record.x) - 1;
    return Number.isFinite(r) && Number.isFinite(c) && r >= 0 && c >= 0 && r < plate.rows && c < plate.columns ? [r, c] : null;
  }

  function applyRecordToWell(well, record) {
    const handled = new Set(['plate_id', 'group', 'sample_index', 'source_sample', 'plate_position', 'plate_row', 'plate_column', 'x', 'y', 'total_well', 'well_name_fill_color', 'well_number_label', 'well_number_fill_color', 'display_feature', 'display_label', 'display_fill_color']);
    for (const [rawField, rawValue] of Object.entries(record)) {
      if (handled.has(rawField) || rawValue == null) continue;
      let field = rawField;
      if (field === 'well_name') field = 'well_name_label';
      if (field === 'compound') field = 'treatment';
      if (field === 'well_name_label') continue;
      if (field === 'well_number') field = 'well_id';
      if (field === 'is_occupied') {
        well.is_occupied = /^(1|true|yes|occupied)$/i.test(String(rawValue).trim()); continue;
      }
      setField(well, field, rawValue);
    }
    const explicitlyOccupied = record.is_occupied != null && String(record.is_occupied).trim() !== '';
    if (!explicitlyOccupied && (well.barcode || metadataFields().some((field) => String(well.values[field] || '').trim()))) well.is_occupied = true;
  }

  function installImportedPlates(imported, sourceName, mapping = '') {
    if (!imported.length) { showToast('No plates were found in that file.'); return; }
    const mappingText = mapping ? `\nDetected fields: ${mapping}.` : '';
    const replace = window.confirm(`Found ${imported.length} plate${imported.length === 1 ? '' : 's'} in ${sourceName}.${mappingText}\nReplace the current project? Choose Cancel to add them to this project.`);
    if (replace) {
      project.plates = imported;
    }
    else {
      project.plates.push(...imported);
    }
    currentPlateId = imported[0].id; currentWindowIndex = 0; selectedKeys = new Set(['0,0']); renderAll();
    showToast(`Imported ${imported.length} plate${imported.length === 1 ? '' : 's'}.`);
  }

  async function importTableFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text(); const matrix = parseDelimited(text);
      if (matrix.length && isHeaderRow(matrix[0])) {
        const imported = tableToPlates(matrix);
        if (imported.length) installImportedPlates(imported, file.name, [...new Set(matrix[0].map(canonicalHeader))].join(', '));
        else showToast('No well records were found in that table.');
      } else {
        const [r, c] = anchorCoordinate(); const count = applyPastedText(text, [r, c], pasteTargetFeature(), false);
        showPasteToast(count);
      }
    } catch (error) { showToast(`Table import failed: ${error.message}`); }
  }

  function tableToPlates(matrix) {
    const headers = matrix[0].map(canonicalHeader);
    const records = matrix.slice(1).filter((row) => row.some((value) => String(value).trim())).map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ''])));
    if (!records.length) return [];
    const groups = new Map();
    records.forEach((record) => {
      const label = String(record.plate_id || 'Imported plate 1');
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ record });
    });
    const imported = [];
    for (const [label, entries] of groups) {
      let maxR = -1; let maxC = -1; let total = 0;
      for (const { record } of entries) {
        total = Math.max(total, Number(record.total_well) || 0);
        const point = recordCoordinate({ ...record, plate_position: record.plate_position || record.position }, { rows: 40, columns: 48 });
        if (point) { maxR = Math.max(maxR, point[0]); maxC = Math.max(maxC, point[1]); }
      }
      const common = { 6: [2, 3], 12: [3, 4], 24: [4, 6], 48: [6, 8], 96: [8, 12], 384: [16, 24], 1536: [32, 48] }[total] || [0, 0];
      let rows; let columns;
      if (maxR < 0 && maxC < 0) {
        columns = Math.min(48, common[1] || 12);
        rows = Math.min(40, Math.max(common[0] || 8, Math.ceil(entries.length / columns)));
      } else {
        rows = Math.min(40, Math.max(maxR + 1, common[0], 1));
        columns = Math.min(48, Math.max(maxC + 1, common[1], 1));
      }
      const plate = makePlate(label, rows, columns);
      const first = entries[0].record;
      plate.group = String(first.group || ''); plate.sample_index = String(first.sample_index ?? ''); plate.source_sample = String(first.source_sample || '');
      let sequential = 0;
      for (const { record } of entries) {
        let point = recordCoordinate({ ...record, plate_position: record.plate_position || record.position }, plate);
        if (!point) point = [Math.floor(sequential / columns), sequential % columns];
        sequential++;
        const [r, c] = point;
        if (r >= 0 && r < rows && c >= 0 && c < columns) applyRecordToWell(plate.wells[r][c], record);
      }
      imported.push(plate);
    }
    return imported;
  }

  function downloadProject() {
    const payload = JSON.stringify({ ...project, settings: { ...project.settings, displayFeature: selectedFeatures[0] || '', displayFeatures: [...selectedFeatures] } }, null, 2);
    downloadBlob(new Blob([payload], { type: 'application/json' }), 'easyplate_project.json');
    showToast('Project JSON downloaded.');
  }

  async function openProjectFile(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      const imported = normalizeProject(JSON.parse(await file.text()));
      project = imported; currentPlateId = project.plates[0].id; currentWindowIndex = 0; selectedFeatures = [...project.settings.displayFeatures]; selectedFeature = selectedFeatures[0] || project.fields[0] || 'cell_line';
      selectedKeys = new Set(['0,0']); renderAll(); showToast('Project opened.');
    } catch (error) { showToast(`Could not open project: ${error.message}`); }
  }

  function exportWarnings() {
    const warnings = [];
    for (const plate of project.plates) {
      const seen = new Set(); let duplicates = 0; let blanks = 0;
      for (const row of plate.wells) for (const well of row) {
        const id = String(well.well_id || '').trim();
        if (!id) { blanks++; continue; }
        if (seen.has(id)) duplicates++; else seen.add(id);
      }
      if (duplicates) warnings.push(`${plate.label}: ${duplicates} duplicate well ID${duplicates === 1 ? '' : 's'}`);
      if (blanks) warnings.push(`${plate.label}: ${blanks} empty well ID${blanks === 1 ? '' : 's'}`);
    }
    return warnings;
  }

  function confirmExportWarnings() {
    const warnings = exportWarnings();
    return !warnings.length || window.confirm(`Review before export:\n\n${warnings.slice(0, 8).join('\n')}${warnings.length > 8 ? '\n…' : ''}\n\nExport anyway?`);
  }

  function csvEscape(value) {
    const text = String(value ?? '');
    return `"${text.replaceAll('"', '""')}"`;
  }

  function isMissingFeatureValue(value) {
    if (value == null) return true;
    const text = String(value).trim();
    return text === '' || /^(none|n\/?a|null|nan|<na>)$/i.test(text);
  }

  function csvFeatureValue(well, field) {
    const value = field === 'barcode' ? well.barcode : well.values[field];
    return isMissingFeatureValue(value) ? '' : value;
  }

  function wellNameForCsv(well) {
    return metadataFields()
      .filter((field) => field !== 'well_name_label' && field !== 'well_id' && field !== 'is_occupied')
      .map((field) => csvFeatureValue(well, field))
      .filter((value) => !isMissingFeatureValue(value))
      .map((value) => String(value).trim())
      .join('_');
  }

  function featureHasExportValue(field) {
    return project.plates.some((plate) => plate.wells.some((row) => row.some((well) =>
      !isMissingFeatureValue(field === 'barcode' ? well.barcode : well.values[field])
    )));
  }

  function annotationRows() {
    const exportableFields = metadataFields().filter(featureHasExportValue);
    const exportablePlateFields = ['group', 'sample_index', 'source_sample'].filter((field) =>
      project.plates.some((plate) => !isMissingFeatureValue(plate[field]))
    );
    const exportWellName = project.plates.some((plate) => plate.wells.some((row) => row.some((well) => wellNameForCsv(well) !== '')));
    const exportBarcode = exportableFields.includes('barcode');
    const columns = [
      ...(exportablePlateFields.includes('group') ? ['group'] : []), 'plate_id',
      ...(exportablePlateFields.includes('sample_index') ? ['sample_index'] : []),
      ...(exportablePlateFields.includes('source_sample') ? ['source_sample'] : []),
      'plate_position', 'plate_row', 'plate_column',
      'is_occupied', ...(exportBarcode ? ['barcode'] : []), 'well_id',
      ...(exportWellName ? ['well_name_label', 'well_name_fill_color'] : []),
      'well_number_label', 'well_number_fill_color',
      ...exportableFields.filter((field) => field !== 'barcode')
    ];
    const rows = [];
    for (const plate of project.plates) {
      for (let r = 0; r < plate.rows; r++) for (let c = 0; c < plate.columns; c++) {
        const well = plate.wells[r][c]; const wellName = wellNameForCsv(well);
        const record = {
          group: csvPlateValue(plate.group), plate_id: plate.label,
          sample_index: csvPlateValue(plate.sample_index), source_sample: csvPlateValue(plate.source_sample),
          plate_position: positionLabel(plate, r, c), plate_row: r + 1, plate_column: c + 1,
          is_occupied: wellIsOccupied(well) ? 'true' : 'false', barcode: csvFeatureValue(well, 'barcode'), well_id: well.well_id,
          well_name_label: wellName, well_name_fill_color: colorFor(wellName, 'well_name_label'),
          well_number_label: well.well_id, well_number_fill_color: '#E2E8F0'
        };
        for (const field of exportableFields) if (field !== 'barcode') record[field] = csvFeatureValue(well, field);
        rows.push(columns.map((column) => record[column] ?? ''));
      }
    }
    return { columns, rows };
  }

  function csvPlateValue(value) {
    return isMissingFeatureValue(value) ? '' : value;
  }

  function exportCsv() {
    if (!confirmExportWarnings()) return;
    const { columns, rows } = annotationRows();
    const csv = `\uFEFF${[columns, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n')}`;
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'plate_layout_annotations.csv');
    showToast(`Exported ${rows.length} plate positions to CSV.`);
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function drawPlate(canvas, plate, view = plateWindow(plate)) {
    const preview = project.settings.preview;
    const margin = 40; const cellW = preview.wellSize;
    const visibleRows = view.rowEnd - view.rowStart; const visibleColumns = view.columnEnd - view.columnStart;
    const lineHeight = preview.fontSize * 1.35;
    const measureContext = document.createElement('canvas').getContext('2d');
    measureContext.font = `${Math.max(6, preview.fontSize - 2)}px Arial, sans-serif`;
    const layoutLines = [];
    for (let r = view.rowStart; r < view.rowEnd; r++) for (let c = view.columnStart; c < view.columnEnd; c++) {
      const lines = [];
      for (const featureLine of wellLinesForFeatures(plate.wells[r][c])) {
        lines.push(...wrapCanvasText(measureContext, featureLine, cellW - 10));
      }
      layoutLines.push(lines);
    }
    const maxLines = Math.max(1, ...layoutLines.map((lines) => lines.length));
    const cellH = Math.max(preview.wellSize, maxLines * lineHeight + 12);
    const gap = Math.max(3, Math.min(7, Math.floor(cellW / 12)));
    const axisW = 30; const titleH = 82;
    const logicalWidth = margin * 2 + axisW + visibleColumns * (cellW + gap);
    const logicalHeight = margin * 2 + titleH + visibleRows * (cellH + gap);
    const scale = Math.min(3, 8000 / logicalWidth, 8000 / logicalHeight);
    canvas.width = Math.ceil(logicalWidth * scale);
    canvas.height = Math.ceil(logicalHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, logicalWidth, logicalHeight);
    ctx.fillStyle = '#23352a'; ctx.font = '700 25px Manrope, Arial, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(plate.label || 'Untitled plate', margin, margin + 25);
    ctx.fillStyle = '#78857c'; ctx.font = '12px Arial, sans-serif';
    const viewLabel = preview.slideWindows ? `  ·  Window ${view.index + 1} of ${view.total}` : '';
    ctx.fillText(`Preview: ${selectedDisplayTitle()}${viewLabel}  ·  ${plate.rows} rows × ${plate.columns} columns${plate.group ? `  ·  ${plate.group}` : ''}`, margin, margin + 48);
    const gridX = margin + axisW; const gridY = margin + titleH;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '600 10px Arial, sans-serif'; ctx.fillStyle = '#849087';
    for (let c = view.columnStart; c < view.columnEnd; c++) ctx.fillText(plate.columnLabels[c] || String(c + 1), gridX + (c - view.columnStart) * (cellW + gap) + cellW / 2, gridY - 12);
    let layoutIndex = 0;
    for (let r = view.rowStart; r < view.rowEnd; r++) {
      const canvasRow = r - view.rowStart;
      ctx.fillText(plate.rowLabels[r] || lettersForRow(r), margin + axisW / 2, gridY + canvasRow * (cellH + gap) + cellH / 2);
      for (let c = view.columnStart; c < view.columnEnd; c++) {
        const well = plate.wells[r][c]; const lines = layoutLines[layoutIndex++] || [];
        const x = gridX + (c - view.columnStart) * (cellW + gap); const y = gridY + canvasRow * (cellH + gap);
        ctx.fillStyle = displayColorFor(well); ctx.strokeStyle = '#dfe6e1'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(x, y, cellW, cellH, 7); ctx.fill(); ctx.stroke();
        if (wellIsOccupied(well)) { ctx.fillStyle = '#54a376'; ctx.beginPath(); ctx.arc(x + cellW - 8, y + 8, 2.5, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = '#304237'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `${Math.max(6, preview.fontSize - 2)}px Arial, sans-serif`;
        const totalHeight = lines.length * lineHeight;
        lines.forEach((line, i) => ctx.fillText(line, x + cellW / 2, y + (cellH - totalHeight) / 2 + (i + 0.5) * lineHeight));
      }
    }
  }

  function safeFilename(value) {
    return String(value || 'plate').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'plate';
  }

  function exportPng() {
    const plate = getPlate(); const canvas = document.createElement('canvas');
    const view = plateWindow(plate);
    drawPlate(canvas, plate, view);
    canvas.toBlob((blob) => {
      if (!blob) { showToast('The browser could not render this plate as PNG.'); return; }
      const windowSuffix = project.settings.preview.slideWindows ? `_window_${view.index + 1}` : '';
      downloadBlob(blob, `${safeFilename(plate.label)}${windowSuffix}_${safeFilename(selectedFeatures.join('_') || 'well_ids')}.png`);
      showToast(`Exported ${plate.label}${project.settings.preview.slideWindows ? ` window ${view.index + 1}` : ''} as PNG.`);
    }, 'image/png');
  }

  function htmlEscape(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function estimatedWrappedLineCount(text, charactersPerLine) {
    return String(text).split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0);
  }

  function exportPdf() {
    if (!confirmExportWarnings()) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) { showToast('Allow pop-ups for this local page to print or save the PDF.'); return; }
    const preview = project.settings.preview;
    const featureGroups = chunkFeatures(selectedFeatures, 2);
    const pageConfigs = [];
    const pdfFontSize = Math.max(6, Math.min(10, preview.fontSize * 0.5));
    for (const plate of project.plates) {
      for (const baseView of pdfWindows(plate)) {
        const visibleColumns = baseView.columnEnd - baseView.columnStart;
        const printableWidth = 1040;
        const cellWidth = (printableWidth - 32 - visibleColumns * 4) / visibleColumns;
        const charactersPerLine = Math.max(7, Math.floor(cellWidth / (pdfFontSize * 0.55)));
        for (const fields of featureGroups) {
          let maximumLines = 1;
          for (let r = baseView.rowStart; r < baseView.rowEnd; r++) for (let c = baseView.columnStart; c < baseView.columnEnd; c++) {
            const lines = pdfFeatureLines(plate.wells[r][c], fields);
            const count = lines.reduce((sum, line) => sum + estimatedWrappedLineCount(line, charactersPerLine), 0);
            maximumLines = Math.max(maximumLines, count);
          }
          const cellHeight = Math.max(26, maximumLines * pdfFontSize * 1.25 + 12);
          const rowsPerPage = Math.max(1, Math.min(baseView.rowEnd - baseView.rowStart, Math.floor(475 / cellHeight)));
          for (let rowStart = baseView.rowStart; rowStart < baseView.rowEnd; rowStart += rowsPerPage) {
            pageConfigs.push({
              plate, fields,
              view: { ...baseView, rowStart, rowEnd: Math.min(baseView.rowEnd, rowStart + rowsPerPage) },
              cellHeight
            });
          }
        }
      }
    }
    const pages = pageConfigs.map(({ plate, fields, view, cellHeight }, pageIndex) => {
      const visibleRows = view.rowEnd - view.rowStart; const visibleColumns = view.columnEnd - view.columnStart;
      const cells = ['<div class="corner"></div>'];
      for (let c = view.columnStart; c < view.columnEnd; c++) cells.push(`<div class="axis">${htmlEscape(plate.columnLabels[c] || c + 1)}</div>`);
      for (let r = view.rowStart; r < view.rowEnd; r++) {
        cells.push(`<div class="axis">${htmlEscape(plate.rowLabels[r] || lettersForRow(r))}</div>`);
        for (let c = view.columnStart; c < view.columnEnd; c++) {
          const well = plate.wells[r][c]; const color = displayColorFor(well);
          const lines = pdfFeatureLines(well, fields);
          const labelsHtml = lines.map((line) => `<span>${htmlEscape(line)}</span>`).join('');
          cells.push(`<div class="well" style="background:${color}"><div class="label">${labelsHtml}</div></div>`);
        }
      }
      const featureTitle = fields.length ? fields.map(featureLabel).join(', ') : (project.settings.preview.showWellId ? 'Well IDs' : 'No labels');
      const windowLabel = `Window ${view.index + 1} · rows ${view.rowStart + 1}–${view.rowEnd}, columns ${view.columnStart + 1}–${view.columnEnd}`;
      return `<section class="page"><header><div><p>EasyPlate · Layout preview</p><h1>${htmlEscape(plate.label || 'Untitled plate')}</h1><small>Features: ${htmlEscape(featureTitle)} · ${htmlEscape(windowLabel)} · ${visibleRows} × ${visibleColumns} shown of ${plate.rows} × ${plate.columns}${plate.group ? ` · ${htmlEscape(plate.group)}` : ''}</small></div><aside>${htmlEscape(plate.sample_index ? `Sample ${plate.sample_index}` : '')}</aside></header><div class="map" style="--columns:${visibleColumns};--cell-height:${cellHeight}px;--label-size:${pdfFontSize}px">${cells.join('')}</div><footer>${htmlEscape(plate.source_sample || 'Local EasyPlate project')} · ${plate.rows * plate.columns} positions · Page ${pageIndex + 1} of ${pageConfigs.length}</footer></section>`;
    }).join('');
    const documentHtml = `<!doctype html><html><head><meta charset="utf-8"><title>EasyPlate plate layouts</title><style>
      @page { size: landscape; margin: 9mm; }
      * { box-sizing: border-box; } body { margin: 0; font: 9px Arial, sans-serif; color: #23352a; }
      .page { width: 100%; min-height: 180mm; break-after: page; page-break-after: always; page-break-inside: avoid; padding: 2mm 0; display: flex; flex-direction: column; }
      .page:last-child { break-after: auto; page-break-after: auto; }
      header { display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:7mm; } header p { margin:0 0 2mm; color:#728077; font-size:8px; letter-spacing:.08em; text-transform:uppercase; }
      h1 { margin:0 0 2mm; font-size:20px; } header small, header aside { color:#728077; font-size:9px; }
      .map { display:grid; grid-template-columns: 7mm repeat(var(--columns), minmax(0,1fr)); gap:1.1mm; flex:1; align-content:start; }
      .axis { display:flex; justify-content:center; align-items:center; color:#87938b; font-size:7px; }
      .corner { min-height:4mm; } .well { min-width:0; min-height:var(--cell-height); overflow:visible; border:1px solid #dfe6e1; border-radius:1.5mm; display:flex; flex-direction:column; justify-content:center; align-items:stretch; gap:1mm; padding:1mm; text-align:left; }
      .label { display:flex; flex-direction:column; gap:.5mm; min-width:0; overflow:visible; white-space:normal; overflow-wrap:anywhere; word-break:break-word; font-size:var(--label-size); font-weight:500; line-height:1.15; }
      .label span { display:block; min-width:0; overflow-wrap:anywhere; word-break:break-word; }
      footer { margin-top:auto; padding-top:3mm; color:#89958d; font-size:7px; }
      @media print { body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
    </style></head><body>${pages}<script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));<\/script></body></html>`;
    printWindow.document.open(); printWindow.document.write(documentHtml); printWindow.document.close();
  }

  function initialize() {
    if (!project || !project.plates.length) project = blankProject();
    currentPlateId = project.plates.find((plate) => plate.id === currentPlateId)?.id || project.plates[0].id;
    selectedFeatures = [...(project.settings.displayFeatures || [])];
    selectedFeature = selectedFeatures[0] || project.fields[0] || 'cell_line';
    bindEvents(); renderAll();
  }

  initialize();
})();

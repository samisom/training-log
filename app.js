(() => {
  'use strict';

  const CONFIG = window.WORKOUT_APP_CONFIG || {};
  const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
  const STORAGE_KEY = 'ptWorkoutLogger.sheetId';
  const DRAFT_PREFIX = 'ptWorkoutLogger.draft';
  const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

  const state = {
    tokenClient: null,
    accessToken: '',
    sheetId: '',
    exercises: [],
    seedExercises: [],
    prRows: [],
    logRows: [],
    programmedRows: [],
    selectedExercise: null,
    isSaving: false,
    isLoading: false,
    activeMuscleGroups: new Set(),
    defaultLoadUnit: 'kg'
  };

  const els = {};

  document.addEventListener('DOMContentLoaded', boot);

  let quickDraftContext = { date: '' };
  let draftSaveTimer = null;

  function boot() {
    cacheElements();
    setAppName();
    initDate();
    restoreSheetId();
    attachEvents();
    quickDraftContext = getQuickDraftContext();
    ensureQuickUI();
    updateLoadPlaceholders();
    loadSeedExercises();
    waitForGoogleIdentity();
    registerServiceWorker();
    addRows(Number(CONFIG.DEFAULT_ROWS || 8));
    updateReadyCount();
  }

  function cacheElements() {
    const ids = [
      'connectionStatus',
      'sheetIdInput',
      'saveSheetIdBtn',
      'authorizeBtn',
      'loadSheetBtn',
      'forgetSheetBtn',
      'setupMessage',
      'dateInput',
      'bodyweightInput',
      'loadUnitSelect',
      'muscleGroupSummary',
      'muscleGroupOptions',
      'selectAllMuscleGroupsBtn',
      'clearAllMuscleGroupsBtn',
      'addRowBtn',
      'addFiveRowsBtn',
      'saveRowsBtn',
      'clearRowsBtn',
      'entryBody',
      'entrySummary',
      'exerciseMeta',
      'quickEntryList',
      'mobileSaveBar',
      'mobileSaveBtn'
    ];

    ids.forEach((id) => {
      els[id] = document.getElementById(id);
    });
    // also refresh mobile quick-entry selects
    refreshQuickExerciseSelects();
  }

  /* Quick-entry (mobile) helpers */
  function ensureQuickUI() {
    const container = els.quickEntryList;
    if (!container) return;
    // create footer with add button and summary
    let footer = container.querySelector('.quick-entry-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'quick-entry-footer';
      const btn = document.createElement('button');
      btn.id = 'addQuickExerciseBtn';
      btn.type = 'button';
      btn.className = 'primary';
      btn.textContent = 'Add exercise';
      btn.addEventListener('click', () => addQuickExerciseCard());
      const programmedBtn = document.createElement('button');
      programmedBtn.id = 'loadProgrammedWorkoutBtn';
      programmedBtn.type = 'button';
      programmedBtn.className = 'secondary';
      programmedBtn.textContent = 'Load programmed workout';
      programmedBtn.addEventListener('click', () => loadProgrammedWorkoutForCurrentDate({ force: true }));
      const summary = document.createElement('div');
      summary.id = 'quickEntrySummary';
      summary.style.marginLeft = '8px';
      footer.appendChild(btn);
      footer.appendChild(programmedBtn);
      footer.appendChild(summary);
      container.appendChild(footer);
    }
  }

  function getQuickEntryControls() {
    const container = els.quickEntryList;
    return container ? container.querySelector('.quick-entry-footer') : null;
  }

  function hasQuickDraftForContext(context) {
    const draftContext = context || getQuickDraftContext();
    const key = getDraftKey(draftContext.sheetId, draftContext.date);
    try {
      return Boolean(localStorage.getItem(key));
    } catch (error) {
      return false;
    }
  }

  function hasQuickEntryContent() {
    const container = els.quickEntryList;
    if (!container) return false;
    return Array.from(container.querySelectorAll('.quick-card')).some((card) => {
      const primaryExercise = card.querySelector('[data-role="primary"] .quick-exercise-select').value.trim();
      const variation = card.querySelector('.quick-variation-input').value.trim();
      const notes = card.querySelector('.quick-notes-input').value.trim();
      const mainSets = collectQuickSetDataFromList(card.querySelector('[data-role="primary"] .quick-set-list'));
      return primaryExercise || variation || notes || mainSets.some((set) => set.load || set.reps || set.drops.some((drop) => drop.load || drop.reps));
    });
  }

  function normalizeProgrammedDateValue(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      const parsedDate = new Date((value - 25569) * 86400000);
      return toInputDate(parsedDate);
    }
    const text = String(value).trim();
    if (!text) return '';
    const dateOnly = text.match(/^\d{4}-\d{2}-\d{2}/);
    if (dateOnly) return dateOnly[0];
    const parsedDate = new Date(text);
    if (!Number.isNaN(parsedDate.getTime())) return toInputDate(parsedDate);
    return text;
  }

  function parseProgrammedRows(valueRows) {
    const rows = Array.isArray(valueRows) ? valueRows : [];
    return rows.map((row) => ({
      date: normalizeProgrammedDateValue(row[0]),
      order: safeString(row[1]),
      exercise: safeString(row[2]),
      variation: safeString(row[3]),
      set: safeString(row[4]),
      load: safeString(row[5]),
      unit: safeString(row[6]),
      reps: safeString(row[7]),
      tempo: safeString(row[8]),
      cues: safeString(row[9]),
      notes: safeString(row[10]),
      superset: safeString(row[11]),
      muscleGroups: safeString(row[12]),
      coachNotes: safeString(row[13])
    })).filter((row) => row.date || row.exercise || row.set || row.load || row.reps || row.notes || row.cues || row.coachNotes || row.superset || row.muscleGroups);
  }

  function getProgrammedRowsForDate(date) {
    const normalizedDate = normalizeProgrammedDateValue(date);
    if (!normalizedDate) return [];
    return state.programmedRows.filter((row) => normalizeProgrammedDateValue(row.date) === normalizedDate);
  }

  function parseProgrammedSetReference(value) {
    const text = safeString(value);
    if (!text) return { mainSet: 1, dropIndex: null };
    const dropMatch = text.match(/^(\d+)\s*[-:]?\s*D(\d+)$/i);
    if (dropMatch) {
      return { mainSet: Number(dropMatch[1]) || 1, dropIndex: Number(dropMatch[2]) || 1 };
    }
    const mainMatch = text.match(/^(\d+)$/);
    if (mainMatch) {
      return { mainSet: Number(mainMatch[1]) || 1, dropIndex: null };
    }
    const numericFallback = Number(text);
    return { mainSet: Number.isFinite(numericFallback) ? numericFallback : 1, dropIndex: null };
  }

  function sortProgrammedRows(rows) {
    return rows.slice().sort((a, b) => {
      const aOrder = Number(a.order) || 0;
      const bOrder = Number(b.order) || 0;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aSet = parseProgrammedSetReference(a.set).mainSet;
      const bSet = parseProgrammedSetReference(b.set).mainSet;
      if (aSet !== bSet) return aSet - bSet;
      return safeString(a.exercise).localeCompare(safeString(b.exercise));
    });
  }

  function buildProgrammedNotes(rows) {
    const parts = [];
    rows.forEach((row) => {
      const cues = safeString(row.cues);
      const notes = safeString(row.notes);
      const coachNotes = safeString(row.coachNotes);
      const superset = safeString(row.superset);
      if (cues) parts.push(`Cues: ${cues}`);
      if (notes) parts.push(`Notes: ${notes}`);
      if (coachNotes) parts.push(`Coach: ${coachNotes}`);
      if (superset) parts.push(`Superset: ${superset}`);
    });
    return parts.filter(Boolean).join('\n');
  }

  function groupProgrammedWorkoutRows(rows) {
    const groups = new Map();
    sortProgrammedRows(rows).forEach((row) => {
      const key = [safeString(row.order), safeString(row.exercise), safeString(row.variation), safeString(row.superset)].join('::');
      if (!groups.has(key)) {
        groups.set(key, {
          exercise: safeString(row.exercise),
          variation: safeString(row.variation),
          tempo: safeString(row.tempo),
          notes: '',
          sets: [],
          rows: []
        });
      }
      const group = groups.get(key);
      group.rows.push(row);
    });

    return Array.from(groups.values()).map((group) => {
      const setMap = new Map();
      group.rows.forEach((row) => {
        const parsedSet = parseProgrammedSetReference(row.set);
        if (!setMap.has(parsedSet.mainSet)) {
          setMap.set(parsedSet.mainSet, {
            load: '',
            reps: '',
            unit: row.unit || '',
            drops: []
          });
        }
        const setData = setMap.get(parsedSet.mainSet);
        if (parsedSet.dropIndex) {
          setData.drops.push({
            load: safeString(row.load),
            reps: safeString(row.reps),
            unit: safeString(row.unit)
          });
        } else {
          setData.load = safeString(row.load);
          setData.reps = safeString(row.reps);
          setData.unit = safeString(row.unit);
        }
      });

      const sets = Array.from(setMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);

      return {
        ...group,
        sets,
        notes: buildProgrammedNotes(group.rows)
      };
    });
  }

  function createQuickCardsFromProgrammedRows(rows) {
    const container = els.quickEntryList;
    if (!container) return false;
    clearQuickCards();
    const groups = groupProgrammedWorkoutRows(rows);
    if (!groups.length) return false;

    const units = Array.from(new Set(rows.map((row) => normalizeLoadUnit(row.unit || 'kg'))));
    if (units.length === 1) {
      setWorkoutDefaultLoadUnit(units[0]);
    } else {
      setWorkoutDefaultLoadUnit('kg');
      setSetupMessage('Programmed workout has mixed units. Using kg as workout unit.', 'warning');
    }
    updateLoadPlaceholders();

    const controls = getQuickEntryControls();
    groups.forEach((group) => {
      const card = createQuickExerciseCard();
      const primarySelect = card.querySelector('[data-role="primary"] .quick-exercise-select');
      if (primarySelect && group.exercise) {
        const optionExists = Array.from(primarySelect.options).some((option) => option.value === group.exercise);
        if (!optionExists) {
          const option = document.createElement('option');
          option.value = group.exercise;
          option.textContent = `${group.exercise} - programmed`; 
          primarySelect.appendChild(option);
        }
        primarySelect.value = group.exercise;
      }

      const variationInput = card.querySelector('.quick-variation-input');
      if (variationInput) variationInput.value = group.variation || '';
      const tempoInput = card.querySelector('.quick-tempo-input');
      if (tempoInput) tempoInput.value = group.tempo || '';
      const notesInput = card.querySelector('.quick-notes-input');
      if (notesInput) notesInput.value = group.notes || '';
      const primaryList = card.querySelector('[data-role="primary"] .quick-set-list');
      renderQuickCardSetRows(card, Math.max(1, group.sets.length), {
        primary: group.sets,
        secondary: []
      });
      if (controls) {
        container.insertBefore(card, controls);
      } else {
        container.appendChild(card);
      }
    });

    refreshQuickExerciseSelects();
    Array.from(container.querySelectorAll('.quick-card')).forEach((card) => refreshQuickComputedCellsForCard(card));
    updateQuickReadyCount();
    debounceSaveQuickDraft();
    return true;
  }

  function applyProgrammedWorkoutForCurrentDate(options = {}) {
    const context = getQuickDraftContext();
    if (hasQuickDraftForContext(context)) {
      restoreQuickDraft(context);
      setSetupMessage('Draft restored instead of programmed workout.', 'success');
      return false;
    }

    if (!options.force && hasQuickEntryContent()) {
      clearQuickCards();
    }

    const selectedDate = els.dateInput.value;
    const rows = getProgrammedRowsForDate(selectedDate);
    if (!rows.length) {
      clearQuickCards();
      setSetupMessage('No programmed workout found for this date.', 'success');
      return false;
    }

    const loaded = createQuickCardsFromProgrammedRows(rows);
    if (loaded) {
      setSetupMessage('Programmed workout loaded.', 'success');
      return true;
    }
    return false;
  }

  function loadProgrammedWorkoutForCurrentDate(options = {}) {
    if (options.force && hasQuickEntryContent()) {
      const confirmed = window.confirm('Replace the current workout cards with the programmed workout for this date?');
      if (!confirmed) {
        setSetupMessage('Programmed workout load cancelled.', '');
        return false;
      }
    }
    return applyProgrammedWorkoutForCurrentDate({ ...options, force: true });
  }

  async function loadProgrammedWorkoutsFromSheet() {
    if (!state.sheetId || !state.accessToken) {
      state.programmedRows = [];
      return false;
    }

    const ranges = getRanges();
    try {
      const params = new URLSearchParams();
      params.set('ranges', ranges.programmedWorkouts);
      params.set('majorDimension', 'ROWS');
      params.set('valueRenderOption', 'FORMATTED_VALUE');
      params.set('dateTimeRenderOption', 'FORMATTED_STRING');
      const data = await sheetsFetch(`/values:batchGet?${params.toString()}`);
      const values = data.valueRanges && data.valueRanges[0] ? data.valueRanges[0].values || [] : [];
      state.programmedRows = parseProgrammedRows(values);
      applyProgrammedWorkoutForCurrentDate({ force: false });
      return true;
    } catch (error) {
      console.warn('Programmed workout tab could not be loaded', error);
      state.programmedRows = [];
      setSetupMessage('Programmed workout tab not found. Workout logging still works.', 'success');
      return false;
    }
  }

  function normalizeLoadUnit(unit) {
    const text = String(unit || '').trim().toLowerCase();
    return text === 'lb' ? 'lb' : 'kg';
  }

  function getWorkoutDefaultLoadUnit() {
    return normalizeLoadUnit(state.defaultLoadUnit || 'kg');
  }

  function getWorkoutLoadUnit() {
    return normalizeLoadUnit((els.loadUnitSelect && els.loadUnitSelect.value) || state.defaultLoadUnit || 'kg');
  }

  function updateLoadPlaceholders() {
    const unit = getWorkoutLoadUnit();
    const placeholder = unit;
    const inputs = document.querySelectorAll('.quick-load-input');
    inputs.forEach((input) => {
      input.placeholder = placeholder;
    });
  }

  function setWorkoutDefaultLoadUnit(unit) {
    const normalized = normalizeLoadUnit(unit);
    state.defaultLoadUnit = normalized;
    if (els.loadUnitSelect) {
      els.loadUnitSelect.value = normalized;
    }
    updateLoadPlaceholders();
    return normalized;
  }

  function createLoadUnitSelect(defaultUnit) {
    const select = document.createElement('select');
    select.className = 'load-unit-select compact-select';
    select.setAttribute('aria-label', 'Load unit');
    select.innerHTML = `
      <option value="kg">kg</option>
      <option value="lb">lb</option>
    `;
    select.value = normalizeLoadUnit(defaultUnit || getWorkoutDefaultLoadUnit());
    select.dataset.unit = select.value;
    select.addEventListener('change', () => {
      select.dataset.unit = normalizeLoadUnit(select.value);
    });
    return select;
  }

  function createQuickLoadControl() {
    const wrapper = document.createElement('div');
    wrapper.className = 'load-control quick-load-control';
    const input = document.createElement('input');
    // Use text + inputmode on mobile to avoid native number spinners
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'quick-load-input';
    input.placeholder = getWorkoutLoadUnit();
    wrapper.appendChild(input);
    return { wrapper, input };
  }

  function getRowLoadUnit(select, fallback) {
    if (!select) return normalizeLoadUnit(fallback || getWorkoutDefaultLoadUnit());
    const value = select.value || select.dataset.unit || fallback || '';
    return normalizeLoadUnit(value || getWorkoutDefaultLoadUnit());
  }

  function convertLoadToKg(loadRaw, unit) {
    const trimmed = String(loadRaw || '').trim();
    if (!trimmed) return '';

    const numeric = strictNumber(trimmed);
    if (numeric === null) return trimmed;

    return normalizeLoadUnit(unit) === 'lb' ? round(numeric / 2.20462, 2) : round(numeric, 2);
  }

  function formatEnteredLoadNote(loadRaw, unit) {
    const trimmed = String(loadRaw || '').trim();
    if (!trimmed || normalizeLoadUnit(unit) !== 'lb') return '';
    const numeric = strictNumber(trimmed);
    if (numeric === null) return '';
    return `Entered: ${trimmed} lb`;
  }

  function addQuickExerciseCard() {
    const container = els.quickEntryList;
    if (!container) return null;
    const card = createQuickExerciseCard();
    const controls = getQuickEntryControls();
    if (controls) {
      container.insertBefore(card, controls);
    } else {
      container.appendChild(card);
    }
    refreshQuickExerciseSelects();
    updateQuickReadyCount();
    return card;
  }

  function createQuickExerciseCard() {
    const card = document.createElement('div');
    card.className = 'quick-card';
    card.innerHTML = `
      <div class="exercise-row">
        <div class="quick-exercise-section" data-role="primary">
          <label class="quick-exercise-label">Exercise
            <select class="quick-exercise-select"></select>
          </label>
          <div class="set-rows">
            <div class="quick-set-list"></div>
          </div>
        </div>
        <div class="quick-superset-actions">
          <button type="button" class="ghost quick-add-superset-btn">Add superset exercise</button>
        </div>
        <div class="quick-superset-section" style="display:none">
          <div class="quick-superset-header">
            <span class="quick-superset-title">Superset exercise</span>
            <button type="button" class="ghost quick-remove-superset-btn">Remove superset</button>
          </div>
          <div class="quick-exercise-section" data-role="secondary">
            <label class="quick-exercise-label">Exercise
              <select class="quick-exercise-select"></select>
            </label>
            <div class="set-rows">
              <div class="quick-set-list"></div>
            </div>
          </div>
        </div>
        <details>
          <summary>Notes / tempo / variation</summary>
          <label>Tempo<input class="quick-tempo-input" type="text" placeholder="e.g. 31X0"></label>
          <label>Variation<input class="quick-variation-input" type="text" placeholder="Optional"></label>
          <label>Notes<textarea class="quick-notes-input" rows="3" placeholder="Cues or notes"></textarea></label>
        </details>
      </div>
    `;
    renderQuickCardSetRows(card, 1);
    return card;
  }

  function createDropSetRow(dropIndex, existingValues) {
    const row = document.createElement('div');
    row.className = 'drop-set-row';
    const label = document.createElement('span');
    label.className = 'drop-set-label';
    label.textContent = `Drop ${dropIndex}`;
    const values = existingValues || {};
    const loadControl = createQuickLoadControl();
    const load = loadControl.input;
    const reps = document.createElement('input');
    // use text + inputmode to prevent mobile spinner UI
    reps.type = 'text';
    reps.inputMode = 'numeric';
    reps.className = 'quick-reps-input';
    reps.placeholder = 'reps';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-drop-set-btn';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove Drop ${dropIndex}`);

    load.value = values.load || '';
    reps.value = values.reps || '';

    row.appendChild(label);
    row.appendChild(loadControl.wrapper);
    row.appendChild(reps);
    row.appendChild(remove);
    return row;
  }

  function createSetBlock(setNumber, existingValues) {
    const block = document.createElement('div');
    block.className = 'set-block';
    const row = document.createElement('div');
    row.className = 'set-row';
    const label = document.createElement('span');
    label.className = 'set-label';
    label.textContent = `Set ${setNumber}`;
    const addDrop = document.createElement('button');
    addDrop.type = 'button';
    addDrop.className = 'drop-set-btn';
    addDrop.textContent = '+↓';
    addDrop.setAttribute('aria-label', `Add drop set under set ${setNumber}`);
    const values = existingValues || {};
    const loadControl = createQuickLoadControl();
    const load = loadControl.input;
    const reps = document.createElement('input');
    // use text + inputmode to prevent mobile spinner UI
    reps.type = 'text';
    reps.inputMode = 'numeric';
    reps.className = 'quick-reps-input';
    reps.placeholder = 'reps';

    load.value = values.load || '';
    reps.value = values.reps || '';

    row.appendChild(label);
    row.appendChild(addDrop);
    row.appendChild(loadControl.wrapper);
    row.appendChild(reps);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'set-actions-row';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-set-btn';
    remove.textContent = '−';
    remove.setAttribute('aria-label', `Remove Set ${setNumber}`);
    remove.hidden = setNumber <= 1;
    const addSet = document.createElement('button');
    addSet.type = 'button';
    addSet.className = 'add-set-btn';
    addSet.textContent = '+';
    addSet.setAttribute('aria-label', 'Add set');
    actionsRow.appendChild(remove);
    actionsRow.appendChild(addSet);

    const drops = document.createElement('div');
    drops.className = 'drop-set-list';
    (existingValues && Array.isArray(existingValues.drops) ? existingValues.drops : []).forEach((drop, index) => {
      drops.appendChild(createDropSetRow(index + 1, drop));
    });

    block.appendChild(row);
    block.appendChild(actionsRow);
    block.appendChild(drops);
    return block;
  }

  function getQuickSetBlocksFromList(list) {
    if (!list) return [];
    return Array.from(list.querySelectorAll(':scope > .set-block'));
  }

  function renumberQuickSetBlocks(list) {
    if (!list) return;
    const blocks = getQuickSetBlocksFromList(list);
    blocks.forEach((block, index) => {
      const label = block.querySelector('.set-label');
      if (label) label.textContent = `Set ${index + 1}`;
      const removeButton = block.querySelector('.remove-set-btn');
      if (removeButton) {
        removeButton.hidden = index === 0;
        removeButton.setAttribute('aria-label', `Remove Set ${index + 1}`);
      }
    });
  }

  function addNormalSetToSection(section) {
    const list = section ? section.querySelector('.quick-set-list') : null;
    if (!list) return;
    const nextSetNumber = getQuickSetBlocksFromList(list).length + 1;
    list.appendChild(createSetBlock(nextSetNumber, {}));
    renumberQuickSetBlocks(list);
    updateQuickReadyCount();
  }

  function renderQuickSetRowsForList(list, setCount, existingValues) {
    if (!list) return;
    const existing = Array.isArray(existingValues) ? existingValues : [];
    list.innerHTML = '';
    const targetCount = Number.isFinite(setCount) ? Math.max(1, Number(setCount) || 1) : Math.max(1, existing.length || 1);
    for (let i = 0; i < targetCount; i += 1) {
      const block = createSetBlock(i + 1, existing[i]);
      list.appendChild(block);
    }
  }

  function renderQuickCardSetRows(card, setCount, existingDataByRole) {
    if (!card) return;
    const lists = card.querySelectorAll('.quick-set-list');
    lists.forEach((list) => {
      const role = list.closest('.quick-exercise-section') && list.closest('.quick-exercise-section').getAttribute('data-role') || 'primary';
      const existing = existingDataByRole && existingDataByRole[role] ? existingDataByRole[role] : [];
      renderQuickSetRowsForList(list, setCount, existing);
    });
  }

  function collectQuickSetDataFromList(list) {
    if (!list) return [];
    return getQuickSetBlocksFromList(list).map((block) => {
      const mainRow = block.querySelector(':scope > .set-row');
      const dropRows = Array.from(block.querySelectorAll(':scope > .drop-set-list > .drop-set-row'));
      return {
        load: mainRow ? mainRow.querySelector('.quick-load-input').value : '',
        reps: mainRow ? mainRow.querySelector('.quick-reps-input').value : '',
        drops: dropRows.map((row) => ({
          load: row.querySelector('.quick-load-input').value || '',
          reps: row.querySelector('.quick-reps-input').value || ''
        }))
      };
    });
  }

  function addDropSet(setRow) {
    const block = setRow ? setRow.closest('.set-block') : null;
    const dropList = block ? block.querySelector('.drop-set-list') : null;
    if (!dropList) return;
    const dropRows = Array.from(dropList.querySelectorAll('.drop-set-row'));
    const nextIndex = dropRows.length + 1;
    dropList.appendChild(createDropSetRow(nextIndex, {}));
  }

  function renumberDropSets(block) {
    const dropRows = block ? Array.from(block.querySelectorAll(':scope > .drop-set-list > .drop-set-row')) : [];
    dropRows.forEach((row, index) => {
      const label = row.querySelector('.drop-set-label');
      if (label) label.textContent = `Drop ${index + 1}`;
    });
  }

  function getQuickCardSetCount(card) {
    if (!card) return 1;
    const primaryList = card.querySelector('[data-role="primary"] .quick-set-list');
    return Math.max(1, getQuickSetBlocksFromList(primaryList).length);
  }

  function refreshQuickExerciseSelects() {
    const filtered = getFilteredExercises() || [];
    const container = els.quickEntryList;
    if (!container) return;
    const selects = container.querySelectorAll('.quick-exercise-select');
    selects.forEach((select) => {
      const selected = select.value;
      const options = ['<option value="">Select exercise</option>']
        .concat(filtered.map((exercise) => {
          const label = `${exercise.exercise} - ${exercise.category}`;
          return `<option value="${escapeAttr(exercise.exercise)}">${escapeHtml(label)}</option>`;
        }))
        .join('');
      select.innerHTML = options;
      if (selected) {
        const exists = Array.from(select.options).some((option) => option.value === selected);
        if (!exists) {
          const option = document.createElement('option');
          option.value = selected;
          option.textContent = `${selected} - outside current muscle filter`;
          select.appendChild(option);
        }
        select.value = selected;
      }
      const card = select.closest('.quick-card');
      refreshQuickComputedCellsForCard(card);
    });
  }

  function refreshQuickComputedCellsForCard(card) {
    if (!card) return;
    const tempoInput = card.querySelector('.quick-tempo-input');
    const primaryExercise = card.querySelector('[data-role="primary"] .quick-exercise-select');
    const primaryValue = primaryExercise ? primaryExercise.value : '';
    const pr = findPr(primaryValue);
    if (tempoInput && !tempoInput.value && pr && pr.prTempo) {
      tempoInput.value = String(pr.prTempo).toUpperCase();
    }
  }

  function updateQuickReadyCount() {
    const container = els.quickEntryList;
    if (!container) return;
    const exerciseCount = Array.from(container.querySelectorAll('.quick-exercise-select')).filter((s) => s.value).length;
    const setCount = Array.from(container.querySelectorAll('.quick-set-list .set-row')).length;
    const summary = document.getElementById('quickEntrySummary');
    if (summary) {
      if (exerciseCount === 0) {
        summary.textContent = 'No exercises yet.';
      } else {
        summary.textContent = `${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}, ${setCount} set${setCount === 1 ? '' : 's'} ready.`;
      }
    }
  }

  function handleQuickChange(event) {
    const target = event.target;
    const card = target.closest('.quick-card');
    if (!card) return;
    if (target.matches('.quick-exercise-select')) {
      refreshQuickComputedCellsForCard(card);
      updateQuickReadyCount();
    }
    debounceSaveQuickDraft();
  }

  function handleQuickInput(event) {
    const target = event.target;
    if (!target) return;
    if (target.matches('.quick-variation-input')) {
      const card = target.closest('.quick-card');
      refreshQuickComputedCellsForCard(card);
    }
    debounceSaveQuickDraft();
  }

  function handleQuickClick(event) {
    const dropButton = event.target.closest('.drop-set-btn');
    if (dropButton) {
      const setRow = dropButton.closest('.set-row');
      if (setRow) {
        addDropSet(setRow);
        debounceSaveQuickDraft();
      }
      return;
    }

    const removeDropButton = event.target.closest('.remove-drop-set-btn');
    if (removeDropButton) {
      const dropRow = removeDropButton.closest('.drop-set-row');
      const block = dropRow ? dropRow.closest('.set-block') : null;
      if (dropRow) {
        dropRow.remove();
        if (block) renumberDropSets(block);
        debounceSaveQuickDraft();
      }
      return;
    }

    const addSetButton = event.target.closest('.add-set-btn');
    if (addSetButton) {
      const section = addSetButton.closest('.quick-exercise-section');
      if (section) {
        addNormalSetToSection(section);
        debounceSaveQuickDraft();
      }
      return;
    }

    const removeSetButton = event.target.closest('.remove-set-btn');
    if (removeSetButton) {
      const block = removeSetButton.closest('.set-block');
      const list = block ? block.closest('.quick-set-list') : null;
      if (block && list) {
        block.remove();
        renumberQuickSetBlocks(list);
        updateQuickReadyCount();
        debounceSaveQuickDraft();
      }
      return;
    }

    const addButton = event.target.closest('.quick-add-superset-btn');
    if (addButton) {
      const card = addButton.closest('.quick-card');
      const supersetSection = card ? card.querySelector('.quick-superset-section') : null;
      if (card && supersetSection) {
        supersetSection.style.display = '';
        const primaryList = card.querySelector('[data-role="primary"] .quick-set-list');
        renderQuickCardSetRows(card, null, {
          primary: collectQuickSetDataFromList(primaryList),
          secondary: []
        });
        refreshQuickExerciseSelects();
        refreshQuickComputedCellsForCard(card);
        updateQuickReadyCount();
        debounceSaveQuickDraft();
      }
      return;
    }

    const removeSupersetButton = event.target.closest('.quick-remove-superset-btn');
    if (removeSupersetButton) {
      const card = removeSupersetButton.closest('.quick-card');
      const supersetSection = card ? card.querySelector('.quick-superset-section') : null;
      if (card && supersetSection) {
        supersetSection.style.display = 'none';
        const secondarySelect = supersetSection.querySelector('.quick-exercise-select');
        if (secondarySelect) secondarySelect.value = '';
        const secondaryList = supersetSection.querySelector('.quick-set-list');
        if (secondaryList) renderQuickSetRowsForList(secondaryList, 1, []);
        refreshQuickComputedCellsForCard(card);
        updateQuickReadyCount();
        debounceSaveQuickDraft();
      }
      return;
    }

    const removeButton = event.target.closest('.quick-remove-card-btn');
    if (removeButton) {
      const card = removeButton.closest('.quick-card');
      if (card) card.remove();
      updateQuickReadyCount();
      debounceSaveQuickDraft();
      return;
    }
  }

  function getDraftKey(sheetId, date) {
    const normalizedSheet = String(sheetId || 'no-sheet').trim();
    const normalizedDate = String(date || '').trim();
    return `${DRAFT_PREFIX}.${normalizedSheet}.${normalizedDate}`;
  }

  function getQuickDraftContext() {
    return {
      sheetId: state.sheetId || 'no-sheet',
      date: els.dateInput.value || ''
    };
  }

  function collectQuickDraft() {
    const cards = Array.from(els.quickEntryList.querySelectorAll('.quick-card'))
      .map((card) => {
        const exercise = card.querySelector('[data-role="primary"] .quick-exercise-select').value.trim();
        const sets = collectQuickSetDataFromList(card.querySelector('[data-role="primary"] .quick-set-list'));
        const tempo = card.querySelector('.quick-tempo-input').value.trim().toUpperCase();
        const variation = card.querySelector('.quick-variation-input').value.trim();
        const notes = card.querySelector('.quick-notes-input').value.trim();
        const supersetSection = card.querySelector('.quick-superset-section');
        const hasSuperset = supersetSection && supersetSection.style.display !== 'none';
        const supersetExercise = hasSuperset ? card.querySelector('.quick-superset-section .quick-exercise-select').value.trim() : '';
        const primaryList = card.querySelector('[data-role="primary"] .quick-set-list');
        const secondaryList = hasSuperset ? card.querySelector('.quick-superset-section .quick-set-list') : null;
        const setCount = sets.length || 1;
        const supersetSets = hasSuperset ? collectQuickSetDataFromList(secondaryList) : [];

        const hasContent = exercise || tempo || variation || notes || supersetExercise || sets.some((set) => set.load || set.reps || set.drops.some((drop) => drop.load || drop.reps)) || supersetSets.some((set) => set.load || set.reps || set.drops.some((drop) => drop.load || drop.reps));
        if (!hasContent) return null;

        return {
          exercise,
          setCount,
          sets,
          tempo,
          variation,
          notes,
          supersetExercise,
          supersetSets,
          hasSuperset
        };
      })
      .filter(Boolean);

    return {
      cards,
      activeMuscleGroups: Array.from(state.activeMuscleGroups),
      defaultLoadUnit: getWorkoutDefaultLoadUnit()
    };
  }

  function saveQuickDraft(context) {
    const draftContext = context || getQuickDraftContext();
    const key = getDraftKey(draftContext.sheetId, draftContext.date);
    const draft = collectQuickDraft();
    if (!draft.cards.length) {
      localStorage.removeItem(key);
      return false;
    }
    try {
      localStorage.setItem(key, JSON.stringify(draft));
      return true;
    } catch (error) {
      console.error('Could not save quick draft', error);
      return false;
    }
  }

  function restoreQuickDraft(context) {
    const draftContext = context || getQuickDraftContext();
    const key = getDraftKey(draftContext.sheetId, draftContext.date);
    let stored = null;

    try {
      stored = JSON.parse(localStorage.getItem(key) || 'null');
    } catch (error) {
      stored = null;
    }

    if (!stored || !Array.isArray(stored.cards) || !stored.cards.length) {
      return false;
    }

    if (Array.isArray(stored.activeMuscleGroups)) {
      state.activeMuscleGroups = new Set(stored.activeMuscleGroups.filter(Boolean));
      updateMuscleGroupFilterUI();
      refreshExerciseSelects();
    }

    if (stored.defaultLoadUnit) {
      setWorkoutDefaultLoadUnit(stored.defaultLoadUnit);
    }

    const container = els.quickEntryList;
    if (!container) return false;

    clearQuickCards();

    const controls = getQuickEntryControls();
    stored.cards.forEach((cardDraft) => {
      const card = createQuickExerciseCard();
      const tempoInput = card.querySelector('.quick-tempo-input');
      const variationInput = card.querySelector('.quick-variation-input');
      const notesInput = card.querySelector('.quick-notes-input');

      tempoInput.value = cardDraft.tempo || '';
      variationInput.value = cardDraft.variation || '';
      notesInput.value = cardDraft.notes || '';

      const shouldShowSuperset = Boolean(cardDraft.hasSuperset || cardDraft.supersetExercise || (Array.isArray(cardDraft.supersetSets) && cardDraft.supersetSets.some((set) => set.load || set.reps || set.drops.some((drop) => drop.load || drop.reps))));
      const supersetSection = card.querySelector('.quick-superset-section');
      const secondarySelect = supersetSection ? supersetSection.querySelector('.quick-exercise-select') : null;
      const shouldRestoreSupersetData = Boolean(cardDraft.supersetExercise || (Array.isArray(cardDraft.supersetSets) && cardDraft.supersetSets.length));
      if (supersetSection) {
        supersetSection.style.display = shouldShowSuperset || shouldRestoreSupersetData ? '' : 'none';
      }

      renderQuickCardSetRows(card, Number(cardDraft.setCount || (Array.isArray(cardDraft.sets) ? cardDraft.sets.length : 1) || 1), {
        primary: Array.isArray(cardDraft.sets) ? cardDraft.sets : [],
        secondary: Array.isArray(cardDraft.supersetSets) ? cardDraft.supersetSets : []
      });
      if (secondarySelect && cardDraft.supersetExercise) {
        secondarySelect.value = cardDraft.supersetExercise;
      }

      if (controls) {
        container.insertBefore(card, controls);
      } else {
        container.appendChild(card);
      }
    });

    refreshQuickExerciseSelects();

    Array.from(container.querySelectorAll('.quick-card')).forEach((card, index) => {
      const cardDraft = stored.cards[index] || {};
      const primarySelect = card.querySelector('[data-role="primary"] .quick-exercise-select');
      if (primarySelect && cardDraft.exercise) {
        if (primarySelect.value !== cardDraft.exercise) {
          const option = document.createElement('option');
          option.value = cardDraft.exercise;
          option.textContent = `${cardDraft.exercise} - restored`;
          primarySelect.appendChild(option);
          primarySelect.value = cardDraft.exercise;
        }
      }
      const secondarySelect = card.querySelector('.quick-superset-section .quick-exercise-select');
      if (secondarySelect && cardDraft.supersetExercise) {
        if (secondarySelect.value !== cardDraft.supersetExercise) {
          const option = document.createElement('option');
          option.value = cardDraft.supersetExercise;
          option.textContent = `${cardDraft.supersetExercise} - restored`;
          secondarySelect.appendChild(option);
          secondarySelect.value = cardDraft.supersetExercise;
        }
      }
      refreshQuickComputedCellsForCard(card);
    });

    updateQuickReadyCount();
    setSetupMessage('Draft restored', 'success');
    return true;
  }

  function clearQuickDraft(context) {
    const draftContext = context || getQuickDraftContext();
    const key = getDraftKey(draftContext.sheetId, draftContext.date);
    localStorage.removeItem(key);
  }

  function clearQuickCards() {
    Array.from(els.quickEntryList.querySelectorAll('.quick-card')).forEach((card) => card.remove());
    updateQuickReadyCount();
  }

  function handleDraftContextChange() {
    const previous = { ...quickDraftContext };
    const next = getQuickDraftContext();
    if (previous.date === next.date && previous.sheetId === next.sheetId) {
      return;
    }

    saveQuickDraft(previous);
    quickDraftContext = next;
    if (hasQuickDraftForContext(next)) {
      restoreQuickDraft(next);
      setSetupMessage('Draft restored instead of programmed workout.', 'success');
    } else {
      applyProgrammedWorkoutForCurrentDate({ force: false });
    }
  }

  function debounceSaveQuickDraft() {
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
    }
    draftSaveTimer = setTimeout(() => {
      if (saveQuickDraft()) {
        setSetupMessage('Draft saved', 'success');
      }
    }, 300);
  }

  function setAppName() {
    const name = CONFIG.APP_NAME || 'PT Workout Logger';
    document.title = name;
    const heading = document.querySelector('h1');
    if (heading) heading.textContent = name;
  }

  function initDate() {
    els.dateInput.value = toInputDate(new Date());
  }

  function restoreSheetId() {
    const fromQuery = new URLSearchParams(window.location.search).get('sheetId');
    const saved = fromQuery || localStorage.getItem(STORAGE_KEY) || '';
    if (saved) {
      state.sheetId = extractSheetId(saved);
      els.sheetIdInput.value = state.sheetId;
      localStorage.setItem(STORAGE_KEY, state.sheetId);
      setSetupMessage('Sheet ID saved in this browser.', 'success');
    }
  }

  function getMuscleGroups() {
    const groups = new Set();
    (Array.isArray(state.exercises) ? state.exercises : []).forEach((exercise) => {
      const category = String(exercise.category || '').trim();
      if (!category) return;
      groups.add(category);
    });
    return Array.from(groups).sort((a, b) => a.localeCompare(b));
  }

  function ensureActiveMuscleGroups() {
    const groups = getMuscleGroups();
    const chosen = new Set();

    if (state.activeMuscleGroups && state.activeMuscleGroups.size) {
      state.activeMuscleGroups.forEach((group) => {
        if (groups.includes(group)) chosen.add(group);
      });
    }

    if (!chosen.size && groups.length) {
      groups.forEach((group) => chosen.add(group));
    }

    state.activeMuscleGroups = chosen;
    updateMuscleGroupFilterUI();
  }

  function updateMuscleGroupFilterUI() {
    const groups = getMuscleGroups();
    const options = groups.map((group, index) => {
      const checked = state.activeMuscleGroups.has(group) ? 'checked' : '';
      return `
        <label for="muscleGroupOption${index}">
          <input id="muscleGroupOption${index}" type="checkbox" value="${escapeAttr(group)}" ${checked}>
          ${escapeHtml(group)}
        </label>
      `;
    }).join('');

    if (els.muscleGroupOptions) {
      els.muscleGroupOptions.innerHTML = options || '<p class="muted">No muscle groups available yet.</p>';
    }
    if (els.muscleGroupSummary) {
      const total = groups.length;
      const selected = state.activeMuscleGroups.size;
      els.muscleGroupSummary.textContent = selected === total ? `All muscle groups (${total})` : selected > 0 ? `${selected} selected` : 'No muscle groups selected';
    }
  }

  function handleMuscleGroupChange(event) {
    const target = event.target;
    if (!target || target.type !== 'checkbox') return;
    const group = String(target.value || '').trim();
    if (!group) return;
    if (target.checked) {
      state.activeMuscleGroups.add(group);
    } else {
      state.activeMuscleGroups.delete(group);
    }
    updateMuscleGroupFilterUI();
    refreshExerciseSelects();
    refreshQuickExerciseSelects();
    debounceSaveQuickDraft();
  }

  function setAllMuscleGroups(selectAll) {
    const groups = getMuscleGroups();
    state.activeMuscleGroups = new Set();
    if (selectAll) {
      groups.forEach((group) => state.activeMuscleGroups.add(group));
    }
    updateMuscleGroupFilterUI();
    refreshExerciseSelects();
    refreshQuickExerciseSelects();
    debounceSaveQuickDraft();
  }

  function attachEvents() {
    els.saveSheetIdBtn.addEventListener('click', saveSheetIdFromInput);
    els.authorizeBtn.addEventListener('click', requestAccessToken);
    els.loadSheetBtn.addEventListener('click', () => loadSheetData());
    els.forgetSheetBtn.addEventListener('click', forgetSheet);
    els.dateInput.addEventListener('change', handleDraftContextChange);
    if (els.muscleGroupOptions) {
      els.muscleGroupOptions.addEventListener('change', handleMuscleGroupChange);
    }
    if (els.selectAllMuscleGroupsBtn) {
      els.selectAllMuscleGroupsBtn.addEventListener('click', () => {
        setAllMuscleGroups(true);
      });
    }
    if (els.clearAllMuscleGroupsBtn) {
      els.clearAllMuscleGroupsBtn.addEventListener('click', () => {
        setAllMuscleGroups(false);
      });
    }
    if (els.loadUnitSelect) {
      els.loadUnitSelect.addEventListener('change', (event) => {
        setWorkoutDefaultLoadUnit(event.target.value);
        updateLoadPlaceholders();
        debounceSaveQuickDraft();
      });
    }
    els.addRowBtn.addEventListener('click', () => addRows(1));
    els.addFiveRowsBtn.addEventListener('click', () => addRows(5));
    els.clearRowsBtn.addEventListener('click', clearRows);
    els.saveRowsBtn.addEventListener('click', saveRows);
    els.mobileSaveBtn.addEventListener('click', saveRows);
    els.entryBody.addEventListener('input', handleEntryInput);
    els.entryBody.addEventListener('change', handleEntryChange);
    els.entryBody.addEventListener('focusin', handleRowFocus);
    els.entryBody.addEventListener('click', handleEntryClick);
    if (els.quickEntryList) {
      els.quickEntryList.addEventListener('change', handleQuickChange);
      els.quickEntryList.addEventListener('input', handleQuickInput);
      els.quickEntryList.addEventListener('click', handleQuickClick);
    }
  }

  async function loadSeedExercises() {
    try {
      const response = await fetch('data/exercise-seed.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Seed exercise file returned ${response.status}.`);
      state.seedExercises = await response.json();
      state.exercises = state.seedExercises;
      ensureActiveMuscleGroups();
      refreshExerciseSelects();
      refreshQuickExerciseSelects();
      setConnectionStatus('Demo mode', '');
      restoreQuickDraft();
    } catch (error) {
      console.warn(error);
      setSetupMessage('Seed exercises could not be loaded. Connect a Google Sheet to continue.', 'error');
    }
  }

  function waitForGoogleIdentity() {
    const clientId = String(CONFIG.GOOGLE_CLIENT_ID || '');
    if (!clientId || clientId.includes('PASTE_YOUR_GOOGLE_OAUTH')) {
      setConnectionStatus('Config needed', 'error');
      setSetupMessage('Add your Google OAuth web client ID to config.js before connecting Google.', 'error');
      return;
    }

    const check = () => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        state.tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: CONFIG.SHEETS_SCOPE || DEFAULT_SCOPE,
          callback: async (response) => {
            if (!response || response.error) {
              const message = response && response.error ? response.error : 'Authorization was cancelled.';
              setConnectionStatus('Auth error', 'error');
              setSetupMessage(message, 'error');
              return;
            }
            state.accessToken = response.access_token;
            setConnectionStatus('Google connected', 'connected');
            setSetupMessage('Google connected. Loading sheet data...', 'success');
            await loadSheetData();
          }
        });
      } else {
        window.setTimeout(check, 100);
      }
    };

    check();
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Service worker registration failed', error));
    }
  }

  function saveSheetIdFromInput() {
    const id = extractSheetId(els.sheetIdInput.value);
    if (!id) {
      setSetupMessage('Paste a Google Sheet URL or ID first.', 'error');
      return;
    }
    state.sheetId = id;
    els.sheetIdInput.value = id;
    localStorage.setItem(STORAGE_KEY, id);
    setSetupMessage('Sheet ID saved. Connect Google, then load the sheet.', 'success');
  }

  function forgetSheet() {
    localStorage.removeItem(STORAGE_KEY);
    state.sheetId = '';
    els.sheetIdInput.value = '';
    state.logRows = [];
    state.prRows = [];
    setSetupMessage('Forgot the saved Sheet ID on this browser.', 'success');
    setConnectionStatus(state.accessToken ? 'Google connected' : 'Demo mode', state.accessToken ? 'connected' : '');
    refreshAllComputedCells();
  }

  function requestAccessToken() {
    saveSheetIdFromInput();
    if (!state.tokenClient) {
      setSetupMessage('Google Identity Services is not ready yet, or the client ID is missing.', 'error');
      return;
    }
    state.tokenClient.requestAccessToken({ prompt: state.accessToken ? '' : 'consent' });
  }

  async function loadSheetData() {
    saveSheetIdFromInput();
    if (!state.sheetId) return;
    if (!state.accessToken) {
      setSetupMessage('Connect Google before loading a private Sheet.', 'error');
      return;
    }

    state.isLoading = true;
    setButtonsDisabled(true);
    setSetupMessage('Loading exercises, PRs, and log history from Google Sheets...', '');

    try {
      const ranges = getRanges();
      const params = new URLSearchParams();
      [ranges.exercises, ranges.prTracker, ranges.log].forEach((range) => params.append('ranges', range));
      params.set('majorDimension', 'ROWS');
      params.set('valueRenderOption', 'UNFORMATTED_VALUE');
      params.set('dateTimeRenderOption', 'FORMATTED_STRING');

      const data = await sheetsFetch(`/values:batchGet?${params.toString()}`);
      const valueRanges = data.valueRanges || [];
      const parsedExercises = parseExercises(valueRanges[0] ? valueRanges[0].values || [] : []);
      if (parsedExercises.length) {
        state.exercises = parsedExercises;
      } else if (state.seedExercises.length) {
        state.exercises = state.seedExercises;
        console.warn('Google Sheet returned 0 exercises. Falling back to seed exercises.');
      }
      state.prRows = parsePrRows(valueRanges[1] ? valueRanges[1].values || [] : []);
      state.logRows = parseLogRows(valueRanges[2] ? valueRanges[2].values || [] : []);

      ensureActiveMuscleGroups();
      refreshExerciseSelects();
      refreshQuickExerciseSelects();
      refreshAllComputedCells();
      setConnectionStatus('Sheet loaded', 'connected');
      const source = parsedExercises.length ? 'sheet' : 'seed fallback';
      setSetupMessage(`Loaded ${state.exercises.length} exercises from ${source}, ${state.prRows.length} PR rows, and ${state.logRows.length} log rows.`, 'success');
      await loadProgrammedWorkoutsFromSheet();
      restoreQuickDraft();
    } catch (error) {
      handleApiError(error, 'Could not load the Google Sheet.');
    } finally {
      state.isLoading = false;
      setButtonsDisabled(false);
    }
  }

  async function saveRows() {
    saveSheetIdFromInput();
    if (!state.sheetId) return;
    if (!state.accessToken) {
      setSetupMessage('Connect Google before saving.', 'error');
      return;
    }

    const collected = collectRowsForSave();
    if (!collected.rows.length) {
      setSetupMessage('Add at least one exercise row before saving.', 'error');
      return;
    }
    if (collected.errors.length) {
      setSetupMessage(collected.errors[0], 'error');
      return;
    }

    state.isSaving = true;
    setButtonsDisabled(true);
    setSetupMessage(`Saving ${collected.rows.length} set rows...`, '');

    try {
      const appendResponse = await appendLogRows(collected.rows);
      const appendedRange = appendResponse && appendResponse.updates && appendResponse.updates.updatedRange ? appendResponse.updates.updatedRange : null;
      const formattingSucceeded = await applySupersetFormatting(appendedRange, collected.formatBlocks);
      const prUpdateCount = await updatePrRows(collected.prCandidates);
      await loadSheetData();
      clearRows();
      clearQuickDraft();
      clearQuickCards();
      addRows(Number(CONFIG.DEFAULT_ROWS || 8));
      if (!formattingSucceeded) {
        setSetupMessage(`Saved ${collected.rows.length} rows.${prUpdateCount ? ` Updated ${prUpdateCount} PR row(s).` : ''} Draft cleared after save. Superset highlighting failed.`, 'warning');
      } else {
        setSetupMessage(`Saved ${collected.rows.length} rows.${prUpdateCount ? ` Updated ${prUpdateCount} PR row(s).` : ''} Draft cleared after save.`, 'success');
      }
    } catch (error) {
      handleApiError(error, 'Could not save rows to the Google Sheet.');
    } finally {
      state.isSaving = false;
      setButtonsDisabled(false);
      updateReadyCount();
    }
  }

  async function appendLogRows(rows) {
    const ranges = getRanges();
    const encodedRange = encodeURIComponent(ranges.appendLog || 'Log!B4:P');
    const query = new URLSearchParams({
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS'
    });
    return sheetsFetch(`/values/${encodedRange}:append?${query.toString()}`, {
      method: 'POST',
      body: JSON.stringify({ majorDimension: 'ROWS', values: rows })
    });
  }

  async function getLogSheetGridId() {
    try {
      const metadata = await sheetsFetch('/?fields=sheets.properties.sheetId,sheets.properties.title');
      const sheets = Array.isArray(metadata && metadata.sheets) ? metadata.sheets : [];
      const logSheet = sheets.find((sheet) => {
        const title = String(sheet && sheet.properties && sheet.properties.title || '').trim();
        return normalize(title) === 'log';
      });
      return logSheet && logSheet.properties ? logSheet.properties.sheetId : null;
    } catch (error) {
      console.warn('Could not resolve Log sheet grid ID.', error);
      return null;
    }
  }

  function parseAppendedRange(range) {
    const text = String(range || '').trim();
    const match = text.match(/^[^!]+!([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    if (!match) return null;
    return {
      startRow: Number(match[2]),
      endRow: Number(match[4])
    };
  }

  async function applySupersetFormatting(appendedRange, formatBlocks) {
    if (!Array.isArray(formatBlocks) || !formatBlocks.length || !appendedRange) return true;
    const logSheetId = await getLogSheetGridId();
    const parsedRange = parseAppendedRange(appendedRange);
    if (!logSheetId || !parsedRange || parsedRange.startRow > parsedRange.endRow) return false;

    const colors = [
      { red: 0.82, green: 0.9, blue: 0.99, alpha: 1 },
      { red: 0.84, green: 0.97, blue: 0.85, alpha: 1 },
      { red: 0.99, green: 0.97, blue: 0.82, alpha: 1 }
    ];

    const requests = formatBlocks.map((block, index) => {
      if (!block || !block.rowCount) return null;
      const startRowIndex = parsedRange.startRow + block.startOffset - 1;
      const endRowIndex = startRowIndex + block.rowCount;
      if (startRowIndex < 0 || endRowIndex <= startRowIndex) return null;
      return {
        repeatCell: {
          range: {
            sheetId: logSheetId,
            startRowIndex,
            endRowIndex,
            startColumnIndex: 1,
            endColumnIndex: 16
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: colors[index % colors.length]
            }
          },
          fields: 'userEnteredFormat.backgroundColor'
        }
      };
    }).filter(Boolean);

    if (!requests.length) return true;
    await sheetsFetch('/:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests })
    });
    return true;
  }

  async function updatePrRows(prCandidates) {
    if (!prCandidates.length) return 0;
    const byExercise = new Map();

    prCandidates.forEach((candidate) => {
      const key = normalize(candidate.exercise);
      const existing = byExercise.get(key);
      if (!existing || candidate.score > existing.score) byExercise.set(key, candidate);
    });

    const data = [];
    byExercise.forEach((candidate) => {
      const pr = findPr(candidate.exercise);
      if (!pr || !pr.rowNumber) return;
      data.push({
        range: `PR_Tracker!D${pr.rowNumber}:G${pr.rowNumber}`,
        values: [[candidate.load, candidate.reps, candidate.date, candidate.tempo]]
      });
    });

    if (!data.length) return 0;

    await sheetsFetch('/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data })
    });

    return data.length;
  }

  function collectRowsForSave() {
    const date = els.dateInput.value;
    const bodyweight = valueOrBlank(els.bodyweightInput.value);
    const rows = [];
    const prCandidates = [];
    const errors = [];
    const activeExerciseNames = [];
    const formatBlocks = [];

    if (!date) errors.push('Choose a date first.');

    // First pass: collect all active exercise names from desktop rows
    Array.from(els.entryBody.querySelectorAll('tr')).forEach((tr) => {
      const exercise = tr.querySelector('.exercise-select').value.trim();
      if (exercise) {
        activeExerciseNames.push(exercise);
      }
    });

    // Collect all active exercise names from quick cards
    if (els.quickEntryList) {
      Array.from(els.quickEntryList.querySelectorAll('.quick-card')).forEach((card) => {
        const primaryExercise = card.querySelector('[data-role="primary"] .quick-exercise-select').value.trim();
        const secondaryExercise = card.querySelector('.quick-superset-section .quick-exercise-select').value.trim();
        const primaryRows = Array.from(card.querySelectorAll('[data-role="primary"] .set-row'));
        const secondaryRows = Array.from(card.querySelectorAll('.quick-superset-section .set-row'));
        const hasPrimarySetValue = primaryRows.some((row) => {
          const loadRaw = String(row.querySelector('.quick-load-input').value || '').trim();
          const repsRaw = String(row.querySelector('.quick-reps-input').value || '').trim();
          return loadRaw || repsRaw;
        });
        const hasSecondarySetValue = secondaryRows.some((row) => {
          const loadRaw = String(row.querySelector('.quick-load-input').value || '').trim();
          const repsRaw = String(row.querySelector('.quick-reps-input').value || '').trim();
          return loadRaw || repsRaw;
        });
        if (hasPrimarySetValue && primaryExercise) activeExerciseNames.push(primaryExercise);
        if (hasSecondarySetValue && secondaryExercise) activeExerciseNames.push(secondaryExercise);
      });
    }

    // Calculate workout focus label once
    const workoutSessionLabel = getWorkoutFocusLabel(activeExerciseNames);

    // Second pass: process desktop rows
    Array.from(els.entryBody.querySelectorAll('tr')).forEach((tr, index) => {
      const exercise = tr.querySelector('.exercise-select').value.trim();
      if (!exercise) return;

      const variation = tr.querySelector('.variation-input').value.trim();
      const setNumber = valueOrBlank(tr.querySelector('.set-input').value);
      const loadRaw = tr.querySelector('.load-input').value.trim();
      const loadUnit = getRowLoadUnit(tr.querySelector('.load-unit-select'));
      const repsRaw = tr.querySelector('.reps-input').value.trim();
      const tempo = tr.querySelector('.tempo-input').value.trim().toUpperCase();
      const rpe = valueOrBlank(tr.querySelector('.rpe-input').value);
      const rest = valueOrBlank(tr.querySelector('.rest-input').value);
      const prFlag = tr.querySelector('.pr-select').value;
      const notes = tr.querySelector('.notes-input').value.trim();

      if (!setNumber) errors.push(`Row ${index + 1}: enter a set number.`);
      if (!loadRaw) errors.push(`Row ${index + 1}: enter load. Use BW or 0 for bodyweight if needed.`);
      if (!repsRaw) errors.push(`Row ${index + 1}: enter reps.`);

      const load = convertLoadToKg(loadRaw, loadUnit);
      const reps = coerceCellValue(repsRaw);
      const finalTempo = tempo;
      const numericLoad = typeof load === 'number' ? load : null;
      const numericReps = strictNumber(repsRaw);
      const volume = numericLoad !== null && numericReps !== null ? round(numericLoad * numericReps, 2) : '';
      const e1rm = numericLoad !== null && numericReps !== null ? round(numericLoad * (1 + numericReps / 30), 2) : '';
      const notesWithLoad = formatEnteredLoadNote(loadRaw, loadUnit);

      rows.push([
        date,
        workoutSessionLabel,
        exercise,
        variation,
        setNumber,
        load,
        reps,
        finalTempo,
        rpe,
        rest,
        bodyweight,
        volume,
        e1rm,
        prFlag,
        [notes, notesWithLoad].filter(Boolean).join(' | ')
      ]);

      if (prFlag === 'Y' && numericLoad !== null && numericReps !== null) {
        prCandidates.push({
          exercise,
          load: numericLoad,
          reps: numericReps,
          date,
          tempo: finalTempo,
          score: e1rm || numericLoad
        });
      }
    });

    // Third pass: process quick cards
    if (els.quickEntryList) {
      Array.from(els.quickEntryList.querySelectorAll('.quick-card')).forEach((card, cardIndex) => {
        const variation = card.querySelector('.quick-variation-input').value.trim();
        const tempoValue = card.querySelector('.quick-tempo-input').value.trim().toUpperCase();
        const notesValue = card.querySelector('.quick-notes-input').value.trim();
        const finalTempo = tempoValue;
        const finalNotes = notesValue;

        const primarySection = card.querySelector('[data-role="primary"]');
        const primaryExercise = primarySection ? primarySection.querySelector('.quick-exercise-select').value.trim() : '';
            const primarySetRows = primarySection ? collectQuickSetDataFromList(primarySection.querySelector('.quick-set-list')) : [];
        const secondarySection = card.querySelector('.quick-superset-section');
        const secondaryExercise = secondarySection && secondarySection.style.display !== 'none' ? secondarySection.querySelector('.quick-exercise-select').value.trim() : '';
        const secondarySetRows = secondarySection && secondarySection.style.display !== 'none' ? collectQuickSetDataFromList(secondarySection.querySelector('.quick-set-list')) : [];
        const hasSupersetExercise = Boolean(secondaryExercise && secondarySection && secondarySection.style.display !== 'none');
        const primaryHasAnySetValue = primarySetRows.some((set) => set.load || set.reps || set.drops.some((drop) => drop.load || drop.reps));
        const secondaryHasAnySetValue = secondarySetRows.some((set) => set.load || set.reps || set.drops.some((drop) => drop.load || drop.reps));
        const hasAnySetValue = primaryHasAnySetValue || secondaryHasAnySetValue;
        if (!hasAnySetValue) return;
        if (!primaryExercise) {
          errors.push(`Quick entry ${cardIndex + 1}: choose an exercise for active sets.`);
          return;
        }

        const exerciseSections = [];
        if (primaryExercise) exerciseSections.push({ exercise: primaryExercise, sets: primarySetRows });
        if (secondaryExercise && secondarySection && secondarySection.style.display !== 'none') exerciseSections.push({ exercise: secondaryExercise, sets: secondarySetRows });

        const blockStartOffset = rows.length;
        const maxSets = Math.max(primarySetRows.length, secondarySetRows.length);
        for (let setIndex = 0; setIndex < maxSets; setIndex += 1) {
          exerciseSections.forEach((section) => {
            const setData = section.sets[setIndex];
            if (!setData) return;
            const loadRaw = String(setData.load || '').trim();
            const loadUnit = getWorkoutLoadUnit();
            const repsRaw = String(setData.reps || '').trim();
            if (!loadRaw && !repsRaw) return;
            if (!loadRaw) errors.push(`Quick entry ${cardIndex + 1}, set ${setIndex + 1}: enter load.`);
            if (!repsRaw) errors.push(`Quick entry ${cardIndex + 1}, set ${setIndex + 1}: enter reps.`);

            const load = convertLoadToKg(loadRaw, loadUnit);
            const reps = coerceCellValue(repsRaw);
            const numericLoad = typeof load === 'number' ? load : null;
            const numericReps = strictNumber(repsRaw);
            const volume = numericLoad !== null && numericReps !== null ? round(numericLoad * numericReps, 2) : '';
            const e1rm = numericLoad !== null && numericReps !== null ? round(numericLoad * (1 + numericReps / 30), 2) : '';
            const notesWithLoad = formatEnteredLoadNote(loadRaw, loadUnit);

            rows.push([
              date,
              workoutSessionLabel,
              section.exercise,
              variation,
              `${setIndex + 1}`,
              load,
              reps,
              finalTempo,
              '',
              '',
              bodyweight,
              volume,
              e1rm,
              '',
              [finalNotes, notesWithLoad].filter(Boolean).join(' | ')
            ]);

            (setData.drops || []).forEach((drop, dropIndex) => {
              const dropLoadRaw = String(drop.load || '').trim();
              const dropRepsRaw = String(drop.reps || '').trim();
              if (!dropLoadRaw && !dropRepsRaw) return;
              if (!dropLoadRaw || !dropRepsRaw) {
                errors.push(`Quick entry ${cardIndex + 1}, set ${setIndex + 1} drop ${dropIndex + 1}: enter both load and reps.`);
                return;
              }
              const dropLoadUnit = getWorkoutLoadUnit();
              const dropLoad = convertLoadToKg(dropLoadRaw, dropLoadUnit);
              const dropReps = coerceCellValue(dropRepsRaw);
              const dropNumericLoad = typeof dropLoad === 'number' ? dropLoad : null;
              const dropNumericReps = strictNumber(dropRepsRaw);
              const dropVolume = dropNumericLoad !== null && dropNumericReps !== null ? round(dropNumericLoad * dropNumericReps, 2) : '';
              const dropE1rm = dropNumericLoad !== null && dropNumericReps !== null ? round(dropNumericLoad * (1 + dropNumericReps / 30), 2) : '';
              const dropNotesWithLoad = formatEnteredLoadNote(dropLoadRaw, dropLoadUnit);
              rows.push([
                date,
                workoutSessionLabel,
                section.exercise,
                variation,
                `${setIndex + 1}-D${dropIndex + 1}`,
                dropLoad,
                dropReps,
                finalTempo,
                '',
                '',
                bodyweight,
                dropVolume,
                dropE1rm,
                '',
                [finalNotes, dropNotesWithLoad].filter(Boolean).join(' | ')
              ]);
            });
          });
        }
        if (hasSupersetExercise) {
          formatBlocks.push({
            startOffset: blockStartOffset,
            rowCount: rows.length - blockStartOffset,
            type: 'superset'
          });
        }
      });
    }

    return { rows, prCandidates, errors, formatBlocks };
  }

  function handleEntryInput(event) {
    const target = event.target;
    if (!target.closest('tbody')) return;
    if (target.matches('.load-input, .reps-input, .exercise-select, .variation-input, .pr-select')) {
      updateReadyCount();
    }
    if (target.matches('.variation-input')) {
      refreshComputedCellsForRow(target.closest('tr'));
      autoSetNumber(target.closest('tr'));
    }
  }

  function handleEntryChange(event) {
    const target = event.target;
    const tr = target.closest('tr');
    if (!tr) return;

    if (target.matches('.exercise-select')) {
      applyExerciseDefaults(tr);
      autoSetNumber(tr);
      refreshComputedCellsForRow(tr);
      renderExerciseMeta(getExercise(target.value));
    }

    if (target.matches('.variation-input')) {
      refreshComputedCellsForRow(tr);
      autoSetNumber(tr);
    }

    if (target.matches('.load-unit-select')) {
      target.dataset.unit = normalizeLoadUnit(target.value);
    }

    updateReadyCount();
  }

  function handleRowFocus(event) {
    const tr = event.target.closest('tr');
    if (!tr) return;
    const exercise = tr.querySelector('.exercise-select').value;
    renderExerciseMeta(getExercise(exercise));
  }

  function handleEntryClick(event) {
    const btn = event.target.closest('.remove-row-btn');
    if (!btn) return;
    const tr = btn.closest('tr');
    tr.remove();
    updateReadyCount();
  }

  function addRows(count) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i += 1) {
      fragment.appendChild(createEntryRow());
    }
    els.entryBody.appendChild(fragment);
    refreshExerciseSelects();
    updateReadyCount();
  }

  function clearRows() {
    els.entryBody.innerHTML = '';
    els.exerciseMeta.innerHTML = '<p>Select an exercise row to see primary muscle, secondary muscle, movement pattern, equipment, limb type, difficulty, base fatigue score, and variation lineage.</p>';
    updateReadyCount();
  }

  function createEntryRow() {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="exercise-cell">
        <select class="exercise-select" aria-label="Exercise"></select>
        <span class="meta-line"></span>
      </td>
      <td><input class="variation-input" type="text" placeholder="Optional" aria-label="Variation"></td>
      <td><input class="set-input compact-input" type="number" min="1" step="1" aria-label="Set"></td>
      <td><div class="load-control"><input class="load-input compact-input" type="number" min="0" step="0.1" inputmode="decimal" placeholder="kg" aria-label="Load kg"><select class="load-unit-select compact-select" aria-label="Load unit"><option value="kg">kg</option><option value="lb">lb</option></select></div></td>
      <td><input class="reps-input compact-input" inputmode="decimal" placeholder="reps" aria-label="Reps"></td>
      <td><input class="tempo-input compact-input" type="text" placeholder="31X0" aria-label="Tempo"></td>
      <td><input class="rpe-input compact-input" type="number" min="1" max="10" step="0.5" placeholder="RPE" aria-label="RPE"></td>
      <td><input class="rest-input compact-input" type="number" min="0" step="5" placeholder="sec" aria-label="Rest seconds"></td>
      <td>
        <select class="pr-select" aria-label="PR flag">
          <option value=""></option>
          <option value="Y">Y</option>
        </select>
      </td>
      <td><input class="notes-input" type="text" placeholder="Cues or notes" aria-label="Notes"></td>
      <td><button class="remove-row-btn" type="button" aria-label="Remove row">X</button></td>
    `;
    const loadUnitSelect = tr.querySelector('.load-unit-select');
    if (loadUnitSelect) {
      loadUnitSelect.value = getWorkoutDefaultLoadUnit();
    }
    return tr;
  }

  function refreshExerciseSelects() {
    const filtered = getFilteredExercises();
    const selects = els.entryBody.querySelectorAll('.exercise-select');
    selects.forEach((select) => {
      const selected = select.value;
      const options = ['<option value=""></option>']
        .concat(filtered.map((exercise) => {
          const label = `${exercise.exercise} - ${exercise.category}`;
          return `<option value="${escapeAttr(exercise.exercise)}">${escapeHtml(label)}</option>`;
        }))
        .join('');
      select.innerHTML = options;
      if (selected) {
        const exists = Array.from(select.options).some((option) => option.value === selected);
        if (!exists) {
          const option = document.createElement('option');
          option.value = selected;
          option.textContent = `${selected} - outside current muscle filter`;
          select.appendChild(option);
        }
        select.value = selected;
      }
      updateRowMetaLine(select.closest('tr'));
    });
  }

  function refreshAllComputedCells() {
    els.entryBody.querySelectorAll('tr').forEach((tr) => refreshComputedCellsForRow(tr));
  }

  function refreshComputedCellsForRow(tr) {
    if (!tr) return;
    updateRowMetaLine(tr);
  }

  function updateRowMetaLine(tr) {
    if (!tr) return;
    const exercise = getExercise(tr.querySelector('.exercise-select').value);
    const line = tr.querySelector('.meta-line');
    if (!line) return;
    if (!exercise) {
      line.textContent = '';
      return;
    }
    line.textContent = `${exercise.primaryMuscle || exercise.category} | ${exercise.movementPattern || 'Movement not set'} | Fatigue ${exercise.baseFatigueScore || '-'}`;
  }

  function applyExerciseDefaults(tr) {
    const exerciseName = tr.querySelector('.exercise-select').value;
    const pr = findPr(exerciseName);
    const tempoInput = tr.querySelector('.tempo-input');
    if (!tempoInput.value && pr && pr.prTempo) tempoInput.value = String(pr.prTempo).toUpperCase();
  }

  function autoSetNumber(tr) {
    if (!tr) return;
    const setInput = tr.querySelector('.set-input');
    if (setInput.value) return;
    const exercise = normalize(tr.querySelector('.exercise-select').value);
    const variation = normalize(tr.querySelector('.variation-input').value);
    if (!exercise) return;

    let count = 0;
    const rows = Array.from(els.entryBody.querySelectorAll('tr'));
    for (const row of rows) {
      if (row === tr) break;
      const rowExercise = normalize(row.querySelector('.exercise-select').value);
      const rowVariation = normalize(row.querySelector('.variation-input').value);
      if (rowExercise === exercise && rowVariation === variation) count += 1;
    }
    setInput.value = count + 1;
  }

  function getFilteredExercises() {
    if (!state.activeMuscleGroups || !state.activeMuscleGroups.size) return [];
    return (state.exercises || []).filter((exercise) => state.activeMuscleGroups.has(String(exercise.category || '').trim()));
  }

  function renderExerciseMeta(exercise) {
    if (!exercise) {
      els.exerciseMeta.innerHTML = '<p>Select an exercise row to see primary muscle, secondary muscle, movement pattern, equipment, limb type, difficulty, base fatigue score, and variation lineage.</p>';
      return;
    }

    const items = [
      ['Exercise', exercise.exercise],
      ['Category', exercise.category],
      ['Primary muscle', exercise.primaryMuscle],
      ['Secondary muscle', exercise.secondaryMuscle],
      ['Movement pattern', exercise.movementPattern],
      ['Equipment', exercise.equipment],
      ['Limb type', exercise.limbType],
      ['Difficulty', exercise.difficulty],
      ['Base fatigue', exercise.baseFatigueScore],
      ['Variation of', exercise.variationOf || 'Base movement']
    ];

    els.exerciseMeta.innerHTML = items
      .map(([label, value]) => `<div class="meta-card"><strong>${escapeHtml(label)}</strong>${escapeHtml(value || '-')}</div>`)
      .join('');
  }

  function parseExercises(values) {
    return values
      .map((row) => ({
        exercise: safeString(row[0]),
        category: safeString(row[1]),
        movementPattern: safeString(row[2]),
        primaryMuscle: safeString(row[3]),
        secondaryMuscle: safeString(row[4]),
        equipment: safeString(row[5]),
        limbType: safeString(row[6]),
        difficulty: row[7] || '',
        baseFatigueScore: row[8] || '',
        variationOf: safeString(row[9]).replace(/^[-]+$/, '')
      }))
      .filter((row) => row.exercise && row.category)
      .filter((row) => normalize(row.exercise) !== 'exercise')
      .filter((row) => !row.exercise.includes('>') && !row.exercise.includes('▸'));
  }

  function parsePrRows(values) {
    return values
      .map((row, index) => ({
        rowNumber: 5 + index,
        exercise: safeString(row[0]),
        category: safeString(row[1]),
        prLoad: row[2] || '',
        prReps: row[3] || '',
        prDate: row[4] || '',
        prTempo: row[5] || '',
        targetLoad: row[6] || '',
        targetReps: row[7] || '',
        lastSeenLoad: row[8] || '',
        lastSeenReps: row[9] || '',
        notes: safeString(row[10])
      }))
      .filter((row) => row.exercise)
      .filter((row) => normalize(row.exercise) !== 'exercise');
  }

  function parseLogRows(values) {
    return values
      .map((row, index) => ({
        rowNumber: 5 + index,
        date: row[0] || '',
        session: safeString(row[1]),
        exercise: safeString(row[2]),
        variation: safeString(row[3]),
        setNumber: row[4] || '',
        load: row[5] || '',
        reps: row[6] || '',
        tempo: row[7] || '',
        rpe: row[8] || '',
        rest: row[9] || '',
        bodyweight: row[10] || '',
        volume: row[11] || '',
        e1rm: row[12] || '',
        pr: row[13] || '',
        notes: safeString(row[14]),
        sourceIndex: index
      }))
      .filter((row) => row.exercise);
  }

  function findLastUsed(exerciseName, variation) {
    if (!exerciseName) return '';
    const exerciseKey = normalize(exerciseName);
    const variationKey = normalize(variation);
    const candidates = state.logRows.filter((row) => {
      if (normalize(row.exercise) !== exerciseKey) return false;
      if (variationKey) return normalize(row.variation) === variationKey;
      return true;
    });

    if (!candidates.length) return '';
    candidates.sort(compareLogRowsNewestFirst);
    const latest = candidates[0];
    return `${formatLoad(latest.load)} x ${formatReps(latest.reps)}`;
  }

  function getTarget(exerciseName) {
    if (!exerciseName) return '';
    const pr = findPr(exerciseName);
    if (!pr) return '';
    const load = pr.targetLoad || computeTargetLoad(pr.prLoad);
    const reps = pr.targetReps || computeTargetReps(pr.prReps);
    if (!load && !reps) return '';
    return `${formatLoad(load)} x ${formatReps(reps)}`;
  }

  function findPr(exerciseName) {
    const key = normalize(exerciseName);
    return state.prRows.find((row) => normalize(row.exercise) === key) || null;
  }

  function getExercise(exerciseName) {
    const key = normalize(exerciseName);
    return state.exercises.find((row) => normalize(row.exercise) === key) || null;
  }

  function getExerciseFocusLabel(exerciseName) {
    const exercise = getExercise(exerciseName);
    const category = normalize(exercise ? exercise.category : '');
    const primaryMuscle = safeString(exercise ? exercise.primaryMuscle : '');
    const labelMap = {
      'back - vertical pull': 'Back',
      'back - horizontal pull': 'Back',
      'chest': 'Chest',
      'quads': 'Legs',
      'hamstrings': 'Legs',
      'glutes & hips': 'Legs',
      'calves': 'Legs',
      'shoulders - anterior': 'Ant Delt',
      'shoulders - lateral': 'Lat Delt',
      'shoulders - posterior': 'Rear Delt',
      'biceps': 'Biceps',
      'triceps': 'Triceps',
      'forearms & grip': 'Forearms',
      'core & abs': 'Core'
    };
    if (labelMap[category]) return labelMap[category];
    if (primaryMuscle) return primaryMuscle;
    return 'General';
  }

  function getWorkoutFocusLabel(exerciseNames) {
    // Define the muscle group order
    const muscleOrder = ['Legs', 'Chest', 'Back', 'Ant Delt', 'Lat Delt', 'Rear Delt', 'Biceps', 'Triceps', 'Forearms', 'Core', 'General'];
    
    if (!exerciseNames || exerciseNames.length === 0) return 'General';
    
    // Map each exercise to its focus label
    const labels = exerciseNames.map(name => getExerciseFocusLabel(name));
    
    // Get unique labels
    const uniqueLabels = Array.from(new Set(labels));
    
    // Remove 'General' if there are other labels
    const filteredLabels = uniqueLabels.filter(label => label !== 'General' || uniqueLabels.length === 1);
    
    // Sort by the predefined order
    const sortedLabels = filteredLabels.sort((a, b) => {
      const indexA = muscleOrder.indexOf(a);
      const indexB = muscleOrder.indexOf(b);
      return indexA - indexB;
    });
    
    // Join with ' + '
    return sortedLabels.join(' + ');
  }

  function compareLogRowsNewestFirst(a, b) {
    const dateA = parseComparableDate(a.date);
    const dateB = parseComparableDate(b.date);
    if (dateA !== dateB) return dateB - dateA;
    return b.sourceIndex - a.sourceIndex;
  }

  function parseComparableDate(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function computeTargetLoad(prLoad) {
    const numeric = strictNumber(prLoad);
    if (numeric === null) return prLoad ? `${prLoad} +5%` : '';
    return roundToIncrement(numeric * 1.05, 1.25);
  }

  function computeTargetReps(prReps) {
    const numeric = strictNumber(prReps);
    if (numeric === null) return '';
    return numeric + 1;
  }

  function roundToIncrement(value, increment) {
    return round(Math.round(value / increment) * increment, 2);
  }

  function formatLoad(value) {
    if (value === null || value === undefined || value === '') return '-';
    if (typeof value === 'number') return `${formatNumber(value)} kg`;
    const text = String(value).trim();
    if (!text) return '-';
    if (/kg|bw|body/i.test(text)) return text;
    const numeric = strictNumber(text);
    if (numeric !== null) return `${formatNumber(numeric)} kg`;
    return text;
  }

  function formatReps(value) {
    if (value === null || value === undefined || value === '') return '- reps';
    let text = String(value).trim();
    if (!text) return '- reps';
    text = text.replace(/\s*,\s*/g, ', ');
    if (/,/.test(text)) {
      return /rep/i.test(text) ? text : `${text} reps`;
    }
    return /rep/i.test(text) ? text : `${formatNumber(value)} reps`;
  }

  function formatNumber(value) {
    const numeric = typeof value === 'number' ? value : strictNumber(value);
    if (numeric === null) return String(value);
    return Number.isInteger(numeric) ? String(numeric) : String(round(numeric, 2)).replace(/\.00$/, '');
  }

  function strictNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value === null || value === undefined) return null;
    const text = String(value).trim().replace(/,/g, '').replace(/\s+/g, '');
    const match = text.match(/^(-?\d+(?:\.\d+)?)(?:kg|lb)?$/i);
    if (!match) return null;
    const numeric = Number(match[1]);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function coerceCellValue(value) {
    const numeric = strictNumber(value);
    return numeric === null ? value : numeric;
  }

  function valueOrBlank(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const numeric = strictNumber(trimmed);
    return numeric === null ? trimmed : numeric;
  }

  function updateReadyCount() {
    const count = Array.from(els.entryBody.querySelectorAll('.exercise-select')).filter((select) => select.value).length;
    if (count === 0) {
      els.entrySummary.textContent = 'Ready to log.';
    } else {
      els.entrySummary.textContent = `${count} row${count === 1 ? '' : 's'} ready.`;
    }
  }

  function getRanges() {
    return Object.assign({
      exercises: 'Exercise_Library!B4:K300',
      prTracker: 'PR_Tracker!B5:L300',
      log: 'Log!B5:P5000',
      appendLog: 'Log!B4:P',
      programmedWorkouts: 'Programmed_Workouts!A2:N1000'
    }, CONFIG.RANGES || {});
  }

  async function sheetsFetch(path, options = {}) {
    if (!state.accessToken) throw new Error('Missing Google access token.');
    const response = await fetch(`${SHEETS_BASE}/${encodeURIComponent(state.sheetId)}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${state.accessToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });

    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = json && json.error && json.error.message ? json.error.message : `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.details = json;
      throw error;
    }
    return json;
  }

  function handleApiError(error, prefix) {
    console.error(error);
    let message = `${prefix} ${error.message || error}`;
    if (error.status === 401) message = 'Google access expired. Tap Connect Google again.';
    if (error.status === 403) message = 'Access denied. Make sure the signed-in Google account can edit this client Sheet and that the Sheets API is enabled.';
    if (/Unable to parse range|Requested entity was not found/i.test(String(error.message))) {
      message = 'Check the Sheet ID and make sure the workbook has Exercise_Library, PR_Tracker, and Log tabs with the expected ranges.';
    }
    setConnectionStatus('Sheet error', 'error');
    setSetupMessage(message, 'error');
  }

  function setButtonsDisabled(disabled) {
    [
      els.saveSheetIdBtn,
      els.authorizeBtn,
      els.loadSheetBtn,
      els.forgetSheetBtn,
      els.addRowBtn,
      els.addFiveRowsBtn,
      els.clearRowsBtn,
      els.saveRowsBtn
    ].forEach((button) => {
      if (button) button.disabled = disabled;
    });
  }

  function setConnectionStatus(text, className) {
    els.connectionStatus.textContent = text;
    els.connectionStatus.className = 'status-pill';
    if (className) els.connectionStatus.classList.add(className);
  }

  function setSetupMessage(text, kind) {
    els.setupMessage.textContent = text || '';
    els.setupMessage.className = 'message';
    if (kind) els.setupMessage.classList.add(kind);
  }

  function extractSheetId(input) {
    const text = String(input || '').trim();
    if (!text) return '';
    const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match) return match[1];
    return text.replace(/[?#].*$/, '').trim();
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function safeString(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
  }

  function toInputDate(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }
})();

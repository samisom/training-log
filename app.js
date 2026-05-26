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
    selectedExercise: null,
    isSaving: false,
    isLoading: false
  };

  const els = {};

  document.addEventListener('DOMContentLoaded', boot);

  let quickDraftContext = { date: '', session: '' };
  let draftSaveTimer = null;

  function boot() {
    cacheElements();
    setAppName();
    initDate();
    restoreSheetId();
    renderSessionOptions();
    attachEvents();
    quickDraftContext = getQuickDraftContext();
    ensureQuickUI();
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
      'sessionSelect',
      'sessionHelp',
      'bodyweightInput',
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
      const summary = document.createElement('div');
      summary.id = 'quickEntrySummary';
      summary.style.marginLeft = '8px';
      footer.appendChild(btn);
      footer.appendChild(summary);
      container.appendChild(footer);
    }
  }

  function getQuickEntryControls() {
    const container = els.quickEntryList;
    return container ? container.querySelector('.quick-entry-footer') : null;
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
        <label>Exercise
          <select class="quick-exercise-select"></select>
        </label>
        <div class="readouts">
          <div class="quick-readout-item">
            <span>Last:</span>
            <div class="quick-last-readout">-</div>
          </div>
          <div class="quick-readout-item">
            <span>Target:</span>
            <div class="quick-target-readout">-</div>
          </div>
          <div style="margin-left:auto"><button type="button" class="remove-card quick-remove-card-btn">Remove</button></div>
        </div>
        <div class="readout-helper">Last = most recent logged set. Target = PR load +5% and PR reps +1.</div>
        <div class="sets-control">
          <label>Sets
            <select class="quick-set-count" aria-label="Sets count">
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3" selected>3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
            </select>
          </label>
        </div>
        <div class="set-rows">
          <div class="quick-set-list"></div>
        </div>
        <details>
          <summary>Notes / tempo / variation</summary>
          <label>Tempo<input class="quick-tempo-input" type="text" placeholder="e.g. 31X0"></label>
          <label>Variation<input class="quick-variation-input" type="text" placeholder="Optional"></label>
          <label>Notes<textarea class="quick-notes-input" rows="3" placeholder="Cues or notes"></textarea></label>
        </details>
      </div>
    `;
    // initial set rows
    renderQuickSetRows(card, 3);
    return card;
  }

  function renderQuickSetRows(card, setCount) {
    const list = card.querySelector('.quick-set-list');
    if (!list) return;
    // preserve existing values
    const existing = Array.from(list.querySelectorAll('.set-row')).map((row) => ({
      load: row.querySelector('.quick-load-input') ? row.querySelector('.quick-load-input').value : '',
      reps: row.querySelector('.quick-reps-input') ? row.querySelector('.quick-reps-input').value : ''
    }));
    list.innerHTML = '';
    for (let i = 0; i < setCount; i += 1) {
      const row = document.createElement('div');
      row.className = 'set-row';
      const label = document.createElement('span');
      label.className = 'set-label';
      label.textContent = String(i + 1);
      const load = document.createElement('input');
      load.type = 'text';
      load.className = 'quick-load-input';
      load.placeholder = 'kg/BW';
      const reps = document.createElement('input');
      reps.type = 'number';
      reps.className = 'quick-reps-input';
      reps.placeholder = 'reps';
      if (existing[i]) {
        load.value = existing[i].load;
        reps.value = existing[i].reps;
      }
      row.appendChild(label);
      row.appendChild(load);
      row.appendChild(reps);
      list.appendChild(row);
    }
  }

  function refreshQuickExerciseSelects() {
    let filtered = getFilteredExercises() || [];
    if (!filtered.length) filtered = state.exercises || [];
    if (!filtered.length) filtered = state.seedExercises || [];
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
          option.textContent = `${selected} - outside session filter`;
          select.appendChild(option);
        }
        select.value = selected;
      }
      // refresh readouts for this card
      const card = select.closest('.quick-card');
      refreshQuickComputedCellsForCard(card);
    });
  }

  function refreshQuickComputedCellsForCard(card) {
    if (!card) return;
    const exercise = card.querySelector('.quick-exercise-select').value;
    const variation = card.querySelector('.quick-variation-input').value.trim();
    const last = findLastUsed(exercise, variation);
    const target = getTarget(exercise);
    const lastEl = card.querySelector('.quick-last-readout');
    const targetEl = card.querySelector('.quick-target-readout');
    if (lastEl) lastEl.textContent = last || '-';
    if (targetEl) targetEl.textContent = target || '-';
    // auto-fill tempo from PR if available
    const tempoInput = card.querySelector('.quick-tempo-input');
    const pr = findPr(exercise);
    if (tempoInput && !tempoInput.value) {
      if (pr && pr.prTempo) tempoInput.value = String(pr.prTempo).toUpperCase();
    }
  }

  function updateQuickReadyCount() {
    const container = els.quickEntryList;
    if (!container) return;
    const exerciseCount = Array.from(container.querySelectorAll('.quick-exercise-select')).filter((s) => s.value).length;
    const setCount = Array.from(container.querySelectorAll('.set-row')).length;
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
    if (target.matches('.quick-set-count')) {
      const n = Number(target.value) || 1;
      renderQuickSetRows(card, n);
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
    const btn = event.target.closest('.quick-remove-card-btn');
    if (btn) {
      const card = btn.closest('.quick-card');
      if (card) card.remove();
      updateQuickReadyCount();
      debounceSaveQuickDraft();
      return;
    }
  }

  function getDraftKey(sheetId, date, session) {
    const normalizedSheet = String(sheetId || 'no-sheet').trim();
    const normalizedDate = String(date || '').trim();
    const normalizedSession = String(session || '').trim();
    return `${DRAFT_PREFIX}.${normalizedSheet}.${normalizedDate}.${normalizedSession}`;
  }

  function getQuickDraftContext() {
    return {
      sheetId: state.sheetId || 'no-sheet',
      date: els.dateInput.value || '',
      session: els.sessionSelect.value || ''
    };
  }

  function collectQuickDraft() {
    const cards = Array.from(els.quickEntryList.querySelectorAll('.quick-card'))
      .map((card) => {
        const exercise = card.querySelector('.quick-exercise-select').value.trim();
        const setCount = Number(card.querySelector('.quick-set-count').value) || 1;
        const tempo = card.querySelector('.quick-tempo-input').value.trim().toUpperCase();
        const variation = card.querySelector('.quick-variation-input').value.trim();
        const notes = card.querySelector('.quick-notes-input').value.trim();
        const sets = Array.from(card.querySelectorAll('.set-row')).map((row) => ({
          load: String(row.querySelector('.quick-load-input').value || '').trim(),
          reps: String(row.querySelector('.quick-reps-input').value || '').trim()
        }));

        const hasContent = exercise || tempo || variation || notes || sets.some((set) => set.load || set.reps);
        if (!hasContent) return null;

        return {
          exercise,
          setCount,
          sets,
          tempo,
          variation,
          notes
        };
      })
      .filter(Boolean);

    return { cards };
  }

  function saveQuickDraft(context) {
    const draftContext = context || getQuickDraftContext();
    const key = getDraftKey(draftContext.sheetId, draftContext.date, draftContext.session);
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
    const key = getDraftKey(draftContext.sheetId, draftContext.date, draftContext.session);
    let stored = null;

    try {
      stored = JSON.parse(localStorage.getItem(key) || 'null');
    } catch (error) {
      stored = null;
    }

    if (!stored || !Array.isArray(stored.cards) || !stored.cards.length) {
      return false;
    }

    const container = els.quickEntryList;
    if (!container) return false;

    clearQuickCards();

    const controls = getQuickEntryControls();
    stored.cards.forEach((cardDraft) => {
      const card = createQuickExerciseCard();
      const exerciseSelect = card.querySelector('.quick-exercise-select');
      const setCountSelect = card.querySelector('.quick-set-count');
      const tempoInput = card.querySelector('.quick-tempo-input');
      const variationInput = card.querySelector('.quick-variation-input');
      const notesInput = card.querySelector('.quick-notes-input');

      setCountSelect.value = String(cardDraft.setCount || 1);
      renderQuickSetRows(card, Number(cardDraft.setCount) || 1);
      tempoInput.value = cardDraft.tempo || '';
      variationInput.value = cardDraft.variation || '';
      notesInput.value = cardDraft.notes || '';

      const setRows = Array.from(card.querySelectorAll('.set-row'));
      if (Array.isArray(cardDraft.sets)) {
        cardDraft.sets.forEach((set, index) => {
          const row = setRows[index];
          if (!row) return;
          const loadInput = row.querySelector('.quick-load-input');
          const repsInput = row.querySelector('.quick-reps-input');
          if (loadInput) loadInput.value = set.load || '';
          if (repsInput) repsInput.value = set.reps || '';
        });
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
      const exerciseSelect = card.querySelector('.quick-exercise-select');
      if (exerciseSelect && cardDraft.exercise) {
        if (exerciseSelect.value !== cardDraft.exercise) {
          const option = document.createElement('option');
          option.value = cardDraft.exercise;
          option.textContent = `${cardDraft.exercise} - restored`;
          exerciseSelect.appendChild(option);
          exerciseSelect.value = cardDraft.exercise;
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
    const key = getDraftKey(draftContext.sheetId, draftContext.date, draftContext.session);
    localStorage.removeItem(key);
  }

  function clearQuickCards() {
    Array.from(els.quickEntryList.querySelectorAll('.quick-card')).forEach((card) => card.remove());
    updateQuickReadyCount();
  }

  function handleDraftContextChange() {
    const previous = { ...quickDraftContext };
    const next = getQuickDraftContext();
    if (previous.date === next.date && previous.session === next.session && previous.sheetId === next.sheetId) {
      return;
    }

    saveQuickDraft(previous);
    quickDraftContext = next;
    restoreQuickDraft(next);
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

  function renderSessionOptions() {
    const sessions = getSessions();
    els.sessionSelect.innerHTML = sessions
      .map((session) => `<option value="${escapeAttr(session.name)}">${escapeHtml(session.name)}</option>`)
      .join('');

    const preferred = sessions.find((session) => session.name === 'Legs') || sessions[0];
    if (preferred) els.sessionSelect.value = preferred.name;
    updateSessionHelp();
  }

  function getSessions() {
    const configured = Array.isArray(CONFIG.SESSIONS) ? CONFIG.SESSIONS : [];
    const sessions = configured.length ? configured : [{ name: 'All Exercises', categories: ['*'] }];
    const seen = new Set();
    const clean = [];

    sessions.forEach((session) => {
      if (!session || !session.name) return;
      const key = normalize(session.name);
      if (seen.has(key)) return;
      seen.add(key);
      clean.push({
        name: String(session.name),
        categories: Array.isArray(session.categories) && session.categories.length ? session.categories : ['*']
      });
    });

    state.logRows.forEach((row) => {
      if (!row.session) return;
      const key = normalize(row.session);
      if (seen.has(key)) return;
      seen.add(key);
      clean.push({ name: row.session, categories: ['*'] });
    });

    return clean;
  }

  function attachEvents() {
    els.saveSheetIdBtn.addEventListener('click', saveSheetIdFromInput);
    els.authorizeBtn.addEventListener('click', requestAccessToken);
    els.loadSheetBtn.addEventListener('click', () => loadSheetData());
    els.forgetSheetBtn.addEventListener('click', forgetSheet);
    els.sessionSelect.addEventListener('change', () => {
      updateSessionHelp();
      refreshExerciseSelects();
      refreshAllComputedCells();
      refreshQuickExerciseSelects();
      handleDraftContextChange();
    });
    els.dateInput.addEventListener('change', handleDraftContextChange);
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
      refreshExerciseSelects();
      refreshQuickExerciseSelects();
      setConnectionStatus('Demo mode', '');
      updateSessionHelp();
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

      const selectedSession = els.sessionSelect.value;
      renderSessionOptions();
      if (selectedSession) els.sessionSelect.value = selectedSession;
      updateSessionHelp();
      refreshExerciseSelects();
      refreshQuickExerciseSelects();
      refreshAllComputedCells();
      setConnectionStatus('Sheet loaded', 'connected');
      const source = parsedExercises.length ? 'sheet' : 'seed fallback';
      setSetupMessage(`Loaded ${state.exercises.length} exercises from ${source}, ${state.prRows.length} PR rows, and ${state.logRows.length} log rows.`, 'success');
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
      await appendLogRows(collected.rows);
      const prUpdateCount = await updatePrRows(collected.prCandidates);
      await loadSheetData();
      clearRows();
      clearQuickDraft();
      clearQuickCards();
      addRows(Number(CONFIG.DEFAULT_ROWS || 8));
      setSetupMessage(`Saved ${collected.rows.length} rows.${prUpdateCount ? ` Updated ${prUpdateCount} PR row(s).` : ''} Draft cleared after save.`, 'success');
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
    const session = els.sessionSelect.value;
    const bodyweight = valueOrBlank(els.bodyweightInput.value);
    const rows = [];
    const prCandidates = [];
    const errors = [];

    if (!date) errors.push('Choose a date first.');
    if (!session) errors.push('Choose a session first.');

    Array.from(els.entryBody.querySelectorAll('tr')).forEach((tr, index) => {
      const exercise = tr.querySelector('.exercise-select').value.trim();
      if (!exercise) return;

      const variation = tr.querySelector('.variation-input').value.trim();
      const setNumber = valueOrBlank(tr.querySelector('.set-input').value);
      const loadRaw = tr.querySelector('.load-input').value.trim();
      const repsRaw = tr.querySelector('.reps-input').value.trim();
      const tempo = tr.querySelector('.tempo-input').value.trim().toUpperCase();
      const rpe = valueOrBlank(tr.querySelector('.rpe-input').value);
      const rest = valueOrBlank(tr.querySelector('.rest-input').value);
      const prFlag = tr.querySelector('.pr-select').value;
      const notes = tr.querySelector('.notes-input').value.trim();

      if (!setNumber) errors.push(`Row ${index + 1}: enter a set number.`);
      if (!loadRaw) errors.push(`Row ${index + 1}: enter load. Use BW or 0 for bodyweight if needed.`);
      if (!repsRaw) errors.push(`Row ${index + 1}: enter reps.`);

      const load = coerceCellValue(loadRaw);
      const reps = coerceCellValue(repsRaw);
      const finalTempo = tempo;
      const numericLoad = strictNumber(loadRaw);
      const numericReps = strictNumber(repsRaw);
      const volume = numericLoad !== null && numericReps !== null ? round(numericLoad * numericReps, 2) : '';
      const e1rm = numericLoad !== null && numericReps !== null ? round(numericLoad * (1 + numericReps / 30), 2) : '';

      rows.push([
        date,
        session,
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
        notes
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

    if (els.quickEntryList) {
      Array.from(els.quickEntryList.querySelectorAll('.quick-card')).forEach((card, cardIndex) => {
        const exercise = card.querySelector('.quick-exercise-select').value.trim();
        const variation = card.querySelector('.quick-variation-input').value.trim();
        const tempoValue = card.querySelector('.quick-tempo-input').value.trim().toUpperCase();
        const notesValue = card.querySelector('.quick-notes-input').value.trim();
        const finalTempo = tempoValue;
        const finalNotes = notesValue;

        const setRows = Array.from(card.querySelectorAll('.set-row'));
        const hasAnySetValue = setRows.some((row) => {
          const loadRaw = String(row.querySelector('.quick-load-input').value || '').trim();
          const repsRaw = String(row.querySelector('.quick-reps-input').value || '').trim();
          return loadRaw || repsRaw;
        });
        if (!hasAnySetValue) return;
        if (!exercise) {
          errors.push(`Quick entry ${cardIndex + 1}: choose an exercise for active sets.`);
          return;
        }

        setRows.forEach((row, setIndex) => {
          const loadRaw = String(row.querySelector('.quick-load-input').value || '').trim();
          const repsRaw = String(row.querySelector('.quick-reps-input').value || '').trim();
          if (!loadRaw && !repsRaw) return;
          if (!loadRaw) errors.push(`Quick entry ${cardIndex + 1}, set ${setIndex + 1}: enter load.`);
          if (!repsRaw) errors.push(`Quick entry ${cardIndex + 1}, set ${setIndex + 1}: enter reps.`);

          const load = coerceCellValue(loadRaw);
          const reps = coerceCellValue(repsRaw);
          const numericLoad = strictNumber(loadRaw);
          const numericReps = strictNumber(repsRaw);
          const volume = numericLoad !== null && numericReps !== null ? round(numericLoad * numericReps, 2) : '';
          const e1rm = numericLoad !== null && numericReps !== null ? round(numericLoad * (1 + numericReps / 30), 2) : '';

          rows.push([
            date,
            session,
            exercise,
            variation,
            setIndex + 1,
            load,
            reps,
            finalTempo,
            '',
            '',
            bodyweight,
            volume,
            e1rm,
            '',
            finalNotes
          ]);
        });
      });
    }

    return { rows, prCandidates, errors };
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
      <td><input class="load-input compact-input" inputmode="decimal" placeholder="kg/BW" aria-label="Load kg"></td>
      <td><input class="reps-input compact-input" inputmode="decimal" placeholder="reps" aria-label="Reps"></td>
      <td><input class="tempo-input compact-input" type="text" placeholder="31X0" aria-label="Tempo"></td>
      <td><input class="rpe-input compact-input" type="number" min="1" max="10" step="0.5" placeholder="RPE" aria-label="RPE"></td>
      <td><input class="rest-input compact-input" type="number" min="0" step="5" placeholder="sec" aria-label="Rest seconds"></td>
      <td class="readout last-readout">-</td>
      <td class="readout target-readout">-</td>
      <td>
        <select class="pr-select" aria-label="PR flag">
          <option value=""></option>
          <option value="Y">Y</option>
        </select>
      </td>
      <td><input class="notes-input" type="text" placeholder="Cues or notes" aria-label="Notes"></td>
      <td><button class="remove-row-btn" type="button" aria-label="Remove row">X</button></td>
    `;
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
          option.textContent = `${selected} - outside session filter`;
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
    const exercise = tr.querySelector('.exercise-select').value;
    const variation = tr.querySelector('.variation-input').value.trim();
    const last = findLastUsed(exercise, variation);
    const target = getTarget(exercise);
    tr.querySelector('.last-readout').textContent = last || '-';
    tr.querySelector('.target-readout').textContent = target || '-';
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
    const session = getSessions().find((item) => item.name === els.sessionSelect.value);
    if (!session || session.categories.includes('*')) return state.exercises;
    const allowed = new Set(session.categories.map(normalize));
    return state.exercises.filter((exercise) => allowed.has(normalize(exercise.category)));
  }

  function updateSessionHelp() {
    const session = getSessions().find((item) => item.name === els.sessionSelect.value);
    if (!session) {
      els.sessionHelp.textContent = 'Choose a session to filter the exercise dropdowns.';
      return;
    }
    if (session.categories.includes('*')) {
      els.sessionHelp.textContent = 'This session shows all exercises.';
      return;
    }
    els.sessionHelp.textContent = `This session filters to: ${session.categories.join(', ')}.`;
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
    const text = String(value).trim().replace(/kg/gi, '').replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
    const numeric = Number(text);
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
      appendLog: 'Log!B4:P'
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

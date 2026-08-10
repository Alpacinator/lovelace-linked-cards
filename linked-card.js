/**
 * linked-card - A HACS Lovelace plugin
 *
 *   custom:linked-card-source
 *     Wraps any card and gives it a card_id so it can be linked from elsewhere.
 *
 *       type: custom:linked-card-source
 *       card_id: my-sensor-list
 *       card:
 *         type: entities
 *         entities:
 *           - sensor.temperature
 *
 *   custom:linked-card
 *     Renders a linked copy of a source card.
 *
 *       type: custom:linked-card
 *       linked_card_id: my-sensor-list
 *
 *   custom:linked-section
 *     Renders all cards from a source section identified by section_id.
 *
 *       type: custom:linked-section
 *       linked_section_id: bedroom-controls
 */

const CACHE_TTL_MS   = 30_000;
const PLUGIN_VERSION = '1.6.0';

// ------------------------------------------------------------------ global cache --

let _dashboardEntries = null; // [{ config, urlPath }]
let _dashboardCacheTs = 0;
let _dashboardPending = null;

// Per-id result cache: key -> { config, location } | null
const _resultCache = new Map();

// Rendered element cache: key -> { element, childCards }
const _elementCache = new Map();

// Pre-warmed helpers promise
let _helpersPromise = null;
function getHelpers() {
  if (!_helpersPromise) _helpersPromise = window.loadCardHelpers();
  return _helpersPromise;
}
getHelpers();

// ------------------------------------------------------------------ helpers --

function cloneWithout(obj, ...keys) {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

function isDashboardCacheValid() {
  return _dashboardEntries !== null && Date.now() - _dashboardCacheTs < CACHE_TTL_MS;
}

/**
 * Returns [{ config, urlPath }] for all readable dashboards.
 * urlPath is null for the default dashboard.
 * All callers share one in-flight promise.
 */
async function getDashboardEntries(hass) {
  if (isDashboardCacheValid()) return _dashboardEntries;
  if (_dashboardPending) return _dashboardPending;

  _dashboardPending = (async () => {
    let urlPaths;
    try {
      const dashboards = await hass.callWS({ type: 'lovelace/dashboards/list' });
      urlPaths = [null, ...dashboards.map((d) => d.url_path)];
    } catch {
      urlPaths = [null];
    }

    const entries = [];
    for (const urlPath of urlPaths) {
      try {
        const config = await hass.callWS({ type: 'lovelace/config', url_path: urlPath });
        entries.push({ config, urlPath });
      } catch {
        // YAML-managed or inaccessible - skip
      }
    }

    _dashboardEntries = entries;
    _dashboardCacheTs = Date.now();
    _dashboardPending = null;
    return entries;
  })();

  return _dashboardPending;
}

/**
 * Builds the URL to navigate to a specific view.
 * urlPath: null = default dashboard (/lovelace), otherwise the custom path.
 * view: the view object (may have a .path property, otherwise use index).
 * viewIndex: fallback index if view has no path.
 */
function buildViewUrl(urlPath, view, viewIndex) {
  const base = urlPath === null ? '/lovelace' : `/${urlPath}`;
  const slug  = view?.path ?? viewIndex;
  return `${base}/${slug}`;
}

/** Bust all caches - used on retry */
function bustCache(elementCacheKey, resultCacheKey) {
  _dashboardEntries = null;
  _dashboardCacheTs = 0;
  _dashboardPending = null;
  _prewarmed        = false;
  if (resultCacheKey)  _resultCache.delete(resultCacheKey);
  if (elementCacheKey) _elementCache.delete(elementCacheKey);
}

// --------------------------------------------------------- card search ------

/**
 * Searches a list of cards for one matching cardId.
 * Returns { config } or null.
 */
function searchCardsInList(cards, cardId) {
  for (const card of cards ?? []) {
    // Preferred: custom:linked-card-source wrapper
    if (card.type === 'custom:linked-card-source' && card.card_id === cardId && card.card) {
      return { config: card.card };
    }
    // Legacy: card_id directly on any card (backwards compatible)
    if (card.card_id === cardId) {
      return { config: cloneWithout(card, 'card_id') };
    }
    // Recurse into container cards
    const nested =
      searchCardsInList(card.cards, cardId) ||
      (card.card && card.type !== 'custom:linked-card-source'
        ? searchCardsInList([card.card], cardId)
        : null);
    if (nested) return nested;
  }
  return null;
}

/**
 * Searches all views in a dashboard config for a card matching cardId.
 * Returns { config, viewUrl } or null.
 */
function searchCardInDashboard(dashboardEntry, cardId) {
  const { config, urlPath } = dashboardEntry;
  const views = config?.views ?? [];
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    const inCards = searchCardsInList(view.cards, cardId);
    if (inCards) return { config: inCards.config, viewUrl: buildViewUrl(urlPath, view, i) };

    for (const section of view.sections ?? []) {
      const inSection = searchCardsInList(section.cards, cardId);
      if (inSection) return { config: inSection.config, viewUrl: buildViewUrl(urlPath, view, i) };
    }
  }
  return null;
}

async function findCardById(hass, cardId) {
  const cacheKey = `card::${cardId}`;
  if (_resultCache.has(cacheKey)) return _resultCache.get(cacheKey);

  const entries = await getDashboardEntries(hass);
  for (const entry of entries) {
    const found = searchCardInDashboard(entry, cardId);
    if (found) {
      _resultCache.set(cacheKey, found);
      return found;
    }
  }
  _resultCache.set(cacheKey, null);
  return null;
}

// --------------------------------------------------------- section search ---

/**
 * Searches all views in a dashboard config for a section matching sectionId.
 * Returns { config, viewUrl } or null.
 */
function searchSectionInDashboard(dashboardEntry, sectionId) {
  const { config, urlPath } = dashboardEntry;
  const views = config?.views ?? [];
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    for (const section of view.sections ?? []) {
      if (section.section_id === sectionId) {
        return {
          config:  cloneWithout(section, 'section_id'),
          viewUrl: buildViewUrl(urlPath, view, i),
        };
      }
    }
  }
  return null;
}

async function findSectionById(hass, sectionId) {
  const cacheKey = `section::${sectionId}`;
  if (_resultCache.has(cacheKey)) return _resultCache.get(cacheKey);

  const entries = await getDashboardEntries(hass);
  for (const entry of entries) {
    const found = searchSectionInDashboard(entry, sectionId);
    if (found) {
      _resultCache.set(cacheKey, found);
      return found;
    }
  }
  _resultCache.set(cacheKey, null);
  return null;
}

// --------------------------------------------------- pre-warm on first hass --

let _prewarmed = false;
function prewarmIfNeeded(hass) {
  if (_prewarmed || isDashboardCacheValid()) return;
  _prewarmed = true;
  getDashboardEntries(hass);
}

// ---------------------------------------------------- shared base class -----

class LinkedBase extends HTMLElement {
  constructor() {
    super();
    this._config    = null;
    this._hass      = null;
    this._state     = 'idle';
    this._cacheKey  = null;
    this._sourceUrl = null; // URL to navigate to for editing the source
  }

  set hass(hass) {
    this._hass = hass;
    prewarmIfNeeded(hass);
    this._onHassUpdated(hass);
    if (this._state === 'idle') this._load();
    else if (this._state === 'ready') this._syncEditOverlay();
  }

  _onHassUpdated(_hass) {}

  _resetForNewId() {
    this._cacheKey  = null;
    this._sourceUrl = null;
    this._state     = 'idle';
    if (this._hass) this._load();
  }

  async _load() {
    if (!this._hass || !this._config) return;

    // Reattach cached element if available
    if (this._cacheKey && _elementCache.has(this._cacheKey)) {
      const cached = _elementCache.get(this._cacheKey);
      this._sourceUrl = cached.sourceUrl;
      this._onElementReused(cached);
      this._state    = 'ready';
      this.innerHTML = '';
      this.appendChild(cached.element);
      this._onHassUpdated(this._hass);
      this._syncEditOverlay();
      return;
    }

    this._state = 'loading';
    this._renderLoading();
    try {
      await this._doLoad();
      if (this._state === 'ready') this._syncEditOverlay();
    } catch (err) {
      this._renderError(`Unexpected error: ${err.message}`);
      this._state = 'error';
    }
  }

  _onElementReused(_cached) {}
  async _doLoad() {}

  // Shows or hides the edit-mode overlay depending on hass.editMode
  _syncEditOverlay() {
    const overlay = this.querySelector('.lc-edit-overlay');
    if (this._hass?.editMode && this._state === 'ready') {
      if (!overlay) this._addEditOverlay();
    } else {
      overlay?.remove();
    }
  }

  _addEditOverlay() {
    const label   = this._kind === 'card' ? 'Linked Card' : 'Linked Section';
    const sourceId = this._kind === 'card'
      ? this._config.linked_card_id
      : this._config.linked_section_id;

    const overlay = document.createElement('div');
    overlay.className = 'lc-edit-overlay';
    overlay.innerHTML = `
      <ha-icon icon="mdi:link-variant"></ha-icon>
      <span class="lc-edit-label">${label}: <strong>${sourceId}</strong></span>
      ${this._sourceUrl
        ? `<button class="lc-edit-btn">Edit source</button>`
        : `<span class="lc-edit-unknown">Source location unknown</span>`
      }
      <style>
        .lc-edit-overlay {
          position: absolute;
          top: 0; left: 0; right: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          background: var(--primary-color, #2196f3);
          color: #fff;
          font-size: 12px;
          font-weight: 500;
          z-index: 10;
          border-radius: var(--ha-card-border-radius, 4px) var(--ha-card-border-radius, 4px) 0 0;
          box-sizing: border-box;
          pointer-events: all;
        }
        .lc-edit-overlay ha-icon {
          --mdc-icon-size: 16px;
          flex-shrink: 0;
        }
        .lc-edit-label {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lc-edit-btn {
          background: rgba(255,255,255,0.2);
          border: 1px solid rgba(255,255,255,0.5);
          color: #fff;
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 11px;
          cursor: pointer;
          flex-shrink: 0;
          white-space: nowrap;
        }
        .lc-edit-btn:hover { background: rgba(255,255,255,0.35); }
        .lc-edit-unknown { opacity: 0.7; font-size: 11px; flex-shrink: 0; }
      </style>
    `;

    if (this._sourceUrl) {
      overlay.querySelector('.lc-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        history.pushState(null, '', this._sourceUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    }

    // The host element needs relative positioning for the overlay to work
    this.style.position = 'relative';
    this.style.display  = 'block';
    this.insertBefore(overlay, this.firstChild);
  }

  _renderLoading() {
    this.innerHTML = `
      <ha-card>
        <div class="lc-message">
          <ha-circular-progress active size="small"></ha-circular-progress>
          <span>Loading linked ${this._kind}...</span>
        </div>
      </ha-card>
      ${sharedStyles()}
    `;
  }

  _renderError(message, elementCacheKey, resultCacheKey) {
    this.innerHTML = `
      <ha-card>
        <div class="lc-error">
          <ha-icon icon="mdi:link-variant-off"></ha-icon>
          <div>
            <strong>Linked ${capitalize(this._kind)}</strong>
            <p>${message}</p>
            <button class="lc-retry">Retry</button>
          </div>
        </div>
      </ha-card>
      ${sharedStyles()}
    `;
    this.querySelector('.lc-retry')?.addEventListener('click', () => {
      bustCache(elementCacheKey, resultCacheKey);
      this._cacheKey  = null;
      this._sourceUrl = null;
      this._state     = 'idle';
      this._load();
    });
  }

  getCardSize() { return 1; }
}

function sharedStyles() {
  return `
    <style>
      .lc-message {
        display: flex; align-items: center; gap: 12px;
        padding: 16px; color: var(--secondary-text-color); font-size: 14px;
      }
      .lc-error {
        display: flex; align-items: flex-start; gap: 12px;
        padding: 16px; color: var(--error-color, #db4437); font-size: 14px;
      }
      .lc-error ha-icon { flex-shrink: 0; margin-top: 2px; }
      .lc-error p { margin: 4px 0 8px; color: var(--secondary-text-color); }
      .lc-retry {
        background: none; border: 1px solid var(--error-color, #db4437);
        color: var(--error-color, #db4437); border-radius: 4px;
        padding: 4px 10px; cursor: pointer; font-size: 12px;
      }
      .lc-retry:hover { opacity: 0.8; }
    </style>
  `;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// --------------------------------------------------------------- LinkedCard --

class LinkedCard extends LinkedBase {
  constructor() {
    super();
    this._kind      = 'card';
    this._childCard = null;
  }

  setConfig(config) {
    if (!config.linked_card_id) throw new Error('[linked-card] linked_card_id is required.');
    const idChanged = this._config?.linked_card_id !== config.linked_card_id;
    this._config = config;
    if (idChanged) {
      this._childCard = null;
      this._resetForNewId();
    }
  }

  _onHassUpdated(hass) {
    if (this._childCard) this._childCard.hass = hass;
  }

  _onElementReused(cached) {
    this._childCard = cached.childCard;
  }

  async _doLoad() {
    const id         = this._config.linked_card_id;
    const elementKey = `card::${id}`;
    const found      = await findCardById(this._hass, id);

    if (!found) {
      this._renderError(
        `No card found with card_id: "${id}". ` +
        `Make sure the source is a custom:linked-card-source card on a UI-managed dashboard.`,
        elementKey, `card::${id}`
      );
      this._state = 'error';
      return;
    }

    if (found.config.type === 'custom:linked-card') {
      this._renderError(
        `Circular reference: card_id "${id}" points to another linked-card.`,
        elementKey, `card::${id}`
      );
      this._state = 'error';
      return;
    }

    const helpers = await getHelpers();
    const card    = helpers.createCardElement(found.config);
    card.hass     = this._hass;

    this._cacheKey  = elementKey;
    this._sourceUrl = found.viewUrl;
    this._childCard = card;

    _elementCache.set(elementKey, { element: card, childCard: card, sourceUrl: found.viewUrl });

    this._state    = 'ready';
    this.innerHTML = '';
    this.appendChild(card);
  }

  getCardSize() { return this._childCard?.getCardSize?.() ?? 1; }

  static getConfigElement() { return document.createElement('linked-card-editor'); }
  static getStubConfig()    { return { linked_card_id: '' }; }
}

// ---------------------------------------------------------- LinkedSection ---

class LinkedSection extends LinkedBase {
  constructor() {
    super();
    this._kind       = 'section';
    this._childCards = [];
  }

  setConfig(config) {
    if (!config.linked_section_id) throw new Error('[linked-section] linked_section_id is required.');
    const idChanged = this._config?.linked_section_id !== config.linked_section_id;
    this._config = config;
    if (idChanged) {
      this._childCards = [];
      this._resetForNewId();
    }
  }

  _onHassUpdated(hass) {
    for (const card of this._childCards) card.hass = hass;
  }

  _onElementReused(cached) {
    this._childCards = cached.childCards;
  }

  async _doLoad() {
    const id         = this._config.linked_section_id;
    const elementKey = `section::${id}`;
    const found      = await findSectionById(this._hass, id);

    if (!found) {
      this._renderError(
        `No section found with section_id: "${id}". ` +
        `Make sure the source section has section_id set and is on a UI-managed dashboard.`,
        elementKey, `section::${id}`
      );
      this._state = 'error';
      return;
    }

    const cards = found.config.cards ?? [];
    if (cards.length === 0) {
      this._renderError(`Section "${id}" exists but has no cards.`, elementKey, `section::${id}`);
      this._state = 'error';
      return;
    }

    const helpers = await getHelpers();
    const wrapper  = document.createElement('div');
    wrapper.className = 'linked-section-wrapper';

    if (found.config.title) {
      const heading       = document.createElement('div');
      heading.className   = 'linked-section-title';
      heading.textContent = found.config.title;
      wrapper.appendChild(heading);
    }

    this._childCards = [];
    for (const cardConfig of cards) {
      const card = helpers.createCardElement(cardConfig);
      card.hass  = this._hass;
      this._childCards.push(card);
      wrapper.appendChild(card);
    }

    this._cacheKey  = elementKey;
    this._sourceUrl = found.viewUrl;

    _elementCache.set(elementKey, {
      element:    wrapper,
      childCards: this._childCards,
      sourceUrl:  found.viewUrl,
    });

    this._state    = 'ready';
    this.innerHTML = `
      <style>
        .linked-section-wrapper {
          display: flex; flex-direction: column;
          gap: var(--ha-card-border-radius, 8px);
        }
        .linked-section-title {
          font-size: 14px; font-weight: 500;
          color: var(--secondary-text-color); padding: 4px 0;
        }
      </style>
    `;
    this.appendChild(wrapper);
  }

  getCardSize() {
    if (!this._childCards.length) return 1;
    return this._childCards.reduce((sum, c) => sum + (c.getCardSize?.() ?? 1), 0);
  }

  static getConfigElement() { return document.createElement('linked-section-editor'); }
  static getStubConfig()    { return { linked_section_id: '' }; }
}

// -------------------------------------------------------- LinkedCardSource ----

class LinkedCardSource extends HTMLElement {
  constructor() {
    super();
    this._config    = null;
    this._hass      = null;
    this._childCard = null;
  }

  setConfig(config) {
    if (!config.card_id) throw new Error('[linked-card-source] card_id is required.');
    if (!config.card)    throw new Error('[linked-card-source] card is required.');
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._childCard) this._childCard.hass = hass;
  }

  async _render() {
    if (!this._config?.card) return;
    const helpers   = await getHelpers();
    const card      = helpers.createCardElement(this._config.card);
    if (this._hass) card.hass = this._hass;
    this._childCard = card;
    this.innerHTML  = '';
    this.appendChild(card);
  }

  getCardSize() { return this._childCard?.getCardSize?.() ?? 1; }

  static getConfigElement() { return document.createElement('linked-card-source-editor'); }
  static getStubConfig()    { return { card_id: '', card: { type: 'entities', entities: [] } }; }
}

class LinkedCardSourceEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
  }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(_hass) {}

  _render() {
    const currentId = this._config.card_id ?? '';
    this.innerHTML = `
      <div class="lc-editor">
        <p class="lc-hint">
          Give this source card a unique ID. Then reference it from any dashboard using
          <code>custom:linked-card</code> with <code>linked_card_id: ${currentId || 'your-id'}</code>.
        </p>
        <label class="lc-label">
          Card ID
          <input type="text" class="lc-input" placeholder="e.g. living-room-sensors" value="${currentId}" />
        </label>
        <p class="lc-hint" style="margin-top:12px">
          The inner card is configured via the <code>card:</code> key in YAML.
        </p>
      </div>
      <style>
        .lc-editor { padding: 8px 0; font-size: 14px; }
        .lc-hint { color: var(--secondary-text-color); margin: 0 0 6px; font-size: 12px; line-height: 1.5; }
        .lc-hint code { background: var(--code-editor-background-color, #f5f5f5); padding: 1px 4px; border-radius: 3px; }
        .lc-label { display: flex; flex-direction: column; gap: 6px; font-weight: 500; }
        .lc-input {
          padding: 8px; margin-top: 4px;
          border: 1px solid var(--divider-color); border-radius: 4px;
          background: var(--card-background-color); color: var(--primary-text-color);
          font-size: 14px; width: 100%; box-sizing: border-box;
        }
      </style>
    `;

    this.querySelector('.lc-input').addEventListener('change', (e) => {
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: { ...this._config, card_id: e.target.value.trim() } },
        bubbles: true,
        composed: true,
      }));
    });
  }
}

// --------------------------------------------------------- shared editor ----

function buildEditor(elementName, idField, label, hint, collectFn) {
  class Editor extends HTMLElement {
    constructor() {
      super();
      this._config  = {};
      this._hass    = null;
      this._ids     = [];
      this._loading = false;
    }

    setConfig(config) {
      this._config = config;
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._loadIds();
    }

    async _loadIds() {
      if (!this._hass || this._loading) return;
      this._loading  = true;
      const ids      = [];
      const entries  = await getDashboardEntries(this._hass);
      for (const { config } of entries) collectFn(config, ids);
      this._ids     = [...new Set(ids)].sort();
      this._loading = false;
      this._render();
    }

    _render() {
      const currentId = this._config[idField] ?? '';
      const hasIds    = this._ids.length > 0;

      const options = hasIds
        ? this._ids.map((id) =>
            `<option value="${id}" ${id === currentId ? 'selected' : ''}>${id}</option>`
          ).join('')
        : `<option value="" disabled>${this._loading ? 'Loading...' : 'None found on any UI-managed dashboard'}</option>`;

      this.innerHTML = `
        <div class="lc-editor">
          <p class="lc-hint">${hint}</p>
          <label class="lc-label">
            ${label}
            <div class="lc-row">
              <input
                type="text"
                class="lc-input"
                placeholder="e.g. my-${idField.replace('linked_', '').replace('_id', '')}"
                value="${currentId}"
              />
              <select class="lc-select" ${!hasIds ? 'disabled' : ''}>
                <option value="">-- pick existing --</option>
                ${options}
              </select>
            </div>
          </label>
          ${currentId && !hasIds ? `<p class="lc-warn">Could not load dashboard configs. Check that your dashboards are UI-managed.</p>` : ''}
        </div>
        <style>
          .lc-editor { padding: 8px 0; font-size: 14px; }
          .lc-hint { color: var(--secondary-text-color); margin: 0 0 12px; font-size: 12px; line-height: 1.5; }
          .lc-hint code { background: var(--code-editor-background-color, #f5f5f5); padding: 1px 4px; border-radius: 3px; }
          .lc-warn { color: var(--warning-color, #ff9800); font-size: 12px; margin: 8px 0 0; }
          .lc-label { display: flex; flex-direction: column; gap: 6px; font-weight: 500; }
          .lc-row { display: flex; gap: 8px; margin-top: 4px; }
          .lc-input {
            flex: 1; padding: 8px;
            border: 1px solid var(--divider-color); border-radius: 4px;
            background: var(--card-background-color); color: var(--primary-text-color);
            font-size: 14px;
          }
          .lc-select {
            padding: 8px;
            border: 1px solid var(--divider-color); border-radius: 4px;
            background: var(--card-background-color); color: var(--primary-text-color);
            font-size: 14px;
          }
          .lc-select:disabled { opacity: 0.5; }
        </style>
      `;

      const input  = this.querySelector('.lc-input');
      const select = this.querySelector('.lc-select');

      input.addEventListener('change',  (e) => this._fire(e.target.value.trim()));
      select?.addEventListener('change', (e) => {
        if (e.target.value) { input.value = e.target.value; this._fire(e.target.value); }
      });
    }

    _fire(value) {
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: { ...this._config, [idField]: value } },
        bubbles: true,
        composed: true,
      }));
    }
  }

  customElements.define(elementName, Editor);
}

function collectCardIds(config, ids) {
  function walk(cards) {
    for (const card of cards ?? []) {
      if (card.card_id) ids.push(card.card_id);
      walk(card.cards);
      if (card.card && card.type !== 'custom:linked-card-source') walk([card.card]);
    }
  }
  for (const view of config?.views ?? []) {
    walk(view.cards);
    for (const section of view.sections ?? []) walk(section.cards);
  }
}

function collectSectionIds(config, ids) {
  for (const view of config?.views ?? []) {
    for (const section of view.sections ?? []) {
      if (section.section_id) ids.push(section.section_id);
    }
  }
}

buildEditor(
  'linked-card-editor',
  'linked_card_id',
  'Card ID',
  'Wrap any card with <code>custom:linked-card-source</code> and give it a <code>card_id</code>, then pick it here.',
  collectCardIds
);

buildEditor(
  'linked-section-editor',
  'linked_section_id',
  'Section ID',
  'Add <code>section_id: your-unique-id</code> to any section in a sections-layout view, then pick it here.',
  collectSectionIds
);

// ---------------------------------------------------------------- register --

customElements.define('linked-card-source',        LinkedCardSource);
customElements.define('linked-card-source-editor', LinkedCardSourceEditor);
customElements.define('linked-card',               LinkedCard);
customElements.define('linked-section',            LinkedSection);

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: 'linked-card-source',
    name: 'Linked Card Source',
    description: 'Wraps a card and gives it a card_id so it can be mirrored anywhere using custom:linked-card.',
    preview: false,
    documentationURL: 'https://github.com/Alpacinator/lovelace-linked-cards',
  },
  {
    type: 'linked-card',
    name: 'Linked Card',
    description: 'Renders a card defined elsewhere by its card_id. Edit the source once; all linked copies update automatically.',
    preview: false,
    documentationURL: 'https://github.com/Alpacinator/lovelace-linked-cards',
  },
  {
    type: 'linked-section',
    name: 'Linked Section',
    description: 'Renders all cards from a section defined elsewhere by its section_id. Edit the source section; all linked copies update automatically.',
    preview: false,
    documentationURL: 'https://github.com/Alpacinator/lovelace-linked-cards',
  }
);

console.info(
  `%c LINKED-CARDS %c v${PLUGIN_VERSION} `,
  'background:#2196f3;color:#fff;font-weight:bold;padding:2px 4px;border-radius:3px 0 0 3px',
  'background:#1565c0;color:#fff;padding:2px 4px;border-radius:0 3px 3px 0'
);

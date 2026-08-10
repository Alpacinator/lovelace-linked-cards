/**
 * linked-card - A HACS Lovelace plugin
 *
 * Two card types:
 *
 *   custom:linked-card
 *     Renders a single source card identified by card_id.
 *
 *     Source (add card_id to any existing card):
 *       type: entities
 *       card_id: my-sensor-list
 *       entities:
 *         - sensor.temperature
 *
 *     Linked copy:
 *       type: custom:linked-card
 *       linked_card_id: my-sensor-list
 *
 *   custom:linked-section
 *     Renders all cards from a source section identified by section_id.
 *
 *     Source (add section_id to any section in a sections-layout view):
 *       section_id: bedroom-controls
 *       cards:
 *         - type: light
 *           entity: light.bedroom
 *
 *     Linked copy (place as a card anywhere):
 *       type: custom:linked-section
 *       linked_section_id: bedroom-controls
 */

const CACHE_TTL_MS = 30_000;
const PLUGIN_VERSION = '1.2.0';

// ------------------------------------------------------------------ global cache --
// All linked-card and linked-section instances on the page share a single fetch
// for dashboard configs. No matter how many cards are on the page, only one set
// of WebSocket calls is made per TTL window.

let _dashboardConfigs = null;      // cached array of all dashboard configs
let _dashboardCacheTs  = 0;        // timestamp of last successful fetch
let _dashboardPending  = null;     // in-flight promise, shared across all instances

// Per-id result cache so we don't re-search all configs for the same id every time.
// key: `card::<id>` or `section::<id>`
const _resultCache = new Map();

// ------------------------------------------------------------------ helpers --

function cloneWithout(obj, ...keys) {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

function isDashboardCacheValid() {
  return _dashboardConfigs !== null && Date.now() - _dashboardCacheTs < CACHE_TTL_MS;
}

/**
 * Returns all readable dashboard configs.
 * The first call fetches everything via WebSocket; subsequent calls within
 * CACHE_TTL_MS return the cached result instantly. Concurrent callers all
 * await the same single in-flight promise.
 */
async function getDashboardConfigs(hass) {
  if (isDashboardCacheValid()) return _dashboardConfigs;
  if (_dashboardPending) return _dashboardPending;

  _dashboardPending = (async () => {
    let paths;
    try {
      const dashboards = await hass.callWS({ type: 'lovelace/dashboards/list' });
      paths = [null, ...dashboards.map((d) => d.url_path)];
    } catch {
      paths = [null];
    }

    const configs = [];
    for (const urlPath of paths) {
      try {
        const config = await hass.callWS({ type: 'lovelace/config', url_path: urlPath });
        configs.push(config);
      } catch {
        // YAML-managed or inaccessible - skip
      }
    }

    _dashboardConfigs = configs;
    _dashboardCacheTs = Date.now();
    _dashboardPending = null;
    return configs;
  })();

  return _dashboardPending;
}

/** Bust all caches - called on retry so fresh data is fetched. */
function bustCache(resultCacheKey) {
  _dashboardConfigs = null;
  _dashboardCacheTs = 0;
  _dashboardPending = null;
  if (resultCacheKey) _resultCache.delete(resultCacheKey);
}

// --------------------------------------------------------- card search ------

function searchCardsInList(cards, cardId) {
  for (const card of cards ?? []) {
    if (card.card_id === cardId) return cloneWithout(card, 'card_id');
    const nested =
      searchCardsInList(card.cards, cardId) ||
      (card.card ? searchCardsInList([card.card], cardId) : null);
    if (nested) return nested;
  }
  return null;
}

function searchCardInDashboard(config, cardId) {
  for (const view of config?.views ?? []) {
    const inCards = searchCardsInList(view.cards, cardId);
    if (inCards) return inCards;
    for (const section of view.sections ?? []) {
      const inSection = searchCardsInList(section.cards, cardId);
      if (inSection) return inSection;
    }
  }
  return null;
}

async function findCardConfigById(hass, cardId) {
  const cacheKey = `card::${cardId}`;
  const cached = _resultCache.get(cacheKey);
  if (cached) return cached.value;

  const configs = await getDashboardConfigs(hass);
  for (const config of configs) {
    const found = searchCardInDashboard(config, cardId);
    if (found) {
      _resultCache.set(cacheKey, { value: found });
      return found;
    }
  }
  _resultCache.set(cacheKey, { value: null });
  return null;
}

// --------------------------------------------------------- section search ---

function searchSectionInDashboard(config, sectionId) {
  for (const view of config?.views ?? []) {
    for (const section of view.sections ?? []) {
      if (section.section_id === sectionId) return cloneWithout(section, 'section_id');
    }
  }
  return null;
}

async function findSectionConfigById(hass, sectionId) {
  const cacheKey = `section::${sectionId}`;
  const cached = _resultCache.get(cacheKey);
  if (cached) return cached.value;

  const configs = await getDashboardConfigs(hass);
  for (const config of configs) {
    const found = searchSectionInDashboard(config, sectionId);
    if (found) {
      _resultCache.set(cacheKey, { value: found });
      return found;
    }
  }
  _resultCache.set(cacheKey, { value: null });
  return null;
}

// ---------------------------------------------------- shared base class -----

class LinkedBase extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass   = null;
    this._state  = 'idle'; // idle | loading | ready | error
  }

  set hass(hass) {
    this._hass = hass;
    this._onHassUpdated(hass);
    if (this._state === 'idle') this._load();
  }

  _onHassUpdated(_hass) {}

  _resetForNewId() {
    this._state = 'idle';
    if (this._hass) this._load();
  }

  async _load() {
    if (!this._hass || !this._config) return;
    this._state = 'loading';
    this._renderLoading();
    try {
      await this._doLoad();
    } catch (err) {
      this._renderError(`Unexpected error: ${err.message}`);
      this._state = 'error';
    }
  }

  async _doLoad() {}

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

  _renderError(message, cacheKey) {
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
      bustCache(cacheKey);
      this._state = 'idle';
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
    this._kind     = 'card';
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

  async _doLoad() {
    const id = this._config.linked_card_id;
    const sourceConfig = await findCardConfigById(this._hass, id);

    if (!sourceConfig) {
      this._renderError(
        `No card found with card_id: "${id}". ` +
        `Make sure the source card has card_id set and is on a UI-managed dashboard.`,
        `card::${id}`
      );
      this._state = 'error';
      return;
    }

    if (sourceConfig.type === 'custom:linked-card') {
      this._renderError(`Circular reference: card_id "${id}" points to another linked-card.`, `card::${id}`);
      this._state = 'error';
      return;
    }

    const helpers = await window.loadCardHelpers();
    const card    = helpers.createCardElement(sourceConfig);
    card.hass     = this._hass;

    this._childCard = card;
    this._state     = 'ready';
    this.innerHTML  = '';
    this.appendChild(card);
  }

  getCardSize() { return this._childCard?.getCardSize?.() ?? 1; }

  static getConfigElement() { return document.createElement('linked-card-editor'); }

  static getStubConfig(hass, entities, entitiesFallback) {
    return { linked_card_id: '' };
  }
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

  async _doLoad() {
    const id      = this._config.linked_section_id;
    const section = await findSectionConfigById(this._hass, id);

    if (!section) {
      this._renderError(
        `No section found with section_id: "${id}". ` +
        `Make sure the source section has section_id set and is on a UI-managed dashboard.`,
        `section::${id}`
      );
      this._state = 'error';
      return;
    }

    const cards = section.cards ?? [];
    if (cards.length === 0) {
      this._renderError(`Section "${id}" exists but has no cards.`, `section::${id}`);
      this._state = 'error';
      return;
    }

    const helpers = await window.loadCardHelpers();
    const wrapper = document.createElement('div');
    wrapper.className = 'linked-section-wrapper';

    if (section.title) {
      const heading     = document.createElement('div');
      heading.className = 'linked-section-title';
      heading.textContent = section.title;
      wrapper.appendChild(heading);
    }

    this._childCards = [];
    for (const cardConfig of cards) {
      const card = helpers.createCardElement(cardConfig);
      card.hass  = this._hass;
      this._childCards.push(card);
      wrapper.appendChild(card);
    }

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

  static getStubConfig() {
    return { linked_section_id: '' };
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
      this._loading = true;
      const ids     = [];
      // Reuse the global dashboard cache - no extra fetches if already loaded
      const configs = await getDashboardConfigs(this._hass);
      for (const config of configs) collectFn(config, ids);
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

      input.addEventListener('change', (e) => this._fire(e.target.value.trim()));
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
      if (card.card) walk([card.card]);
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
  'Add <code>card_id: your-unique-id</code> to any existing card to make it a source, then pick it here.',
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

customElements.define('linked-card',    LinkedCard);
customElements.define('linked-section', LinkedSection);

window.customCards = window.customCards || [];
window.customCards.push(
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

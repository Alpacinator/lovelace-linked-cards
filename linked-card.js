/**
 * linked-card - A HACS Lovelace plugin
 *
 * Mirror any card or section across dashboards by picking it from a dropdown.
 * The source is identified by dashboard, view, and card/section name.
 * No markers or wrappers needed on the source card.
 *
 *   custom:linked-card
 *       type: custom:linked-card
 *       dashboard: null          # null = default dashboard, or a url_path string
 *       view: "living-room"      # view path or title
 *       card: "My Sensor Card"   # card name, title, or heading
 *
 *   custom:linked-section
 *       type: custom:linked-section
 *       dashboard: null
 *       view: "living-room"
 *       section: "My Section"    # section title
 */

const CACHE_TTL_MS   = 30_000;
const PLUGIN_VERSION = '2.0.0';

// ------------------------------------------------------------------ global cache --

// Map of pathKey -> { config, ts } | Promise
const _dashboardCache = new Map();

// Map of cacheKey -> { element, sourceConfigJson, childCards, sourceUrl }
const _elementCache   = new Map();

let _helpersPromise = null;
function getHelpers() {
  if (!_helpersPromise) _helpersPromise = window.loadCardHelpers();
  return _helpersPromise;
}
getHelpers();

// ------------------------------------------------------------------ helpers --

const NULL_PATH_KEY = '__default__';

function pathKey(dashboard) {
  return (dashboard === null || dashboard === undefined) ? NULL_PATH_KEY : dashboard;
}

function isDashboardCacheValid(entry) {
  return entry && !(entry instanceof Promise) && Date.now() - entry.ts < CACHE_TTL_MS;
}

async function getDashboardConfig(hass, urlPath) {
  const key   = pathKey(urlPath);
  const entry = _dashboardCache.get(key);

  if (isDashboardCacheValid(entry)) return entry.config;
  if (entry instanceof Promise)     return entry;

  const promise = hass.callWS({ type: 'lovelace/config', url_path: urlPath ?? null })
    .then((config) => {
      _dashboardCache.set(key, { config, ts: Date.now() });
      return config;
    })
    .catch(() => {
      _dashboardCache.delete(key);
      return null;
    });

  _dashboardCache.set(key, promise);
  return promise;
}

async function listDashboards(hass) {
  try {
    const dashboards = await hass.callWS({ type: 'lovelace/dashboards/list' });
    return [
      { urlPath: null, title: 'Default' },
      ...dashboards.map((d) => ({ urlPath: d.url_path, title: d.title || d.url_path })),
    ];
  } catch {
    return [{ urlPath: null, title: 'Default' }];
  }
}

// -------------------------------------------------------------- identifiers --
// Views are identified by their path, falling back to title.
// Cards are identified by name, title, or heading.
// Sections are identified by their title.
// These are used both for storing the config and for looking up the source.

function getViewId(view, index) {
  return view.path || view.title || String(index);
}

function getCardId(card, index) {
  return card.name || card.title || card.heading || null;
}

function getSectionId(section, index) {
  return section.title || null;
}

function getViewLabel(view, index) {
  return view.title || view.path || `View ${index + 1}`;
}

function getCardLabel(card, index) {
  const id = getCardId(card, index);
  return id || `${card.type || 'Card'} #${index + 1} (no name)`;
}

function getSectionLabel(section, index) {
  return getSectionId(section, index) || `Section ${index + 1} (no title)`;
}

function findViewByIdInConfig(dashConfig, viewId) {
  return (dashConfig?.views ?? []).find((v, i) => getViewId(v, i) === viewId) ?? null;
}

function findCardByIdInView(view, cardId) {
  return (view?.cards ?? []).find((c, i) => getCardId(c, i) === cardId) ?? null;
}

function findSectionByIdInView(view, sectionId) {
  return (view?.sections ?? []).find((s, i) => getSectionId(s, i) === sectionId) ?? null;
}

function buildViewUrl(urlPath, view, views) {
  const base  = urlPath === null ? '/lovelace' : `/${urlPath}`;
  const index = views.indexOf(view);
  const slug  = view?.path ?? index;
  return `${base}/${slug}`;
}

function bustDashboardCache(urlPath) {
  _dashboardCache.delete(pathKey(urlPath));
}

// ---------------------------------------------------- shared base class -----

class LinkedBase extends HTMLElement {
  constructor() {
    super();
    this._config    = null;
    this._hass      = null;
    this._state     = 'idle';
    this._cacheKey  = null;
    this._sourceUrl = null;
  }

  set hass(hass) {
    this._hass = hass;
    this._onHassUpdated(hass);
    if (this._state === 'idle') this._load();
    else if (this._state === 'ready') this._syncEditOverlay();
  }

  _onHassUpdated(_hass) {}

  _resetForConfig() {
    this._cacheKey  = null;
    this._sourceUrl = null;
    this._state     = 'idle';
    if (this._hass) this._load();
  }

  _elementCacheKey() { return null; }

  async _load() {
    if (!this._hass || !this._config) return;

    const key = this._elementCacheKey();
    if (key && _elementCache.has(key)) {
      const cached          = _elementCache.get(key);
      const currentJson     = await this._getSourceConfigJson();
      if (currentJson === cached.sourceConfigJson) {
        this._sourceUrl = cached.sourceUrl;
        this._onElementReused(cached);
        this._state    = 'ready';
        this.innerHTML = '';
        this.appendChild(cached.element);
        this._onHassUpdated(this._hass);
        this._syncEditOverlay();
        return;
      }
      _elementCache.delete(key);
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

  async _getSourceConfigJson() { return null; }
  _onElementReused(_cached)    {}
  async _doLoad()              {}

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
    const overlay = document.createElement('div');
    overlay.className = 'lc-edit-overlay';
    overlay.innerHTML = `
      <ha-icon icon="mdi:link-variant"></ha-icon>
      <span class="lc-edit-label">${label}</span>
      ${this._sourceUrl ? `<button class="lc-edit-btn">Edit source</button>` : ''}
      <style>
        .lc-edit-overlay {
          position: absolute; top: 0; left: 0; right: 0;
          display: flex; align-items: center; gap: 8px; padding: 6px 10px;
          background: var(--primary-color, #2196f3); color: #fff;
          font-size: 12px; font-weight: 500; z-index: 10;
          border-radius: var(--ha-card-border-radius, 4px) var(--ha-card-border-radius, 4px) 0 0;
          box-sizing: border-box; pointer-events: all;
        }
        .lc-edit-overlay ha-icon { --mdc-icon-size: 16px; flex-shrink: 0; }
        .lc-edit-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lc-edit-btn {
          background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.5);
          color: #fff; border-radius: 4px; padding: 2px 8px;
          font-size: 11px; cursor: pointer; flex-shrink: 0;
        }
        .lc-edit-btn:hover { background: rgba(255,255,255,0.35); }
      </style>
    `;
    if (this._sourceUrl) {
      overlay.querySelector('.lc-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        history.pushState(null, '', this._sourceUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
    }
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

  _renderError(message, urlPath) {
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
      if (urlPath !== undefined) bustDashboardCache(urlPath);
      if (this._cacheKey) _elementCache.delete(this._cacheKey);
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
    if (!config.card) throw new Error('[linked-card] card name is required.');
    if (!config.view) throw new Error('[linked-card] view is required.');
    const changed =
      this._config?.dashboard !== config.dashboard ||
      this._config?.view      !== config.view      ||
      this._config?.card      !== config.card;
    this._config = config;
    if (changed) {
      this._childCard = null;
      this._resetForConfig();
    }
  }

  _elementCacheKey() {
    const { dashboard = null, view, card } = this._config;
    return `card::${pathKey(dashboard)}::${view}::${card}`;
  }

  async _getSourceConfigJson() {
    const { dashboard = null, view: viewId, card: cardId } = this._config;
    const dashConfig = await getDashboardConfig(this._hass, dashboard);
    const view       = findViewByIdInConfig(dashConfig, viewId);
    const card       = findCardByIdInView(view, cardId);
    return card ? JSON.stringify(card) : null;
  }

  _onHassUpdated(hass) {
    if (this._childCard) this._childCard.hass = hass;
  }

  _onElementReused(cached) {
    this._childCard = cached.childCard;
  }

  async _doLoad() {
    const { dashboard = null, view: viewId, card: cardId } = this._config;
    const dashConfig = await getDashboardConfig(this._hass, dashboard);

    if (!dashConfig) {
      this._renderError('Could not load dashboard config. Is it UI-managed?', dashboard);
      this._state = 'error';
      return;
    }

    const view = findViewByIdInConfig(dashConfig, viewId);
    if (!view) {
      this._renderError(`View "${viewId}" not found.`, dashboard);
      this._state = 'error';
      return;
    }

    const cardConfig = findCardByIdInView(view, cardId);
    if (!cardConfig) {
      this._renderError(`Card "${cardId}" not found in view "${viewId}".`, dashboard);
      this._state = 'error';
      return;
    }

    const helpers = await getHelpers();
    const card    = helpers.createCardElement(cardConfig);
    card.hass     = this._hass;

    const key       = this._elementCacheKey();
    this._cacheKey  = key;
    this._sourceUrl = buildViewUrl(dashboard, view, dashConfig.views);
    this._childCard = card;

    _elementCache.set(key, {
      element:          card,
      childCard:        card,
      sourceConfigJson: JSON.stringify(cardConfig),
      sourceUrl:        this._sourceUrl,
    });

    this._state    = 'ready';
    this.innerHTML = '';
    this.appendChild(card);
  }

  getCardSize() { return this._childCard?.getCardSize?.() ?? 1; }

  static getConfigElement() { return document.createElement('linked-card-editor'); }
  static getStubConfig()    { return { dashboard: null, view: '', card: '' }; }
}

// ---------------------------------------------------------- LinkedSection ---

class LinkedSection extends LinkedBase {
  constructor() {
    super();
    this._kind       = 'section';
    this._childCards = [];
  }

  setConfig(config) {
    if (!config.section) throw new Error('[linked-section] section name is required.');
    if (!config.view)    throw new Error('[linked-section] view is required.');
    const changed =
      this._config?.dashboard !== config.dashboard ||
      this._config?.view      !== config.view      ||
      this._config?.section   !== config.section;
    this._config = config;
    if (changed) {
      this._childCards = [];
      this._resetForConfig();
    }
  }

  _elementCacheKey() {
    const { dashboard = null, view, section } = this._config;
    return `section::${pathKey(dashboard)}::${view}::${section}`;
  }

  async _getSourceConfigJson() {
    const { dashboard = null, view: viewId, section: sectionId } = this._config;
    const dashConfig = await getDashboardConfig(this._hass, dashboard);
    const view       = findViewByIdInConfig(dashConfig, viewId);
    const section    = findSectionByIdInView(view, sectionId);
    return section ? JSON.stringify(section) : null;
  }

  _onHassUpdated(hass) {
    for (const card of this._childCards) card.hass = hass;
  }

  _onElementReused(cached) {
    this._childCards = cached.childCards;
  }

  async _doLoad() {
    const { dashboard = null, view: viewId, section: sectionId } = this._config;
    const dashConfig = await getDashboardConfig(this._hass, dashboard);

    if (!dashConfig) {
      this._renderError('Could not load dashboard config. Is it UI-managed?', dashboard);
      this._state = 'error';
      return;
    }

    const view = findViewByIdInConfig(dashConfig, viewId);
    if (!view) {
      this._renderError(`View "${viewId}" not found.`, dashboard);
      this._state = 'error';
      return;
    }

    const section = findSectionByIdInView(view, sectionId);
    if (!section) {
      this._renderError(`Section "${sectionId}" not found in view "${viewId}".`, dashboard);
      this._state = 'error';
      return;
    }

    const cards = section.cards ?? [];
    if (!cards.length) {
      this._renderError(`Section "${sectionId}" has no cards.`, dashboard);
      this._state = 'error';
      return;
    }

    const helpers = await getHelpers();
    const wrapper  = document.createElement('div');
    wrapper.className = 'linked-section-wrapper';

    if (section.title) {
      const heading       = document.createElement('div');
      heading.className   = 'linked-section-title';
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

    const key       = this._elementCacheKey();
    this._cacheKey  = key;
    this._sourceUrl = buildViewUrl(dashboard, view, dashConfig.views);

    _elementCache.set(key, {
      element:          wrapper,
      childCards:       this._childCards,
      sourceConfigJson: JSON.stringify(section),
      sourceUrl:        this._sourceUrl,
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
  static getStubConfig()    { return { dashboard: null, view: '', section: '' }; }
}

// --------------------------------------------------------- shared editor ----

function buildEditor(elementName, itemField, itemsFromView, getItemId, getItemLabel) {
  class Editor extends HTMLElement {
    constructor() {
      super();
      this._config     = {};
      this._hass       = null;
      this._dashboards = [];
      this._views      = [];
      this._items      = [];
    }

    setConfig(config) {
      this._config = config;
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      this._loadDashboards();
    }

    async _loadDashboards() {
      if (!this._hass) return;
      this._dashboards = await listDashboards(this._hass);
      await this._loadViews();
    }

    async _loadViews() {
      const dashboard  = this._config.dashboard ?? null;
      const dashConfig = await getDashboardConfig(this._hass, dashboard);
      this._views      = dashConfig?.views ?? [];
      await this._loadItems();
    }

    async _loadItems() {
      const dashboard  = this._config.dashboard ?? null;
      const viewId     = this._config.view ?? '';
      const dashConfig = await getDashboardConfig(this._hass, dashboard);
      const view       = findViewByIdInConfig(dashConfig, viewId)
                         ?? dashConfig?.views?.[0]
                         ?? null;
      this._items      = view ? itemsFromView(view) : [];
      this._render();
    }

    _render() {
      const dashboard = this._config.dashboard ?? null;
      const viewId    = this._config.view    ?? '';
      const itemId    = this._config[itemField] ?? '';

      const dashOptions = this._dashboards.map((d) =>
        `<option value="${d.urlPath ?? ''}" ${(d.urlPath ?? null) === dashboard ? 'selected' : ''}>${d.title}</option>`
      ).join('') || '<option>Loading...</option>';

      const viewOptions = this._views.map((v, i) => {
        const id = getViewId(v, i);
        return `<option value="${id}" ${id === viewId ? 'selected' : ''}>${getViewLabel(v, i)}</option>`;
      }).join('') || '<option disabled>No views found</option>';

      const itemOptions = this._items.map((item, i) => {
        const id = getItemId(item, i);
        if (!id) return ''; // skip unnamed items? No - show them but note they can't be linked
        return `<option value="${id}" ${id === itemId ? 'selected' : ''}>${getItemLabel(item, i)}</option>`;
      }).filter(Boolean).join('') || '<option disabled>None found</option>';

      const itemLabel = itemField === 'card' ? 'Card' : 'Section';

      this.innerHTML = `
        <div class="lc-editor">
          <label class="lc-label">
            Dashboard
            <select class="lc-select" id="lc-dashboard">${dashOptions}</select>
          </label>
          <label class="lc-label">
            View
            <select class="lc-select" id="lc-view" ${!this._views.length ? 'disabled' : ''}>${viewOptions}</select>
          </label>
          <label class="lc-label">
            ${itemLabel}
            <select class="lc-select" id="lc-item" ${!this._items.length ? 'disabled' : ''}>${itemOptions}</select>
          </label>
          ${itemField === 'card' ? `<p class="lc-hint">Only cards with a name, title, or heading are listed. Add a <code>name</code> to any card to make it available here.</p>` : ''}
        </div>
        <style>
          .lc-editor { display: flex; flex-direction: column; gap: 12px; padding: 8px 0; font-size: 14px; }
          .lc-label { display: flex; flex-direction: column; gap: 4px; font-weight: 500; }
          .lc-hint { color: var(--secondary-text-color); font-size: 12px; margin: 0; line-height: 1.5; }
          .lc-hint code { background: var(--code-editor-background-color, #f5f5f5); padding: 1px 4px; border-radius: 3px; }
          .lc-select {
            padding: 8px; border: 1px solid var(--divider-color); border-radius: 4px;
            background: var(--card-background-color); color: var(--primary-text-color);
            font-size: 14px; width: 100%;
          }
          .lc-select:disabled { opacity: 0.5; }
        </style>
      `;

      this.querySelector('#lc-dashboard')?.addEventListener('change', async (e) => {
        const urlPath   = e.target.value === '' ? null : e.target.value;
        this._config    = { ...this._config, dashboard: urlPath, view: '', [itemField]: '' };
        this._fire();
        await this._loadViews();
      });

      this.querySelector('#lc-view')?.addEventListener('change', async (e) => {
        this._config = { ...this._config, view: e.target.value, [itemField]: '' };
        this._fire();
        await this._loadItems();
      });

      this.querySelector('#lc-item')?.addEventListener('change', (e) => {
        this._config = { ...this._config, [itemField]: e.target.value };
        this._fire();
      });
    }

    _fire() {
      this.dispatchEvent(new CustomEvent('config-changed', {
        detail: { config: { ...this._config } },
        bubbles: true,
        composed: true,
      }));
    }
  }

  customElements.define(elementName, Editor);
}

buildEditor(
  'linked-card-editor',
  'card',
  (view) => (view.cards ?? []).filter((c, i) => getCardId(c, i) !== null),
  getCardId,
  getCardLabel
);

buildEditor(
  'linked-section-editor',
  'section',
  (view) => (view.sections ?? []).filter((s, i) => getSectionId(s, i) !== null),
  getSectionId,
  getSectionLabel
);

// ---------------------------------------------------------------- register --

customElements.define('linked-card',    LinkedCard);
customElements.define('linked-section', LinkedSection);

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: 'linked-card',
    name: 'Linked Card',
    description: 'Pick any named card from any dashboard and mirror it here. Edit the source and all copies update instantly.',
    preview: false,
    documentationURL: 'https://github.com/Alpacinator/lovelace-linked-cards',
  },
  {
    type: 'linked-section',
    name: 'Linked Section',
    description: 'Pick any section from any dashboard and mirror all its cards here. Edit the source and all copies update instantly.',
    preview: false,
    documentationURL: 'https://github.com/Alpacinator/lovelace-linked-cards',
  }
);

console.info(
  `%c LINKED-CARDS %c v${PLUGIN_VERSION} `,
  'background:#2196f3;color:#fff;font-weight:bold;padding:2px 4px;border-radius:3px 0 0 3px',
  'background:#1565c0;color:#fff;padding:2px 4px;border-radius:0 3px 3px 0'
);

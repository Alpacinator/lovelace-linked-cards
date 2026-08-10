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
const PLUGIN_VERSION = '2.6.3';

// ----------------------------------------------------------------- version check --
// Compares the running version against the last seen version in localStorage.
// If they differ, a persistent HA notification is created asking the user to reload.
// This catches the case where HACS updated the file but the app state is stale.
const LC_VERSION_KEY = 'linked-cards-plugin-version';
try {
  const lastVersion = localStorage.getItem(LC_VERSION_KEY);
  if (lastVersion && lastVersion !== PLUGIN_VERSION) {
    console.info(
      `[linked-cards] Updated from v${lastVersion} to v${PLUGIN_VERSION}. ` +
      `A full page reload is recommended.`
    );
    // We don't have hass yet at module load time, so store a flag and notify later
    localStorage.setItem('linked-cards-needs-reload', '1');
  }
  localStorage.setItem(LC_VERSION_KEY, PLUGIN_VERSION);
} catch (_) {}

// ------------------------------------------------------------------ helpers --

// Guard against passing a partially initialized hass object to child cards.
// card-mod crashes if hass.auth is undefined, which can happen during HA startup
// or view transitions. Only pass hass through if it looks complete.
function isHassReady(hass) {
  return hass && hass.auth && hass.states && hass.callWS;
}

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
  return card.name || card.title || card.heading || `${card.type || 'card'}::${index}`;
}

function isCardIdGenerated(id) {
  // Returns true if the id is a generated fallback, not a real name
  return id && id.includes('::');
}

function getSectionId(section, index) {
  return section.title || `section::${index}`;
}

function isSectionIdGenerated(id) {
  return id && id.startsWith('section::');
}

function getViewLabel(view, index) {
  return view.title || view.path || `View ${index + 1}`;
}

function getDashboardLabel(urlPath) {
  return urlPath === null || urlPath === undefined ? 'Default' : urlPath;
}

function getCardLabel(card, index) {
  // For linked cards, show dashboard > view > card
  if (card.type === 'custom:linked-card') {
    if (!card.view && !card.card) return 'Linked card (not configured)';
    const dash = getDashboardLabel(card.dashboard ?? null);
    const parts = [dash, card.view, card.card].filter(Boolean);
    return parts.join(' > ');
  }
  // For linked sections, show dashboard > view > section (or card names)
  if (card.type === 'custom:linked-section') {
    if (!card.view && !card.section) return 'Linked section (not configured)';
    const dash = getDashboardLabel(card.dashboard ?? null);
    const parts = [dash, card.view, card.section].filter(Boolean);
    return parts.join(' > ');
  }
  return card.name
    || card.title
    || card.heading
    || (card.entity ? `${card.type} (${card.entity})` : null)
    || `${card.type || 'card'} #${index + 1} (unnamed - add a name to link this card)`;
}

function getSectionLabel(section, index) {
  if (section.title) return section.title;
  const cards = section.cards ?? [];
  const names = cards
    .map((c) => c.name || c.title || c.heading || null)
    .filter(Boolean)
    .slice(0, 3);
  if (names.length) {
    return `Section ${index + 1}: ${names.join(', ')}${cards.length > 3 ? ', ...' : ''}`;
  }
  return `Section ${index + 1} (${cards.length} card${cards.length !== 1 ? 's' : ''})`;
}

function findViewByIdInConfig(dashConfig, viewId) {
  return (dashConfig?.views ?? []).find((v, i) => getViewId(v, i) === viewId) ?? null;
}

function findCardByIdInView(view, cardId) {
  // Search top-level cards first
  const inCards = (view?.cards ?? []).find((c, i) => getCardId(c, i) === cardId);
  if (inCards) return inCards;
  // Also search inside sections (sections layout)
  for (const section of view?.sections ?? []) {
    const inSection = (section.cards ?? []).find((c, i) => getCardId(c, i) === cardId);
    if (inSection) return inSection;
  }
  return null;
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

// -------------------------------------------------------- reload notification --

let _reloadNotified = false;
function _notifyReloadIfNeeded(hass) {
  if (_reloadNotified) return;
  try {
    if (localStorage.getItem('linked-cards-needs-reload') !== '1') return;
    _reloadNotified = true;
    localStorage.removeItem('linked-cards-needs-reload');
    hass.callService('persistent_notification', 'create', {
      title: 'Linked Cards updated',
      message: `Linked Cards was updated to v${PLUGIN_VERSION}. Please do a hard refresh to avoid issues with cached files. Windows/Linux: Ctrl+Shift+R. Mac: Cmd+Shift+R.`,
      notification_id: 'linked_cards_update',
    });
  } catch (_) {}
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
    _notifyReloadIfNeeded(hass);
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
        setTimeout(() => {
          history.pushState(null, '', this._sourceUrl);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, 100);
      });
    }
    this.style.position = 'relative';
    this.style.display  = 'block';
    this.insertBefore(overlay, this.firstChild);
  }

  _renderPlaceholder(message) {
    this.innerHTML = `
      <ha-card>
        <div class="lc-message">
          <ha-icon icon="mdi:link-variant"></ha-icon>
          <span>${message}</span>
        </div>
      </ha-card>
      ${sharedStyles()}
    `;
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
    if (this._childCard && isHassReady(hass)) this._childCard.hass = hass;
  }

  _onElementReused(cached) {
    this._childCard = cached.childCard;
  }

  async _doLoad() {
    const { dashboard = null, view: viewId, card: cardId } = this._config;

    if (!cardId || !viewId) {
      this._renderPlaceholder('Select a dashboard, view, and card in the editor.');
      this._state = 'ready';
      return;
    }

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
    if (isHassReady(this._hass)) card.hass = this._hass;

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
    if (isHassReady(hass)) for (const card of this._childCards) card.hass = hass;
  }

  _onElementReused(cached) {
    this._childCards = cached.childCards;
  }

  async _doLoad() {
    const { dashboard = null, view: viewId, section: sectionId } = this._config;

    if (!sectionId || !viewId) {
      this._renderPlaceholder('Select a dashboard, view, and section in the editor.');
      this._state = 'ready';
      return;
    }

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
      if (isHassReady(this._hass)) card.hass = this._hass;
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
      this._error      = null;
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
      this._error = null;
      try {
        this._dashboards = await listDashboards(this._hass);
      } catch (e) {
        this._error = `Could not list dashboards: ${e.message}`;
        this._render();
        return;
      }
      await this._loadViews();
    }

    async _loadViews() {
      const dashboard = this._config.dashboard ?? null;
      let dashConfig;
      try {
        dashConfig = await getDashboardConfig(this._hass, dashboard);
      } catch (e) {
        this._error = `Could not load dashboard: ${e.message}`;
        this._render();
        return;
      }
      if (!dashConfig) {
        this._error = 'Dashboard returned no config. Make sure it is UI-managed (not YAML mode).';
        this._render();
        return;
      }
      this._error  = null;
      this._views  = dashConfig?.views ?? [];
      await this._loadItems();
    }

    async _loadItems() {
      const dashboard  = this._config.dashboard ?? null;
      const viewId     = this._config.view ?? '';
      let dashConfig;
      try {
        dashConfig = await getDashboardConfig(this._hass, dashboard);
      } catch (e) {
        this._error = `Could not load dashboard: ${e.message}`;
        this._render();
        return;
      }
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
        if (!id) return '';
        return `<option value="${id}" ${id === itemId ? 'selected' : ''}>${getItemLabel(item, i)}</option>`;
      }).filter(Boolean).join('') || '<option disabled>None found</option>';

      const itemPlaceholder = `<option value="" ${!itemId ? 'selected' : ''} disabled>-- select a ${itemField === 'card' ? 'card' : 'section'} --</option>`;

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
            <select class="lc-select" id="lc-item" ${!this._items.length ? 'disabled' : ''}>${itemPlaceholder}${itemOptions}</select>
          </label>
          ${itemField === 'card' ? `<p class="lc-hint">Only cards with a name, title, or heading are listed. Add a <code>name</code> to any card to make it available here.</p>` : ''}
          ${viewId && itemId ? `
            <button class="lc-goto-btn" id="lc-goto">Go to source view</button>
            ${itemField === 'card' ? '<button class="lc-goto-btn lc-edit-btn-editor" id="lc-open-editor">Open card in visual editor</button>' : ''}
          ` : ''}
          ${this._error ? `
            <div class="lc-error-box">
              <strong>Error loading dashboards</strong>
              <p>${this._error}</p>
              <button class="lc-retry-btn">Retry</button>
            </div>
          ` : ''}

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
          .lc-error-box {
            background: var(--error-color, #db4437); color: #fff;
            padding: 10px 12px; border-radius: 4px; font-size: 12px;
          }
          .lc-error-box p { margin: 4px 0 8px; opacity: 0.9; }
          .lc-error-box strong { font-size: 13px; }
          .lc-retry-btn {
            background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.5);
            color: #fff; border-radius: 4px; padding: 3px 10px;
            font-size: 12px; cursor: pointer;
          }
          .lc-retry-btn:hover { background: rgba(255,255,255,0.35); }
          .lc-goto-btn {
            background: none; border: 1px solid var(--primary-color, #2196f3);
            color: var(--primary-color, #2196f3); border-radius: 4px;
            padding: 6px 12px; font-size: 13px; cursor: pointer; width: 100%;
          }
          .lc-goto-btn:hover { background: var(--primary-color, #2196f3); color: #fff; }

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

      this.querySelector('.lc-retry-btn')?.addEventListener('click', () => {
        // Bust the dashboard cache so we actually re-fetch
        const dashboard = this._config.dashboard ?? null;
        bustDashboardCache(dashboard);
        this._error = null;
        this._loadDashboards();
      });



      this.querySelector('#lc-goto')?.addEventListener('click', async () => {
        const dashboard  = this._config.dashboard ?? null;
        const viewId     = this._config.view ?? '';
        const dashConfig = await getDashboardConfig(this._hass, dashboard);
        const view       = findViewByIdInConfig(dashConfig, viewId);
        if (!view) return;

        const url = buildViewUrl(dashboard, view, dashConfig.views);
        history.pushState(null, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));

        setTimeout(() => {
          try {
            const root = document
              .querySelector('home-assistant')
              ?.shadowRoot?.querySelector('home-assistant-main')
              ?.shadowRoot?.querySelector('ha-panel-lovelace')
              ?.shadowRoot?.querySelector('hui-root');
            if (root) {
              root.dispatchEvent(new CustomEvent('ll-edit-mode-changed', {
                detail: { value: true },
                bubbles: true,
                composed: true,
              }));
            }
          } catch (_) {}
        }, 300);
      });

      this.querySelector('#lc-open-editor')?.addEventListener('click', async () => {
        const dashboard  = this._config.dashboard ?? null;
        const viewId     = this._config.view ?? '';
        const cardId     = this._config[itemField] ?? '';
        const dashConfig = await getDashboardConfig(this._hass, dashboard);
        const view       = findViewByIdInConfig(dashConfig, viewId);
        if (!view) return;

        // Navigate to the source view
        const url = buildViewUrl(dashboard, view, dashConfig.views);
        console.log('[linked-cards] Navigating to source view:', url);
        setTimeout(() => {
          history.pushState(null, '', url);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }, 100);

        setTimeout(() => {
          try {
            const ha       = document.querySelector('home-assistant');
            const haMain   = ha?.shadowRoot?.querySelector('home-assistant-main');
            const haPanel  = haMain?.shadowRoot?.querySelector('ha-panel-lovelace');
            const huiRoot  = haPanel?.shadowRoot?.querySelector('hui-root');

            console.log('[linked-cards] Shadow DOM traversal:');
            console.log('  home-assistant:      ', ha      ? 'found' : 'NOT FOUND');
            console.log('  home-assistant-main: ', haMain  ? 'found' : 'NOT FOUND');
            console.log('  ha-panel-lovelace:   ', haPanel ? 'found' : 'NOT FOUND');
            console.log('  hui-root:            ', huiRoot ? 'found' : 'NOT FOUND');

            if (!huiRoot) {
              console.warn('[linked-cards] Could not find hui-root - edit mode and card editor unavailable');
              return;
            }

            // Enter edit mode
            // HA's lovelace property is on huiRoot.lovelace (no underscore).
            // Edit mode is set by replacing the lovelace object with editMode: true.
            console.log('[linked-cards] Attempting to enter edit mode...');

            const lovelace = huiRoot.lovelace ?? haPanel?.lovelace;
            console.log('[linked-cards] lovelace found:', !!lovelace, 'keys:', lovelace ? Object.keys(lovelace).join(', ') : 'none');

            if (lovelace) {
              if (typeof lovelace.setEditMode === 'function') {
                console.log('[linked-cards] Calling lovelace.setEditMode(true)');
                lovelace.setEditMode(true);
              } else {
                // Set editMode directly on the lovelace object and reassign
                console.log('[linked-cards] Setting lovelace.editMode = true directly');
                lovelace.editMode = true;
                if (huiRoot.lovelace) huiRoot.lovelace = { ...lovelace, editMode: true };
              }
            } else {
              console.warn('[linked-cards] No lovelace object found on hui-root or ha-panel-lovelace');
            }

            // Find card index
            const views     = dashConfig.views ?? [];
            const viewIndex = views.indexOf(view);
            let cardIndex   = (view.cards ?? []).findIndex((c, i) => getCardId(c, i) === cardId);
            let path;

            if (cardIndex !== -1) {
              path = [viewIndex, cardIndex];
              console.log('[linked-cards] Card found in view.cards at index', cardIndex, '- path:', path);
            } else {
              const sections = view.sections ?? [];
              for (let si = 0; si < sections.length; si++) {
                cardIndex = (sections[si].cards ?? []).findIndex((c, i) => getCardId(c, i) === cardId);
                if (cardIndex !== -1) {
                  path = [viewIndex, si, cardIndex];
                  console.log('[linked-cards] Card found in section', si, 'at index', cardIndex, '- path:', path);
                  break;
                }
              }
            }

            if (!path) {
              console.warn('[linked-cards] Could not find card with id:', cardId, 'in view:', viewId);
              return;
            }

            setTimeout(() => {
              try {
                const huiView = huiRoot.shadowRoot?.querySelector('hui-sections-view')
                  || huiRoot.shadowRoot?.querySelector('hui-view')
                  || huiRoot.shadowRoot?.querySelector('hui-masonry-view');

                console.log('[linked-cards] hui-view element:', huiView ? huiView.tagName : 'NOT FOUND');
                console.log('[linked-cards] hui-view _lovelace:', !!(huiView?._lovelace));

                const target         = huiView ?? huiRoot;
                const pathWithinView = path.slice(1);
                console.log('[linked-cards] Firing ll-edit-card on', target.tagName, 'with path:', pathWithinView);

                // Fire on the view element
                target.dispatchEvent(new CustomEvent('ll-edit-card', {
                  detail: { path: pathWithinView }, bubbles: true, composed: true,
                }));

                // Also try finding the specific hui-card element and clicking
                // its edit button directly, since ll-edit-card on the view may
                // not be handled in sections layout
                try {
                  const sectionIndex = pathWithinView.length === 2 ? pathWithinView[0] : 0;
                  const cardIndex    = pathWithinView[pathWithinView.length - 1];

                  // hui-section has its own shadow DOM, so we need to pierce into it
                  const sections = huiView?.shadowRoot?.querySelectorAll('hui-section');
                  console.log('[linked-cards] Sections found:', sections?.length ?? 0);

                  const sectionEl = sections?.[sectionIndex];
                  console.log('[linked-cards] Target section:', sectionEl ? sectionEl.tagName : 'NOT FOUND');

                  // Cards are inside hui-section's shadow DOM
                  const cards = sectionEl?.shadowRoot?.querySelectorAll('hui-card');
                  console.log('[linked-cards] hui-card elements in section:', cards?.length ?? 0);

                  const cardEl = cards?.[cardIndex];
                  console.log('[linked-cards] Target hui-card:', cardEl ? 'found' : 'NOT FOUND');

                  if (cardEl) {
                    // Fire ll-edit-card on the card element
                    cardEl.dispatchEvent(new CustomEvent('ll-edit-card', {
                      detail: { path: pathWithinView }, bubbles: true, composed: true,
                    }));

                    // Try clicking the edit button directly
                    const editBtn = cardEl.shadowRoot?.querySelector('ha-icon-button');
                    console.log('[linked-cards] Edit button in hui-card shadow:', editBtn ? 'found' : 'NOT FOUND');
                    editBtn?.click();
                  }
                } catch (e) {
                  console.error('[linked-cards] Error finding hui-card:', e);
                }
              } catch (e) {
                console.error('[linked-cards] Error firing ll-edit-card:', e);
              }
            }, 500);

          } catch (e) {
            console.error('[linked-cards] Error while trying to open card editor:', e);
          }
        }, 300);
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
  (view) => {
    // Collect cards from top-level and from inside sections
    const topLevel = view.cards ?? [];
    const inSections = (view.sections ?? []).flatMap((s) => s.cards ?? []);
    return [...topLevel, ...inSections];
  },
  getCardId,
  getCardLabel
);

buildEditor(
  'linked-section-editor',
  'section',
  (view) => view.sections ?? [],
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

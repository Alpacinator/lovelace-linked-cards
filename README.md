# Linked Cards

A [HACS](https://hacs.xyz) Lovelace plugin for Home Assistant.

Define a card or an entire section once and reference it from any number of dashboards or views.
When you edit the source, every linked copy reflects the change immediately.

---

## Card types

| Type | Links | Identified by |
|---|---|---|
| `custom:linked-card` | A single card | `card_id` on the source card |
| `custom:linked-section` | All cards in a section | `section_id` on the source section |

---

## Installation

### Via HACS (recommended)

1. Open HACS in your Home Assistant instance.
2. Go to **Frontend**.
3. Click the three-dot menu and choose **Custom repositories**.
4. Add `https://github.com/Alpacinator/lovelace-linked-cards` with category **Dashboard**.
5. Install **Linked Cards** and reload your browser.

### Manual

1. Copy `linked-card.js` to `<config>/www/linked-card/linked-card.js`.
2. In **Settings > Dashboards > Resources**, add:
   - URL: `/local/linked-card/linked-card.js`
   - Resource type: **JavaScript module**
3. Reload your browser.

---

## Usage: linked-card

### Mark a source card

Add `card_id` to any card via the raw config editor:

```yaml
type: entities
card_id: living-room-sensors
title: Living Room
entities:
  - sensor.temperature
  - sensor.humidity
```

The `card_id` field is ignored by Home Assistant itself, so the card works normally.

### Place a linked copy

```yaml
type: custom:linked-card
linked_card_id: living-room-sensors
```

---

## Usage: linked-section

Useful when you use the **Sections** view layout and want to mirror a whole column of cards across dashboards.

### Mark a source section

Add `section_id` to any section in a sections-layout view via the raw config editor:

```yaml
views:
  - type: sections
    sections:
      - section_id: bedroom-controls
        title: Bedroom
        cards:
          - type: light
            entity: light.bedroom_ceiling
          - type: entities
            entities:
              - sensor.bedroom_temperature
              - sensor.bedroom_humidity
```

### Place a linked copy (as a card)

On any other dashboard or view, drop a `custom:linked-section` card. It renders each card from the source section stacked vertically, and inherits the section title if one is set.

```yaml
type: custom:linked-section
linked_section_id: bedroom-controls
```

---

## Configuration reference

### custom:linked-card

| Option | Type | Required | Description |
|---|---|---|---|
| `linked_card_id` | string | yes | The `card_id` of the source card to render. |

### custom:linked-section

| Option | Type | Required | Description |
|---|---|---|---|
| `linked_section_id` | string | yes | The `section_id` of the source section whose cards to render. |

---

## Limitations

- Only UI-managed (storage-mode) dashboards are searchable. YAML-mode dashboards cannot be read via the WebSocket API.
- The source card for `linked-card` cannot itself be a `custom:linked-card` (circular references are blocked).
- Linked copies inherit the source config at render time. Per-instance UI state (open/close toggles, selected tabs, etc.) is independent.
- `linked-section` renders cards in a vertical stack regardless of the column layout of the source section.

---

## License

MIT - see [LICENSE](https://github.com/Alpacinator/lovelace-linked-cards/blob/main/LICENSE)

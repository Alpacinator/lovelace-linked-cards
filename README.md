<h1 align="center">Linked Cards</h1>
<p align="center">
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-orange.svg" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/releases"><img src="https://img.shields.io/github/v/release/Alpacinator/lovelace-linked-cards" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Alpacinator/lovelace-linked-cards" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/stargazers"><img src="https://img.shields.io/github/stars/Alpacinator/lovelace-linked-cards" /></a>
</p>
<p align="center">
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=Alpacinator&repository=lovelace-linked-cards&category=dashboard">
    <img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Add to HACS" />
  </a>
</p>
<p align="center">Create and define a card or section once. Reference and mirror it from anywhere. Edit the source and every linked copy updates instantly.</p>

## Card types

| Type | Role | Identified by |
|---|---|---|
| `custom:linked-card-source` | Defines the source card | `card_id` on the wrapper |
| `custom:linked-card` | Renders a linked copy of the source | `linked_card_id` |
| `custom:linked-section` | Renders all cards from a source section | `linked_section_id` |

## Quick start

Wrap any card with `custom:linked-card-source` and give it a `card_id`:

```yaml
type: custom:linked-card-source
card_id: my-card
card:
  type: entities
  entities:
    - sensor.temperature
```

Or label any existing section with a `section_id`:

```yaml
section_id: my-section
cards:
  - ...
```

Then place a linked copy anywhere using that name:

```yaml
type: custom:linked-card
linked_card_id: my-card
```

```yaml
type: custom:linked-section
linked_section_id: my-section
```

## Installation

### Via HACS (recommended)

1. Open HACS in your Home Assistant instance
2. Go to **Frontend**
3. Click the three-dot menu and choose **Custom repositories**
4. Add `https://github.com/Alpacinator/lovelace-linked-cards` with category **Dashboard**
5. Install **Linked Cards** and reload your browser

### Manual

1. Copy `linked-card.js` to `<config>/www/linked-card/linked-card.js`
2. In **Settings > Dashboards > Resources** add `/local/linked-card/linked-card.js` as a **JavaScript module**
3. Reload your browser

## Usage

### Adding a card via the UI

Both **Linked Card** and **Linked Section** appear in the Home Assistant card picker. After selecting one, the visual editor shows a dropdown of all `card_id` or `section_id` values it finds across your dashboards. Just pick the source from the list and the card is ready.

> [!NOTE]
> The dropdown only shows IDs from UI-managed (storage-mode) dashboards. YAML-mode dashboards are not readable via the WebSocket API.

### custom:linked-card-source

Wrap any card to give it a `card_id`. This is the recommended way to define a source card as it works fully with the visual editor:

```yaml
type: custom:linked-card-source
card_id: living-room-sensors
card:
  type: entities
  title: Living Room
  entities:
    - sensor.temperature
    - sensor.humidity
```

### custom:linked-card

Place a linked copy anywhere on any dashboard:

```yaml
type: custom:linked-card
linked_card_id: living-room-sensors
```

### custom:linked-section

Add `section_id` to any section in a sections-layout view:

```yaml
section_id: bedroom-controls
title: Bedroom
cards:
  - type: light
    entity: light.bedroom_ceiling
  - type: entities
    entities:
      - sensor.bedroom_temperature
```

Then place a linked copy anywhere as a card:

```yaml
type: custom:linked-section
linked_section_id: bedroom-controls
```

## Options

### custom:linked-card

| Option | Type | Required | Description |
|---|---|---|---|
| `linked_card_id` | string | yes | The `card_id` of the source card |

### custom:linked-section

| Option | Type | Required | Description |
|---|---|---|---|
| `linked_section_id` | string | yes | The `section_id` of the source section |

## Limitations

> [!WARNING]
> The source card for `custom:linked-card` cannot itself be a `custom:linked-card`. Circular references are blocked.

> [!TIP]
> `custom:linked-section` renders cards in a vertical stack regardless of the column layout of the source section. This is expected behaviour.

## License

MIT - see [LICENSE](https://github.com/Alpacinator/lovelace-linked-cards/blob/main/LICENSE)

<h1 align="center">Linked Cards</h1>

<p align="center">
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-orange.svg" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/releases"><img src="https://img.shields.io/github/v/release/Alpacinator/lovelace-linked-cards" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Alpacinator/lovelace-linked-cards" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/stargazers"><img src="https://img.shields.io/github/stars/Alpacinator/lovelace-linked-cards" /></a>
</p>

<p align="center">Define a card or section once. Reference it from anywhere. Edit the source and every linked copy updates instantly.</p>

---

## Card types

| Type | What it links | Source marker |
|---|---|---|
| `custom:linked-card` | A single card | `card_id` on the source card |
| `custom:linked-section` | All cards in a section | `section_id` on the source section |

---

## Quick start

Label any existing card with a `card_id`:

```yaml
type: entities
card_id: my-card
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

---

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

---

## Usage

### custom:linked-card

Add `card_id` to any existing card to make it the source:

```yaml
type: entities
card_id: living-room-sensors
title: Living Room
entities:
  - sensor.temperature
  - sensor.humidity
```

Then place a linked copy anywhere on any dashboard:

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

---

## Options

### custom:linked-card

| Option | Type | Required | Description |
|---|---|---|---|
| `linked_card_id` | string | yes | The `card_id` of the source card |

### custom:linked-section

| Option | Type | Required | Description |
|---|---|---|---|
| `linked_section_id` | string | yes | The `section_id` of the source section |

---

## Limitations

> [!NOTE]
> Only **UI-managed (storage-mode) dashboards** are searchable. YAML-mode dashboards cannot be read via the WebSocket API.

> [!WARNING]
> The source card for `custom:linked-card` cannot itself be a `custom:linked-card` — circular references are blocked.

> [!TIP]
> `custom:linked-section` renders cards in a vertical stack regardless of the column layout of the source section. This is expected behaviour.

---

## License

MIT - see [LICENSE](https://github.com/Alpacinator/lovelace-linked-cards/blob/main/LICENSE)

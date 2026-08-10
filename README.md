<h1 align="center">Linked Cards</h1>
<p align="center">
  <a href="https://github.com/hacs/integration"><img src="https://img.shields.io/badge/HACS-Custom-orange.svg" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Alpacinator/lovelace-linked-cards" /></a>
  <a href="https://github.com/Alpacinator/lovelace-linked-cards/stargazers"><img src="https://img.shields.io/github/stars/Alpacinator/lovelace-linked-cards" /></a>
</p>
<p align="center">
  <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=Alpacinator&repository=lovelace-linked-cards&category=dashboard">
    <img src="https://my.home-assistant.io/badges/hacs_repository.svg" alt="Add to HACS" />
  </a>
</p>
<p align="center">Mirror any card or section across multiple dashboards. No markers or wrappers needed. The source stays a completely normal card.</p>

## Installation

1. Click the button above to open HACS, or add this repository manually under **HACS > Frontend > Custom repositories** with category **Dashboard**
2. Install **Linked Cards** and reload your browser

## Usage

### Prepare the source card

Give the card you want to mirror a `name`. You can hide it visually with `show_name: false` if you don't want it displayed:

```yaml
type: entities
name: my-living-room-card
show_name: false
entities:
  - sensor.temperature
```

For sections, just make sure the section has a `title`.

### Add a linked copy

Add a **Linked Card** or **Linked Section** from the card picker. The visual editor shows three dropdowns:

1. **Dashboard** - pick which dashboard the source lives on
2. **View** - pick which view within that dashboard
3. **Card / Section** - pick the card or section by name

The source card is never modified. It stays a completely normal card and the visual editor works on it as usual.

### Edit mode

When editing a dashboard, linked cards show a blue **Edit source** button that takes you directly to the view where the source is defined.

> [!NOTE]
> Only UI-managed (storage-mode) dashboards are supported. YAML-mode dashboards cannot be read.

> [!NOTE]
> Only cards with a `name`, `title`, or `heading` appear in the card picker. Cards without a name cannot be linked.

## License

MIT - see [LICENSE](https://github.com/Alpacinator/lovelace-linked-cards/blob/main/LICENSE)

# Three D Graph View

Three D Graph View is an Obsidian plugin that adds a rotatable, graph-style view for exploring notes, links, backlinks, tags, and vault growth over time.

## Features

- Rotate, pan, and zoom through a 3D vault graph.
- Core-to-surface spherical layout for a globe-like graph volume.
- Optional tag nodes with per-tag colors and muted sub-tag inheritance.
- Hover highlighting for a node and its direct connections.
- Timelapse replay based on note creation order.
- Settings for labels, unresolved links, backlinks, tag visibility, disconnected group spread, node size, and sphere strength.

## Usage

Open the command palette and run **Open 3D graph view**. The graph toolbar includes refresh, fit, settings, and timelapse controls.

## Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from a release and copy them into:

```text
<vault>/.obsidian/plugins/three-d-graph-view/
```

Then enable **Three D Graph View** in Obsidian's community plugin settings.

## Development

```bash
npm install
npm run dev
```

For a production bundle:

```bash
npm run build
```

## License

MIT

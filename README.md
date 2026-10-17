# Krupashree's Site

Life and tools of Krupashree — a personal site hosted on GitHub Pages.

## Pages

- **Home** — an enchanted, Hogwarts-meets-Fearless birthday timeline at https://krupashree1996.github.io/
- **PDF Tools** — a single-file, offline PDF toolkit for merging and compressing PDFs, at [pdf-tools.html](pdf-tools.html)
- **IPO Tracker** — an offline PWA for tracking Indian IPO applications and allotments, at [ipo/](ipo/)
- **Neu-Tracker** — a multi-card credit-card statement tracker (Tata Neu Infinity + Axis Scapia): PDF import + verify, manual ledger with NeuCoins prediction (UPI split 1% app / 0.5% statement), due board & unbilled on Home. Offline PWA at [neu-tracker/](neu-tracker/); spec in [neu-tracker/REQUIREMENTS.md](neu-tracker/REQUIREMENTS.md)
- **Investments** — an offline PWA for tracking investments, at [investments/](investments/)
- **TN Utilities** — an offline PWA for tracking TN utility bills, at [tn-utilities/](tn-utilities/)

## Tech

Plain HTML/CSS/JS, no build step. The timeline content is loaded from [data/timeline.json](data/timeline.json). GitHub Actions ([.github/workflows/static.yml](.github/workflows/static.yml)) deploys every push to `main`.

## License

[MIT](LICENSE)
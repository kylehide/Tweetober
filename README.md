# Tweetober 5

- `index.html` — the whole site (layout, styles, and the code that reads the Google Sheet).
- `assets/` — the images. Swap any file for a new one with the same name and it updates on the site.

| File | Used for |
|---|---|
| `assets/banner.png` | Title banner at the top (transparent PNG, about 1100×211) |
| `assets/crest.png` | Tweetober crest in The Decree and the footer |
| `assets/emblem-333.png`, `assets/emblem-500.png` | The house emblems on the house cards (shown at 74×96, so any portrait-shaped image works) |
| `assets/head-333.jpg`, `assets/head-500.jpg` | Heads of House profile pictures (square) |
| `assets/stone.jpg` | Background tile (seamless, 900×900) |

To use a differently named image, say a new house crest, put it in `assets/` and change the
matching `emblem:` or `avatar:` line inside `CONFIG` → `houses` in `index.html`.

## Settings

Open `index.html` and look for `const CONFIG = {` near the top of the `<script>` block.

- `listId` — the numeric ID from `x.com/i/lists/<ID>`. Fill this in and the live feed turns on.
- `docUrl` — the link the "Open the Ledger" button opens.
- `sheetCsvUrl`, `trophyCsvUrl`, `eventsCsvUrl` — CSV feeds for the Ledger sheet and its
  `Trophy Room` and `Events` tabs. Only change these if the sheet moves.
- `refreshMinutes` — how often the page re-reads the sheet (default 5).
- `boardSize` — how many names on the Scroll of Honor (default 10).
- `houses` — names, mottos, Heads of House, images and fallback rosters.

Sheet layout the page expects:

- **Ledger tab (first tab):** Handle | House | Oct 1 … Oct 31 with Tally columns after the 5th, 10th, 15th, 20th, 25th, and a Final tally after the 31st | Grand total.
- **Trophy Room tab:** Link | Handle | House | Honor | Tweet text. A Link alone embeds the tweet.
- **Events tab:** Name | Date | Time | Place | Note | Link.

The background darkness is the `.7` in `rgba(20, 14, 8, .7)` near the top of the `<style>` block.

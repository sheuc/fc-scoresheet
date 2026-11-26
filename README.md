<p align="center">
  <img src="web/logo.svg" alt="FC Scoresheet logo" width="96">
</p>

<h1 align="center">FC Scoresheet</h1>

<p align="center">
  Turn your EA SPORTS FC Mobile match screenshots into a goal tally, season stats and a shareable card.<br>
  Runs entirely in your browser: your screenshots never leave your device.
</p>

<p align="center">
  <a href="https://sheuc.github.io/fc-scoresheet/"><strong>Open the app</strong></a>
</p>

> **Unofficial fan tool.** Not made by, or affiliated with, EA or EA SPORTS. "FC Mobile" is used only to say which game it reads.

## What it does

1. **Drop in your post-match screenshots** (50-100 at a time is fine).
2. It reads every goal: who scored and when. It also reads the match-stats screen (shots, possession, pass accuracy and so on). Both the original and the redesigned match screens are recognised automatically.
3. **Check the results**, remove or adjust anything that is wrong, and press **Confirm**.
4. **Save to your spreadsheet.** Start a new Excel file or upload your existing one. Saving never double-counts a game you have already recorded.

You also get:

- **Stats:** averages per game, team record and win rate, shot accuracy, biggest win and heaviest defeat, comeback wins, hat-tricks, and who is most clutch in stoppage time.
- **A share card:** a 4:5 image of your top scorers and key stats to download, share or copy, with your own title and a dark or light look.

## Privacy

There is no server and no account. The OCR engine runs in your browser, your images are never uploaded, and your spreadsheet stays on your device. Share-card choices are remembered in your browser only. After the first visit the app also works offline.

## Run it locally

You need [Node.js](https://nodejs.org/) (only for development; visitors need nothing).

```
cd web
npm install
npm run vendor     # copies the OCR engine, ExcelJS and the English model into vendor/
npm run serve      # http://localhost:8080
```

Opening `index.html` straight from disk will not work, because browsers block web workers on `file://`. Use the server above.

## Deploy

`npm run build` (in `web/`) writes a self-contained `dist/` of about 14 MB. Any static host works. This repository publishes it to GitHub Pages with the workflow in `.github/workflows/deploy.yml`: set **Settings → Pages → Source** to **GitHub Actions** and every push to `main` redeploys.

## What the stats mean

- **Team record:** games played, wins, draws, losses, win rate (wins divided by games played), goals for and against, clean sheets, comeback wins and hat-tricks.
- **Averages per game** for you and your opponents: goals, shots, shots on target, possession, pass accuracy, fouls and offsides. These use the games that have a match-stats screenshot.
- **Shooting:** shot accuracy (shots on target / shots) and conversion (goals / shots).
- **Biggest win and heaviest defeat** by goal margin.
- **Hat-tricks:** players ranked by matches with three or more goals.
- **Most clutch players:** ranked by stoppage-time goals (90'+) that won the game or levelled the score.

Your spreadsheet keeps a visible **Stats** sheet and a few hidden helper sheets. They are how the app remembers which games it has already counted, so please leave them in place.

## Built with

[Tesseract.js](https://github.com/naptha/tesseract.js) for OCR, [ExcelJS](https://github.com/exceljs/exceljs) for spreadsheets, the HTML Canvas for the share card, and the [Inter](https://rsms.me/inter/) font (SIL Open Font License).

## Known limits

- Tuned on screenshots from one phone. Other phones, aspect ratios and languages are only simulated so far, so expect the odd misread: that is what the Confirm step is for.
- The share sheet needs https on a phone (it works on the deployed site, not on a plain-http local address).

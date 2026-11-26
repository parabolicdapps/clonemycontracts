# @cmc/web

The CloneMyContracts tool UI: plain HTML, CSS and ES modules, served by `apps/api`. `viem` is the only runtime dependency and is bundled locally with esbuild into `dist/app.js` (no CDN, no external fonts, no inline scripts).

- `public/styles.css` holds the app's base stylesheet and tool components in the same cascade layers and tokens, with theme persistence via the `cmc-theme` storage key.
- `src/` holds `main.js` (flow), `render.js`, `wallet.js` (EIP-6963 + EIP-1193), `api.js`, `args.js`, `dom.js`.
- `npm run build -w @cmc/web` writes `dist/`. State lives in the URL: `?address=&from=&to=&set=key=value`.

# Choice Wallet UI

The wallet's screens, in React, shared by every platform: the Chrome extension now, the
desktop app (Tauri) and mobile later. Pre-alpha: not for real funds.

Licensed GPL-3.0 ([LICENSE](LICENSE)).

## How a platform uses it

```ts
import { mount, type Backend } from "@choice-wallet/ui";

const backend: Backend = {
  send: (request) => /* deliver to the host, resolve with its reply */,
  copy: (text) => /* put text on the clipboard */,
};
mount(document.getElementById("root"), backend);
```

- `Backend` is the UI's only way out. The requests and replies are in
  [src/protocol.ts](src/protocol.ts); each platform's host answers them. The UI never sees
  the keystore or the unlock key.
- No platform APIs in this package. Its tsconfig loads no platform types, so `npm run check`
  fails on any `chrome.*` call here.
- The stylesheet sets no window size. A platform with a fixed-size window adds its own CSS
  (the extension's popup is 360px wide).
- No build step of its own: each platform's esbuild bundles it, with its CSS and assets.

## Look

Choice's visual language, with the Choice app's own tokens (ground `#08090b`, gold
`#fdc70c`, Montserrat, three text tiers, gold-tinted buttons), so the wallet and the
exchange read as one product. Dark only, like the exchange. See the header of
[src/styles.css](src/styles.css).

Everything it shows ships with it; nothing is loaded from the network at runtime:

- `src/assets/fonts/`: Montserrat (variable, latin), SIL Open Font License 1.1
  ([OFL.txt](src/assets/fonts/OFL.txt)).
- `src/assets/choice-mark.svg`: the Choice mark, a trademark (see the repo README).
- `src/assets/tokens/`: logos of the tokens on the wallet's list, 64 px, from the
  `injective-lists` token list. Trademarks of their issuers. A logo is chosen by denom and
  only for listed tokens; any other token gets a monogram, so a token that calls itself
  "USDT" never wears USDT's logo.

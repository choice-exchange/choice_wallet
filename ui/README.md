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
- No build step of its own: each platform's esbuild bundles it, with its CSS.

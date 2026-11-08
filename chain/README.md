# Choice Wallet chain client

Talks to the chain for the wallet: accounts, balances, token names, gas estimates,
broadcasting and transaction status. It holds no keys; it sends only bytes the vault
signed. Web APIs only (`fetch`, `crypto.subtle`), so the same code runs in the extension's
service worker, a desktop or mobile web view, and Node.

Licensed GPL-3.0 ([LICENSE](LICENSE)).

- Endpoints are user-settable; the defaults are several independent public ones
  ([src/networks.ts](src/networks.ts)). An endpoint that gives no usable answer, or serves
  another chain, is skipped; an error the chain itself returns is final.
- Every response is checked before use. See "Chain client" in
  [docs/DESIGN.md](../docs/DESIGN.md) for the rules and what was measured on mainnet.
- Tests run on Node's own TypeScript support, against recorded mainnet responses:
  `npm test -w chain` from the repo root.

// The contract between the UI and its host: what the UI may ask for and what comes back.
// Every host answers these: the extension's service worker now, the desktop app's Rust
// side later. The UI never sees the keystore or the unlock key, only what's below.

/** The vault's and the host's error shape. */
export type HostError = { code: string; message: string };
export type Result<T> = { ok: true; result: T } | { ok: false; error: HostError };

/** An account as the vault's `accounts` lists it. */
export type AccountInfo = {
  account: { derivation: "default" | "ledger_live"; index: number } | { derivation: "imported" };
  public_key: string;
  /** Address per CAIP-2 chain ID. */
  addresses: Record<string, string>;
};

export type NewSecret = { mnemonic: string } | { private_key: string };

export type NetworkId = "mainnet" | "testnet";

export type UiRequest =
  | { type: "status" }
  | { type: "generate"; words: 12 | 24 }
  | { type: "create"; secret: NewSecret; password: string }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "settings" }
  /** Switch to `network`, with these LCD and EVM endpoints for it (`null`: the defaults;
   *  left out: unchanged). */
  | { type: "save_settings"; network: NetworkId; lcd: string[] | null; evm?: string[] | null; prices?: boolean }
  | { type: "balances" }
  /** Which tokens the current network's lists show (see `TokenFilter`). */
  | { type: "save_token_filter"; filter: TokenFilter }
  /** Add a token by its contract address: an ERC20 (0x…) with no bank denom, or a CW20
   *  (inj1…), joins the list; one a bank denom covers is just shown. */
  | { type: "add_token"; address: string }
  /** One page (from 1) of the account's activity, from the node's tx index. */
  | { type: "activity"; page: number }
  /** `amount` in base units, or "max" (the fee token: everything but the fee). */
  | { type: "prepare_send"; denom: string; to: string; amount: string }
  /** Convert `amount` (base units, or "max") of a token into its other form (`convertsTo`):
   *  a CW20 into its bank denom through the CW20 adapter, or back. Confirmed like a send. */
  | { type: "prepare_convert"; denom: string; amount: string }
  /** Sign and broadcast the prepared send whose review showed `digest`. `confirm` is the
   *  word the review asked for, if any. */
  | { type: "confirm_send"; digest: string; confirm?: string }
  | { type: "tx_status"; hash: string }
  /** A site's request waiting in an approval window (see `DappRequest`). */
  | { type: "dapp_request"; id: string }
  /** Prepare and decode a waiting signature request, for its approval screen. */
  | { type: "dapp_review"; id: string }
  /** Answer a waiting request. Approving a signature names the `digest` its review showed
   *  (and the typed word, if the review asked for one). */
  | { type: "dapp_answer"; id: string; approve: boolean; digest?: string; confirm?: string }
  /** Sites this wallet is connected to, and cutting one off. */
  | { type: "connections" }
  | { type: "disconnect"; origin: string };

export type Status = {
  hasWallet: boolean;
  unlocked: boolean;
  kind: "mnemonic" | "private_key" | null;
  network: NetworkId;
  /** Only while unlocked. */
  accounts: AccountInfo[];
};

/** How a token is shown. Symbols of tokens not on the wallet's list (`known: false`) are
 *  whatever their creator chose, so show the denom with them. */
export type TokenInfo = {
  denom: string;
  symbol: string;
  name: string;
  decimals: number;
  known: boolean;
  /** USD per whole token, from Choice's price index, when it has one (mainnet only). */
  priceUsd?: string;
};

export type Balance = TokenInfo & {
  amount: string;
  usd?: number;
  /** Choice has priced it within the past week: it trades somewhere real. Filters only;
   *  `priceUsd` is the price to show. */
  onChoice?: boolean;
  /** The same token in another form, one for one, that the wallet can convert this into:
   *  a CW20's bank denom (`factory/{adapter}/{cw20}`), or the CW20 (`cw20:inj1…`) behind
   *  one. */
  convertsTo?: string;
};

/** Which tokens the lists show, per network. Anyone can send any token to any address, so
 *  by default only the fee token, the wallet's listed tokens and tokens Choice prices show.
 *  Hidden tokens stay in the account. */
export type TokenFilter = {
  /** Show every token, not only listed and priced ones. */
  all: boolean;
  /** Also hide priced tokens worth under $1. */
  hideSmall: boolean;
  /** The user's own choices, over the rules above. */
  shown: string[];
  hidden: string[];
};

export type Level = "info" | "amber" | "red" | "blocked";

export type Finding = { rule: string; level: Level; message: string; confirm?: string; params: unknown };

/** The risk rules' verdict on a request (choice-wallet-policy). */
export type Risk = { level: Level; confirm?: string; findings: Finding[] };

/** A coin as the vault decodes it. */
export type Coin = { denom: string; amount: string };

/** One decoded message (the vault's `Msg`); `bank_send` is the one this UI builds. */
export type DecodedMsg = { type: "bank_send"; from: string; to: string; amount: Coin[] } | { type: string; [k: string]: unknown };

/** The vault's decode of a Cosmos transaction: what gets signed. */
export type CosmosDisplay = {
  kind: string;
  chain: string;
  signer: string;
  memo: string;
  fee: { amount: Coin[]; gas_limit: string; granter: string | null; payer: string | null };
  messages: DecodedMsg[];
};

/** The vault's decode of an EVM transaction: what gets signed. Amounts in base units. */
export type EvmDisplay = {
  kind: "evm_transaction";
  chain: string;
  from: string;
  to: string;
  value: string;
  nonce: string;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  /** gas_limit × max_fee_per_gas: the most the fee can be. */
  max_gas_cost: string;
  data: string;
  call: { type: "transfer" } | { type: "erc20_transfer"; to: string; amount: string } | { type: "contract"; selector: string | null };
};

export type SendReview = {
  /** Binds the approval to exactly this transaction. */
  digest: string;
  display: CosmosDisplay | EvmDisplay;
  risk: Risk;
  /** How to show each denom in `display`. */
  tokens: Record<string, TokenInfo>;
  /** The endpoint that simulated it (host name). */
  checkedBy: string;
};

export type Sent = { hash: string; explorer: string };

export type ActivityKind =
  | "send"
  | "receive"
  | "swap"
  | "convert"
  | "contract"
  | "evm"
  | "orderbook"
  | "ibc"
  | "stake"
  | "unstake"
  | "redelegate"
  | "rewards"
  | "other";

/** One transaction as it touched this account (choice-wallet-chain `summarize`). */
export type ActivityItem = {
  hash: string;
  height: string;
  time: string;
  ok: boolean;
  kind: ActivityKind;
  /** The message's own name, for kind "other". */
  label?: string;
  counterparty?: string;
  /** This account paid the fee. */
  signed: boolean;
  /** Net change per denom, signed base units, fee left out. */
  changes: Coin[];
  fee: Coin[];
};

export type ActivityPage = {
  network: NetworkId;
  items: ActivityItem[];
  /** How to show each denom in `items`. */
  tokens: Record<string, TokenInfo & { onChoice?: boolean }>;
  /** Another page may hold more. */
  more: boolean;
  /** Items below this height may still be missing newer neighbours from the next page: show
   *  down to here. Null when nothing is left to load. */
  cutoff: string | null;
  filter: TokenFilter;
};

export type Settings = {
  network: NetworkId;
  /** LCD endpoints in use per network, tried in order. */
  lcd: Record<NetworkId, string[]>;
  /** The wallet's defaults per network. */
  lcdDefault: Record<NetworkId, string[]>;
  /** EVM JSON-RPC endpoints in use per network, and the defaults. */
  evm: Record<NetworkId, string[]>;
  evmDefault: Record<NetworkId, string[]>;
  /** Show USD values (Choice's price index). */
  prices: boolean;
};

export type TxState = { state: "pending" | "success" | "failed"; log?: string };

/** What a site asked for, waiting for the user in an approval window. `origin` comes from
 *  the browser, never from the page. */
export type DappRequest = {
  id: string;
  origin: string;
  network: NetworkId;
  /** connect: see the account and ask for approvals. switch: move the wallet to `to`.
   *  sign: one of the vault's request kinds (`method` names it). */
  kind: "connect" | "switch" | "sign";
  /** For sign: evm_transaction, evm_personal_sign, evm_typed_data, cosmos_direct or
   *  cosmos_amino. */
  method?: string;
  /** For switch: the network asked for. */
  to?: NetworkId;
};

/** A signature request's approval screen: the vault's decode and the risk rules' verdict,
 *  as for the wallet's own sends. */
export type DappReview = Omit<SendReview, "display"> & {
  display: CosmosDisplay | EvmDisplay | { kind: string; [k: string]: unknown };
  /** A Cosmos tx's simulation: what it would move for this account (the fee apart), or why
   *  it would fail. */
  simulation?: { ok: true; changes: Coin[] } | { ok: false; error: string };
};

export type Connection = { origin: string; since: number };

/** What each request returns. */
export type Replies = {
  status: Status;
  generate: { phrase: string };
  create: Status;
  unlock: Status;
  lock: Status;
  settings: Settings;
  save_settings: Settings;
  /** Every balance; the UI applies `filter`. `prices` is the USD values setting. EVM-only
   *  tokens (denom `evm:0x…`) and CW20s (`cw20:inj1…`) are in the list; `evmDown` says the
   *  EVM endpoints didn't answer, so EVM-only tokens may be missing. */
  balances: { network: NetworkId; balances: Balance[]; filter: TokenFilter; prices: boolean; evmDown?: true };
  add_token: { denom: string; symbol: string; filter: TokenFilter };
  save_token_filter: TokenFilter;
  activity: ActivityPage;
  prepare_send: SendReview;
  prepare_convert: SendReview;
  confirm_send: Sent;
  tx_status: TxState;
  dapp_request: DappRequest;
  dapp_review: DappReview;
  dapp_answer: { done: true; hash?: string };
  connections: Connection[];
  disconnect: Connection[];
};

export type Reply<R extends UiRequest> = Replies[R["type"]];

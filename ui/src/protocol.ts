// The contract between the UI and its host: what the UI may ask for and what comes back.
// Every host answers these: the extension's service worker now, the desktop app's Rust
// side later. The UI never sees the keystore or the unlock key, only what's below.

/** The vault's and the host's error shape. */
export type HostError = { code: string; message: string };
export type Result<T> = { ok: true; result: T } | { ok: false; error: HostError };

/** An account as the vault's `accounts` lists it. */
/** A source of keys: a recovery phrase or an imported key, sealed behind the one password,
 *  or a Ledger (whose keys never leave it; only their public keys are kept). Accounts
 *  belong to one. Watched addresses belong to none (their `wallet` is "watch"). */
export type WalletInfo = { id: string; type: "mnemonic" | "private_key" | "ledger"; name: string };

export type AccountInfo = {
  /** The wallet it comes from (`WalletInfo.id`), or "watch". */
  wallet: string;
  /** How the vault finds its key; "watch" has none (an address to follow, never to sign). */
  account:
    | { derivation: "default" | "ledger_live"; index: number }
    | { derivation: "imported" }
    | { derivation: "watch" }
    /** On a Ledger, at this BIP-32 path (`m/44'/60'/…`). */
    | { derivation: "ledger"; path: string };
  /** Empty for a watch-only account. */
  public_key: string;
  /** Address per CAIP-2 chain ID. */
  addresses: Record<string, string>;
  /** The user's name for it ("Account 2" until renamed). */
  name: string;
};

export type NewSecret = { mnemonic: string } | { private_key: string };

export type { Nft, NftCollection, NftStandard } from "@choice-wallet/chain";
import type { NftCollection, NftStandard } from "@choice-wallet/chain";
/** The account's NFTs by collection; `evmDown`: no EVM endpoint answered, so ERC721s may be
 *  missing. */
export type NftList = { collections: NftCollection[]; evmDown?: true };

/** What a hardware wallet signs, as the vault gave it: the app (Ledger's Cosmos or Ethereum
 *  app), what kind of thing it is, the exact bytes (hex), and the account's path. */
export type DeviceRequest = { app: "cosmos" | "ethereum"; kind: "amino" | "transaction" | "message"; payload: string; path: string };
/** A device's signature, as it wrote it: DER (the Cosmos app) or `r || s` (hex). */
export type DeviceSignature = { signature: string; format: "der" | "rs" };
/** A Ledger account found on the device: its path and public key (compressed, hex). */
export type LedgerKey = { path: string; public_key: string };

export type NetworkId = "mainnet" | "testnet";

export type UiRequest =
  | { type: "status" }
  | { type: "generate"; words: 12 | 24 }
  /** The first wallet, and the password for all of them. `imported`: a phrase from before,
   *  so its other accounts with history are found and added. */
  | { type: "create"; secret: NewSecret; password: string; imported?: boolean }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  /** Accounts: the next one from the recovery phrase; an address to watch (no key, can't
   *  sign); which one the wallet and connected sites use; a name; drop one from the list
   *  (the first can't go: it is the keystore's own). Each answers with the new status. */
  | { type: "add_account"; wallet?: string }
  | { type: "add_watch"; address: string }
  /** Accounts read from a Ledger: a new Ledger wallet, or more of `wallet`'s. */
  | { type: "add_ledger"; accounts: LedgerKey[]; wallet?: string }
  /** Another wallet behind the same password: a new phrase (`created`), or an imported phrase
   *  (its accounts with history found and added) or private key. */
  | { type: "add_wallet"; secret: NewSecret; created?: boolean }
  | { type: "rename_wallet"; wallet: string; name: string }
  /** One wallet and its accounts off this device, after the password. */
  | { type: "remove_wallet"; wallet: string; password: string }
  | { type: "switch_account"; index: number }
  | { type: "rename_account"; index: number; name: string }
  | { type: "remove_account"; index: number }
  /** Security, each behind the password: show a wallet's recovery phrase (or its imported
   *  key), or account `index`'s private key; a new password; take everything off this
   *  device. */
  | { type: "reveal_secret"; password: string; wallet?: string; index?: number }
  | { type: "change_password"; password: string; new_password: string }
  | { type: "reset"; password: string }
  | { type: "settings" }
  /** Switch to `network`, with these LCD, EVM and Blockscout endpoints for it (`null`: the
   *  defaults; left out: unchanged; an empty Blockscout list turns it off). */
  | { type: "save_settings"; network: NetworkId; lcd: string[] | null; evm?: string[] | null; evmIndex?: string[] | null; prices?: boolean; autoLock?: number }
  | { type: "balances" }
  /** Which tokens the current network's lists show (see `TokenFilter`). */
  | { type: "save_token_filter"; filter: TokenFilter }
  /** Add a token by its contract address: an ERC20 (0x…) with no bank denom, or a CW20
   *  (inj1…), joins the list; one a bank denom covers is just shown. */
  | { type: "add_token"; address: string }
  /** One page (from 1) of the account's activity, from the node's tx index. */
  | { type: "activity"; page: number }
  /** `amount` in base units, or "max" (the fee token: everything but the fee). `memo` goes
   *  in a Cosmos transaction; an EVM-only token's send can't carry one. */
  | { type: "prepare_send"; denom: string; to: string; amount: string; memo?: string }
  /** The address book: saved recipients, each with the memo an exchange needs, if any. */
  | { type: "contacts" }
  /** Save a contact: a new one, or `id`'s changes. */
  | { type: "save_contact"; id?: string; name: string; address: string; memo: string }
  | { type: "remove_contact"; id: string }
  /** What the wallet knows of a recipient before the review: a contact, one of the user's
   *  accounts, or an address whose deposits carry a memo (an exchange's). */
  | { type: "check_recipient"; to: string }
  /** Tokens to swap into: held ones, the wallet's list, and ones added by address. */
  | { type: "swap_tokens" }
  /** A quote for `amount` (base units, or "max") of `from` into `to`. */
  | { type: "swap_quote"; from: string; to: string; amount: string; slippageBps?: number }
  /** The next step of a quoted swap, for review: an approval, or the swap itself. */
  | { type: "prepare_swap"; quote: string }
  /** Convert `amount` (base units, or "max") of a token into its other form (`convertsTo`):
   *  a CW20 into its bank denom through the CW20 adapter, or back. Confirmed like a send. */
  | { type: "prepare_convert"; denom: string; amount: string }
  | { type: "staking" }
  | { type: "approvals" }
  | { type: "prepare_revoke"; items: RevokeItem[] }
  | { type: "prepare_revoke_erc20"; token: string; spender: string }
  /** The rescue address: what's set, set or clear it, the rescue account's gas for this
   *  one, and the rescue itself. */
  | { type: "rescue" }
  | { type: "set_rescue"; address: string | null }
  | { type: "prepare_rescue_grant" }
  | { type: "prepare_rescue" }
  /** NFTs the account holds; a collection added by its contract; one NFT sent. */
  | { type: "nfts" }
  | { type: "add_nft_collection"; address: string }
  | { type: "prepare_nft_send"; standard: NftStandard; collection: string; tokenId: string; to: string }
  | ({ type: "prepare_stake" } & StakeRequest)
  /** Sign and broadcast the prepared send whose review showed `digest`. `confirm` is the
   *  word the review asked for, if any. */
  | { type: "confirm_send"; digest: string; confirm?: string }
  /** The Ledger's signature for the prepared send `confirm_send` handed to it. */
  | ({ type: "ledger_signed"; digest: string } & DeviceSignature)
  | { type: "tx_status"; hash: string }
  /** A site's request waiting in an approval window (see `DappRequest`). */
  | { type: "dapp_request"; id: string }
  /** Prepare and decode a waiting signature request, for its approval screen. */
  | { type: "dapp_review"; id: string }
  /** Answer a waiting request. Approving a signature names the `digest` its review showed
   *  (and the typed word, if the review asked for one). */
  | { type: "dapp_answer"; id: string; approve: boolean; digest?: string; confirm?: string }
  /** The Ledger's signature for a site's request that `dapp_answer` handed to it. */
  | ({ type: "dapp_ledger_signed"; id: string; digest: string } & DeviceSignature)
  /** Sites this wallet is connected to, and cutting one off. */
  | { type: "connections" }
  | { type: "disconnect"; origin: string };

/** A saved recipient. `address` is its inj1 form and `evm` its 0x form; `memo` is what an
 *  exchange credits deposits by (empty when it needs none). */
export type Contact = { id: string; name: string; address: string; evm: string; memo: string };

/** What the wallet knows of a recipient. `takesMemo`: most deposits it receives carry a
 *  memo, from many senders, as an exchange's shared deposit address does. */
export type RecipientCheck = { contact?: Contact; mine?: string; takesMemo: boolean };

export type Status = {
  hasWallet: boolean;
  unlocked: boolean;
  network: NetworkId;
  /** Only while unlocked. */
  wallets: WalletInfo[];
  accounts: AccountInfo[];
  /** Which of `accounts` is in use. */
  active: number;
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
  call:
    | { type: "transfer" }
    | { type: "erc20_transfer"; to: string; amount: string }
    | { type: "contract"; selector: string | null; unreadable_swap?: true }
    | { type: "approve"; spender: string; amount: string }
    | { type: "permit2_approve"; token: string; spender: string; amount: string; expiration: number }
    | EvmSwapCall;
};

/** A swap through Choice's aggregator or router, as the vault reads its calldata. The zero
 *  address is native INJ. */
export type EvmSwapCall = {
  type: "swap";
  executor: "aggregator" | "router";
  token_in: string;
  token_out: string;
  amount_in: string;
  minimum_out: string;
  recipient: string;
  deadline: string | null;
  fee_bps: number;
  fee_recipient: string | null;
  venues: { venue: string; contract?: string; hops?: number; market?: string }[];
  permit: { token: string; spender: string; amount: string; expiration: number } | null;
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
  /** One step of a swap: which tokens it trades (wallet keys, in `tokens`) and what
   *  Choice expects it to return (display only; the minimum in `display` is the guard). */
  swap?: SwapStepInfo;
  /** An NFT send: which NFT, as the host checked it is held (the vault's decode says
   *  where it goes). */
  nft?: { collection: string; tokenId: string; standard: NftStandard };
  /** A rescue: where everything goes, and how many messages didn't fit (run it again). */
  rescue?: { to: string; rest: number };
};

/** The rescue address set for the account in use, its name if it is one of the wallet's
 *  accounts, whether that account can sign here (to give gas), and the gas it gave. */
export type RescueSummary = {
  address: string | null;
  name?: string;
  canGrant?: boolean;
  /** `current`: it covers every message a rescue sends (else it can be renewed). */
  gas?: { limit: Coin[]; current: boolean } | null;
  /** The rescue address is on Injective's list of who a stake can be given to at once;
   *  otherwise a rescue unstakes. */
  stakesMove?: boolean;
};

/** What a swap step's review needs beyond the vault's reading. */
export type SwapStepInfo = {
  step: SwapStep;
  /** Steps after this one. */
  left: number;
  from: string;
  to: string;
  expectedOut: string;
};

export type SwapStep = "approve" | "permit2" | "swap";

/** A quote from Choice for the wallet's own swap. Amounts in base units. */
export type SwapQuote = {
  /** What `prepare_swap` builds from. */
  id: string;
  from: string;
  to: string;
  amountIn: string;
  amountOut: string;
  minimumOut: string;
  slippageBps: number;
  executor: "aggregator" | "router";
  legs: { venue: string; portionBps: number }[];
  /** Choice's fee, if it takes one; it comes out of `amountOut` and is in the calldata. */
  fee: { bps: number } | null;
  /** What it takes, in order: approvals first, when the token needs them. */
  steps: SwapStep[];
  tokens: Record<string, TokenInfo>;
};

/** A token the swap screen offers. */
export type SwapToken = TokenInfo & { amount?: string };

export type Sent = { hash: string; explorer: string };

/** A staking action. Amounts are base units of INJ, or "max". `validator` is where the
 *  stake is (for "move", where it leaves; for "claim", absent to claim from every one). */
export type StakeRequest =
  | { action: "stake"; validator: string; amount: string }
  | { action: "unstake"; validator: string; amount: string }
  | { action: "move"; validator: string; to: string; amount: string }
  | { action: "claim"; validator?: string; amount?: undefined }
  | { action: "cancel"; validator: string; height: string; amount?: undefined };

/** What this account lets others do. */
export type ApprovalsSummary = {
  network: NetworkId;
  /** authz grants it gave. `msgTypeUrl` is what a revoke names; null when the wallet can't
   *  tell (shown, not revocable here). */
  grants: { grantee: string; type: string; msgTypeUrl: string | null; spendLimit?: Coin[]; allowList?: string[]; expiration: string | null }[];
  /** Fee allowances it gave; an empty limit is none. */
  feeGrants: { grantee: string; type: string; spendLimit: Coin[]; expiration: string | null; allowedMessages?: string[] }[];
  /** Where staking rewards go, when it isn't this account. */
  rewardsTo: string | null;
  /** By the token's `cw20:` key. */
  cw20: { token: string; spender: string; amount: string; expires: string }[];
  /** By the token's `evm:` key; what is left of each, from the token. */
  erc20: { token: string; spender: string; amount: string }[];
  tokens: Record<string, TokenInfo>;
  /** Blockscout didn't answer: ERC20 allowances may be missing. */
  evmIndexDown?: true;
  /** No EVM endpoint answered: ERC20 allowances couldn't be checked. */
  evmDown?: true;
};

/** One Cosmos-side permission to take back. */
export type RevokeItem =
  | { type: "authz"; grantee: string; msg_type_url: string }
  | { type: "fee"; grantee: string }
  | { type: "rewards" }
  | { type: "cw20"; contract: string; spender: string; amount: string };

export type ValidatorInfo = {
  address: string;
  /** Written by the validator: not proof of who runs it. */
  moniker: string;
  website: string;
  /** 0 to 1. */
  commission: number;
  tokens: string;
  jailed: boolean;
  /** In the active set (earning rewards). */
  active: boolean;
  /** Place in the active set by voting power, 1 first. */
  rank: number | null;
};

export type StakingSummary = {
  network: NetworkId;
  denom: string;
  staked: string;
  unbondingTotal: string;
  /** Unclaimed, rounded down. */
  rewards: string;
  stakes: { validator: string; amount: string; rewards: string }[];
  /** Soonest first. */
  unbonding: { validator: string; amount: string; height: string; completes: string }[];
  /** The active set by voting power, then any other validator a stake is with. */
  validators: ValidatorInfo[];
  unbondingDays: number;
};

export type ActivityKind =
  | "send"
  | "receive"
  | "swap"
  | "convert"
  | "approve"
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
  /** An EVM transaction's 0x hash: its explorer page is Blockscout's. */
  evmHash?: string;
  /** For kind "approve": who may spend how much of which token ("0" takes it back). */
  approval?: { denom: string; spender: string; amount: string };
};

export type ActivityPage = {
  /** Names of the validators the rows name, from the active set. */
  validators?: Record<string, string>;
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
  /** Blockscout didn't answer: ERC20s others sent may be missing. */
  evmIndexDown?: true;
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
  /** Blockscout instances per network (empty: off), and the defaults. */
  evmIndex: Record<NetworkId, string[]>;
  evmIndexDefault: Record<NetworkId, string[]>;
  /** Show USD values (Choice's price index). */
  prices: boolean;
  /** Minutes without activity before the wallet locks: 5, 15, 60 or 240. */
  autoLock: number;
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
  /** For sign: evm_transaction, evm_personal_sign, evm_typed_data, cosmos_direct,
   *  cosmos_amino or cosmos_arbitrary (ADR-036). */
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
  add_account: Status;
  add_watch: Status;
  switch_account: Status;
  rename_account: Status;
  remove_account: Status;
  add_wallet: Status;
  rename_wallet: Status;
  reveal_secret: { phrase?: string; private_key?: string };
  change_password: Status;
  remove_wallet: Status;
  reset: Status;
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
  contacts: Contact[];
  save_contact: Contact[];
  remove_contact: Contact[];
  check_recipient: RecipientCheck;
  swap_tokens: SwapToken[];
  swap_quote: SwapQuote;
  prepare_swap: SendReview;
  prepare_convert: SendReview;
  staking: StakingSummary;
  approvals: ApprovalsSummary;
  prepare_revoke: SendReview;
  prepare_revoke_erc20: SendReview;
  rescue: RescueSummary;
  set_rescue: RescueSummary;
  prepare_rescue_grant: SendReview;
  prepare_rescue: SendReview;
  nfts: NftList;
  add_nft_collection: NftList;
  prepare_nft_send: SendReview;
  prepare_stake: SendReview;
  /** Sent, or (for a Ledger account) what the device must sign first. */
  confirm_send: Sent | { device: DeviceRequest };
  ledger_signed: Sent;
  add_ledger: Status;
  tx_status: TxState;
  dapp_request: DappRequest;
  dapp_review: DappReview;
  dapp_answer: { done: true; hash?: string } | { device: DeviceRequest };
  dapp_ledger_signed: { done: true; hash?: string };
  connections: Connection[];
  disconnect: Connection[];
};

export type Reply<R extends UiRequest> = Replies[R["type"]];

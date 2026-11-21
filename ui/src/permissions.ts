// Plain names for what an authz grant lets someone do, by the message type it covers.

const NAMES: Record<string, string> = {
  "/cosmos.bank.v1beta1.MsgSend": "Send your tokens",
  "/cosmos.bank.v1beta1.MsgMultiSend": "Send your tokens",
  "/cosmos.authz.v1beta1.MsgExec": "Use permissions others gave you",
  "/cosmos.authz.v1beta1.MsgGrant": "Give permissions for you",
  "/cosmos.feegrant.v1beta1.MsgGrantAllowance": "Let others spend your fees",
  "/cosmwasm.wasm.v1.MsgExecuteContract": "Call contracts as you",
  "/cosmwasm.wasm.v1.MsgMigrateContract": "Change your contracts' code",
  "/cosmos.staking.v1beta1.MsgDelegate": "Stake for you",
  "/cosmos.staking.v1beta1.MsgUndelegate": "Unstake for you",
  "/cosmos.staking.v1beta1.MsgBeginRedelegate": "Move your stake",
  "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward": "Claim your rewards",
  "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress": "Redirect your rewards",
  "/cosmos.gov.v1beta1.MsgVote": "Vote for you",
  "/cosmos.gov.v1.MsgVote": "Vote for you",
  "/ibc.applications.transfer.v1.MsgTransfer": "Send your tokens to other chains",
};

/** Grants that can't move the account's funds out: the only ones not shown in red. Every other
 *  type, unknown and future ones included, is treated as able to (as the signing rules do). */
const HARMLESS = new Set([
  "/cosmos.staking.v1beta1.MsgDelegate",
  "/cosmos.staking.v1beta1.MsgUndelegate",
  "/cosmos.staking.v1beta1.MsgBeginRedelegate",
  "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation",
  "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
  "/cosmos.gov.v1beta1.MsgVote",
  "/cosmos.gov.v1.MsgVote",
]);

/** Exchange messages that place or cancel orders (a trading grant); the exchange's other
 *  messages move funds between accounts or into contracts, and are named for what they are. */
const ORDERS = /^\/injective\.exchange\.v[0-9a-z]+\.Msg(Create|Cancel|BatchCreate|BatchCancel|BatchUpdate|IncreasePositionMargin|DecreasePositionMargin|LiquidatePosition)/;
const CANCELS = /^\/injective\.exchange\.v[0-9a-z]+\.Msg(Cancel|BatchCancel)/;

/** What a grant for `msgTypeUrl` lets the grantee do, in a few words. */
export function permissionName(msgTypeUrl: string): string {
  const known = NAMES[msgTypeUrl];
  if (known) return known;
  if (ORDERS.test(msgTypeUrl)) return "Trade on the INJ orderbook";
  const name = msgTypeUrl.split(".").pop()?.replace(/^Msg/, "") ?? msgTypeUrl;
  return `${name.replace(/([a-z])([A-Z])/g, "$1 $2")} for you`;
}

/** Whether a grant for `msgTypeUrl` can move funds out of the account: anything not known
 *  to be harmless. Placing orders can (a grantee can trade the funds away); cancelling can't. */
export function canMoveFunds(msgTypeUrl: string | null): boolean {
  return msgTypeUrl === null || !(HARMLESS.has(msgTypeUrl) || CANCELS.test(msgTypeUrl));
}

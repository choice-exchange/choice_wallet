// NFTs for the account in use: CW721 collections on the Cosmos side and ERC721s on Injective
// EVM (`@choice-wallet/chain`'s nfts.ts finds them and checks each with its contract), the
// collections the user added by hand, and a send of one NFT, prepared like any other send
// so the vault decodes and grades it before anything is signed.

import { cw721Collections, cw721Info, erc721Collections, isObject, isTokenId, NETWORKS, type NetworkId, type NftCollection } from "@choice-wallet/chain";
import type { AccountInfo, Result, SendReview } from "@choice-wallet/ui/protocol";

import type { createSender } from "./send";
import type { Store } from "./service";
import { fail } from "./util";

type Sender = ReturnType<typeof createSender>;

/** Collections added by hand, per network. */
const MAX_ADDED = 50;
const CONTRACT = /^inj1[02-9ac-hj-np-z]{38,58}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export function createNfts(d: { sender: Sender; local: Store; vault<T>(method: string, params?: unknown): Promise<Result<T>> }) {
  async function added(network: NetworkId): Promise<string[]> {
    const { custom_nfts } = (await d.local.get(["custom_nfts"])) as { custom_nfts?: Partial<Record<NetworkId, unknown>> };
    const list = custom_nfts?.[network];
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
  }

  /** Every collection the account holds an NFT in. The EVM side failing leaves the Cosmos
   *  side to show, with a note. */
  async function list(network: NetworkId, account: AccountInfo): Promise<Result<{ collections: NftCollection[]; evmDown?: true }>> {
    const net = NETWORKS[network];
    const mine = await added(network);
    try {
      const cw = await cw721Collections(await d.sender.lcd(network), account.addresses[net.cosmos] ?? "", mine);
      let evm: NftCollection[] = [];
      let evmDown = false;
      try {
        evm = await erc721Collections(await d.sender.evm(network), await d.sender.evmIndex(network), account.addresses[net.evm] ?? "", mine);
      } catch {
        evmDown = true;
      }
      return { ok: true, result: { collections: [...cw, ...evm], ...(evmDown ? { evmDown: true as const } : {}) } };
    } catch (e) {
      return d.sender.chainFailure(e);
    }
  }

  /** Add a collection by its contract: a CW721 (`inj1…`) that answers `contract_info`, or an
   *  ERC721 (`0x…`) that says so through ERC-165. */
  async function add(network: NetworkId, account: AccountInfo, address: unknown): Promise<Result<{ collections: NftCollection[]; evmDown?: true }>> {
    if (typeof address !== "string") return fail("bad_request", "Enter a collection's contract address.");
    const a = address.trim();
    try {
      if (CONTRACT.test(a)) {
        if (!(await cw721Info(await d.sender.lcd(network), a))) return fail("not_a_collection", "That contract isn't a CW721 collection.");
      } else if (EVM.test(a)) {
        // supportsInterface(0x80ac58cd), ERC721's interface ID.
        const r = await (await d.sender.evm(network)).call("eth_call", [{ to: a, data: `0x01ffc9a780ac58cd${"0".repeat(56)}` }, "latest"]);
        if (typeof r !== "string" || !/^0x0*1$/.test(r)) return fail("not_a_collection", "That contract isn't an ERC721 collection.");
      } else {
        return fail("bad_request", "Enter an inj1… or 0x… contract address.");
      }
    } catch (e) {
      return d.sender.chainFailure(e);
    }
    const key = EVM.test(a) ? a.toLowerCase() : a;
    const { custom_nfts } = (await d.local.get(["custom_nfts"])) as { custom_nfts?: Partial<Record<NetworkId, string[]>> };
    const now = await added(network);
    if (!now.includes(key)) {
      if (now.length >= MAX_ADDED) return fail("too_many", `At most ${MAX_ADDED} added collections.`);
      await d.local.set({ custom_nfts: { ...(custom_nfts ?? {}), [network]: [...now, key] } });
    }
    return list(network, account);
  }

  /** One NFT to `to`, checked as still this account's first. */
  async function prepare(network: NetworkId, account: AccountInfo, req: { standard?: unknown; collection?: unknown; tokenId?: unknown; to?: unknown }): Promise<Result<SendReview>> {
    const net = NETWORKS[network];
    const { standard, collection, tokenId, to } = req;
    if (typeof collection !== "string" || !isTokenId(tokenId) || typeof to !== "string" || !to.trim()) return fail("bad_request", "Pick an NFT and a recipient.");
    const r = await d.vault<{ addresses: Record<string, string> }>("addresses", { address: to.trim() });
    if (!r.ok) return fail("invalid_address", "Check the recipient address.");
    const recipient = r.result.addresses;
    const nft = { collection, tokenId, standard: standard === "erc721" ? ("erc721" as const) : ("cw721" as const) };
    try {
      if (standard === "cw721" && CONTRACT.test(collection)) {
        const owner = await (await d.sender.lcd(network)).smart(collection, { owner_of: { token_id: tokenId } });
        if (!isObject(owner) || owner["owner"] !== account.addresses[net.cosmos]) return fail("not_yours", "This account doesn't hold that NFT now.");
        const review = await d.sender.prepareCosmos(network, account, {
          denom: net.feeDenom,
          amount: "0",
          noAmount: true,
          messages: () => [{ type: "nft_transfer", contract: collection, to: recipient[net.cosmos], token_id: tokenId }],
          knownContracts: [collection],
          recipient: recipient[net.cosmos]!,
        });
        return review.ok ? { ok: true, result: { ...review.result, nft } } : review;
      }
      if (standard === "erc721" && EVM.test(collection) && /^[0-9]{1,78}$/.test(tokenId)) {
        const rpc = await d.sender.evm(network);
        const owner = await rpc.call("eth_call", [{ to: collection, data: `0x6352211e${BigInt(tokenId).toString(16).padStart(64, "0")}` }, "latest"]);
        const me = (account.addresses[net.evm] ?? "").toLowerCase();
        if (typeof owner !== "string" || `0x${owner.slice(-40)}`.toLowerCase() !== me) return fail("not_yours", "This account doesn't hold that NFT now.");
        const review = await d.sender.prepareEvmCall(network, account, {
          to: recipient[net.evm]!,
          amount: 0n,
          call: { type: "nft_transfer", collection, token_id: tokenId },
          tokens: [],
          expect: (display) =>
            display.call["type"] === "nft_transfer" && display.to.toLowerCase() === collection.toLowerCase() && display.call["token_id"] === tokenId ? null : "The vault didn't read this as that NFT's transfer.",
        });
        return review.ok ? { ok: true, result: { ...review.result, nft } } : review;
      }
    } catch (e) {
      return d.sender.chainFailure(e);
    }
    return fail("bad_request", "Not an NFT the wallet lists.");
  }

  return { list, add, prepare };
}

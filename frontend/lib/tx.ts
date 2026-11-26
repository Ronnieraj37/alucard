"use client";

import { withHeadroom } from "@/lib/gas";
import { useCallback, useState } from "react";
import { type Abi, BaseError, ContractFunctionRevertedError, maxUint256 } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { testTokenAbi } from "./generated/abis";
import { type Token } from "./pools";

export type TxState = { busy: boolean; message: string | null; error: string | null; hash: string | null };

/** Run one or more writes in order, waiting for each to be mined, with a plain status line for the user. */
export function useTx() {
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { address } = useAccount();
  const [state, setState] = useState<TxState>({ busy: false, message: null, error: null, hash: null });

  const send = useCallback(
    async (label: string, req: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint }) => {
      setState((s) => ({ ...s, busy: true, message: `${label}: confirm in your wallet…`, error: null }));
      // Our pools' hook writes a price snapshot in the first swap of each minute, and a rule's run can take another
      // path once the price moves. An estimate made a moment before the block can fall short: add room. Only the gas
      // used is paid. A failing estimate is thrown here, with the contract's reason, before the wallet opens.
      const estimate = await client!.estimateContractGas({ ...(req as object), account: address } as never);
      const hash = await writeContractAsync({ ...req, gas: withHeadroom(estimate) } as never);
      setState((s) => ({ ...s, message: `${label}: waiting for the block…`, hash }));
      const receipt = await client!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${label} failed on-chain`);
      return receipt;
    },
    [address, client, writeContractAsync],
  );

  /** Approve `spender` for `amount` of `token` if the allowance is not enough already. */
  const ensureAllowance = useCallback(
    async (token: Token, spender: `0x${string}`, amount: bigint) => {
      if (token.native || amount === 0n || !address) return;
      const allowance = await client!.readContract({
        address: token.address,
        abi: testTokenAbi,
        functionName: "allowance",
        args: [address, spender],
      });
      if (allowance >= amount) return;
      await send(`Approve t${token.symbol}`, {
        address: token.address,
        abi: testTokenAbi as Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
    },
    [address, client, send],
  );

  const run = useCallback(async (fn: () => Promise<unknown>, done = "Done") => {
    try {
      await fn();
      setState({ busy: false, message: done, error: null, hash: null });
      return true;
    } catch (e) {
      setState({ busy: false, message: null, error: explain(e), hash: null });
      return false;
    }
  }, []);

  return { state, send, ensureAllowance, run };
}

/** Turn wallet and revert errors into one short sentence. */
export function explain(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name) return HUMAN_ERRORS[name] ?? `The contract refused: ${name}`;
    }
    if (e.shortMessage?.includes("User rejected")) return "You cancelled the transaction in your wallet.";
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

const HUMAN_ERRORS: Record<string, string> = {
  ConditionNotMet: "Its condition is not met right now (rules read the average price, so a move needs a couple of minutes to count).",
  TooSoon: "This side ran (or started) less than a minute ago. A side runs at most once a minute: try again shortly.",
  NoPrice: "This pool does not have enough price history yet for that average (a new pool, or a long averaging time). Try a shorter time, or again later.",
  NothingToEnter: "The move could not put anything into the new range at today's price. It is tried again later.",
  PriceMoved: "The price right now is too far from its recent average (or from Chainlink), so nothing runs at it: someone may have pushed it. It runs once the price settles.",
  NothingToPoke: "Nothing to update: the remembered price is already the best one.",
  SideOff: "This side has no rule.",
  InvalidSide: "One of the rules is not allowed. Check the warnings in the editor.",
  InvalidLeg: "That move is not allowed: the other pool must be an Alucard pool sharing a token with this one, and the move must swap into that token.",
  InvalidOrder: "The order settings are not valid (expiry, fee, both sides empty, or a move without a way out and back).",
  UnknownPool: "That pool is not an Alucard pool, so rules cannot read its price.",
  TooMuchIn: "The price moved while you were confirming. Refresh and try again.",
  NotOwner: "Only the owner can do this.",
  Expired: "This order has expired. Anyone can now cancel it, which returns the tokens to the owner.",
  UnknownOrder: "This order no longer exists.",
  TokenNotAllowed: "Rules are only available for tokens on the list (tokens with a Chainlink price). One of this pool's tokens is not on it.",
  OrderTooSmall: "This position is below the smallest size a rule can be attached to. Add more, or try again when the Chainlink price has updated.",
  BatchOutOfGas: "The batch ran out of gas. Send it with more gas, or fewer rules at once.",
};

/** Balance of a token (native ETH or ERC20) for the connected wallet. */
export function useTokenBalance(token: Token): bigint | undefined {
  const { address } = useAccount();
  const native = useBalance({ address, query: { enabled: !!address && !!token.native } });
  const erc20 = useReadContract({
    address: token.address,
    abi: testTokenAbi,
    functionName: "balanceOf",
    args: [address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address && !token.native },
  });
  return token.native ? native.data?.value : (erc20.data as bigint | undefined);
}

import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAIN_ID, CHAINS, SUPPORTED, rpcUrl } from "./chain";

export const RPC_URL = rpcUrl();

// The active chain first: with no wallet (or a wallet on an unsupported network) reads go to it. The others are
// listed so the wallet can be switched to them; the Header follows the wallet onto any of them.
const chains = [CHAIN_ID, ...SUPPORTED.filter((id) => id !== CHAIN_ID)].map((id) => CHAINS[id].chain);

export const wagmiConfig = createConfig({
  chains: chains as [(typeof chains)[number], ...(typeof chains)[number][]],
  connectors: [injected()],
  transports: Object.fromEntries(SUPPORTED.map((id) => [id, http(rpcUrl(id))])),
  ssr: true,
});

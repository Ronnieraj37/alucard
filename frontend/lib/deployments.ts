// Every chain's deployment at once, for pages that are the same whichever network is chosen (docs, landing). They
// render on the server, which cannot know the network a visitor picked, so they list all of them.
import all from "./generated/deployment.json";
import { CHAINS, SUPPORTED, type ChainId } from "./chain";

export type ChainDeployment = {
  id: ChainId;
  label: string;
  short: string;
  explorer: string;
  core: Record<string, string>;
  tokens: Record<string, string>;
};

const RAW = all.chains as unknown as Record<string, { core: Record<string, string>; tokens: Record<string, string> }>;

export const DEPLOYMENTS: ChainDeployment[] = SUPPORTED.map((id) => ({
  id,
  label: CHAINS[id].label,
  short: CHAINS[id].short,
  explorer: CHAINS[id].chain.blockExplorers?.default.url ?? "https://sepolia.etherscan.io",
  core: RAW[id].core,
  tokens: RAW[id].tokens,
}));

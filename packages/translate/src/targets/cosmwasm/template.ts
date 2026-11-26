import type { ContractSpec, TokenFacts } from '../../types.js';
import type { StandardMatch } from '../../spec/standard.js';
import type { CwDesign } from './design-types.js';
import { cw20InstantiateMsg, type Cw20TemplateInfo } from './adapter.js';

const bare = (s: string) => s.replace(/^_+/, '').replace(/_+$/, '').toLowerCase();
const paramIndex = (spec: ContractSpec, stateVar: string): number => {
  const ps = spec.constructor?.params ?? [];
  const a = spec.constructor?.paramAssignments?.find((x) => bare(x.stateVar) === stateVar)?.param;
  if (a) return ps.findIndex((p) => p.name === a);
  return ps.findIndex((p) => p.type.kind === 'string' && bare(p.name) === stateVar);
};

export function cw20Info(spec: ContractSpec, m: StandardMatch): Cw20TemplateInfo {
  const dec = Number(spec.stateVars.find((s) => s.name === 'decimals')?.initial?.value ?? 18);
  return { nameParam: paramIndex(spec, 'name'), symbolParam: paramIndex(spec, 'symbol'), supplyParam: m.initialSupplyParam, decimals: Number.isFinite(dec) ? dec : 18, mintable: m.features.mintable, burnable: m.features.burnable, ownable: m.features.ownable };
}

/** Design of a native cw20-base / cw721-base deployment (no custom code). */
export function buildTemplateDesign(spec: ContractSpec, m: StandardMatch, info: Cw20TemplateInfo): CwDesign {
  const is20 = m.standard === 'ERC-20';
  const notes: string[] = is20 ? [
    `${spec.name} is a plain ERC-20, so it is not rewritten: it is deployed as the cw20-base contract from cw-plus (the reference cw20 implementation) with an instantiate message. No model-written and no custom code.`,
    `Decimals: ${info.decimals} (cw20 accepts at most 18); amounts are Uint128 (the Solidity uint256 supply must fit 128 bits). No rescaling.`,
    `Initial balances: the ERC-20 constructor's initial supply goes to the deployer (\`initial_balances\`).`,
    m.features.mintable ? 'Minter: the Solidity owner/minter becomes the cw20 minter (`mint: { minter, cap }`); `cap` is null (a capped Solidity token would set it: a `cap` constructor argument maps to `mint.cap`, but the plain-token classifier does not generate capped tokens).' : 'Not mintable: `mint` is null, the supply is fixed.',
    m.features.ownable ? 'transferOwnership(newOwner) is `update_minter`; the minter role is the only owner-like role cw20-base has.' : 'No owner role.',
    'Allowances: ERC-20 approve(spender, amount) SETS the allowance; cw20 has `increase_allowance` / `decrease_allowance` (with optional expiry), so a client sends the difference. `increaseAllowance` / `decreaseAllowance` map one to one.',
    'cw20-base rejects zero-amount transfers/mints/burns and addresses that fail bech32 validation; ERC-20 allows zero amounts. The Solidity zero-address guards have no counterpart: the zero address is simply not a valid cw20 address.',
    'cw20-base always has `burn` / `burn_from` (a non-burnable Solidity token would still be burnable by its holders).',
    'Name 3..50 characters, symbol 3..12 letters or "-": a Solidity token whose name/symbol are outside these ranges cannot be instantiated.',
  ] : [
    `${spec.name} is a plain ERC-721, deployed as cw721-base (instantiate message in token.json). Only the recipe is produced: it is NOT executed or verified by this pipeline.`,
    'cw721 has no balanceOf (count the owner\'s tokens with the `tokens` query), no safeTransferFrom hook (use `send_nft`), and token ids are strings.',
  ];
  return {
    version: 1, mode: 'template', programName: 'app', decimals: { original: info.decimals, target: info.decimals, divisor: '1' },
    integerPolicy: ['cw20 amounts are Uint128; values from the Solidity uint256 must fit 128 bits.'], native: { used: false }, state: [], structs: [], tokens: [], instructions: [], observables: {}, constants: [],
    extraCapabilities: is20 ? [
      ...(m.features.burnable ? [] : [{ name: 'burn / burn_from', reason: 'cw20-base lets every holder burn its own tokens and any spender burn within its allowance; the original has no burn function, so the supply can shrink here although it cannot on the original (the only configuration cw20-base offers is a different contract)' }]),
      { name: 'send / send_from', reason: 'cw20-base can send tokens together with a message to a contract (the cw20 hook); ERC-20 has no such call' },
      { name: 'increase_allowance / decrease_allowance with expiry', reason: 'allowances may carry an expiry; the original\'s allowances never expire' },
      { name: 'marketing / logo update', reason: 'cw20-base has marketing entry points; they are disabled here (instantiate `marketing` is null)' },
    ] : [],
    decimalsNote: `Decimals: the cw20 token keeps the original ${info.decimals} decimals (amounts are Uint128, no rescaling).`,
    allowanceNote: is20 ? 'approve sets an allowance; cw20 has increase_allowance/decrease_allowance, so approve is the difference (see design notes)' : 'ERC-721 recipe only',
    notTranslated: is20 ? [
      { feature: 'zero-address checks', where: 'transfer, mint, transferOwnership', reason: 'the zero address is not a valid cw20/bech32 address; cw20-base validates addresses instead' },
      { feature: 'approve (set semantics)', where: 'approve', reason: 'cw20 has increase_allowance / decrease_allowance; approve is expressed as the difference' },
      { feature: 'unlimited allowance sentinel', where: 'transferFrom', reason: 'cw20 allowances are Uint128; 2^256-1 does not fit (use a large finite allowance)' },
    ] : [{ feature: 'ERC-721 recipe only', where: 'all', reason: 'cw721-base instantiate recipe is provided, not executed here' }],
    notes,
  };
}

export function recipeFiles(spec: ContractSpec, m: StandardMatch, d: CwDesign, info: Cw20TemplateInfo, facts: TokenFacts = {}): Record<string, string> {
  const is20 = m.standard === 'ERC-20';
  if (!is20) {
    const inst = { name: facts.name ?? '<SET_TOKEN_NAME>', symbol: facts.symbol ?? '<SET_TOKEN_SYMBOL>', minter: '<MINTER_ADDRESS>' };
    return { 'cw721/instantiate.json': JSON.stringify(inst, null, 2) + '\n', 'token.json': JSON.stringify({ standard: 'ERC-721', contract: 'cw721-base', note: 'recipe only, not executed', instantiate: inst, features: m.features }, null, 2) + '\n', 'deploy-testnet.sh': deployScript(spec, 'cw721_base.wasm', 'cw721/instantiate.json', 'cw721-base') };
  }
  // name / symbol / supply of the ORIGINAL (read from the source chain); unreadable values stay as marked placeholders that the deploy script refuses to use
  const supply = info.supplyParam !== null ? (facts.totalSupply ?? '<SET_INITIAL_SUPPLY>') : '0';
  const inst = cw20InstantiateMsg(info, (spec.constructor?.params ?? []).map((_p, i) => (i === info.nameParam ? 'xxx' : i === info.symbolParam ? 'XXX' : '0')), 'deployer');
  const msg = JSON.parse(JSON.stringify(inst).replace(/actor:deployer/g, '<DEPLOYER_ADDRESS>'));
  msg.name = facts.name ?? '<SET_TOKEN_NAME>'; msg.symbol = facts.symbol ?? '<SET_TOKEN_SYMBOL>';
  if (facts.decimals !== undefined) msg.decimals = facts.decimals;
  msg.initial_balances = info.supplyParam !== null ? [{ address: '<DEPLOYER_ADDRESS>', amount: supply }] : [];
  return {
    'cw20/instantiate.json': JSON.stringify(msg, null, 2) + '\n',
    'token.json': JSON.stringify({ standard: 'ERC-20', contract: 'cw20-base (cw-plus 2.0.0)', decimals: facts.decimals ?? info.decimals, valuesFrom: facts.source ?? 'unset (placeholders <SET_...> that the deploy script refuses)', divisor: d.decimals.divisor, features: m.features, instantiate: msg }, null, 2) + '\n',
    'deploy-testnet.sh': deployScript(spec, 'cw20_base.wasm', 'cw20/instantiate.json', 'cw20-base'),
  };
}

const deployScript = (spec: ContractSpec, wasm: string, instFile: string, label: string) => `#!/usr/bin/env bash
# Deploy ${spec.name} as the standard ${label} contract on a CosmWasm testnet. Unaudited recipe: review before mainnet.
# Needs a chain CLI (wasmd, neutrond, osmosisd, ...) with a funded testnet key. Not executed by this pipeline.
set -euo pipefail
CLI=\${CLI:-neutrond}                       # your chain's binary
NODE=\${NODE:?set NODE to a testnet RPC, e.g. https://rpc-palvus.pion-1.ntrn.tech:443}
CHAIN_ID=\${CHAIN_ID:?e.g. pion-1}
FROM=\${FROM:?your key name}
FLAGS="--node $NODE --chain-id $CHAIN_ID --from $FROM --gas auto --gas-adjustment 1.4 --fees \${FEES:?e.g. 5000untrn} -y -o json"

# 1. the audited-style reference wasm: build ${label} from github.com/CosmWasm/cw-plus (or cw-nfts for cw721), or use a release artifact
test -f ${wasm} || { echo "put ${wasm} here (cosmwasm-check it first)"; exit 1; }
cosmwasm-check ${wasm}

# 2. store the code
TX=$($CLI tx wasm store ${wasm} $FLAGS | jq -r .txhash); sleep 8
CODE_ID=$($CLI q tx "$TX" --node "$NODE" -o json | jq -r '.events[] | select(.type=="store_code").attributes[] | select(.key=="code_id").value' | head -1)
echo "code id: $CODE_ID"

# 3. instantiate (edit ${instFile}: replace <DEPLOYER_ADDRESS> with the address of $FROM)
sed "s/<DEPLOYER_ADDRESS>/$($CLI keys show $FROM -a)/g; s/<MINTER_ADDRESS>/$($CLI keys show $FROM -a)/g" ${instFile} > /tmp/instantiate.json
# refuse placeholders: name / symbol / supply must be the ORIGINAL token's values, never test values
if grep -q '<SET_' /tmp/instantiate.json; then echo "edit ${instFile}: replace every <SET_...> placeholder with the original token's value (they could not be read from the source chain)"; exit 1; fi
$CLI tx wasm instantiate "$CODE_ID" "$(cat /tmp/instantiate.json)" --label "${spec.name}" --admin "$($CLI keys show $FROM -a)" $FLAGS
`;

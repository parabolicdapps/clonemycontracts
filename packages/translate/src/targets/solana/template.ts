import type { ContractSpec, TokenFacts } from '../../types.js';
import { uiAmount } from '../../spec/facts.js';
import type { StandardMatch } from '../../spec/standard.js';
import type { SolanaDesign } from './design-types.js';

/** Design of a native SPL deployment (no program). */
export function buildTemplateDesign(spec: ContractSpec, m: StandardMatch, decimalsOriginal: number, solDecimals: number): SolanaDesign {
  const notes = [
    `${m.standard} is not rewritten: it is deployed as a native SPL Token mint (classic Token program, Token-2022 optional for metadata).`,
    `Decimals: the Solidity token uses ${decimalsOriginal}; SPL amounts are u64, so ${decimalsOriginal} decimals would cap the supply at about 18.4 whole tokens. Default ${solDecimals} decimals (cap about 18.4 billion tokens); every amount is divided by 10^${decimalsOriginal - solDecimals}. You can choose another value with --decimals.`,
    'The Solidity owner becomes the SPL mint authority (transferOwnership = set_authority, renounce = disable the mint authority).',
    'Allowances become SPL delegates: one delegate per token account (a second approve replaces the first) and no unlimited-allowance sentinel.',
    'There is no zero address on Solana: the zero-address checks of the Solidity contract have no equivalent in the Token program.',
    'name/symbol/URI live in token metadata (Token-2022 metadata extension or Metaplex), not on the mint: deployment recipe only, not executed by this pipeline.',
  ];
  return {
    version: 1, mode: 'template', programName: 'app', decimals: { original: decimalsOriginal, solana: solDecimals, divisor: (10n ** BigInt(Math.max(0, decimalsOriginal - solDecimals))).toString() },
    decimalsNote: decimalsOriginal !== solDecimals ? `Decimals: the original token has ${decimalsOriginal}, the SPL mint ${solDecimals} (amounts divided by ${10n ** BigInt(Math.max(0, decimalsOriginal - solDecimals))}); with u64 balances ${decimalsOriginal} decimals would cap the supply near 18 tokens.` : undefined,
    extraCapabilities: [
      ...(m.features.burnable ? [] : [{ name: 'burn', reason: 'the SPL Token program lets every holder burn its own tokens (and a delegate burn within its delegation); the original has no burn function' }]),
      { name: 'delegate / revoke', reason: 'SPL delegates are per token account (one at a time), not the unlimited multi-spender allowance map of ERC-20' },
      { name: 'close_account', reason: 'an empty token account can be closed and its rent reclaimed; there is no such concept in ERC-20' },
    ],
    allowanceNote: 'allowance = one SPL delegate per token account (see design notes)',
    integerPolicy: [`Amounts are SPL base units (u64) at ${solDecimals} decimals.`], accounts: [], tokens: [], instructions: [], observables: {}, derivedMappings: [],
    notTranslated: [
      { feature: 'zero-address checks', where: 'transfer, mint, transferOwnership', reason: 'no zero address on Solana; the Token program does not check it' },
      { feature: 'unlimited allowance sentinel', where: 'transferFrom', reason: 'SPL delegates have an exact delegated amount' },
      { feature: 'name / symbol / tokenURI', where: 'name, symbol', reason: 'token metadata is a separate extension/program (recipe provided, not executed)' },
    ],
    notes: m.standard === 'ERC-721' ? [...notes, 'NFT: mint one SPL token with 0 decimals per token id and attach Metaplex metadata; marked "recipe, not a program": not executed here.'] : notes,
  };
}

/** a shell value that FAILS the script when it was not set (never a test fixture) */
const shellRequired = (varName: string, what: string) => `"\${${varName}:?set ${varName}: ${what} of the original token (it could not be read from the source chain)}"`;

export function splRecipeFiles(spec: ContractSpec, m: StandardMatch, d: SolanaDesign, params: { facts?: TokenFacts }): Record<string, string> {
  const dec = d.decimals.solana;
  const facts = params.facts ?? {};
  const sh1 = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
  const nameLine = facts.name !== undefined ? `TOKEN_NAME=\${TOKEN_NAME:-${sh1(facts.name)}}` : `TOKEN_NAME=${shellRequired('TOKEN_NAME', 'the name')}`;
  const symLine = facts.symbol !== undefined ? `TOKEN_SYMBOL=\${TOKEN_SYMBOL:-${sh1(facts.symbol)}}` : `TOKEN_SYMBOL=${shellRequired('TOKEN_SYMBOL', 'the symbol')}`;
  let supplyUi: string | null = null; let dustNote = '';
  if (m.initialSupplyParam !== null && facts.totalSupply !== undefined) {
    const u = uiAmount(BigInt(facts.totalSupply), d.decimals.original, dec);
    supplyUi = u.ui;
    if (u.dust > 0n) dustNote = `# NOTE: ${u.dust} base units of the original supply do not fit ${dec} decimals and are dropped.\n`;
  }
  const supplyLine = m.initialSupplyParam === null ? 'SUPPLY=0   # the original has no initial supply' : supplyUi !== null ? `SUPPLY=\${SUPPLY:-${supplyUi}}   # the original's totalSupply (${facts.totalSupply} base units, ${d.decimals.original} decimals), as whole tokens at ${dec} decimals` : `SUPPLY=${shellRequired('SUPPLY', 'the initial supply as whole tokens')}`;
  // who may mint: only a mintable original keeps a mint authority; everything else is disabled right after the initial supply is minted
  const noMint = !m.features.mintable;
  const sh = `#!/usr/bin/env bash
# Deploy ${spec.name} as a native SPL token on Solana devnet. Unaudited: review before using mainnet.
# Needs the Solana CLI and spl-token CLI, and a funded devnet keypair (solana airdrop 2 --url devnet).
# Values come from the ORIGINAL token on ${facts.source ?? 'the source chain (could not be read: set the variables below, the script refuses to run with test values)'}.
set -euo pipefail
URL=\${SOLANA_URL:-https://api.devnet.solana.com}
solana config set --url "$URL" >/dev/null
${nameLine}
${symLine}
${dustNote}${supplyLine}
decimals=${dec}   # the original has ${d.decimals.original}; SPL u64 amounts cap the supply, see design notes

# 1. the mint. spl-token create-token sets NO freeze authority unless --enable-freezing is given; the original has no freeze/pause power, so it is not given.
MINT=$(spl-token create-token --decimals "$decimals" --output json-compact | python3 -c 'import json,sys; print(json.load(sys.stdin)["commandOutput"]["address"])')
echo "mint: $MINT"

# 2. your token account and the initial supply
spl-token create-account "$MINT"
spl-token mint "$MINT" "$SUPPLY"
${noMint ? `
# 3. the original has NO mint path (${m.features.ownable ? 'its owner role cannot mint' : 'it is not ownable and has no mint function'}): disable the mint authority so the supply is fixed for ever
spl-token authorize "$MINT" mint --disable
${m.features.ownable ? '# (the Solidity owner role itself has no SPL counterpart once the mint authority is disabled: documented difference)\n' : ''}` : `
# 3. the original is mintable by its owner: the mint authority stays with the current keypair (= the Solidity owner)
# transferOwnership(newOwner)  ->  spl-token authorize "$MINT" mint <NEW_OWNER_PUBKEY>
${m.features.ownable ? '# renounce (fixed supply)      ->  spl-token authorize "$MINT" mint --disable' : ''}`}
# freeze authority: none (see step 1)

# 4. metadata (name/symbol/URI): needs a Token-2022 mint with the metadata extension, or Metaplex. Not executed by this pipeline.
#    spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb --enable-metadata --decimals "$decimals"
#    spl-token initialize-metadata "$MINT" "$TOKEN_NAME" "$TOKEN_SYMBOL" <METADATA_URI>
`;
  return { 'deploy-devnet.sh': sh, 'token.json': JSON.stringify({ standard: m.standard, program: 'spl-token', decimals: dec, originalDecimals: d.decimals.original, divisor: d.decimals.divisor, mintAuthority: noMint ? null : 'owner keypair', freezeAuthority: null, name: facts.name ?? null, symbol: facts.symbol ?? null, supply: supplyUi, valuesFrom: facts.source ?? 'unset (placeholders that fail when left unset)', features: m.features }, null, 2) + '\n' };
}

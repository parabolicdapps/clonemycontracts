export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type ProviderName = 'sourcify' | 'etherscan' | 'blockscout';

export interface ChainInfo {
  chainId: number;
  name: string;
  alias: string;
  testnet: boolean;
  /** 'evm' chains are supported; 'zksync' style chains are not (need zksolc). */
  kind: 'evm' | 'zksync';
  nativeCurrency: string;
  rpcUrls: string[];
  explorer: {
    name: string | null;
    url: string | null;
    etherscanV2: boolean;
    blockscoutApi: string | null;
  };
  /** Shanghai (PUSH0) supported; verified by an eth_call probe on 2026-11-22. */
  push0: boolean;
  wrappedNative: { symbol: string; address: Address } | null;
  /** well-known contract addresses by kind (verified to have code on the chain). */
  wellKnown: Record<string, Address>;
  /**
   * Highest EVM hardfork the chain's RPC was verified to execute (opcode probes on a live node), e.g. `cancun` or `prague`.
   * null = not verified. Probed by scripts/probe-hardforks.mjs.
   */
  latestHardfork?: string | null;
  /** per-opcode result of the same probe (some chains run only part of a hardfork, e.g. Polygon has TSTORE/MCOPY but no BLOBHASH). Missing = not probed. */
  opcodes?: Partial<Record<EvmFeature, boolean>>;
  /** Chainlink price feeds from Chainlink's reference data, each verified on-chain (`description()`/`decimals()`), keyed by pair e.g. `ETH / USD`. */
  chainlinkFeeds?: Record<string, { address: Address; decimals: number }>;
}

export interface ProxyInfo {
  isProxy: boolean;
  type: string | null;
  implementations: Address[];
}

export interface AbiParam {
  name?: string;
  type: string;
  components?: AbiParam[];
  internalType?: string;
}
export interface AbiItem {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
}

export interface StdJsonInput {
  language: string;
  sources: Record<string, { content: string }>;
  settings: {
    optimizer?: { enabled?: boolean; runs?: number; details?: unknown };
    evmVersion?: string;
    viaIR?: boolean;
    libraries?: Record<string, Record<string, string>>;
    remappings?: string[];
    metadata?: Record<string, unknown>;
    outputSelection?: unknown;
    [k: string]: unknown;
  };
}

export interface VerifiedContract {
  address: Address;
  chainId: number;
  name: string;
  /** Fully qualified `path/File.sol:Name` when known. */
  fullyQualifiedName: string | null;
  /** e.g. `0.8.20+commit.a1b79de6` (Etherscan style `v0.8.20+commit...` is normalised). */
  compilerVersion: string;
  language: 'Solidity' | 'Vyper' | 'Yul' | string;
  stdJsonInput: StdJsonInput;
  evmVersion: string | null;
  optimizer: { enabled: boolean; runs: number };
  abi: AbiItem[];
  /** constructor arguments as 0x hex (may be `0x` for none); null if unknown. */
  constructorArgs: Hex | null;
  /** libraries as in the standard JSON input: file -> name -> address */
  libraries: Record<string, Record<string, string>>;
  creationTxHash: Hex | null;
  /** block of the creation transaction when the provider gave it */
  creationBlock?: number | null;
  /** SPDX id or provider licence string. */
  license: string | null;
  proxy: ProxyInfo;
  /** immutable references of the deployed (runtime) code: astId -> [{start,length}] */
  immutableReferences: Record<string, { start: number; length: number }[]>;
  /** exact/partial match for Sourcify, null for others */
  matchType: string | null;
  provider: ProviderName;
  /** providers that were tried and why they did not answer */
  attempts: { provider: ProviderName; ok: boolean; note?: string }[];
}

export type AddressClass = 'zero' | 'wellknown' | 'contract' | 'eoa' | 'unknown';

export interface AddressFinding {
  address: Address;
  where: string;
  classification: AddressClass;
  label?: string;
  /** kind from the chain registry when well known */
  kind?: string;
  /** known counterpart per chain id (decimal string) */
  counterparts?: Record<string, Address>;
}

export type LicenseClass = 'permissive' | 'copyleft' | 'restricted' | 'none-or-unknown';

export interface DecodedArg {
  index: number;
  name: string;
  type: string;
  abiParam: AbiParam;
  /** JSON-safe value (bigint as decimal string). */
  value: unknown;
}

/** A hard-coded `0x...` address literal in source, with its location and classification. */
export interface SourceLiteral {
  address: Address;
  file: string;
  /** 1-based */
  line: number;
  column: number;
  /** the source line, trimmed */
  snippet: string;
  /** every location of this address in the contract's sources that is code (not a comment) */
  occurrences: number;
  classification: AddressClass;
  label?: string;
  kind?: string;
  counterparts?: Record<string, Address>;
}

/** A call (selector + arguments) decoded against a known ABI. Used for proxy constructor `_data` and for initialiser transactions. */
export interface DecodedCallInfo {
  /** which ABI it was decoded against */
  target: 'proxy' | 'implementation';
  selector: Hex;
  function: string;
  /** canonical signature, e.g. `initialize(string,string,address)` */
  signature: string;
  inputs: AbiParam[];
  args: (DecodedArg & { addresses: { path: (string | number)[]; address: Address; classification: AddressClass; label?: string; kind?: string }[] })[];
}

export interface DiscoveredCall extends DecodedCallInfo {
  txHash: Hex;
  from: Address;
  blockNumber: number;
  /** 0-based order among the discovered calls */
  order: number;
}

export interface InitialisationInfo {
  /** `_data` of the proxy constructor decoded against the implementation ABI (ERC-1967 / Transparent / UUPS / Beacon proxies). */
  constructorCall: (DecodedCallInfo & { argName: string }) | null;
  /** constructor `_data` was present but not decodable (unknown selector) */
  constructorDataUndecoded: { argName: string; data: Hex } | null;
  /** ERC-1967 admin slot value on the source chain */
  adminAddress: Address | null;
  /** proxy whose admin cannot call the implementation (AdminUpgradeabilityProxy `ifAdmin`): the deployer must hand over admin before initialising */
  ifAdminProxy: boolean;
  /** initialiser-like calls to the proxy found in its early transactions (explorer API), in original order */
  discovered: DiscoveredCall[];
  /** admin-change calls found among the early transactions */
  discoveredAdminCalls: DiscoveredCall[];
  /** initialiser-like functions in the implementation ABI (`initialize*`, `init*`, `reinitialize*`, `__*_init`) */
  abiInitialisers: { function: string; signature: string; inputs: AbiParam[] }[];
  /** how discovery went: where the transactions came from, or why nothing was found */
  discovery: { source: 'etherscan' | 'blockscout' | 'rpc' | 'none'; scanned: number; note?: string };
  /** implementation looks protected against direct initialisation (`_disableInitializers()` / constructor sets initialized); null = unknown */
  implementationProtected: boolean | null;
}

export type EvmFeature = 'PUSH0' | 'MCOPY' | 'TSTORE' | 'TLOAD' | 'BLOBHASH' | 'BLOBBASEFEE' | 'CLZ' | 'PREVRANDAO';

export interface CloneAnalysis {
  contract: VerifiedContract;
  proxy: ProxyInfo;
  implementation: CloneAnalysis | null;
  libraries: { file: string; name: string; address: string }[];
  constructorInputs: AbiParam[];
  constructorArgs: DecodedArg[] | null;
  addresses: AddressFinding[];
  immutableCount: number;
  tokenStandards: string[];
  /** this contract's licence: the most restrictive of every licence its files and the provider declare (`ids` lists them all) */
  license: { id: string | null; class: LicenseClass; ids?: string[] };
  /** licences of the libraries this contract links (when they could be fetched) */
  libraryLicenses?: { name: string; address: string; id: string | null; ids: string[]; class: LicenseClass }[];
  evm: {
    effectiveEvmVersion: string;
    needsPush0: boolean;
  };
  unsupported: string[];
  warnings: string[];
  /** hard-coded address literals in this contract's source (code only, not comments), with file/line */
  sourceLiterals?: SourceLiteral[];
  /** proxy initialisation as found on the source chain (null for non-proxies) */
  initialisation?: InitialisationInfo | null;
  /** EIP-1967 beacon behind this proxy (beacon proxies) */
  beacon?: CloneAnalysis | null;
  /** this address is an EIP-1167 minimal proxy; `implementation` holds the analysis of its target */
  minimalProxy?: { standard: 'EIP-1167' } | null;
  /** constructor args were recovered from the creation transaction (the provider did not return them) */
  constructorArgsSource?: 'provider' | 'creation-tx' | 'unknown';
}

export type ArgAction = 'keep' | 'remap' | 'needs-input';

export interface PlanArg {
  index: number;
  name: string;
  type: string;
  abiParam: AbiParam;
  original: unknown;
  /** value used for deployment (JSON-safe); {"$ref":"step:<id>"} objects are resolved at deploy time */
  value: unknown;
  action: ArgAction;
  note?: string;
  /** addresses found inside this argument */
  addresses: { path: (string | number)[]; address: Address; classification: AddressClass; label?: string; suggested?: Address }[];
  /** what we would suggest for a needs-input value, e.g. `{"$ref":"deployer"}` for owner/admin/role addresses. Never applied silently. */
  suggestion?: unknown;
  /** set when this `bytes` argument is an encoded call (proxy constructor `_data`): decoded, remappable arguments. `value` is the encoded hex (null while inputs are missing). */
  call?: PlanCall;
}

/** A function call with individually remappable arguments. */
export interface PlanCall {
  /** step id of the contract the call is made on (or whose ABI decodes it) */
  target: string;
  function: string;
  signature: string;
  selector: Hex;
  args: PlanArg[];
}

export type StepKind = 'library' | 'implementation' | 'proxy' | 'contract' | 'beacon' | 'minimal-proxy' | 'initialise' | 'admin';

export interface PlanStep {
  id: string;
  /**
   * Deployments: library | implementation | proxy | contract | beacon | minimal-proxy.
   * Transactions on an already-deployed step: `initialise` (an initialiser call) and `admin` (hand the proxy admin to another account).
   */
  kind: StepKind;
  /** human description, e.g. `Deploy proxy FiatTokenProxy` or `Initialise proxy: initialize(...)` */
  label: string;
  name: string;
  /** source-chain address this step clones */
  sourceAddress: Address;
  /** key into plan.contracts */
  contractKey: string;
  args: PlanArg[];
  /** libraries to link: fully qualified `file:Name` -> step id or literal address */
  links: Record<string, string>;
  dependsOn: string[];
  /** present for `initialise` and `admin` steps: the call to make (args are in `args`) */
  call?: {
    /** step id of the deployed contract that receives the call */
    target: string;
    function: string;
    signature: string;
    selector: Hex;
    /** found in the source chain's transactions (true) or only detected from the implementation ABI (false) */
    discovered: boolean;
    /** optional steps are skipped (not blocking) until their needs-input arguments are supplied */
    optional: boolean;
    sourceTx?: Hex;
    sourceCaller?: Address;
  };
  /** CREATE2/CREATE3 deployment details for deploy steps when the plan uses a deterministic-address factory */
  create2?: { predictedAddress: Address | null; initCodeHash: Hex | null; note?: string };
}

/** A hard-coded address literal in a contract's source, as a remap item (like a constructor argument). */
export interface PlanLiteral {
  id: string;
  /** key into plan.contracts */
  contractKey: string;
  stepId: string;
  original: Address;
  /** address that will be patched into the source (original when kept) */
  value: Address;
  action: ArgAction;
  note?: string;
  classification: AddressClass;
  label?: string;
  suggested?: Address;
  locations: { file: string; line: number; column: number; snippet: string }[];
  occurrences: number;
}

export interface Create2Plan {
  mode: 'create2' | 'create3';
  factory: Address;
  /** factory has code on the target chain (checked with eth_getCode) */
  factoryVerified: boolean;
  /** user-chosen salt, or derived deterministically */
  salt: Hex;
  saltDerived: boolean;
  /** salt as the factory will use it after its own guarding (sender / chain-id mixing) */
  guardedSalt: Hex | null;
  /** the account whose address the salt may be bound to (permissioned salt); null when no signing key was configured at plan time */
  deployer?: Address | null;
}

export interface ClonePlan {
  version: 1;
  /** 2 since the initialisation / literals / CREATE2 additions (steps may be `initialise`/`admin` calls, steps have `label`) */
  planVersion?: 2;
  from: { chainId: number; address: Address };
  to: { chainId: number };
  steps: PlanStep[];
  /** per contract key: the compiler input needed (standard JSON with chosen evmVersion) */
  contracts: Record<
    string,
    {
      name: string;
      fullyQualifiedName: string | null;
      sourceAddress: Address;
      compilerVersion: string;
      evmVersion: string | null;
      evmVersionOriginal: string | null;
      stdJsonInput: StdJsonInput;
      sourceEdits: { from: string; to: string }[];
      expectedMatch: boolean;
      abi: AbiItem[];
      /** original on-chain constructor args hex */
      originalConstructorArgs: Hex | null;
      /** the source was patched (address literals / --set): the bytecode intentionally differs from the original, which is not a mismatch */
      modifiedSource?: boolean;
    }
  >;
  /** hard-coded source address literals as remap items */
  sourceLiterals?: PlanLiteral[];
  create2?: Create2Plan;
  /** summary of how the clone gets initialised, for display */
  initialisation?: { mode: 'none' | 'constructor-data' | 'separate-transactions'; frontRunnable: boolean; notes: string[] };
  warnings: string[];
  unsupported: string[];
  needsInput: string[];
  overridesApplied: string[];
  /** the most restrictive licence of every contract in the plan */
  license: { id: string | null; class: LicenseClass; ids?: string[] };
  /** a licence per contract of the plan (proxy, implementation, beacon, libraries) */
  licenses?: { role: string; name: string; address: string; id: string | null; ids: string[]; class: LicenseClass }[];
}

export interface Overrides {
  /** `argName` or `stepId.argName` or `0xOLD` -> value; `evmVersion` -> version string */
  [key: string]: string;
}

export class CmcError extends Error {
  constructor(
    message: string,
    public code: 'UNVERIFIED' | 'UNSUPPORTED' | 'RPC' | 'COMPILE' | 'INPUT' | 'DEPLOY' | 'NETWORK' | 'INTERNAL' = 'INTERNAL',
  ) {
    super(message);
    this.name = 'CmcError';
  }
}

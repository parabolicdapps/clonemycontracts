/** Language-neutral contract spec, scenario format, report and the TargetPack interface. Target independent. */

export interface TypeRef {
  /** canonical Solidity type string, e.g. `mapping(address => uint256)`, `uint64`, `address[3]` */
  solidity: string;
  kind: 'uint' | 'int' | 'bool' | 'address' | 'bytes' | 'fixedbytes' | 'string' | 'enum' | 'struct' | 'mapping' | 'array' | 'contract' | 'other';
  bits?: number;
  /** contract/struct/enum name */
  name?: string;
  key?: TypeRef;
  value?: TypeRef;
  element?: TypeRef;
  length?: number;
}

export interface ParamSpec { name: string; type: TypeRef }
export interface SourceRange { file: string; start: number; length: number; line: number; endLine: number }

export interface StateVarSpec {
  name: string;
  type: TypeRef;
  visibility: 'public' | 'internal' | 'private';
  constant: boolean;
  immutable: boolean;
  /** declared in which contract (inheritance flattened) */
  definedIn: string;
  initialValue?: string;
  /** the initialiser evaluated by code from the AST (literals, unit literals, constant expressions, other constants); never model-written */
  initial?: InitialValue;
  /** an initialiser exists but could not be evaluated by code (e.g. `msg.sender`, a function call) */
  initialUnresolved?: boolean;
  range: SourceRange;
}

/** a compile-time value: ints as decimal strings, address as 0x-hex, string/bytes as the literal text */
export interface InitialValue { kind: 'uint' | 'int' | 'bool' | 'address' | 'string' | 'bytes'; value: string; /** how it was obtained */ via: 'ast' | 'original-getter' | 'source-chain' }

/** facts about the ORIGINAL token read from the source chain; absent fields stay unset and deploy recipes carry marked placeholders */
export interface TokenFacts { name?: string; symbol?: string; decimals?: number; /** current totalSupply in base units */ totalSupply?: string; source?: string }

export interface StructSpec { name: string; fields: ParamSpec[] }
export interface EnumSpec { name: string; members: string[] }

export type KeySource =
  | { kind: 'msg.sender' }
  | { kind: 'param'; name: string }
  | { kind: 'statevar'; name: string }
  | { kind: 'this' }
  | { kind: 'literal'; text: string }
  | { kind: 'expr'; text: string };

export interface MappingAccess { variable: string; keys: KeySource[]; write: boolean }

export interface Requirement {
  kind: 'require' | 'revert' | 'assert' | 'if-revert';
  /** condition source text (for require/assert: the condition that must hold) */
  condition: string;
  message?: string;
  /** set when the check comes from a modifier */
  fromModifier?: string;
  range: SourceRange;
}

export interface ExternalCall {
  /** source text of the callee expression, e.g. `token` / `stakingToken` */
  target: string;
  /** method name, e.g. `transferFrom`, `call` */
  method: string;
  /** declared contract/interface type of the target when known */
  targetType?: string;
  sendsValue: boolean;
  low: boolean;
  /** the call sits in a modifier (or something a modifier calls): its result gates the function */
  fromModifier?: string;
  /** the call returns nothing and is view/pure: it can only exist to revert (a guard such as `blacklister.nonBlacklisted(x)`) */
  voidView?: boolean;
  /** the call is part of a require/assert argument, an `if` condition, or the returned value of an internal helper: its result decides what happens */
  inCondition?: boolean;
  /** the call sits in the true-branch of `if (<bool state variable>)`: dead when that flag is false on the source chain (e.g. USDT `deprecated`) */
  underFlag?: string;
  /** argument sources in call order (for token transfers: to / from+to, amount) */
  args: KeySource[];
}

export interface FunctionSpec {
  /** guard-taint analysis (spec/taint.ts): conditions on this function's path that read a value coming from a signature check or another contract */
  guardTaint?: { why: string; kind: 'signature' | 'external'; underFlag?: string }[];
  /** unique key: the Solidity name, or `name_type1_type2` for an overloaded public function (see spec/overloads.ts) */
  name: string;
  /** the Solidity name when `name` was made unique because of overloading */
  solidityName?: string;
  kind: 'function' | 'constructor' | 'receive' | 'fallback';
  visibility: 'public' | 'external' | 'internal' | 'private';
  mutability: 'pure' | 'view' | 'nonpayable' | 'payable';
  payable: boolean;
  params: ParamSpec[];
  returns: ParamSpec[];
  modifiers: string[];
  definedIn: string;
  /** events emitted (including through internal calls and modifiers) */
  events: string[];
  reads: string[];
  writes: string[];
  externalCalls: ExternalCall[];
  requires: Requirement[];
  mappingAccesses: MappingAccess[];
  /** internal functions called (transitively collapsed into the lists above) */
  calls: string[];
  usesTimestamp: boolean;
  /** `stateVar = param` assignments in the body (constructors/initialisers) */
  paramAssignments?: { param: string; stateVar: string }[];
  /** public function that is NOT translated on any target: proxy plumbing (upgrade / admin) or an initialiser / re-initialiser (the constructor path replaces it) */
  excluded?: { category: 'upgrade' | 'initializer'; reason: string };
  /** constructor only: state variables assigned `msg.sender` (here or in a base constructor), e.g. `owner` */
  senderAssignments?: string[];
  /** the expression of `return <expr>;` when the whole body is a single return statement */
  returnExpr?: string;
  /** non-portable feature ids used by this function (see NonPortableFeature.id) */
  nonPortable: string[];
  range: SourceRange;
  /** optional model-written natural language summary; never used for decisions */
  summary?: string;
}

export interface EventSpec { name: string; params: (ParamSpec & { indexed: boolean })[] }
export interface ErrorSpec { name: string; params: ParamSpec[] }

export interface NonPortableFeature {
  id: string;
  title: string;
  where: string[];
  detail: string;
  /** how the pipeline treats it */
  treatment: 'mapped' | 'flagged' | 'not-translated';
}

export interface AccessControlInfo {
  pattern: 'none' | 'Ownable' | 'AccessControl' | 'custom-owner' | 'custom-roles';
  ownerVar?: string;
  /** function name -> guard description */
  guarded: { fn: string; guard: string }[];
}

/** the address given was a proxy: the rewrite targets the implementation behind it */
export interface ProxyInfoSpec { address: string; type: string; implementation: string; proxyName: string; implementationName: string; /** `initialize*` function run through the proxy at deployment; it becomes the constructor of the rewrite */ initializer?: string }

export interface ContractSpec {
  version: 1;
  proxy?: ProxyInfoSpec;
  /** the initialiser function that became the constructor of the rewrite (proxy implementations and initialiser-style contracts) */
  foldedInitializer?: string;
  name: string;
  source: { address?: string; chainId?: number; file?: string; compiler: string; license: string | null };
  inherits: { name: string; openzeppelin: boolean; ozVersion?: string }[];
  stateVars: StateVarSpec[];
  structs: StructSpec[];
  enums: EnumSpec[];
  events: EventSpec[];
  errors: ErrorSpec[];
  constructor: FunctionSpec | null;
  functions: FunctionSpec[];
  /** modifiers defined in non-library user code (for prompts) */
  modifiers: { name: string; range: SourceRange }[];
  accessControl: AccessControlInfo;
  tokenStandards: string[];
  /** state vars / constructor params typed as a contract that is only used through ERC-20 style calls */
  tokenDependencies: { name: string; origin: 'statevar' | 'ctor-param'; type: string; methods: string[] }[];
  nonPortable: NonPortableFeature[];
  hasReceive: boolean;
  hasFallback: boolean;
}

// ---------------------------------------------------------------- scenarios

/** A value in a scenario. Plain JSON except for tagged objects. */
export type Val =
  | string | boolean | number
  | { actor: string }
  | { token: string }
  | { time: number }
  | { zero: true }
  | { hex: string }
  | Val[];

export interface Expectation {
  status: 'success' | 'revert';
  /** revert reason text, recorded from the original when it reverted with Error(string) */
  reason?: string;
  returns?: unknown[];
  events?: string[];
}

export type Step =
  | { type: 'call'; actor: string; fn: string; args: Val[]; valueWei?: string; at: number; expect?: Expectation; observed?: Expectation }
  | { type: 'view'; fn: string; args: Val[]; at: number; expect?: unknown; label: string; /** a public state variable getter (initial-state invariant) */ getter?: boolean };

export interface TokenFixture { name: string; decimals: number; fundings: { actor: string; amount: string }[]; approveContract: boolean }

export interface DeploySpec {
  actor: string;
  args: Val[];
  at: number;
  valueWei?: string;
  expect?: Expectation;
}

export interface Scenario {
  id: string;
  title: string;
  kind: 'init' | 'function' | 'revert' | 'access' | 'sequence' | 'time' | 'extra';
  /** function exercised, when there is one */
  fn?: string;
  deploy: DeploySpec;
  steps: Step[];
  /** proposed by the model and validated on the original */
  source: 'template' | 'model';
  /** this scenario contains a successful call of `valued` whose values were non-trivial on the original (tokens moved, state changed, non-zero arguments) */
  valued?: string[];
  /** security probe: an excluded (initialiser / upgrade) function called by an unprivileged account after deployment; the rewrite must not expose it */
  probe?: string;
  /** negative scenario of a guarded function (unauthorised caller, bad / empty signature, no funds behind a pull): the original must revert, and so must the rewrite */
  negative?: { fn: string; kind: 'unauthorised' | 'bad-signature' | 'unfunded' };
}

export interface ScenarioSet {
  version: 1;
  contract: string;
  t0: number;
  actors: string[];
  tokens: TokenFixture[];
  scenarios: Scenario[];
}

export type Observed = { status: 'success' | 'revert'; reason?: string; returns?: unknown; events?: string[] };

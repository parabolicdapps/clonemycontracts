import type { TypeMap } from './names.js';

export interface KeyD {
  t: TypeMap;
  /** SmartPy type of this key component */
  sp: string;
}

export interface StructFieldD { name: string; solidity: string; t: TypeMap }
export interface StructD { name: string; solidity: string; fields: StructFieldD[] }

export interface StateVarD {
  kind: 'item' | 'map' | 'array';
  solidity: string;
  /** python identifier / accessor suffix: self.data.<name>, get_<name> */
  name: string;
  value: TypeMap;
  struct?: string;
  keys: KeyD[];
  fixedLen?: number;
  public: boolean;
  immutable: boolean;
  /** SmartPy expression of the Solidity default (zero) value of one element */
  zero: string;
  /** a literal initial value from the declaration (`uint x = 5`), already a SmartPy expression */
  init?: string;
  unsupported?: string;
}

export interface ArgD {
  name: string;
  solidity: string;
  t: TypeMap;
  /** index of the Solidity parameter */
  src: number;
  note?: string;
}

export interface ReturnFieldD { name: string; solidity: string; t: TypeMap }
export interface ReturnD { single: boolean; fields: ReturnFieldD[] }

export interface HandlerD {
  /** unit id (`ep_<name>`, `view_<name>`, `initialize`) */
  unit: string;
  kind: 'initialize' | 'entrypoint' | 'view';
  /** python method / Michelson entrypoint / view name */
  name: string;
  solidity: string;
  args: ArgD[];
  payable: boolean;
  returns?: ReturnD;
  /** body written by code (public state getters): the model is not asked */
  generated?: { why: string; body: string };
  emits: string[];
  requires: string[];
  writes: string[];
  notes: string[];
}

export interface TokenDepD { solidity: string; stateName: string | null; methods: string[] }

export type ObservableD = { kind: 'view'; unit: string } | { kind: 'token-balance' } | { kind: 'unobservable'; reason: string };

export interface TezosDesign {
  /** address state variables the constructor set to msg.sender: applied by generated code in initialize */
  senderInits?: string[];
  version: 1;
  mode: 'program' | 'template';
  contractName: string;
  /** the SmartPy class name */
  className: string;
  decimals: { original: number; target: number; divisor: string };
  integerPolicy: string[];
  native: { used: boolean };
  /** the contract has any signed integer (state, parameters, returns, struct fields): subtractions are then NOT rewritten to nat subtractions */
  hasSigned: boolean;
  /** a constructor exists: storage starts uninitialised and `initialize` runs the constructor body once */
  hasInitialize: boolean;
  state: StateVarD[];
  structs: StructD[];
  tokens: TokenDepD[];
  instructions: HandlerD[];
  observables: Record<string, ObservableD>;
  notTranslated: { feature: string; where: string; reason: string }[];
  notes: string[];
  decimalsNote?: string;
  allowanceNote?: string;
  constants: { name: string; solidity: string; value: string | null }[];
  /** helper names the generated class offers (for lint and prompts) */
  helpers: { name: string; sig: string; doc: string }[];
}

import type { TypeMap } from './names.js';

export interface KeyD {
  t: TypeMap;
  /** type of the cw-storage-plus key and of the accessor parameter, e.g. `&Addr`, `u64`, `&str` */
  rust: string;
}

export interface StructFieldD { name: string; solidity: string; t: TypeMap }
export interface StructD { name: string; solidity: string; fields: StructFieldD[] }

export interface StateVarD {
  kind: 'item' | 'map' | 'array';
  /** Solidity name */
  solidity: string;
  /** snake_case accessor suffix: get_<name> / set_<name> */
  name: string;
  /** stored value type */
  value: TypeMap;
  /** name of the generated struct when the value is a struct */
  struct?: string;
  keys: KeyD[];
  /** fixed array length (array kind only) */
  fixedLen?: number;
  public: boolean;
  immutable: boolean;
  /** Rust expression of the Solidity default (zero) value */
  zero: string;
  /** why this variable could not be mapped (the variable is then not generated) */
  unsupported?: string;
}

export interface ArgD {
  name: string;
  solidity: string;
  t: TypeMap;
  /** index of the Solidity parameter; -1 for synthetic fields (native_denom) */
  src: number;
  note?: string;
}

export interface ReturnFieldD { name: string; solidity: string; t: TypeMap }

export interface ReturnD {
  /** one return value: handler returns it bare; several: handler returns the response struct */
  single: boolean;
  /** single: handler return type (address -> String) */
  rust: string;
  t?: TypeMap;
  struct?: string;
  fields: ReturnFieldD[];
}

export interface HandlerD {
  /** file and function name: `instantiate`, `exec_<fn>`, `query_<fn>` */
  unit: string;
  kind: 'instantiate' | 'execute' | 'query';
  /** message variant (PascalCase); empty for instantiate */
  variant: string;
  solidity: string;
  args: ArgD[];
  payable: boolean;
  returns?: ReturnD;
  /** handler body written by code (state getters, array lengths): the model is not asked */
  generated?: { why: string; body: string };
  emits: string[];
  requires: string[];
  writes: string[];
  notes: string[];
}

export interface TokenDepD {
  solidity: string;
  /** state accessor suffix holding its Addr (when the token address is stored) */
  stateName: string | null;
  methods: string[];
}

export type ObservableD = { kind: 'query'; unit: string } | { kind: 'token-balance' } | { kind: 'unobservable'; reason: string };

export interface CwDesign {
  version: 1;
  mode: 'program' | 'template';
  programName: 'app';
  /** amounts are not rescaled: the cw20 token keeps the original decimals; this is only here for the shared pipeline */
  decimals: { original: number; target: number; divisor: string };
  integerPolicy: string[];
  /** native coin: used when the contract is payable or sends native value */
  native: { used: boolean };
  state: StateVarD[];
  structs: StructD[];
  tokens: TokenDepD[];
  /** every handler: instantiate, executes, queries (also the generation units) */
  instructions: HandlerD[];
  observables: Record<string, ObservableD>;
  notTranslated: { feature: string; where: string; reason: string }[];
  notes: string[];
  /** constants the model must inline (name: type = initial value text) */
  decimalsNote?: string;
  allowanceNote?: string;
  extraCapabilities?: { name: string; reason: string }[];
  constants: { name: string; solidity: string; value: string | null }[];
  /** inline state variable initialisers applied by generated code at the top of `instantiate` (values evaluated by code) */
  initials?: { name: string; solidity: string; rustExpr: string; shown: string }[];
}

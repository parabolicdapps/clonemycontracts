import type { KeySource } from '../../types.js';

export type Scale = 'token' | 'plain' | 'ratio';

export interface FieldDesign {
  name: string;
  rust: string;
  solidity: string;
  /** Solidity state variable (or struct field) this comes from */
  source: string;
  scale: Scale;
  note?: string;
}

/** How one key of a PDA is obtained. */
export type KeyRef =
  | { kind: 'caller' }
  | { kind: 'arg'; name: string; rust: string }
  | { kind: 'config'; field: string; rust: string };

export interface StateAccountDesign {
  /** Rust struct name, e.g. `Config`, `User` */
  name: string;
  role: 'config' | 'entry' | 'item';
  /** Solidity mapping/array variables folded into this account */
  sources: string[];
  /** seed prefix bytes (ASCII); the config PDA is `[b"config"]` */
  seedPrefix: string;
  keys: { name: string; rust: 'Pubkey' | 'u64'; solidity: string }[];
  fields: FieldDesign[];
  /** missing entries read as these Solidity defaults (zero / false / zero address) */
  defaultsToZero: boolean;
}

export type AccountKind =
  | 'caller' | 'config' | 'entry' | 'mint' | 'vault' | 'user_token' | 'recipient'
  | 'token_program' | 'system_program' | 'associated_token_program';

export interface AccountRole {
  name: string;
  kind: AccountKind;
  writable: boolean;
  signer?: boolean;
  /** several mutable entries of the same mapping in one instruction: the keys may coincide (self-transfer, sender == fee owner); `dup` lets Anchor accept that */
  dup?: boolean;
  /** view instructions: the entry may not exist (Option<Account>); a missing entry reads as the Solidity default and is never created */
  optional?: boolean;
  /** created by this instruction (init, or init_if_needed for entries) */
  init?: 'init' | 'init_if_needed';
  /** state account struct (config/entry kinds) */
  state?: string;
  keys?: KeyRef[];
  /** token dependency key for mint/vault/user_token */
  token?: string;
  /** user_token: whose ATA */
  owner?: KeySource;
  /** recipient: where its pubkey is stored */
  from?: { state: string; field: string; keys?: KeyRef[] } | { arg: string };
  note?: string;
}

export interface ArgDesign {
  name: string;
  rust: string;
  solidity: string;
  scale: Scale | 'time';
  /** index of the Solidity parameter this argument comes from; -1 for synthetic arguments (msg.value) */
  src: number;
  note?: string;
}

export interface InstructionDesign {
  /** snake_case instruction name = IDL name */
  name: string;
  solidity: string;
  kind: 'initialize' | 'function' | 'view' | 'receive';
  args: ArgDesign[];
  accounts: AccountRole[];
  returns?: { rust: string; solidity: string; scale: Scale };
  emits: string[];
  requires: string[];
  payable: boolean;
  /** Solidity writes state vars (resolved through internal calls and modifiers) */
  writes: string[];
  notes: string[];
}

export interface TokenDesign {
  /** Solidity state variable / constructor parameter name */
  solidity: string;
  /** short key used in account names */
  key: string;
  mintAccount: string;
  mintField: string;
  vault: string;
  methods: string[];
}

export type ObservableDesign =
  | { kind: 'config-field'; field: string; scale: Scale }
  | { kind: 'entry-field'; state: string; keyArgs: ('arg0' | 'arg1')[]; field: string; scale: Scale }
  | { kind: 'array-length'; field: string }
  | { kind: 'membership'; arrayField: string }
  | { kind: 'view-instruction'; instruction: string; scale: Scale }
  | { kind: 'token-balance' }
  | { kind: 'mint-pubkey'; token: string }
  | { kind: 'unobservable'; reason: string };

export interface SolanaDesign {
  version: 1;
  mode: 'program' | 'template';
  programName: 'app';
  /** SPL mint decimals used for fixtures, and the divisor from original base units to Solana base units */
  decimals: { original: number; solana: number; divisor: string };
  integerPolicy: string[];
  accounts: StateAccountDesign[];
  tokens: TokenDesign[];
  instructions: InstructionDesign[];
  /** Solidity function or public variable name -> how to read it on Solana */
  observables: Record<string, ObservableDesign>;
  /** mappings that are replaced by a membership check against an array in the config */
  derivedMappings: { mapping: string; arrayField: string }[];
  notTranslated: { feature: string; where: string; reason: string }[];
  notes: string[];
  /** inline state variable initialisers applied by generated code at the top of `initialize` (values evaluated by code) */
  decimalsNote?: string;
  allowanceNote?: string;
  extraCapabilities?: { name: string; reason: string }[];
  initials?: { field: string; solidity: string; rustValue: string; shown: string }[];
}

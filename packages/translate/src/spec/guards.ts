import type { ContractSpec, ExternalCall } from '../types.js';

type Fn = ContractSpec['functions'][number];

/** methods of an ERC-20/ERC-721 token the targets implement natively (pulls, payouts, balance reads): not an "external dependency" */
const TOKEN_METHODS = /^(transfer|transferFrom|safeTransfer|safeTransferFrom|safeIncreaseAllowance|safeDecreaseAllowance|forceApprove|approve|safeApprove|balanceOf|allowance|totalSupply|decimals|name|symbol|ownerOf)$/;

const isPublic = (f: Fn) => f.kind === 'function' && (f.visibility === 'public' || f.visibility === 'external') && f.mutability !== 'view' && f.mutability !== 'pure';

/** the function verifies an off-chain signature: ecrecover / ECDSA / SignatureChecker / EIP-1271 / a multisig `checkSignatures` */
export function signatureGuarded(f: Fn): boolean {
  if (f.nonPortable.includes('signatures')) return true;
  if (f.externalCalls.some((e) => /^(isValidSignature\w*|checkSignatures|checkNSignatures|recover|tryRecover)$/.test(e.method))) return true;
  if (f.calls.some((c) => /(^|\.)(checkSignatures|checkNSignatures|isValidSignature\w*|verifySignatures?|_verifySignatures?)$/.test(c))) return true;
  return f.requires.some((r) => /\b(ecrecover|isValidSignature\w*|checkSignatures|verifySignatures?)\s*\(/.test(r.condition));
}

/**
 * external calls whose answer GATES the function and that the target cannot reproduce. Only real guard constructs count, never a method name:
 *  - a call inside a modifier (or something a modifier calls),
 *  - a call that returns nothing and is view/pure (it can only exist to revert, e.g. `blacklister.nonBlacklisted(x)`),
 *  - a call that is part of a require/assert argument, an `if` condition, or the returned value of an internal helper used as a guard.
 * Token ops are not included (the targets implement them natively and the lint checks them), and calls under a flag known to be false
 * (`underFlag`, see dropDeadBranches) are removed from the spec before this runs.
 */
export function externalDependencies(f: Fn): ExternalCall[] {
  return f.externalCalls.filter((e) => !e.low && !TOKEN_METHODS.test(e.method) && (!!e.fromModifier || !!e.voidView || !!e.inCondition));
}

/** where the guard-like external calls of a function come from, for the report and tests */
export function describeDependency(e: ExternalCall): string {
  return `${e.target}.${e.method} (${e.fromModifier ? `in modifier ${e.fromModifier}` : e.voidView ? 'void view call: reverts or passes' : 'result decides a require / if / helper return'})`;
}

/**
 * FAIL-CLOSED rule: a public state-changing function whose authorisation or result depends on something the target cannot implement faithfully
 * (signature verification, an external contract's answer) is not translated at all. The pipeline must never "skip the check and continue".
 */
export function failClosedReason(f: Fn): { feature: string; reason: string } | null {
  if (!isPublic(f)) return null;
  if (signatureGuarded(f)) return { feature: 'signature-guarded function (fail closed)', reason: 'the function verifies a signature (ecrecover / EIP-712 / EIP-3009 / EIP-1271 / multisig checkSignatures); the target has a different signature scheme, so the whole function is not translated: skipping the check and keeping the effect would let anyone run it' };
  const taint = f.guardTaint ?? [];
  if (taint.some((t) => t.kind === 'signature')) { const t = taint.find((x) => x.kind === 'signature')!; return { feature: 'signature-guarded function (fail closed)', reason: `the function's path verifies a signature (${t.why}); the target has a different signature scheme, so the whole function is not translated: skipping the check and keeping the effect would let anyone run it` }; }
  if (taint.length) return { feature: 'depends on an external contract (fail closed)', reason: `a guard on the function's path depends on another contract's answer (${taint.slice(0, 2).map((t) => t.why).join('; ')}); the target cannot reproduce it, so the whole function is not translated instead of skipping the check and keeping the effect` };
  const deps = externalDependencies(f);
  if (deps.length) {
    const names = [...new Set(deps.map(describeDependency))].slice(0, 3).join('; ');
    return { feature: 'depends on an external contract (fail closed)', reason: `the function's guard or result depends on a call to another contract (${names}) that the target cannot reproduce; the whole function is not translated instead of skipping the call and keeping the effect` };
  }
  return null;
}

/** what the original checks that the rewrite must check too (before its first state write or value transfer) */
export interface ExpectedGuards { caller: string | null; pulls: ExternalCall[]; valueOut: boolean }
export function expectedGuards(f: Fn): ExpectedGuards {
  const caller = f.requires.find((r) => /msg\.sender|_msgSender\(\)/.test(r.condition) && /(==|!=)/.test(r.condition) && !/\[/.test(r.condition))?.condition
    ?? (f.modifiers.find((m) => /^only(?!Payload|Proxy|Initializing)/i.test(m)) ?? null)
    ?? (f.requires.find((r) => /\b(hasRole|_checkRole|isOwner|isAuthorized)\s*\(/.test(r.condition))?.condition ?? null);
  const pulls = f.externalCalls.filter((e) => !e.low && /^(transferFrom|safeTransferFrom)$/.test(e.method));
  const valueOut = f.externalCalls.some((e) => e.low && e.sendsValue);
  return { caller, pulls, valueOut };
}

/** hard rule appended to every generation prompt (the pipeline also enforces it by code: lint + negative scenarios) */
export const FAIL_CLOSED_PROMPT = 'HARD RULE (fail closed): never drop a check and keep the effect. If a guard of the original cannot be implemented faithfully (a signature / ecrecover / EIP-712 / EIP-1271 check, a role registry or any other contract whose answer gates the function, an external call whose result decides the effect), the function must NOT do its effect at all: make the body revert unconditionally with the message "not supported on this target". Example: `require(registry.isOperator(msg.sender))` followed by a state write -> revert, never "the check is skipped, the effect stays". Every caller / role check of the original must appear in your body BEFORE the first state write or value transfer, and a function that pulls tokens (transferFrom) must pull them. The pipeline fails the whole rewrite as unsafe when a comment says a check is skipped, omitted or accepted as-is.';

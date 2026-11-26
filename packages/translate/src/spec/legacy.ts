import { CmcError } from '@cmc/core';

/**
 * solc before 0.5.0 emits a compact AST that lacks fields the extractor relies on:
 *   - FunctionDefinition has no `kind`: constructors are `isConstructor: true` (named like the contract before 0.4.22),
 *     the fallback function is a function with an empty name; there is no `receive`.
 *   - `stateMutability` only exists from 0.4.16 (older: `constant`/`isDeclaredConst` + `payable`).
 *   - VariableDeclaration has no `mutability` (only `constant`), no `immutable`.
 *   - Events are emitted with a plain call (no EmitStatement before 0.4.21).
 *   - `now`, `sha3`, `suicide`, `throw`, `var` are still legal.
 * normalizeAst() rewrites these in place so that everything downstream sees the 0.5+ shape. It is idempotent and a
 * no-op for 0.8 ASTs. The pre-0.4.12 "legacyAST" (`attributes`/`children`) cannot be normalised faithfully and is rejected loudly.
 */
/** The source cannot be rewritten at all (Vyper, Solidity older than 0.4.12): typed so that an API maps it to 422, never to a generic failure. */
export class UnsupportedSourceError extends CmcError {
  constructor(message: string, readonly language: string, readonly version: string) {
    super(message, 'UNSUPPORTED');
    this.name = 'UnsupportedSourceError';
  }
}

/** Throws UnsupportedSourceError for Vyper / Yul and for Solidity before 0.4.12 (no usable compact AST). */
export function assertSupportedSource(language: string | undefined, compilerVersion: string): void {
  const lang = (language ?? 'Solidity').toString();
  if (/vyper/i.test(lang) || /vyper/i.test(compilerVersion)) throw new UnsupportedSourceError(`Vyper contracts cannot be rewritten (compiler ${compilerVersion})`, 'Vyper', compilerVersion);
  if (/yul/i.test(lang)) throw new UnsupportedSourceError('Yul sources cannot be rewritten', 'Yul', compilerVersion);
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(compilerVersion);
  if (m && (Number(m[1]) === 0 && (Number(m[2]) < 4 || (Number(m[2]) === 4 && Number(m[3]) < 12)))) throw new UnsupportedSourceError(`Solidity ${m[1]}.${m[2]}.${m[3]} is older than 0.4.12 (legacy AST): not supported`, 'Solidity', compilerVersion);
}

export function isLegacyShape(ast: any): boolean {
  return !!ast && !ast.nodeType && (ast.name === 'SourceUnit' || Array.isArray(ast.children));
}

export function normalizeAst(ast: any, compilerVersion = ''): any {
  if (isLegacyShape(ast)) throw new UnsupportedSourceError(`solc ${compilerVersion || '<0.4.12'} produced the pre-0.4.12 legacy AST (attributes/children), which is not supported; the rewrite is stopped instead of continuing with an empty spec`, 'Solidity', compilerVersion);
  const eventIds = new Set<number>();
  const visit = (n: any, fn: (x: any) => void) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x, fn); return; }
    if (n.nodeType) fn(n);
    for (const k of Object.keys(n)) { if (k === 'typeDescriptions' || k === 'src') continue; const v = n[k]; if (v && typeof v === 'object') visit(v, fn); }
  };
  visit(ast, (n) => { if (n.nodeType === 'EventDefinition') eventIds.add(n.id); });
  visit(ast, (n) => {
    switch (n.nodeType) {
      case 'FunctionDefinition': {
        if (n.kind === undefined) {
          n.kind = n.isConstructor ? 'constructor' : n.name === '' ? 'fallback' : 'function';
          if (n.isConstructor) n.name = '';
        }
        if (n.stateMutability === undefined) n.stateMutability = n.payable ? 'payable' : (n.isDeclaredConst || n.constant) ? 'view' : 'nonpayable';
        if (n.visibility === undefined) n.visibility = 'public';
        break;
      }
      case 'VariableDeclaration':
        if (n.mutability === undefined) n.mutability = n.constant ? 'constant' : 'mutable';
        if (n.visibility === undefined) n.visibility = n.stateVariable ? 'internal' : 'internal';
        break;
      case 'FunctionCall':
        if (n.kind === undefined) n.kind = n.type_conversion || n.typeConversion ? 'typeConversion' : n.isStructConstructorCall ? 'structConstructorCall' : 'functionCall';
        break;
      case 'ExpressionStatement': {
        // pre-0.4.21 event emission: `Transfer(a, b, c);` is a call to the event
        const e = n.expression;
        if (e?.nodeType === 'FunctionCall' && e.expression?.nodeType === 'Identifier' && eventIds.has(e.expression.referencedDeclaration)) {
          n.nodeType = 'EmitStatement'; n.eventCall = e; delete n.expression;
        }
        break;
      }
      case 'Throw': break;
    }
  });
  return ast;
}

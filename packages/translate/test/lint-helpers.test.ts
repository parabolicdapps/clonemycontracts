import { describe, expect, it } from 'vitest';
import { compileWithAst, stdInputForSource } from '../src/spec/compile.js';
import { extractSpec } from '../src/spec/extract.js';
import { lintSecurity } from '../src/pipeline/security.js';
import { renderReport } from '../src/pipeline/report.js';

const compile = async (body: string) => { const c = await compileWithAst({ compilerVersion: '0.8.28+commit.7893614a', stdJsonInput: stdInputForSource('X.sol', `pragma solidity ^0.8.0;\n${body}`), contract: 'X' }); return extractSpec(c, {}); };
const SRC = `interface IERC20 { function transferFrom(address a, address b, uint v) external returns (bool); }
contract X { IERC20 public token; address public funder; uint public total;
  constructor(address t) { token = IERC20(t); funder = msg.sender; }
  function fund(uint amount) external { require(msg.sender == funder, "not funder"); total += amount; token.transferFrom(msg.sender, address(this), amount); } }`;

const fails = (r: ReturnType<typeof lintSecurity>) => r.filter((x) => x.status === 'FAIL');

/** [target, body with the helper call, same body without it] */
const CASES: Array<[string, string, string]> = [
  // the exact ep_fund body of the Tezos pack output that the end-to-end test wrongly flagged
  ['tezos', `        assert sp.sender == self.data.funder, "not funder"
        assert not self.data.revoked, "revoked"
        self.data.total_allocation = self.data.total_allocation + amount
        # the token pull is queued and runs after this entrypoint returns; if it fails, everything above is reverted too
        self.erc20_transfer_from(sp.record(token=self.data.token, from_=sp.sender, to=sp.self_address, amount=amount))
        sp.emit(sp.record(amount=amount), tag="Funded")`,
  `        assert sp.sender == self.data.funder, "not funder"
        assert not self.data.revoked, "revoked"
        self.data.total_allocation = self.data.total_allocation + amount
        # the token pull is queued and runs after this entrypoint returns; if it fails, everything above is reverted too
        sp.emit(sp.record(amount=amount), tag="Funded")`],
  ['cosmwasm', `    if info.sender != FUNDER.load(deps.storage)? { return Err(ContractError::Unauthorized {}); }\n    TOTAL.save(deps.storage, &amount)?;\n    let msgs = helpers::cw20_transfer_from(&token, &info.sender, &env.contract.address, amount)?;\n    Ok(Response::new().add_messages(msgs))`,
  `    if info.sender != FUNDER.load(deps.storage)? { return Err(ContractError::Unauthorized {}); }\n    TOTAL.save(deps.storage, &amount)?;\n    Ok(Response::new())`],
  ['solana', `    require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.config.funder, AppError::Funder);\n    helpers::user_to_vault(&ctx.accounts.token_program, &ctx.accounts.user_ata, &ctx.accounts.mint, &ctx.accounts.vault, &ctx.accounts.caller, amount)?;\n    ctx.accounts.config.total += amount;\n    Ok(())`,
  `    require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.config.funder, AppError::Funder);\n    ctx.accounts.config.total += amount;\n    Ok(())`],
  ['aptos', `    assert!(signer::address_of(caller) == funder(), E_NOT_FUNDER);\n    token_pull(caller, amount);\n    set_total(total() + amount);`,
  `    assert!(signer::address_of(caller) == funder(), E_NOT_FUNDER);\n    set_total(total() + amount);`],
];

describe('security lint recognises the helpers the target packs generate', () => {
  for (const [target, withCall, without] of CASES) {
    it(`${target}: a body with the pack's own token-pull helper is not flagged, the same body without it still is`, async () => {
      const spec = await compile(SRC);
      expect(fails(lintSecurity(target, spec, (fn) => fn, { fund: withCall })), target).toEqual([]);
      const bad = fails(lintSecurity(target, spec, (fn) => fn, { fund: without }));
      expect(bad.map((x) => x.fn), target).toEqual(['fund']);
      expect(bad[0]!.problems.join(), target).toMatch(/no token transfer/);
    });
  }
  it('a plain token PUSH (tezos erc20_transfer / solana vault_to_account) does not count as a pull', async () => {
    const spec = await compile(SRC);
    const t = '        assert sp.sender == self.data.funder, "x"\n        self.erc20_transfer(sp.record(token=self.data.token, to=sp.sender, amount=amount))';
    expect(fails(lintSecurity('tezos', spec, (fn) => fn, { fund: t })).length).toBe(1);
    const s = '    require_keys_eq!(ctx.accounts.caller.key(), ctx.accounts.config.funder, AppError::Funder);\n    helpers::vault_to_account(&tp, &v, &m, &to, &cfg, amount)?;';
    expect(fails(lintSecurity('solana', spec, (fn) => fn, { fund: s })).length).toBe(1);
  });
});

describe('report wording for FAILED-BEHAVIOUR without failing scenarios', () => {
  const base = (conformance: string[], unsafe: boolean) => renderReport({ version: 1, contract: 'X', source: {}, target: 'tezos', path: 'model', status: 'FAILED-BEHAVIOUR', statusReasons: ['x'], coverage: { functionsTotal: 0, functionsVerified: 0, functionsUnverified: [], uncheckedFunctions: [], trivialOnlyFunctions: [], notTranslatedFunctions: [], functionsAbsent: [], functionsPresent: 0, failedFunctions: [], otherUnverifiedFunctions: [], uncomparedReturns: [], notRunnableScenarios: [], getters: { planned: 0, checked: 0, mismatched: 0, notCompared: [] }, summary: 's' },
    compile: { ok: true, round: 0, rounds: [] }, behaviour: { ran: true, passed: 24, failed: 0, notRunnable: 0, documented: 0, total: 24, rounds: [], conformance }, functions: [], nonPortable: [], notTranslated: [], designNotes: [], extraCapabilities: [], deploy: [], usage: { requests: 0, tokensIn: 0, tokensOut: 0, modelSecs: 0 }, wallSecs: 0, outcomes: [], scenarioCount: 24,
    security: { checked: 0, probes: [], problems: unsafe ? ['p'] : [], unsafe, lint: [], negativeFailures: [], negativeScenarios: 0 } } as never);
  it('conformance only: the design sentence', () => { const md = base(['c1'], false); expect(md).toMatch(/does not follow the generated design/); expect(md).not.toMatch(/static security check found/); });
  it('security only: every scenario passed, but the security check failed', () => { const md = base([], true); expect(md).toMatch(/Every scenario that ran passed, but the static security check found a problem/); expect(md).not.toMatch(/does not follow the generated design/); });
  it('both: both sentences', () => { const md = base(['c1'], true); expect(md).toMatch(/does not follow the generated design/); expect(md).toMatch(/static security check found a problem/); });
});

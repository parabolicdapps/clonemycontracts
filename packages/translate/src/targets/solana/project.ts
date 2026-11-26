import type { ContractSpec } from '../../types.js';
import type { SolanaDesign } from './design-types.js';
import { genAccounts, genErrors, genEvents, genHandler, genHelpers, genLib, genLogicMod, genSkeleton, genState, genStubHandler } from './codegen.js';

export const DECLARE_ID = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';

/** Files that are produced by code from the design (the model never edits these). */
export function fixedFiles(spec: ContractSpec, design: SolanaDesign): Record<string, string> {
  return {
    ...genSkeleton(),
    'programs/app/src/lib.rs': genLib(design, DECLARE_ID),
    'programs/app/src/state.rs': genState(design),
    'programs/app/src/events.rs': genEvents(spec),
    'programs/app/src/errors.rs': genErrors(spec),
    'programs/app/src/helpers.rs': genHelpers(),
    'programs/app/src/ctxs.rs': genAccounts(design),
    'programs/app/src/logic/mod.rs': genLogicMod(design),
  };
}

/** Full project: fixed files plus one handler file per instruction (body from `bodies`, else a stub). */
export function assembleProject(spec: ContractSpec, design: SolanaDesign, bodies: Record<string, string>): Record<string, string> {
  const files = fixedFiles(spec, design);
  for (const ins of design.instructions) {
    const b = bodies[ins.name];
    files[`programs/app/src/logic/${ins.name}.rs`] = b !== undefined ? genHandler(ins, b, design) : genStubHandler(ins, design);
  }
  return files;
}

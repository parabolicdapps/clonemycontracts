import type { ContractSpec } from '../../types.js';
import type { CwDesign } from './design-types.js';
import { genCargo, genContract, genError, genEvents, genHandler, genHandlersMod, genHelpers, genLib, genMsg, genState, genStubHandler } from './codegen.js';

/** Files produced by code from the design (the model never edits these). */
export function fixedFiles(spec: ContractSpec, design: CwDesign): Record<string, string> {
  return {
    'Cargo.toml': genCargo(),
    'src/lib.rs': genLib(),
    'src/error.rs': genError(spec),
    'src/events.rs': genEvents(spec),
    'src/msg.rs': genMsg(design),
    'src/state.rs': genState(design),
    'src/helpers.rs': genHelpers(design),
    'src/contract.rs': genContract(design),
    'src/handlers/mod.rs': genHandlersMod(design),
  };
}

/** Full project: fixed files plus one handler file per unit (body from `bodies`, else generated/stub). */
export function assembleProject(spec: ContractSpec, design: CwDesign, bodies: Record<string, string>): Record<string, string> {
  const files = fixedFiles(spec, design);
  for (const h of design.instructions) {
    if (h.generated) { files[`src/handlers/${h.unit}.rs`] = genHandler(h, h.generated.body); continue; }
    const b = bodies[h.unit];
    files[`src/handlers/${h.unit}.rs`] = b !== undefined ? genHandler(h, b, design) : genStubHandler(h, design);
  }
  return files;
}

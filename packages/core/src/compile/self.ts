/** Libraries start with PUSH20 <own address>; solc leaves zeros there in the compiler output. */
export function fixLibrarySelfRuntime(recompiled: string, onchain: string): string {
  if (/^73(00){20}/.test(recompiled) && /^0x73/.test(onchain)) return onchain.slice(2, 44).toLowerCase() + recompiled.slice(42);
  return recompiled;
}

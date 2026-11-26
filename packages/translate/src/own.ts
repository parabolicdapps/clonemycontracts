/** Own-property lookup for records keyed by Solidity function/variable names (`constructor`, `toString`, `__proto__`, `hasOwnProperty` are legal names). */
export const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
/** A record without Object.prototype, so that function names can never hit inherited members. */
export const nullRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

// usage: vite-node scripts/cosmwasm-spec-dump.ts <Name>   prints the ContractSpec of a test fixture
import { load } from '../test/helpers.js';
const { spec } = await load(process.argv[2]!);
console.log(JSON.stringify(spec, (k, v) => (k === 'range' ? undefined : v), 1));

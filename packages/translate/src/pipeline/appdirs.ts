import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppPaths { data: string; cache: string; config: string; /** scratch for toolchain containers (a bind-mount source, so it must be somewhere Docker shares) */ work: string }

/**
 * Where the app keeps its files. macOS: ~/Library/Application Support/CloneMyContracts (data, config), ~/Library/Caches/CloneMyContracts.
 * Linux: XDG data/cache/config under `clonemycontracts`. `CMC_DATA_DIR` and `CMC_CONFIG_DIR` override one each.
 */
export function appPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): AppPaths {
  let data: string, cache: string, config: string;
  if (platform === 'darwin') {
    data = config = join(home, 'Library', 'Application Support', 'CloneMyContracts');
    cache = join(home, 'Library', 'Caches', 'CloneMyContracts');
  } else {
    const x = (v: string | undefined, fallback: string) => (v && v.startsWith('/') ? v : fallback);
    data = join(x(env.XDG_DATA_HOME, join(home, '.local', 'share')), 'clonemycontracts');
    cache = join(x(env.XDG_CACHE_HOME, join(home, '.cache')), 'clonemycontracts');
    config = join(x(env.XDG_CONFIG_HOME, join(home, '.config')), 'clonemycontracts');
  }
  if (env.CMC_DATA_DIR) data = env.CMC_DATA_DIR;
  if (env.CMC_CONFIG_DIR) config = env.CMC_CONFIG_DIR;
  return { data, cache, config, work: join(data, 'work') };
}

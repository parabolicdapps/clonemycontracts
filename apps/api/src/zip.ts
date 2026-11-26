import { crc32, deflateRawSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function walk(dir: string, prefix = '', skip: string[] = []): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir)) {
    const p = join(dir, e);
    if (skip.includes(`${prefix}${e}`)) continue;
    if ((await stat(p)).isDirectory()) out.push(...(await walk(p, `${prefix}${e}/`, skip)));
    else out.push(`${prefix}${e}`);
  }
  return out.sort();
}

/** Minimal zip writer (deflate) for a directory tree; enough for the project download. */
export async function zipDirectory(dir: string, root: string, skip: string[] = []): Promise<Buffer> {
  const files = await walk(dir, '', skip);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const data = await readFile(join(dir, f));
    const comp = deflateRawSync(data);
    const store = comp.length >= data.length;
    const body = store ? data : comp;
    const name = Buffer.from(`${root}/${f}`);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(store ? 0 : 8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

async function compressDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await compressDirectory(path);
    else if (/\.(?:js|css|html|svg|json)$/.test(entry.name)) {
      const source = await readFile(path);
      await Promise.all([
        compressBrotli(source).then(data => writeFile(`${path}.br`, data)),
        compressGzip(source).then(data => writeFile(`${path}.gz`, data)),
      ]);
    }
  }
}

await compressDirectory(fileURLToPath(new URL("../dist/", import.meta.url)));

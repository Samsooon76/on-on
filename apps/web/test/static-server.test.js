import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { createStaticServer } from "../static-server.mjs";

test("static assets negotiate compression, preserve cache headers and support uncompressed builds", async t => {
  const root = await mkdtemp(join(tmpdir(), "onoff-web-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "assets"));
  const source = "export const value = 'hello';".repeat(100);
  await Promise.all([
    writeFile(join(root, "assets/app-test.js"), source),
    writeFile(join(root, "assets/app-test.js.br"), brotliCompressSync(source)),
    writeFile(join(root, "assets/app-test.js.gz"), gzipSync(source)),
    writeFile(join(root, "index.html"), "<main>Application</main>"),
  ]);
  const server = createStaticServer(root).listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, "listening");
  const read = (path, encoding, method = "GET") => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, path, method, headers: encoding ? { "accept-encoding": encoding } : {} }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  const br = await read("/assets/app-test.js", "gzip, br");
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(brotliDecompressSync(br.body).toString(), source);
  assert.equal(br.headers.vary, "Accept-Encoding");
  assert.match(br.headers["cache-control"], /immutable/);
  assert.equal(Number(br.headers["content-length"]), br.body.length);
  for (const encoding of ["br;q=0, gzip", "br;q=0.5, gzip;q=1"]) {
    const gz = await read("/assets/app-test.js", encoding);
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(gz.body).toString(), source);
  }
  for (const encoding of [undefined, "identity", "br;q=0, gzip;q=0", "*;q=0"]) {
    const plain = await read("/assets/app-test.js", encoding);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.body.toString(), source);
  }
  const head = await read("/assets/app-test.js", "br", "HEAD");
  assert.equal(head.body.length, 0);
  assert.equal(head.headers["content-length"], br.headers["content-length"]);
  const spa = await read("/settings", "br, gzip");
  assert.equal(spa.body.toString(), "<main>Application</main>");
  assert.equal(spa.headers["cache-control"], "no-cache");
  assert.equal((await read("/assets/missing.js", "br")).status, 404);
  assert.equal((await read("/%2e%2e%2fsecret", "br")).status, 403);
  assert.equal((await read("/", "br", "POST")).status, 405);
});

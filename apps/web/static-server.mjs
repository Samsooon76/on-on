import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

function acceptedEncodings(header = "") {
  const qualities = new Map(header.toLowerCase().split(",").map(value => {
    const [name, ...parameters] = value.trim().split(";");
    const quality = parameters.find(parameter => parameter.trim().startsWith("q="));
    return [name, quality === undefined ? 1 : Number(quality.trim().slice(2))];
  }));
  return ["br", "gzip"]
    .map(name => ({ name, quality: qualities.get(name) ?? qualities.get("*") ?? 0 }))
    .filter(item => item.quality > 0 && item.quality <= 1)
    .sort((a, b) => b.quality - a.quality);
}

export function createStaticServer(webRoot) {
  return createServer(async (request, response) => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end();
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/health/live") {
      response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(request.method === "HEAD" ? undefined : JSON.stringify({ status: "ok" }));
      return;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      response.writeHead(400, headers).end();
      return;
    }
    if (decodedPath.includes("\0")) {
      response.writeHead(400, headers).end();
      return;
    }

    const requestedPath = resolve(webRoot, `.${decodedPath}`);
    if (requestedPath !== webRoot && !requestedPath.startsWith(`${webRoot}${sep}`)) {
      response.writeHead(403, headers).end();
      return;
    }

    let filePath = requestedPath;
    let file;
    try {
      file = await readFile(filePath);
    } catch {
      if (decodedPath.startsWith("/assets/") || extname(decodedPath)) {
        response.writeHead(404, headers).end();
        return;
      }
      filePath = resolve(webRoot, "index.html");
      try {
        file = await readFile(filePath);
      } catch {
        response.writeHead(503, headers).end("Web build is missing.");
        return;
      }
    }

    const isHashedAsset = decodedPath.startsWith("/assets/");
    let encoding;
    if (/\.(?:js|css|html|svg|json)$/.test(filePath)) {
      for (const { name } of acceptedEncodings(request.headers["accept-encoding"])) {
        try {
          file = await readFile(`${filePath}.${name === "br" ? "br" : "gz"}`);
          encoding = name;
          break;
        } catch { /* Uncompressed builds remain usable during local development. */ }
      }
    }
    response.writeHead(200, {
      ...headers,
      "Content-Type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
      Vary: "Accept-Encoding",
      "Content-Length": file.length,
      ...(encoding ? { "Content-Encoding": encoding } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : file);
  });
}

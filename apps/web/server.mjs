import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const server = createServer(async (request, response) => {
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
  response.writeHead(200, {
    ...headers,
    "Content-Type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
    "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
  });
  response.end(request.method === "HEAD" ? undefined : file);
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ event: "web_server_started", port }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

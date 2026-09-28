import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticServer } from "./static-server.mjs";

const webRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "dist");
const server = createStaticServer(webRoot);

const port = Number(process.env.PORT ?? 4173);
server.listen(port, "0.0.0.0", () => {
  console.info(JSON.stringify({ event: "web_server_started", port }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

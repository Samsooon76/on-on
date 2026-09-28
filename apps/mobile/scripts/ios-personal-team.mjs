import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const mobileDirectory = fileURLToPath(new URL("../", import.meta.url));
const entitlementsPath = fileURLToPath(new URL("../ios/Onoff/Onoff.entitlements", import.meta.url));
const pushEntitlement = /^[ \t]*<key>aps-environment<\/key>\r?\n[ \t]*<string>(development|production)<\/string>\r?\n/m;
const env = { ...process.env, EXPO_PUBLIC_IOS_LOCAL_NO_PUSH: "1" };
const { values, positionals } = parseArgs({
  options: { dev: { type: "boolean", default: false } },
  allowPositionals: true,
});
if (positionals.length > 1) throw new Error("Indiquez un seul nom ou identifiant d'iPhone.");
const device = positionals[0];
const configuration = values.dev ? "Debug" : "Release";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: mobileDirectory, env, stdio: "inherit", detached: true });
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = signals.map((signal) => {
      const handler = () => {
        try { process.kill(-child.pid, signal); } catch { /* The command already exited. */ }
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      resolve(signal ? 128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1) : code ?? 1);
    });
  });
}

const original = await readFile(entitlementsPath, "utf8");
const withoutPush = original.replace(pushEntitlement, "");
if (withoutPush === original) {
  throw new Error(`Autorisation APNs introuvable dans ${entitlementsPath}. Vérifiez le projet iOS avant de lancer l'aperçu.`);
}

let status;
try {
  await writeFile(entitlementsPath, withoutPush);
  console.log("Compilation iOS avec APNs désactivé temporairement pour l'équipe Apple personnelle.");
  console.log(values.dev
    ? "Mode développement : Metro reste ouvert pendant l'essai ; Ctrl-C rétablit l'autorisation APNs d'origine."
    : "Version autonome : le code est inclus dans l'app, qui démarre sans URL ni serveur Metro.");
  status = await run("pnpm", [
    "ios", "--device", ...(device ? [device] : []),
    "--configuration", configuration,
    ...(!values.dev ? ["--no-bundler"] : []),
  ]);
} finally {
  await writeFile(entitlementsPath, original);
  console.log("Autorisation APNs d'origine rétablie dans le projet.");
}

process.exitCode = status;

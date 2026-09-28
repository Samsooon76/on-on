import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  manifest: {
    name: "Onoff click-to-call",
    description: "Détecte les numéros de la page et lance les appels dans Onoff.",
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    permissions: ["activeTab", "scripting", "storage"],
  },
});

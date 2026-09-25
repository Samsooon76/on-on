import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifestVersion: 3,
  manifest: {
    name: "Onoff click-to-call",
    description: "Ouvre le composeur Onoff avec le numéro choisi.",
    permissions: ["activeTab", "scripting", "storage"],
  },
});

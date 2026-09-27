import { writeFileSync } from "node:fs";
import { ambientGradient, palette, radius } from "./index.ts";

const tokens = {
  ink: palette.ink, muted: palette.muted, accent: palette.accent,
  "accent-dark": palette.accentDark, "accent-soft": palette.selected,
  canvas: palette.canvas, surface: palette.surface, line: palette.line,
  lavender: palette.lavender, violet: palette.lavenderDeep,
  lime: palette.lime, success: palette.success, "success-soft": palette.green,
  danger: palette.red, "danger-soft": palette.redLight,
  warning: palette.amber, "warning-soft": palette.amberLight,
  "radius-control": `${radius.control}px`, "radius-card": `${radius.card}px`,
  "radius-dialog": `${radius.dialog}px`,
};
writeFileSync(new URL("./theme.css", import.meta.url), `/* Generated from index.ts by generate-css.ts. */
@font-face {
  font-family: 'Inter';
  src: url('./assets/inter-variable.woff2') format('woff2');
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
:root {
${Object.entries(tokens).map(([key, value]) => `  --${key}: ${value};`).join("\n")}
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --shadow-card: 0 2px 4px rgb(0 0 0 / 3%);
  --shadow-overlay: 0 20px 65px rgb(0 0 0 / 14%);
  --wash: ${ambientGradient};
  --gradient-text: linear-gradient(100deg, #b368d6 1%, #d77fc6 38%, #ec8eab 64%, #ecc42e 99%);
  color-scheme: light;
}
`);

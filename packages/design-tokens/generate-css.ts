import { writeFileSync } from "node:fs";
import { palette, radius } from "./index.ts";

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
  --shadow-card: 0 2px 4px rgb(45 27 55 / 3%);
  --shadow-overlay: 0 20px 65px rgb(45 27 55 / 14%);
  --wash: radial-gradient(ellipse 600px 440px at 0 0, #e6c9e8 0%, #ead9f0 25%, #f5eff9 65%, transparent 100%);
  --highlight: linear-gradient(110deg, #a2f2b3, #d5f0a0 60%, #f5f386);
  --gradient-text: linear-gradient(105deg, #9460b6, #b667a5 48%, #b17630);
  color-scheme: light;
}
`);

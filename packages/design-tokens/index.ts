/** Neutral controls from dash, with the user's pastel reference as the ambient canvas. */
export const palette = {
  ink: "#242424",
  muted: "#626262",
  accent: "#242424",
  accentDark: "#171717",
  canvas: "#FFFFFF",
  surface: "#F5F5F5",
  line: "#E7E7E7",
  white: "#FFFFFF",
  lavender: "#F0E5F4",
  lavenderDeep: "#84549A",
  selected: "#EFEFEF",
  green: "#EDF6E8",
  lime: "#DDF3A0",
  success: "#39742D",
  red: "#AB4545",
  redLight: "#FAF0F0",
  amber: "#8B6329",
  amberLight: "#FFF5E5",
} as const;

export const radius = { control: 8, card: 12, dialog: 18 } as const;

// One pastel glow anchored to the upper-left corner. Every layer fades to
// transparent within 640 x 420 px, leaving the white canvas untouched beyond it.
// CSS and React Native render the same layers.
export const ambientGradient = [
  "radial-gradient(ellipse 170px 210px at 0px 0px, rgba(228, 200, 248, 0.65) 0%, rgba(228, 200, 248, 0) 100%)",
  "radial-gradient(ellipse 220px 290px at 35px 80px, rgba(255, 195, 214, 0.65) 0%, rgba(255, 195, 214, 0) 100%)",
  "radial-gradient(ellipse 240px 260px at 165px 0px, rgba(255, 222, 166, 0.8) 0%, rgba(255, 222, 166, 0) 100%)",
  "radial-gradient(ellipse 310px 260px at 330px 0px, rgba(196, 223, 255, 0.75) 0%, rgba(196, 223, 255, 0) 100%)",
  "radial-gradient(ellipse 200px 300px at 0px 120px, rgba(255, 205, 183, 0.4) 0%, rgba(255, 205, 183, 0) 100%)",
].join(", ");

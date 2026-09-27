/** Onoff's shared palette, adapted from dash/index.html. Light on every platform. */
export const palette = {
  ink: "#242424",
  muted: "#6E6873",
  accent: "#28232D",
  accentDark: "#17131C",
  canvas: "#FFFFFF",
  surface: "#F7F5F8",
  line: "#E8E3EB",
  white: "#FFFFFF",
  lavender: "#F0E5F4",
  lavenderDeep: "#84549A",
  selected: "#EEE7F2",
  green: "#EDF6E8",
  lime: "#DDF3A0",
  success: "#39742D",
  red: "#AB4545",
  redLight: "#FAF0F0",
  amber: "#8B6329",
  amberLight: "#FFF5E5",
} as const;

export const radius = { control: 8, card: 12, dialog: 18 } as const;

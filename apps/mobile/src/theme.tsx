import { StyleSheet, View, type TextStyle } from "react-native";
import { ambientGradient } from "@onoff/design-tokens";
export { palette } from "@onoff/design-tokens";

// Static font files keep each weight consistent on Android and iOS.
export function themedStyles<T extends StyleSheet.NamedStyles<T>>(definitions: T): T {
  const themed = Object.fromEntries(Object.entries(definitions).map(([key, value]) => {
    const style = value as TextStyle;
    if (style.fontSize === undefined && style.fontWeight === undefined) return [key, value];
    const weight = Number(style.fontWeight ?? 400);
    const font = weight >= 650 ? 700 : weight >= 550 ? 600 : weight >= 450 ? 500 : 400;
    return [key, { ...style, fontFamily: `Inter${font}`, fontWeight: "normal" }];
  })) as T;
  return StyleSheet.create(themed);
}

export function AmbientBackground() {
  return <View pointerEvents="none" accessible={false} style={[StyleSheet.absoluteFill, { experimental_backgroundImage: ambientGradient }]} />;
}

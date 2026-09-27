import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, type TextStyle } from "react-native";
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
  return <LinearGradient pointerEvents="none" accessible={false} colors={["#EAD7EF", "#F7F0FA", "#FFFFFF"]} locations={[0, 0.45, 1]} start={{ x: 0, y: 0 }} end={{ x: 0.45, y: 0.6 }} style={{ position: "absolute", top: 0, left: 0, right: 0, height: 370 }} />;
}

export function LineHighlight() {
  return <LinearGradient pointerEvents="none" accessible={false} colors={["#C3EEC4", "#E2F2B4", "#F4F1B1"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, { borderRadius: 12 }]} />;
}

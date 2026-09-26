const variant = process.env.APP_VARIANT === "demo" ? "demo" : "dev";
const googleServicesFile = process.env.GOOGLE_SERVICES_FILE;

export default {
  expo: {
    name: "Onoff",
    slug: "onoff-mobile",
    scheme: "onoff",
    version: "0.1.0",
    platforms: ["ios", "android"],
    orientation: "portrait",
    userInterfaceStyle: "light",
    plugins: [
      ["@twilio/voice-react-native-sdk", {
        apsEnvironment: variant === "demo" ? "production" : "development",
        microphoneUsageDescription: "Onoff utilise le microphone pendant vos appels.",
      }],
      ["expo-secure-store", { faceIDPermission: "Déverrouiller votre session Onoff." }],
    ],
    ios: {
      bundleIdentifier: variant === "demo" ? "com.onoffv2.mobile" : "com.onoffv2.mobile.dev",
      supportsTablet: true,
      infoPlist: { EXDevMenuShowFloatingActionButton: false },
    },
    android: {
      package: variant === "demo" ? "com.onoffv2.mobile" : "com.onoffv2.mobile.dev",
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
    extra: { appVariant: variant },
  },
};

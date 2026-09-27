export const settingsTabs = ["account", "lines", "devices", "tags", "api", "assistants"] as const;
export type SettingsTab = typeof settingsTabs[number];

export function settingsTabFromSearch(search: string): SettingsTab | null {
  const params = new URLSearchParams(search);
  if (params.has("mcpSms")) return "assistants";
  const tab = params.get("settings");
  return settingsTabs.find((item) => item === tab) ?? null;
}

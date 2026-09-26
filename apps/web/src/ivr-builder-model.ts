import type { VoiceDestination, VoiceFlow } from "@onoff/contracts";

export type IvrMenu = VoiceFlow["menus"][number];
export type DestinationAddress =
  | { kind: "entry" }
  | { kind: "closed" }
  | { kind: "fallback"; menuId: string }
  | { kind: "branch"; menuId: string; index: number };

export const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

export function nextDigit(menu: IvrMenu): string | undefined {
  return digits.find(digit => !menu.options.some(option => option.digit === digit));
}

export function readDestination(flow: VoiceFlow, address: DestinationAddress): VoiceDestination | undefined {
  if (address.kind === "entry") return flow.entry;
  if (address.kind === "closed") return flow.schedule.closed;
  const menu = flow.menus.find(item => item.id === address.menuId);
  return address.kind === "fallback" ? menu?.fallback : menu?.options[address.index]?.destination;
}

// Keep shared menus, back-links and the out-of-hours route; remove detached subtrees.
export function pruneMenus(flow: VoiceFlow): VoiceFlow {
  const reachable = new Set<string>();
  function visit(destination: VoiceDestination) {
    if (destination.type !== "menu" || reachable.has(destination.menuId)) return;
    reachable.add(destination.menuId);
    const menu = flow.menus.find(item => item.id === destination.menuId);
    if (!menu) return;
    visit(menu.fallback);
    menu.options.forEach(option => visit(option.destination));
  }
  visit(flow.entry);
  visit(flow.schedule.closed);
  return { ...flow, menus: flow.menus.filter(menu => reachable.has(menu.id)) };
}

export function replaceDestination(flow: VoiceFlow, address: DestinationAddress, destination: VoiceDestination): VoiceFlow {
  if (address.kind === "entry") return pruneMenus({ ...flow, entry: destination });
  if (address.kind === "closed") return pruneMenus({ ...flow, schedule: { ...flow.schedule, closed: destination } });
  return pruneMenus({ ...flow, menus: flow.menus.map(menu => menu.id !== address.menuId ? menu : address.kind === "fallback"
    ? { ...menu, fallback: destination }
    : { ...menu, options: menu.options.map((option, index) => index === address.index ? { ...option, destination } : option) }) });
}

export function addSubmenu(flow: VoiceFlow, address: DestinationAddress, id: string): VoiceFlow {
  const previous = readDestination(flow, address);
  if (!previous || flow.menus.length >= 12 || flow.menus.some(menu => menu.id === id)) return flow;
  const menu: IvrMenu = {
    id, name: "Nouveau menu", prompt: "Comment pouvons-nous vous aider ?", timeout: 5, maxAttempts: 2,
    options: [{ digit: "1", label: previous.type === "voicemail" ? "laisser un message" : "continuer", destination: previous }],
    fallback: { type: "voicemail" },
  };
  return replaceDestination({ ...flow, menus: [...flow.menus, menu] }, address, { type: "menu", menuId: id });
}

export function removeBranch(flow: VoiceFlow, menuId: string, index: number): VoiceFlow {
  return pruneMenus({ ...flow, menus: flow.menus.map(menu => menu.id === menuId
    ? { ...menu, options: menu.options.filter((_, position) => position !== index) } : menu) });
}

export function referencedQueueIds(flow: VoiceFlow): Set<string> {
  const visible = pruneMenus(flow);
  const destinations = [visible.entry, visible.schedule.closed, ...visible.menus.flatMap(menu => [menu.fallback, ...menu.options.map(option => option.destination)])];
  return new Set(destinations.flatMap(destination => destination.type === "queue" ? [destination.queueId] : []));
}

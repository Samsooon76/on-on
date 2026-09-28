/** Runs in Chrome's isolated world. Only candidate strings leave the page. */
export function readPagePhones(): string[] {
  const candidates = new Set<string>();
  const pattern = /(?<![\p{L}\d])(?:0[1-9](?:[\t \u00a0\u202f().-]*\d){8}|(?:\+|00)[1-9][\d\t \u00a0\u202f().-]{6,23}\d)(?![\p{L}\d])/gu;
  const collect = (text: string) => {
    for (const match of text.matchAll(pattern)) candidates.add(match[0]);
  };
  collect(window.getSelection()?.toString() ?? "");
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="tel:"]')) {
    try { candidates.add(decodeURIComponent(anchor.getAttribute("href")!.slice(4).split(/[;?]/)[0]!)); } catch { /* Malformed URI. */ }
  }
  // innerText excludes scripts, styles and hidden content, and separates block elements.
  collect(document.body?.innerText ?? "");
  return [...candidates].slice(0, 500);
}

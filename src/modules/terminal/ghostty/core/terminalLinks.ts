export type TerminalTextLink = { start: number; end: number; uri: string };

export function detectTerminalLinks(text: string): TerminalTextLink[] {
  const links: TerminalTextLink[] = [];
  const pattern = /(?:https?:\/\/|mailto:)[^\s<>"'`\u0000-\u001f\u007f]+/giu;
  for (
    let match = pattern.exec(text);
    match && links.length < 256;
    match = pattern.exec(text)
  ) {
    let uri = match[0].replace(/[.,;:!?]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]) {
      while (
        uri.endsWith(close) &&
        uri.split(close).length > uri.split(open).length
      )
        uri = uri.slice(0, -1);
    }
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "mailto:" && !parsed.hostname) continue;
      links.push({ start: match.index, end: match.index + uri.length, uri });
    } catch {
      /* Incomplete URLs stay ordinary terminal text. */
    }
  }
  return links;
}

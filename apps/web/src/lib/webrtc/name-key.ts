// Comparison key for display names. Mirrors `nameKey` in the signaling server
// (packages/signaling-server/src/core/protocol.ts) — keep the two in step — so the client can
// refuse a name that reads the same as someone else's even when it didn't come from the server.

// A small fold for look-alike letters from other scripts (not the full Unicode confusables table).
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w', һ: 'h', ɡ: 'g',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  '0': 'o', '1': 'l', '|': 'l', '!': 'l', $: 's', '@': 'a',
};

/**
 * Compatibility-normalized, accents and case folded, look-alike letters mapped to Latin and
 * whitespace collapsed: "Ałex", "ALEX" and "Аlex" (Cyrillic А) all compare equal to "alex".
 */
export function nameKey(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/ß/g, 'ss');
  let out = '';
  for (const ch of folded) out += CONFUSABLES[ch] ?? ch;
  // Capital I and small l look the same in many fonts.
  return out.replace(/i/g, 'l').replace(/\s+/g, ' ').trim();
}

// Comparison key for display names. Follows `nameKey` in the signaling server
// (packages/signaling-server/src/core/protocol.ts), so the client can refuse a name that reads the
// same as someone else's even when it didn't come from the server. Unlike the server — which
// strips invisible characters from names before it ever compares them — the client also has to
// cope with names that never passed through the server, so that stripping happens here too.

// Characters that render as nothing (or as a blank): format controls such as zero-width and bidi
// marks and the "tag" block, plus the blank Hangul fillers and the empty Braille cell.
const INVISIBLE = /[\p{Cf}\u115f\u1160\u180e\u2800\u3164\uffa0]/gu;

/** Remove characters that can't be seen, so two names that look alike are alike. */
export function stripInvisible(name: string): string {
  return name.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

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
  const folded = stripInvisible(name)
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

/**
 * The lower-cased Latin letters the CLI's Slugify folds to ASCII, the same
 * table as latinFold in internal/felt/felt.go.
 */
const latinFold: Record<string, string> = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ā: 'a', ă: 'a', ą: 'a', æ: 'ae',
  ç: 'c', ć: 'c', č: 'c', ď: 'd', đ: 'd', ð: 'd',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ē: 'e', ė: 'e', ę: 'e', ě: 'e',
  ğ: 'g', ì: 'i', í: 'i', î: 'i', ï: 'i', ī: 'i', ı: 'i', ł: 'l',
  ñ: 'n', ń: 'n', ň: 'n',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', ō: 'o', ő: 'o', œ: 'oe',
  ř: 'r', ś: 's', š: 's', ş: 's', ß: 'ss', ť: 't', þ: 'th',
  ù: 'u', ú: 'u', û: 'u', ü: 'u', ū: 'u', ů: 'u', ű: 'u',
  ý: 'y', ÿ: 'y', ź: 'z', ż: 'z', ž: 'z',
}

/**
 * The slug a title gives a new fiber, by felt's convention: lowercase letters
 * and digits joined by single hyphens, with no hyphen at either end. It
 * derives as the CLI's Slugify does ([bracketed] tags are dropped, İ
 * lowercases to i, Latin letters fold to ASCII: é to e, ß to ss), then cuts
 * at 60 characters, which Slugify does not. Empty when the title has no letters or digits; each caller names that
 * case for itself.
 */
export function slugStem(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, '')
    .replace(/İ/g, 'i')
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (c) => latinFold[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
}

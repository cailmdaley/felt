/**
 * The slug a title gives a new fiber, by felt's convention: lowercase letters
 * and digits joined by single hyphens, at most 60 characters, with no hyphen
 * at either end. Empty when the title has no letters or digits; each caller
 * names that case for itself.
 */
export function slugStem(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
}

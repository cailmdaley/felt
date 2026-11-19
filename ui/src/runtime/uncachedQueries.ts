/**
 * WebKit keeps the result of a `querySelector` or `querySelectorAll` whose
 * selector is one tag name, `*` or one class name in a cache on the document,
 * keyed by the node that was asked. A kept result holds its matches and,
 * through them, their document for the life of the process: after a reload,
 * and after a frame is taken out of its page. A selector list is never kept,
 * and for a selector with no bracket, quote or combinator `x,x` matches
 * exactly what `x` does, so every query that could be kept is asked as a list
 * of itself twice.
 *
 * `installUncachedQueries` does it for the page that imports it. The function
 * is self-contained: the document bridge injects its source into framed pages.
 */
export function keepQueriesUncached(): void {
  // CSS escapes and comments can hide any character, so they are read as a letter before the test;
  // a backslash or comment left open at the end changes what the doubled selector means, so it is read as a bracket.
  const hidden = /\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[\s\S]|$)|\/\*[\s\S]*?(?:\*\/|$)/g
  const read = (part: string): string => part === '\\' || (part.startsWith('/*') && (part.length < 4 || !part.endsWith('*/'))) ? '(' : 'x'
  const list = (args: unknown[]): unknown[] => {
    if (!args.length) return args
    const selector = `${args[0]}`, plain = selector.replace(hidden, read).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '')
    // What is left is one compound selector with no attribute, pseudo-class or id part.
    return plain && !/[ \t\n\r\f,>+~[(:#"']/.test(plain) ? [`${selector},${selector}`] : [selector]
  }
  for (const proto of [Document.prototype, DocumentFragment.prototype, Element.prototype]) {
    for (const name of ['querySelector', 'querySelectorAll'] as const) {
      const native = proto[name] as (this: unknown, ...args: unknown[]) => unknown
      const asked = function (this: unknown, ...args: unknown[]): unknown { return native.apply(this, list(args)) }
      // Its name, length and String() read as the browser's own; Function.prototype.toString.call shows the wrapper.
      Object.defineProperties(asked, { name: { value: name }, length: { value: native.length }, toString: { value: () => Function.prototype.toString.call(native) } })
      Object.defineProperty(proto, name, { ...Object.getOwnPropertyDescriptor(proto, name), value: asked })
    }
  }
}

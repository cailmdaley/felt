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
  // CSS escapes and comments can hide any character, so they are read as a letter before the test.
  const hidden = /\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|[\s\S]|$)|\/\*[\s\S]*?(?:\*\/|$)/g
  const list = (args: unknown[]): unknown[] => {
    if (!args.length) return args
    const selector = `${args[0]}`, plain = selector.replace(hidden, 'x').replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '')
    // What is left is one compound selector with no attribute, pseudo-class or id part.
    return plain && !/[ \t\n\r\f,>+~[(:#"']/.test(plain) ? [`${selector},${selector}`] : args
  }
  for (const proto of [Document.prototype, DocumentFragment.prototype, Element.prototype]) {
    for (const name of ['querySelector', 'querySelectorAll'] as const) {
      // A proxy keeps the native name and length, and passes a page's check for native code.
      const asked = new Proxy(proto[name], { apply: (native, node, args: unknown[]) => Reflect.apply(native, node, list(args)) })
      Object.defineProperty(proto, name, { ...Object.getOwnPropertyDescriptor(proto, name), value: asked })
    }
  }
}

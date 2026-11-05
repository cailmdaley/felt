// The harness bakes these bundles at build time into a gitignored directory.
declare module '*.change.json' {
  const bundle: import('../src/board/workspace/changeModel.js').ChangeBundle
  export default bundle
}

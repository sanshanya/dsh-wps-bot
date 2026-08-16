/**
 * Build the plugin's client bundle in the module-loader shape the DSH Web
 * shell serves: a CJS fragment wrapped in `window.__ModuleLoader__.load`.
 * id MUST equal the package name（client-modules 以包名为入口 id）。
 * Only the runtime platform modules stay external — every dependency else is
 * inlined. 与 better-model-provider scripts/build-client.mjs 同形。
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const ID = 'dsh-wps-bot'
const BANNER = `window.__ModuleLoader__.load({
\tid: "${ID}",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`
const FOOTER = `
\t\treturn module.exports;
\t}
});
`

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'react',
  target: 'es2020',
  sourcemap: true,
  minify: true,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  outfile: 'lib/browser.js',
  banner: { js: BANNER },
  footer: { js: FOOTER },
})

const content = await readFile('lib/browser.js', 'utf8')
if (!content.startsWith('window.__ModuleLoader__.load({')) {
  throw new Error('client bundle wrapper missing __ModuleLoader__.load preamble')
}
console.log(`built lib/browser.js (${content.length} bytes)`)

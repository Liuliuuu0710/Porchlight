// 把云端 Homi 服务（server/main.ts 和用到的 src/ 代码）打包成一个文件：build/server.mjs
// 用法：node scripts/build-server.mjs [--watch]
import { context, build } from 'esbuild'

const options = {
  entryPoints: ['server/main.ts'],
  outfile: 'build/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // 打包进来的 CommonJS 代码（jpeg-js）要用 require
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
}

if (process.argv.includes('--watch')) {
  const ctx = await context({ ...options, plugins: [{ name: 'notify', setup: (b) => b.onEnd((r) => {
    process.send?.({ built: r.errors.length === 0 })
  }) }] })
  await ctx.watch()
} else {
  await build(options)
}

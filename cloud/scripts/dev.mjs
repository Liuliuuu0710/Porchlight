// npm run dev：同时启动本机的云端 Homi 服务（localhost:8787，改了代码自动重新打包、重启）和网页（localhost:5181）。
// 本机服务不要访问密码；AI Key 从 .env 读（只在本机 Node 进程里用）；eufy 参数从 eufy.local.json 读；数据放 data-dev/，和线上分开。
import { fork, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const env = { ...process.env, PORT: '8787', HOST: '127.0.0.1', DATA_DIR: 'data-dev', EUFY_CONFIG_FILE: 'eufy.local.json' }
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line)
    if (m && m[1] === 'AI_API_KEY') env.AI_API_KEY = m[2]
  }
} catch {
  console.error('没有 .env（需要 AI_API_KEY）')
}
delete env.SHARE_PASSWORD

let server = null
const restart = () => {
  if (server) server.kill()
  server = spawn(process.execPath, ['--enable-source-maps', 'build/server.mjs'], { env, stdio: 'inherit' })
}

const builder = fork('scripts/build-server.mjs', ['--watch'])
builder.on('message', (m) => {
  if (m?.built) restart()
})

const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' })

const stop = () => {
  server?.kill()
  builder.kill()
  vite.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

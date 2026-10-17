/**
 * 检查 dev/.env 里的 AI_API_KEY 能否调用主办方网关。
 * 用法：npm run check-key
 * 不会打印完整 Key，只显示开头、结尾和长度。
 */
import { readFileSync } from 'node:fs'

const ENDPOINT = 'https://ai-router-cn-pub.anker-in.com/chat/completions'
const MODEL = 'hackathon/v_model/glm-5.2'

let raw
try {
  raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
} catch {
  console.log('✗ 找不到 dev/.env 文件。请在 dev 目录下新建 .env，写一行：AI_API_KEY=sk-...')
  process.exit(1)
}

const line = raw.split(/\r?\n/).find((l) => l.trim().startsWith('AI_API_KEY'))
if (!line) {
  console.log('✗ .env 里没有 AI_API_KEY 这一行。格式应为：AI_API_KEY=sk-...')
  process.exit(1)
}
const value = line.slice(line.indexOf('=') + 1)
const key = value.trim().replace(/^["']|["']$/g, '')

console.log(`Key：${key.slice(0, 5)}…${key.slice(-4)}（长度 ${key.length}）`)
if (value !== key) console.log('  注意：Key 前后有空格或引号，已自动去掉。')
if (!key.startsWith('sk-')) console.log('  注意：Key 不是以 sk- 开头。')
if (/\s/.test(key)) console.log('  注意：Key 中间有空白字符，可能是复制时断行了。')

console.log(`请求 ${MODEL} …`)
const t0 = Date.now()
try {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: '回复“通了”两个字' }] }),
  })
  const body = await res.text()
  const ms = Date.now() - t0
  if (res.ok) {
    const text = JSON.parse(body).choices?.[0]?.message?.content
    console.log(`✓ Key 可用（HTTP ${res.status}，${ms}ms）。模型回复：${text}`)
    console.log('  如果网页里还是 401，请重启 npm run dev（.env 只在启动时读取）。')
  } else {
    console.log(`✗ HTTP ${res.status}（${ms}ms）：${body.slice(0, 300)}`)
    if (res.status === 401) console.log('  Key 被网关拒绝：请对照主办方原始消息核对是否复制完整、是否已激活。')
  }
} catch (e) {
  console.log(`✗ 网络错误：${e.message}。检查是否能访问外网、是否开了代理/VPN。`)
}

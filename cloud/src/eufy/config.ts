/**
 * eufy 摄像头的鉴权参数（赛事方分配）。只存在这台电脑的浏览器里，不传给云端、不进代码。
 * 两种登录方式：填 token（跳过 token 生成，直接用）；或不填 token、填 account_uuid（重新生成 token）。
 */
export interface EufyConfig {
  appName: string
  clientId: string
  clientSecret: string
  presetKey: string
  /** 设备 SN（本赛题：T8171 云台摄像头 / T8214 门铃） */
  stationSn: string
  eufyUserId: string
  accountUuid: string
  token: string
}

export const EMPTY_EUFY_CONFIG: EufyConfig = {
  appName: '',
  clientId: '',
  clientSecret: '',
  presetKey: '',
  stationSn: '',
  eufyUserId: '',
  accountUuid: '',
  token: '',
}

const KEY = 'porchlight-eufy-config'

export function loadEufyConfig(): EufyConfig {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...EMPTY_EUFY_CONFIG, ...JSON.parse(raw) } : EMPTY_EUFY_CONFIG
  } catch {
    return EMPTY_EUFY_CONFIG
  }
}

export function saveEufyConfig(c: EufyConfig) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c))
  } catch {
    // 存不下就只在这次打开时用
  }
}

/** 连接前检查：缺哪项直接说，不等 eufy 返回看不懂的 403 */
export function missingFields(c: EufyConfig): string[] {
  const need: [keyof EufyConfig, string][] = [
    ['appName', 'App Name'],
    ['clientId', 'Client ID'],
    ['presetKey', 'Preset Key'],
    ['stationSn', '设备 SN'],
    ['eufyUserId', 'eufy_user_id'],
  ]
  const miss = need.filter(([k]) => !c[k].trim()).map(([, label]) => label)
  if (!c.token.trim() && !c.accountUuid.trim()) miss.push('Token 或 account_uuid')
  if (!c.token.trim() && !c.clientSecret.trim()) miss.push('Client Secret（用 account_uuid 登录时要）')
  return miss
}

/** 云端配好的参数（cloud/eufy.local.json 或线上 SSM）；没配或连不上返回 null，改为在网页里填 */
export async function fetchCloudEufyConfig(headers: Record<string, string>): Promise<EufyConfig | null> {
  try {
    const r = await fetch('/api/eufy-config', { headers, cache: 'no-store' })
    if (!r.ok) return null
    return { ...EMPTY_EUFY_CONFIG, ...(await r.json()) }
  } catch {
    return null
  }
}

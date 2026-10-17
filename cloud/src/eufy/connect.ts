/**
 * eufy 云云对接鉴权 → OpenAPIIntegration（照赛事方示例 services/connect.ts、services/index.ts）。
 * ecdh / encryption / header / request 四个文件原样取自示例。所有 eufy 接口经云端 Homi 服务转发（/openapi-api）。
 */
import axios from 'axios'
import { EcdhKey, generateEcdhKeyPair } from './ecdh'
import { AesCBCDecryptV2, AesCBCEncryptV2 } from './encryption'
import { HeaderBuilder } from './header'
import { Request } from './request'
import { OPENAPI_PROXY, viaProxy, type WebSDK } from './sdk'
import type { EufyConfig } from './config'

/** 403 且返回为空 = eufy 网关不认这套参数（10/16 踩过：App Name 差一个字符） */
const explain = (e: unknown, step: string) => {
  const status = (e as { response?: { status?: number } })?.response?.status
  const msg = (e as Error)?.message ?? String(e)
  if (status === 403 || /403|未授权/.test(msg)) {
    return new Error(`${step}被 eufy 拒绝（403）：请逐字核对 App Name、Client ID、Preset Key（大小写，l / I / 1，O / 0）`)
  }
  return new Error(`${step}失败：${msg}`)
}

async function getDomain(): Promise<string> {
  const res = await axios.get(`${OPENAPI_PROXY}/v1/cloud/account/domain/US`)
  const domain = res.data?.data?.domain
  if (!domain) throw new Error('没拿到 eufy 接口域名')
  return domain
}

async function exchangeKey(domain: string, presetKey: string): Promise<EcdhKey> {
  const [privateKey, publicKey] = await generateEcdhKeyPair()
  const encPublicKey = await AesCBCEncryptV2(publicKey, presetKey)
  const { randomField, headers } = Request.headerBuilder.buildExchangeKeyHeaders(presetKey, encPublicKey)
  const res = await axios
    .post(`${viaProxy(domain)}/v1/app/account/key_exchange`, { client_public_key: encPublicKey }, { headers: headers as never })
    .then((r) => r.data)
  const serverPublicKey = await AesCBCDecryptV2(res.data.server_public_key, presetKey)
  return new EcdhKey(randomField.keyindent, privateKey, serverPublicKey)
}

async function requestToken(data: { eufy_user_id: string; account_uuid: string }): Promise<string> {
  const res = await Request.request({
    url: '/v1/cloud/account/request_token',
    method: 'post',
    data,
    headers: { 'Content-Type': 'text/plain' },
  })
  return res.data.access_token
}

/** 返回给 Provider 用的 integration；SDK 内部还会用 App Name / Client ID / Preset Key 再做一次密钥交换 */
export async function connectEufy(sdk: WebSDK, raw: EufyConfig): Promise<unknown> {
  const c = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v).trim()])) as unknown as EufyConfig
  let domain: string
  try {
    domain = await getDomain()
  } catch (e) {
    throw explain(e, '获取 eufy 域名')
  }
  Request.headerBuilder = new HeaderBuilder({ appName: c.appName, clientId: c.clientId, CLIENT_SECRET: c.clientSecret })
  let token = c.token
  if (!token) {
    try {
      Request.ecdhKey = await exchangeKey(domain, c.presetKey)
      Request.baseURL = viaProxy(domain)
      token = await requestToken({ eufy_user_id: c.eufyUserId, account_uuid: c.accountUuid })
    } catch (e) {
      throw explain(e, '获取 eufy Token ')
    }
  }
  Request.AccessToken = token
  return new sdk.OpenAPIIntegration({
    apiDomain: domain,
    userId: c.eufyUserId,
    presetKey: c.presetKey,
    authorization: token,
    appName: c.appName,
    clientId: c.clientId,
  })
}

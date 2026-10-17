/**
 * @name ECDH 密钥交换工具
 * @description 基于 P-256 曲线实现 ECDH 密钥交换，用于与 eufy OpenAPI 建立加密通道。
 *   实现与 web-iot-sdk-2.0 的 integration-openapi/auth 保持一致。
 */

import elliptic from 'elliptic';

const ec = new elliptic.ec('p256');

/**
 * 生成 ECDH 密钥对
 * @return {Promise<[string, string]>} [私钥(hex), 公钥(hex)]
 */
export const generateEcdhKeyPair = async (): Promise<[string, string]> => {
  const keyPair = ec.genKeyPair();
  const privateKey = keyPair.getPrivate('hex');
  const publicKey = keyPair.getPublic('hex');
  return [privateKey, publicKey];
};

/**
 * 从共享密钥派生 32 位对称密钥（AES-128 需要 16 字节 = 32 位 hex）
 *
 * 注意：sharedSecret 来自 BN.toString(16)，会剥掉前导零，长度可能是 64/63/62/…。
 * 必须左侧补零到完整 64 hex 字符（32 字节），再取前 32 字符（16 字节）作为密钥。
 * 旧实现 `('0' + s).substr(-64)` 只补 1 个零，在共享密钥有 2+ 个前导零字节时
 * （约 1/256 概率）会派生出错误密钥，导致握手静默失败（signature mismatch）。
 * @param {string} sharedSecret - ECDH 共享密钥（hex）
 * @return {string} 32 位对称密钥（hex）
 */
function deriveSymmetricKey(sharedSecret: string): string {
  return sharedSecret.padStart(64, '0').substr(0, 32);
}

/**
 * 执行 ECDH 密钥交换，计算共享密钥
 * @param {string} privateKeyHex - 本端私钥（hex）
 * @param {string} peerPublicKeyHex - 对端公钥（hex）
 * @return {string} 派生后的对称密钥（hex）
 */
export const performEcdhKeyExchange = (
  privateKeyHex: string,
  peerPublicKeyHex: string,
): string => {
  const privateKey = ec.keyFromPrivate(privateKeyHex, 'hex');
  const peerPublicKey = ec.keyFromPublic(peerPublicKeyHex, 'hex');
  const sharedSecret = privateKey.derive(peerPublicKey.getPublic());
  return deriveSymmetricKey(sharedSecret.toString(16));
};

/**
 * ECDH 密钥交换结果封装
 * 交换完成后用于后续请求的签名与加解密
 */
export class EcdhKey {
  keyIndent: string;
  clientPrivateKeyHex: string;
  serverPublicKeyHex: string;
  shareKey: string;

  constructor(
    keyIndent: string,
    clientPrivateKeyHex: string,
    serverPublicKeyHex: string,
  ) {
    this.keyIndent = keyIndent;
    this.clientPrivateKeyHex = clientPrivateKeyHex;
    this.serverPublicKeyHex = serverPublicKeyHex;
    this.shareKey = performEcdhKeyExchange(
      clientPrivateKeyHex,
      serverPublicKeyHex,
    );
  }
}

/**
 * 冒烟 1：真 WPS 租户自签自证（不发送任何消息）。
 *  Step 1: OAuth 取 access_token；
 *  Step 2: 加 KSO-1 签名调 /v7/service_principals/current；
 *  Step 3: 打印服务主体 id + company_id —— 后者同时给出两个关键焊点的真值：
 *    - WPS365_SP_ID 的真实数值（之前 env 里没配，本脚本自证后补进 env.local）
 *    - bot 消息 sender.type 的真实形状（'app'/'service_principal'?）
 */
import { WpsClient } from '../../src/client.ts';

const { WPS365_API_BASE = 'https://openapi.wps.cn', WPS365_CLIENT_ID = '', WPS365_CLIENT_SECRET = '' } = process.env;
if (!WPS365_CLIENT_ID || !WPS365_CLIENT_SECRET) {
  console.error('[失败] 缺 WPS365_CLIENT_ID / WPS365_CLIENT_SECRET；用 --env-file /tmp/wps-bot-e2e/env.local 跑本脚本。');
  process.exit(1);
}

const client = new WpsClient({ clientId: WPS365_CLIENT_ID, clientSecret: WPS365_CLIENT_SECRET, apiBase: WPS365_API_BASE });
console.log('step1/2: oauth + 当前 service principal …');
const sp = await client.currentServicePrincipal();
console.log(JSON.stringify(sp, null, 2));
console.log('\n提示：把下面这一行写进 /tmp/wps-bot-e2e/env.local，并补进 cordis.patch.yml 的 wps-bot config：');
console.log(`WPS365_SP_ID=${sp.id ?? sp.app_id ?? '?'}`);
process.exit(0);

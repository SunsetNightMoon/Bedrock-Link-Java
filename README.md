# Bedrock-Link-Java

MCSkinToServer（MCSTS）的官方插件：**基岩版身份绑定（站点侧）v2「签证」模型**。

把 Xbox 基岩身份（XUID）签证到站点角色。玩家经 Geyser/Floodgate 进 Java 服务器时带的是 XUID
（Floodgate 对 Xbox 会话**实测**，在线服上不可伪造——微软背书）；签证之后，服务器侧伴生插件
按 XUID 放行该玩家，并以站点角色的身份/皮肤接管其进服体验。

**本仓库只是站点侧（MCSTS 插件）。** 服务器侧伴生插件（Bedrock-Link-Server，jar）按下面的
回调契约另行实现；本站不做协议翻译，也不探测你的服务器装了什么。

## 签证：两条证据，各管一半

| 证据 | 证明什么 | 来源 |
|---|---|---|
| 网页提交 XUID 申请 | **意愿** —— 这个站号的主人想绑这个基岩身份 | 玩家已登录站点，在账号设置区「账号绑定」填写 |
| 服务器实测该 XUID 进服 | **持有** —— 该 Xbox 账号此刻真的登在里面 | Floodgate 对 Xbox 会话实测，伴生插件签名回报 |

**玩家动线（零命令）**：进服被拦 → 屏幕显示你的 XUID → 到站点粘贴提交（状态「待确认」）→
重新进服 → 伴生插件观测到你、调 `/hooks/confirm` → 站点当场签发（记录昵称）→ 放行。

签发后绑定行显示「XUID · 角色 · 签发时昵称」——昵称对不上说明被人抢注了申请，本人可自助解绑重申。
要绝对严格的站点可把 `BIND_MODE` 切成 `code`（一次性码模式：网页生码 → 游戏内 `/bedrock link <码>`，
意愿与持有在同一条命令里同时成立，无抢注窗口）。

## 服务器侧伴生插件的回调契约

入口挂在 `https://<站点>/api/plugins/bedrock_link/hooks/…`，HMAC 签名三头：

```
签名串 = ts + "\n" + nonce + "\n" + METHOD + "\n" + 完整路径 + "\n" + sha256hex(body)
签名   = HMAC-SHA256(服务器密钥, 签名串) 十六进制小写
X-MCSTS-Timestamp / X-MCSTS-Nonce / X-MCSTS-Signature
```

| 端点 | 请求 | 响应 |
|---|---|---|
| `POST /hooks/lookup` | `{xuid}` | `{bound:true, status:'active', profileId, profileName, gamertag}` / `{bound:true,status:'pending',…}` / `{bound:false,pending:false}` |
| `POST /hooks/confirm` | `{xuid, gamertag?}` | 同上 + `justIssued`；pending→active 的签发点，幂等 |
| `POST /hooks/bind` | `{token, xuid, gamertag?}` | 码制签发；`400` 码无效/冲突 |
| `POST /hooks/verify` | `{name, value, signature}`（Java 玩家的 textures property 原样回传） | `{ok:true, profileId}` 或 `{ok:false, reason}` —— 站点用 RSA 私钥对应的公钥验签并核对身份 |

进服门控建议：Floodgate 玩家 `lookup/confirm` 不为 active 就踢回（消息带其实测 XUID 与站点地址）；
Java 玩家 `verify` 不过就踢回（离线模式下这就是「仅限外置登录玩家」的实现方式）。

## 安装（站点侧）

1. 后端启用插件系统：`MCSTS_PLUGINS=1`（重启后端）。
2. 面板 → 插件管理 → 从 GitHub 导入：`SunsetNightMoon/Bedrock-Link-Java`，选 tag。
3. 启用 → 设置：`JOIN_ADDRESS`（基岩地址，展示给玩家）、`BIND_MODE`（默认 claim）。
4. 「服务器密钥」生成，把明文配进伴生插件；密钥轮换旧服侧立即失效。

## 边界（请如实理解）

- **本仓库 = 站点侧。** 游戏内命令与进服门控由伴生插件提供；没装它之前，申请会停在「待确认」。
- **皮肤**：Java 侧玩家看站点皮肤走标准 textures property；**基岩客户端自己穿站点皮肤**需伴生插件
  经 Geyser 皮肤接口推送（覆盖客户端自带皮肤）。**披风在基岩客户端不显示**（客户端限制，Java 侧可见）。
- 申请制的抢注窗口见上表；介意就 `BIND_MODE=code`。
- 插件运行在 MCSTS 的 Node 进程内，**没有沙盒**；安装与启用是超管的决定，行为由安装者负责。
- 一次性码/申请的消费与签发都在数据库原子操作里完成；失败文案不区分原因，端点不可当探测器。

## 开发

`plugin-api.d.ts` 复制自 MCSTS 仓库根；改代码后「重载」只重跑 setup，换不掉模块——重启站点生效。

## 许可

MIT（见 `LICENSE.txt`）。署名条款随 MCSkinToServer 主项目：对外提供服务时保留页脚「Powered by MCSkinToServer」。

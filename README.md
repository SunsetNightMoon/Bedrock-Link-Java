# Bedrock-Link-Java

MCSkinToServer（MCSTS）的官方插件：**基岩版身份绑定（站点侧）v2「签证」模型**。

把 Xbox 基岩身份（XUID）签证到站点角色。玩家经 Geyser/Floodgate 进 Java 服务器时带的是 XUID
（Floodgate 对 Xbox 会话**实测**，在线服上不可伪造——微软背书）；签证之后，服务器侧伴生插件
按 XUID 放行该玩家，并以站点角色的身份/皮肤接管其进服体验。

**仓库结构**：`site/` = 站点侧（MCSTS 插件 `bedrock_link`，导入时子目录填 `site`）；
`server/` = 服务器侧伴生插件 **BedrockLink**（Paper jar，git subtree 自独立开发仓并入），
jar 的构建配方、配置与边界说明见 [`server/README.md`](server/README.md)，二进制资产挂在
GitHub Release 上；仓库根只留说明与识别代号标记 `.mcsts-plugin/`。这样 MCSTS 的 GitHub
导入（只收纯文本、逐字节核对）不会扫到 `server/` 里的 jar/java 而拒装。本站不做协议翻译，
也不探测你的服务器装了什么。

## Tag 与可用版本

两条产品线、两套前缀，版本号互不对应：**站点插件 tag = `v*`，伴生 jar tag = `server-v*`**。

| 实际可用 | 要求 / 搭档 |
|---|---|
| 站点插件 `v2.2.2`（当前；`v2.2.1`→`v2.2.2` 仅修元数据与文档，代码相同） | MCSTS ≥ P6 第七批（`binding.issue:false` 与 `profile.reserved`，目前仅在 Dev）；搭档 jar `server-v0.1.28`。自 v2.2.1 起插件住在 `site/` 子目录 |
| 站点插件 `v2.2.0` | 同 v2.2.1，但为**仓库根目录布局**——MCSTS 第八批自动识别导入会扫到 `server/` 的 jar 而拒装，只能手工放目录装 |
| 站点插件 `v2.0.0` ~ `v2.1.1` | MCSTS ≥ P6 第五批（v2-26.4.1 / master 即可）；自带一次性码链路（`BIND_MODE`），搭档 jar `server-v0.1.27`；同为根目录布局，自动导入同样装不了 |
| 伴生 jar `server-v0.1.28`（当前） | 配站点插件 ≥ v2.2.0：码制退役，`/bedrock link` 子命令移除 |
| 伴生 jar `server-v0.1.27` | 配站点插件 v2.0.0 ~ v2.1.1（Release 挂 jar 资产） |

搁置不作废：站点插件 `v1.0.0`/`v1.0.1`（一次性码模型，伴生端 `/bedrock link` 已退役，
整链路不再可用）；jar `0.1.0`~`0.1.26` 从未打 tag，二进制都在 `server/dist/` 里可追溯。
MCSTS 导入器只认**语义化 tag**（`v*`）并自动挑最新，`server-v*` 会被当噪声过滤——
两条线共用一个仓库也不会互相认错。

## 签证：两条证据，各管一半

| 证据 | 证明什么 | 来源 |
|---|---|---|
| 网页提交 XUID 申请 | **意愿** —— 这个站号的主人想绑这个基岩身份 | 玩家已登录站点，在账号设置区「账号绑定」填写 |
| 服务器实测该 XUID 进服 | **持有** —— 该 Xbox 账号此刻真的登在里面 | Floodgate 对 Xbox 会话实测，伴生插件签名回报 |

**玩家动线（零命令）**：进服被拦 → 屏幕显示你的 XUID → 到站点粘贴提交（状态「待确认」）→
重新进服 → 伴生插件观测到你、调 `/hooks/confirm` → 站点当场签发（记录昵称）→ 放行。

签发后绑定行显示「XUID · 角色 · 签发时昵称」——昵称对不上说明被人抢注了申请，本人可自助解绑重申。
v2.2.0 起一次性码模式（旧 `BIND_MODE=code`）已移除：XUID 申请制覆盖同一件事，且「持有」一环
由微软背书的实测 XUID 承担，比码更强；页面也因此收起了「生成绑定码」按钮。
角色被换下（多→单切换、单模式换 ID）或账号注销时，插件收到核心事件后**丢弃该角色的绑定**，
XUID 随即释放，可绑到新的可用角色上。

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
| `POST /hooks/verify` | `{name, value, signature}`（Java 玩家的 textures property 原样回传） | `{ok:true, profileId}` 或 `{ok:false, reason}` —— 站点用 RSA 私钥对应的公钥验签并核对身份 |
| `POST /hooks/skin` | `{xuid}` 或 `{profileId}` | `{bound:true, profileId, profileName, textures:{name,value,signature}}` —— 签名 textures property（皮肤/披风 URL），伴生插件据此经 Geyser 通道覆盖基岩客户端自带皮肤；无绑定回 `{bound:false}` |

进服门控建议：Floodgate 玩家 `lookup/confirm` 不为 active 就踢回（消息带其实测 XUID 与站点地址）；
Java 玩家 `verify` 不过就踢回（离线模式下这就是「仅限外置登录玩家」的实现方式）。

## 安装（站点侧）

1. 后端启用插件系统：`MCSTS_PLUGINS=1`（重启后端）。
2. 面板 → 插件管理 → 从 GitHub 导入：粘仓库地址（任何形态都行），版本由导入器扫 tag 自动挑
   最新语义化版本；**子目录**在 MCSTS ≥ v2-26.4.2 之后的 Dev 上会随唯一 manifest 自动识别、
   可留空，v2-26.4.2 正式版仍需手填 `site`。直连 GitHub 不畅的部署由运维
   配 `MCSTS_PLUGIN_MIRROR`（https 前缀，同时转发 API 与 raw 两个域名）。
3. 启用 → 设置：`JOIN_ADDRESS`（基岩地址，展示给玩家）。
4. 「服务器密钥」生成，把明文配进伴生插件；密钥轮换旧服侧立即失效。

## 边界（请如实理解）

- **本仓库 = 站点侧。** 游戏内命令与进服门控由伴生插件提供；没装它之前，申请会停在「待确认」。
  伴生插件源码在本仓 `server/`（git subtree 维护），jar 二进制挂 GitHub Release。
- **皮肤与披风**：Java 侧玩家看站点皮肤走标准 textures property；**基岩客户端穿站点皮肤与披风**
  由伴生插件经 Geyser 皮肤接口推送（覆盖客户端自带皮肤；披风走 SerializedSkin 的 capeData 槽位，实测可见）。
  基岩端硬限制只剩两处：物品栏纸娃娃与第一人称手臂永远渲染客户端本地皮肤，任何服务器方案都改不了。
- 申请制的抢注窗口见上表；介意的人可引导玩家绑定后在绑定页核对「签发时昵称」。
- 插件运行在 MCSTS 的 Node 进程内，**没有沙盒**；安装与启用是超管的决定，行为由安装者负责。
- 申请的记录与签发都在数据库原子操作里完成；失败文案不区分原因，端点不可当探测器。

## 开发

`site/plugin-api.d.ts` 复制自 MCSTS 仓库根；改代码后「重载」只重跑 setup，换不掉模块——重启站点生效。

## 许可

MIT（见 `LICENSE.txt`）。署名条款随 MCSkinToServer 主项目：对外提供服务时保留页脚「Powered by MCSkinToServer」。

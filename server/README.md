# BedrockLink

MCSkinToServer 官方插件 **bedrock_link（基岩版身份绑定）的服务器侧伴生插件**（Paper 插件）。
配套站点侧仓库：`SunsetNightMoon/Bedrock-Link-Java`（签证模型契约与 hooks 定义以那边为准）。

## 它做什么

1. **基岩门控（签证）**：在 Java 登录阶段（`AsyncPlayerPreLoginEvent`）拿该连接**实测的 XUID**，
   签名回调站点 `/hooks/confirm`。没有生效签证 → 踢回，断线画面直接显示你的 XUID 与申请指引。
   （v0.1.0 曾挂在 Geyser `SessionLoginEvent`，实测基岩客户端在握手阶段不显示服务器给的
   断线原因、只有"未找到服务器"通用页 —— 已改到登录阶段，文案可见且无法绕过。）
2. **身份套用**：签证生效时把「XUID → 站点角色」写进 **Floodgate 链接记录**
   （`player-link.enabled: true` 是前提）。签发当次会提示重进；此后每次进服，
   该基岩玩家就是站点角色的名字/UUID —— 权限、背包、统计与 Java 侧完全同人。
   网页解绑后，下次进服会撤销本地链接记录并重新拦下，解绑不会"残存"。
3. **Java 门控（验签）**：离线模式下把 Java 玩家的 textures property 发回站点 `/hooks/verify`，
   站点用自己的 RSA 公钥验签 —— 只有皮肤站签发的"签证"能进，正版直连与乱改名字的都进不来。
4. **命令**：`/bedrock xuid`（查自己 XUID 与签证状态）、`/bedrock link <码>`（码制严格模式）、`/bedrock reload`。

## 安装

1. 站点侧先装好 bedrock_link 插件并启用（见 Bedrock-Link-Java 的 README），面板生成**服务器密钥**。
2. 把 `BedrockLink-<版本>.jar` 放进 `plugins/`，启动一次生成 `config.yml`：
   ```yaml
   site-url: "https://你的皮肤站"
   hook-key: "面板生成的服务器密钥"
   require-binding: true   # 基岩无签证不放行
   link-identity: true     # 自动写 Floodgate 链接（需 floodgate player-link.enabled: true）
   verify-java: true       # Java 玩家必须带站点签名的 textures
   ```
3. 填好 `hook-key` 后 `/bedrock reload`（key 为空时插件刻意不注册任何拦截，避免误锁全服）。
4. 站点必须对本服务器可达；**站点不可达时一律拒绝放行**（fail-closed）——
   签证体系的前提是「进服瞬间的持有证明」由站点记录，宁可短暂拦人，不可放进伪造身份。

## 边界与已知限制

- **皮肤接管已实现**（`skin-push: true`，v0.1.26）：站点纹理经 `/hooks/skin` 取回，五路推送
  （进服多档重发 / Java 玩家主动推 / 皮肤监视器 / `SessionSkinApplyEvent` 覆写 / 自发 trusted
  PlayerSkinPacket），基岩自己第三人称与他人视角、皮肤与披风全部生效；换肤后 1 分钟内全视角生效，无需重进。
- 基岩端的硬限制只剩两处：**物品栏纸娃娃与第一人称手臂**永远渲染客户端本地皮肤（任何服务器方案都改不了）。
- 本插件不翻译协议、不验证 Xbox 票据（那是 Geyser/Floodgate 的职责）；它只认
  「Floodgate 实测 XUID + 站点签证」两件事。
- 与 Floodgate 自带 `/link` 玩家自助链接共存：链接记录同库同格式，本插件只是代玩家免命令地写入。

## 构建

无 Maven/Gradle 也可编译（本项目实测路径）：

```
javac --release 21 -encoding UTF-8 -nowarn \
  -cp "paper-api.jar;Geyser-Spigot.jar;floodgate-spigot.jar;gson.jar;adventure-api.jar;adventure-key.jar;annotations.jar;bungeecord-chat.jar" \
  -d out/classes $(find src/main/java -name '*.java')
cp -r src/main/resources/* out/classes/
jar -cf dist/BedrockLink-0.1.30.jar -C out/classes .
```

依赖版本与 `pom.xml` 一致（Paper 26.2 build 129 / Geyser api 2.11.3-SNAPSHOT /
Floodgate api 2.2.5-SNAPSHOT / adventure 5.2.0）。运行环境为 Java 25。

## 许可

MIT（随 MCSkinToServer 生态；对外提供服务保留页脚署名条款见站点主仓库）。

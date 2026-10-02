package top.catnight.bedrocklink;

import com.google.gson.JsonObject;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.geysermc.floodgate.api.FloodgateApi;
import org.geysermc.floodgate.api.link.PlayerLink;
import org.geysermc.floodgate.api.player.FloodgatePlayer;

import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.logging.Logger;

/**
 * 统一登录门控（AsyncPlayerPreLoginEvent）——两条分支：
 * - 基岩（Floodgate）玩家：签证门控。confirm 就是签发点（站点见「pending 申请 + 实测 XUID 进服」双证据）。
 *   门控刻意不放在 Geyser SessionLoginEvent：那一层断开时基岩客户端只会显示
 *   "未找到服务器"通用错误，自定义文案（含 XUID）根本看不到；Java 登录阶段的踢回文案能原样弹出。
 * - Java 玩家：把 textures property 发回站点 /hooks/verify 验签 —— 离线模式下实现「仅限外置登录玩家」。
 */
public final class LoginGate implements Listener {
    public static final String CONFIRM = "/api/plugins/bedrock_link/hooks/confirm";
    public static final String VERIFY = "/api/plugins/bedrock_link/hooks/verify";

    /**
     * 运行时平台探测：登录期读/写 GameProfile（挂载站点纹理、预登录验签）是 Paper 独有 API，
     * Spigot 上调用直接 NoSuchMethodError。Spigot 走降级路径：纹理挂载跳过（Java 观众看不到
     * 基岩玩家的站点皮肤，基岩侧五路推送不受影响），verify-java 改在进服后反射核验、不过即踢。
     */
    public static final boolean PAPER = probePaper();

    private static boolean probePaper() {
        try {
            AsyncPlayerPreLoginEvent.class.getMethod("getPlayerProfile");
            return true;
        } catch (Throwable err) {
            return false;
        }
    }

    private final BedrockLinkPlugin plugin;
    private final Logger log;
    private boolean spigotNoticeLogged;

    public LoginGate(BedrockLinkPlugin plugin) {
        this.plugin = plugin;
        this.log = plugin.getLogger();
    }

    @EventHandler
    public void onPreLogin(AsyncPlayerPreLoginEvent e) {
        if (FloodgateApi.getInstance().isFloodgatePlayer(e.getUniqueId())) {
            gateBedrock(e);
        } else if (plugin.settings().verifyJava()) {
            if (PAPER) {
                gateJava(e);
            } else {
                noticeSpigot();
                // Spigot 预登录拿不到 profile：验签挪到进服后（onJoinVerify），这里放行
            }
        }
    }

    private void noticeSpigot() {
        if (spigotNoticeLogged) return;
        spigotNoticeLogged = true;
        log.info("检测到 Spigot（非 Paper）：纹理挂载与预登录验签降级 —— verify-java 改在进服后核验，"
                + "Java 观众看不到站点皮肤（基岩侧皮肤/披风推送不受影响）。需要完整功能请换 Paper。");
    }

    /** Spigot 降级路径：进服后反射读 textures property 验签，不过即踢（进服即踢，体验略糙但闸门不漏人） */
    @EventHandler
    public void onJoinVerify(org.bukkit.event.player.PlayerJoinEvent e) {
        if (PAPER || !plugin.settings().verifyJava()) return;
        org.bukkit.entity.Player p = e.getPlayer();
        if (FloodgateApi.getInstance().isFloodgatePlayer(p.getUniqueId())) return;
        String name = p.getName();
        java.util.UUID uid = p.getUniqueId();
        String[] tex = readTexturesViaReflection(p);
        org.bukkit.Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
            JsonObject req = new JsonObject();
            req.addProperty("name", name);
            if (tex == null) {
                req.addProperty("value", "");
                req.addProperty("signature", "");
            } else {
                req.addProperty("value", tex[0]);
                req.addProperty("signature", tex[1]);
            }
            JsonObject r;
            try {
                r = plugin.site().post(VERIFY, req);
            } catch (Exception err) {
                kick(uid, "皮肤站暂时连不上，无法核验签证。");
                return;
            }
            if (!(r.has("ok") && r.get("ok").getAsBoolean())) {
                String reason = r.has("reason") ? r.get("reason").getAsString() : "unknown";
                kick(uid, "签证核验未通过（" + reason + "）：请使用皮肤站外置登录进入本服。");
            }
        });
    }

    private void kick(java.util.UUID uid, String msg) {
        org.bukkit.Bukkit.getScheduler().runTask(plugin, () -> {
            org.bukkit.entity.Player p = plugin.getServer().getPlayer(uid);
            if (p != null) p.kickPlayer(msg);
        });
    }

    /** CraftPlayer.getProfile() 在 Spigot/Paper 都存在；authlib 类不硬依赖，全程反射 */
    private static String[] readTexturesViaReflection(org.bukkit.entity.Player p) {
        try {
            Object profile = p.getClass().getMethod("getProfile").invoke(p);
            Object map = profile.getClass().getMethod("getProperties").invoke(profile);
            Object entries = map.getClass().getMethod("entries").invoke(map);
            for (Object entryObj : (Iterable<?>) entries) {
                Object key = entryObj.getClass().getMethod("getKey").invoke(entryObj);
                if (!"textures".equals(String.valueOf(key))) continue;
                Object prop = entryObj.getClass().getMethod("getValue").invoke(entryObj);
                String value = (String) prop.getClass().getMethod("getValue").invoke(prop);
                String sig = (String) prop.getClass().getMethod("getSignature").invoke(prop);
                if (sig == null || sig.isEmpty()) return null;
                return new String[]{value, sig};
            }
        } catch (Throwable err) {
            return null;
        }
        return null;
    }


    private void gateBedrock(AsyncPlayerPreLoginEvent e) {
        if (!plugin.settings().requireBinding()) return;
        FloodgatePlayer fp = FloodgateApi.getInstance().getPlayer(e.getUniqueId());
        if (fp == null) {
            deny(e, "无法读取 Floodgate 身份，请重新进入。");
            return;
        }
        String xuid = fp.getXuid();
        String gamertag = fp.getUsername();
        JsonObject r;
        try {
            JsonObject body = new JsonObject();
            body.addProperty("xuid", xuid);
            body.addProperty("gamertag", gamertag == null ? "" : gamertag);
            // 多互通服：上报本服名字，站点把「签发于哪个服」记进签证（v2.3.0 起可选字段）
            String serverName = plugin.settings().serverName();
            if (!serverName.isEmpty()) body.addProperty("server", serverName);
            r = plugin.site().post(CONFIRM, body);
        } catch (Exception err) {
            log.warning("站点不可达（" + err.getMessage() + "），require-binding 下拒绝放行 " + xuid);
            deny(e, "皮肤站暂时连不上，签证无法核验，请稍后再试。");
            return;
        }
        boolean bound = r.has("bound") && r.get("bound").getAsBoolean();
        // 链接记录的键是「XUID 推导的假 UUID」——已链接玩家的 getJavaUniqueId 会变成站点 UUID，
        // 拿它查/删链接会永远对不上，解绑就撤不掉；必须从 xuid 重新推导
        UUID fakeUuid;
        try {
            fakeUuid = FloodgateApi.getInstance().createJavaPlayerId(Long.parseLong(xuid));
        } catch (NumberFormatException err) {
            fakeUuid = e.getUniqueId();
        }
        if (!bound) {
            unlinkStale(fakeUuid);
            deny(e, "§e你没有本站的基岩签证。\n"
                    + "§7你的 XUID：§f" + xuid + "\n"
                    + "§7打开 " + plugin.settings().displayUrl() + " → 登录皮肤站 → 个人中心 → 账号绑定，\n"
                    + "§7填入上面的 XUID 提交申请，重新进入本服即自动签发。");
            return;
        }
        String status = r.has("status") ? r.get("status").getAsString() : "active";
        if ("pending".equals(status)) {
            deny(e, "签证已签发，请重新进入服务器。");
            return;
        }
        applyIdentity(e, fp, r, fakeUuid);
        if (!e.getLoginResult().equals(AsyncPlayerPreLoginEvent.Result.ALLOWED)) return;
        applyTextures(e, xuid);
    }

    /** 把站点签名纹理挂进 Java GameProfile：Java 侧玩家即可看到该基岩玩家的站点皮肤与披风（仅 Paper） */
    private void applyTextures(AsyncPlayerPreLoginEvent e, String xuid) {
        if (!plugin.settings().skinPush() || !PAPER) return;
        try {
            JsonObject body = new JsonObject();
            body.addProperty("xuid", xuid);
            JsonObject r = plugin.site().post(SkinPush.SKIN_HOOK, body);
            if (!r.has("textures") || r.get("textures").isJsonNull()) return;
            JsonObject t = r.getAsJsonObject("textures");
            e.getPlayerProfile().setProperty(new com.destroystokyo.paper.profile.ProfileProperty(
                    "textures", t.get("value").getAsString(), t.get("signature").getAsString()));
            log.info("已给 " + e.getName() + " 挂载站点纹理（Java 侧皮肤/披风生效）");
        } catch (Exception err) {
            log.warning("挂载站点纹理失败（不影响门控）：" + err.getMessage());
        }
    }

    /** 签证生效 → 确保 Floodgate 链接记录指向站点角色；本次仍以链接后的身份进入才生效 */
    private void applyIdentity(AsyncPlayerPreLoginEvent e, FloodgatePlayer fp, JsonObject r, UUID fakeUuid) {
        if (!plugin.settings().linkIdentity()) return;
        String profileId = r.has("profileId") ? r.get("profileId").getAsString() : "";
        String profileName = r.has("profileName") ? r.get("profileName").getAsString() : "";
        if (profileId.isEmpty()) return;
        try {
            PlayerLink link = FloodgateApi.getInstance().getPlayerLink();
            if (link == null || !link.isEnabled()) {
                log.warning("Floodgate 未启用 player-link（config.yml），无法套用站点身份；签证门控仍生效");
                return;
            }
            if (fp.isLinked() || link.getLinkedPlayer(fakeUuid).get(5, TimeUnit.SECONDS) != null) return;
            link.linkPlayer(fakeUuid, UUID.fromString(profileId), profileName).get(5, TimeUnit.SECONDS);
            boolean justIssued = r.has("justIssued") && r.get("justIssued").getAsBoolean();
            deny(e, "§a签证已签发！§7重新进入服务器，你将以「§f" + profileName + "§7」的身份游玩。");
            log.info("已写入 Floodgate 链接：" + fakeUuid + " → " + profileName + "（" + profileId + "）"
                    + (justIssued ? "（本次为签发）" : ""));
        } catch (Exception err) {
            String msg = String.valueOf(err.getMessage());
            if (msg.contains("Global Linking")) {
                log.severe("写 Floodgate 链接被拒：floodgate/config.yml 开着 enable-global-linking，"
                        + "该模式禁止本地写链接。自托管签证的服务器请改为 enable-own-linking: true + enable-global-linking: false 后重启。");
            } else {
                log.warning("写 Floodgate 链接失败：" + msg);
            }
        }
    }

    /** 站点已无签证（如网页解绑）但本地还留着链接记录 → 撤销，防止解绑不生效 */
    private void unlinkStale(UUID fakeUuid) {
        if (!plugin.settings().linkIdentity()) return;
        try {
            PlayerLink link = FloodgateApi.getInstance().getPlayerLink();
            if (link == null || !link.isEnabled()) return;
            if (link.getLinkedPlayer(fakeUuid).get(5, TimeUnit.SECONDS) != null) {
                link.unlinkPlayer(fakeUuid).get(5, TimeUnit.SECONDS);
                log.info("签证已失效，撤销本地 Floodgate 链接 " + fakeUuid);
            }
        } catch (Exception err) {
            log.warning("撤销 Floodgate 链接失败：" + err.getMessage());
        }
    }

    private void gateJava(AsyncPlayerPreLoginEvent e) {
        com.destroystokyo.paper.profile.PlayerProfile profile = e.getPlayerProfile();
        com.destroystokyo.paper.profile.ProfileProperty textures = profile.getProperties().stream()
                .filter(p -> "textures".equals(p.getName()))
                .findFirst().orElse(null);
        if (textures == null || textures.getSignature() == null || textures.getSignature().isEmpty()) {
            deny(e, "请通过皮肤站外置登录进入本服（" + plugin.settings().displayUrl() + "）");
            return;
        }
        JsonObject req = new JsonObject();
        req.addProperty("name", e.getName());
        req.addProperty("value", textures.getValue());
        req.addProperty("signature", textures.getSignature());
        log.info("verify 请求：name=" + e.getName() + " valueLen=" + textures.getValue().length()
                + " sigLen=" + textures.getSignature().length());
        JsonObject r;
        try {
            r = plugin.site().post(VERIFY, req);
        } catch (Exception err) {
            log.warning("站点不可达（" + err.getMessage() + "），verify-java 下拒绝 " + e.getName());
            deny(e, "皮肤站暂时连不上，无法核验签证。");
            return;
        }
        boolean ok = r.has("ok") && r.get("ok").getAsBoolean();
        if (!ok) {
            // 诊断：把站点原样响应（含 _status）记下来，unknown 不再靠猜
            log.warning("verify 响应未通过：" + r);
            String reason = r.has("reason") ? r.get("reason").getAsString() : "unknown";
            deny(e, "签证核验未通过（" + reason + "）：请使用皮肤站外置登录进入本服。");
        }
    }

    private void deny(AsyncPlayerPreLoginEvent e, String message) {
        e.disallow(AsyncPlayerPreLoginEvent.Result.KICK_OTHER, message);
    }
}

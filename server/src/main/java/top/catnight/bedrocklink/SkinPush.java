package top.catnight.bedrocklink;

import com.google.gson.JsonObject;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.geysermc.floodgate.api.FloodgateApi;
import org.geysermc.floodgate.api.player.FloodgatePlayer;
import org.geysermc.geyser.api.GeyserApi;
import org.geysermc.geyser.api.connection.GeyserConnection;
import org.geysermc.geyser.api.skin.Skin;
import org.geysermc.geyser.api.skin.SkinData;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Base64;
import java.util.logging.Logger;

/**
 * 皮肤接管：签证玩家进服后，从站点 /hooks/skin 取绑定角色的签名 textures property，
 * 解出 SKIN 图片 URL → 下载 → 经 Geyser sendSkin 推给基岩客户端（覆盖其自带皮肤）。
 * 披风如实说明：基岩客户端不支持 Java 披风，只推皮肤；Java 侧玩家看该玩家仍是站点全套纹理。
 */
public final class SkinPush implements Listener {
    public static final String SKIN_HOOK = "/api/plugins/bedrock_link/hooks/skin";

    private final BedrockLinkPlugin plugin;
    private final Logger log;
    private final HttpClient http = HttpClient.newHttpClient();
    /** javaUuid → 已下载的皮肤字节；SessionSkinApplyEvent 同步取用，不阻塞网络线程去下载 */
    private final java.util.concurrent.ConcurrentHashMap<java.util.UUID, Cached> cache =
            new java.util.concurrent.ConcurrentHashMap<>();

    private record Cached(byte[] png, boolean slim, long atMs, String value, String signature, byte[] cape) {}

    /** 皮肤监视器：每个在线玩家当前已广播的 skinId，变化才动 */
    private final java.util.concurrent.ConcurrentHashMap<java.util.UUID, String> lastId =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** 站点不认识的 UUID（普通离线玩家/头颅）短负缓存，防止每次皮肤应用都打一发 hook */
    private final java.util.concurrent.ConcurrentHashMap<java.util.UUID, Long> negative =
            new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * 基岩按 skinId 缓存皮肤：id 恒定（如文件名）会让换肤/换人不生效。
     * Geyser 把 Skin.textureUrl 直接当 skinId 用，所以这里放内容哈希。
     */
    static String skinId(byte[] png, boolean slim) {
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(png);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", d[i]));
            return sb + (slim ? "-slim" : "");
        } catch (java.security.NoSuchAlgorithmException err) {
            return "bedrocklink-" + png.length + (slim ? "-slim" : "");
        }
    }

    public SkinPush(BedrockLinkPlugin plugin) {
        this.plugin = plugin;
        this.log = plugin.getLogger();
        // Geyser 应用皮肤的那一刻直接替换数据：自己视角、他人视角、重生全部覆盖 ——
        // 这是 SkinRestorer 同款挂点；sendSkin 对本地玩家纸娃娃并不可靠
        org.geysermc.geyser.api.GeyserApi.api().eventBus().subscribe(
                org.geysermc.geyser.api.event.EventRegistrar.of(plugin),
                org.geysermc.geyser.api.event.bedrock.SessionSkinApplyEvent.class,
                this::onSkinApply);
        // 皮肤监视器：在线玩家换肤后 1 分钟内全视角生效，无需重进（站点一次 hook/人/分钟，很轻）
        Bukkit.getScheduler().runTaskTimerAsynchronously(plugin, this::watchSkins, 1200L, 1200L);
    }

    /** 在线皮肤守卫：异步现取现比（Paper 禁止异步 hide/show），有变化回主线程重播 */
    private void watchSkins() {
        if (!plugin.settings().skinPush()) return;
        try {
            java.util.List<Change> pending = new java.util.ArrayList<>();
            for (Player p : Bukkit.getOnlinePlayers()) {
                java.util.UUID u = p.getUniqueId();
                Cached c = fetch(u);
                if (c == null) continue;
                String id = skinId(c.png(), c.slim());
                String prev = lastId.put(u, id);
                if (prev == null || id.equals(prev)) continue; // 首次记录=基线，进服链路已推过
                pending.add(new Change(p, c, id, rawPixels(c),
                        c.cape() != null && c.cape().length > 0 ? rawBytes(c.cape()) : null,
                        FloodgateApi.getInstance().isFloodgatePlayer(u)));
            }
            if (pending.isEmpty()) return;
            Bukkit.getScheduler().runTask(plugin, () -> {
                for (Change ch : pending) applyChange(ch);
            });
        } catch (Exception err) {
            log.warning("皮肤监视器异常（不影响登录链路）：" + err.getMessage());
        }
    }

    private record Change(Player player, Cached c, String id, byte[] raw, byte[] capeRaw, boolean bedrock) {}

    private void applyChange(Change ch) {
        Player p = ch.player();
        java.util.UUID u = p.getUniqueId();
        Cached c = ch.c();
        if (ch.bedrock() && c.value() != null && c.signature() != null) {
            // Java 观众：换档案 + hide/show 强制按新 blob URL 重取（绕开注入器旧缓存）
            com.destroystokyo.paper.profile.PlayerProfile pp = p.getPlayerProfile();
            pp.setProperty(new com.destroystokyo.paper.profile.ProfileProperty(
                    "textures", c.value(), c.signature()));
            p.setPlayerProfile(pp);
        }
        org.geysermc.geyser.api.skin.Cape cape = ch.capeRaw() == null ? emptyCape()
                : new org.geysermc.geyser.api.skin.Cape(skinId(ch.c().cape(), false),
                        skinId(ch.c().cape(), false), ch.capeRaw());
        SkinData data = new SkinData(new Skin(ch.id(), ch.raw()), cape,
                c.slim() ? org.geysermc.geyser.api.skin.SkinGeometry.SLIM
                        : org.geysermc.geyser.api.skin.SkinGeometry.WIDE);
        for (Player v : Bukkit.getOnlinePlayers()) {
            if (v.getUniqueId().equals(u)) continue;
            if (FloodgateApi.getInstance().isFloodgatePlayer(v.getUniqueId())) {
                GeyserConnection conn = GeyserApi.api().connectionByUuid(v.getUniqueId());
                if (conn != null) conn.sendSkin(u, data);
            } else if (ch.bedrock()) {
                v.hidePlayer(plugin, p);
                v.showPlayer(plugin, p);
            }
        }
        if (ch.bedrock()) {
            FloodgatePlayer fp = FloodgateApi.getInstance().getPlayer(u);
            GeyserConnection self = GeyserApi.api().connectionByUuid(u);
            if (fp != null && self != null) pushSelfTrusted(fp, self, c);
        }
        log.info("皮肤监视器：检测到 " + p.getName() + " 换肤，已重播全部视角");
    }

    private void onSkinApply(org.geysermc.geyser.api.event.bedrock.SessionSkinApplyEvent ev) {
        if (!plugin.settings().skinPush()) return;
        java.util.UUID uuid = ev.uuid();
        Cached c = cache.get(uuid);
        if (c == null || System.currentTimeMillis() - c.atMs() > 10 * 60_000L) {
            Long neg = negative.get(uuid);
            long now = System.currentTimeMillis();
            if (neg != null && now - neg < 60_000L) return; // 站点不认识的人，1 分钟内不再追问
            // 事件在 Geyser 自己的异步执行器上触发（同层也在抓 Mojang 纹理），
            // 就地同步取一次；基岩链接玩家与 Java 站点玩家都走这里
            c = fetch(uuid);
            if (c == null) {
                negative.put(uuid, now);
                return;
            }
        }
        // Skin 第三参是 failed（不是 slim！）；纤细走 SkinGeometry.SLIM；像素要裸 ARGB 不是 PNG
        try {
            ev.skin(new Skin(skinId(c.png(), c.slim()), rawPixels(c)));
            if (c.cape() != null && c.cape().length > 0) ev.cape(capeOf(c));
        } catch (Exception err) {
            log.warning("皮肤像素转换失败（" + uuid + "）：" + err.getMessage());
            return;
        }
        ev.geometry(c.slim()
                ? org.geysermc.geyser.api.skin.SkinGeometry.SLIM
                : org.geysermc.geyser.api.skin.SkinGeometry.WIDE);
        log.info("SessionSkinApplyEvent 已应用站点皮肤（" + uuid + "，" + (c.slim() ? "slim" : "default") + "）");
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        if (!plugin.settings().skinPush()) return;
        Player player = e.getPlayer();
        // 换肤重进即生效：进服先作废自己的皮肤缓存，本次所有推送（自发/推他人/事件）都现取新图
        cache.remove(player.getUniqueId());
        negative.remove(player.getUniqueId());
        boolean bedrock = FloodgateApi.getInstance().isFloodgatePlayer(player.getUniqueId());
        // 基岩客户端在出生流程收尾时会用本地皮肤覆盖服务器早发的条目，
        // 单次推送会被冲掉；SkinRestorer 同款做法是多档延迟重发（缓存命中后近乎零成本）。
        // Java 站点玩家的皮肤 Geyser 自己拉不到（注入器把 URL 改写成 Java 客户端本机代理），
        // 只能由我们主动推给每个基岩连接。
        for (long delay : new long[]{2L, 60L, 160L, 400L}) {
            Bukkit.getScheduler().runTaskLater(plugin, () ->
                    Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> {
                        if (bedrock) push(player.getUniqueId(), 0);
                        syncJavaSkins();
                    }), delay);
        }
    }

    /** 所有在线 Java 玩家：按 profileId 问站点拿皮肤，推给每个在线基岩连接 */
    /** 所有在线站点玩家（Java 与基岩都算）：取皮肤推给每个基岩观众连接 */
    private void syncJavaSkins() {
        try {
            java.util.List<Player> bedrockViewers = new java.util.ArrayList<>();
            for (Player v : Bukkit.getOnlinePlayers()) {
                if (FloodgateApi.getInstance().isFloodgatePlayer(v.getUniqueId())) bedrockViewers.add(v);
            }
            if (bedrockViewers.isEmpty()) return;
            for (Player p : Bukkit.getOnlinePlayers()) {
                java.util.UUID u = p.getUniqueId();
                // v0.1.30：基岩主体不再跳过——门控给基岩玩家挂了 textures property 后，
                // Geyser 对他就走「按 URL 直拉」而**从不触发** SessionSkinApplyEvent（#4 真机 0 次实证），
                // 于是基岩↔基岩观众两头落空。与 Java 站点玩家同路：我们主动推给每个基岩连接。
                Cached c = fetchCached(u);
                if (c == null) continue;
                SkinData data = new SkinData(new Skin(skinId(c.png(), c.slim()), rawPixels(c)), capeOf(c),
                        c.slim() ? org.geysermc.geyser.api.skin.SkinGeometry.SLIM
                                : org.geysermc.geyser.api.skin.SkinGeometry.WIDE);
                int sent = 0;
                for (Player v : bedrockViewers) {
                    if (v.getUniqueId().equals(u)) continue; // 自己那路由 push()/trusted 包负责
                    GeyserConnection conn = GeyserApi.api().connectionByUuid(v.getUniqueId());
                    if (conn != null) { conn.sendSkin(u, data); sent++; }
                }
                log.info("已把站点玩家 " + p.getName() + " 的皮肤推给 " + sent + " 个基岩观众");
            }
        } catch (Exception err) {
            log.warning("syncJavaSkins 失败（不影响其他链路）：" + err.getMessage());
        }
    }

    /** 公开 sendSkin 链路里 getSkin 无条件调 cape.capeData()：null 直接 NPE，给全透明占位 */
    private static org.geysermc.geyser.api.skin.Cape emptyCape() {
        return new org.geysermc.geyser.api.skin.Cape("", "", new byte[64 * 32 * 4]);
    }

    /** PNG 字节 → Geyser 认可的原始 ARGB 像素（ImageData.of 只收 8192/16384/… 裸像素长度） */
    private static byte[] rawBytes(byte[] png) throws Exception {
        java.awt.image.BufferedImage img = javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(png));
        if (img == null) throw new IllegalArgumentException("PNG 解码失败");
        Class<?> skinProvider = Class.forName("org.geysermc.geyser.skin.SkinProvider");
        java.lang.reflect.Method toRaw = skinProvider.getMethod("bufferedImageToImageData", java.awt.image.BufferedImage.class);
        return (byte[]) toRaw.invoke(null, img);
    }

    private byte[] rawPixels(Cached c) throws Exception {
        return rawBytes(c.png());
    }

    /** 站点披风 → 基岩 SerializedSkin 的 capeData/capeId；没有披风时给全透明占位 */
    private org.geysermc.geyser.api.skin.Cape capeOf(Cached c) throws Exception {
        if (c.cape() == null || c.cape().length == 0) return emptyCape();
        String id = skinId(c.cape(), false);
        return new org.geysermc.geyser.api.skin.Cape(id, id, rawBytes(c.cape()));
    }

    /** 缓存 →（未命中且不在负缓存）→ fetch；站点不认识的人 1 分钟内不再追问 */
    private Cached fetchCached(java.util.UUID uuid) {
        Cached c = cache.get(uuid);
        if (c != null && System.currentTimeMillis() - c.atMs() <= 10 * 60_000L) return c;
        Long neg = negative.get(uuid);
        long now = System.currentTimeMillis();
        if (neg != null && now - neg < 60_000L) return null;
        c = fetch(uuid);
        if (c == null) negative.put(uuid, now);
        return c;
    }

    @EventHandler
    public void onQuit(org.bukkit.event.player.PlayerQuitEvent e) {
        lastId.remove(e.getPlayer().getUniqueId());
    }

    @EventHandler
    public void onRespawn(org.bukkit.event.player.PlayerRespawnEvent e) {
        if (!plugin.settings().skinPush()) return;
        Player player = e.getPlayer();
        if (!FloodgateApi.getInstance().isFloodgatePlayer(player.getUniqueId())) return;
        Bukkit.getScheduler().runTaskLater(plugin, () ->
                Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> push(player.getUniqueId(), 0)), 5L);
    }

    private void push(java.util.UUID uuid, int attempt) {
        try {
            FloodgatePlayer fp = FloodgateApi.getInstance().getPlayer(uuid);
            if (fp == null) return;
            GeyserConnection probe = GeyserApi.api().connectionByUuid(uuid);
            if (probe == null) {
                // 会话还没挂上：2 秒后补试，最多 3 次
                if (attempt < 3) {
                    Bukkit.getScheduler().runTaskLater(plugin, () ->
                            Bukkit.getScheduler().runTaskAsynchronously(plugin, () -> push(uuid, attempt + 1)), 40L);
                }
                return;
            }
            Cached c = fetch(uuid);
            if (c == null) return;
            GeyserConnection conn = GeyserApi.api().connectionByUuid(uuid);
            if (conn == null) conn = probe;
            if (conn.playerEntity() == null) {
                // GeyserConnection.sendSkin 在实体未入缓存时会静默返回，这里把哑路径变可见
                log.info("推送时本地实体尚未就绪（" + uuid + "），等下一档重试");
                return;
            }
            conn.sendSkin(uuid, new SkinData(new Skin(skinId(c.png(), c.slim()), rawPixels(c)), capeOf(c),
                    c.slim() ? org.geysermc.geyser.api.skin.SkinGeometry.SLIM
                            : org.geysermc.geyser.api.skin.SkinGeometry.WIDE));
            pushSelfTrusted(fp, conn, c);
            log.info("已给 " + fp.getUsername() + " 推送站点皮肤（" + (c.slim() ? "slim" : "default") + "）");
        } catch (Exception err) {
            log.warning("皮肤推送失败（不影响签证门控）：" + err.getMessage());
        }
    }

    /**
     * 实验（v0.1.12）：Geyser sendSkin 对「自己」走 PlayerList 条目，基岩本地角色渲染
     * 疑似只认 trusted PlayerSkinPacket（他人路径同款）。这里绕过公开 API 直接给自己发一份。
     */
    private void pushSelfTrusted(FloodgatePlayer fp, GeyserConnection conn, Cached c) {
        try {
            Object session = unwrapSession(conn);
            if (session == null) {
                log.warning("未能取到 GeyserSession（内部结构可能已变），跳过 PlayerSkinPacket");
                return;
            }
            Class<?> sessionClass = Class.forName("org.geysermc.geyser.session.GeyserSession");
            java.lang.reflect.Method getSkin = Class.forName("org.geysermc.geyser.skin.SkinManager")
                    .getDeclaredMethod("getSkin", sessionClass, String.class, Skin.class,
                            org.geysermc.geyser.api.skin.Cape.class,
                            org.geysermc.geyser.api.skin.SkinGeometry.class);
            getSkin.setAccessible(true);
            String id = skinId(c.png(), c.slim());
            // ImageData.of() 要的是 width*height*4 的裸像素，且 Geyser 自己的序是 RGBA
            // （SkinProvider.bufferedImageToImageData 逐像素 R,G,B,A 写出）。直接复用它，别手搓字节序。
            Skin rawSkin = new Skin(id, rawBytes(c.png()));
            // SkinManager.getSkin 无条件调 cape.capeData()：null 会 NPE；有真披风给真披风
            org.geysermc.geyser.api.skin.Cape cape = capeOf(c);
            org.cloudburstmc.protocol.bedrock.data.skin.SerializedSkin serialized =
                    (org.cloudburstmc.protocol.bedrock.data.skin.SerializedSkin) getSkin.invoke(null,
                            session, id, rawSkin, cape,
                            c.slim() ? org.geysermc.geyser.api.skin.SkinGeometry.SLIM
                                    : org.geysermc.geyser.api.skin.SkinGeometry.WIDE);
            // 客户端只认自己「真实 CUOID」（登录报文里的 AuthData.uuid），
            // Floodgate 由 XUID 推导的假 UUID 是链接键，不是它
            java.util.UUID cuuid;
            try {
                Object authData = sessionClass.getMethod("getAuthData").invoke(session);
                cuuid = (java.util.UUID) authData.getClass().getMethod("uuid").invoke(authData);
            } catch (Exception lookupErr) {
                cuuid = FloodgateApi.getInstance()
                        .createJavaPlayerId(Long.parseLong(fp.getXuid()));
            }
            org.cloudburstmc.protocol.bedrock.packet.PlayerSkinPacket pkt =
                    new org.cloudburstmc.protocol.bedrock.packet.PlayerSkinPacket();
            pkt.setUuid(cuuid);
            pkt.setOldSkinName("");
            pkt.setNewSkinName(id);
            pkt.setSkin(serialized);
            pkt.setTrustedSkin(true);
            sessionClass.getMethod("sendUpstreamPacketImmediately",
                            org.cloudburstmc.protocol.bedrock.packet.BedrockPacket.class)
                    .invoke(session, pkt);
            log.info("已向自己直发 trusted PlayerSkinPacket（CUOID " + cuuid + "）");
        } catch (Exception err) {
            Throwable cause = err instanceof java.lang.reflect.InvocationTargetException && err.getCause() != null
                    ? err.getCause() : err;
            log.warning("自发 PlayerSkinPacket 失败（不影响其他链路）：" + cause);
        }
    }

    private static Object unwrapSession(GeyserConnection conn) throws Exception {
        // GeyserImpl.connectionByUuid 返回的就是 GeyserSession 本身（它实现了 GeyserConnection）
        Class<?> sessionClass = Class.forName("org.geysermc.geyser.session.GeyserSession");
        if (sessionClass.isInstance(conn)) return conn;
        for (Class<?> k = conn.getClass(); k != null; k = k.getSuperclass()) {
            for (java.lang.reflect.Field f : k.getDeclaredFields()) {
                if (sessionClass.isAssignableFrom(f.getType())) {
                    f.setAccessible(true);
                    return f.get(conn);
                }
            }
        }
        return null;
    }

    /**
     * 站点 /hooks/skin 取签名 textures → 解出 SKIN 图 URL → 下载 PNG → 入缓存。
     * 基岩链接玩家按 XUID 问；其他玩家（Java 站点角色）按 profileId=其 UUID 问。
     * 调用方线程必须允许阻塞网络（Geyser 异步执行器或 Bukkit async 线程）。
     */
    private Cached fetch(java.util.UUID uuid) {
        try {
            FloodgatePlayer fp = FloodgateApi.getInstance().getPlayer(uuid);
            JsonObject body = new JsonObject();
            if (fp != null) body.addProperty("xuid", fp.getXuid());
            else body.addProperty("profileId", uuid.toString());
            JsonObject r = plugin.site().post(SKIN_HOOK, body);
            if (!(r.has("bound") && r.get("bound").getAsBoolean())) return null;
            if (!r.has("textures") || r.get("textures").isJsonNull()) return null;
            String value = r.getAsJsonObject("textures").get("value").getAsString();
            String signature = r.getAsJsonObject("textures").has("signature")
                    ? r.getAsJsonObject("textures").get("signature").getAsString() : null;
            JsonObject payload = new com.google.gson.Gson()
                    .fromJson(new String(Base64.getDecoder().decode(value), java.nio.charset.StandardCharsets.UTF_8),
                            JsonObject.class);
            JsonObject textures = payload.getAsJsonObject("textures");
            if (textures == null || !textures.has("SKIN")) return null; // 角色没皮肤：不推，保留基岩自带外观
            String url = textures.getAsJsonObject("SKIN").get("url").getAsString();
            boolean slim = textures.getAsJsonObject("SKIN").has("metadata")
                    && "slim".equals(textures.getAsJsonObject("SKIN").getAsJsonObject("metadata")
                    .get("model").getAsString());
            byte[] png = http.send(HttpRequest.newBuilder(URI.create(url)).GET()
                            .timeout(java.time.Duration.ofSeconds(8)).build(),
                    HttpResponse.BodyHandlers.ofByteArray()).body();
            if (png == null || png.length == 0) return null;
            byte[] cape = null;
            if (textures.has("CAPE")) {
                try {
                    cape = http.send(HttpRequest.newBuilder(
                                    URI.create(textures.getAsJsonObject("CAPE").get("url").getAsString())).GET()
                                    .timeout(java.time.Duration.ofSeconds(8)).build(),
                            HttpResponse.BodyHandlers.ofByteArray()).body();
                } catch (Exception ignore) {
                    /* 披风拉不到不拦皮肤 */
                }
            }
            Cached c = new Cached(png, slim, System.currentTimeMillis(), value, signature, cape);
            cache.put(uuid, c);
            log.info("已取到站点皮肤（角色 " + r.get("profileName").getAsString()
                    + (slim ? "，slim" : "") + "，" + png.length + " 字节"
                    + (cape != null && cape.length > 0 ? "，含披风" : "") + "）");
            return c;
        } catch (Exception err) {
            log.warning("站点皮肤获取失败（不影响签证门控）：" + err.getMessage());
            return null;
        }
    }
}

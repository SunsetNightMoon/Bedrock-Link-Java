package top.catnight.bedrocklink;

import com.google.gson.JsonObject;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.geysermc.floodgate.api.FloodgateApi;
import org.geysermc.floodgate.api.player.FloodgatePlayer;

/**
 * /bedrock xuid —— 查自己的 XUID 与签证状态（基岩玩家）
 * /bedrock reload —— 重读配置
 * （v0.1.28：/bedrock link 随站点 v2.2.0 移除码制一并退役）
 */
public final class BedrockCommand implements CommandExecutor {
    private static final String LOOKUP = "/api/plugins/bedrock_link/hooks/lookup";

    private final BedrockLinkPlugin plugin;

    public BedrockCommand(BedrockLinkPlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length >= 1 && args[0].equalsIgnoreCase("reload")) {
            if (!sender.hasPermission("bedrocklink.use")) return true;
            plugin.reloadSettings();
            sender.sendMessage("BedrockLink 配置已重载");
            return true;
        }
        if (args.length >= 2 && args[0].equalsIgnoreCase("prop")) {
            // 取证：转某个在线玩家当前 GameProfile 里 textures 的真实内容（服务器到底往外发什么）
            if (!LoginGate.PAPER) { sender.sendMessage("prop 取证读的是 Paper 的 GameProfile API，Spigot 上不可用"); return true; }
            Player target = org.bukkit.Bukkit.getPlayerExact(args[1]);
            if (target == null) { sender.sendMessage("玩家不在线：" + args[1]); return true; }
            com.destroystokyo.paper.profile.PlayerProfile pp = target.getPlayerProfile();
            var props = pp.getProperties().stream()
                    .filter(p -> "textures".equals(p.getName())).findFirst();
            if (props.isEmpty()) { sender.sendMessage(args[1] + " 当前没有 textures property"); return true; }
            try {
                String json = new String(java.util.Base64.getDecoder()
                        .decode(props.get().getValue()), java.nio.charset.StandardCharsets.UTF_8);
                JsonObject v = com.google.gson.JsonParser.parseString(json).getAsJsonObject();
                String url = v.has("textures") && v.getAsJsonObject("textures").has("SKIN")
                        ? v.getAsJsonObject("textures").getAsJsonObject("SKIN").get("url").getAsString() : "(无SKIN)";
                sender.sendMessage("textures: name=" + (v.has("profileName") ? v.get("profileName") : "?")
                        + " ts=" + (v.has("timestamp") ? v.get("timestamp") : "?") + " url=" + url
                        + " sigLen=" + (props.get().getSignature() == null ? -1 : props.get().getSignature().length()));
            } catch (Exception err) {
                sender.sendMessage("解码失败：" + err);
            }
            return true;
        }
        if (!(sender instanceof Player player)) {
            sender.sendMessage("仅玩家可用 xuid/link");
            return true;
        }
        FloodgatePlayer fp = FloodgateApi.getInstance().getPlayer(player.getUniqueId());
        if (fp == null) {
            sender.sendMessage("你不是经 Geyser 进入的基岩玩家，无需签证。");
            return true;
        }
        String xuid = fp.getXuid();
        if (args.length >= 1 && args[0].equalsIgnoreCase("xuid")) {
            sender.sendMessage("你的 XUID：" + xuid + "（去皮肤站「账号绑定」里填它申请）");
            try {
                JsonObject body = new JsonObject();
                body.addProperty("xuid", xuid);
                JsonObject r = plugin.site().post(LOOKUP, body);
                if (r.has("bound") && r.get("bound").getAsBoolean()) {
                    sender.sendMessage("签证状态：" + r.get("status").getAsString()
                            + " · 角色 " + r.get("profileName").getAsString());
                } else {
                    sender.sendMessage("签证状态：未绑定");
                }
            } catch (Exception err) {
                sender.sendMessage("站点查询失败：" + err.getMessage());
            }
            return true;
        }
        sender.sendMessage("用法：/bedrock xuid | /bedrock reload");
        return true;
    }
}

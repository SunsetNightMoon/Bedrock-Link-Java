package top.catnight.bedrocklink;

import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.java.JavaPlugin;

public final class BedrockLinkPlugin extends JavaPlugin {
    public record Settings(String siteUrl, String displayUrl, String hookKey, boolean requireBinding,
                           boolean linkIdentity, boolean verifyJava, boolean skinPush) {}

    private volatile SiteClient site;
    private volatile Settings settings;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        reloadSettings();
        if (settings.hookKey().isEmpty()) {
            getLogger().severe("config.yml 的 hook-key 未填（面板 → 插件管理 → bedrock_link → 服务器密钥）。"
                    + "门控与验签无法工作，插件不注册任何拦截。");
            return;
        }
        getServer().getPluginManager().registerEvents(new LoginGate(this), this);
        getServer().getPluginManager().registerEvents(new SkinPush(this), this);
        PluginCommand cmd = getCommand("bedrock");
        if (cmd != null) cmd.setExecutor(new BedrockCommand(this));
        getLogger().info("已启用：site=" + settings.siteUrl()
                + " require-binding=" + settings.requireBinding()
                + " link-identity=" + settings.linkIdentity()
                + " verify-java=" + settings.verifyJava());
    }

    public void reloadSettings() {
        reloadConfig();
        String url = getConfig().getString("site-url", "http://127.0.0.1:3010").trim();
        String display = getConfig().getString("site-display-url", "").trim();
        String key = getConfig().getString("hook-key", "").trim();
        settings = new Settings(url, display.isEmpty() ? url : display, key,
                getConfig().getBoolean("require-binding", true),
                getConfig().getBoolean("link-identity", true),
                getConfig().getBoolean("verify-java", true),
                getConfig().getBoolean("skin-push", true));
        site = new SiteClient(url, key);
    }

    public SiteClient site() {
        return site;
    }

    public Settings settings() {
        return settings;
    }
}

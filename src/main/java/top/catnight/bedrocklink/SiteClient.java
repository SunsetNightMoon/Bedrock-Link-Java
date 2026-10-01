package top.catnight.bedrocklink;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;

/**
 * MCSTS 插件 hooks 的 HMAC 客户端。签名串与站点 src/plugins/hmac.ts 的约定逐字节对齐：
 * ts \n nonce \n METHOD \n 完整挂载路径 \n sha256hex(body)，HMAC-SHA256 十六进制小写。
 * body 的 JSON 文本只序列化一次，签名与发送共用同一份 —— 两边序列化不一致是 403 的头号成因。
 */
public final class SiteClient {
    private final String base;
    private final String key;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    // Gson 默认把 = < > & ' 转义成 \u003d 等：base64 的 = 填充会被改写，
    // 而核心按 JSON.stringify(解析后的 body) 算哈希 —— 两边字节不一致直接 bad_signature。
    // 必须关 HTML 转义，序列化结果才与站点侧重序列化逐字节一致。
    private final Gson gson = new com.google.gson.GsonBuilder().disableHtmlEscaping().create();

    public SiteClient(String siteUrl, String hookKey) {
        this.base = siteUrl.endsWith("/") ? siteUrl.substring(0, siteUrl.length() - 1) : siteUrl;
        this.key = hookKey;
    }

    public JsonObject post(String hookPath, JsonObject body) throws Exception {
        String bodyStr = gson.toJson(body);
        String ts = String.valueOf(System.currentTimeMillis());
        String nonce = UUID.randomUUID().toString().replace("-", "");
        String canonical = ts + "\n" + nonce + "\nPOST\n" + hookPath + "\n" + sha256Hex(bodyStr);
        HttpRequest req = HttpRequest.newBuilder(URI.create(base + hookPath))
                .timeout(Duration.ofSeconds(8))
                .header("Content-Type", "application/json")
                .header("X-MCSTS-Timestamp", ts)
                .header("X-MCSTS-Nonce", nonce)
                .header("X-MCSTS-Signature", hmacHex(canonical))
                .POST(HttpRequest.BodyPublishers.ofString(bodyStr, StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonObject json = gson.fromJson(res.body(), JsonObject.class);
        if (json == null) json = new JsonObject();
        json.addProperty("_status", res.statusCode());
        return json;
    }

    private String hmacHex(String canonical) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return HexFormat.of().formatHex(mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
    }

    private static String sha256Hex(String text) throws Exception {
        return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
    }
}

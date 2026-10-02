/**
 * bedrock_link —— MCSkinToServer 官方插件：基岩版身份绑定（站点侧）v2「签证」模型。
 *
 * 对练规则：本文件**只依赖 `plugin-api.d.ts` 与开发指南**，不读 MCSTS 源码。
 *
 * 签证的两条证据链：
 * - **意愿**：玩家在站点（已登录）对自己的角色提交 XUID 申请 → 状态 pending；
 * - **持有**：Floodgate 对 Xbox 会话实测的 XUID 出现在进服瞬间（在线服不可伪造），
 *   伴生插件调 /hooks/confirm → 站点把该申请签发为 active。
 * 两条齐了才生效；玩家全程零命令。v2.2.0 起码制（issue→/hooks/bind）移除：
 * XUID 申请已覆盖同一件事且更强（微软背书的持有证明），页面也不再出现生成码按钮。
 */
import { createVerify } from 'node:crypto';
import type {
  PluginBindingActor,
  PluginContext,
  PluginSetup,
} from './plugin-api.js';

/** Floodgate 实测的 XUID 是一串十进制数字；形态不对一律拒 */
const XUID_PATTERN = /^[0-9]{1,21}$/;

type Row = {
  xuid: unknown;
  profile_id: unknown;
  profile_name: unknown;
  gamertag: unknown;
  status: unknown;
  bound_at: unknown;
  server: unknown;
};

/** 「名字=地址；名字=地址」——名字可省略；分号（含中文）与换行都是分隔符 */
function parseServers(raw: string): { name: string; addr: string }[] {
  return raw
    .split(/[;；\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const eq = entry.indexOf('=');
      return eq > 0
        ? { name: entry.slice(0, eq).trim(), addr: entry.slice(eq + 1).trim() }
        : { name: '', addr: entry };
    })
    .filter((s) => s.addr !== '');
}

const setup: PluginSetup = async (ctx: PluginContext) => {
  const table = ctx.table('bindings');
  const ph = (i: number): string => (ctx.db.dialect === 'postgres' ? `$${i + 1}` : '?');

  await ctx.db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       xuid         TEXT PRIMARY KEY,
       profile_id   TEXT NOT NULL UNIQUE,
       profile_name TEXT NOT NULL,
       user_id      TEXT NOT NULL,
       gamertag     TEXT,
       status       TEXT NOT NULL,
       bound_at     TEXT NOT NULL,
       server       TEXT
     )`,
  );
  // v2.3.0 多互通服：老库补 server 列（签发时记录观测到该 XUID 的服务器名）
  if (ctx.db.dialect === 'postgres') {
    await ctx.db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS server TEXT`);
  } else {
    const cols = await ctx.db.query<{ name: string }>(`PRAGMA table_info(${table})`, []);
    if (!cols.some((c) => String(c.name) === 'server')) {
      await ctx.db.exec(`ALTER TABLE ${table} ADD COLUMN server TEXT`);
    }
  }

  const rowOut = (r: Row) => ({
    bound: true,
    status: String(r.status),
    profileId: String(r.profile_id),
    profileName: String(r.profile_name),
    gamertag: r.gamertag === null || r.gamertag === undefined ? null : String(r.gamertag),
    server: r.server === null || r.server === undefined ? null : String(r.server),
  });

  // ---- 生命周期跟随：绑定存角色 UUID，名字只是展示副本 ----
  ctx.events.on('profile.renamed', async (payload) => {
    await ctx.db.run(
      `UPDATE ${table} SET profile_name = ${ph(0)} WHERE profile_id = ${ph(1)}`,
      [payload.to, payload.profileId],
    );
  });
  ctx.events.on('profile.deleted', async (payload) => {
    await ctx.db.run(`DELETE FROM ${table} WHERE profile_id = ${ph(0)}`, [payload.profileId]);
  });
  // 角色被换下（多→单、或单模式换 ID）：绑定随之作废，XUID 释放给新的可用角色重绑。
  // 预留角色只是名字占位，不再是可用身份 —— 留着绑定等于让一个进不了服的 ID 继续放行。
  ctx.events.on('profile.reserved', async (payload) => {
    await ctx.db.run(`DELETE FROM ${table} WHERE profile_id = ${ph(0)}`, [payload.profileId]);
  });
  ctx.events.on('account.purged', async (payload) => {
    for (const profileId of payload.profileIds) {
      await ctx.db.run(`DELETE FROM ${table} WHERE profile_id = ${ph(0)}`, [profileId]);
    }
  });

  // ---- 账号设置区的通用绑定页 ----
  ctx.binding({
    async list(actor: PluginBindingActor) {
      const rows = await ctx.db.query<Row>(
        `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at, server FROM ${table} WHERE profile_id = ${ph(0)}`,
        [actor.profileId],
      );
      const serversRaw = String((await ctx.settings.get('SERVERS')) ?? '').trim();
      // 兼容回落：v2.3.0 前只有 JOIN_ADDRESS 一个地址；SERVERS 没配时照旧生效
      const legacy = String((await ctx.settings.get('JOIN_ADDRESS')) ?? '').trim();
      const servers = serversRaw !== '' ? parseServers(serversRaw) : parseServers(legacy);
      const fields = (r: Row) => {
        const list = [
          { label: 'XUID', value: String(r.xuid), secret: true },
          { label: '角色', value: String(r.profile_name) },
        ];
        if (r.gamertag !== null && r.gamertag !== undefined) {
          list.push({ label: '签发时昵称', value: String(r.gamertag) });
        }
        if (r.server !== null && r.server !== undefined && String(r.server) !== '') {
          list.push({ label: '签发于', value: String(r.server) });
        }
        return list;
      };
      const where =
        servers.length > 0
          ? `用基岩版加入以下任一服务器：${servers.map((s) => (s.name === '' ? s.addr : `${s.name}（${s.addr}）`)).join('、')}；`
          : '';
      const claimHintText =
        `${where}被拦下的屏幕会显示你的 XUID，填入输入框提交申请，重新进服的那一刻签发。`;
      return {
        bindings: rows.map((r) => ({
          id: String(r.xuid),
          fields: fields(r),
          boundAt: String(r.bound_at),
          status: (r.status === 'pending' ? 'pending' : 'active') as 'pending' | 'active',
        })),
        instructions: claimHintText,
      };
    },

    async claim(actor: PluginBindingActor & { value: string }) {
      const xuid = actor.value.trim();
      if (!XUID_PATTERN.test(xuid)) return { message: 'XUID 格式不正确' };

      const byXuid = await ctx.db.query<Row>(
        `SELECT xuid, profile_id, status FROM ${table} WHERE xuid = ${ph(0)}`,
        [xuid],
      );
      const hitX = byXuid[0];
      if (hitX && String(hitX.profile_id) !== String(actor.profileId) && String(hitX.status) === 'active') {
        return { message: '该 XUID 已绑定其他角色，无法申请' };
      }
      const byProfile = await ctx.db.query<Row>(
        `SELECT xuid, status FROM ${table} WHERE profile_id = ${ph(0)}`,
        [actor.profileId],
      );
      const hitP = byProfile[0];
      if (hitP && String(hitP.xuid) !== xuid && String(hitP.status) === 'active') {
        return { message: '本角色已绑定其他 XUID，请先解绑' };
      }
      // 进到这里：要么全新，要么只是挪动 pending（申请在被观测前可反悔/改主意）
      if (hitP && String(hitP.xuid) !== xuid) {
        await ctx.db.run(`DELETE FROM ${table} WHERE profile_id = ${ph(0)}`, [actor.profileId]);
      }
      if (hitX && String(hitX.status) === 'pending') {
        await ctx.db.run(
          `UPDATE ${table} SET profile_id = ${ph(0)}, profile_name = ${ph(1)}, user_id = ${ph(2)}, bound_at = ${ph(3)} WHERE xuid = ${ph(4)} AND status = 'pending'`,
          [actor.profileId, actor.profileName ?? '', actor.userId, new Date().toISOString(), xuid],
        );
      } else if (!hitX) {
        await ctx.db.run(
          `INSERT INTO ${table} (xuid, profile_id, profile_name, user_id, status, bound_at)
           VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, ${ph(3)}, 'pending', ${ph(4)})`,
          [xuid, actor.profileId, actor.profileName ?? '', actor.userId, new Date().toISOString()],
        );
      }
      ctx.logger.info('收到申请（待进服签发）', { xuid, profileId: actor.profileId });
      return { message: '申请已记录：重新进入基岩服务器的那一刻自动签发生效' };
    },

    async revoke(actor: PluginBindingActor & { bindingId: string }) {
      await ctx.db.run(
        `DELETE FROM ${table} WHERE profile_id = ${ph(0)} AND xuid = ${ph(1)}`,
        [actor.profileId, actor.bindingId],
      );
      ctx.logger.info('网页侧解绑完成', { userId: actor.userId, bindingId: actor.bindingId });
    },
  });

  // ---- 机器回调：伴生插件 → 本站 ----

  ctx.hook({ method: 'POST', path: '/lookup', auth: 'hmac' }, async (req, res) => {
    const xuid = String(req.body['xuid'] ?? '').trim();
    if (!XUID_PATTERN.test(xuid)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xuid 必须是一串十进制数字' });
      return;
    }
    const rows = await ctx.db.query<Row>(
      `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at, server FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    const row = rows[0];
    if (!row) {
      res.json({ bound: false, pending: false });
      return;
    }
    res.json(rowOut(row));
  });

  // 进服观测 = 持有证明：pending 在这里翻成 active，并记录实测昵称与观测到它的服务器名
  ctx.hook({ method: 'POST', path: '/confirm', auth: 'hmac' }, async (req, res) => {
    const xuid = String(req.body['xuid'] ?? '').trim();
    const gamertag = String(req.body['gamertag'] ?? '').trim();
    const server = String(req.body['server'] ?? '').trim().slice(0, 64);
    if (!XUID_PATTERN.test(xuid)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xuid 必须是一串十进制数字' });
      return;
    }
    const rows = await ctx.db.query<Row>(
      `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at, server FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    const row = rows[0];
    if (!row) {
      res.json({ bound: false, pending: false });
      return;
    }
    if (String(row.status) === 'pending') {
      await ctx.db.run(
        `UPDATE ${table} SET status = 'active', gamertag = ${ph(0)}, server = ${ph(1)}, bound_at = ${ph(2)} WHERE xuid = ${ph(3)} AND status = 'pending'`,
        [gamertag, server, new Date().toISOString(), xuid],
      );
      ctx.logger.info('进服观测，签证签发', { xuid, profileId: String(row.profile_id), gamertag, server });
      const fresh = await ctx.db.query<Row>(
        `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at, server FROM ${table} WHERE xuid = ${ph(0)}`,
        [xuid],
      );
      res.json({ ...rowOut(fresh[0] ?? row), justIssued: true });
      return;
    }
    // 已生效但老记录没存过服务器名：补记一次，让「在哪台服的持有证明」可追溯
    if (server !== '' && (row.server === null || row.server === undefined || row.server === '')) {
      await ctx.db.run(`UPDATE ${table} SET server = ${ph(0)} WHERE xuid = ${ph(1)} AND (server IS NULL OR server = '')`, [server, xuid]);
      row.server = server; // 响应要反映补记后的状态，而不是补记前读到的旧行
    }
    res.json({ ...rowOut(row), justIssued: false });
  });

  // Java 侧准入：验「签证是否真实存在」—— textures property 必须由本站私钥签出，且身份自洽
  ctx.hook({ method: 'POST', path: '/verify', auth: 'hmac' }, async (req, res) => {
    const name = String(req.body['name'] ?? '').trim();
    const value = String(req.body['value'] ?? '');
    const signature = String(req.body['signature'] ?? '');
    if (name === '' || value === '' || signature === '') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'name / value / signature 都必填' });
      return;
    }
    const publicKeyPem = await ctx.site.publicKeyPem();
    if (!publicKeyPem) {
      res.status(503).json({ error: 'CONFIG_ERROR', message: '站点尚未生成 Yggdrasil 密钥' });
      return;
    }
    let payload: { profileId?: string; profileName?: string };
    try {
      const ok = createVerify('RSA-SHA1')
        .update(value, 'utf8')
        .verify(publicKeyPem, signature, 'base64');
      if (!ok) {
        res.json({ ok: false, reason: 'bad_signature' });
        return;
      }
      payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as typeof payload;
    } catch (err) {
      res.json({ ok: false, reason: `malformed_property: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (payload.profileName !== name) {
      res.json({ ok: false, reason: 'name_mismatch' });
      return;
    }
    res.json({ ok: true, profileId: payload.profileId ?? null });
  });
  // 皮肤推送取数：伴生插件按 XUID 拿绑定角色的签名 textures property（SKIN/CAPE URL 在其中）
  ctx.hook({ method: 'POST', path: '/skin', auth: 'hmac' }, async (req, res) => {
    // 入口二：按 profileId 直取（HMAC 已证明请求方是配了密钥的服务器）——
    // 伴生插件用它给基岩观众补 Java 站点玩家的皮肤（注入器改写 URL 后 Geyser 自己拉不到原图）
    const wanted = String(req.body['profileId'] ?? '').trim();
    if (wanted !== '') {
      const dashed = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)
        ? wanted
        : /^[0-9a-f]{32}$/i.test(wanted)
          ? `${wanted.slice(0, 8)}-${wanted.slice(8, 12)}-${wanted.slice(12, 16)}-${wanted.slice(16, 20)}-${wanted.slice(20)}`
          : null;
      if (!dashed) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'profileId 必须是 UUID' });
        return;
      }
      const property = await ctx.textures.buildProperty(dashed);
      if (!property) {
        res.json({ bound: false });
        return;
      }
      let profileName = '';
      try {
        const payload = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8')) as {
          profileName?: string;
        };
        profileName = String(payload.profileName ?? '');
      } catch {
        /* 名字只是日志装饰，拿不到不拦 */
      }
      res.json({ bound: true, profileId: dashed, profileName, textures: property });
      return;
    }
    const xuid = String(req.body['xuid'] ?? '').trim();
    if (!XUID_PATTERN.test(xuid)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xuid 必须是一串十进制数字' });
      return;
    }
    const rows = await ctx.db.query<Row>(
      `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at, server FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    const row = rows[0];
    if (!row || String(row.status) !== 'active') {
      res.json({ bound: false });
      return;
    }
    const property = await ctx.textures.buildProperty(String(row.profile_id));
    res.json({
      bound: true,
      profileId: String(row.profile_id),
      profileName: String(row.profile_name),
      textures: property,
    });
  });
};

export default setup;

/**
 * bedrock_link —— MCSkinToServer 官方插件：基岩版身份绑定（站点侧）v2「签证」模型。
 *
 * 对练规则：本文件**只依赖 `plugin-api.d.ts` 与开发指南**，不读 MCSTS 源码。
 *
 * 签证的两条证据链：
 * - **意愿**：玩家在站点（已登录）对自己的角色提交 XUID 申请 → 状态 pending；
 * - **持有**：Floodgate 对 Xbox 会话实测的 XUID 出现在进服瞬间（在线服不可伪造），
 *   伴生插件调 /hooks/confirm → 站点把该申请签发为 active。
 * 两条齐了才生效；玩家全程零命令。码制（issue→/hooks/bind）作为严格模式保留（BIND_MODE）。
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
};

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
       bound_at     TEXT NOT NULL
     )`,
  );

  const mode = async (): Promise<'claim' | 'code' | 'both'> => {
    const raw = String((await ctx.settings.get('BIND_MODE')) ?? 'claim').trim().toLowerCase();
    return raw === 'code' || raw === 'both' ? raw : 'claim';
  };
  const ttlMinutes = async (): Promise<number> => {
    const raw = Number((await ctx.settings.get('CODE_TTL_MINUTES')) ?? 5);
    if (!Number.isFinite(raw)) return 5;
    return Math.min(Math.max(Math.round(raw), 1), 60);
  };
  const rowOut = (r: Row) => ({
    bound: true,
    status: String(r.status),
    profileId: String(r.profile_id),
    profileName: String(r.profile_name),
    gamertag: r.gamertag === null || r.gamertag === undefined ? null : String(r.gamertag),
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
  ctx.events.on('account.purged', async (payload) => {
    for (const profileId of payload.profileIds) {
      await ctx.db.run(`DELETE FROM ${table} WHERE profile_id = ${ph(0)}`, [profileId]);
    }
  });

  // ---- 账号设置区的通用绑定页 ----
  ctx.binding({
    async list(actor: PluginBindingActor) {
      const rows = await ctx.db.query<Row>(
        `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at FROM ${table} WHERE profile_id = ${ph(0)}`,
        [actor.profileId],
      );
      const m = await mode();
      const joinAddress = String((await ctx.settings.get('JOIN_ADDRESS')) ?? '').trim();
      const fields = (r: Row) => {
        const list = [
          { label: 'XUID', value: String(r.xuid) },
          { label: '角色', value: String(r.profile_name) },
        ];
        if (r.gamertag !== null && r.gamertag !== undefined) {
          list.push({ label: '签发时昵称', value: String(r.gamertag) });
        }
        return list;
      };
      const claimHintText =
        joinAddress !== ''
          ? `用基岩版加入服务器 ${joinAddress}；被拦下的屏幕会显示你的 XUID，填入输入框提交申请，重新进服的那一刻签发。`
          : '进服被拦时屏幕会显示你的 XUID，填入输入框提交申请，重新进服的那一刻签发。';
      return {
        bindings: rows.map((r) => ({
          id: String(r.xuid),
          fields: fields(r),
          boundAt: String(r.bound_at),
          status: (r.status === 'pending' ? 'pending' : 'active') as 'pending' | 'active',
        })),
        instructions:
          m === 'code'
            ? '点「生成绑定码」，进基岩服输入 /bedrock link <码> 完成绑定。'
            : claimHintText,
      };
    },

    async claim(actor: PluginBindingActor & { value: string }) {
      if ((await mode()) === 'code') return { message: '本站点当前只开启了一次性码模式' };
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

    async issue(actor: PluginBindingActor) {
      if ((await mode()) === 'claim') throw new Error('本站点当前只开启了申请制，请刷新页面使用 XUID 申请');
      const issued = await ctx.tokens.issue({
        subject: String(actor.profileId),
        ttlMs: (await ttlMinutes()) * 60_000,
        data: { by: actor.userId, profileName: actor.profileName ?? '' },
      });
      return { code: issued.token, expiresAt: issued.expiresAt };
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
      `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    const row = rows[0];
    if (!row) {
      res.json({ bound: false, pending: false });
      return;
    }
    res.json(rowOut(row));
  });

  // 进服观测 = 持有证明：pending 在这里翻成 active，并记录实测昵称
  ctx.hook({ method: 'POST', path: '/confirm', auth: 'hmac' }, async (req, res) => {
    const xuid = String(req.body['xuid'] ?? '').trim();
    const gamertag = String(req.body['gamertag'] ?? '').trim();
    if (!XUID_PATTERN.test(xuid)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xuid 必须是一串十进制数字' });
      return;
    }
    const rows = await ctx.db.query<Row>(
      `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    const row = rows[0];
    if (!row) {
      res.json({ bound: false, pending: false });
      return;
    }
    if (String(row.status) === 'pending') {
      await ctx.db.run(
        `UPDATE ${table} SET status = 'active', gamertag = ${ph(0)}, bound_at = ${ph(1)} WHERE xuid = ${ph(2)} AND status = 'pending'`,
        [gamertag, new Date().toISOString(), xuid],
      );
      ctx.logger.info('进服观测，签证签发', { xuid, profileId: String(row.profile_id), gamertag });
      const fresh = await ctx.db.query<Row>(
        `SELECT xuid, profile_id, profile_name, gamertag, status, bound_at FROM ${table} WHERE xuid = ${ph(0)}`,
        [xuid],
      );
      res.json({ ...rowOut(fresh[0] ?? row), justIssued: true });
      return;
    }
    res.json({ ...rowOut(row), justIssued: false });
  });

  // 码制：玩家码（意愿）+ 实测 XUID（持有）当场双证据签发
  ctx.hook({ method: 'POST', path: '/bind', auth: 'hmac' }, async (req, res) => {
    if ((await mode()) === 'claim') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '本站点未开启一次性码模式' });
      return;
    }
    const token = String(req.body['token'] ?? '').trim().toUpperCase();
    const xuid = String(req.body['xuid'] ?? '').trim();
    const gamertag = String(req.body['gamertag'] ?? '').trim();
    if (!XUID_PATTERN.test(xuid)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xuid 必须是一串十进制数字（Floodgate 实测值）' });
      return;
    }
    const consumed = await ctx.tokens.consume(token);
    if (!consumed) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '绑定码无效、已过期或已被使用' });
      return;
    }
    const profileId = consumed.subject;
    const profileName = String(consumed.data['profileName'] ?? '');
    const byProfile = await ctx.db.query<Row>(
      `SELECT xuid, status FROM ${table} WHERE profile_id = ${ph(0)}`,
      [profileId],
    );
    if (byProfile.length > 0 && String(byProfile[0]!['xuid']) !== xuid) {
      ctx.logger.warn('绑定冲突：角色已绑定另一个 XUID', { profileId, old: String(byProfile[0]!['xuid']), new: xuid });
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '该角色已绑定另一个基岩身份，请先在站点解绑' });
      return;
    }
    const byXuid = await ctx.db.query<Row>(
      `SELECT profile_id, status FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    if (byXuid.length > 0 && String(byXuid[0]!['profile_id']) !== profileId) {
      ctx.logger.warn('绑定冲突：XUID 已绑另一个角色', { xuid, old: String(byXuid[0]!['profile_id']), new: profileId });
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '该基岩身份已绑定另一个角色，请先在站点解绑' });
      return;
    }
    await ctx.db.run(
      `INSERT INTO ${table} (xuid, profile_id, profile_name, user_id, gamertag, status, bound_at)
       VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, 'active', ${ph(5)})
       ON CONFLICT (xuid) DO UPDATE SET
         profile_id = excluded.profile_id,
         profile_name = excluded.profile_name,
         gamertag = excluded.gamertag,
         status = 'active',
         bound_at = excluded.bound_at`,
      [xuid, profileId, profileName, String(consumed.data['by'] ?? ''), gamertag, new Date().toISOString()],
    );
    ctx.logger.info('码制签发完成', { profileId, xuid });
    res.json({ bound: true, status: 'active', profileId, profileName, xuid });
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
};

export default setup;

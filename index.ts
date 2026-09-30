/**
 * bedrock_link —— MCSkinToServer 的官方第一个插件：基岩版身份绑定（站点侧）。
 *
 * 对练规则：本文件**只依赖 `plugin-api.d.ts` 与开发指南**，不读 MCSTS 源码。
 * 如果哪个细节必须翻了核心实现才能确定，那就是接口缺口，要补的是接口。
 *
 * 双证据（缺一不可，见指南 §7）：
 * 1. 玩家授权 —— 他在站点账号设置区（已登录）点「生成绑定码」，拿到一次性短码；
 * 2. 服务器实测 —— 他到基岩服输码，伴生插件从 Floodgate 取该连接的真实 XUID，
 *    带 HMAC 签名回调 /hooks/bind。
 * 两者同时成立才写绑定。
 */
import type {
  PluginBindingActor,
  PluginContext,
  PluginSetup,
} from './plugin-api.js';

/** Floodgate 实测的 XUID 是一串十进制数字；形态不对一律当伪造拒掉 */
const XUID_PATTERN = /^\d{1,21}$/;

const setup: PluginSetup = async (ctx: PluginContext) => {
  const table = ctx.table('bindings');
  const ph = (i: number): string => (ctx.db.dialect === 'postgres' ? `$${i + 1}` : '?');

  await ctx.db.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (
       profile_id   TEXT PRIMARY KEY,
       xuid         TEXT NOT NULL UNIQUE,
       profile_name TEXT NOT NULL,
       user_id      TEXT NOT NULL,
       bound_at     TEXT NOT NULL
     )`,
  );

  // ---- 生命周期跟随：绑定存角色 UUID，名字只是展示副本 ----
  // 角色有 30 天改名冷却与名称池，存名字当键会让改名静默打断绑定（指南 §7）。
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

  const rowsOfProfile = (profileId: string) =>
    ctx.db.query<{ xuid: unknown; profile_name: unknown; bound_at: unknown }>(
      `SELECT xuid, profile_name, bound_at FROM ${table} WHERE profile_id = ${ph(0)}`,
      [profileId],
    );

  const ttlMinutes = async (): Promise<number> => {
    const raw = Number((await ctx.settings.get('CODE_TTL_MINUTES')) ?? 5);
    if (!Number.isFinite(raw)) return 5;
    return Math.min(Math.max(Math.round(raw), 1), 60);
  };

  // ---- 账号设置区的通用绑定页（ctx.binding）----
  ctx.binding({
    // 核心已经验过 actor.profileId 属于当前登录账号，这里只按角色取数
    async list(actor: PluginBindingActor) {
      const rows = await rowsOfProfile(String(actor.profileId));
      const joinAddress = String((await ctx.settings.get('JOIN_ADDRESS')) ?? '').trim();
      return {
        bindings: rows.map((r) => ({
          id: String(r.xuid),
          fields: [
            { label: 'XUID', value: String(r.xuid) },
            { label: '角色', value: String(r.profile_name) },
          ],
          boundAt: String(r.bound_at),
        })),
        instructions:
          (joinAddress ? `用基岩版加入服务器 ${joinAddress}，` : '进入基岩服务器后，') +
          '输入 /bedrock link {{code}}；' +
          '服务器会把它实测到的 XUID 回报站点完成绑定。',
      };
    },

    async issue(actor: PluginBindingActor) {
      const profileId = String(actor.profileId);
      // 名字随令牌带过去：/hooks/bind 只有 profileId，没有核心仓储可查名字，
      // 而伴生插件的 GameProfile 需要一个当前名字 —— issue 是唯一同时手握两者的时刻
      const issued = await ctx.tokens.issue({
        subject: profileId,
        ttlMs: (await ttlMinutes()) * 60_000,
        data: { by: actor.userId, profileName: actor.profileName ?? '' },
      });
      return { code: issued.token, expiresAt: issued.expiresAt };
    },

    async revoke(actor: PluginBindingActor & { bindingId: string }) {
      // 只允许玩家本人从网页侧解绑（服务器侧不许单方面解绑）；
      // profileId + xuid 双条件，跨角色的句柄猜不出别人的行
      await ctx.db.run(
        `DELETE FROM ${table} WHERE profile_id = ${ph(0)} AND xuid = ${ph(1)}`,
        [actor.profileId, actor.bindingId],
      );
      ctx.logger.info('网页侧解绑完成', { userId: actor.userId, bindingId: actor.bindingId });
    },
  });

  // ---- 机器回调：伴生插件 → 本站 ----

  ctx.hook({ method: 'POST', path: '/bind', auth: 'hmac' }, async (req, res) => {
    const token = String(req.body['token'] ?? '').trim().toUpperCase();
    const xuid = String(req.body['xuid'] ?? '').trim();
    if (!XUID_PATTERN.test(xuid)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xuid 必须是一串十进制数字（Floodgate 实测值）' });
      return;
    }
    // consume 的判定全在数据库的原子语句里：同一枚码并发提交也只有一次能赢
    const consumed = await ctx.tokens.consume(token);
    if (!consumed) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '绑定码无效、已过期或已被使用' });
      return;
    }
    const profileId = consumed.subject;
    const profileName = String(consumed.data['profileName'] ?? '');

    // 双向唯一：一个 XUID 只绑一个角色、一个角色只绑一个 XUID。
    // 历史数据已冲突时**不任选一条**，一律拒绝并记日志（指南 §7）。
    const byProfile = await ctx.db.query<{ xuid: unknown }>(
      `SELECT xuid FROM ${table} WHERE profile_id = ${ph(0)}`,
      [profileId],
    );
    if (byProfile.length > 0 && String(byProfile[0]!['xuid']) !== xuid) {
      ctx.logger.warn('绑定冲突：角色已绑另一个 XUID', { profileId, old: String(byProfile[0]!['xuid']), new: xuid });
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '该角色已绑定另一个基岩身份，请先在站点解绑' });
      return;
    }
    const byXuid = await ctx.db.query<{ profile_id: unknown }>(
      `SELECT profile_id FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    if (byXuid.length > 0 && String(byXuid[0]!['profile_id']) !== profileId) {
      ctx.logger.warn('绑定冲突：XUID 已绑另一个角色', { xuid, old: String(byXuid[0]!['profile_id']), new: profileId });
      res.status(400).json({ error: 'VALIDATION_ERROR', message: '该基岩身份已绑定另一个角色，请先在站点解绑' });
      return;
    }

    await ctx.db.run(
      `INSERT INTO ${table} (profile_id, xuid, profile_name, user_id, bound_at)
       VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})
       ON CONFLICT (profile_id) DO UPDATE SET
         xuid = excluded.xuid,
         profile_name = excluded.profile_name,
         bound_at = excluded.bound_at`,
      [profileId, xuid, profileName, String(consumed.data['by'] ?? ''), new Date().toISOString()],
    );
    ctx.logger.info('绑定完成', { profileId, xuid });
    res.json({ ok: true, profileId, xuid });
  });

  ctx.hook({ method: 'POST', path: '/lookup', auth: 'hmac' }, async (req, res) => {
    const xuid = String(req.body['xuid'] ?? '').trim();
    if (!XUID_PATTERN.test(xuid)) {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'xuid 必须是一串十进制数字' });
      return;
    }
    const rows = await ctx.db.query<{ profile_id: unknown; profile_name: unknown }>(
      `SELECT profile_id, profile_name FROM ${table} WHERE xuid = ${ph(0)}`,
      [xuid],
    );
    const row = rows[0];
    if (!row) {
      res.json({ bound: false });
      return;
    }
    res.json({ bound: true, profileId: String(row.profile_id), profileName: String(row.profile_name) });
  });
};

export default setup;

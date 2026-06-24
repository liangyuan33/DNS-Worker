import { Env, ExecutionContext } from "../types";
import { BloomFilter } from "./bloom";
import { fetchListContent } from "./listFetcher";
import { pipelineCache } from "../pipeline/cache";
import { ProfileModel } from "../models/profile";
import { ListModel } from "../models/list";
import { ProfileBloomModel } from "../models/profileBloom";

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 单个列表的字节数上限（5 MB）。超出后软截断，已读部分仍可使用。 */
const MAX_LIST_BYTES = 5 * 1024 * 1024;

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

/**
 * 将 staging Bloom 原子升级为 active，并清除该 profile 的 DNS 内存缓存。
 *
 * 此操作标志着一个同步周期的正式结束：
 *   1. `promoteStagingToActive` 在单次 db.batch 中完成 active 替换与 staging 清理。
 *   2. 更新 `profile.list_updated_at` 为当前时间，使该 profile 退出同步队列。
 *   3. 异步清除 DNS 管道层的内存缓存，令新规则立即对后续查询生效。
 */
async function promoteAndFinalize(
  profileId: string,
  bloomModel: ProfileBloomModel,
  profileModel: ProfileModel,
  ctx: ExecutionContext,
  now: number
): Promise<void> {
  await bloomModel.promoteStagingToActive(profileId, now);
  await profileModel.updateListUpdatedAt(profileId, now);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(pipelineCache.clear(profileId));
  }
}

/**
 * 将域名数组增量写入 staging Bloom Filter 并持久化到 D1。
 *
 * 读取现有 staging → add 域名 → 序列化写回，
 * active Bloom 在此过程中保持不变。
 *
 * @returns 实际写入的域名数量；staging 不存在时返回 -1
 */
async function accumulateDomainsToStaging(
  profileId: string,
  domains: string[],
  maxListDomains: number,
  bloomModel: ProfileBloomModel,
  now: number
): Promise<number> {
  const stagingBuffer = await bloomModel.getStagingBloom(profileId);
  if (!stagingBuffer) return -1;

  const bloom = BloomFilter.fromUint8Array(new Uint8Array(stagingBuffer));

  const effectiveDomains =
    domains.length > maxListDomains ? domains.slice(0, maxListDomains) : domains;

  if (effectiveDomains.length < domains.length) {
    console.warn(
      `[Sync] Domain list truncated to ${maxListDomains} (was ${domains.length}).`
    );
  }

  effectiveDomains.forEach((d) => bloom.add(d));

  const binary = bloom.toUint8Array();
  await bloomModel.upsertStagingBloom(profileId, binary.buffer as ArrayBuffer, now);

  return effectiveDomains.length;
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 【Cron 专用】每次触发时处理**单个**最旧的订阅列表，
 * 将域名增量累积到 staging Bloom Filter 中。
 *
 * ## A/B 升级策略
 *
 * - **staging** (`profile_blooms_staging`)：构建中的 Bloom Filter，
 *   仅在此函数内写入，DNS 查询路径不可见。
 * - **active** (`profile_blooms`)：已完成周期的 Bloom Filter，
 *   是 DNS 查询的唯一数据来源，始终处于一致状态。
 * - **原子升级**：当所有列表处理完毕后，通过 `promoteStagingToActive`
 *   一次性替换，不存在中间态。
 *
 * ## 周期管理
 *
 * 1. **新周期检测**：若所有列表的 `last_synced_at` 均 ≤ `list_updated_at`，
 *    说明本周期尚未开始，清空 staging 并预分配新的空白 Bloom。
 * 2. **单列表处理**：从待处理列表中选最旧的一条，拉取 → 解析 → 累积。
 * 3. **周期结束**：所有列表完成后，staging 升级为 active，缓存失效。
 *
 * @param profileId - 需要同步的 Profile ID
 * @param env - Worker 环境变量
 * @param ctx - 执行上下文
 */
export async function syncNextListForProfile(
  profileId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const profileModel = new ProfileModel(env.DB);
  const listModel = new ListModel(env.DB);
  const bloomModel = new ProfileBloomModel(env.DB);
  const now = Math.floor(Date.now() / 1000);

  try {
    const profile = await profileModel.getById(profileId);
    if (!profile) {
      console.error(`[Sync] Profile ${profileId} not found.`);
      return;
    }

    const lastFullSync: number = profile.list_updated_at ?? 0;
    const lists = await listModel.getLists(profileId);

    if (lists.length === 0) {
      await bloomModel.clearStagingBloom(profileId);
      await bloomModel.clearProfileBlooms(profileId);
      await profileModel.updateListUpdatedAt(profileId, now);
      return;
    }

    // ── 新周期检测 ────────────────────────────────────────────────────────────
    const isNewCycle = !lists.some((l) => (l.last_synced_at ?? 0) > lastFullSync);

    if (isNewCycle) {
      const maxDomains = Number(env.MAX_SYNC_DOMAINS) || 500000;
      const falsePositiveRate = Number(env.BLOOM_FALSE_POSITIVE_RATE) || 0.0001;
      await bloomModel.initializeStagingBloom(profileId, maxDomains, falsePositiveRate, now);
      console.log(
        `[Sync] Profile ${profileId}: new cycle — staging initialized ` +
          `(maxDomains=${maxDomains}, p=${falsePositiveRate}).`
      );
    }

    // ── 选取下一个待同步列表 ──────────────────────────────────────────────────
    const pendingLists = lists
      .filter((l) => (l.last_synced_at ?? 0) <= lastFullSync)
      .sort((a, b) => (a.last_synced_at ?? 0) - (b.last_synced_at ?? 0));

    if (pendingLists.length === 0) {
      // Edge case：逻辑重入，所有列表已完成
      await promoteAndFinalize(profileId, bloomModel, profileModel, ctx, now);
      return;
    }

    // ── 拉取并累积单个列表 ────────────────────────────────────────────────────
    const list = pendingLists[0];
    const timeoutMs = Number(env.SYNC_TIMEOUT_MS) || 30000;

    const { domains, error: fetchError } = await fetchListContent(
      list.url,
      MAX_LIST_BYTES,
      timeoutMs
    );

    let success = false;
    let syncError: string | null = fetchError;

    if (!fetchError) {
      const maxListDomains = Number(env.MAX_LIST_DOMAINS) || 150000;
      const written = await accumulateDomainsToStaging(
        profileId,
        domains,
        maxListDomains,
        bloomModel,
        now
      );

      if (written === -1) {
        syncError = "Staging Bloom not initialized — possible new-cycle detection miss";
        console.error(`[Sync] Profile ${profileId}: staging bloom missing.`);
      } else {
        console.log(
          `[Sync] Profile ${profileId}: added ${written} domains ` +
            `from list #${list.id} (${pendingLists.length - 1} remaining).`
        );
        success = true;
      }
    }

    await listModel.updateListSyncStatus(list.id, now, success ? 1 : 0, syncError);

    // ── 检查本周期是否全部完成 ────────────────────────────────────────────────
    const updatedLists = await listModel.getLists(profileId);
    const allDone = updatedLists.every((l) => (l.last_synced_at ?? 0) > lastFullSync);

    if (allDone) {
      await promoteAndFinalize(profileId, bloomModel, profileModel, ctx, now);
      console.log(
        `[Sync] Profile ${profileId}: all ${updatedLists.length} list(s) synced — ` +
          `staging promoted to active.`
      );
    } else {
      const remaining = updatedLists.filter(
        (l) => (l.last_synced_at ?? 0) <= lastFullSync
      ).length;
      console.log(`[Sync] Profile ${profileId}: ${remaining} list(s) remaining in this cycle.`);
    }
  } catch (e) {
    console.error(`[Sync] Critical failure for Profile ${profileId}:`, e);
    // 防止单个失败导致该 profile 永久阻塞
    await profileModel.updateListUpdatedAt(profileId, now);
  }
}

/**
 * 【手动触发】一次性同步 profile 下所有订阅列表。
 *
 * 用于用户主动操作（添加列表、删除列表、点击「立即同步」），
 * 不受 cron CPU 预算约束。同样遵循 A/B 模式：
 * 所有列表写入 staging 后统一升级为 active。
 *
 * @param profileId - 需要同步的 Profile ID
 * @param env - Worker 环境变量
 * @param ctx - 执行上下文
 */
export async function syncProfileLists(
  profileId: string,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const profileModel = new ProfileModel(env.DB);
  const listModel = new ListModel(env.DB);
  const bloomModel = new ProfileBloomModel(env.DB);
  const now = Math.floor(Date.now() / 1000);

  try {
    const lists = await listModel.getLists(profileId);

    if (lists.length === 0) {
      await bloomModel.clearStagingBloom(profileId);
      await bloomModel.clearProfileBlooms(profileId);
      await profileModel.updateListUpdatedAt(profileId, now);
      return;
    }

    // 初始化 staging（覆盖任何进行中的 cron 周期）
    const maxDomains = Number(env.MAX_SYNC_DOMAINS) || 500000;
    const falsePositiveRate = Number(env.BLOOM_FALSE_POSITIVE_RATE) || 0.0001;
    await bloomModel.initializeStagingBloom(profileId, maxDomains, falsePositiveRate, now);

    const timeoutMs = Number(env.SYNC_TIMEOUT_MS) || 30000;
    const maxListDomains = Number(env.MAX_LIST_DOMAINS) || 150000;

    for (const list of lists) {
      const { domains, error: fetchError } = await fetchListContent(
        list.url,
        MAX_LIST_BYTES,
        timeoutMs
      );

      let success = false;
      let syncError: string | null = fetchError;

      if (!fetchError) {
        const written = await accumulateDomainsToStaging(
          profileId,
          domains,
          maxListDomains,
          bloomModel,
          now
        );
        success = written !== -1;
        if (!success) syncError = "Staging Bloom missing during manual sync";
      }

      await listModel.updateListSyncStatus(list.id, now, success ? 1 : 0, syncError);
    }

    // 全部列表处理完毕 → 升级 staging → active
    await promoteAndFinalize(profileId, bloomModel, profileModel, ctx, now);
    console.log(`[Sync] Manual sync for Profile ${profileId}: staging promoted to active.`);
  } catch (e) {
    console.error(`[Sync] Manual sync critical failure for Profile ${profileId}:`, e);
  } finally {
    await profileModel.updateListUpdatedAt(profileId, now);
  }
}

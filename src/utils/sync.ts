import { Env, List, ExecutionContext } from "../types";
import { parseList } from "./parser";
import { BloomFilter } from "./bloom";
import { pipelineCache } from "../pipeline/cache";

/**
 * 同步并更新 Profile 关联的规则列表，生成布隆过滤器。
 * 
 * 该函数会拉取所有启用的订阅列表，合并并解析其中的域名，
 * 然后生成高精度的布隆过滤器二进制数据存储在 D1 (profile_blooms 表) 中。
 * 
 * @param profileId - 需要同步的目标 Profile 的 ID
 * @param env - Worker 环境变量，包含 D1 数据库实例等
 * @param ctx - 执行上下文，用于在后台执行缓存清理等异步操作
 */
export async function syncProfileLists(profileId: string, env: Env, ctx: ExecutionContext): Promise<void> {
  const { results: lists } = await env.DB.prepare("SELECT id, url FROM lists WHERE profile_id = ?").bind(profileId).all<List>();
  
  const now = Math.floor(Date.now() / 1000);

  if (lists.length === 0) {
    // 如果当前 Profile 没有配置任何订阅列表，则清理旧的布隆过滤器数据
    await env.DB.prepare("DELETE FROM profile_blooms WHERE profile_id = ?").bind(profileId).run();
    // 更新配置的同步时间，防止被 Cron 定时任务重复选中
    await env.DB.prepare("UPDATE profiles SET list_updated_at = ? WHERE id = ?").bind(now, profileId).run();
    return;
  }
  const allDomains = new Set<string>();

  // 逐个拉取所有列表的最新的规则文件
  for (const list of lists) {
    let success = false;
    try {
      const response = await fetch(list.url, { signal: AbortSignal.timeout(30000) });
      if (response.ok) {
        const domains = parseList(await response.text());
        if (domains.length > 0) {
          domains.forEach(d => allDomains.add(d));
          success = true;
        }
      }
    } catch (e) {
      console.error(`[Sync] Failed to fetch ${list.url}:`, e);
    }

    // 单个列表拉取完毕后更新其同步时间和可用状态
    await env.DB.prepare("UPDATE lists SET last_synced_at = ?, enabled = ? WHERE id = ?").bind(now, success ? 1 : 0, list.id).run();
  }

  const domainArray = Array.from(allDomains);

  if (domainArray.length > 0) {
    // 根据提取到的所有拦截域名，构建假阳性率为 0.1% 的高精度布隆过滤器
    const falsePositiveRate = 0.001;
    const bloom = BloomFilter.create(domainArray.length, falsePositiveRate);
    domainArray.forEach(d => bloom.add(d));
    const binary = bloom.toUint8Array();

    // 将序列化后的布隆过滤器二进制数据存储到 D1 数据库中
    await env.DB.prepare(
      "INSERT INTO profile_blooms (profile_id, bloom_filter, updated_at) VALUES (?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET bloom_filter = excluded.bloom_filter, updated_at = excluded.updated_at"
    ).bind(profileId, binary.buffer, now).run();

    // 通知缓存层异步清除此 Profile 的相关解析缓存，以使新规则立刻生效
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(pipelineCache.clear(profileId));
    }

    console.log(`[Sync] Profile ${profileId}: ${domainArray.length} domains synced to D1.`);
  }

  // 更新整个 Profile 级别的最后同步时间，作为 Cron 定时同步任务的判断依据
  await env.DB.prepare("UPDATE profiles SET list_updated_at = ? WHERE id = ?").bind(now, profileId).run();
}

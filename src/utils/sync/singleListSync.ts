import { Env } from "../../types";
import { BloomFilter } from "../bloom";
import { fetchListContent } from "../listFetcher";
import { ListModel } from "../../models/list";
import { ListBloomModel } from "../../models/listBloom";

const MAX_LIST_BYTES = 5 * 1024 * 1024;

/**
 * 同步单个订阅列表的通用业务逻辑。
 * 
 * 包含：下载列表内容、截断、构建列表级布隆过滤器、保存至分块表、以及更新同步状态。
 * 
 * @returns 最终的同步错误信息 (若成功则为 null)
 */
export async function syncSingleList(
  profileId: string,
  list: { id: number; url: string },
  env: Env,
  listModel: ListModel,
  listBloomModel: ListBloomModel,
  now: number
): Promise<string | null> {
  const timeoutMs = Number(env.SYNC_TIMEOUT_MS) || 30000;
  const { domains, error: fetchError } = await fetchListContent(
    list.url,
    MAX_LIST_BYTES,
    timeoutMs
  );

  const maxListDomains = Number(env.MAX_LIST_DOMAINS) || 500000;
  const maxDomains = Number(env.MAX_SYNC_DOMAINS) || 1000000;
  const falsePositiveRate = Number(env.BLOOM_FALSE_POSITIVE_RATE) || 0.0001;

  let syncError: string | null = fetchError;

  if (!fetchError) {
    // 创建全局主布隆过滤器
    const listBloom = BloomFilter.create(maxDomains, falsePositiveRate);
    const limit = Math.min(domains.length, maxListDomains);
    if (domains.length > maxListDomains) {
      console.warn(
        `[Sync] Domain list truncated to ${maxListDomains} (was ${domains.length}).`
      );
    }

    // 分块编译：每 100k 个域名为一个分块编译结果，然后合并（OR）到主过滤器中
    const chunkSize = 100000;
    for (let offset = 0; offset < limit; offset += chunkSize) {
      const chunkEnd = Math.min(offset + chunkSize, limit);
      // 创建相当长度/规格的临时布隆块
      const chunkBloom = BloomFilter.create(maxDomains, falsePositiveRate);
      
      for (let i = offset; i < chunkEnd; i++) {
        chunkBloom.add(domains[i]);
      }
      
      // 合众为一 (bitwise OR)
      listBloom.merge(chunkBloom);
      
      // 让出事件循环，释放 CPU 执行时间并给 GC 喘息机会
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // 保存列表布隆过滤器至 D1
    await listBloomModel.upsertListBloom(list.id, listBloom.toUint8Array().buffer as ArrayBuffer, now);
    console.log(
      `[Sync] Profile ${profileId}: successfully updated list #${list.id} with ${limit} domains.`
    );
  } else {
    // 下载/解析失败：跳过，沿用旧数据
    console.warn(
      `[Sync] Profile ${profileId}: failed to fetch list #${list.id}. ` +
        `Skipping and keeping old bloom. Error: ${fetchError}`
    );
  }

  // 写入列表同步状态
  await listModel.updateListSyncStatus(list.id, now, 1, syncError);
  return syncError;
}

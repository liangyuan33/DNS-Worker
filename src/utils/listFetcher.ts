import { isSafeUrl } from "./validator";
import { parseList } from "./parser";

/** 单个列表的拉取结果 */
export interface FetchListResult {
  /** 成功解析的域名列表；失败时为空数组 */
  domains: string[];
  /** 错误信息；成功时为 null */
  error: string | null;
}

/**
 * 拉取单个订阅列表并解析其中的域名。
 *
 * 职责边界：
 * - 仅负责 HTTP 获取、流式读取、大小截断、文本解码和域名解析。
 * - 不涉及数据库操作、Bloom Filter 或同步周期管理。
 *
 * @param url - 订阅列表的 HTTP(S) URL
 * @param maxBytes - 单个列表的字节数上限（软截断，超出后停止读取）
 * @param timeoutMs - 请求超时时间（毫秒）
 * @returns 解析出的域名列表与错误信息
 */
export async function fetchListContent(
  url: string,
  maxBytes: number,
  timeoutMs: number
): Promise<FetchListResult> {
  if (!isSafeUrl(url)) {
    return {
      domains: [],
      error: "Invalid list URL. Private networks and localhosts are not allowed.",
    };
  }

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) {
      return {
        domains: [],
        error: `HTTP error! Status: ${response.status} ${response.statusText}`,
      };
    }

    // 通过 Content-Length 快速拒绝明显超限的列表
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return {
        domains: [],
        error: `List too large (${(parseInt(contentLength, 10) / 1024 / 1024).toFixed(2)} MB), limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { domains: [], error: "Failed to get stream reader from response" };
    }

    // 流式读取，超出上限时软截断（保留已读部分）
    let totalBytes = 0;
    const chunks: Uint8Array[] = [];
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          truncated = true;
          // 移除超出限制的最后一个 chunk，只保留 maxBytes 以内的内容
          totalBytes -= value.length;
          break;
        }
        chunks.push(value);
      }
    }

    if (truncated) {
      console.warn(`[Fetcher] List truncated at ${(maxBytes / 1024 / 1024).toFixed(0)} MB: ${url}`);
    }

    // 合并 chunks → 解码 → 解析域名
    const concatenated = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      concatenated.set(chunk, offset);
      offset += chunk.length;
    }

    const domains = parseList(new TextDecoder().decode(concatenated));

    if (domains.length === 0) {
      return { domains: [], error: "No valid domain rules found in the list" };
    }

    return { domains, error: null };
  } catch (e: any) {
    return { domains: [], error: e.message || String(e) };
  }
}

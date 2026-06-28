function isIpLike(str: string): boolean {
  if (str.includes(':')) return true; // IPv6

  let dotCount = 0;
  const len = str.length;
  if (len < 7 || len > 15) return false;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code === 46) { // '.'
      dotCount++;
    } else if (code < 48 || code > 57) { // not '0'-'9'
      return false;
    }
  }
  return dotCount === 3;
}

export function parseList(content: string): string[] {
  const domains = new Set<string>();
  const len = content.length;
  let start = 0;

  while (start < len) {
    let end = content.indexOf('\n', start);
    if (end === -1) {
      end = len;
    }

    // 手动计算 trim 后的 lineStart 和 lineEnd，避免为空白行、注释行分配临时字符串
    let lineStart = start;
    while (lineStart < end) {
      const code = content.charCodeAt(lineStart);
      if (code === 32 || code === 9 || code === 13 || code === 10) {
        lineStart++;
      } else {
        break;
      }
    }

    let lineEnd = end;
    while (lineEnd > lineStart) {
      const code = content.charCodeAt(lineEnd - 1);
      if (code === 32 || code === 9 || code === 13 || code === 10) {
        lineEnd--;
      } else {
        break;
      }
    }

    start = end + 1;

    // 空行直接跳过
    if (lineStart >= lineEnd) {
      continue;
    }

    // 直接在原大文本上利用字符编码匹配注释行，避免创建 String 实例和 GC 压力
    const firstChar = content.charCodeAt(lineStart);
    if (firstChar === 33 || firstChar === 35) { // '!' 或 '#'
      continue;
    }
    if (firstChar === 64 && lineStart + 1 < lineEnd && content.charCodeAt(lineStart + 1) === 64) { // '@@'
      continue;
    }

    // 此时确认为有效行规则，仅提取这部分子串
    const line = content.substring(lineStart, lineEnd);

    // AdGuard 广告过滤规则格式 (如: ||example.com^$all)
    if (line.startsWith('||')) {
      let domain = line.substring(2);
      const caretIdx = domain.indexOf('^');
      if (caretIdx !== -1) {
        domain = domain.substring(0, caretIdx);
      }
      const dollarIdx = domain.indexOf('$');
      if (dollarIdx !== -1) {
        domain = domain.substring(0, dollarIdx);
      }
      
      domain = domain.trim().toLowerCase();
      if (domain) domains.add(domain);
      continue;
    }

    // Hosts 规则文件格式 (如: 127.0.0.1 example.com)
    // 快速通道：如果没有空格/制表符，说明就是一个单纯的域名，直接添加以避免进行 split 或 regex 匹配
    let firstSpace = -1;
    const lineLen = line.length;
    for (let i = 0; i < lineLen; i++) {
      const code = line.charCodeAt(i);
      if (code === 32 || code === 9) { // 空格或 Tab
        firstSpace = i;
        break;
      }
    }

    if (firstSpace === -1) {
      domains.add(line.toLowerCase());
    } else {
      const part0 = line.substring(0, firstSpace);
      // 快速跨过连续的空格或 Tab
      let secondStart = firstSpace;
      while (secondStart < lineLen) {
        const code = line.charCodeAt(secondStart);
        if (code === 32 || code === 9) {
          secondStart++;
        } else {
          break;
        }
      }
      
      let part1 = "";
      if (secondStart < lineLen) {
        let secondEnd = secondStart;
        while (secondEnd < lineLen) {
          const code = line.charCodeAt(secondEnd);
          if (code === 32 || code === 9) {
            break;
          }
          secondEnd++;
        }
        part1 = line.substring(secondStart, secondEnd);
      }

      if (part1 !== "") {
        // 如果第一部分是 IP 地址，第二部分则是域名
        if (isIpLike(part0)) {
          const domain = part1.toLowerCase();
          if (domain !== 'localhost' && domain !== '0.0.0.0' && domain !== '127.0.0.1') {
            domains.add(domain);
          }
        } else {
          domains.add(part0.toLowerCase());
        }
      } else {
        domains.add(part0.toLowerCase());
      }
    }
  }

  return Array.from(domains);
}

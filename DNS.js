// ============================================================
// Egern 小组件：DNS 泄露检测 + WebRTC 泄露检测
// 数据源：ip.net.coffee（DNS 泄露页 /dns/ 的检测机制 + 相关 API）
// UI / 排版：参照 IPPure 小组件（仅借鉴布局与视觉风格）
//
// 【DNS 检测原理】（与 ip.net.coffee/dns/ 页面一致）
//   1. 生成随机 token，构造唯一子域名 {token}-1..5.d.ip.net.coffee
//   2. 组件向这些子域名发起 HTTP 请求 → 由"实际处理解析的递归 DNS"
//      （本地运营商 / 透明 DNS 代理 / 代理接管后的 DNS）去查询
//      ip.net.coffee 的自建权威 DNS
//   3. 权威 DNS 记录查询来源 IP（= 解析器出口 IP），按 token 归档
//   4. 组件轮询 /api/dns/result/{token} 取回解析器 IP 列表
//   5. 逐个 /api/geoip/{ip} 查归属地，与出口 IP 比对判定
//
// 【WebRTC 说明】
//   Egern 组件 JS 运行时不提供 RTCPeerConnection / UDP STUN API，
//   因此 WebRTC 真实泄露检测只能在浏览器里做（ip.net.coffee/webrtc）。
//   组件内展示本机局域网 IP 与设备 DNS（WebRTC 泄露会暴露的两类信息）
//   并给出浏览器检测入口。
//
// 【用法】
//   1. Egern → Tools → Scripts → 新建 generic 脚本，粘贴本代码
//   2. 小组件选择该脚本；可选环境变量 GROUP=策略组名称（默认 DIRECT）
//   3. DNS 测试每次约 8~12 秒；若组件频繁超时，可把 ROUNDS 改为 3
// ============================================================

// IP 脱敏：IPv4 后两段按字符数替换为 *；IPv6 只保留前两段
function maskIp(ip) {
  if (!ip || typeof ip !== 'string') return ip;

  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) {
      const p3 = '*'.repeat(parts[2].length);
      const p4 = '*'.repeat(parts[3].length);
      return `${parts[0]}.${parts[1]}.${p3}.${p4}`;
    }
    return ip;
  }

  // IPv6：只保留前两段，后面统一显示 ****:****
  if (ip.includes(':')) {
    const firstColon = ip.indexOf(':');
    if (firstColon === -1) return ip;
    const secondColon = ip.indexOf(':', firstColon + 1);
    if (secondColon === -1) return ip + ':****:****';
    return ip.substring(0, secondColon) + ':****:****';
  }

  return ip;
}

export default async function(ctx) {

  const strategyGroup = ctx.env.GROUP || 'DIRECT';
  const widgetFamily = ctx.widgetFamily || 'systemLarge';

  // ---- 配色（与参照 JS 一致）----
  const C = {
    bgTop: '#0C0D0F',
    bgBottom: '#141619',
    borderColor: 'rgba(255, 255, 255, 0.06)',
    text: '#F8FAFC',
    secondary: '#94A3B8',
    muted: '#64748B',
    blue: '#60A5FA',
    green: '#34D399',
    yellow: '#FACC15',
    // 风险色（绿 → 红渐进）
    risk0: '#22C55E',
    risk1: '#84CC16',
    risk2: '#EAB308',
    risk3: '#F59E0B',
    risk4: '#F97316',
    risk5: '#DC2626',
  };

  const premiumGradient = {
    type: 'linear',
    colors: [C.bgTop, C.bgBottom],
    startPoint: { x: 0.5, y: 0 },
    endPoint: { x: 0.5, y: 1 }
  };

  // ---- 常量 ----
  const CACHE_TTL = 600000;   // 缓存 10 分钟
  const ROUNDS = 5;           // 触发解析轮数（快速测试）
  const cacheKey = 'ncleak_' + strategyGroup;

  let data = null;
  let fromCache = false;
  let latency = '--';
  const t0 = Date.now();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJSON(url, opts) {
    try {
      const resp = await ctx.http.get(url, opts);
      if (!resp || resp.status !== 200) return null;
      return await resp.json();
    } catch (_) { return null; }
  }

  // 获取出口 IP：走 Cloudflare trace（与 ip.net.coffee 页面同源）
  async function getUserExit() {
    try {
      const resp = await ctx.http.get('https://1.1.1.1/cdn-cgi/trace', {
        policy: strategyGroup,
        timeout: 8000
      });
      const txt = await resp.text();
      const m = txt.match(/ip=([^\n]+)/);
      if (!m) return null;
      const ip = m[1].trim();
      const geo = await getJSON('https://ip.net.coffee/api/geoip/' + ip, {
        policy: strategyGroup, timeout: 8000
      });
      let asn = null, org = '';
      try {
        const lk = (ctx.lookupIP && ctx.lookupIP(ip)) || null;
        if (lk) { asn = lk.asn || null; org = lk.organization || ''; }
      } catch (_) {}
      if (!org && geo && geo.isp) org = geo.isp;
      return {
        ip,
        geo: geo || {},
        asn,
        org
      };
    } catch (_) { return null; }
  }

  // DNS 泄露检测：触发真实递归 DNS 查询本站自建权威，再取回解析器 IP
  async function runDnsTest() {
    const token =
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2);

    for (let i = 1; i <= ROUNDS; i++) {
      try {
        await ctx.http.get(
          'https://' + token + '-' + i + '.d.ip.net.coffee/pixel.gif?_=' + Date.now(),
          { policy: strategyGroup, timeout: 4000 }
        );
      } catch (_) {}
      if (i < ROUNDS) await sleep(400);
    }

    // 等待权威服务器收齐并按 token 归档
    await sleep(2000);

    let dnsServers = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await getJSON('https://ip.net.coffee/api/dns/result/' + token, {
        policy: strategyGroup, timeout: 6000
      });
      if (r && Array.isArray(r.dns_servers) && r.dns_servers.length > 0) {
        dnsServers = r.dns_servers;
        break;
      }
      if (attempt < 2) await sleep(2000);
    }

    // 解析器归属地
    const resolvers = [];
    for (const ip of dnsServers.slice(0, 5)) {
      const g = await getJSON('https://ip.net.coffee/api/geoip/' + ip, {
        policy: strategyGroup, timeout: 6000
      });
      resolvers.push({
        ip,
        country: (g && g.country) || '',
        city: (g && g.city) || '',
        isp: (g && g.isp) || '',
        country_code: (g && g.country_code) || ''
      });
    }
    return { token, resolvers };
  }

  // 判定逻辑：与 ip.net.coffee 一致的经典场景 + 通用不一致检测
  function verdictFor(resolvers, userCC) {
    if (!resolvers.length) {
      return {
        text: 'DNS 已加密/代理接管',
        color: C.green,
        detail: '未发现解析器出口 IP（可能已走 DoH/DoT 或代理已接管 DNS）'
      };
    }
    const hasCC = resolvers.filter((r) => r.country_code);
    const cnLeak = userCC && userCC !== 'cn' && hasCC.some((r) => r.country_code === 'cn');
    const mismatch = userCC && hasCC.some((r) => r.country_code !== userCC);
    if (cnLeak) {
      return {
        text: 'DNS 泄露',
        color: C.risk5,
        detail: '解析器位于中国大陆，DNS 查询未走代理'
      };
    }
    if (mismatch) {
      return {
        text: '解析器不一致',
        color: C.risk4,
        detail: '解析器与出口 IP 归属地不同，可能未走代理'
      };
    }
    return {
      text: 'DNS 正常',
      color: C.green,
      detail: '解析器与出口 IP 归属地一致'
    };
  }

  // ============================================
  // 主流程
  // ============================================
  try {
    const exit = await getUserExit();
    const dns = await runDnsTest();

    data = {
      ts: Date.now(),
      exit: exit || { ip: null, geo: {}, asn: null, org: '' },
      resolvers: dns.resolvers
    };

    latency = (Date.now() - t0) + 'ms';
    try { ctx.storage.setJSON(cacheKey, data); } catch (_) {}

  } catch (e) {
    latency = (Date.now() - t0) + 'ms';
    try {
      const cached = ctx.storage.getJSON(cacheKey);
      if (cached) {
        data = cached;
        fromCache = true;
        const ageMin = Math.round((Date.now() - cached.ts) / 60000);
        latency = ageMin ? '缓存 ' + ageMin + 'min' : '缓存';
      }
    } catch (_) {}
  }

  if (!data) {
    data = {
      ts: Date.now(),
      exit: { ip: null, geo: {}, asn: null, org: '' },
      resolvers: [],
      error: '请求失败'
    };
  }

  const exit = data.exit || {};
  const exitGeo = exit.geo || {};
  const resolvers = data.resolvers || [];
  const userCC = (exitGeo.country_code || '').toLowerCase();
  const verdict = verdictFor(resolvers, userCC);

  // 设备信息（WebRTC 泄露会暴露的两类信息，组件内可读）
  const dev = ctx.device || {};
  const lanIPv4 = (dev.ipv4 && dev.ipv4.address) || null;
  const lanIPv6 = (dev.ipv6 && dev.ipv6.address) || null;
  const dnsList = Array.isArray(dev.dnsServers) ? dev.dnsServers : [];

  const locationText = [exitGeo.country, exitGeo.region, exitGeo.city]
    .filter(Boolean).join(' · ');
  const shortLocation = [exitGeo.country, exitGeo.city]
    .filter(Boolean).join(' · ');

  const resolversText = resolvers.length
    ? resolvers.map((r) => [r.country_code, r.city].filter(Boolean).join(' · ')).join('  ⦿  ')
    : '未发现（可能已加密）';

  const orgText = exit.org || exitGeo.isp || 'Unknown';
  const asnText = exit.asn ? 'AS' + exit.asn : '---';

  const webText = '浏览器检测';
  const webColor = C.yellow;

  // ---- UI 工具函数（与参照 JS 一致）----
  function row(label, value, valueColor) {
    return {
      type: 'stack',
      direction: 'row',
      children: [
        {
          type: 'text',
          text: label,
          font: { size: 'caption1', weight: 'medium' },
          textColor: C.muted
        },
        { type: 'spacer' },
        {
          type: 'text',
          text: value,
          font: { size: 'caption1', weight: 'medium' },
          textColor: valueColor || C.secondary,
          textAlign: 'right'
        }
      ]
    };
  }

  function badge(text, color) {
    return {
      type: 'stack',
      direction: 'row',
      gap: 5,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:circle.fill',
          width: 7,
          height: 7,
          color: color
        },
        {
          type: 'text',
          text: text,
          font: { size: 'caption2', weight: 'bold' },
          textColor: color
        }
      ]
    };
  }

  // ============================================
  // LOCK SCREEN: CIRCULAR
  // ============================================
  if (widgetFamily === 'accessoryCircular') {
    return {
      type: 'image',
      src: 'sf-symbol:shield.fill',
      width: 34,
      height: 34,
      color: verdict.color
    };
  }

  // ============================================
  // LOCK SCREEN: RECTANGULAR
  // ============================================
  if (widgetFamily === 'accessoryRectangular') {
    return {
      type: 'widget',
      padding: [6, 10],
      gap: 2,
      children: [
        {
          type: 'text',
          text: shortLocation || 'Unknown',
          font: { size: 14, weight: 'semibold' },
          textColor: C.text,
          maxLine: 1
        },
        {
          type: 'text',
          text: verdict.text,
          font: { size: 11, weight: 'medium' },
          textColor: verdict.color,
          maxLine: 1
        },
        {
          type: 'text',
          text: '解析器 ' + resolvers.length + ' · ' + (maskIp(exit.ip) || '--'),
          font: { size: 11, weight: 'medium' },
          textColor: C.secondary,
          maxLine: 1
        }
      ]
    };
  }

  // ============================================
  // LOCK SCREEN: INLINE
  // ============================================
  if (widgetFamily === 'accessoryInline') {
    return {
      type: 'widget',
      children: [
        {
          type: 'text',
          text: (maskIp(exit.ip) || '--') + ' · ' + verdict.text,
          font: { size: 14, weight: 'semibold' },
          textColor: C.text,
          maxLine: 1
        }
      ]
    };
  }

  // ============================================
  // SMALL / MEDIUM（中号）
  // ============================================
  if (widgetFamily === 'systemMedium') {
    return {
      type: 'widget',
      backgroundGradient: premiumGradient,
      border: { width: 1, color: C.borderColor },
      padding: [16, 18, 16, 18],
      children: [
        // Header
        {
          type: 'stack',
          direction: 'row',
          children: [
            {
              type: 'stack',
              direction: 'row',
              gap: 6,
              children: [
                {
                  type: 'image',
                  src: 'sf-symbol:network',
                  width: 17,
                  height: 17,
                  color: C.green
                },
                {
                  type: 'text',
                  text: 'Leak Test',
                  font: { size: 18, weight: 'bold' },
                  textColor: C.text
                }
              ]
            },
            { type: 'spacer' },
            {
              type: 'text',
              text: strategyGroup,
              font: { size: 15, weight: 'medium' },
              textColor: C.muted
            }
          ]
        },
        { type: 'spacer' },
        // 中间出口 IP
        {
          type: 'text',
          text: maskIp(exit.ip) || '--',
          font: { size: 30, weight: 'bold' },
          textColor: C.text
        },
        // 标签行
        {
          type: 'stack',
          direction: 'row',
          gap: 10,
          children: [
            badge('DNS ' + verdict.text, verdict.color),
            badge('WebRTC ' + webText, webColor)
          ]
        },
        { type: 'spacer' },
        // 底部栏
        {
          type: 'stack',
          direction: 'row',
          children: [
            {
              type: 'text',
              text: shortLocation || 'Unknown',
              font: { size: 13, weight: 'medium' },
              textColor: C.secondary
            },
            { type: 'spacer' },
            {
              type: 'stack',
              direction: 'row',
              gap: 4,
              children: [
                {
                  type: 'text',
                  text: '解析器',
                  font: { size: 13, weight: 'medium' },
                  textColor: C.secondary
                },
                {
                  type: 'text',
                  text: String(resolvers.length),
                  font: { size: 15, weight: 'bold' },
                  textColor: verdict.color
                }
              ]
            }
          ]
        }
      ]
    };
  }

  // ============================================
  // EXTRA LARGE（iPad）
  // ============================================
  if (widgetFamily === 'systemExtraLarge') {
    return {
      type: 'widget',
      backgroundGradient: premiumGradient,
      border: { width: 1, color: C.borderColor },
      padding: 22,
      gap: 16,
      children: [
        {
          type: 'stack',
          direction: 'row',
          children: [
            {
              type: 'stack',
              direction: 'row',
              gap: 8,
              children: [
                {
                  type: 'image',
                  src: 'sf-symbol:network',
                  width: 20,
                  height: 20,
                  color: C.green
                },
                {
                  type: 'text',
                  text: 'Leak Test',
                  font: { size: 'headline', weight: 'bold' },
                  textColor: C.text
                }
              ]
            },
            { type: 'spacer' },
            {
              type: 'text',
              text: strategyGroup,
              font: { size: 'caption1', weight: 'bold' },
              textColor: C.blue
            }
          ]
        },
        {
          type: 'text',
          text: 'EXIT IP',
          font: { size: 'caption1', weight: 'bold' },
          textColor: C.muted
        },
        {
          type: 'text',
          text: maskIp(exit.ip) || 'N/A',
          font: { size: 36, weight: 'bold' },
          textColor: C.text
        },
        {
          type: 'stack',
          direction: 'row',
          gap: 14,
          children: [
            badge('DNS ' + verdict.text, verdict.color),
            badge('WebRTC ' + webText, webColor)
          ]
        },
        row('位置', locationText || 'Unknown'),
        row('运营商', orgText),
        row('ASN', asnText),
        row('DNS 解析器', resolversText),
        row('本机 DNS', dnsList.length ? dnsList.join(', ') : '---'),
        row('本机局域网', lanIPv4 || lanIPv6 || '---'),
        row('判定', verdict.text, verdict.color),
        { type: 'spacer' },
        {
          type: 'stack',
          direction: 'row',
          gap: 6,
          children: [
            {
              type: 'image',
              src: 'sf-symbol:checkmark.circle.fill',
              width: 12,
              height: 12,
              color: C.green
            },
            {
              type: 'text',
              text: 'Leak Test Active · ' + latency + (fromCache ? ' · 缓存' : ''),
              font: { size: 'caption2' },
              textColor: C.secondary
            }
          ]
        }
      ]
    };
  }

  // ============================================
  // LARGE（大号，默认）
  // ============================================
  return {
    type: 'widget',
    backgroundGradient: premiumGradient,
    border: { width: 1, color: C.borderColor },
    padding: 20,
    gap: 14,
    children: [
      {
        type: 'stack',
        direction: 'row',
        children: [
          {
            type: 'stack',
            direction: 'row',
            gap: 8,
            children: [
              {
                type: 'image',
                src: 'sf-symbol:network',
                width: 18,
                height: 18,
                color: C.green
              },
              {
                type: 'text',
                text: 'Leak Test',
                font: { size: 'headline', weight: 'bold' },
                textColor: C.text
              }
            ]
          },
          { type: 'spacer' },
          {
            type: 'text',
            text: strategyGroup,
            font: { size: 'caption1', weight: 'bold' },
            textColor: C.blue
          }
        ]
      },
      {
        type: 'text',
        text: 'EXIT IP',
        font: { size: 'caption1', weight: 'bold' },
        textColor: C.muted
      },
      {
        type: 'text',
        text: maskIp(exit.ip) || 'N/A',
        font: { size: 32, weight: 'bold' },
        textColor: C.text
      },
      {
        type: 'stack',
        direction: 'row',
        gap: 14,
        children: [
          badge('DNS ' + verdict.text, verdict.color),
          badge('WebRTC ' + webText, webColor)
        ]
      },
      row('位置', locationText || 'Unknown'),
      row('运营商', orgText),
      row('ASN', asnText),
      row('DNS 解析器', resolversText),
      row('本机 DNS', dnsList.length ? dnsList.join(', ') : '---'),
      {
        type: 'stack',
        direction: 'row',
        children: [
          {
            type: 'text',
            text: '判定',
            font: { size: 'caption1', weight: 'medium' },
            textColor: C.muted
          },
          { type: 'spacer' },
          {
            type: 'text',
            text: verdict.text,
            font: { size: 'caption1', weight: 'bold' },
            textColor: verdict.color,
            textAlign: 'right'
          }
        ]
      },
      {
        type: 'text',
        text: 'WebRTC 真实检测需浏览器：ip.net.coffee/webrtc（组件无 RTCPeerConnection API）',
        font: { size: 'caption2' },
        textColor: C.muted,
        maxLine: 2
      },
      { type: 'spacer' },
      {
        type: 'stack',
        direction: 'row',
        gap: 6,
        children: [
          {
            type: 'image',
            src: 'sf-symbol:checkmark.circle.fill',
            width: 12,
            height: 12,
            color: C.green
          },
          {
            type: 'text',
            text: 'Leak Test Active · ' + latency + (fromCache ? ' · 缓存' : ''),
            font: { size: 'caption2' },
            textColor: C.secondary
          }
        ]
      }
    ]
  };

}

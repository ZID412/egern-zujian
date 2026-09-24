// ============================================================
// Egern 小组件：DNS 泄露检测 + WebRTC 泄露检测（极简版）
// 数据源：ip.net.coffee（/dns/ 页面的检测机制 + 相关 API）
// UI / 排版：参照 IPPure 小组件（仅借鉴布局与视觉风格）
//
// 【检测规则】
//   DNS：组件内真实检测。向 {token}-1..5.d.ip.net.coffee 发起请求，
//        由实际处理解析的递归 DNS 查询本站自建权威，再轮询
//        /api/dns/result/{token} 取回解析器 IP 并查归属地。
//        只要出现中国大陆(CN)解析器 → 检测到国内网络（异常）；
//        其余情况（含国外多条 IP）→ 正常。
//   WebRTC：Egern 组件 JS 无 RTCPeerConnection / UDP API，
//        无法在组件内真实检测，需浏览器打开 ip.net.coffee/webrtc。
//
// 【用法】
//   1. Egern → Tools → Scripts → 新建 generic 脚本，粘贴本代码
//   2. 小组件选择该脚本；可选环境变量 GROUP=策略组名（默认 DIRECT）
//   3. 若组件频繁超时，把 ROUNDS 改为 3
// ============================================================

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
    risk0: '#22C55E',
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
  const ROUNDS = 5;           // 触发解析轮数
  const cacheKey = 'ncdns_' + strategyGroup;

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

    // 解析器归属地（只取国家代码用于判定）
    const resolvers = [];
    for (const ip of dnsServers.slice(0, 8)) {
      const g = await getJSON('https://ip.net.coffee/api/geoip/' + ip, {
        policy: strategyGroup, timeout: 6000
      });
      if (g && g.country_code) {
        resolvers.push({ ip, country_code: g.country_code });
      }
    }
    return { resolvers };
  }

  // 判定：只认国内(CN)。出现 CN → 检测到国内网络（异常），否则正常
  function dnsVerdict(resolvers) {
    const cnList = resolvers.filter((r) => r.country_code === 'cn');
    if (cnList.length > 0) {
      return {
        text: '检测到国内 DNS',
        color: C.risk5,
        count: cnList.length,
        countries: resolvers.map((r) => r.country_code.toUpperCase()).join(' · ')
      };
    }
    return {
      text: '正常',
      color: C.green,
      count: 0,
      countries: resolvers.length
        ? resolvers.map((r) => r.country_code.toUpperCase()).join(' · ')
        : ''
    };
  }

  // ============================================
  // 主流程
  // ============================================
  try {
    const dns = await runDnsTest();
    data = { ts: Date.now(), resolvers: dns.resolvers };
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
    data = { ts: Date.now(), resolvers: [], error: '请求失败' };
  }

  const resolvers = data.resolvers || [];
  const v = dnsVerdict(resolvers);

  // WebRTC：组件内无法真实检测（无 RTCPeerConnection API）
  const web = {
    text: '浏览器检测',
    color: C.yellow,
    detail: '组件无 RTCPeerConnection API，请用浏览器打开 ip.net.coffee/webrtc 检测'
  };

  const dnsDetail = v.count > 0
    ? v.count + ' 个国内解析器 · ' + v.countries
    : (resolvers.length ? '解析器：' + v.countries + '（国外多条均正常）' : '未发现解析器，DNS 已走代理/加密');

  // ---- UI 工具函数（与参照 JS 一致）----
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
      color: v.color
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
          text: 'DNS ' + v.text + (v.count ? ' (' + v.count + ')' : ''),
          font: { size: 14, weight: 'semibold' },
          textColor: v.color,
          maxLine: 1
        },
        {
          type: 'text',
          text: 'WebRTC ' + web.text,
          font: { size: 11, weight: 'medium' },
          textColor: web.color,
          maxLine: 1
        },
        {
          type: 'text',
          text: v.countries || '解析器 0',
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
          text: 'DNS ' + v.text + ' · WebRTC ' + web.text,
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
        // DNS
        {
          type: 'text',
          text: 'DNS',
          font: { size: 'caption1', weight: 'bold' },
          textColor: C.muted
        },
        {
          type: 'text',
          text: v.text,
          font: { size: 24, weight: 'bold' },
          textColor: v.color
        },
        {
          type: 'text',
          text: dnsDetail,
          font: { size: 12, weight: 'medium' },
          textColor: C.secondary,
          maxLine: 1
        },
        { type: 'spacer' },
        // WebRTC
        {
          type: 'text',
          text: 'WebRTC',
          font: { size: 'caption1', weight: 'bold' },
          textColor: C.muted
        },
        {
          type: 'stack',
          direction: 'row',
          gap: 8,
          children: [
            badge(web.text, web.color),
            {
              type: 'text',
              text: 'ip.net.coffee/webrtc',
              font: { size: 12, weight: 'medium' },
              textColor: C.muted,
              maxLine: 1
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
          text: 'DNS 泄露检测',
          font: { size: 'caption1', weight: 'bold' },
          textColor: C.muted
        },
        {
          type: 'text',
          text: v.text,
          font: { size: 34, weight: 'bold' },
          textColor: v.color
        },
        {
          type: 'text',
          text: dnsDetail,
          font: { size: 13, weight: 'medium' },
          textColor: C.secondary,
          maxLine: 2
        },
        { type: 'spacer' },
        {
          type: 'text',
          text: 'WebRTC 泄露检测',
          font: { size: 'caption1', weight: 'bold' },
          textColor: C.muted
        },
        {
          type: 'text',
          text: web.text,
          font: { size: 26, weight: 'bold' },
          textColor: web.color
        },
        {
          type: 'text',
          text: web.detail,
          font: { size: 13, weight: 'medium' },
          textColor: C.secondary,
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
        text: 'DNS 泄露检测',
        font: { size: 'caption1', weight: 'bold' },
        textColor: C.muted
      },
      {
        type: 'text',
        text: v.text,
        font: { size: 30, weight: 'bold' },
        textColor: v.color
      },
      {
        type: 'text',
        text: dnsDetail,
        font: { size: 13, weight: 'medium' },
        textColor: C.secondary,
        maxLine: 2
      },
      { type: 'spacer' },
      {
        type: 'text',
        text: 'WebRTC 泄露检测',
        font: { size: 'caption1', weight: 'bold' },
        textColor: C.muted
      },
      {
        type: 'stack',
        direction: 'row',
        gap: 8,
        children: [
          badge(web.text, web.color),
          {
            type: 'text',
            text: 'ip.net.coffee/webrtc',
            font: { size: 12, weight: 'medium' },
            textColor: C.muted,
            maxLine: 1
          }
        ]
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

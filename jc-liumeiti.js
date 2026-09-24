/**
 * ==========================================
 * 🌐 网络雷达 (NetRadar) 大组件 · 12 通道解锁探测
 *
 * ✨ 功能概览
 * • 大号组件：一行 4 个卡片、共 3 行，全量展示 12 个服务解锁状态。
 * • 仅做链接可用性探测，无任何 IP 属性检测（IP、ISP、地理位置、
 *   纯净度评分、DNS 泄漏等全部移除）。
 * • 探测方法：HTTP GET + 状态码白名单判定 + 超时熔断。
 * • 服务列表：
 *   行1：Google / GitHub / YouTube / ChatGPT
 *   行2：Claude / Gemini / Netflix / Disney+
 *   行3：Prime Video / Spotify / TikTok / OKX
 * ==========================================
 */
export default async function (ctx) {
  const TIMEOUT_MS = 4000;
  const commonHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache'
  };

  const now = new Date();
  const timeStr = `${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  // =========================================================================
  // 探测函数：HTTP GET + 状态码白名单判定
  // =========================================================================
  async function timed(fn, timeoutMs = TIMEOUT_MS) {
    const start = Date.now();
    try {
      const result = await Promise.race([
        fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
      ]);
      return { ...result, ms: Date.now() - start };
    } catch { return { code: 'ERR', ms: 0 }; }
  }

  async function checkGoogle()    { const res = await ctx.http.get(`https://www.google.com/generate_204`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: res?.status === 204 ? 'OK' : 'ERR' }; }
  async function checkGitHub()    { const res = await ctx.http.get(`https://github.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res && (res.status === 200 || res.status === 301 || res.status === 302)) ? 'OK' : 'ERR' }; }
  async function checkYouTube()   { const res = await ctx.http.get(`https://www.youtube.com/generate_204`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: res?.status === 204 ? 'OK' : 'ERR' }; }
  async function checkChatGPT()   { const res = await ctx.http.get(`https://chatgpt.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res && (res.status === 200 || res.status === 302 || res.status === 401 || res.status === 404)) ? 'OK' : 'ERR' }; }
  async function checkClaude()    { const res = await ctx.http.get(`https://api.anthropic.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res && (res.status === 404 || res.status === 401 || res.status === 200)) ? 'OK' : 'ERR' }; }
  async function checkGemini() {
    try {
      // 探测无 Geo-IP 强前端拦截的底层 API 模型接口，只要有响应（含 403）即判定链路畅通
      await ctx.http.get("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
        timeout: TIMEOUT_MS
      });
      return { status: 'OK' };
    } catch (e) {
      return { status: 'ERR' };
    }
  }
  async function checkNetflix()   { const res = await ctx.http.get(`https://www.netflix.com/generate_204`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res?.status === 204 || res?.status === 200) ? 'OK' : 'ERR' }; }
  async function checkDisney()    { const res = await ctx.http.get(`https://www.disneyplus.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res && res.status !== 403) ? 'OK' : 'ERR' }; }
  async function checkPrimeVideo(){ const res = await ctx.http.get(`https://www.primevideo.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res && (res.status === 200 || res.status === 301 || res.status === 302)) ? 'OK' : 'ERR' }; }
  async function checkSpotify()   { const res = await ctx.http.get(`https://open.spotify.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: res && res.status === 200 ? 'OK' : 'ERR' }; }
  async function checkTikTok()    { const res = await ctx.http.get(`https://www.tiktok.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res && (res.status === 200 || res.status === 301 || res.status === 302)) ? 'OK' : 'ERR' }; }
  async function checkOKX()       { const res = await ctx.http.get(`https://www.okx.com/`, { timeout: TIMEOUT_MS, headers: commonHeaders, followRedirect: false }).catch(() => null); return { code: (res && (res.status === 200 || res.status === 301 || res.status === 302)) ? 'OK' : 'ERR' }; }

  // 12 通道并发探测
  const [google, github, youtube, chatgpt, claude, gemini, netflix, disney, prime, spotify, tiktok, okx] = await Promise.all([
    timed(checkGoogle), timed(checkGitHub), timed(checkYouTube), timed(checkChatGPT),
    timed(checkClaude), timed(checkGemini), timed(checkNetflix), timed(checkDisney),
    timed(checkPrimeVideo), timed(checkSpotify), timed(checkTikTok), timed(checkOKX)
  ]);

  // =========================================================================
  // 展示
  // =========================================================================
  const REGION = {
    'Google': 'G', 'GitHub': 'G', 'YouTube': 'HK', 'ChatGPT': 'US', 'Claude': 'US', 'Gemini': 'US',
    'Netflix': 'SG', 'Disney+': 'SG', 'Prime Video': 'US', 'Spotify': 'US', 'TikTok': 'US', 'OKX': 'G'
  };

  const resultInfo = (result, name) => {
    const available = result.code === 'OK' || result.status === 'OK';
    const finalRegion = REGION[name] || 'XX';
    return { available, region: available ? finalRegion : '--', ms: result.ms || 0 };
  };

  const allServices = [
    { name: 'Google',       info: resultInfo(google,   'Google') },
    { name: 'GitHub',       info: resultInfo(github,   'GitHub') },
    { name: 'YouTube',      info: resultInfo(youtube,  'YouTube') },
    { name: 'ChatGPT',      info: resultInfo(chatgpt,  'ChatGPT') },
    { name: 'Claude',       info: resultInfo(claude,   'Claude') },
    { name: 'Gemini',       info: resultInfo(gemini,   'Gemini') },
    { name: 'Netflix',      info: resultInfo(netflix,  'Netflix') },
    { name: 'Disney+',      info: resultInfo(disney,   'Disney+') },
    { name: 'Prime Video',  info: resultInfo(prime,    'Prime Video') },
    { name: 'Spotify',      info: resultInfo(spotify,  'Spotify') },
    { name: 'TikTok',       info: resultInfo(tiktok,   'TikTok') },
    { name: 'OKX',          info: resultInfo(okx,      'OKX') }
  ];

  const C = {
    bg:         { light: '#F9F9FB', dark: '#0A0C10' },
    cardBg:     { light: '#FFFFFF', dark: '#12151D' },
    cardBorder: { light: '#E8E8ED', dark: '#1F2430' },
    textMain:   { light: '#111111', dark: '#FFFFFF' },
    textSub:    { light: '#7C7C80', dark: '#8B949E' },
    blue:       { light: '#0066FF', dark: '#58A6FF' },
    green:      { light: '#248A3D', dark: '#3FB950' },
    purple:     { light: '#8C32E6', dark: '#BC8CFF' },
    red:        { light: '#E3241B', dark: '#F85149' },
    warn:       { light: '#E87D00', dark: '#F5A623' },
    badgeBg:    { light: '#F0F0F4', dark: '#1C212B' }
  };

  const parseProxyMode = (context) => {
    let mode = "Rule";
    try {
      if (!context) return mode;
      const p = context.proxy || context.node || context.policy || context.outbound || context.egern;
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return p.name || p.title || p.remark || p.policy || "Rule";
    } catch (e) {}
    return mode;
  };
  const currentPolicy = parseProxyMode(ctx);

  const mkRow = (children, opts = {}) => ({ type: 'stack', direction: 'row', alignItems: 'center', ...opts, children });
  const mkCol = (children, opts = {}) => ({ type: 'stack', direction: 'column', ...opts, children });
  const mkText = (text, size, color, weight = 'regular', opts = {}) => ({ type: 'text', text: String(text), textColor: color, font: { size, weight }, ...opts });
  const mkIcon = (src, color, size = 14, opts = {}) => ({ type: 'image', src: `sf-symbol:${src}`, color, width: size, height: size, ...opts });
  const mkSpacer = (len) => len ? { type: 'spacer', length: len } : { type: 'spacer' };

  const responseColor = (ms, available) => !available ? C.red : (ms >= 1500 ? C.warn : C.textSub);

  const ServiceBlock = (item) => {
    const isOk = item.info.available;
    return mkCol([
      mkRow([
        mkText(item.name, 11, C.textMain, 'bold', { flex: 1, maxLines: 1 }),
        { type: 'stack', width: 5, height: 5, borderRadius: 2.5, backgroundColor: isOk ? C.green : C.red }
      ]),
      mkSpacer(8),
      mkRow([
        mkText(item.info.region, 9, C.textSub, 'regular'),
        mkSpacer(),
        mkText(isOk ? `${item.info.ms}ms` : '--', 9, responseColor(item.info.ms, isOk), 'regular', { design: 'monospaced' })
      ])
    ], { backgroundColor: C.cardBg, borderRadius: 8, padding: [8, 8], flex: 1, borderWidth: 1, borderColor: C.cardBorder });
  };

  const headerRow = mkRow([
    mkIcon('waveform.path.ecg', C.blue, 12), mkSpacer(6),
    mkText('网络雷达', 12, C.textMain, 'bold'),
    mkSpacer(),
    mkRow([ mkIcon('shield.fill', C.purple, 9), mkSpacer(4), mkText(currentPolicy, 9, C.textMain, 'bold', { maxLines: 1 }) ], { padding: [3, 8], backgroundColor: C.badgeBg, borderRadius: 6 }),
    mkSpacer(8),
    mkRow([ mkIcon('arrow.triangle.2.circlepath', C.textSub, 10), mkSpacer(3), mkText(timeStr, 10, C.textSub, 'bold', { family: 'Menlo' }) ])
  ]);

  return {
    type: 'widget', backgroundColor: C.bg, padding: 12,
    children: [
      headerRow, mkSpacer(10),
      mkRow(allServices.slice(0, 4).map(ServiceBlock), { gap: 8 }), mkSpacer(8),
      mkRow(allServices.slice(4, 8).map(ServiceBlock), { gap: 8 }), mkSpacer(8),
      mkRow(allServices.slice(8, 12).map(ServiceBlock), { gap: 8 })
    ]
  };
}

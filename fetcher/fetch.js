/**
 * 今日热搜榜 - 生产版抓取脚本（v2.2 · 豆瓣反爬突破）
 *
 * v2.2 关键改动：
 *   - 新增 Cookie Jar（按 hostname 作用域）：请求 movie.douban.com / m.douban.com 前先 Prime
 *     Cookie，避免 subject_abstract / 移动端详情 302 到安全校验页
 *   - 豆瓣电影/剧集详情改为：subject_abstract JSON（直接拿 directors/actors/types/release_year/
 *     duration/rate/episodes_count 纯结构化） + 移动端 m.douban.com 详情页 meta description
 *     抽剧情简介，不再依赖 PC 详情页 v:directedBy 标签（被 WAF 拦截）
 *   - 通用 fetch() 自动带当前 host 的 Cookie header + 保存 set-cookie + 跟随 30x
 *
 * 其它设计原则（不变）：
 *   1. 安全稳定优先（单平台失败不影响整体）
 *   2. 抓取列表 + 原文正文（方案 D：找正文容器取完整段落）
 *   3. 只保留文字（列表里的 thumb/cover 保留，豆瓣条目单独结构化）
 *   4. 输出到本地 data/*.json，由 workflow commit 到仓库
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

// ============ 配置 ============
const OUTPUT_DIR = path.resolve(__dirname, '..', 'data')
const DETAIL_TOP_N = 20        // 每个平台对前 N 条抓取正文（含豆瓣结构化/简介）
const DETAIL_CONCURRENCY = 5   // 正文抓取并发数
const DETAIL_TIMEOUT = 8000    // 单条正文抓取超时（毫秒）
const CONTENT_MAX_LEN = 3000   // 单条正文最大字数

// ============ Cookie Jar（按 hostname 作用域） ============
const COOKIE_JAR = Object.create(null)
function _saveCookies(host, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return
  if (!COOKIE_JAR[host]) COOKIE_JAR[host] = Object.create(null)
  for (const header of setCookieHeaders) {
    const firstSeg = String(header).split(';')[0].trim()
    if (!firstSeg) continue
    const eq = firstSeg.indexOf('=')
    if (eq <= 0) continue
    const k = firstSeg.slice(0, eq)
    const v = firstSeg.slice(eq + 1)
    if (k) COOKIE_JAR[host][k] = v
  }
}
function _cookieHeader(host) {
  const jar = COOKIE_JAR[host]
  if (!jar) return ''
  const keys = Object.keys(jar)
  if (!keys.length) return ''
  return keys.map(k => k + '=' + jar[k]).join('; ')
}
// Prime：预热 Cookie，防止豆瓣首次请求 302 安全校验
async function primeCookies(host, urls) {
  for (const u of urls) {
    try { await fetch(u, { timeout: 10000 }); break } catch (_) {}
  }
  return !!_cookieHeader(host)
}

// ============ 通用请求（自动带 Cookie + 跟随 30x） ============
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    let parsedUrl
    try { parsedUrl = new URL(url) } catch (e) { return reject(e) }
    const host = parsedUrl.hostname
    const extraHeaders = {}
    const ck = _cookieHeader(host)
    if (ck) extraHeaders['Cookie'] = ck
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }, extraHeaders, options.headers || {}),
      timeout: options.timeout || 15000
    }, res => {
      _saveCookies(host, res.headers['set-cookie'])
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href
        return resolve(fetch(next, options))
      }
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ data, statusCode: res.statusCode, headers: res.headers })
        } else {
          reject(new Error('HTTP ' + res.statusCode + ' for ' + url))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout: ' + url)) })
    req.end()
  })
}

// ============ 工具函数 ============
function clean(s) {
  return (s || '').toString().replace(/\s+/g, ' ').trim()
}
function stripHtml(s) {
  return (s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim()
}
function parseHot(hotStr) {
  if (!hotStr) return 0
  const s = String(hotStr).replace(/[,，\s]/g, '')
  const m = s.match(/^([\d.]+)\s*(亿|万|千)?$/)
  if (!m) return 0
  let n = parseFloat(m[1])
  if (m[2] === '亿') n *= 100000000
  else if (m[2] === '万') n *= 10000
  else if (m[2] === '千') n *= 1000
  return isNaN(n) ? 0 : n
}
function tagsFor(hotStr, rank) {
  const tags = []
  const n = parseHot(hotStr)
  if (n >= 1000000) tags.push('爆')
  else if (n >= 100000) tags.push('沸')
  else if (n >= 10000) tags.push('热')
  if (!tags.length && rank <= 3) tags.push('热议')
  return tags
}

// ============ 方案 D：正文原文提取（找容器 → 取段落 → meta 兜底） ============
const ARTICLE_SELECTOR_REGEXES = [
  /<article[^>]*>([\s\S]*?)<\/article>/gi,
  /class="[^"]*\b(article|post|content|detail|news|detail-content|article-content|content-detail|article_detail|topic-content|rich_media_content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi,
  /id="[^"]*\b(article|post|content|detail|newsText|endText|artibody)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi
]
function extractParagraphs(html, maxP) {
  if (!html) return []
  const result = []
  const preg = /<p[^>]*>([\s\S]*?)<\/p>/gi
  let pm
  while ((pm = preg.exec(html)) && result.length < maxP) {
    const t = stripHtml(pm[1])
    if (t.length >= 12) result.push(t)
  }
  return result
}
function extractContentFromHtml(html) {
  if (!html) return ''
  for (const re of ARTICLE_SELECTOR_REGEXES) {
    let m
    while ((m = re.exec(html))) {
      const container = m[2] || m[1] || ''
      const ps = extractParagraphs(container, 20)
      if (ps.length >= 2) return ps.join('\n\n')
    }
  }
  const psAll = extractParagraphs(html, 10)
  if (psAll.length >= 2) return psAll.join('\n\n')
  let m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
    || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i)
  if (m && m[1]) return clean(m[1])
  m = html.match(/<meta[^>]+property=["']og:description["'][[^>]+content=["']([\s\S]*?)["']/i)
    || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["']/i)
  if (m && m[1]) return clean(m[1])
  if (psAll.length === 1) return psAll[0]
  return ''
}

// ============ 豆瓣：拿 subject_id 从 URL ============
function extractDoubanSubjectId(url) {
  if (!url) return ''
  const m = String(url).match(/subject\/(\d+)/)
  return m ? m[1] : ''
}

/**
 * 豆瓣电影/剧集结构化抓取（v2.2 新版 · 反爬友好）
 *  ① JSON 结构化 → /j/subject_abstract?subject_id=ID
 *     directors actors types release_year duration rate episodes_count region
 *  ② 剧情简介 → m.douban.com/movie/subject/{ID}/ meta name="description"
 *    例："抓特务豆瓣评分：7.4 简介：一场警察与特务..."（中文冒号"简介："之后全是剧情简介，
 *    meta description 是豆瓣官方截取，跨 PC/移动一致性最好）
 */
async function fetchDoubanStructured(subjectId) {
  if (!subjectId) return {}
  const info = {}

  // ---- ① subject_abstract 纯 JSON（含导演/主演/类型/年份/片长/评分/集数） ----
  try {
    const abs = await fetch(
      'https://movie.douban.com/j/subject_abstract?subject_id=' + encodeURIComponent(subjectId),
      {
        timeout: DETAIL_TIMEOUT,
        headers: {
          'Referer': 'https://movie.douban.com/',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/plain, */*'
        }
      }
    )
    const j = JSON.parse(abs.data)
    if (j && j.r === 0 && j.subject) {
      const s = j.subject
      if (Array.isArray(s.directors) && s.directors.length)
        info.douban_directors = s.directors.join(' / ')
      if (Array.isArray(s.actors) && s.actors.length)
        info.douban_casts = s.actors.slice(0, 6).join(' / ')
      if (Array.isArray(s.types) && s.types.length)
        info.douban_genre = s.types.join(' / ')
      if (s.release_year) info.douban_year = String(s.release_year)
      if (s.duration) info.douban_runtime = String(s.duration)
      if (s.episodes_count) info.douban_episodes = String(s.episodes_count)
      if (s.region) info.douban_region = String(s.region)
      if (s.rate) info.rate = String(s.rate)
    }
  } catch (_) { /* abstract 失败不影响，继续尝试简介 */ }

  // ---- ② 剧情简介（优先用 移动端详情页 meta description） ----
  try {
    const r = await fetch('https://m.douban.com/movie/subject/' + encodeURIComponent(subjectId) + '/', {
      timeout: DETAIL_TIMEOUT,
      headers: {
        'Referer': 'https://m.douban.com/movie/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
      }
    })
    const html = r.data || ''
    let summary = ''
    const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
      || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i)
    if (descM && descM[1]) {
      // 格式："XXX豆瓣评分：x.x 简介：..." 或 "XXX评分 x.x 简介：..."
      const raw = clean(descM[1])
      const idx = raw.search(/简介[：:]\s*/)
      if (idx !== -1) {
        summary = raw.slice(idx).replace(/^简介[：:]\s*/, '')
      } else {
        // 没有"简介："标签就退化为整段 description 去掉开头评分前缀
        summary = raw.replace(/^.*?豆瓣评分[：:]\s*[\d.]+\s*/, '')
      }
    }
    if (!summary) {
      const ogM = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["']/i)
      if (ogM && ogM[1]) summary = clean(ogM[1])
    }
    // 兜底再尝试 itemprop description
    if (!summary) {
      const ipM = html.match(/<meta[^>]+itemprop=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+itemprop=["']description["']/i)
      if (ipM && ipM[1]) {
        const raw = clean(ipM[1])
        const idx = raw.search(/简介[：:]\s*/)
        summary = idx !== -1 ? raw.slice(idx).replace(/^简介[：:]\s*/, '') : raw
      }
    }
    summary = clean(summary)
    if (summary && summary.length >= 10) {
      info.douban_intro = summary
      info.content_for_item = summary.slice(0, CONTENT_MAX_LEN)
    }
  } catch (_) { /* 简介抓取失败保留已有字段 */ }

  return info
}

// ============ 并发控制 ============
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let idx = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const i = idx++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (err) {
        results[i] = { __error: err.message || String(err) }
      }
    }
  })
  await Promise.all(workers)
  return results
}

// ============ 归一化 ============
function norm(items, platform) {
  return (items || []).map((it, i) => {
    const rank = it.index || i + 1
    const hot = clean(it.hot)
    return {
      rank,
      title: clean(it.title),
      excerpt: clean(it.desc),
      content: '',
      hot,
      tags: tagsFor(hot, rank),
      url: it.mobilUrl || it.url || '',
      thumb: it.pic || ''
    }
  }).filter(it => it.title)
}

// ============ 各平台 Fetcher ============
const FETCHERS = {
  baidu: async () => {
    const r = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime')
    const j = JSON.parse(r.data)
    const cards = (j.data && j.data.cards) || []
    let content = []
    for (const c of cards) {
      if (!Array.isArray(c.content)) continue
      if (c.content[0] && Array.isArray(c.content[0].content)) {
        content = content.concat(c.content[0].content)
      } else {
        content = content.concat(c.content)
      }
    }
    return content.map((it, i) => ({
      index: it.index || i + 1,
      title: (it.word || '').trim(),
      desc: (it.desc || '').trim(),
      pic: it.img || '',
      hot: it.hotScore ? String(it.hotScore) : '',
      url: it.url || it.rawUrl || '',
      mobilUrl: it.url || it.rawUrl || ''
    })).filter(it => it.title)
  },

  douyin: async () => {
    const r = await fetch('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/')
    const j = JSON.parse(r.data)
    const list = j.word_list || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.word || '').trim(),
      desc: (it.event_description || it.word_desc || '').trim(),
      pic: '',
      hot: it.hot_value ? String(it.hot_value) : '',
      url: 'https://www.douyin.com/search/' + encodeURIComponent(it.word || ''),
      mobilUrl: 'https://www.douyin.com/search/' + encodeURIComponent(it.word || '')
    })).filter(it => it.title)
  },

  toutiao: async () => {
    const r = await fetch('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc')
    const j = JSON.parse(r.data)
    const list = j.data || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.Title || '').trim(),
      desc: clean(it.ClipInfo ? (it.ClipInfo.AbsText || '') : ''),
      pic: it.Image ? (it.Image.url || '') : '',
      hot: it.HotValue ? String(it.HotValue) : '',
      url: (it.Url || '').trim(),
      mobilUrl: (it.Url || '').trim()
    })).filter(it => it.title)
  },

  tieba: async () => {
    const r = await fetch('https://tieba.baidu.com/hottopic/browse/topicList?topic_id=0')
    const j = JSON.parse(r.data)
    const list = (j.data && j.data.bang_topic && j.data.bang_topic.topic_list) || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.topic_name || '').trim(),
      desc: (it.topic_desc || it.abstract || '').trim(),
      pic: it.topic_pic || '',
      hot: it.discuss_num ? String(it.discuss_num) : '',
      url: (it.topic_url || '').replace(/&amp;/g, '&'),
      mobilUrl: (it.topic_url || '').replace(/&amp;/g, '&')
    })).filter(it => it.title)
  },

  sspai: async () => {
    const r = await fetch('https://sspai.com/api/v1/articles?limit=30')
    const j = JSON.parse(r.data)
    const list = j.list || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.title || '').trim(),
      desc: (it.summary || '').trim(),
      pic: it.banner ? ('https://cdn.sspai.com/' + it.banner) : '',
      hot: it.likes ? String(it.likes) : (it.views_count ? String(it.views_count) : ''),
      url: 'https://sspai.com/post/' + it.id,
      mobilUrl: 'https://sspai.com/post/' + it.id
    })).filter(it => it.title)
  },

  hupu: async () => {
    const r = await fetch('https://bbs.hupu.com/topic-daily')
    const html = r.data
    const items = []
    const reg = /<a[^>]+href="(\/\d+\.html)"[^>]*>([^<]{4,})<\/a>/g
    let m
    while ((m = reg.exec(html)) && items.length < 30) {
      const url = 'https://bbs.hupu.com' + m[1]
      const title = (m[2] || '').trim()
      if (!title) continue
      if (items.some(x => x.url === url)) continue
      items.push({ index: items.length + 1, title, desc: '', pic: '', hot: '', url, mobilUrl: url })
    }
    if (!items.length) throw new Error('虎扑解析失败')
    return items
  },

  cctv: async () => {
    const r = await fetch('https://news.cctv.com/')
    const html = r.data
    const items = []
    const reg = /href="(https:\/\/news\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/ARTI[\w-]+\.shtml)"[^>]*>([\s\S]{4,200}?)<\/a>/g
    let m
    while ((m = reg.exec(html)) && items.length < 30) {
      const url = m[1]
      const title = (m[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      if (!title || title.length < 4) continue
      if (items.some(x => x.url === url)) continue
      items.push({ index: items.length + 1, title, desc: '', pic: '', hot: '', url, mobilUrl: url })
    }
    if (!items.length) throw new Error('央视解析失败')
    return items
  },

  douban: async () => {
    // prime 豆瓣 cookie（PC+移动双端），为后续详情做准备
    primeCookies('movie.douban.com', ['https://movie.douban.com/']).catch(() => {})
    primeCookies('m.douban.com',     ['https://m.douban.com/movie/']).catch(() => {})
    const r = await fetch('https://movie.douban.com/j/search_subjects?type=movie&tag=热门&page_limit=20&page_start=0', {
      headers: { 'Referer': 'https://movie.douban.com/' }
    })
    const j = JSON.parse(r.data)
    const list = j.subjects || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.title || '').trim(),
      desc: it.rate ? '评分 ' + it.rate : '',
      pic: it.cover || '',
      hot: it.rate || '',
      rate: it.rate || '',
      url: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      mobilUrl: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      douban_id: String(it.id || '')
    })).filter(it => it.title)
  },

  doubantv: async () => {
    primeCookies('movie.douban.com', ['https://movie.douban.com/']).catch(() => {})
    primeCookies('m.douban.com',     ['https://m.douban.com/movie/']).catch(() => {})
    const r = await fetch('https://movie.douban.com/j/search_subjects?type=tv&tag=热门&page_limit=20&page_start=0', {
      headers: { 'Referer': 'https://movie.douban.com/' }
    })
    const j = JSON.parse(r.data)
    const list = j.subjects || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.title || '').trim(),
      desc: (it.episodes_info || '') + (it.rate ? ' 评分 ' + it.rate : ''),
      pic: it.cover || '',
      hot: it.rate || '',
      rate: it.rate || '',
      url: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      mobilUrl: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      douban_id: String(it.id || '')
    })).filter(it => it.title)
  }
}

// ============ 正文抓取（方案 D：分平台策略） ============
async function enrichContent(platform, items) {
  const top = items.slice(0, DETAIL_TOP_N)
  const rest = items.slice(DETAIL_TOP_N)
  const isDouban = (platform === 'douban' || platform === 'doubantv')

  const results = await mapWithConcurrency(top, DETAIL_CONCURRENCY, async (it) => {
    // ---- 豆瓣：结构化 JSON + 移动端剧情简介 ----
    if (isDouban) {
      const sid = (it && it.douban_id) || extractDoubanSubjectId(it.url)
      const info = await fetchDoubanStructured(sid)
      // 若 abstract 没返回 rate，保留列表接口自带的
      if (!info.rate && it && it.rate) info.rate = it.rate
      const body = (info.content_for_item || '').slice(0, CONTENT_MAX_LEN)
      delete info.content_for_item
      return Object.assign({ content: body }, info)
    }
    // ---- 非豆瓣：常规正文抓取（方案 D） ----
    if (!it.url) return { content: '' }
    try {
      const r = await fetch(it.url, { timeout: DETAIL_TIMEOUT })
      const content = extractContentFromHtml(r.data || '').slice(0, CONTENT_MAX_LEN)
      return { content }
    } catch (_) {
      return { content: '' }
    }
  })

  top.forEach((it, i) => {
    const r = results[i] || {}
    if (isDouban) {
      // content：优先 douban_intro（剧情简介），其次列表 excerpt（"评分 X.X"）
      if (r.douban_intro) it.content = r.douban_intro.slice(0, CONTENT_MAX_LEN)
      else it.content = it.excerpt || ''
      if (r.douban_directors) it.douban_directors = r.douban_directors
      if (r.douban_casts)    it.douban_casts    = r.douban_casts
      if (r.douban_genre)    it.douban_genre    = r.douban_genre
      if (r.douban_year)     it.douban_year     = r.douban_year
      if (r.douban_runtime)  it.douban_runtime  = r.douban_runtime
      if (r.douban_episodes) it.douban_episodes = r.douban_episodes
      if (r.douban_region)   it.douban_region   = r.douban_region
      if (r.rate)            it.rate            = r.rate
    } else {
      const c = (r && r.content) || ''
      if (c && c.length > (it.excerpt || '').length) it.content = c
      else if (it.excerpt) it.content = it.excerpt
      else it.content = c
    }
  })
  rest.forEach(it => { it.content = it.excerpt || '' })
  return items
}

// ============ 输出 ============
function writeFile(filepath, content) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, content, 'utf8')
}

// ============ 主流程 ============
async function main() {
  console.log('=== 开始抓取热搜数据 ===')
  console.log('Time: ' + new Date().toISOString())
  console.log('Output dir: ' + OUTPUT_DIR)
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const platforms = Object.keys(FETCHERS)
  const results = {}
  const meta = {
    version: '2.2',
    update_time: new Date().toISOString(),
    platforms: []
  }

  for (const key of platforms) {
    try {
      console.log('抓取 ' + key + '...')
      const raw = await FETCHERS[key]()
      const items = norm(raw, key)
      if (!items.length) throw new Error('空数据')
      results[key] = items
      console.log('  ✓ ' + key + ': ' + items.length + ' 条')
    } catch (err) {
      console.error('  ✗ ' + key + ': ' + (err.message || err))
      results[key] = null
    }
  }

  for (const key of platforms) {
    if (!results[key]) continue
    try {
      console.log('正文抓取 ' + key + '...')
      await enrichContent(key, results[key])
      const withContent = results[key].filter(x => x.content && x.content.length >= 20).length
      const infoFields = results[key].filter(x => x.douban_directors || x.douban_casts).length
      const extraLine = (key === 'douban' || key === 'doubantv')
        ? '（结构化 ' + infoFields + '/' + results[key].length + ' 条）'
        : ''
      console.log('  ✓ ' + key + ' 正文已填充（' + withContent + '/' + results[key].length + ' 条有正文）' + extraLine)
    } catch (err) {
      console.error('  ✗ ' + key + ' 正文抓取失败: ' + (err.message || err))
    }
  }

  for (const key of platforms) {
    const filepath = path.join(OUTPUT_DIR, key + '.json')
    if (!results[key]) {
      writeFile(filepath, JSON.stringify({
        success: false, platform: key,
        update_time: new Date().toISOString(), data: []
      }, null, 2))
      meta.platforms.push({ key, success: false, count: 0 })
      continue
    }
    const payload = {
      success: true, platform: key,
      update_time: new Date().toISOString(),
      count: results[key].length,
      data: results[key]
    }
    writeFile(filepath, JSON.stringify(payload, null, 2))
    meta.platforms.push({ key, success: true, count: results[key].length })
  }

  writeFile(path.join(OUTPUT_DIR, '_meta.json'), JSON.stringify(meta, null, 2))
  const okCount = meta.platforms.filter(p => p.success).length
  console.log('=== 完成 ===')
  console.log('OK: ' + okCount + '/' + platforms.length)
  console.log('失败平台: ' + meta.platforms.filter(p => !p.success).map(p => p.key).join(', '))
  if (okCount < Math.ceil(platforms.length / 2)) {
    console.error('失败过多，退出码 1')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('主流程错误:', err)
  process.exit(1)
})

/**
 * 今日热搜榜 - 配置驱动抓取脚本 v2.3
 * 读取 data-sources.yaml 驱动抓取，支持多种源类型
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const { loadConfig, getEnabledSources, getPlatforms, getSourcesForPlatform, getGlobalConfig, parsePlatformParsers } = require('./config-loader')

// ============ 配置 ============
const config = loadConfig()
parsePlatformParsers(config)
const globalConfig = getGlobalConfig(config)
const OUTPUT_DIR = path.resolve(__dirname, '..', 'data')
const DETAIL_TOP_N = globalConfig.detail_top_n || 50  // 增加到 50 条
const DETAIL_CONCURRENCY = globalConfig.concurrency || 5
const DETAIL_TIMEOUT = globalConfig.timeout || 10000  // 增加到 10s
const DETAIL_RETRY = 2  // 重试次数
const CONTENT_MAX_LEN = globalConfig.content_max_len || 6000

// ============ Cookie Jar ============
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
async function primeCookies(host, urls) {
  for (const u of urls) {
    try { await fetch(u, { timeout: 10000 }); break } catch (_) {}
  }
  return !!_cookieHeader(host)
}

// ============ 通用请求 ============
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
        'User-Agent': globalConfig.default_headers?.['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': globalConfig.default_headers?.['Accept'] || 'application/json, text/html, */*',
        'Accept-Language': globalConfig.default_headers?.['Accept-Language'] || 'zh-CN,zh;q=0.9'
      }, extraHeaders, options.headers || {}),
      timeout: options.timeout || 15000,
      // 解决自签名证书问题
      rejectUnauthorized: false
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
function isMostlyEnglish(s) {
  if (!s || s.length < 20) return false
  const ascii = (s.match(/[\x00-\x7f]/g) || []).length
  return ascii / s.length > 0.6
}
function stripHtml(s) {
  return (s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&/g, '&')
    .replace(/</g, '<').replace(/>/g, '>')
    .replace(/"/g, '"').replace(/'/g, "'")
    .replace(/\s+/g, ' ').trim()
}
function cleanContent(s) {
  if (!s) return ''
  let t = s
    // 央视视频模板
    .replace(/\[!--begin:htmlVideoCode--\][\s\S]*?\[!--end:htmlVideoCode--\]/g, '')
    // 贴吧
    .replace(/吧内搜索\s*搜贴\s*搜人\s*进吧\s*搜标签/g, '')
    .replace(/贴吧用户_\w+/g, '')
    .replace(/来自\s+\S+吧/g, '')
    // 虎扑
    .replace(/亮了\(\s*\d+\s*\)\s*回复/g, '')
    .replace(/点灭\s*只看此人\s*举报/g, '')
    .replace(/含AI生成内容/g, '')
    .replace(/深聊/g, '')
    .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g, '')
    .replace(/发布于[\s\S]*?(?=\n)/g, '')
    .replace(/\d+\s*楼\s*/g, '')
    .replace(/查看评论\(\s*\d+\s*\)/g, '')
    .replace(/引用内容由于违规已被删除/g, '')
    // 虎扑页脚
    .replace(/社区\s*»[\s\S]*?(?=\n|$)/g, '')
    .replace(/虎扑首页[\s\S]*?(?:版权所有|All Rights Reserved)/g, '')
    .replace(/热门游戏[\s\S]*?(?=\n|$)/g, '')
    .replace(/FIFPRO[\s\S]*?(?=\n|$)/g, '')
    .replace(/美职篮篮球世界/g, '')
    .replace(/世界大赛[\s\S]*?(?=\n|$)/g, '')
    .replace(/NBA官方正版授权[\s\S]*?(?=\n|$)/g, '')
    // 央视页脚
    .replace(/央视网[\s\S]*?(?:版权所有|All Rights Reserved)/g, '')
    // 少数派
    .replace(/共创\s*PRIME\s*Matrix\s*栏目\s*Pi\s*Store[\s\S]*?(?=\d{4}年\d{2}月\d{2}日)/g, '')
    .replace(/无需申请，自由写作[\s\S]*?了解更多/g, '')
    .replace(/(\d{4}年\d{2}月\d{2}日)\s*\d+\s*分钟阅读/g, '$1')
    .replace(/主作者\s*关注[\s\S]*?(?=近年来|前几天|本文|这次|在)/g, '')
    .replace(/联合作者\s*关注[\s\S]*?(?=\n)/g, '')
    .replace(/微信扫码分享[\s\S]*?分享\s*收藏\s*举报/g, '')
    .replace(/利益相关声明[:：][\s\S]*?(?=\n)/g, '')
    .replace(/点击下方按钮可复制链接\s*分享\s*收藏\s*举报/g, '')
    // IT之家
    .replace(/IT之家[\s\S]*?(?:版权所有|All Rights Reserved)/g, '')
    .replace(/微信扫码[\s\S]*?(?=\n|$)/g, '')
    .replace(/下载IT之家APP[\s\S]*?(?=\n|$)/g, '')
    .replace(/相关推荐[\s\S]*$/g, '')
    .replace(/大家都在看[\s\S]*$/g, '')
    .replace(/分享到[\s\S]*?(?=\n|$)/g, '')
    // 通用
    .replace(/编辑[:：]\s*\S+/g, '')
    .replace(/来源[:：]\s*\S+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
  return t.trim()
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

// ============ 正文提取 ============
const ARTICLE_SELECTOR_REGEXES = [
  /<article[^>]*>([\s\S]*?)<\/article>/gi,
  /class="[^"]*\b(article|post|content|detail|news|detail-content|article-content|content-detail|article_detail|topic-content|rich_media_content|article-body|post-content|entry-content|news-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi,
  /id="[^"]*\b(article|post|content|detail|newsText|endText|artibody)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi
]
const PLATFORM_CONTENT_SELECTORS = {
  sspai: [
    /class="[^"]*\b(article-body|article-content|post-content|rich_media_content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi,
    /id="[^"]*\b(article-content|post-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi
  ],
  hupu: [
    /class="[^"]*\b(article-content|post-content|floor-content|bbs-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi,
    /id="[^"]*\b(tpc_content|article-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi
  ],
  ithome: [
    /class="[^"]*\b(article-content|post-content|news-content|content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi,
    /id="[^"]*\b(article-content|news-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi
  ],
  tieba: [
    /class="[^"]*\b(post-content|content|thread-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi,
    /id="[^"]*\b(post-content|j_p_postlist)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi
  ],
  cctv: [
    /class="[^"]*\b(content|article-content|news-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi,
    /id="[^"]*\b(content|article-content)\b[^"]*"[^>]*>([\s\S]*?)<\/(div|section|article)>/gi
  ]
}
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
function extractContentFromHtml(html, platform) {
  if (!html) return ''
  // 平台特定选择器
  if (platform && PLATFORM_CONTENT_SELECTORS[platform]) {
    for (const re of PLATFORM_CONTENT_SELECTORS[platform]) {
      let m
      while ((m = re.exec(html))) {
        const container = m[2] || m[1] || ''
        const ps = extractParagraphs(container, 20)
        if (ps.length >= 2) return ps.join('\n\n')
      }
    }
  }
  // 通用选择器
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
  m = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i)
    || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["']/i)
  if (m && m[1]) return clean(m[1])
  if (psAll.length === 1) return psAll[0]
  return ''
}

// 央视特殊处理
function extractCctvContent(html) {
  if (!html) return ''
  const patterns = [
    /var\s+contentdate\s*=\s*'((?:[^'\\]|\\.)*)'/,
    /contentdate\s*=\s*'((?:[^'\\]|\\.)*)'/,
    /var\s+contentdate\s*=\s*"((?:[^"\\]|\\.)*)"/,
    /contentdate\s*=\s*"((?:[^"\\]|\\.)*)"/
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m[1]) {
      let content = m[1]
      content = content.replace(/\[!--begin:htmlVideoCode--\][\s\S]*?\[!--end:htmlVideoCode--\]/g, '')
      content = content.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\')
      content = content.replace(/<[^>]+>/g, ' ')
      content = content.replace(/&nbsp;/g, ' ').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, "'")
      content = content.replace(/\s+/g, ' ').trim()
      return content
    }
  }
  const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
    || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i)
  if (metaDesc && metaDesc[1]) return clean(metaDesc[1])
  return ''
}

// ============ 豆瓣结构化 ============
function extractDoubanSubjectId(url) {
  if (!url) return ''
  const m = String(url).match(/subject\/(\d+)/)
  return m ? m[1] : ''
}
async function fetchDoubanStructured(subjectId) {
  if (!subjectId) return {}
  const info = {}
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
      if (Array.isArray(s.directors) && s.directors.length) info.douban_directors = s.directors.join(' / ')
      if (Array.isArray(s.actors) && s.actors.length) info.douban_casts = s.actors.slice(0, 6).join(' / ')
      if (Array.isArray(s.types) && s.types.length) info.douban_genre = s.types.join(' / ')
      if (s.release_year) info.douban_year = String(s.release_year)
      if (s.duration) info.douban_runtime = String(s.duration)
      if (s.episodes_count) info.douban_episodes = String(s.episodes_count)
      if (s.region) info.douban_region = String(s.region)
      if (s.rate) info.rate = String(s.rate)
    }
  } catch (_) {}
  try {
    await primeCookies('m.douban.com', ['https://m.douban.com/movie/'])
    const r = await fetch('https://m.douban.com/movie/subject/' + encodeURIComponent(subjectId) + '/', {
      timeout: DETAIL_TIMEOUT,
      headers: {
        'Referer': 'https://m.douban.com/movie/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
      }
    })
    const html = r.data || ''
    let summary = ''
    // 方案1：文本结构提取
    {
      const text = stripHtml(html)
      const idx1 = text.search(/剧情简介/)
      if (idx1 !== -1) {
        let section = text.slice(idx1).replace(/^剧情简介[\s·*]*/, '')
        const nextSec = section.search(/(演职员|演职人员|短评|影评|剧照|讨论|谁演的|更多\.\.\.|查看全部|广告)/)
        if (nextSec > 0) section = section.slice(0, nextSec)
        section = section.trim()
        if (section.length >= 20) summary = section
      }
    }
    // 方案2：PC 端 v:summary
    if (!summary || summary.length < 20) {
      const bodyM = html.match(/<div[^>]+id=["']link-report["'][^>]*>([\s\S]*?)<\/div>/i)
      if (bodyM && bodyM[1]) {
        const inner = bodyM[1]
        const spanM = inner.match(/<span[^>]+property=["']v:summary["'][^>]*>([\s\S]*?)<\/span>/i)
        if (spanM && spanM[1]) summary = stripHtml(spanM[1]).replace(/\s+/g, ' ').trim()
        else summary = stripHtml(inner).replace(/\s+/g, ' ').trim()
      }
    }
    // 方案3：移动端容器
    if (!summary || summary.length < 20) {
      const introM = html.match(/<div[^>]+class=["'][^"']*(?:subject-intro|subject-info|intro-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)
      if (introM && introM[1]) {
        const t = stripHtml(introM[1]).replace(/\s+/g, ' ').trim()
        if (t.length > summary.length) summary = t
      }
    }
    // 方案4：meta description
    if (!summary || summary.length < 20) {
      const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i)
      if (descM && descM[1]) {
        const raw = clean(descM[1])
        const idx = raw.search(/简介[：:]\s*/)
        summary = idx !== -1 ? raw.slice(idx).replace(/^简介[：:]\s*/, '') : raw.replace(/^.*?豆瓣评分[：:]\s*[\d.]+\s*/, '')
      }
    }
    // 方案5：og:description
    if (!summary) {
      const ogM = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["']/i)
      if (ogM && ogM[1]) summary = clean(ogM[1])
    }
    // 方案6：itemprop
    if (!summary) {
      const ipM = html.match(/<meta[^>]+itemprop=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+itemprop=["']description["']/i)
      if (ipM && ipM[1]) {
        const raw = clean(ipM[1])
        const idx = raw.search(/简介[：:]\s*/)
        summary = idx !== -1 ? raw.slice(idx).replace(/^简介[：:]\s*/, '') : raw
      }
    }
    // 英文简介兜底尝试 PC 页
    if (isMostlyEnglish(summary)) {
      try {
        const pc = await fetch('https://movie.douban.com/subject/' + encodeURIComponent(subjectId) + '/', {
          timeout: DETAIL_TIMEOUT,
          headers: { 'Referer': 'https://movie.douban.com/' }
        })
        const pcHtml = pc.data || ''
        const vsm = pcHtml.match(/<span[^>]+property=["']v:summary["'][^>]*>([\s\S]*?)<\/span>/i)
        if (vsm && vsm[1]) {
          const cnSummary = stripHtml(vsm[1]).replace(/\s+/g, ' ').trim()
          if (cnSummary.length >= 20 && !isMostlyEnglish(cnSummary)) summary = cnSummary
        }
      } catch (_) {}
    }
    summary = summary
      .replace(/\s*广告\s*/g, ' ')
      .replace(/[\uFFFD\uFFFE\uFFFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (summary && summary.length >= 10) {
      info.douban_intro = summary
      info.content_for_item = summary.slice(0, CONTENT_MAX_LEN)
    }
  } catch (_) {}
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
      content: it.content || '',  // 保留 enrichContent 设置的 content
      hot,
      tags: tagsFor(hot, rank),
      url: it.mobilUrl || it.url || '',
      thumb: it.pic || it.cover || it.img || ''
    }
  }).filter(it => it.title)
}

// ============ 各类型源抓取器 ============
const SOURCE_FETCHERS = {
  // 聚合 API：一次请求返回多平台数据
  aggregated_api: async (source) => {
    const { base_url, platform_mapping, field_mapping, field_mapping_per_platform, platform_parsers, url_pattern } = source.config
    const results = {}
    console.log(`[DEBUG] aggregated_api source: ${source.id}, url_pattern: ${url_pattern}`)
    for (const [apiType, platformKey] of Object.entries(platform_mapping)) {
      try {
        // 支持两种 URL 模式：
        // 1. query 参数模式（默认）：base_url?type=apiType
        // 2. 路径模式：base_url/apiType （当 url_pattern === 'path' 时），apiType 为映射后的值
        let url
        if (url_pattern === 'path') {
          // 直接使用 apiType 作为 endpoint（platform_mapping 的 key 即为 API endpoint）
          url = base_url.replace(/\/+$/, '') + '/' + apiType
        } else {
          url = base_url + (base_url.includes('?') ? '&' : '?') + 'type=' + encodeURIComponent(apiType)
        }
        console.log(`[DEBUG] ${source.id} ${apiType} -> ${url}`)
        const r = await fetch(url, { timeout: globalConfig.timeout || 15000 })
        const j = JSON.parse(r.data)
        const list = j.data || j.list || j.result || []
        console.log(`[DEBUG] ${source.id} ${apiType} got ${list.length} items`)
        
        // 优先使用平台专用解析器，其次用字段映射
        const parser = platform_parsers?.[apiType]
        const perPlatformMapping = field_mapping_per_platform?.[apiType] || field_mapping
        
        let mapped = []
        if (parser && typeof parser === 'function') {
          // 使用自定义解析器
          mapped = list.map((it, i) => parser(it, i)).filter(Boolean)
        } else {
          // 使用字段映射
          mapped = list.map((it, i) => {
            const title = clean(it[perPlatformMapping?.title || 'title'] || it[perPlatformMapping?.name || 'name'])
            if (!title) return null
            return {
              index: it[perPlatformMapping?.rank || 'index'] || i + 1,
              title,
              desc: clean(it[perPlatformMapping?.desc || 'desc'] || it[perPlatformMapping?.excerpt || 'excerpt'] || ''),
              pic: it[perPlatformMapping?.cover || 'pic'] || it[perPlatformMapping?.img || 'img'] || it[perPlatformMapping?.thumb || 'thumb'] || '',
              hot: it[perPlatformMapping?.hot || 'hot'] ? String(it[perPlatformMapping.hot]) : '',
              url: it[perPlatformMapping?.url || 'url'] || it[perPlatformMapping?.link || 'link'] || '',
              mobilUrl: it[perPlatformMapping?.mobilUrl || 'mobilUrl'] || it[perPlatformMapping?.url || 'url'] || it[perPlatformMapping?.link || 'link'] || ''
            }
          }).filter(Boolean)
        }
        if (mapped.length) results[platformKey] = mapped
      } catch (e) {
        console.error(`  ✗ ${source.id} ${apiType}: ${e.message}`)
      }
    }
    return results
  },

  // RSS 源
  rss: async (source) => {
    const { url, field_mapping } = source.config
    try {
      const r = await fetch(url, { timeout: globalConfig.timeout || 15000 })
      const xml = r.data
      // 简单的 RSS 解析（item 标签）
      const items = []
      const itemRegex = /<item[\s\S]*?<\/item>/gi
      let m
      while ((m = itemRegex.exec(xml)) && items.length < 50) {
        const itemXml = m[0]
        const getTag = (tag) => {
          // 支持命名空间标签如 content:encoded
          const re = new RegExp('<' + tag.replace(':', '\\:') + '[^>]*>([\\s\\S]*?)<\\/' + tag.replace(':', '\\:') + '>', 'i')
          const mm = itemXml.match(re)
          return mm ? mm[1] : ''
        }
        const title = clean(getTag(field_mapping?.title || 'title'))
        if (!title) continue
        items.push({
          index: items.length + 1,
          title,
          desc: clean(getTag(field_mapping?.desc || 'description') || getTag('summary') || ''),
          content: clean(getTag(field_mapping?.content || 'content:encoded') || getTag('content') || ''),
          url: clean(getTag(field_mapping?.url || 'link') || getTag('guid') || ''),
          pubDate: getTag(field_mapping?.pub_date || 'pubDate') || '',
          author: getTag(field_mapping?.author || 'author') || ''
        })
      }
      console.log(`  ✓ ${source.id}: ${items.length} 条`)
      return { [source.platforms?.[0] || 'rss']: items }
    } catch (e) {
      console.error(`  ✗ ${source.id}: ${e.message}`)
      return {}
    }
  },

  // HTML 抓取（复用原有 fetch.js 的 FETCHERS 逻辑）
  html_scrape: async (source) => {
    const { parser } = source.config
    const platformKey = source.platforms?.[0]
    if (!platformKey || !parser) return {}
    
    // 根据 parser 类型调用对应的抓取逻辑
    try {
      let items = []
      switch (parser) {
        case 'tieba_json':
          items = await fetchTieba()
          break
        case 'sspai_json':
          items = await fetchSspai()
          break
        case 'hupu_html':
          items = await fetchHupu()
          break
        case 'ithome_html':
          items = await fetchIthome()
          break
        case 'cctv_js_variable':
          items = await fetchCctv()
          break
      }
      return items.length ? { [platformKey]: items } : {}
    } catch (e) {
      console.error(`  ✗ ${source.id} ${platformKey}: ${e.message}`)
      return {}
    }
  },

  // 静态文件
  static: async (source) => {
    const { files } = source.config
    const results = {}
    for (const [platformKey, filePath] of Object.entries(files)) {
      const fullPath = path.resolve(__dirname, '..', filePath)
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8')
          const j = JSON.parse(content)
          if (j.data && j.data.length) {
            results[platformKey] = j.data
            console.log(`  ✓ ${source.id} ${platformKey}: ${j.data.length} 条（静态）`)
          }
        }
      } catch (e) {
        console.error(`  ✗ ${source.id} ${platformKey}: ${e.message}`)
      }
    }
    return results
  }
}

// ============ HTML 抓取复用函数（从原 fetch.js 迁移） ============
async function fetchTieba() {
  const r = await fetch('https://tieba.baidu.com/hottopic/browse/topicList?topic_id=0')
  const j = JSON.parse(r.data)
  const list = (j.data && j.data.bang_topic && j.data.bang_topic.topic_list) || []
  return list.map((it, i) => ({
    index: i + 1,
    title: clean(it.topic_name || ''),
    desc: clean(it.topic_desc || it.abstract || ''),
    pic: it.topic_pic || '',
    hot: it.discuss_num ? String(it.discuss_num) : '',
    url: clean((it.topic_url || '').replace(/&/g, '&')),
    mobilUrl: clean((it.topic_url || '').replace(/&/g, '&'))
  })).filter(it => it.title)
}

async function fetchSspai() {
  const r = await fetch('https://sspai.com/api/v1/articles?limit=30', { timeout: 20000 })
  const j = JSON.parse(r.data)
  const list = j.list || []
  return list.map((it, i) => ({
    index: i + 1,
    title: clean(it.title || ''),
    desc: clean(it.summary || ''),
    pic: it.banner ? ('https://cdn.sspai.com/' + it.banner) : '',
    hot: it.likes ? String(it.likes) : (it.views_count ? String(it.views_count) : ''),
    url: 'https://sspai.com/post/' + it.id,
    mobilUrl: 'https://sspai.com/post/' + it.id
  })).filter(it => it.title)
}

async function fetchHupu() {
  const r = await fetch('https://bbs.hupu.com/topic-daily')
  const html = r.data
  const items = []
  const reg = /<a[^>]+href="(\/\d+\.html)"[^>]*>([^<]{4,})<\/a>/g
  let m
  while ((m = reg.exec(html)) && items.length < 30) {
    const url = 'https://bbs.hupu.com' + m[1]
    const title = clean(m[2] || '')
    if (!title) continue
    if (items.some(x => x.url === url)) continue
    const beforeHtml = html.slice(Math.max(0, m.index - 200), m.index)
    const imgM = beforeHtml.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/i)
    items.push({ index: items.length + 1, title, desc: '', pic: imgM ? imgM[1] : '', hot: '', url, mobilUrl: url })
  }
  if (!items.length) throw new Error('虎扑解析失败')
  return items
}

async function fetchIthome() {
  const r = await fetch('https://m.ithome.com/', { timeout: 20000 })
  const html = r.data || ''
  const items = []
  const reg = /<a[^>]+href="(https:\/\/m\.ithome\.com\/html\/\d+\.htm)"[^>]*>([\s\S]*?)<\/a>/g
  let m
  while ((m = reg.exec(html)) && items.length < 30) {
    const url = m[1]
    const inner = m[2] || ''
    const title = clean(stripHtml(inner).replace(/\s+/g, ' ').trim())
    if (!title || title.length < 4) continue
    if (title.includes('广告')) continue
    const cleanTitle = title
      .replace(/\s*\d{1,2}:\d{2}\s*/g, ' ')
      .replace(/\s*\d+评\s*/g, ' ')
      .replace(/\s*视频\d+评\s*/g, ' ')
      .replace(/\s+/g, ' ').trim()
    if (!cleanTitle || cleanTitle.length < 4) continue
    if (items.some(x => x.url === url)) continue
    const beforeHtml = html.slice(Math.max(0, m.index - 300), m.index)
    const imgM = beforeHtml.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/i)
    items.push({ index: items.length + 1, title: cleanTitle, desc: '', pic: imgM ? imgM[1] : '', hot: '', url, mobilUrl: url })
  }
  if (items.length < 10) {
    const reg2 = /<a[^>]+href="(https:\/\/www\.ithome\.com\/0\/\d+\/\d+\.htm)"[^>]*>([^<]{4,})<\/a>/g
    while ((m = reg2.exec(html)) && items.length < 30) {
      const url = m[1]
      const title = clean((m[2] || '').replace(/<[^>]+>/g, '').trim())
      if (!title || title.length < 4) continue
      if (items.some(x => x.url === url)) continue
      const beforeHtml = html.slice(Math.max(0, m.index - 300), m.index)
      const imgM = beforeHtml.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/i)
      items.push({ index: items.length + 1, title, desc: '', pic: imgM ? imgM[1] : '', hot: '', url, mobilUrl: url })
    }
  }
  if (!items.length) throw new Error('IT之家解析失败')
  return items
}

async function fetchCctv() {
  const r = await fetch('https://news.cctv.com/')
  const html = r.data
  const items = []
  const reg = /href="(https:\/\/news\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/ARTI[\w-]+\.shtml)"[^>]*>([\s\S]{4,200}?)<\/a>/g
  let m
  while ((m = reg.exec(html)) && items.length < 30) {
    const url = m[1]
    const title = clean((m[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    if (!title || title.length < 4) continue
    if (/VIDEO|video/i.test(url)) continue
    if (items.some(x => x.url === url)) continue
    const beforeHtml = html.slice(Math.max(0, m.index - 300), m.index)
    const imgM = beforeHtml.match(/<img[^>]+src="([^"]+\.(?:jpg|jpeg|png|webp))"/i)
    items.push({ index: items.length + 1, title, desc: '', pic: imgM ? imgM[1] : '', hot: '', url, mobilUrl: url })
  }
  if (!items.length) throw new Error('央视解析失败')
  return items
}

// ============ 正文抓取 ============
// 平台分级（内部使用，决定抓取策略和兜底文案）
const PLATFORM_TIER = {
  // Tier 1: 可完整抓取正文
  FULL: ['tieba', 'hupu', 'cctv', 'sspai', 'ithome', '36kr', 'huxiu', 'infoq', 'juejin', 'baidu', 'arxiv'],
  // Tier 2: 仅结构化数据（豆瓣）
  STRUCTURED: ['douban', 'doubanhot', 'doubantv', 'doubannew', 'doubanscore'],
  // Tier 3: 无正文/视频/强反爬，只能引导跳转
  LINK_ONLY: ['weibo', 'zhihu', 'toutiao', 'douyin', 'bilibili', 'weixin', 'github_trending', 'v2ex']
}

const SKIP_URL_PLATFORMS = ['github_trending', 'arxiv', 'v2ex']  // 这些平台无文章 URL 或纯 API
const CLEAN_PLATFORMS = ['tieba', 'hupu', 'cctv', 'sspai', 'ithome', '36kr', 'huxiu', 'infoq', 'juejin']

// 无法抓取正文的平台友好提示（面向用户直接展示）
const FALLBACK_MESSAGES = {
  weibo: '微博热搜无法直接获取正文（反爬限制）。可点击下方「原文链接」在微博 App/浏览器查看完整内容。',
  zhihu: '知乎热榜无法直接获取正文（反爬限制）。可点击下方「原文链接」在知乎 App/浏览器查看完整内容。',
  toutiao: '头条热榜无法直接获取正文（反爬限制）。可点击下方「原文链接」在头条 App/浏览器查看完整内容。',
  baidu: '百度热搜无法直接获取正文（反爬限制）。可点击下方「原文链接」在百度 App/浏览器查看完整内容。',
  douyin: '抖音热榜为短视频内容，无文字正文。可点击下方「原文链接」在抖音 App 观看视频。',
  bilibili: 'B站热榜为视频内容，无文字正文。可点击下方「原文链接」在哔哩哔哩 App/网页观看视频。',
  weixin: '微信热文需在微信内打开。可点击下方「原文链接」复制后在微信中打开阅读。',
  github_trending: 'GitHub Trending 无详情页正文。可点击下方「原文链接」在 GitHub 查看项目详情。',
  v2ex: 'V2EX 热榜无详情页正文。可点击下方「原文链接」在 V2EX 查看完整帖子。',
  douban: '豆瓣条目包含评分、导演、演员等结构化信息。如需查看完整影评/简介，请点击下方「原文链接」在豆瓣 App/网页查看。'
}

// 判断平台分级
function getPlatformTier(platform) {
  if (PLATFORM_TIER.FULL.includes(platform)) return 'full'
  if (PLATFORM_TIER.STRUCTURED.includes(platform)) return 'structured'
  if (PLATFORM_TIER.LINK_ONLY.includes(platform)) return 'link_only'
  return 'full'  // 默认尝试抓取
}

// 带重试的 fetch
async function fetchWithRetry(url, options = {}, retries = DETAIL_RETRY) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, options)
    } catch (e) {
      if (i === retries) throw e
      // 指数退避
      await new Promise(r => setTimeout(r, 500 * (i + 1)))
    }
  }
}

async function enrichContent(platform, items) {
  const top = items.slice(0, DETAIL_TOP_N)
  const rest = items.slice(DETAIL_TOP_N)
  const isDouban = ['douban', 'doubanhot', 'doubantv', 'doubannew', 'doubanscore'].includes(platform)
  const skipUrl = SKIP_URL_PLATFORMS.includes(platform)
  const needClean = CLEAN_PLATFORMS.includes(platform)
  const tier = getPlatformTier(platform)

  const results = await mapWithConcurrency(top, DETAIL_CONCURRENCY, async (it) => {
    if (isDouban) {
      const sid = (it && it.douban_id) || extractDoubanSubjectId(it.url)
      const info = await fetchDoubanStructured(sid)
      if (!info.rate && it && it.rate) info.rate = it.rate
      const body = (info.content_for_item || '').slice(0, CONTENT_MAX_LEN)
      delete info.content_for_item
      return Object.assign({ content: body }, info)
    }
    // LINK_ONLY 平台：直接返回兜底文案，不尝试抓取
    if (tier === 'link_only') return { content: FALLBACK_MESSAGES[platform] || '' }
    if (skipUrl) return { content: FALLBACK_MESSAGES[platform] || '' }
    if (!it.url) return { content: '' }
    try {
      const r = await fetchWithRetry(it.url, { timeout: DETAIL_TIMEOUT })
      let content
      if (platform === 'cctv') {
        content = extractCctvContent(r.data || '')
      } else {
        content = extractContentFromHtml(r.data || '', platform)
      }
      content = content.slice(0, CONTENT_MAX_LEN)
      if (needClean && content) content = cleanContent(content)
      return { content }
    } catch (_) {
      return { content: '' }
    }
  })

  top.forEach((it, i) => {
    const r = results[i] || {}
    if (isDouban) {
      // 豆瓣：将结构化字段拼成可读文本
      const parts = []
      if (r.rate) parts.push(`⭐ ${r.rate}/10`)
      if (r.douban_directors) parts.push(`导演: ${r.douban_directors}`)
      if (r.douban_casts) parts.push(`主演: ${r.douban_casts}`)
      if (r.douban_genre) parts.push(`类型: ${r.douban_genre}`)
      if (r.douban_year) parts.push(`年份: ${r.douban_year}`)
      if (r.douban_runtime) parts.push(`片长: ${r.douban_runtime}`)
      if (r.douban_episodes) parts.push(`集数: ${r.douban_episodes}`)
      if (r.douban_region) parts.push(`地区: ${r.douban_region}`)
      if (r.douban_intro) parts.push(r.douban_intro.slice(0, 500))
      it.content = parts.join('\n\n') || it.excerpt || it.title || FALLBACK_MESSAGES[platform] || ''
      // 保留结构化字段供前端使用
      if (r.douban_directors) it.douban_directors = r.douban_directors
      if (r.douban_casts) it.douban_casts = r.douban_casts
      if (r.douban_genre) it.douban_genre = r.douban_genre
      if (r.douban_year) it.douban_year = r.douban_year
      if (r.douban_runtime) it.douban_runtime = r.douban_runtime
      if (r.douban_episodes) it.douban_episodes = r.douban_episodes
      if (r.douban_region) it.douban_region = r.douban_region
      if (r.rate) it.rate = r.rate
    } else if (tier === 'link_only') {
      // LINK_ONLY 平台：结果已经是兜底文案
      it.content = r.content || FALLBACK_MESSAGES[platform] || ''
    } else {
      let c = (r && r.content) || ''
      // 优先级：抓取到的正文 > excerpt > desc > FALLBACK_MESSAGE > title
      if (!c || c.length < 20) {
        c = it.excerpt || it.desc || FALLBACK_MESSAGES[platform] || it.title || ''
      }
      it.content = c
    }
  })
  rest.forEach(it => {
    // 剩余条目同样兜底
    if (!it.content || it.content.length < 20) {
      const tier = getPlatformTier(platform)
      if (tier === 'link_only') {
        it.content = FALLBACK_MESSAGES[platform] || ''
      } else {
        it.content = it.excerpt || it.desc || FALLBACK_MESSAGES[platform] || it.title || ''
      }
    }
  })
  return items
}

// ============ 合并去重 ============
function mergePlatformData(platformKey, allData, mergeConfig) {
  // allData: { sourceId: [items...] }
  const items = []
  for (const sourceItems of Object.values(allData)) {
    items.push(...sourceItems)
  }
  if (!items.length) return []

  const { dedup_strategy, similarity_threshold, max_per_platform } = mergeConfig
  
  if (dedup_strategy === 'title_similarity') {
    // 简单去重：按标题相似度
    const unique = []
    for (const item of items) {
      let isDup = false
      for (const u of unique) {
        if (similarity(item.title, u.title) >= similarity_threshold) {
          isDup = true
          break
        }
      }
      if (!isDup) unique.push(item)
    }
    return unique.slice(0, max_per_platform)
  }
  return items.slice(0, max_per_platform)
}

function similarity(a, b) {
  // 简单的编辑距离相似度
  const s1 = a.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '')
  const s2 = b.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '')
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  // 简单包含判断
  if (s1.includes(s2) || s2.includes(s1)) return 0.9
  // 公共子串长度 / 最大长度
  let maxLen = 0
  for (let i = 0; i < s1.length; i++) {
    for (let j = 0; j < s2.length; j++) {
      let k = 0
      while (i + k < s1.length && j + k < s2.length && s1[i + k] === s2[j + k]) k++
      if (k > maxLen) maxLen = k
    }
  }
  return maxLen / Math.max(s1.length, s2.length)
}

// ============ 写文件 ============
function writeFile(filepath, content) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, content, 'utf8')
}

// ============ 主流程 ============
async function main() {
  console.log('=== 开始抓取热搜数据 (配置驱动 v2.3) ===')
  console.log('Time:', new Date().toISOString())
  console.log('Output dir:', OUTPUT_DIR)
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const sources = getEnabledSources(config)
  const platforms = getPlatforms(config)
  const mergeConfig = config.merge || {}

  console.log('启用源数:', sources.length)
  console.log('平台数:', platforms.length)

  // 按平台分组收集数据
  const platformData = {}

  for (const source of sources) {
    console.log('\n抓取源:', source.id, '(', source.type, ')')
    try {
      const fetcher = SOURCE_FETCHERS[source.type]
      if (!fetcher) {
        console.log('  ⚠ 未实现的源类型:', source.type)
        continue
      }
      const result = await fetcher(source)
      for (const [platformKey, items] of Object.entries(result)) {
        if (!platformData[platformKey]) platformData[platformKey] = {}
        platformData[platformKey][source.id] = items
        console.log(`  ✓ ${platformKey}: ${items.length} 条`)
      }
    } catch (err) {
      console.error(`  ✗ ${source.id}: ${err.message}`)
    }
  }

  // 合并去重 + 正文抓取
  const finalResults = {}
  const meta = {
    version: '2.3',
    update_time: new Date().toISOString(),
    platforms: []
  }

  for (const platform of platforms) {
    const key = platform.key
    const sourceData = platformData[key] || {}
    const totalItems = Object.values(sourceData).flat().length
    if (!totalItems) {
      console.log(`\n${key}: 无数据，跳过`)
      meta.platforms.push({ key, success: false, count: 0 })
      continue
    }

    console.log(`\n合并去重 ${key} (${totalItems} 条原始)...`)
    let merged = mergePlatformData(key, sourceData, mergeConfig)
    console.log(`  合并后: ${merged.length} 条`)

    // 正文抓取
    try {
      console.log(`正文抓取 ${key}...`)
      await enrichContent(key, merged)
      const withContent = merged.filter(x => x.content && x.content.length >= 20).length
      const infoFields = merged.filter(x => x.douban_directors || x.douban_casts).length
      const isDouban = ['douban', 'doubanhot', 'doubantv', 'doubannew', 'doubanscore'].includes(key)
      console.log(`  ✓ ${key} 正文已填充（${withContent}/${merged.length} 条有正文）${isDouban ? '（结构化 ' + infoFields + '/' + merged.length + ' 条）' : ''}`)
    } catch (err) {
      console.error(`  ✗ ${key} 正文抓取失败: ${err.message}`)
    }

    // 归一化输出
    const normalized = norm(merged, key)
    finalResults[key] = {
      success: true,
      platform: key,
      update_time: new Date().toISOString(),
      count: normalized.length,
      data: normalized
    }
    meta.platforms.push({ key, success: true, count: normalized.length })

    // 写文件
    const filepath = path.join(OUTPUT_DIR, key + '.json')
    writeFile(filepath, JSON.stringify(finalResults[key], null, 2))
  }

  // 写 _meta.json
  writeFile(path.join(OUTPUT_DIR, '_meta.json'), JSON.stringify(meta, null, 2))

  console.log('\n=== 完成 ===')
  console.log('OK:', meta.platforms.filter(p => p.success).length, '/', meta.platforms.length)
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
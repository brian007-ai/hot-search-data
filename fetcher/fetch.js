/**
 * ä»æ¥ç­ææ¦ - çäº§çæåèæ¬ï¼v2.2 Â· è±ç£åç¬çªç ´ï¼
 *
 * v2.2 å³é®æ¹å¨ï¼
 *   - æ°å¢ Cookie Jarï¼æ hostname ä½ç¨åï¼ï¼è¯·æ± movie.douban.com / m.douban.com åå Prime
 *     Cookieï¼é¿å subject_abstract / ç§»å¨ç«¯è¯¦æ 302 å°å®å¨æ ¡éªé¡µ
 *   - è±ç£çµå½±/å§éè¯¦ææ¹ä¸ºï¼subject_abstract JSONï¼ç´æ¥æ¿ directors/actors/types/release_year/
 *     duration/rate/episodes_count çº¯ç»æåï¼ + ç§»å¨ç«¯ m.douban.com è¯¦æé¡µ meta description
 *     æ½å§æç®ä»ï¼ä¸åä¾èµ PC è¯¦æé¡µ v:directedBy æ ç­¾ï¼è¢« WAF æ¦æªï¼
 *   - éç¨ fetch() èªå¨å¸¦å½å host ç Cookie header + ä¿å­ set-cookie + è·é 30x
 *
 * å¶å®è®¾è®¡ååï¼ä¸åï¼ï¼
 *   1. å®å¨ç¨³å®ä¼åï¼åå¹³å°å¤±è´¥ä¸å½±åæ´ä½ï¼
 *   2. æååè¡¨ + åææ­£æï¼æ¹æ¡ Dï¼æ¾æ­£æå®¹å¨åå®æ´æ®µè½ï¼
 *   3. åªä¿çæå­ï¼åè¡¨éç thumb/cover ä¿çï¼è±ç£æ¡ç®åç¬ç»æåï¼
 *   4. è¾åºå°æ¬å° data/*.jsonï¼ç± workflow commit å°ä»åº
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

// ============ éç½® ============
const OUTPUT_DIR = path.resolve(__dirname, '..', 'data')
const DETAIL_TOP_N = 20        // æ¯ä¸ªå¹³å°å¯¹å N æ¡æåæ­£æï¼å«è±ç£ç»æå/ç®ä»ï¼
const DETAIL_CONCURRENCY = 5   // æ­£ææåå¹¶åæ°
const DETAIL_TIMEOUT = 8000    // åæ¡æ­£ææåè¶æ¶ï¼æ¯«ç§ï¼
const CONTENT_MAX_LEN = 3000   // åæ¡æ­£ææå¤§å­æ°

// ============ Cookie Jarï¼æ hostname ä½ç¨åï¼ ============
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
// Primeï¼é¢ç­ Cookieï¼é²æ­¢è±ç£é¦æ¬¡è¯·æ± 302 å®å¨æ ¡éª
async function primeCookies(host, urls) {
  for (const u of urls) {
    try { await fetch(u, { timeout: 10000 }); break } catch (_) {}
  }
  return !!_cookieHeader(host)
}

// ============ éç¨è¯·æ±ï¼èªå¨å¸¦ Cookie + è·é 30xï¼ ============
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

// ============ å·¥å·å½æ° ============
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
// æ¸æ´æåå°çæ­£æï¼å»é¤é¡µé¢å¯¼èªãç¨æ·è¯è®ºç­åªé³
function cleanContent(s) {
  if (!s) return ''
  let t = s
    // è´´å§é¡µé¢åªé³
    .replace(/å§åæç´¢\s*æè´´\s*æäºº\s*è¿å§\s*ææ ç­¾/g, '')
    .replace(/è´´å§ç¨æ·_\w+/g, '')
    .replace(/æ¥èª\s+\S+å§/g, '')
    // èæé¡µé¢åªé³
    .replace(/äº®äº\(\s*\d+\s*\)\s*åå¤/g, '')
    .replace(/ç¹ç­\s*åªçæ­¤äºº\s*ä¸¾æ¥/g, '')
    .replace(/å«AIçæåå®¹/g, '')
    .replace(/æ·±è/g, '')
    .replace(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g, '')
    .replace(/åå¸äº[\s\S]*?(?=\n)/g, '')
    .replace(/\d+\s*æ¥¼\s*/g, '')
    .replace(/æ¥çè¯è®º\(\s*\d+\s*\)/g, '')
    .replace(/å¼ç¨åå®¹ç±äºè¿è§å·²è¢«å é¤/g, '')
    // èæé¡µè
    .replace(/ç¤¾åº\s*Â»[\s\S]*?(?=\n|$)/g, '')
    .replace(/èæé¦é¡µ[\s\S]*?(?:çæææ|All Rights Reserved)/g, '')
    .replace(/ç­é¨æ¸¸æ[\s\S]*?(?=\n|$)/g, '')
    .replace(/FIFPRO[\s\S]*?(?=\n|$)/g, '')
    .replace(/ç¾èç¯®ç¯®çä¸ç/g, '')
    .replace(/ä¸çå¤§èµ[\s\S]*?(?=\n|$)/g, '')
    .replace(/NBAå®æ¹æ­£çææ[\s\S]*?(?=\n|$)/g, '')
    // å¤®è§é¡µè
    .replace(/å¤®è§ç½[\s\S]*?(?:çæææ|All Rights Reserved)/g, '')
    // éç¨åªé³
    .replace(/ç¼è¾[:ï¼]\s*\S+/g, '')
    .replace(/æ¥æº[:ï¼]\s*\S+/g, '')
    // æ¸çå¤ä½ç©ºç½
    .replace(/\n{3,}/g, '\n\n')
    .replace(/  +/g, ' ')
  return t.trim()
}
function parseHot(hotStr) {
  if (!hotStr) return 0
  const s = String(hotStr).replace(/[,ï¼\s]/g, '')
  const m = s.match(/^([\d.]+)\s*(äº¿|ä¸|å)?$/)
  if (!m) return 0
  let n = parseFloat(m[1])
  if (m[2] === 'äº¿') n *= 100000000
  else if (m[2] === 'ä¸') n *= 10000
  else if (m[2] === 'å') n *= 1000
  return isNaN(n) ? 0 : n
}
function tagsFor(hotStr, rank) {
  const tags = []
  const n = parseHot(hotStr)
  if (n >= 1000000) tags.push('ç')
  else if (n >= 100000) tags.push('æ²¸')
  else if (n >= 10000) tags.push('ç­')
  if (!tags.length && rank <= 3) tags.push('ç­è®®')
  return tags
}

// ============ æ¹æ¡ Dï¼æ­£æåææåï¼æ¾å®¹å¨ â åæ®µè½ â meta ååºï¼ ============
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

// ============ è±ç£ï¼æ¿ subject_id ä» URL ============
function extractDoubanSubjectId(url) {
  if (!url) return ''
  const m = String(url).match(/subject\/(\d+)/)
  return m ? m[1] : ''
}

/**
 * è±ç£çµå½±/å§éç»æåæåï¼v2.2 æ°ç Â· åç¬åå¥½ï¼
 *  â  JSON ç»æå â /j/subject_abstract?subject_id=ID
 *     directors actors types release_year duration rate episodes_count region
 *  â¡ å§æç®ä» â m.douban.com/movie/subject/{ID}/ meta name="description"
 *    ä¾ï¼"æç¹å¡è±ç£è¯åï¼7.4 ç®ä»ï¼ä¸åºè­¦å¯ä¸ç¹å¡..."ï¼ä¸­æåå·"ç®ä»ï¼"ä¹åå¨æ¯å§æç®ä»ï¼
 *    meta description æ¯è±ç£å®æ¹æªåï¼è·¨ PC/ç§»å¨ä¸è´æ§æå¥½ï¼
 */
async function fetchDoubanStructured(subjectId) {
  if (!subjectId) return {}
  const info = {}

  // ---- â  subject_abstract çº¯ JSONï¼å«å¯¼æ¼/ä¸»æ¼/ç±»å/å¹´ä»½/çé¿/è¯å/éæ°ï¼ ----
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
  } catch (_) { /* abstract å¤±è´¥ä¸å½±åï¼ç»§ç»­å°è¯ç®ä» */ }

  // ---- â¡ å§æç®ä»ï¼ä¼åç¨ ç§»å¨ç«¯è¯¦æé¡µ meta descriptionï¼ ----
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
      // æ ¼å¼ï¼"XXXè±ç£è¯åï¼x.x ç®ä»ï¼..." æ "XXXè¯å x.x ç®ä»ï¼..."
      const raw = clean(descM[1])
      const idx = raw.search(/ç®ä»[ï¼:]\s*/)
      if (idx !== -1) {
        summary = raw.slice(idx).replace(/^ç®ä»[ï¼:]\s*/, '')
      } else {
        // æ²¡æ"ç®ä»ï¼"æ ç­¾å°±éåä¸ºæ´æ®µ description å»æå¼å¤´è¯ååç¼
        summary = raw.replace(/^.*?è±ç£è¯å[ï¼:]\s*[\d.]+\s*/, '')
      }
    }
    if (!summary) {
      const ogM = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["']/i)
      if (ogM && ogM[1]) summary = clean(ogM[1])
    }
    // ååºåå°è¯ itemprop description
    if (!summary) {
      const ipM = html.match(/<meta[^>]+itemprop=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
        || html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+itemprop=["']description["']/i)
      if (ipM && ipM[1]) {
        const raw = clean(ipM[1])
        const idx = raw.search(/ç®ä»[ï¼:]\s*/)
        summary = idx !== -1 ? raw.slice(idx).replace(/^ç®ä»[ï¼:]\s*/, '') : raw
      }
    }
    summary = clean(summary)
    if (summary && summary.length >= 10) {
      info.douban_intro = summary
      info.content_for_item = summary.slice(0, CONTENT_MAX_LEN)
    }
  } catch (_) { /* ç®ä»æåå¤±è´¥ä¿çå·²æå­æ®µ */ }

  return info
}

// ============ å¹¶åæ§å¶ ============
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

// ============ å½ä¸å ============
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

// ============ åå¹³å° Fetcher ============
const FETCHERS = {
  baidu: async () => {
    const r = await fetch('https://top.baidu.com/api/board?platform=pc&tab=realtime')
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
      desc: (it.desc || it.abs || it.show || '').trim(),
      pic: it.img || '',
      hot: it.hotScore ? String(it.hotScore) : '',
      url: it.rawUrl || it.url || '',
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
      desc: (it.event_description || it.word_desc || it.description || '').trim(),
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
      desc: clean((it.ClipInfo && (it.ClipInfo.AbsText || it.ClipInfo.Description)) || it.Description || it.Abstract || ''),
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
    const r = await fetch('https://sspai.com/api/v1/articles?limit=30', { timeout: 20000 })
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
    if (!items.length) throw new Error('èæè§£æå¤±è´¥')
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
    if (!items.length) throw new Error('å¤®è§è§£æå¤±è´¥')
    return items
  },

  douban: async () => {
    // prime è±ç£ cookieï¼PC+ç§»å¨åç«¯ï¼ï¼ä¸ºåç»­è¯¦æååå¤
    primeCookies('movie.douban.com', ['https://movie.douban.com/']).catch(() => {})
    primeCookies('m.douban.com',     ['https://m.douban.com/movie/']).catch(() => {})
    const r = await fetch('https://movie.douban.com/j/search_subjects?type=movie&tag=ç­é¨&page_limit=20&page_start=0', {
      headers: { 'Referer': 'https://movie.douban.com/' }
    })
    const j = JSON.parse(r.data)
    const list = j.subjects || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.title || '').trim(),
      desc: it.rate ? 'è¯å ' + it.rate : '',
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
    const r = await fetch('https://movie.douban.com/j/search_subjects?type=tv&tag=ç­é¨&page_limit=20&page_start=0', {
      headers: { 'Referer': 'https://movie.douban.com/' }
    })
    const j = JSON.parse(r.data)
    const list = j.subjects || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.title || '').trim(),
      desc: (it.episodes_info || '') + (it.rate ? ' è¯å ' + it.rate : ''),
      pic: it.cover || '',
      hot: it.rate || '',
      rate: it.rate || '',
      url: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      mobilUrl: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      douban_id: String(it.id || '')
    })).filter(it => it.title)
  }
}

// ============ æ­£ææåï¼æ¹æ¡ Dï¼åå¹³å°ç­ç¥ï¼ ============
// æç´¢é¡µå¹³å°ï¼URL æ¯æç´¢/è¶å¿é¡µï¼æ æ³æåæ­£æï¼ç´æ¥ç¨ API æè¿°ååº
const SKIP_URL_PLATFORMS = ['douyin']
// æ­£æéè¦æ¸æ´åªé³çå¹³å°
const CLEAN_PLATFORMS = ['tieba', 'hupu', 'cctv', 'sspai']

async function enrichContent(platform, items) {
  const top = items.slice(0, DETAIL_TOP_N)
  const rest = items.slice(DETAIL_TOP_N)
  const isDouban = (platform === 'douban' || platform === 'doubantv')
  const skipUrl = SKIP_URL_PLATFORMS.includes(platform)
  const needClean = CLEAN_PLATFORMS.includes(platform)

  const results = await mapWithConcurrency(top, DETAIL_CONCURRENCY, async (it) => {
    // ---- è±ç£ï¼ç»æå JSON + ç§»å¨ç«¯å§æç®ä» ----
    if (isDouban) {
      const sid = (it && it.douban_id) || extractDoubanSubjectId(it.url)
      const info = await fetchDoubanStructured(sid)
      if (!info.rate && it && it.rate) info.rate = it.rate
      const body = (info.content_for_item || '').slice(0, CONTENT_MAX_LEN)
      delete info.content_for_item
      return Object.assign({ content: body }, info)
    }
    // ---- æç´¢é¡µå¹³å°ï¼è·³è¿ URL æåï¼æç´¢é¡µæ æ³æåæ­£æï¼ ----
    if (skipUrl) return { content: '' }
    // ---- å¸¸è§æ­£ææåï¼æ¹æ¡ Dï¼ ----
    if (!it.url) return { content: '' }
    try {
      const r = await fetch(it.url, { timeout: DETAIL_TIMEOUT })
      let content = extractContentFromHtml(r.data || '').slice(0, CONTENT_MAX_LEN)
      if (needClean && content) content = cleanContent(content)
      return { content }
    } catch (_) {
      return { content: '' }
    }
  })

  top.forEach((it, i) => {
    const r = results[i] || {}
    if (isDouban) {
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
      let c = (r && r.content) || ''
      // ååºé¾ï¼æå°çæ­£æ â API excerpt â æ é¢
      if (!c || c.length < 20) c = it.excerpt || ''
      if (!c && it.title) c = it.title
      it.content = c
    }
  })
  rest.forEach(it => {
    if (!it.content || it.content.length < 20) it.content = it.excerpt || ''
    if (!it.content && it.title) it.content = it.title
  })
  return items
}

// ============ è¾åº ============
function writeFile(filepath, content) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, content, 'utf8')
}

// ============ ä¸»æµç¨ ============
async function main() {
  console.log('=== å¼å§æåç­ææ°æ® ===')
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
      console.log('æå ' + key + '...')
      const raw = await FETCHERS[key]()
      const items = norm(raw, key)
      if (!items.length) throw new Error('ç©ºæ°æ®')
      results[key] = items
      console.log('  â ' + key + ': ' + items.length + ' æ¡')
    } catch (err) {
      console.error('  â ' + key + ': ' + (err.message || err))
      results[key] = null
    }
  }

  for (const key of platforms) {
    if (!results[key]) continue
    try {
      console.log('æ­£ææå ' + key + '...')
      await enrichContent(key, results[key])
      const withContent = results[key].filter(x => x.content && x.content.length >= 20).length
      const infoFields = results[key].filter(x => x.douban_directors || x.douban_casts).length
      const extraLine = (key === 'douban' || key === 'doubantv')
        ? 'ï¼ç»æå ' + infoFields + '/' + results[key].length + ' æ¡ï¼'
        : ''
      console.log('  â ' + key + ' æ­£æå·²å¡«åï¼' + withContent + '/' + results[key].length + ' æ¡ææ­£æï¼' + extraLine)
    } catch (err) {
      console.error('  â ' + key + ' æ­£ææåå¤±è´¥: ' + (err.message || err))
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
  console.log('=== å®æ ===')
  console.log('OK: ' + okCount + '/' + platforms.length)
  console.log('å¤±è´¥å¹³å°: ' + meta.platforms.filter(p => !p.success).map(p => p.key).join(', '))
  if (okCount < Math.ceil(platforms.length / 2)) {
    console.error('å¤±è´¥è¿å¤ï¼éåºç  1')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('ä¸»æµç¨éè¯¯:', err)
  process.exit(1)
})

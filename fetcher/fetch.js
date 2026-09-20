/**
 * 今日热搜榜 - 零依赖抓取脚本 v4.1
 * 核心原则：零第三方依赖、只用官方源+RSS+静态兜底、零维护成本
 * 只依赖 Node.js 原生模块：https, http, fs, path, url
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const { loadConfig, getEnabledSources, getPlatforms, getGlobalConfig } = require('./config-loader')

// ============ 配置加载 ============
const config = loadConfig()
const globalConfig = getGlobalConfig(config)
const OUTPUT_DIR = path.resolve(__dirname, '..', 'data')

// ============ 常量 ============
const SKIP_URL_PLATFORMS = ['github_trending', 'arxiv', 'v2ex']
const CLEAN_PLATFORMS = ['tieba', 'hupu', 'ithome', 'sspai']
const DOUBAN_PLATFORMS = ['douban', 'doubanhot', 'doubantv', 'doubannew', 'doubanscore']

const PLATFORM_TIER = {
  FULL: ['tieba', 'hupu', 'ithome', 'sspai', 'arxiv'],
  STRUCTURED: DOUBAN_PLATFORMS,
  LINK_ONLY: ['weibo', 'zhihu', 'toutiao', 'douyin', 'bilibili', 'weixin', 'github_trending', 'v2ex', 'cctv', 'huxiu', 'infoq', 'baidu']
}

function getPlatformTier(platform) {
  if (PLATFORM_TIER.FULL.includes(platform)) return 'full'
  if (PLATFORM_TIER.STRUCTURED.includes(platform)) return 'structured'
  return 'link_only'
}

// ============ Cookie 管理 ============
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

// ============ 通用请求（原生 http/https，零依赖） ============
function httpFetch(url, options = {}) {
  const parsed = new URL(url)
  const isHttps = parsed.protocol === 'https:'
  const client = isHttps ? https : http
  const host = parsed.host
  return new Promise((resolve, reject) => {
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': globalConfig.default_headers?.['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }, options.headers || {}, _cookieHeader(host) ? { Cookie: _cookieHeader(host) } : {}),
      timeout: options.timeout || 15000,
      rejectUnauthorized: false
    }, res => {
      _saveCookies(host, res.headers['set-cookie'])
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href
        return resolve(httpFetch(next, options))
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

function cleanHtml(s) {
  if (!s) return ''
  return s
    .replace(/<!\[CDATA\[/, '')
    .replace(/\]\]>/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function similarity(a, b) {
  const s1 = a.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '')
  const s2 = b.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '')
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  if (s1.includes(s2) || s2.includes(s1)) return 0.9
  let maxLen = 0
  for (let i = 0; i < s1.length; i++) {
    for (let j = 0; j < s2.length; j++) {
      let k = 0
      while (i + k < s1.length && j + k < s2.length && s1[i + k] === s2[j + k]) k++
      if (k > maxLen) maxLen = k
    }
    return maxLen / Math.max(s1.length, s2.length)
  }
}

function writeFile(filepath, content) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true })
  fs.writeFileSync(filepath, content, 'utf8')
}

// ============ RSS 解析器（修复 regex 转义） ============
function parseRss(xml) {
  const items = []
  const itemRegex = /<item[\s\S]*?<\/item>/gi
  let m
  while ((m = itemRegex.exec(xml)) && items.length < 50) {
    const itemXml = m[0]
    const getTag = (tag) => {
      const startMarker = '<' + tag
      const endMarker = '</' + tag + '>'
      const startIdx = itemXml.indexOf(startMarker)
      if (startIdx === -1) return ''
      const afterTag = itemXml.indexOf('>', startIdx)
      if (afterTag === -1) return ''
      const contentStart = afterTag + 1
      const endIdx = itemXml.indexOf(endMarker, contentStart)
      if (endIdx === -1) return ''
      return cleanHtml(itemXml.substring(contentStart, endIdx))
    }
    items.push({
      title: getTag('title'),
      desc: getTag('description'),
      url: getTag('link'),
      pubDate: getTag('pubDate'),
    })
  }
  return items.filter(it => it.title)
}

// ============ 兜底消息 ============
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
  arxiv: 'arXiv 论文详情可点击下方「原文链接」在 arXiv 查看完整论文。',
  douban: '豆瓣条目包含评分、导演、演员等结构化信息。如需查看完整影评/简介，请点击下方「原文链接」在豆瓣 App/网页查看。',
  cctv: '央视新闻详情需在官网查看。可点击下方「原文链接」查看完整内容。',
  huxiu: '虎嗅文章需在官网查看。可点击下方「原文链接」查看完整内容。',
  infoq: 'InfoQ 文章需在官网查看。可点击下方「原文链接」查看完整内容。',
  ithome: 'IT之家文章需在官网查看。可点击下方「原文链接」查看完整内容。',
  juejin: '掘金文章需在官网查看。可点击下方「原文链接」查看完整内容。',
  sspai: '少数派文章需在官网查看。可点击下方「原文链接」查看完整内容。',
  tieba: '贴吧帖子需在官网查看。可点击下方「原文链接」查看完整内容。',
  hupu: '虎扑帖子需在官网查看。可点击下方「原文链接」查看完整内容。',
}

// ============ 正文提取 ============
function extractContentFromHtml(html) {
  if (!html) return ''
  let content = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  content = content.replace(/<style[\s\S]*?<\/style>/gi, '')
  const articleMatch = content.match(/<article[\s\S]*?<\/article>/i)
  if (articleMatch) content = articleMatch[0]
  else {
    const mainMatch = content.match(/<main[\s\S]*?<\/main>/i)
    if (mainMatch) content = mainMatch[0]
  }
  content = content.replace(/<[^>]+>/g, ' ')
  content = content.replace(/&[a-z]+;/gi, ' ')
  content = content.replace(/\s+/g, ' ').trim()
  return content.slice(0, 5000)
}

function extractCctvContent(html) {
  if (!html) return ''
  const match = html.match(/contentData\s*=\s*({[\s\S]*?})\s*;/)
  if (match) {
    try {
      const data = JSON.parse(match[1])
      return data.content || data.body || ''
    } catch {}
  }
  const match2 = html.match(/<div class="content">([\s\S]*?)<\/div>/i)
  if (match2) return clean(match2[1])
  return ''
}

function extractDoubanSubjectId(url) {
  if (!url) return null
  const match = url.match(/subject\/(\d+)/)
  return match ? match[1] : null
}

async function fetchDoubanStructured(subjectId) {
  if (!subjectId) return {}
  const url = `https://api.douban.com/v2/movie/subject/${subjectId}`
  try {
    const r = await httpFetch(url, { timeout: 5000 })
    const j = JSON.parse(r.data)
    return {
      douban_directors: (j.directors || []).map(d => d.name).join(', '),
      douban_casts: (j.casts || []).map(c => c.name).slice(0, 5).join(', '),
      douban_genre: (j.genres || []).join(', '),
      douban_year: j.year || '',
      douban_runtime: (j.durations || [])[0] || '',
      douban_episodes: j.episodes_count || '',
      douban_region: (j.countries || []).join(', '),
      douban_intro: j.summary || '',
      rate: j.rating?.average || ''
    }
  } catch { return {} }
}

async function enrichContent(platform, items) {
  const top = items.slice(0, 15)
  const rest = items.slice(15)

  const results = await mapWithConcurrency(top, 3, async (it) => {
    if (DOUBAN_PLATFORMS.includes(platform)) {
      const sid = (it && it.douban_id) || extractDoubanSubjectId(it.url)
      const info = await fetchDoubanStructured(sid)
      if (!info.rate && it && it.rate) info.rate = it.rate
      return { content: (info.douban_intro || '').slice(0, 5000), ...info }
    }
    if (SKIP_URL_PLATFORMS.includes(platform)) return { content: FALLBACK_MESSAGES[platform] || '' }
    if (!it.url) return { content: FALLBACK_MESSAGES[platform] || '' }
    try {
      const r = await httpFetch(it.url, { timeout: 10000 })
      let content
      if (platform === 'cctv') {
        content = extractCctvContent(r.data || '')
      } else {
        content = extractContentFromHtml(r.data || '')
      }
      content = content.slice(0, 5000)
      if (CLEAN_PLATFORMS.includes(platform) && content) content = cleanHtml(content)
      return { content }
    } catch (_) {
      return { content: FALLBACK_MESSAGES[platform] || '' }
    }
  })

  top.forEach((it, i) => {
    const r = results[i] || {}
    if (DOUBAN_PLATFORMS.includes(platform)) {
      if (it.douban_intro) it.content = it.douban_intro.slice(0, 5000)
      else if (r.douban_intro) it.content = r.douban_intro.slice(0, 5000)
      else it.content = it.excerpt || it.title || FALLBACK_MESSAGES[platform] || ''
      if (r.douban_directors) it.douban_directors = r.douban_directors
      if (r.douban_casts) it.douban_casts = r.douban_casts
      if (r.douban_genre) it.douban_genre = r.douban_genre
      if (r.douban_year) it.douban_year = r.douban_year
      if (r.douban_runtime) it.douban_runtime = r.douban_runtime
      if (r.douban_episodes) it.douban_episodes = r.douban_episodes
      if (r.douban_region) it.douban_region = r.douban_region
      if (r.rate) it.rate = r.rate
    } else {
      let c = (r && r.content) || ''
      if (!c || c.length < 20) c = it.excerpt || it.desc || FALLBACK_MESSAGES[platform] || it.title || ''
      it.content = c
    }
  })
  rest.forEach(it => {
    if (!it.content || it.content.length < 20) it.content = it.excerpt || it.desc || FALLBACK_MESSAGES[platform] || it.title || ''
  })
  return items
}

// ============ 并发控制 ============
async function mapWithConcurrency(arr, concurrency, fn) {
  const results = []
  const executing = []
  for (const item of arr) {
    const p = fn(item).then(r => {
      results.push(r)
      executing.splice(executing.indexOf(p), 1)
    })
    results.push(p)
    executing.push(p)
    if (executing.length >= concurrency) {
      await Promise.race(executing)
    }
  }
  return Promise.all(results)
}

// ============ 合并去重 ============
function mergePlatformData(platformKey, allData, mergeConfig) {
  const items = []
  for (const sourceItems of Object.values(allData)) items.push(...sourceItems)
  if (!items.length) return []
  const { dedup_strategy, similarity_threshold, max_per_platform } = mergeConfig
  if (dedup_strategy === 'title_similarity') {
    const unique = []
    for (const item of items) {
      let isDup = false
      for (const u of unique) {
        if (similarity(item.title, u.title) >= similarity_threshold) { isDup = true; break }
      }
      if (!isDup) unique.push(item)
    }
    return unique.slice(0, max_per_platform)
  }
  return items.slice(0, max_per_platform)
}

// ============ 归一化输出 ============
function norm(items, platform) {
  return (items || []).map((it, i) => {
    const rank = it.index || i + 1
    const hot = clean(it.hot)
    return {
      rank,
      title: clean(it.title),
      excerpt: clean(it.desc),
      content: it.content || '',
      hot,
      tags: tagsFor(hot, rank),
      url: it.mobilUrl || it.url || '',
      thumb: it.pic || it.cover || it.img || '',
      douban_directors: it.douban_directors || '',
      douban_casts: it.douban_casts || '',
      douban_genre: it.douban_genre || '',
      douban_year: it.douban_year || '',
      douban_runtime: it.douban_runtime || '',
      douban_episodes: it.douban_episodes || '',
      douban_region: it.douban_region || '',
      douban_rate: it.douban_rate || it.rate || '',
      douban_intro: it.douban_intro || ''
    }
  }).filter(it => it.title)
}

function tagsFor(hot, rank) {
  const tags = []
  if (rank === 1) tags.push({ text: '顶', cls: 'tag-boom' })
  else if (rank <= 3) tags.push({ text: '热', cls: 'tag-hot' })
  else if (hot && /^\d+(\.\d+)?[万亿]?$/.test(hot)) {
    const num = parseFloat(hot)
    const unit = hot.includes('万') ? 10000 : hot.includes('亿') ? 100000000 : 1
    if (num * unit >= 10000000) tags.push({ text: '爆', cls: 'tag-boom' })
    else if (num * unit >= 1000000) tags.push({ text: '热', cls: 'tag-hot' })
  }
  return tags
}

// ============ 各类型源抓取器 ============
const SOURCE_FETCHERS = {
  rss: async (source) => {
    const { url } = source.config
    try {
      const r = await httpFetch(url, { timeout: 15000 })
      const items = parseRss(r.data)
      // 按 platforms 字段包装为对象返回，与 html_scrape/static 格式一致
      const platforms = source.platforms || []
      if (!platforms.length) return {}
      const result = {}
      for (const p of platforms) {
        result[p] = items
      }
      return result
    } catch (e) {
      console.error(`  ✗ ${source.id}: ${e.message}`)
      return {}
    }
  },

  html_scrape: async (source) => {
    const { api_url, parser } = source.config
    try {
      if (!api_url) return []
      const r = await httpFetch(api_url, { timeout: 15000 })
      const j = JSON.parse(r.data)

      // 兼容多种 API 返回格式
      const list = j.data || j.list || j.result || j
      if (!Array.isArray(list)) {
        console.error(`  ✗ ${source.id}: 返回格式非数组`)
        return []
      }

      if (parser === 'tieba_json') {
        return list.map((it, i) => ({
          index: i + 1,
          title: clean(it.topic_name || ''),
          desc: clean(it.topic_desc || it.abstract || ''),
          pic: it.topic_pic || '',
          hot: it.discuss_num ? String(it.discuss_num) : '',
          url: clean((it.topic_url || '').replace(/&amp;/g, '&')),
          mobilUrl: clean((it.topic_url || '').replace(/&amp;/g, '&'))
        })).filter(it => it.title)
      }

      if (parser === 'sspai_json') {
        return list.map((it, i) => ({
          index: i + 1,
          title: clean(it.title || ''),
          desc: clean(it.excerpt || it.summary || ''),
          pic: it.banner || it.cover || '',
          hot: it.likes_count ? String(it.likes_count) : '',
          url: it.permalink || `https://sspai.com/post/${it.id}`,
          mobilUrl: it.permalink || `https://sspai.com/post/${it.id}`
        })).filter(it => it.title)
      }

      return []
    } catch (e) {
      console.error(`  ✗ ${source.id}: ${e.message}`)
      return []
    }
  },

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

// ============ 主流程 ============
async function main() {
  console.log('=== 开始抓取热搜数据 (零依赖版 v4.1) ===')
  console.log('Time:', new Date().toISOString())
  console.log('Output dir:', OUTPUT_DIR)
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const SOURCES = getEnabledSources(config)
  const platforms = getPlatforms(config)

  console.log('启用源数:', SOURCES.length)
  console.log('平台数:', platforms.length)

  const platformData = {}

  for (const source of SOURCES) {
    console.log('\n抓取源:', source.id, '(', source.type, ')')
    try {
      const fetcher = SOURCE_FETCHERS[source.type]
      if (!fetcher) {
        console.log(`  ✗ 未知源类型: ${source.type}`)
        continue
      }
      const data = await fetcher(source)
      for (const [platformKey, items] of Object.entries(data)) {
        if (!platformData[platformKey]) platformData[platformKey] = {}
        platformData[platformKey][source.id] = items
      }
    } catch (err) {
      console.error(`  ✗ ${source.id}: ${err.message}`)
    }
  }

  const finalResults = {}
  const meta = { version: '4.1', update_time: new Date().toISOString(), platforms: [] }

  for (const platform of platforms) {
    const key = platform.key
    const sourceData = platformData[key] || {}
    console.log(`\n合并去重 ${key}...`)

    let merged = mergePlatformData(key, sourceData, platform.merge_config || {})
    console.log(`  合并后: ${merged.length} 条`)

    try {
      console.log(`正文抓取 ${key}...`)
      await enrichContent(key, merged)
      const withContent = merged.filter(x => x.content && x.content.length >= 20).length
      const isDouban = DOUBAN_PLATFORMS.includes(key)
      const infoFields = merged.filter(x => x.douban_directors || x.douban_casts).length
      console.log(`  ✓ ${key} 正文已填充（${withContent}/${merged.length} 条有正文）${isDouban ? '（结构化 ' + infoFields + '/' + merged.length + ' 条）' : ''}`)
    } catch (err) {
      console.error(`  ✗ ${key} 正文抓取失败: ${err.message}`)
    }

    const normalized = norm(merged, key)
    finalResults[key] = {
      success: true,
      platform: key,
      update_time: new Date().toISOString(),
      count: normalized.length,
      data: normalized
    }
    meta.platforms.push({ key, success: true, count: normalized.length })

    const filepath = path.join(OUTPUT_DIR, key + '.json')
    writeFile(filepath, JSON.stringify(finalResults[key], null, 2))
  }

  writeFile(path.join(OUTPUT_DIR, '_meta.json'), JSON.stringify(meta, null, 2))

  console.log('\n=== 完成 ===')
  console.log('OK:', meta.platforms.filter(p => p.success && p.count > 0).length, '/', meta.platforms.length)
}

main().catch(console.error)
/**
 * 今日热搜榜 - 生产版抓取脚本
 *
 * 设计原则：
 *   1. 安全稳定优先（单平台失败不影响整体）
 *   2. 抓取列表 + 正文摘要（方案 D：能抓正文抓正文，抓不到抓 meta description，再抓不到用原摘要）
 *   3. 只保留文字（不存图片/视频 URL，列表里的 thumb 字段保留供小程序选择性展示封面）
 *   4. 输出到本地 data/*.json，由 workflow commit 到仓库，GitHub Pages 托管
 *   5. 不直接处理 Gitee 推送（由单独的 mirror workflow 同步）
 *
 * 输出文件：
 *   data/<platform>.json     每个平台一个文件
 *   data/_meta.json          元数据（更新时间、平台清单、各平台状态）
 *
 * 9 个稳定平台：baidu / douyin / toutiao / tieba / sspai / hupu / cctv / douban / doubantv
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')

// ============ 配置 ============
const OUTPUT_DIR = path.resolve(__dirname, '..', 'data')
const DETAIL_TOP_N = 10        // 每个平台只对前 N 条抓取正文（控制时长）
const DETAIL_CONCURRENCY = 5   // 正文抓取并发数
const DETAIL_TIMEOUT = 8000    // 单条正文抓取超时（毫秒）

// ============ 通用请求 ============
function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }, options.headers || {}),
      timeout: options.timeout || 15000
    }, res => {
      // 处理重定向
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
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
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

// 从 HTML 提取正文摘要（meta description 优先，其次 og:description，再退化到前几段 <p>）
function extractContentFromHtml(html) {
  if (!html) return ''
  // 1. meta description
  let m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)
  if (m && m[1]) return clean(m[1])
  m = html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["']/i)
  if (m && m[1]) return clean(m[1])
  // 2. og:description
  m = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["']/i)
  if (m && m[1]) return clean(m[1])
  m = html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["']/i)
  if (m && m[1]) return clean(m[1])
  // 3. 提取前几段 <p>
  const ps = []
  const preg = /<p[^>]*>([\s\S]{20,500}?)<\/p>/gi
  let pm
  while ((pm = preg.exec(html)) && ps.length < 3) {
    const t = stripHtml(pm[1])
    if (t.length >= 20) ps.push(t)
  }
  if (ps.length) return ps.join(' ')
  return ''
}

// 并发控制：限制最大并发数
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
      content: '',  // 正文摘要，后续步骤填充
      hot,
      tags: tagsFor(hot, rank),
      url: it.mobilUrl || it.url || '',
      thumb: it.pic || ''
    }
  }).filter(it => it.title)
}

// ============ 各平台 Fetcher ============
const FETCHERS = {
  // 百度热搜
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

  // 抖音热搜
  douyin: async () => {
    const r = await fetch('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/')
    const j = JSON.parse(r.data)
    const list = j.word_list || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.word || '').trim(),
      desc: '',
      pic: '',
      hot: it.hot_value ? String(it.hot_value) : '',
      url: 'https://www.douyin.com/search/' + encodeURIComponent(it.word || ''),
      mobilUrl: 'https://www.douyin.com/search/' + encodeURIComponent(it.word || '')
    })).filter(it => it.title)
  },

  // 头条热榜
  toutiao: async () => {
    const r = await fetch('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc')
    const j = JSON.parse(r.data)
    const list = j.data || []
    return list.map((it, i) => ({
      index: i + 1,
      title: (it.Title || '').trim(),
      desc: '',
      pic: it.Image ? (it.Image.url || '') : '',
      hot: it.HotValue ? String(it.HotValue) : '',
      url: (it.Url || '').trim(),
      mobilUrl: (it.Url || '').trim()
    })).filter(it => it.title)
  },

  // 贴吧热议
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

  // 少数派
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

  // 虎扑步行街
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
      items.push({
        index: items.length + 1,
        title,
        desc: '',
        pic: '',
        hot: '',
        url,
        mobilUrl: url
      })
    }
    if (!items.length) throw new Error('虎扑解析失败')
    return items
  },

  // 央视新闻
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
      items.push({
        index: items.length + 1,
        title,
        desc: '',
        pic: '',
        hot: '',
        url,
        mobilUrl: url
      })
    }
    if (!items.length) throw new Error('央视解析失败')
    return items
  },

  // 豆瓣电影
  douban: async () => {
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
      url: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      mobilUrl: it.url || ('https://movie.douban.com/subject/' + it.id + '/')
    })).filter(it => it.title)
  },

  // 豆瓣剧集
  doubantv: async () => {
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
      url: it.url || ('https://movie.douban.com/subject/' + it.id + '/'),
      mobilUrl: it.url || ('https://movie.douban.com/subject/' + it.id + '/')
    })).filter(it => it.title)
  }
}

// ============ 正文抓取（方案 D：混合策略） ============
// 对每条热搜尝试抓取正文摘要，失败不影响列表
async function enrichContent(platform, items) {
  const top = items.slice(0, DETAIL_TOP_N)
  const rest = items.slice(DETAIL_TOP_N)

  // 并发抓取正文
  const results = await mapWithConcurrency(top, DETAIL_CONCURRENCY, async (it, i) => {
    if (!it.url) return { content: '' }
    try {
      const r = await fetch(it.url, {
        timeout: DETAIL_TIMEOUT,
        headers: it.url.indexOf('douban') > -1 ? { 'Referer': 'https://movie.douban.com/' } : {}
      })
      const html = r.data || ''
      const content = extractContentFromHtml(html)
      return { content: content.slice(0, 1000) }  // 限制 1000 字
    } catch (e) {
      return { content: '' }
    }
  })

  // 合并：有 content 用 content，否则保留原 excerpt
  top.forEach((it, i) => {
    const r = results[i]
    const c = (r && r.content) || ''
    if (c && c.length > (it.excerpt || '').length) {
      it.content = c
    } else {
      it.content = it.excerpt || ''
    }
  })
  // 剩余条目 content = excerpt
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

  // 确保输出目录存在
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const platforms = Object.keys(FETCHERS)
  const results = {}
  const meta = {
    version: '2.0',
    update_time: new Date().toISOString(),
    platforms: []
  }

  // 1. 抓取列表
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

  // 2. 抓取正文（只对成功的平台）
  for (const key of platforms) {
    if (!results[key]) continue
    try {
      console.log('正文抓取 ' + key + '...')
      await enrichContent(key, results[key])
      console.log('  ✓ ' + key + ' 正文已填充')
    } catch (err) {
      console.error('  ✗ ' + key + ' 正文抓取失败: ' + (err.message || err))
      // 列表仍可用，content 留空
    }
  }

  // 3. 写入文件
  for (const key of platforms) {
    const filepath = path.join(OUTPUT_DIR, key + '.json')
    if (!results[key]) {
      // 抓取失败：写一个空数据的占位文件，避免 404
      writeFile(filepath, JSON.stringify({
        success: false,
        platform: key,
        update_time: new Date().toISOString(),
        data: []
      }, null, 2))
      meta.platforms.push({ key, success: false, count: 0 })
      continue
    }
    const payload = {
      success: true,
      platform: key,
      update_time: new Date().toISOString(),
      count: results[key].length,
      data: results[key]
    }
    writeFile(filepath, JSON.stringify(payload, null, 2))
    meta.platforms.push({ key, success: true, count: results[key].length })
  }

  // 4. 写元数据
  writeFile(path.join(OUTPUT_DIR, '_meta.json'), JSON.stringify(meta, null, 2))

  // 5. 汇总
  const okCount = meta.platforms.filter(p => p.success).length
  console.log('=== 完成 ===')
  console.log('OK: ' + okCount + '/' + platforms.length)
  console.log('失败平台: ' + meta.platforms.filter(p => !p.success).map(p => p.key).join(', '))
  // 失败超过半数时返回非零退出码，让 Actions 标记为失败
  if (okCount < Math.ceil(platforms.length / 2)) {
    console.error('失败过多，退出码 1')
    process.exit(1)
  }
}

main().catch(err => {
  console.error('主流程错误:', err)
  process.exit(1)
})

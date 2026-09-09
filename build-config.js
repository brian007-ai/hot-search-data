// build-config.js
// 将 data-sources.yaml 转为 data-sources.json，供小程序前端引用
// 用法：node build-config.js

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const SRC = path.resolve(__dirname, '..', 'data-sources.yaml')
const DST = path.resolve(__dirname, '..', '小程序前端源码', 'utils', 'data-sources.json')

try {
  const content = fs.readFileSync(SRC, 'utf8')
  const config = yaml.load(content)
  
  // 仅输出前端需要的字段，减小体积
  const frontendConfig = {
    global: config.global,
    platforms: config.platforms,
    merge: config.merge,
    // 源配置仅保留前端需要的字段
    sources: (config.sources || []).filter(s => s.enabled !== false).map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      priority: s.priority,
      config: s.config,
      platforms: s.platforms
    }))
  }
  
  fs.writeFileSync(DST, JSON.stringify(frontendConfig, null, 2), 'utf8')
  console.log('✅ 生成前端配置:', DST)
  console.log('平台数:', frontendConfig.platforms.reduce((sum, g) => sum + g.items.length, 0))
  console.log('启用源数:', frontendConfig.sources.length)
} catch (e) {
  console.error('❌ 生成失败:', e.message)
  process.exit(1)
}
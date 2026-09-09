// build-config.js
// 将 data-sources.yaml 转为 data-sources.json + data-sources.js，供小程序前端引用
// 用法：node build-config.js

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const SRC = path.resolve(__dirname, '..', 'data-sources.yaml')
const DST_JSON = path.resolve(__dirname, '..', '小程序前端源码', 'utils', 'data-sources.json')
const DST_JS = path.resolve(__dirname, '..', '小程序前端源码', 'utils', 'data-sources.js')

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
  
  // 写入 JSON 版本（供参考/调试）
  fs.writeFileSync(DST_JSON, JSON.stringify(frontendConfig, null, 2), 'utf8')
  
  // 写入 JS 模块版本（小程序可直接 require）
  // 使用数组拼接避免模板字符串缩进问题
  const jsonStr = JSON.stringify(frontendConfig, null, 2)
  const jsContent = [
    '// 今日热搜榜 - 数据源配置（前端可 require 版）',
    '// 由 build-config.js 从 data-sources.yaml 自动生成',
    '// 请勿手动修改，修改 data-sources.yaml 后运行 npm run build-config 重新生成',
    '',
    'const config = ' + jsonStr,
    '',
    'module.exports = config',
    ''
  ].join('\n')
  
  fs.writeFileSync(DST_JS, jsContent, 'utf8')
  
  console.log('✅ 生成前端配置:', DST_JSON)
  console.log('✅ 生成前端 JS 模块:', DST_JS)
  console.log('平台数:', frontendConfig.platforms.reduce((sum, g) => sum + g.items.length, 0))
  console.log('启用源数:', frontendConfig.sources.length)
} catch (e) {
  console.error('❌ 生成失败:', e.message)
  process.exit(1)
}
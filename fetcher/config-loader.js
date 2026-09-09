/**
 * data-sources.yaml 解析器（云端 Node.js 版）
 * 用于 fetcher/fetch.js 读取配置驱动抓取
 */
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'data-sources.yaml')

function loadConfig() {
  const content = fs.readFileSync(CONFIG_PATH, 'utf8')
  return yaml.load(content)
}

function getEnabledSources(config) {
  return (config.sources || []).filter(s => s.enabled !== false).sort((a, b) => (a.priority || 999) - (b.priority || 999))
}

function getPlatforms(config) {
  const result = []
  for (const group of config.platforms || []) {
    for (const item of group.items || []) {
      result.push({
        ...item,
        group: group.group
      })
    }
  }
  return result
}

function getSourcesForPlatform(config, platformKey) {
  const platform = getPlatforms(config).find(p => p.key === platformKey)
  if (!platform || !platform.source_priority) return []

  const sources = getEnabledSources(config)
  const sourceMap = Object.fromEntries(sources.map(s => [s.id, s]))

  return platform.source_priority
    .map(id => sourceMap[id])
    .filter(Boolean)
}

function getGlobalConfig(config) {
  return config.global || {}
}

// 解析平台专用解析器字符串为函数
function parsePlatformParsers(config) {
  for (const source of config.sources || []) {
    if (source.config && source.config.platform_parsers) {
      const parsers = source.config.platform_parsers
      for (const [apiType, fnStr] of Object.entries(parsers)) {
        try {
          // 使用 eval 将字符串转为函数
          source.config.platform_parsers[apiType] = eval('(' + fnStr + ')')
        } catch (e) {
          console.error(`解析解析器失败 ${source.id}.${apiType}:`, e.message)
        }
      }
    }
  }
}

function getEnabledSources(config) {
  return (config.sources || []).filter(s => s.enabled !== false).sort((a, b) => (a.priority || 999) - (b.priority || 999))
}

function getPlatforms(config) {
  const result = []
  for (const group of config.platforms || []) {
    for (const item of group.items || []) {
      result.push({
        ...item,
        group: group.group
      })
    }
  }
  return result
}

function getSourcesForPlatform(config, platformKey) {
  const platform = getPlatforms(config).find(p => p.key === platformKey)
  if (!platform || !platform.source_priority) return []

  const sources = getEnabledSources(config)
  const sourceMap = Object.fromEntries(sources.map(s => [s.id, s]))

  return platform.source_priority
    .map(id => sourceMap[id])
    .filter(Boolean)
}

function getGlobalConfig(config) {
  return config.global || {}
}

module.exports = {
  loadConfig,
  getEnabledSources,
  getPlatforms,
  getSourcesForPlatform,
  getGlobalConfig,
  parsePlatformParsers
}
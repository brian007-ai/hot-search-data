/**
 * data-sources.yaml 解析器 - 零依赖版
 * 使用自建 yaml-parser.js 解析 YAML，无需 js-yaml
 */
const fs = require('fs')
const path = require('path')
const { parseYaml } = require('./yaml-parser')

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'data-sources.yaml')

function loadConfig() {
  const content = fs.readFileSync(CONFIG_PATH, 'utf8')
  const config = parseYaml(content)
  return config
}

function getEnabledSources(config) {
  return (config.sources || []).filter(s => s.enabled !== false).sort((a, b) => (a.priority || 999) - (b.priority || 999))
}

function getPlatforms(config) {
  const result = []
  for (const group of config.platforms || []) {
    for (const item of group.items || []) {
      result.push({ ...item, group: group.group })
    }
  }
  return result
}

function getSourcesForPlatform(config, platformKey) {
  const platform = getPlatforms(config).find(p => p.key === platformKey)
  if (!platform || !platform.source_priority) return []
  const sources = getEnabledSources(config)
  const sourceMap = Object.fromEntries(sources.map(s => [s.id, s]))
  return platform.source_priority.map(id => sourceMap[id]).filter(Boolean)
}

function getGlobalConfig(config) {
  return config.global || {}
}

module.exports = {
  loadConfig,
  getEnabledSources,
  getPlatforms,
  getSourcesForPlatform,
  getGlobalConfig
}
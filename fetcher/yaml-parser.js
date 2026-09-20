/**
 * 极简 YAML 解析器 - 零第三方依赖
 * 支持：嵌套对象、数组、内联数组、字符串/数字/布尔、注释
 * 专为 data-sources.yaml 格式设计
 */
function parseYaml(content) {
  const lines = []
  for (const rawLine of content.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    lines.push({ content: trimmed, indent })
  }
  return parseBlock(lines, 0, lines[0]?.indent || 0)[0]
}

function parseBlock(lines, startIdx, indent) {
  if (startIdx >= lines.length) return [null, startIdx]
  if (lines[startIdx].content.startsWith('- ')) {
    return parseArray(lines, startIdx, indent)
  }
  return parseObject(lines, startIdx, indent)
}

function parseObject(lines, startIdx, indent) {
  const result = {}
  let i = startIdx
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) { i++; continue }
    const t = line.content
    if (t.startsWith('- ')) break
    const colonIdx = t.indexOf(':')
    if (colonIdx === -1) { i++; continue }
    const key = t.slice(0, colonIdx).trim().replace(/["']/g, '')
    const val = t.slice(colonIdx + 1).trim()
    if (val === '') {
      i++
      if (i < lines.length && lines[i].indent > indent) {
        const [nested, nextIdx] = parseBlock(lines, i, lines[i].indent)
        result[key] = nested
        i = nextIdx
      } else {
        result[key] = null
      }
    } else if (val.startsWith('[')) {
      result[key] = parseInlineArray(val)
      i++
    } else {
      result[key] = parseValue(val)
      i++
    }
  }
  return [result, i]
}

function parseArray(lines, startIdx, indent) {
  const result = []
  let i = startIdx
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) { i++; continue }
    const t = line.content
    if (!t.startsWith('- ')) break
    const afterDash = t.slice(2).trim()
    if (afterDash.includes(':')) {
      lines[i].content = afterDash
      lines[i].indent = indent + 2
      const [obj, nextIdx] = parseObject(lines, i, indent + 2)
      result.push(obj)
      i = nextIdx
    } else {
      result.push(parseValue(afterDash))
      i++
    }
  }
  return [result, i]
}

function parseInlineArray(str) {
  const inner = str.slice(1, -1).trim()
  if (!inner) return []
  return inner.split(',').map(s => parseValue(s.trim()))
}

function parseValue(str) {
  if (str === 'true') return true
  if (str === 'false') return false
  if (str === 'null' || str === '~' || str === '') return null
  if (/^-?\d+$/.test(str)) return parseInt(str, 10)
  if (/^-?\d+\.\d+$/.test(str)) return parseFloat(str)
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return str.slice(1, -1)
  }
  return str
}

module.exports = { parseYaml }
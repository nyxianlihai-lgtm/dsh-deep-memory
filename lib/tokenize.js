// 混合中英文分词。QQ-pet 那套只切汉字，搬到 DSH 上会把路径、函数名全漏掉：
//   "MemoryV3.recall 这个 bug" → 期望能命中 "memory / v3 / recall / bug"
// 所以这里做三件事：中文单字 + 二字；英文按标识符边界拆（camelCase / snake_case / 路径 / 版本号）。

const CN_STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '就', '不',
  '也', '都', '要', '会', '吗', '呢', '吧', '啊', '呀', '么', '着', '过', '把', '被', '给', '让',
  '一个', '什么', '怎么', '为什么', '可以', '没有', '不是', '还是', '然后', '现在', '今天', '明天',
  '昨天', '觉得', '知道', '感觉', '有点', '真的', '其实', '我们', '你们', '他们', '这个', '那个',
  '如果', '所以', '因为', '但是', '而且', '之后', '之前', '里面', '外面', '时候', '东西', '事情',
  '问题', '方法', '地方', '一点', '一些', '一直', '已经', '可能', '应该', '需要', '这样', '那样',
  '一个', '怎样', '如何', '只是', '就是', '还有', '或者', '并且', '以及', '对于', '关于',
])

const EN_STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now',
  'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'she', 'use', 'her', 'why', 'let', 'put',
  'say', 'too', 'this', 'that', 'with', 'from', 'have', 'will', 'your', 'them', 'then', 'than',
  'into', 'only', 'over', 'also', 'such', 'some', 'more', 'most', 'very', 'just', 'like', 'when',
  'what', 'which', 'while', 'about', 'would', 'could', 'should', 'there', 'their', 'these',
  'those', 'been', 'being', 'does', 'doing', 'done', 'make', 'made', 'does', 'yes', 'no',
])

const RAW_IDENT = /[A-Za-z0-9_$][A-Za-z0-9_$.\-\\/]*/g

function splitIdent(raw) {
  const out = []
  for (const seg of String(raw).split(/[_$.\-\\/]+/)) {
    if (!seg) continue
    const parts = seg
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      // 只在「字母有一整段」时才按数字拆，免得把 v3 / utf8 / pnpm2 这类版本号拆碎
      .replace(/([A-Za-z]{2,})([0-9])/g, '$1 $2')
      .replace(/([0-9])([A-Za-z]{2,})/g, '$1 $2')
      .split(/\s+/)
      .filter(Boolean)
    if (parts.length) out.push(...parts)
    else out.push(seg)
  }
  return out
}

/** 文本 -> 去重后的词集合（小写）。IDF 打分和相似度都用它。 */
export function tokens(text) {
  const src = String(text == null ? '' : text).slice(0, 20000)
  const out = new Set()

  for (const raw of src.match(RAW_IDENT) || []) {
    for (const part of splitIdent(raw)) {
      const t = part.toLowerCase()
      if (t.length >= 2 && !EN_STOP.has(t)) out.add(t)
    }
  }

  for (const run of src.toLowerCase().match(/[\u4e00-\u9fa5]+/g) || []) {
    for (const ch of run) if (!CN_STOP.has(ch)) out.add(ch)
    for (let i = 0; i + 1 < run.length; i += 1) {
      const a = run[i]
      const b = run[i + 1]
      if (CN_STOP.has(a) && CN_STOP.has(b)) continue
      out.add(a + b)
    }
  }

  return out
}

export function tokenList(text) {
  return [...tokens(text)]
}

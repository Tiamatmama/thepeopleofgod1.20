// should-pass fixture：注释 / 字符串 / 定义点都不应算命中。

// 原文来自 emtionembedding/core.js:91
// 推一轮，dt=1。o={rng:高斯随机函数, noise:要不要噪声, updateB:生理慢更新, plastic:可塑性}
function step(st, u, P, o) {
  o = o || {}
  return o
}

const doc = 'step(st, u, P, { rng: g }) 这行在字符串里，不报'

const ok1 = step(st, u, P, { rng: g, updateB: true })
const ok2 = step(st, u, P, {
  rng: g,
  updateB: true
})

module.exports = { doc, ok1, ok2 }

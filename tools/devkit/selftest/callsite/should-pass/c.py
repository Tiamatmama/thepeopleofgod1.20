# should-pass fixture：Python 字典字面量的引号键必须被识别为显式传入。
# 原文来自 emtionembedding/search_dyn.py:133

def step(st, u, P, o):
    return o


doc = "step(st, u, P, {'rng': g}) 这行在字符串里，不报"

ok = step(st, u, P, {"rng": g, "updateB": True})
ok2 = step(st, u, P, {
    "rng": g,
    "updateB": True,
})

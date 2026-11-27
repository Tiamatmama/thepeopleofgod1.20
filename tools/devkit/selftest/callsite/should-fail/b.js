// should-fail fixture：options 对象存在，但漏了 updateB。

const g = () => 0

step(st, u, P, { rng: g })

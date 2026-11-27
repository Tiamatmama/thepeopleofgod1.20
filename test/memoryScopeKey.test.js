'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryModule = require('../src/core/memory');

// normalizeScopeKey / baseUserKey 是纯字符串函数，不碰盘、不依赖实例字段，
// 用原型对象造一个「只够跑这两个方法」的模块即可（照 pinMemory.test.js 的做法）。
function makeMemory() {
    return Object.create(MemoryModule.prototype);
}

test('A4：中文 / emoji / 空格昵称不被误杀，仍能拼回原档名', () => {
    const mem = makeMemory();
    assert.equal(mem.normalizeScopeKey('小龙虾🦐'), '小龙虾🦐__role');
    assert.equal(mem.normalizeScopeKey('张三 李四'), '张三 李四__role');
    assert.equal(mem.normalizeScopeKey('小龙虾🦐__role'), '小龙虾🦐__role');
    assert.equal(mem.baseUserKey('小龙虾🦐'), '小龙虾🦐');
    assert.equal(mem.baseUserKey('小龙虾🦐__role'), '小龙虾🦐');   // 分档后缀照常剥离
});

test('A8：含路径分隔符的键不得落到他人档（x/../victim 结果 ≠ victim 键）', () => {
    const mem = makeMemory();
    // 正 / 反斜杠、绝对路径式 ../ 一律回落 default，绝不能拼出 victim 档
    assert.equal(mem.normalizeScopeKey('x/../victim'), 'default__role');
    assert.equal(mem.normalizeScopeKey('../../victim'), 'default__role');
    assert.equal(mem.normalizeScopeKey('x\\..\\victim'), 'default__role');
    assert.equal(mem.baseUserKey('../../victim'), 'default');
    assert.notEqual(mem.normalizeScopeKey('x/../victim'), 'victim__role');
});

test('A12：a/b ≠ a，非法键不静默并入合法档', () => {
    const mem = makeMemory();
    assert.equal(mem.normalizeScopeKey('a/b'), 'default__role');
    // 关键：a/b 不得静默变成 a 的档
    assert.notEqual(mem.normalizeScopeKey('a/b'), mem.normalizeScopeKey('a'));
    assert.equal(mem.normalizeScopeKey('a'), 'a__role');
});

test('边界：空 / 缺省 / 点段回落 default，幂等仍保持', () => {
    const mem = makeMemory();
    assert.equal(mem.normalizeScopeKey(), 'default__role');
    assert.equal(mem.normalizeScopeKey('   '), 'default__role');
    assert.equal(mem.normalizeScopeKey('.'), 'default__role');
    assert.equal(mem.normalizeScopeKey('..'), 'default__role');
    assert.equal(mem.baseUserKey('..'), 'default');
    // 既有幂等契约不变：已带分档后缀的键原样返回
    assert.equal(mem.normalizeScopeKey('u1__ai'), 'u1__ai');
});

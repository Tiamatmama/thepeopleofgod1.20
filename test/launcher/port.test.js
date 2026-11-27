'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePort, DEFAULT_PORT } = require('../../scripts/launch.js');

test('parsePort：未设置 / 空值 / 非数字回落默认端口', () => {
    assert.equal(parsePort({}), DEFAULT_PORT);
    assert.equal(parsePort({ SERVER_PORT: '' }), DEFAULT_PORT);
    assert.equal(parsePort({ SERVER_PORT: 'abc' }), DEFAULT_PORT);
    assert.equal(parsePort(undefined), DEFAULT_PORT);
});

test('parsePort：合法端口原样采用（与 server 口径一致）', () => {
    assert.equal(parsePort({ SERVER_PORT: '8080' }), 8080);
    assert.equal(parsePort({ SERVER_PORT: 9000 }), 9000);
});

test('parsePort：越界端口判失败', () => {
    assert.throws(() => parsePort({ SERVER_PORT: '70000' }));
    assert.throws(() => parsePort({ SERVER_PORT: '99999' }));
    assert.throws(() => parsePort({ SERVER_PORT: '-1' }));
});

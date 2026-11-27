'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBootUrl, normalizePort } = require('../../scripts/launch.js');

test('buildBootUrl：合法端口返回回环确认页地址', () => {
    assert.equal(buildBootUrl(41888), 'http://127.0.0.1:41888/boot.html');
    assert.equal(buildBootUrl('41888'), 'http://127.0.0.1:41888/boot.html');
});

test('buildBootUrl：边界端口 1 与 65535 合法', () => {
    assert.equal(buildBootUrl(1), 'http://127.0.0.1:1/boot.html');
    assert.equal(buildBootUrl(65535), 'http://127.0.0.1:65535/boot.html');
});

test('buildBootUrl：非法端口一律抛错', () => {
    const badPorts = [0, -1, 65536, NaN, '41888@evil.com', 'abc', '', null, undefined, 1.5];
    for (const bad of badPorts) {
        assert.throws(() => buildBootUrl(bad), `端口 ${String(bad)} 应抛错`);
    }
});

test('normalizePort：整数端口原样返回', () => {
    assert.equal(normalizePort(8080), 8080);
    assert.equal(normalizePort('3000'), 3000);
});

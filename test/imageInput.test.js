'use strict';

// 用户附图（多模态输入）：只认 JPEG/PNG/WebP 的 base64 data URL，且限体积。
// 原图只随本轮消息进模型，不走历史、不落盘；这里钉住输入校验的边界。

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeImageDataUrl } = require('../src/core/output');

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const WEBP = 'data:image/webp;base64,UklGRhIAAABXRUJQ';

test('normalizeImageDataUrl：接受 JPEG / PNG / WebP 的 base64 data URL', () => {
    assert.equal(normalizeImageDataUrl(JPEG), JPEG);
    assert.equal(normalizeImageDataUrl(PNG), PNG);
    assert.equal(normalizeImageDataUrl(WEBP), WEBP);
    assert.equal(normalizeImageDataUrl(`  ${JPEG}  `), JPEG);
});

test('normalizeImageDataUrl：拒绝非图片格式与非 data URL', () => {
    assert.equal(normalizeImageDataUrl('data:image/gif;base64,R0lGOD'), '');
    assert.equal(normalizeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), '');
    assert.equal(normalizeImageDataUrl('https://example.com/a.jpg'), '');
    assert.equal(normalizeImageDataUrl('data:text/plain;base64,aGk='), '');
});

test('normalizeImageDataUrl：拒绝空值与非字符串', () => {
    assert.equal(normalizeImageDataUrl(''), '');
    assert.equal(normalizeImageDataUrl('   '), '');
    assert.equal(normalizeImageDataUrl(null), '');
    assert.equal(normalizeImageDataUrl(undefined), '');
    assert.equal(normalizeImageDataUrl({ url: JPEG }), '');
});

test('normalizeImageDataUrl：超过 900KB 一律丢弃', () => {
    const head = 'data:image/jpeg;base64,';
    const limit = 900 * 1024;
    const body = 'A'.repeat(limit - head.length);
    assert.equal(normalizeImageDataUrl(head + body).length, limit);
    assert.equal(normalizeImageDataUrl(`${head}${body}A`), '');
});

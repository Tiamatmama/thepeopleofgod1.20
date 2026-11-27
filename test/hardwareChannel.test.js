'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createHardwareService } = require('../hardware/model/service');

test('独立硬件通道：鉴权、构建、校验与文件落盘', async (t) => {
    const token = 'channel-test-token';
    const server = createHardwareService({ token });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const base = `http://127.0.0.1:${server.address().port}`;
    const name = `channel-test-${process.pid}`;
    const outDir = path.join(__dirname, '..', 'hardware', 'model', 'out');
    t.after(() => {
        for (const ext of ['scad', 'stl', 'step', 'svg']) {
            fs.rmSync(path.join(outDir, `${name}.${ext}`), { force: true });
        }
    });

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'hardware-model');

    const denied = await fetch(`${base}/v1/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec: {} })
    });
    assert.equal(denied.status, 401);

    const list = await fetch(`${base}/v1/parts`, {
        headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(list.status, 200);
    assert.ok((await list.json()).parts.length > 0);

    const spec = {
        name,
        unit: 'mm',
        type: 'gear',
        teeth: 8,
        outerRadius: 10,
        rootRadius: 7,
        depth: 4
    };
    const built = await fetch(`${base}/v1/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ spec })
    });
    assert.equal(built.status, 200);
    const result = await built.json();
    assert.equal(result.ok, true);
    assert.equal(result.part, name);
    assert.ok(result.triangles > 0);
    assert.match(result.files.step, /\.step$/);
    for (const ext of ['scad', 'stl', 'step', 'svg']) {
        assert.ok(fs.existsSync(path.join(outDir, `${name}.${ext}`)), `${ext} 应落盘`);
    }

    const invalid = await fetch(`${base}/v1/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ spec: { ...spec, rootRadius: 12 } })
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /齿根圆/);

    const preflight = await fetch(`${base}/v1/build`, {
        method: 'OPTIONS',
        headers: { origin: 'http://127.0.0.1:41888', 'access-control-request-method': 'POST' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:41888');

    const byFile = await fetch(`${base}/v1/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ file: 'gear-blank.json' })
    });
    assert.equal(byFile.status, 200);
    assert.equal((await byFile.json()).part, 'gear-blank');

    const download = await fetch(`${base}/v1/files/${result.files.step}`, {
        headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(download.status, 200);
    assert.ok((await download.arrayBuffer()).byteLength > 0);

    const traversal = await fetch(`${base}/v1/files/..%2Fpackage.json`, {
        headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(traversal.status, 400);
});

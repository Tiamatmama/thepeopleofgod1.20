'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { httpProbeOnce } = require('../../scripts/launch.js');

function listenOnRandomPort(server) {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
}

test('httpProbeOnce：任意 HTTP 响应（200/404/401）均判就绪', async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/401') {
            res.statusCode = 401;
            res.end('unauthorized');
            return;
        }
        if (req.url === '/404') {
            res.statusCode = 404;
            res.end('not found');
            return;
        }
        res.statusCode = 200;
        res.end('ok');
    });

    const port = await listenOnRandomPort(server);
    try {
        assert.equal(await httpProbeOnce(`http://127.0.0.1:${port}/`), true);
        assert.equal(await httpProbeOnce(`http://127.0.0.1:${port}/404`), true);
        assert.equal(await httpProbeOnce(`http://127.0.0.1:${port}/401`), true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('httpProbeOnce：端口未监听 → 不就绪', async () => {
    const server = http.createServer((req, res) => res.end('x'));
    const port = await listenOnRandomPort(server);
    await new Promise((resolve) => server.close(resolve));

    assert.equal(await httpProbeOnce(`http://127.0.0.1:${port}/`, 500), false);
});

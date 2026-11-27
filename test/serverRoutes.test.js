'use strict';

// server 层冒烟：不启动真实服务、不连数据库，只校验「装配契约」。
// 能抓到的回归：路由模块语法/require 错、导出被改成非函数、路由一个都没注册、
// 两条路由的 method+path 完全重复（后注册的会静默覆盖前者）。
// 真正的业务行为仍由 core 的单测覆盖。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

const SERVER_DIR = path.join(__dirname, '..', 'src', 'server');
const ROUTE_DIR = path.join(SERVER_DIR, 'routes');

function routeFiles() {
    const list = fs.readdirSync(ROUTE_DIR)
        .filter(f => f.endsWith('.js'))
        .sort()
        .map(f => path.join(ROUTE_DIR, f));
    list.push(path.join(SERVER_DIR, 'qq', 'onebotRoutes.js'));
    list.push(path.join(SERVER_DIR, 'bilibili.js'));
    return list;
}

// ctx 里每个属性都返回「可调用、可继续取属性」的桩，避免为 23 个路由各造一套依赖
function stubCtx() {
    const stub = new Proxy(function () {}, {
        get: (target, key) => {
            if (key === 'then') return undefined;      // 避免被当成 thenable
            if (key === Symbol.toPrimitive) return () => '';
            return stub;
        },
        apply: () => stub,
        construct: () => stub
    });
    return stub;
}

function routesOf(file) {
    const app = express();
    const register = require(file);
    assert.equal(typeof register, 'function', `${path.basename(file)} 应导出注册函数`);
    register(app, stubCtx());
    const stack = (app._router && app._router.stack) || [];
    return stack.filter(layer => layer.route).map(layer => ({
        file: path.relative(SERVER_DIR, file),
        path: layer.route.path,
        methods: Object.keys(layer.route.methods)
    }));
}

test('每个路由模块都能注册出至少一条路由，且路径以 / 开头', () => {
    for (const file of routeFiles()) {
        const routes = routesOf(file);
        assert.ok(routes.length > 0, `${path.basename(file)} 未注册任何路由`);
        for (const r of routes) {
            assert.match(r.path, /^\//, `${r.file} 的路径 ${r.path} 应以 / 开头`);
        }
    }
});

test('全站路由 method + path 不重复（重复会静默覆盖）', () => {
    const seen = new Map();
    const dups = [];
    for (const file of routeFiles()) {
        for (const r of routesOf(file)) {
            for (const method of r.methods) {
                const key = `${method.toUpperCase()} ${r.path}`;
                if (seen.has(key)) dups.push(`${key}：${seen.get(key)} 与 ${r.file}`);
                else seen.set(key, r.file);
            }
        }
    }
    assert.deepEqual(dups, [], `重复路由：\n${dups.join('\n')}`);
});

test('路由模块不反向 require server/index.js（避免循环与隐式单例）', () => {
    const offenders = [];
    for (const file of routeFiles()) {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
            if (/(^|\/)index(\.js)?$/.test(m[1]) && !m[1].startsWith('../core') && !m[1].startsWith('../session')) {
                offenders.push(`${path.relative(SERVER_DIR, file)} → ${m[1]}`);
            }
        }
    }
    assert.deepEqual(offenders, [], `路由不应依赖服务入口：\n${offenders.join('\n')}`);
});

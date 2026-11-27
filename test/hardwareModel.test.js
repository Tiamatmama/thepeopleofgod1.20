'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildMesh, normalizeSpec, profilePoints, toFacetedStep } = require('../hardware/model/build');

const specPath = path.join(__dirname, '..', 'hardware', 'model', 'specs', 'phone-stand.json');
const gearSpecPath = path.join(__dirname, '..', 'hardware', 'model', 'specs', 'gear-blank.json');
const assemblySpecPath = path.join(__dirname, '..', 'hardware', 'model', 'specs', 'stand-with-gear.json');
const hydrantSpecPath = path.join(__dirname, '..', 'hardware', 'model', 'specs', 'hydrant-hollow.json');

test('硬件建模：默认手机支架是水密实体，尺寸与体积符合参数', () => {
    const spec = normalizeSpec(JSON.parse(fs.readFileSync(specPath, 'utf8')));
    const mesh = buildMesh(spec);

    assert.equal(profilePoints(spec).length, 8);
    assert.equal(mesh.triangleCount, 28); // 2 个 6 面封口 + 8 面墙 × 2
    assert.ok(mesh.volume > 0);
    assert.ok(Math.abs(mesh.volume - 66000) < 1, '截面积 1100 mm² × 深 60 mm');
    assert.deepEqual(
        mesh.bbox.size.map(value => Math.round(value)),
        [80, 60, 70]
    );
});

test('硬件建模：背板过厚会被拒绝', () => {
    assert.throws(
        () => normalizeSpec({ width: 10, depth: 10, height: 20, backThickness: 9, lipThickness: 6 }),
        /背板太厚/
    );
});

test('硬件建模：STEP 是 Inventor 可导入的 FACETED_BREP，实体引用完整', () => {
    const spec = normalizeSpec(JSON.parse(fs.readFileSync(specPath, 'utf8')));
    const mesh = buildMesh(spec);
    const step = toFacetedStep(spec, mesh);

    assert.match(step, /^ISO-10303-21;/);
    assert.match(step, /AUTOMOTIVE_DESIGN/);
    assert.match(step, /FACETED_BREP\('/);
    assert.match(step, /FACETED_BREP_SHAPE_REPRESENTATION/);
    assert.match(step, /SHAPE_REPRESENTATION_RELATIONSHIP/);
    assert.match(step, /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
    assert.equal((step.match(/ADVANCED_FACE/g) || []).length, 10);
    assert.equal((step.match(/POLY_LOOP/g) || []).length, 10);
    assert.equal((step.match(/FACE_OUTER_BOUND/g) || []).length, 10);

    const defined = new Set([...step.matchAll(/^#(\d+)=/gm)].map(match => match[1]));
    const referenced = new Set([...step.matchAll(/#(\d+)/g)].map(match => match[1]));
    const missing = [...referenced].filter(id => !defined.has(id));
    assert.deepEqual(missing, [], '不能有悬空引用');
});

test('硬件建模：18 齿凹多边形也能水密拉伸并导出 74 面 STEP', () => {
    const spec = normalizeSpec(JSON.parse(fs.readFileSync(gearSpecPath, 'utf8')));
    const mesh = buildMesh(spec);

    assert.equal(profilePoints(spec).length, 72);
    assert.equal(mesh.triangleCount, 284);
    assert.ok(mesh.volume > 0);
    assert.ok(Math.abs(mesh.bbox.size[1] - 10) < 1e-6, '厚度 10mm');
    assert.ok(mesh.bbox.size[0] > 59 && mesh.bbox.size[0] <= 60.1);

    const step = toFacetedStep(spec, mesh);
    assert.equal((step.match(/ADVANCED_FACE/g) || []).length, 74);
    assert.equal((step.match(/POLY_LOOP/g) || []).length, 74);
    assert.doesNotMatch(step, /NaN|Infinity/);
});

test('硬件建模：组合件导出为两个独立实体', () => {
    const spec = normalizeSpec(JSON.parse(fs.readFileSync(assemblySpecPath, 'utf8')));
    const mesh = buildMesh(spec);

    assert.equal(spec.components.length, 2);
    assert.equal(mesh.triangleCount, 312);
    assert.deepEqual(mesh.bbox.size.map(value => Math.round(value)), [90, 60, 70]);

    const step = toFacetedStep(spec, mesh);
    assert.equal((step.match(/FACETED_BREP\('/g) || []).length, 2);
    assert.equal((step.match(/CLOSED_SHELL/g) || []).length, 2);
    assert.equal((step.match(/ADVANCED_FACE/g) || []).length, 84);

    const defined = new Set([...step.matchAll(/^#(\d+)=/gm)].map(match => match[1]));
    const referenced = new Set([...step.matchAll(/#(\d+)/g)].map(match => match[1]));
    assert.deepEqual([...referenced].filter(id => !defined.has(id)), []);
});

test('硬件建模：镂空叶轮是单一水密实体', () => {
    const spec = normalizeSpec({
        name: 'impeller-test',
        type: 'impeller',
        outerRadius: 30,
        hubRadius: 12,
        height: 20,
        bladeCount: 6,
        bladeThickness: 3,
        boreRadius: 5,
        cell: 2
    });
    const mesh = buildMesh(spec);

    assert.equal(mesh.implicit, true);
    assert.ok(mesh.triangleCount > 1000);
    assert.ok(mesh.volume > 0);
    const step = toFacetedStep(spec, mesh);
    assert.equal((step.match(/FACETED_BREP\('/g) || []).length, 1);
    assert.equal((step.match(/ADVANCED_FACE/g) || []).length, mesh.triangleCount);
});

test('硬件建模：镂空消防栓是单一水密实体（隐式等值面）', () => {
    const raw = JSON.parse(fs.readFileSync(hydrantSpecPath, 'utf8'));
    const spec = normalizeSpec({ ...raw, cell: 2 }); // 测试用略粗网格，保持速度且不塌薄壁
    const mesh = buildMesh(spec);

    assert.equal(mesh.implicit, true);
    assert.ok(mesh.triangleCount > 1000);
    assert.ok(mesh.volume > 0);
    assert.ok(Math.abs(mesh.bbox.size[0] - 48) <= 4);
    assert.ok(Math.abs(mesh.bbox.size[2] - 78) <= 4);

    const step = toFacetedStep(spec, mesh);
    assert.match(step, /FACETED_BREP\('/);
    assert.equal((step.match(/ADVANCED_FACE/g) || []).length, mesh.triangleCount);
});

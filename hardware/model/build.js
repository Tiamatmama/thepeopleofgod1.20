'use strict';

// 无打印机硬件建模流程：参数 spec → 轮廓三角化 → 拉伸成实体 → SCAD / STL / SVG 预览。
// 只依赖 Node 标准库；OpenSCAD 装了可以拿 .scad 继续改，不装也能直接出可打印 STL。
// 几何约定：X = 宽，Y = 厚（深度），Z = 高；STL 是 Z 向上。

const fs = require('fs');
const path = require('path');

const DEFAULT_SPEC = path.join(__dirname, 'specs', 'phone-stand.json');
const OUT_DIR = path.join(__dirname, 'out');

function readNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} 必须是正数，收到 ${value}`);
  }
  return n;
}

function normalizeSpec(raw) {
  const name = String(raw.name || 'part').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60) || 'part';
  const unit = String(raw.unit || 'mm');
  const type = String(raw.type || 'phone-stand');

  if (type === 'assembly') {
    const entries = Array.isArray(raw.components) ? raw.components : [];
    if (entries.length < 1 || entries.length > 12) {
      throw new Error('组合件需要 1–12 个 components');
    }
    const components = entries.map((entry, index) => {
      if (!entry || !entry.spec) throw new Error(`components[${index}] 缺少 spec`);
      const componentSpec = normalizeSpec({
        ...entry.spec,
        name: entry.spec.name || `${name}-part${index + 1}`
      });
      if (componentSpec.type === 'assembly') {
        throw new Error('组合件里不能再嵌套组合件');
      }
      const placement = entry.placement || {};
      const translate = Array.isArray(placement.translate)
        ? placement.translate.map(Number)
        : [0, 0, 0];
      if (translate.length !== 3 || !translate.every(Number.isFinite)) {
        throw new Error(`components[${index}].placement.translate 必须是 3 个数字`);
      }
      return {
        spec: componentSpec,
        placement: { translate, rotateZ: Number(placement.rotateZ) || 0 }
      };
    });
    return { name, unit, type: 'assembly', components };
  }

  if (type === 'hydrant') {
    const spec = {
      name,
      unit,
      type,
      outerRadius: readNumber(raw.outerRadius == null ? 14 : raw.outerRadius, 'outerRadius'),
      innerRadius: readNumber(raw.innerRadius == null ? 10 : raw.innerRadius, 'innerRadius'),
      height: readNumber(raw.height == null ? 55 : raw.height, 'height'),
      baseRadius: readNumber(raw.baseRadius == null ? 22 : raw.baseRadius, 'baseRadius'),
      baseHeight: readNumber(raw.baseHeight == null ? 6 : raw.baseHeight, 'baseHeight'),
      windowCount: Math.round(readNumber(raw.windowCount == null ? 6 : raw.windowCount, 'windowCount')),
      windowZ: readNumber(raw.windowZ == null ? 30 : raw.windowZ, 'windowZ'),
      windowHeight: readNumber(raw.windowHeight == null ? 24 : raw.windowHeight, 'windowHeight'),
      windowWidth: readNumber(raw.windowWidth == null ? 10 : raw.windowWidth, 'windowWidth'),
      nozzleZ: readNumber(raw.nozzleZ == null ? 45 : raw.nozzleZ, 'nozzleZ'),
      cell: readNumber(raw.cell == null ? 1.8 : raw.cell, 'cell')
    };
    if (spec.innerRadius >= spec.outerRadius) throw new Error('内腔半径必须小于外半径');
    if (spec.windowCount < 2 || spec.windowCount > 24) throw new Error('窗口数量必须在 2–24 之间');
    if (spec.windowZ - spec.windowHeight / 2 < 2 || spec.windowZ + spec.windowHeight / 2 > spec.height) {
      throw new Error('窗口超出筒身高度');
    }
    return spec;
  }

  if (type === 'impeller') {
    const spec = {
      name,
      unit,
      type,
      outerRadius: readNumber(raw.outerRadius == null ? 45 : raw.outerRadius, 'outerRadius'),
      hubRadius: readNumber(raw.hubRadius == null ? 16 : raw.hubRadius, 'hubRadius'),
      height: readNumber(raw.height == null ? 28 : raw.height, 'height'),
      bladeCount: Math.round(readNumber(raw.bladeCount == null ? 8 : raw.bladeCount, 'bladeCount')),
      bladeThickness: readNumber(raw.bladeThickness == null ? 3 : raw.bladeThickness, 'bladeThickness'),
      boreRadius: readNumber(raw.boreRadius == null ? 8 : raw.boreRadius, 'boreRadius'),
      cell: readNumber(raw.cell == null ? 1.8 : raw.cell, 'cell')
    };
    if (spec.hubRadius >= spec.outerRadius - 8) throw new Error('轮毂半径至少要比外半径小 8mm');
    if (spec.boreRadius >= spec.hubRadius - 3) throw new Error('中心孔至少要比轮毂半径小 3mm');
    if (spec.bladeCount < 5 || spec.bladeCount > 16) throw new Error('叶片数量必须在 5–16 之间');
    if (spec.bladeThickness < 2 || spec.bladeThickness > 6) throw new Error('叶片厚度必须在 2–6mm 之间');
    if (spec.height < 18 || spec.height > 50) throw new Error('叶轮高度必须在 18–50mm 之间');
    return spec;
  }

  if (type === 'gear') {
    const spec = {
      name,
      unit,
      type,
      teeth: Math.round(readNumber(raw.teeth == null ? 18 : raw.teeth, 'teeth')),
      outerRadius: readNumber(raw.outerRadius == null ? 30 : raw.outerRadius, 'outerRadius'),
      rootRadius: readNumber(raw.rootRadius == null ? 23 : raw.rootRadius, 'rootRadius'),
      depth: readNumber(raw.depth == null ? 10 : raw.depth, 'depth')
    };
    if (spec.teeth < 6 || spec.teeth > 120) {
      throw new Error('齿数必须在 6–120 之间');
    }
    if (spec.rootRadius >= spec.outerRadius) {
      throw new Error('齿根圆必须小于齿顶圆');
    }
    // 只为摘要/兼容旧字段；真实尺寸以包围盒为准
    spec.width = spec.outerRadius * 2;
    spec.height = spec.outerRadius * 2;
    return spec;
  }

  const spec = {
    name,
    unit,
    type: 'phone-stand',
    width: readNumber(raw.width, 'width'),
    depth: readNumber(raw.depth, 'depth'),
    height: readNumber(raw.height, 'height'),
    baseThickness: readNumber(raw.baseThickness == null ? 6 : raw.baseThickness, 'baseThickness'),
    backThickness: readNumber(raw.backThickness == null ? 8 : raw.backThickness, 'backThickness'),
    lipThickness: readNumber(raw.lipThickness == null ? 6 : raw.lipThickness, 'lipThickness'),
    lipHeight: readNumber(raw.lipHeight == null ? 18 : raw.lipHeight, 'lipHeight')
  };

  if (spec.backThickness >= spec.width - spec.lipThickness) {
    throw new Error('背板太厚：backThickness 必须小于 width - lipThickness');
  }
  if (spec.baseThickness + spec.lipHeight >= spec.height) {
    throw new Error('前挡太高：baseThickness + lipHeight 必须小于 height');
  }
  if (spec.lipThickness <= 0 || spec.baseThickness <= 0) {
    throw new Error('底板/前挡厚度必须为正');
  }
  return spec;
}

// 齿形轮廓：每个齿 4 个点（根→顶→顶→根），齿间用直弦收口。
// 80 个点左右的凹多边形会同时压测耳切、STL 和 STEP 导出。
function gearProfile(spec) {
  const points = [];
  const step = (Math.PI * 2) / spec.teeth;
  const root = spec.rootRadius;
  const outer = spec.outerRadius;
  for (let i = 0; i < spec.teeth; i += 1) {
    const a = i * step;
    const angles = [a, a + step * 0.22, a + step * 0.48, a + step * 0.72];
    const radii = [root, outer, outer, root];
    for (let k = 0; k < 4; k += 1) {
      points.push([radii[k] * Math.cos(angles[k]), radii[k] * Math.sin(angles[k])]);
    }
  }
  return points;
}

// 每个拉伸实体的面环：2 个端盖 + n 个侧墙
function buildProfileLoops(spec) {
  const n = profilePoints(spec).length;
  const loops = [
    Array.from({ length: n }, (_, i) => i),
    Array.from({ length: n }, (_, i) => n + (n - i) % n)
  ];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    loops.push([i, n + i, n + j, j]);
  }
  return loops;
}

function applyPlacement(vertices, placement) {
  const angle = ((Number(placement.rotateZ) || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [tx, ty, tz] = placement.translate;
  return vertices.map(([x, y, z]) => [
    x * cos - y * sin + tx,
    x * sin + y * cos + ty,
    z + tz
  ]);
}

function sdBox(x, y, z, hx, hy, hz) {
  const qx = Math.abs(x) - hx;
  const qy = Math.abs(y) - hy;
  const qz = Math.abs(z) - hz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}

function sdCylinderZ(x, y, z, radius, z0, z1) {
  return Math.max(Math.hypot(x, y) - radius, z0 - z, z - z1);
}

function sdCylinderX(x, y, z, radius, x0, x1, centerZ) {
  return Math.max(Math.hypot(y, z - centerZ) - radius, x0 - x, x - x1);
}

// 消防栓隐式实体：底座 + 筒身 + 阶梯顶 + 两侧接口，内部挖空并开穿墙窗口。
// 用 SDF 而不是拼零件，保证最后只有一个连通实体。
function sdHydrant(spec, x, y, z) {
  const R = spec.outerRadius;
  const r = spec.innerRadius;
  const H = spec.height;

  let d = Math.min(
    sdCylinderZ(x, y, z, spec.baseRadius, -spec.baseHeight, 0),
    sdCylinderZ(x, y, z, R, 0, H),
    sdCylinderZ(x, y, z, R * 0.72, H, H + 5),
    sdCylinderZ(x, y, z, R * 0.45, H + 5, H + 12),
    sdCylinderZ(x, y, z, R * 0.22, H + 12, H + 17)
  );

  // 内腔：从 z=2 到筒顶，壁厚 R-r
  d = Math.max(d, -sdCylinderZ(x, y, z, r, 2, H));

  // 穿墙窗口：径向盒子，绕轴均匀分布
  for (let i = 0; i < spec.windowCount; i += 1) {
    const angle = (i * Math.PI * 2) / spec.windowCount;
    const lx = x * Math.cos(angle) + y * Math.sin(angle);
    const ly = -x * Math.sin(angle) + y * Math.cos(angle);
    const cut = sdBox(
      lx - (r + R) / 2,
      ly,
      z - spec.windowZ,
      (R - r) / 2 + 1.5,
      spec.windowWidth / 2,
      spec.windowHeight / 2
    );
    d = Math.max(d, -cut);
  }

  // 两侧接口：外凸圆柱 + 内孔，内孔连通内腔
  const nozzle = Math.min(
    sdCylinderX(x, y, z, 6, 10, 24, spec.nozzleZ),
    sdCylinderX(x, y, z, 6, -24, -10, spec.nozzleZ)
  );
  d = Math.min(d, nozzle);
  const bore = Math.min(
    sdCylinderX(x, y, z, 3.5, 8, 25, spec.nozzleZ),
    sdCylinderX(x, y, z, 3.5, -25, -8, spec.nozzleZ)
  );
  d = Math.max(d, -bore);

  return d;
}

// 镂空离心叶轮：带窗口的底盘 + 空心轮毂 + 径向叶片，单一连通实体
function sdImpeller(spec, x, y, z) {
  const R = spec.outerRadius;
  const H = spec.hubRadius;
  const T = spec.height;
  const W = spec.bladeThickness;

  let d = Math.min(
    sdCylinderZ(x, y, z, R, -3, 3),
    sdCylinderZ(x, y, z, H, 0, T)
  );

  // 底盘窗口：沿圆周均匀切穿
  for (let i = 0; i < spec.bladeCount; i += 1) {
    const angle = (i * Math.PI * 2) / spec.bladeCount + Math.PI / spec.bladeCount;
    const lx = x * Math.cos(angle) + y * Math.sin(angle);
    const ly = -x * Math.sin(angle) + y * Math.cos(angle);
    const cut = sdBox(
      lx - (H + R) / 2,
      ly,
      z,
      (R - H) * 0.38,
      W * 1.5,
      4
    );
    d = Math.max(d, -cut);
  }

  // 径向叶片：从轮毂伸到外缘，落在底盘上
  for (let i = 0; i < spec.bladeCount; i += 1) {
    const angle = (i * Math.PI * 2) / spec.bladeCount;
    const lx = x * Math.cos(angle) + y * Math.sin(angle);
    const ly = -x * Math.sin(angle) + y * Math.cos(angle);
    const blade = sdBox(
      lx - (H + R) / 2,
      ly,
      z - (T + 3) / 2,
      (R - H) / 2 + 0.5,
      W / 2,
      (T - 3) / 2
    );
    d = Math.min(d, blade);
  }

  // 中心孔贯通
  d = Math.max(d, -sdCylinderZ(x, y, z, spec.boreRadius, -4, T + 1));
  return d;
}

// Marching tetrahedra：把每个网格立方体拆成 6 个四面体，按符号插值出等值面。
// 比 voxel 方块平滑，且天然只有一个水密壳体。
function buildImplicitMesh(spec) {
  const cell = spec.cell;
  const pad = 5;
  const isImpeller = spec.type === 'impeller';
  const sdf = isImpeller ? sdImpeller : sdHydrant;
  // 网格整体偏移一点，避免采样面正好落在 z=窗口中心/圆柱端面这类特征平面上
  const offset = cell * 0.0137;
  const span = isImpeller ? spec.outerRadius + 6 : spec.baseRadius + pad;
  const minX = -span;
  const maxX = span;
  const minY = minX;
  const maxY = maxX;
  const minZ = isImpeller ? -8 : -spec.baseHeight - pad;
  const maxZ = isImpeller ? spec.height + 8 : spec.height + 24;

  const nx = Math.ceil((maxX - minX) / cell) + 1;
  const ny = Math.ceil((maxY - minY) / cell) + 1;
  const nz = Math.ceil((maxZ - minZ) / cell) + 1;
  const values = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => (k * ny + j) * nx + i;

  for (let k = 0; k < nz; k += 1) {
    const z = minZ + k * cell + offset;
    for (let j = 0; j < ny; j += 1) {
      const y = minY + j * cell + offset;
      for (let i = 0; i < nx; i += 1) {
        values[at(i, j, k)] = sdf(spec, minX + i * cell + offset, y, z);
      }
    }
  }

  const vertices = [];
  const faces = [];
  const vertexMap = new Map();
  const addVertex = (p) => {
    const key = `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`;
    let index = vertexMap.get(key);
    if (index == null) {
      index = vertices.length;
      vertices.push(p);
      vertexMap.set(key, index);
    }
    return index;
  };

  const corners = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]
  ];
  const tets = [
    [0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
    [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]
  ];

  const gradient = (x, y, z) => {
    const e = cell * 0.5;
    return [
      sdf(spec, x + e, y, z) - sdf(spec, x - e, y, z),
      sdf(spec, x, y + e, z) - sdf(spec, x, y - e, z),
      sdf(spec, x, y, z + e) - sdf(spec, x, y, z - e)
    ];
  };

  const addTriangle = (a, b, c) => {
    // 粗网格上插值点可能退化到同一个顶点，直接丢掉，避免自环边
    if (a === b || b === c || a === c) return;
    const pa = vertices[a];
    const pb = vertices[b];
    const pc = vertices[c];
    const u = sub(pb, pa);
    const v = sub(pc, pa);
    const normal = cross(u, v);
    const center = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3];
    if (dot(normal, gradient(center[0], center[1], center[2])) < 0) {
      faces.push([a, c, b]);
    } else {
      faces.push([a, b, c]);
    }
  };

  for (let k = 0; k < nz - 1; k += 1) {
    for (let j = 0; j < ny - 1; j += 1) {
      for (let i = 0; i < nx - 1; i += 1) {
        const cornerValues = corners.map(([di, dj, dk]) => values[at(i + di, j + dj, k + dk)]);
        const cornerPoints = corners.map(([di, dj, dk]) => [
          minX + (i + di) * cell + offset,
          minY + (j + dj) * cell + offset,
          minZ + (k + dk) * cell + offset
        ]);

        for (const tet of tets) {
          const vals = tet.map(index => cornerValues[index]);
          const inside = [];
          const outside = [];
          for (let q = 0; q < 4; q += 1) (vals[q] < 0 ? inside : outside).push(q);
          if (inside.length === 0 || inside.length === 4) continue;

          const interp = (a, b) => {
            const t = vals[a] / (vals[a] - vals[b]);
            const pa = cornerPoints[tet[a]];
            const pb = cornerPoints[tet[b]];
            return addVertex([
              pa[0] + (pb[0] - pa[0]) * t,
              pa[1] + (pb[1] - pa[1]) * t,
              pa[2] + (pb[2] - pa[2]) * t
            ]);
          };

          if (inside.length === 1) {
            const a = inside[0];
            addTriangle(interp(a, outside[0]), interp(a, outside[1]), interp(a, outside[2]));
          } else if (inside.length === 3) {
            const b = outside[0];
            addTriangle(interp(b, inside[0]), interp(b, inside[2]), interp(b, inside[1]));
          } else {
            const [a0, a1] = inside;
            const [b0, b1] = outside;
            const p00 = interp(a0, b0);
            const p01 = interp(a0, b1);
            const p10 = interp(a1, b0);
            const p11 = interp(a1, b1);
            addTriangle(p00, p01, p11);
            addTriangle(p00, p11, p10);
          }
        }
      }
    }
  }

  let volume = meshVolume(vertices, faces);
  if (volume < 0) {
    for (const face of faces) {
      const tmp = face[1];
      face[1] = face[2];
      face[2] = tmp;
    }
    volume = -volume;
  }

  return {
    spec,
    vertices,
    faces,
    volume,
    edges: assertWatertight(faces),
    bbox: boundingBox(vertices),
    triangleCount: faces.length,
    implicit: true
  };
}

// 组合件：每个零件仍是独立水密实体，合并到同一份顶点/面数组里。
// STEP 侧会导出为多个 FACETED_BREP，Inventor 打开是多实体零件。
function buildAssemblyMesh(spec) {
  const components = [];
  const vertices = [];
  const faces = [];
  let volume = 0;
  let edges = 0;

  for (const entry of spec.components) {
    const part = buildMesh(entry.spec);
    const placed = applyPlacement(part.vertices, entry.placement);
    const base = vertices.length;
    vertices.push(...placed);
    faces.push(...part.faces.map(tri => tri.map(index => index + base)));
    volume += part.volume;
    edges += part.edges;
    components.push({ spec: part.spec, mesh: { ...part, vertices: placed } });
  }

  return {
    spec,
    components,
    vertices,
    faces,
    volume,
    edges,
    bbox: boundingBox(vertices),
    triangleCount: faces.length
  };
}

// 侧视轮廓：底板 + 背板 + 前挡，L 形。顺时针/逆时针都行，三角化前会统一成逆时针。
function profilePoints(spec) {
  if (spec.type === 'gear') return gearProfile(spec);
  const w = spec.width;
  const h = spec.height;
  const b = spec.baseThickness;
  const bt = spec.backThickness;
  const lt = spec.lipThickness;
  const lh = spec.lipHeight;
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [w - bt, h],
    [w - bt, b],
    [lt, b],
    [lt, b + lh],
    [0, b + lh]
  ];
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function cross2(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(p, a, b, c, eps = 1e-9) {
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  const hasNeg = d1 < -eps || d2 < -eps || d3 < -eps;
  const hasPos = d1 > eps || d2 > eps || d3 > eps;
  return !(hasNeg && hasPos);
}

// Ear clipping：只处理简单多边形（不处理自交）。轮廓点很少，O(n²) 足够。
function triangulate(points) {
  const pts = signedArea(points) < 0 ? points.slice().reverse() : points.slice();
  const indices = pts.map((_, index) => index);
  const triangles = [];
  let guard = 0;

  while (indices.length > 3) {
    if (guard++ > 10000) throw new Error('轮廓三角化失败：疑似自交或重复点');
    let clipped = false;
    for (let i = 0; i < indices.length; i += 1) {
      const n = indices.length;
      const i0 = indices[(i - 1 + n) % n];
      const i1 = indices[i];
      const i2 = indices[(i + 1) % n];
      const a = pts[i0];
      const b = pts[i1];
      const c = pts[i2];
      if (cross2(a, b, c) <= 1e-9) continue; // 凹角，不能剪
      let contains = false;
      for (const j of indices) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTriangle(pts[j], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      triangles.push([i0, i1, i2]);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('轮廓三角化失败：没有可剪的耳朵');
  }
  if (indices.length === 3) triangles.push(indices.slice());
  return { points: pts, triangles };
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function length(a) { return Math.sqrt(dot(a, a)); }
function normalize(a) {
  const len = length(a);
  return len > 1e-12 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
}

function faceNormal(vertices, tri) {
  const a = vertices[tri[0]];
  const b = vertices[tri[1]];
  const c = vertices[tri[2]];
  return normalize(cross(sub(b, a), sub(c, a)));
}

// 轮廓在 XZ 平面，沿 Y 拉伸；两端封口 + 每条边一面墙。
function extrude(profile, depth) {
  const { points, triangles } = triangulate(profile);
  const half = depth / 2;
  const n = points.length;
  const vertices = [];

  for (const [x, z] of points) vertices.push([x, -half, z]);
  for (const [x, z] of points) vertices.push([x, half, z]);

  const faces = [];
  // 前封口（y = -half）：逆时针轮廓在 XZ 平面法线朝 -Y
  for (const [a, b, c] of triangles) faces.push([a, b, c]);
  // 后封口（y = +half）：反向
  for (const [a, b, c] of triangles) faces.push([n + a, n + c, n + b]);

  // 侧墙：按逆时针边顺序生成，再按边的外法线校正朝外。
  // 不能用「边中点 − 轮廓中心」：凹多边形里这个方向并不垂直于边，会把墙判反
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const frontI = i;
    const frontJ = j;
    const backI = n + i;
    const backJ = n + j;
    const quad = [
      [frontI, frontJ, backJ],
      [frontI, backJ, backI]
    ];
    const dx = points[j][0] - points[i][0];
    const dz = points[j][1] - points[i][1];
    const outward = [dz, 0, -dx]; // 逆时针轮廓的右手侧
    for (const tri of quad) {
      const normal = faceNormal(vertices, tri);
      if (dot(normal, outward) < 0) faces.push([tri[0], tri[2], tri[1]]);
      else faces.push(tri);
    }
  }

  return { vertices, faces, profile: points };
}

function meshVolume(vertices, faces) {
  let sum = 0;
  for (const [a, b, c] of faces) {
    sum += dot(vertices[a], cross(vertices[b], vertices[c]));
  }
  return sum / 6;
}

function boundingBox(vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let i = 0; i < 3; i += 1) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// 水密性自检：每条无向边必须正好被两个三角面使用
function assertWatertight(faces) {
  const usage = new Map();
  for (const [a, b, c] of faces) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      usage.set(key, (usage.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of usage) {
    if (count !== 2) throw new Error(`网格不水密：边 ${key} 被 ${count} 个面使用`);
  }
  return usage.size;
}

function buildMesh(rawSpec) {
  const spec = normalizeSpec(rawSpec);
  if (spec.type === 'assembly') return buildAssemblyMesh(spec);
  if (spec.type === 'hydrant' || spec.type === 'impeller') return buildImplicitMesh(spec);
  const profile = profilePoints(spec);
  const extruded = extrude(profile, spec.depth);
  let { vertices, faces } = extruded;

  let volume = meshVolume(vertices, faces);
  if (volume < 0) {
    faces = faces.map(([a, b, c]) => [a, c, b]);
    volume = -volume;
  }

  const edges = assertWatertight(faces);
  const box = boundingBox(vertices);
  return {
    spec,
    vertices,
    faces,
    volume,
    edges,
    bbox: box,
    triangleCount: faces.length
  };
}

function toScad(spec) {
  if (spec.type === 'assembly' || spec.type === 'hydrant' || spec.type === 'impeller') {
    return '// 该模型由隐式实体/多实体生成：请使用 STEP / STL，SCAD 不适用。\n';
  }
  const points = profilePoints(spec).map(([x, z]) => `[${x}, ${z}]`).join(', ');
  const params = spec.type === 'gear'
    ? `teeth = ${spec.teeth};
outerRadius = ${spec.outerRadius};
rootRadius = ${spec.rootRadius};`
    : `width = ${spec.width};
height = ${spec.height};
baseThickness = ${spec.baseThickness};
backThickness = ${spec.backThickness};
lipThickness = ${spec.lipThickness};
lipHeight = ${spec.lipHeight};`;
  return `// 由 hardware/model/build.js 生成；改参数后可用 OpenSCAD 重新导出
// 坐标：X = 宽，Y = 高，Z = 厚（与 STL 的 Y/Z 互换）
$fn = 64;
${params}
depth = ${spec.depth};

linear_extrude(height = depth, center = true)
  polygon(points = [${points}]);
`;
}

function stepNum(value) {
  if (Math.abs(value) < 1e-9) return '0.';
  return Number(value).toFixed(4).replace(/0+$/, '');
}

// 平面多边形法线（Newell 方法，凹多边形也适用）
function polygonNormal(vertices, loop) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = vertices[loop[i]];
    const b = vertices[loop[(i + 1) % loop.length]];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return normalize([nx, ny, nz]);
}

// 备用：显式顶点/边/环的精确 B-rep。几何与上面的 FACETED_BREP 相同，
// 但 Inventor 2027 实测会静默导入成空零件；保留给其他 CAD 或后续研究。
function toStep(spec, mesh) {
  if (spec.type === 'assembly' || spec.type === 'hydrant' || spec.type === 'impeller') {
    throw new Error('该模型请用 toFacetedStep 导出');
  }
  const profile = profilePoints(spec);
  const n = profile.length;
  const depthHalf = spec.depth / 2;
  const loops = [];

  // 端盖：前盖沿用逆时针轮廓（法线 -Y），后盖反向（法线 +Y）
  loops.push(Array.from({ length: n }, (_, i) => i));
  loops.push(Array.from({ length: n }, (_, i) => n + (n - i) % n));

  // 侧墙：F_i → B_i → B_j → F_j，法线朝外
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    loops.push([i, n + i, n + j, j]);
  }

  // 自检：顶点布局必须与 extrude() 一致，否则 STEP 和 STL 不是同一个实体
  for (let i = 0; i < n; i += 1) {
    const front = mesh.vertices[i];
    const back = mesh.vertices[n + i];
    if (Math.abs(front[1] + depthHalf) > 1e-6 || Math.abs(back[1] - depthHalf) > 1e-6) {
      throw new Error('STEP 顶点布局与拉伸体不一致');
    }
  }

  let nextId = 1;
  const entities = [];
  const add = (text) => {
    const id = nextId++;
    entities.push(`#${id}=${text};`);
    return id;
  };
  const point = (v) => add(`CARTESIAN_POINT('',(${v.map(stepNum).join(',')}))`);
  const direction = (v) => add(`DIRECTION('',(${v.map(stepNum).join(',')}))`);

  const app = add("APPLICATION_CONTEXT('automotive design')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const productContext = add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const product = add(`PRODUCT('${spec.name}','${spec.name}','',(#${productContext}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','part',(#${product}))`);
  const definitionContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const definition = add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionContext})`);
  const definitionShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);

  // 单位：毫米 + 弧度 + 球面度；Inventor 对上下文里缺失角度单位的 B-rep 会静默丢弃
  const unit = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angleUnit = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solidAngleUnit = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const uncertainty = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${unit},'distance_accuracy_value','confusion accuracy')`);
  const context = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${unit},#${angleUnit},#${solidAngleUnit}))REPRESENTATION_CONTEXT('','3D'))`);

  const originPoint = point([0, 0, 0]);
  const zAxis = direction([0, 0, 1]);
  const xAxis = direction([1, 0, 0]);
  const worldAxis = add(`AXIS2_PLACEMENT_3D('',#${originPoint},#${zAxis},#${xAxis})`);

  // 顶点共享：16 个几何点 + 16 个拓扑顶点
  const pointIds = mesh.vertices.map(point);
  const vertexIds = pointIds.map(id => add(`VERTEX_POINT('',#${id})`));

  // 边共享：每个面沿环取边，同一条边只建一次 EDGE_CURVE，面里用 ORIENTED_EDGE 选方向
  const edgeMap = new Map();
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i += 1) {
      const u = loop[i];
      const v = loop[(i + 1) % loop.length];
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (edgeMap.has(key)) continue;
      const dirId = direction(normalize(sub(mesh.vertices[v], mesh.vertices[u])));
      const vecId = add(`VECTOR('',#${dirId},.T.)`);
      const lineId = add(`LINE('',#${pointIds[u]},#${vecId})`);
      const curveId = add(`EDGE_CURVE('',#${vertexIds[u]},#${vertexIds[v]},#${lineId},.T.)`);
      edgeMap.set(key, { curveId, from: u, to: v });
    }
  }

  const faceIds = [];
  for (const loop of loops) {
    const normal = polygonNormal(mesh.vertices, loop);
    if (length(normal) < 0.5) throw new Error('STEP 面法线退化');
    const origin = point(mesh.vertices[loop[0]]);
    const normalId = direction(normal);
    const refId = direction(normalize(sub(mesh.vertices[loop[1]], mesh.vertices[loop[0]])));
    const placement = add(`AXIS2_PLACEMENT_3D('',#${origin},#${normalId},#${refId})`);
    const plane = add(`PLANE('',#${placement})`);

    const oriented = [];
    for (let i = 0; i < loop.length; i += 1) {
      const u = loop[i];
      const v = loop[(i + 1) % loop.length];
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      const edge = edgeMap.get(key);
      const sameSense = edge.from === u ? '.T.' : '.F.';
      oriented.push(add(`ORIENTED_EDGE('',*,*,#${edge.curveId},${sameSense})`));
    }
    const loopId = add(`EDGE_LOOP('',(${oriented.map(id => `#${id}`).join(',')}))`);
    const bound = add(`FACE_OUTER_BOUND('',#${loopId},.T.)`);
    faceIds.push(add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`));
  }

  const shell = add(`CLOSED_SHELL('',(${faceIds.map(id => `#${id}`).join(',')}))`);
  const solid = add(`MANIFOLD_SOLID_BREP('${spec.name}',#${shell})`);
  // 产品挂在一个普通 SHAPE_REPRESENTATION 上，再用关系指向 B-rep。
  // 直接让 SHAPE_DEFINITION_REPRESENTATION 指向 ADVANCED_BREP_SHAPE_REPRESENTATION
  // 在 Inventor 里会被解析成空零件（实测 0 实体），必须按它导出的结构走。
  const designRep = add(`SHAPE_REPRESENTATION('',(#${worldAxis}),#${context})`);
  const brepRep = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(#${solid}),#${context})`);
  add(`SHAPE_REPRESENTATION_RELATIONSHIP('SRR','None',#${designRep},#${brepRep})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${definitionShape},#${designRep})`);

  const stamp = new Date().toISOString().slice(0, 19);
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('${spec.name} B-rep'),'2;1');
FILE_NAME('${spec.name}.step','${stamp}',(''),(''),'hardware/model/build.js','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
${entities.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
}

// Inventor 兼容导出：FACETED_BREP + POLY_LOOP（不建边/顶点拓扑）。
// 2026-11-19 实测：Inventor 2027 打开后 SolidBodies/SurfaceBodies 均可识别为实体（10 个面）。
function toFacetedStep(spec, mesh) {
  const parts = mesh.implicit
    ? [{ spec, mesh, loops: mesh.faces }]
    : Array.isArray(mesh.components)
      ? mesh.components
      : [{ spec, mesh }];

  let nextId = 1;
  const entities = [];
  const add = (text) => {
    const id = nextId++;
    entities.push(`#${id}=${text};`);
    return id;
  };
  const point = (v) => add(`CARTESIAN_POINT('',(${v.map(stepNum).join(',')}))`);
  const direction = (v) => add(`DIRECTION('',(${v.map(stepNum).join(',')}))`);

  const app = add("APPLICATION_CONTEXT('automotive design')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const productContext = add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const product = add(`PRODUCT('${spec.name}','${spec.name}','',(#${productContext}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','part',(#${product}))`);
  const definitionContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const definition = add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionContext})`);
  const definitionShape = add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);

  const unit = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angleUnit = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solidAngleUnit = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const uncertainty = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.01),#${unit},'distance_accuracy_value','confusion accuracy')`);
  const context = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${unit},#${angleUnit},#${solidAngleUnit}))REPRESENTATION_CONTEXT('','3D'))`);

  const originPoint = point([0, 0, 0]);
  const zAxis = direction([0, 0, 1]);
  const xAxis = direction([1, 0, 0]);
  const worldAxis = add(`AXIS2_PLACEMENT_3D('',#${originPoint},#${zAxis},#${xAxis})`);

  const solids = [];
  for (const part of parts) {
    const partMesh = part.mesh || mesh;
    const loops = part.loops || buildProfileLoops(part.spec || spec);
    const pointIds = partMesh.vertices.map(point);
    const faceIds = [];
    for (const loop of loops) {
      const normal = polygonNormal(partMesh.vertices, loop);
      if (length(normal) < 0.5) throw new Error('STEP 面法线退化');
      const origin = point(partMesh.vertices[loop[0]]);
      const normalId = direction(normal);
      const refId = direction(normalize(sub(partMesh.vertices[loop[1]], partMesh.vertices[loop[0]])));
      const placement = add(`AXIS2_PLACEMENT_3D('',#${origin},#${normalId},#${refId})`);
      const plane = add(`PLANE('',#${placement})`);
      const poly = add(`POLY_LOOP('',(${loop.map(index => `#${pointIds[index]}`).join(',')}))`);
      const bound = add(`FACE_OUTER_BOUND('',#${poly},.T.)`);
      faceIds.push(add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`));
    }
    const shell = add(`CLOSED_SHELL('',(${faceIds.map(id => `#${id}`).join(',')}))`);
    solids.push(add(`FACETED_BREP('${(part.spec || spec).name}',#${shell})`));
  }

  const designRep = add(`SHAPE_REPRESENTATION('',(#${worldAxis}),#${context})`);
  const brepRep = add(`FACETED_BREP_SHAPE_REPRESENTATION('',(${solids.map(id => `#${id}`).join(',')}),#${context})`);
  add(`SHAPE_REPRESENTATION_RELATIONSHIP('SRR','None',#${designRep},#${brepRep})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(#${definitionShape},#${designRep})`);

  const stamp = new Date().toISOString().slice(0, 19);
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('${spec.name} faceted B-rep'),'2;1');
FILE_NAME('${spec.name}.step','${stamp}',(''),(''),'hardware/model/build.js','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
${entities.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
}

function toStl(spec, mesh) {
  const lines = [`solid ${spec.name}`];
  for (const [a, b, c] of mesh.faces) {
    const n = faceNormal(mesh.vertices, [a, b, c]);
    lines.push(`  facet normal ${n[0].toFixed(6)} ${n[1].toFixed(6)} ${n[2].toFixed(6)}`);
    lines.push('    outer loop');
    for (const index of [a, b, c]) {
      const v = mesh.vertices[index];
      lines.push(`      vertex ${v[0].toFixed(4)} ${v[1].toFixed(4)} ${v[2].toFixed(4)}`);
    }
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push(`endsolid ${spec.name}`);
  return `${lines.join('\n')}\n`;
}

function toSvg(spec, mesh) {
  const width = 900;
  const height = 700;
  const margin = 50;
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);

  const projected = mesh.vertices.map(([x, y, z]) => [((x - y) * cos), ((x + y) * sin - z)]);
  const xs = projected.map(p => p[0]);
  const ys = projected.map(p => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(
    (width - margin * 2) / Math.max(1, maxX - minX),
    (height - margin * 2) / Math.max(1, maxY - minY)
  );
  const tx = margin - minX * scale + (width - margin * 2 - (maxX - minX) * scale) / 2;
  const ty = margin - minY * scale + (height - margin * 2 - (maxY - minY) * scale) / 2;

  const light = normalize([0.45, 0.7, 0.85]);
  const faces = mesh.faces.map((tri) => {
    const depth = tri.reduce((sum, index) => {
      const v = mesh.vertices[index];
      return sum + v[0] + v[1] + v[2];
    }, 0) / 3;
    return { tri, depth, normal: faceNormal(mesh.vertices, tri) };
  }).sort((a, b) => a.depth - b.depth); // 远的先画

  const polygons = faces.map(({ tri, normal }) => {
    const intensity = 0.25 + 0.75 * Math.max(0, dot(normal, light));
    const r = Math.round(42 + (244 - 42) * intensity);
    const g = Math.round(28 + (120 - 28) * intensity);
    const b = Math.round(26 + (95 - 26) * intensity);
    const points = tri.map((index) => {
      const [px, py] = projected[index];
      return `${(px * scale + tx).toFixed(2)},${(py * scale + ty).toFixed(2)}`;
    }).join(' ');
    return `  <polygon points="${points}" fill="rgb(${r},${g},${b})" stroke="rgba(255,235,230,0.22)" stroke-width="0.8"/>`;
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#08080a"/>
  <g>
${polygons}
  </g>
  <text x="${margin}" y="${height - 24}" fill="#f4785f" font-family="ui-monospace, monospace" font-size="18">${spec.name} · ${spec.width}×${spec.depth}×${spec.height} ${spec.unit} · ${mesh.triangleCount} tris</text>
</svg>
`;
}

function buildFromSpec(rawSpec) {
  const mesh = buildMesh(rawSpec);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = mesh.spec.name;
  const scadPath = path.join(OUT_DIR, `${name}.scad`);
  const stlPath = path.join(OUT_DIR, `${name}.stl`);
  const stepPath = path.join(OUT_DIR, `${name}.step`);
  const svgPath = path.join(OUT_DIR, `${name}.svg`);
  fs.writeFileSync(scadPath, toScad(mesh.spec), 'utf8');
  fs.writeFileSync(stlPath, toStl(mesh.spec, mesh), 'utf8');
  fs.writeFileSync(stepPath, toFacetedStep(mesh.spec, mesh), 'utf8');
  fs.writeFileSync(svgPath, toSvg(mesh.spec, mesh), 'utf8');
  return { ...mesh, files: { scadPath, stlPath, stepPath, svgPath } };
}

function main() {
  const specPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SPEC;
  const raw = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const result = buildFromSpec(raw);
  const { spec, bbox, volume } = result;
  console.log(`[硬件建模] ${spec.name}`);
  console.log(`  尺寸: ${bbox.size.map(v => v.toFixed(2)).join(' × ')} ${spec.unit}`);
  console.log(`  三角面: ${result.triangleCount} / 水密边: ${result.edges}`);
  console.log(`  体积: ${(volume / 1000).toFixed(2)} cm³`);
  console.log(`  输出: ${result.files.scadPath}`);
  console.log(`        ${result.files.stlPath}`);
  console.log(`        ${result.files.stepPath}`);
  console.log(`        ${result.files.svgPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[硬件建模] 失败: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  normalizeSpec,
  profilePoints,
  triangulate,
  buildMesh,
  buildFromSpec,
  toScad,
  toStl,
  toStep,
  toFacetedStep,
  toSvg
};

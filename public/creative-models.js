// 家具几何层：家具类方块不再是一整块立方体，而是由若干子盒子拼装（桌面、桌腿、椅背、台面…）
// 坐标为格内 0~1 的局部坐标；tex 指向贴图/配色用的材质 id（复用 wood / stone / cloth 的贴图）
(function () {
  const box = (x0, y0, z0, x1, y1, z1, tex) => ({ x0, y0, z0, x1, y1, z1, tex });

  // 四条细腿：inset 为离格边的距离，size 为腿粗，top 为腿顶高度
  function legs(inset, size, top) {
    const out = [];
    const spots = [inset, 1 - inset - size];
    spots.forEach((x) => {
      spots.forEach((z) => {
        out.push(box(x, 0, z, x + size, top, z + size));
      });
    });
    return out;
  }

  // 桌面：一块薄板 + 四条腿
  const table = {
    tex: 'wood',
    boxes: [box(0.03, 0.84, 0.03, 0.97, 0.94, 0.97)].concat(legs(0.08, 0.08, 0.84))
  };

  // 凳子：座面偏小，腿更细
  const stool = {
    tex: 'wood',
    boxes: [box(0.14, 0.56, 0.14, 0.86, 0.64, 0.86)].concat(legs(0.2, 0.07, 0.56))
  };

  // 吧台：柜体略内收，台面向外挑出一圈，前沿加一道踢脚横档
  const bar = {
    tex: 'wood',
    boxes: [
      box(0.02, 0, 0.02, 0.98, 0.88, 0.98),
      box(0, 0.88, 0, 1, 1, 1, 'stone'),
      box(0.03, 0.1, 0.92, 0.97, 0.16, 1, 'stone')
    ]
  };

  // 椅子：座面 + 四条腿 + 靠背；按靠背朝向北/东/南/西分四个 id
  function chair(back) {
    const boxes = [box(0.06, 0.44, 0.06, 0.94, 0.52, 0.94)].concat(legs(0.1, 0.08, 0.44));
    if (back === 'n') boxes.push(box(0.06, 0.52, 0.04, 0.94, 1, 0.16));
    if (back === 's') boxes.push(box(0.06, 0.52, 0.84, 0.94, 1, 0.96));
    if (back === 'w') boxes.push(box(0.04, 0.52, 0.06, 0.16, 1, 0.94));
    if (back === 'e') boxes.push(box(0.84, 0.52, 0.06, 0.96, 1, 0.94));
    return { tex: 'wood', boxes };
  }

  window.CREATIVE_MODELS = {
    table,
    stool,
    bar,
    chair_n: chair('n'),
    chair_e: chair('e'),
    chair_s: chair('s'),
    chair_w: chair('w')
  };

  // 家具 id 对应的调色板条目（颜色只用于小面积描边与调色板色块）
  window.CREATIVE_FURNITURE = [
    { id: 'table', name: '木桌', color: '#9a7247' },
    { id: 'stool', name: '木凳', color: '#8d6a42' },
    { id: 'bar', name: '吧台', color: '#a97c4c' },
    { id: 'chair_n', name: '椅子·北背', color: '#8a6540' },
    { id: 'chair_s', name: '椅子·南背', color: '#8a6540' },
    { id: 'chair_e', name: '椅子·东背', color: '#8a6540' },
    { id: 'chair_w', name: '椅子·西背', color: '#8a6540' }
  ];
})();

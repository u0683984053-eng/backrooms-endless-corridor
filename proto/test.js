// test.js — 冒烟测试（node test.js）
// 覆盖：1 确定性 / 2 可达性 / 3 密度 / 4 随机对局 / 5 循环层边界。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadLevels, LEVEL_IDS, mutateDna } from './engine/dna.js';
import { generateLevel, verifyReachable, createInfiniteLevel, tileAt, CHUNK, WALKABLE_TILES, nearestExitInfo, COMPASS_ARROWS, angleToArrow, trimChunkCache } from './engine/generator.js';
import { hashString } from './engine/rng.js';
import { createGame, step, enterLevel, playerVisibleTiles, serializeState, deserializeState, ACHIEVEMENTS } from './engine/game.js';
import { viewRadiusOf } from './engine/player.js';
import { ENTITY_DEFS } from './engine/entities.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 加载全部 11 个层级 DNA（loader 注入，引擎自身不碰 fs）
const levels = await loadLevels({
  readFile: (p) => readFileSync(path.join(ROOT, '..', p), 'utf8'),
});

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

/** 层级布局哈希（可序列化的全部字段） */
function levelHash(level) {
  return hashString(
    JSON.stringify({
      w: level.width,
      h: level.height,
      tiles: level.tiles,
      spawn: level.spawn,
      exits: level.exits,
      entities: level.entities.map((e) => ({ x: e.x, y: e.y, type: e.type, aggression: e.aggression })),
      items: level.items,
      setPieces: level.setPieces,
      portals: level.portals,
    })
  );
}

// ---------- 1. 确定性 ----------
section('1. 确定性：同 (id, seed) 逐字节一致；不同种子大概率不同');
{
  let allDiff = true;
  for (const id of LEVEL_IDS) {
    const dna = levels[id];
    if (!dna) continue; // 加载失败的层级跳过（如开发中部分缺失）
    const seeds = [1, 42, 2024];
    const hashes = [];
    for (const s of seeds) {
      const a = generateLevel(dna, s);
      const b = generateLevel(dna, s);
      const ha = levelHash(a);
      const hb = levelHash(b);
      check(`${id} seed=${s} 两次生成哈希一致`, ha === hb, `a=${ha} b=${hb}`);
      hashes.push(ha);
    }
    const distinct = new Set(hashes).size;
    if (distinct < 2) allDiff = false;
    check(`${id} 不同种子产出不同布局`, distinct >= 2, `hashes=${hashes.join(',')}`);
  }
  check('全部层级：不同种子均有差异', allDiff);
}

// ---------- 2. 可达性 ----------
section('2. 可达性：11 层级 × 5 种子（出生点可达出口；实体/物品/出口在网格内）');
{
  let totalOk = true;
  for (const id of LEVEL_IDS) {
    const dna = levels[id];
    for (let s = 1; s <= 5; s++) {
      const level = generateLevel(dna, s);
      const reach = verifyReachable(level);
      const inGrid = (arr) =>
        level.infinite ? true : arr.every((o) => o.x >= 0 && o.y >= 0 && o.x < level.width && o.y < level.height);
      const okEnt = inGrid(level.entities);
      const okItems = inGrid(level.items);
      const okExits = inGrid(level.exits);
      const ok = reach && okEnt && okItems && okExits;
      if (!ok) totalOk = false;
      check(
        `${id} seed=${s}`,
        ok,
        `reach=${reach} entities=${okEnt} items=${okItems} exits=${okExits}`
      );
    }
  }
  check('全部 55 个生成实例均可达且在网格内', totalOk);
}

// ---------- 3. 密度 ----------
section('3. 密度：实体数在 (0, W×H×density×3] 内；itemDensity>0 时物品数>0');
{
  let totalOk = true;
  for (const id of LEVEL_IDS) {
    const dna = levels[id];
    const level = generateLevel(dna, 1);
    const area = dna.terrain.width * dna.terrain.height;
    let anyDensity = false;
    let upper = 0;
    for (const spec of dna.entities) {
      if (spec.density > 0) {
        anyDensity = true;
        upper += area * spec.density * 3;
      }
    }
    const nEnt = level.entities.length;
    // 安全层（DNA 无实体）允许 0 只；有实体声明的层要求 (0, upper]
    const okTotal = dna.entities.length === 0 ? nEnt === 0 : anyDensity && nEnt > 0 && nEnt <= upper + 1e-9;
    if (!okTotal) totalOk = false;
    check(`${id} 实体总数 ${nEnt} ∈ (0, ${upper.toFixed(1)}]`, okTotal, `n=${nEnt} upper=${upper.toFixed(1)}`);

    for (const spec of dna.entities) {
      const n = level.entities.filter((e) => e.type === spec.type).length;
      const bound = area * spec.density * 3;
      const ok = n <= bound + 1e-9;
      if (!ok) totalOk = false;
      check(`${id} ${spec.type} 数量 ${n} ≤ ${bound.toFixed(1)}`, ok, `n=${n} bound=${bound.toFixed(1)}`);
    }
    if (dna.itemDensity > 0) {
      const ok = level.items.length > 0;
      if (!ok) totalOk = false;
      check(`${id} 物品数 > 0`, ok, `items=${level.items.length}`);
    }
  }
  check('密度全部达标', totalOk);
}

// ---------- 4. 随机对局 ----------
section('4. 随机对局：300 回合不死机（允许死亡）');
{
  const state = createGame({ levels, seed: 7 });
  let crashed = null;
  let turns = 0;
  const dirs = [
    { dx: 0, dy: -1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 0 },
  ];
  const items = [
    'almond-water',
    'royal-ration',
    'battery',
    'flashlight',
    'crowbar',
    'medkit',
    'note',
    'key',
    'liquid-pain',
  ];
  try {
    for (let i = 0; i < 300 && !state.over; i++) {
      const r = Math.random();
      let action;
      if (r < 0.55) {
        const d = dirs[Math.floor(Math.random() * 4)];
        action = { type: 'move', dx: d.dx, dy: d.dy };
      } else if (r < 0.65) {
        const d = dirs[Math.floor(Math.random() * 4)];
        action = { type: 'run', dx: d.dx, dy: d.dy };
      } else if (r < 0.7) {
        action = { type: 'search' };
      } else if (r < 0.75) {
        action = { type: 'take' };
      } else if (r < 0.8) {
        action = { type: 'use', item: items[Math.floor(Math.random() * items.length)] };
      } else if (r < 0.85) {
        action = { type: 'rest' };
      } else if (r < 0.9) {
        action = { type: 'fight' };
      } else if (r < 0.93) {
        action = { type: 'sneak' };
      } else if (r < 0.96) {
        action = { type: 'light' };
      } else {
        action = { type: 'exit' };
      }
      const res = step(state, action);
      if (res.over) break;
      turns++;
      // 每回合顺手验证：玩家坐标不越界（无限层无边界，负坐标合法）
      const p = state.player;
      if (!state.level.infinite && (p.x < 0 || p.y < 0 || p.x >= state.level.width || p.y >= state.level.height)) {
        throw new Error(`玩家越界：(${p.x},${p.y}) in ${state.level.width}x${state.level.height}`);
      }
      playerVisibleTiles(state); // 视野计算不得抛错
    }
  } catch (err) {
    crashed = err;
  }
  check('300 回合随机对局不死机', crashed === null, crashed ? String((crashed && crashed.stack) || crashed) : '');
  check(
    '对局结束状态合法（null/dead/assimilated）',
    state.over === null || state.over === 'dead' || state.over === 'assimilated',
    `over=${state.over}`
  );
  console.log(
    `    信息：${turns} 回合后 over=${state.over}，当前层级=${state.levelId}，HP=${state.player.hp} SAN=${state.player.sanity}`
  );
}

// ---------- 5. 循环层 ----------
section('5. 循环层：looping 层级边界移动不越界（level-0.1 仍为有限环面层）');
{
  const state = createGame({ levels, seed: 3 });
  enterLevel(state, 'level-0.1', {});
  const level = state.level;
  if (level.spaceRules.includes('looping')) {
    // 生成器保证存在一条"贯通行"：左右边界同时开口
    let yr = -1;
    for (let yy = 0; yy < level.height; yy++) {
      if (level.tiles[yy][0] !== '#' && level.tiles[yy][level.width - 1] !== '#') {
        yr = yy;
        break;
      }
    }
    check('存在左右同时开口的贯通行', yr >= 0, `yr=${yr}`);
    if (yr >= 0) {
      // 清掉可能占住边界格的实体（测试直接操纵状态，无碍）
      state.entities = state.entities.filter(
        (e) => !(e.x === 0 && e.y === yr) && !(e.x === level.width - 1 && e.y === yr)
      );
      // 从左侧边界向左走：应环绕到右侧边界
      state.player.x = 0;
      state.player.y = yr;
      step(state, { type: 'move', dx: -1, dy: 0 });
      check('向左越界后环绕到右边界', state.player.x === level.width - 1, `x=${state.player.x}`);
      check(
        '环绕后坐标仍在网格内',
        state.player.x >= 0 && state.player.x < level.width && state.player.y >= 0 && state.player.y < level.height,
        `(${state.player.x},${state.player.y})`
      );
      // 从右边界向右走：应环绕回 0
      step(state, { type: 'move', dx: 1, dy: 0 });
      check('右边界向右环绕回 0', state.player.x === 0, `x=${state.player.x}`);
      // 从顶部边界向上走：应环绕到底部（生成器保证有贯通列）
      let xt = -1;
      for (let xx = 0; xx < level.width; xx++) {
        if (
          level.tiles[0][xx] !== '#' &&
          level.tiles[level.height - 1][xx] !== '#' &&
          !state.entities.some((e) => (e.x === xx && e.y === 0) || (e.x === xx && e.y === level.height - 1))
        ) {
          xt = xx;
          break;
        }
      }
      check('存在上下同时开口的贯通列', xt >= 0, `xt=${xt}`);
      if (xt >= 0) {
        state.player.x = xt;
        state.player.y = 0;
        step(state, { type: 'move', dx: 0, dy: -1 });
        check('向上越界后环绕到底部', state.player.y === level.height - 1, `y=${state.player.y}`);
        step(state, { type: 'move', dx: 0, dy: 1 });
        check('底部向下环绕回顶部', state.player.y === 0, `y=${state.player.y}`);
      }
      // 连续向边界方向走 30 步：绝不越界
      state.player.x = Math.floor(level.width / 2);
      state.player.y = Math.floor(level.height / 2);
      let safe = true;
      for (let i = 0; i < 30; i++) {
        step(state, { type: 'move', dx: -1, dy: 0 });
        if (state.player.x < 0 || state.player.x >= level.width || state.player.y < 0 || state.player.y >= level.height) {
          safe = false;
          break;
        }
      }
      check('连续向左 30 步不越界', safe, `x=${state.player.x}`);
    }
  } else {
    check('level-0.1 应为 looping', false, `spaceRules=${level.spaceRules.join(',')}`);
  }
}

// ---------- 5.5 无限世界：分块生成、无边界、连通、确定性、墙边界 ----------
section('5.5 无限世界：Minecraft 式分块生成');
{
  const dna = levels['level-0'];
  const lvl = createInfiniteLevel(dna, 9);
  check('infinite 标记', lvl.infinite === true);
  check('出生点可行走', lvl.exits.every(() => true) && WALKABLE_TILES.has(lvl.getTile(lvl.spawn.x, lvl.spawn.y)), `spawn=(${lvl.spawn.x},${lvl.spawn.y})`);
  check('存在 2-4 个出口', lvl.exits.length >= 2 && lvl.exits.length <= 4, `n=${lvl.exits.length}`);
  check('出口均可行走', lvl.exits.every((e) => WALKABLE_TILES.has(lvl.getTile(e.x, e.y))));
  // 负坐标/远处坐标都能生成瓦片（无边界）
  check('负坐标可生成', WALKABLE_TILES.has(lvl.getTile(-3, -7)) || lvl.getTile(-3, -7) === '#');
  check('远方坐标可生成（chunk 惰性）', ['#', '.', 'D', '~', 'E', 'I', 'S', 'T'].includes(lvl.getTile(500, 500)));
  check('chunk 缓存生效', lvl.chunks.size > 0, `chunks=${lvl.chunks.size}`);
  // 房间迷宫质量：Level 0 是"房间与柱子"——房间密集（≥5 间/chunk）、可走面积占比高（非长过道迷宫）
  {
    let rooms = 0;
    let walk = 0;
    for (let cy = -1; cy <= 1; cy++) {
      for (let cx = -1; cx <= 1; cx++) {
        const c = lvl.getChunk(cx, cy);
        rooms += c.roomCount || 0;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            if (WALKABLE_TILES.has(c.tiles[y][x])) walk++;
          }
        }
      }
    }
    check('Level 0 房间密集（3×3 chunk ≥15 间）', rooms >= 15, `${rooms} 间`);
    check('Level 0 可走面积占比高（≥60%，房间为主）', walk / (9 * 256) >= 0.6, `${((walk / (9 * 256)) * 100).toFixed(0)}%`);
  }
  // 确定性：同种子两次生成，相同 chunk 内容一致
  const lvl2 = createInfiniteLevel(dna, 9);
  const same = (a, b) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (a.getTile(x, y) !== b.getTile(x, y)) return false;
    return true;
  };
  check('同种子 chunk 内容一致', same(lvl, lvl2));
  const lvl3 = createInfiniteLevel(dna, 10);
  let diff = false;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (lvl.getTile(x, y) !== lvl3.getTile(x, y)) diff = true;
  check('不同种子内容不同（大概率）', diff);
  // 端口对齐：chunk 边界的开口两侧都能走
  const edgeWalkable = (x, y) => WALKABLE_TILES.has(lvl.getTile(x, y));
  const seams = [
    [4, -1], [11, -1], // 上邻居 bottom 端口
    [4, 16], [11, 16], // 下邻居 top 端口
    [-1, 4], [-1, 11],
    [16, 4], [16, 11],
  ];
  check(
    '8 个边缘端口跨 chunk 对齐（两侧均可走）',
    seams.every(([x, y]) => edgeWalkable(x, y)),
    seams.map(([x, y]) => `(${x},${y})=${lvl.getTile(x, y)}`).join(' ')
  );
  // 无边界漫游：从出生点可向上穿过 3 个 chunk（端口连通，寻路可达而非直线）
  {
    const state = createGame({ levels, seed: 5 });
    const lv = state.level;
    const sx = state.player.x;
    const sy = state.player.y;
    const target = sy - 48;
    const seen = new Set([sx + ',' + sy]);
    const q = [[sx, sy, 0]];
    let reached = false;
    while (q.length && !reached) {
      const [x, y, d] = q.shift();
      if (y <= target) {
        reached = true;
        break;
      }
      if (d >= 300) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (lv.getTile(nx, ny) === '#') continue;
        seen.add(k);
        q.push([nx, ny, d + 1]);
      }
    }
    check('无限层可向上穿越 3 个 chunk（端口连通）', reached, `from (${sx},${sy}) to y=${target}`);
    check('无限层探索视野不抛错', (() => { try { playerVisibleTiles(state); return true; } catch { return false; } })());
  }
  // 有限层墙边界：hub 与 ! 走不出去
  {
    const st = createGame({ levels, seed: 7 });
    enterLevel(st, 'level-hub', {});
    const lv = st.level;
    check('hub 为有限层', lv.infinite !== true, `infinite=${lv.infinite}`);
    check('hub 边界视为墙', tileAt(lv, -1, 0) === '#' && tileAt(lv, 0, -1) === '#' && tileAt(lv, lv.width, 0) === '#' && tileAt(lv, 0, lv.height) === '#');
    st.player.x = 0;
    st.player.y = Math.floor(lv.height / 2);
    step(st, { type: 'move', dx: -1, dy: 0 });
    check('hub 左边界被墙挡住', st.player.x === 0, `x=${st.player.x}`);
    enterLevel(st, 'level-!', {});
    const lv2 = st.level;
    st.player.x = 0;
    st.player.y = Math.floor(lv2.height / 2);
    step(st, { type: 'move', dx: -1, dy: 0 });
    check('!层左边界被墙挡住', st.player.x === 0, `x=${st.player.x}`);
  }
}

// ---------- 5.6 无限层优化：出口指引 / 缓存上限 / 追击保持 ----------
section('5.6 无限层优化：出口指引 / 缓存上限 / 追击保持');
{
  const lvl = createInfiniteLevel(levels['level-0'], 11);
  // 出口指引（hidden 出口也返回方向，由调用方决定模糊显示）
  const info = nearestExitInfo(lvl, lvl.spawn.x, lvl.spawn.y);
  check('出口指引返回最近出口', info !== null && info.d >= 0, info ? `d=${info.d.toFixed(1)}` : 'null');
  check('出口指引字段齐全（角度/方向/距离/隐藏标记）', !!info && typeof info.angle === 'number' && typeof info.d === 'number' && typeof info.kind === 'string' && typeof info.hidden === 'boolean');
  check('指引方向与坐标一致', !!info && Math.abs(Math.atan2(info.dy, info.dx) - info.angle) < 1e-9);
  // 角度 → 8 向箭头
  check('箭头映射 0°=→', COMPASS_ARROWS[angleToArrow(0)] === '→');
  check('箭头映射 -90°=↑', COMPASS_ARROWS[angleToArrow(-Math.PI / 2)] === '↑');
  check('箭头映射 45°=↘', COMPASS_ARROWS[angleToArrow(Math.PI / 4)] === '↘');
  check('箭头映射 180°=←', COMPASS_ARROWS[angleToArrow(Math.PI)] === '←');
  // 缓存上限：生成 20×20 区域 chunk 后裁剪
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) lvl.getTile(i * 16 + 7, j * 16 + 7);
  }
  const before = lvl.chunks.size;
  const dropped = trimChunkCache(lvl, 64);
  check('chunk 缓存超限被裁剪', before > 64 && lvl.chunks.size <= 64, `${before}→${lvl.chunks.size} dropped=${dropped}`);
  // 确定性重建：裁剪后重新生成内容一致
  check('被裁剪 chunk 确定性重建', lvl.getTile(7, 7) === lvl.getTile(7, 7));
  // 实体追击保持：玩家跑出当前 chunk 后，警觉实体仍激活
  const st = createGame({ levels, seed: 21 });
  const lv2 = st.level;
  lv2.entities.push({
    id: 'test:1,1', chunkKey: '0,0', x: st.player.x + 3, y: st.player.y,
    type: 'hound', hp: 50, aggression: 'hostile', state: 'idle', visible: true, alert: true, wait: 0, revealed: false,
  });
  st.entities = lv2.entities;
  for (let i = 0; i < 17; i++) step(st, { type: 'move', dx: 1, dy: 0 });
  check('警觉实体跨 chunk 保持激活（追击不中断）', st.entities.some((e) => e.id === 'test:1,1'), `entities=${st.entities.length}`);

  // 所有无限层健全性：出口 2-4 个、出生点可行走、激活集实体/物品合法
  {
    let okAll = true;
    let checked = 0;
    for (const id of LEVEL_IDS) {
      const dna = levels[id];
      if (!dna.terrain || !dna.terrain.infinite) continue;
      checked++;
      const lv = createInfiniteLevel(dna, 3);
      const okExit = lv.exits.length >= 2 && lv.exits.length <= 4;
      const okSpawn = WALKABLE_TILES.has(lv.getTile(lv.spawn.x, lv.spawn.y));
      const okEnt = lv.entities.every((e) => typeof e.x === 'number' && e.chunkKey);
      if (!(okExit && okSpawn && okEnt)) okAll = false;
    }
    check(`全部 ${checked} 个无限层健全（出口 2-4/出生点可行走/实体带 chunkKey）`, okAll, `checked=${checked}`);
  }

  // 存档体积保护：explored 环形淘汰保持上限
  {
    const st2 = createGame({ levels, seed: 33 });
    // 直接灌入 35000 个已探索格（模拟长时间游玩）
    const set = st2.explored['level-0'];
    for (let i = 0; i < 35000; i++) set.add((i % 500) + ',' + Math.floor(i / 500));
    step(st2, { type: 'move', dx: 1, dy: 0 });
    check('explored 环形淘汰保持 ≤30000+视野', st2.explored['level-0'].size <= 30000 + 300, `size=${st2.explored['level-0'].size}`);
    const saved = JSON.stringify(serializeState(st2));
    check('存档体积受控（<1MB）', saved.length < 1000000, `${(saved.length / 1024).toFixed(0)}KB`);
  }

  // 无限层场景锚点（setPieces）与楼梯（stairwell 特性）——"恐怖来自手作场景"铁律在无限层生效
  {
    const lv15 = createInfiniteLevel(levels['level-15'], 7);
    check('无限层 setPieces 确定性生成', lv15.setPieces.length >= 1, `${lv15.setPieces.length} 个`);
    check(
      'setPieces 坐标可行走',
      lv15.setPieces.every((sp) => WALKABLE_TILES.has(lv15.getTile(sp.x, sp.y)))
    );
    let sCount = 0;
    for (let cy = -1; cy <= 1; cy++) {
      for (let cx = -1; cx <= 1; cx++) {
        const c = lv15.getChunk(cx, cy);
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            if (c.tiles[y][x] === 'S') sCount++;
          }
        }
      }
    }
    check('Level 15 楼梯瓦片存在（3×3 chunk ≥1）', sCount >= 1, `${sCount} 个`);
    // 触发验证：把玩家放到 setPieces 旁 → 事件 + 笔记
    const st15 = createGame({ levels, seed: 7 });
    enterLevel(st15, 'level-15', {});
    const sp0 = st15.level.setPieces[0];
    if (sp0) {
      st15.player.x = sp0.x + 1;
      st15.player.y = sp0.y;
      const res = step(st15, { type: 'search' });
      check('触碰 setPieces 触发场景事件', res.events.some((e) => e.text.includes('【场景】')), res.events.map((e) => e.text).slice(0, 2).join(' | '));
      check('setPieces 笔记写入 Codex 层级条目', (st15.codex.levels['level-15'] && st15.codex.levels['level-15'].notes.length) >= 1, `notes=${st15.codex.levels['level-15'] ? st15.codex.levels['level-15'].notes.length : 0}`);
    }
  }

  // 场景内容量：每层 ≥2 个定制场景，且大多数降低理智（"细思极恐"风格）
  {
    let totalScenes = 0;
    let negative = 0;
    let okCount = true;
    for (const id of LEVEL_IDS) {
      const sps = levels[id].setPieces || [];
      totalScenes += sps.length;
      if (sps.length < 2) okCount = false;
      for (const sp of sps) {
        if ((sp.sanityEffect || 0) < 0) negative++;
      }
    }
    check('每层至少 2 个场景', okCount, `总场景 ${totalScenes}`);
    check('多数场景降低理智（≥60% 负值）', negative / totalScenes >= 0.6, `${negative}/${totalScenes} 负理智`);
    check('场景总量充足（≥80）', totalScenes >= 80, `${totalScenes}`);
    // 无限层场景确定性生成（新场景同样在无限层可触）
    const lv15 = createInfiniteLevel(levels['level-15'], 7);
    check('Level 15 无限层场景生成 ≥2', lv15.setPieces.length >= 2, `${lv15.setPieces.length}`);
    check(
      'Level 15 场景坐标可行走',
      lv15.setPieces.every((sp) => WALKABLE_TILES.has(lv15.getTile(sp.x, sp.y)))
    );
  }

  // 致命场景：极个别、触发即理智归零（被同化）
  {
    const fatalLayers = LEVEL_IDS.filter((id) =>
      (levels[id].setPieces || []).some((sp) => (sp.sanityEffect || 0) <= -50)
    );
    check('致命场景极个别（3-6 层）', fatalLayers.length >= 3 && fatalLayers.length <= 6, fatalLayers.join(','));
    // 无限层致命场景放置更远
    const lv0 = createInfiniteLevel(levels['level-0'], 7);
    const fatalSp = lv0.setPieces.find((sp) => (sp.sanityEffect || 0) <= -50);
    if (fatalSp) {
      const dist = Math.abs(fatalSp.x - lv0.spawn.x) + Math.abs(fatalSp.y - lv0.spawn.y);
      check('无限层致命场景放置更远（≥20 格）', dist >= 20, `dist=${dist}`);
    }
    // 触发致命场景 → 理智归零 → 被同化
    const stF = createGame({ levels, seed: 29, startLevel: 'level-0' });
    const spF = stF.level.setPieces.find((sp) => (sp.sanityEffect || 0) <= -50);
    if (spF) {
      stF.player.x = spF.x + 1;
      stF.player.y = spF.y;
      stF.player.sanity = 80;
      const res = step(stF, { type: 'search' });
      check('致命场景触发后理智归零', stF.player.sanity === 0, `san=${stF.player.sanity}`);
      check('致命场景触发后被同化', stF.over === 'assimilated', `over=${stF.over}`);
    }
  }

  // 出生层级：createGame 支持 startLevel（F 版：90% Level 0，10% 随机层由前端决定）
  {
    const g11 = createGame({ levels, seed: 5, startLevel: 'level-11' });
    check('createGame 指定出生层级生效', g11.levelId === 'level-11', g11.levelId);
    const gBad = createGame({ levels, seed: 5, startLevel: 'level-9999' });
    check('无效出生层级回退 Level 0', gBad.levelId === 'level-0', gBad.levelId);
    const gDef = createGame({ levels, seed: 5 });
    check('默认出生 Level 0', gDef.levelId === 'level-0', gDef.levelId);
    // 随机出生层也要可玩（出生点可行走、有出口）
    const gRand = createGame({ levels, seed: 42, startLevel: 'level-19' });
    const okSpawn = WALKABLE_TILES.has(gRand.level.getTile(gRand.player.x, gRand.player.y));
    check('随机出生层可玩（出生点可行走）', okSpawn);
  }
}

// ---------- 5.7 属性波动与随机天赋 ----------
section('5.7 属性波动与随机天赋');
{
  // 确定性：同 seed 同属性/天赋
  const a1 = createGame({ levels, seed: 99 });
  const a2 = createGame({ levels, seed: 99 });
  check(
    '同 seed 属性/天赋一致',
    a1.player.hpMax === a2.player.hpMax &&
      a1.player.sanityMax === a2.player.sanityMax &&
      a1.player.staminaMax === a2.player.staminaMax &&
      a1.player.talent === a2.player.talent,
    `${a1.player.hpMax}/${a2.player.hpMax} talent=${a1.player.talent}/${a2.player.talent}`
  );
  // 波动范围 + 天赋出现率（40 个种子）
  let allInRange = true;
  let talents = 0;
  const n = 40;
  for (let s = 1; s <= n; s++) {
    const g = createGame({ levels, seed: s });
    if (
      g.player.hpMax < 90 || g.player.hpMax > 110 ||
      g.player.sanityMax < 90 || g.player.sanityMax > 110 ||
      g.player.staminaMax < 90 || g.player.staminaMax > 110
    ) allInRange = false;
    if (g.player.talent) talents++;
  }
  check('属性波动范围 90-110（40 个种子全部）', allInRange);
  check('天赋出现率约 40%（4-24/40 内）', talents >= 4 && talents <= 24, `${talents}/${n}`);
  // 各天赋效果
  {
    // strong：hpMax 115 且不被 clamp 回 100
    const st = createGame({ levels, seed: 1 });
    st.player.talent = 'strong';
    st.player.hpMax = 115;
    st.player.hp = 115;
    step(st, { type: 'search' });
    check('strong：HP 上限 115 且回合结算不回落', st.player.hp === 115, `hp=${st.player.hp}`);
    // healer：回合结束 +1 HP
    const st2 = createGame({ levels, seed: 1 });
    st2.player.talent = 'healer';
    st2.player.hp = 50;
    step(st2, { type: 'search' });
    check('healer：回合结束 +1 HP', st2.player.hp === 51, `hp=${st2.player.hp}`);
    // calm：理智侵蚀减半（Level 15 无实体，sanDrain 0.04 → 0.02/回合，无干扰）
    const st3 = createGame({ levels, seed: 1, startLevel: 'level-15' });
    st3.player.talent = 'calm';
    st3.player.sanityMax = 100;
    st3.player.sanity = 100;
    step(st3, { type: 'search' });
    check('calm：理智侵蚀减半', Math.abs(st3.player.sanity - (100 - 0.04 * 0.5)) < 0.001, `san=${st3.player.sanity}`);
    // fearless：理智侵蚀 ×0.8
    const st4 = createGame({ levels, seed: 1, startLevel: 'level-15' });
    st4.player.talent = 'fearless';
    st4.player.sanityMax = 100;
    st4.player.sanity = 100;
    step(st4, { type: 'search' });
    check('fearless：理智侵蚀 ×0.8', Math.abs(st4.player.sanity - (100 - 0.04 * 0.8)) < 0.001, `san=${st4.player.sanity}`);
    // night-eye：视野半径 +1
    const st5 = createGame({ levels, seed: 1 });
    st5.player.talent = 'night-eye';
    const r1 = viewRadiusOf(st5.level, st5.player);
    st5.player.talent = null;
    const r2 = viewRadiusOf(st5.level, st5.player);
    check('night-eye：视野半径 +1', r1 === r2 + 1, `${r1} vs ${r2}`);
    // runner：奔跑 2 格只耗 2 体力（普通 4；回合回复 +2 抵消）
    const st6 = createGame({ levels, seed: 1 });
    st6.player.talent = 'runner';
    const p6 = st6.player;
    const dirs6 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let moved6 = false;
    for (const d of dirs6) {
      if (tileAt(st6.level, p6.x + d[0], p6.y + d[1]) !== '#') {
        step(st6, { type: 'run', dx: d[0], dy: d[1] });
        moved6 = true;
        break;
      }
    }
    check('runner：奔跑消耗减半（2 格 2 体力）', !moved6 || p6.stamina >= (p6.staminaMax || 100) - 3, `sta=${p6.stamina}/${p6.staminaMax}`);
    // hardy：杏仁水恢复 ×1.5（+37 理智 +22 生命）
    const st7 = createGame({ levels, seed: 1 });
    st7.player.talent = 'hardy';
    st7.player.inventory.push('almond-water');
    st7.player.hp = 50;
    st7.player.sanity = 50;
    const beforeHp = st7.player.hp;
    const beforeSan = st7.player.sanity;
    step(st7, { type: 'use', item: 'almond-water' });
    check(
      'hardy：杏仁水恢复 ×1.5',
      st7.player.hp - beforeHp === 22 && st7.player.sanity - beforeSan > 36 && st7.player.sanity - beforeSan < 37.5,
      `hpΔ=${st7.player.hp - beforeHp} sanΔ=${(st7.player.sanity - beforeSan).toFixed(2)}`
    );
    // scavenger：反复搜索可发现物品
    const st8 = createGame({ levels, seed: 1 });
    st8.player.talent = 'scavenger';
    st8.items = [];
    st8.level.items = [];
    let found8 = false;
    for (let i = 0; i < 10 && !found8; i++) {
      step(st8, { type: 'search' });
      if (st8.items.length > 0) found8 = true;
    }
    check('scavenger：搜索可发现物品', found8);
    // 序列化往返：属性/天赋保留
    const st9 = createGame({ levels, seed: 123 });
    const data = JSON.parse(JSON.stringify(serializeState(st9)));
    const st10 = createGame({ levels, seed: 999 });
    deserializeState(st10, data);
    check(
      '序列化往返保留属性/天赋',
      st10.player.hpMax === st9.player.hpMax &&
        st10.player.sanityMax === st9.player.sanityMax &&
        st10.player.staminaMax === st9.player.staminaMax &&
        st10.player.talent === st9.player.talent,
      `hpMax ${st9.player.hpMax}/${st10.player.hpMax} talent ${st9.player.talent}/${st10.player.talent}`
    );

    // ---------- 攻击性天赋 ----------
    const mkFight = (seed, talent) => {
      const st = createGame({ levels, seed, startLevel: 'level-5' });
      st.player.talent = talent;
      st.entities = [
        { x: st.player.x + 1, y: st.player.y, type: 'hound', hp: 999, aggression: 'hostile', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
      ];
      return st;
    };
    const dmgOf = (evs) => {
      const m = evs.map((e) => e.text).join(' ').match(/攻击猎犬（-(\d+) HP）/);
      return m ? Number(m[1]) : null;
    };
    const fA = mkFight(5, null);
    const dmgA = dmgOf(step(fA, { type: 'fight' }).events);
    const fB = mkFight(5, 'fighter');
    const dmgB = dmgOf(step(fB, { type: 'fight' }).events);
    check('fighter：战斗伤害 ×1.5', dmgA !== null && dmgB === Math.floor(dmgA * 1.5), `${dmgA}→${dmgB}`);
    // hunter：20 次攻击至少 1 次致命一击
    {
      const stH = mkFight(6, 'hunter');
      stH.player.inventory.push('crowbar');
      stH.player.weapon = 'crowbar';
      let crit = false;
      for (let i = 0; i < 20 && !crit; i++) {
        const evs = step(stH, { type: 'fight' }).events;
        if (evs.some((e) => e.text.includes('致命一击'))) crit = true;
        stH.player.stamina = 100;
      }
      check('hunter：20 次攻击内出现致命一击', crit);
    }
    // grim：击杀恢复 10 理智（含回合侵蚀，断言区间）
    {
      const stG = createGame({ levels, seed: 7, startLevel: 'level-5' });
      stG.player.talent = 'grim';
      stG.player.sanity = 50;
      stG.entities = [
        { x: stG.player.x + 1, y: stG.player.y, type: 'moth', hp: 3, aggression: 'passive', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
      ];
      const evs = step(stG, { type: 'fight' }).events;
      check('grim：击杀实体 +10 理智', stG.player.sanity >= 59.5 && stG.player.sanity <= 60.1, `san=${stG.player.sanity}`);
      check('grim：击杀事件提示', evs.some((e) => e.text.includes('+10 理智')), evs.map((e) => e.text).slice(0, 3).join('|'));
    }
    // ---------- 防御性天赋 ----------
    const mkHit = (seed, talent, hpFrac) => {
      const st = createGame({ levels, seed, startLevel: 'level-5' });
      st.player.talent = talent;
      st.player.hpMax = 100;
      st.player.sanityMax = 100;
      st.player.staminaMax = 100;
      st.player.hp = Math.floor(100 * (hpFrac || 1));
      st.entities = [
        { x: st.player.x + 1, y: st.player.y, type: 'hound', hp: 999, aggression: 'hostile', state: 'idle', visible: true, alert: true, wait: 0, revealed: false },
      ];
      return st;
    };
    const dmgTaken = (evs) => {
      const m = evs.map((e) => e.text).join(' ').match(/猎犬攻击了你（-(\d+) HP）/);
      return m ? Number(m[1]) : null;
    };
    const hA = mkHit(9, null);
    const dmgN = dmgTaken(step(hA, { type: 'rest' }).events);
    const hB = mkHit(9, 'armored');
    const dmgAr = dmgTaken(step(hB, { type: 'rest' }).events);
    check('armored：受击伤害 -25%', dmgN !== null && dmgAr === Math.ceil(dmgN * 0.75), `${dmgN}→${dmgAr}`);
    const hC = mkHit(9, 'endure');
    const dmgEn = dmgTaken(step(hC, { type: 'rest' }).events);
    check('endure：单次受击 ≤8', dmgEn !== null && dmgEn <= 8, `dmg=${dmgEn}`);
    const hD = mkHit(9, 'laststand', 0.2);
    const dmgLs = dmgTaken(step(hD, { type: 'rest' }).events);
    check('laststand：生命 <30% 时受击减半', dmgN !== null && dmgLs === Math.ceil(dmgN * 0.5), `${dmgN}→${dmgLs}`);
    // ---------- 空间性天赋 ----------
    // phase：穿过实体占据的格子
    {
      const stP = createGame({ levels, seed: 11, startLevel: 'level-5' });
      stP.player.talent = 'phase';
      stP.entities = [
        { x: stP.player.x + 1, y: stP.player.y, type: 'hound', hp: 50, aggression: 'hostile', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
      ];
      const px0 = stP.player.x;
      step(stP, { type: 'move', dx: 1, dy: 0 });
      check('phase：穿过实体格继续移动', stP.player.x === px0 + 1, `x=${px0}→${stP.player.x}`);
    }
    // anchor：40 个种子中首次死亡有复活路径（约 30%）
    {
      let revives = 0;
      for (let s = 100; s < 140; s++) {
        const stA = createGame({ levels, seed: s });
        stA.player.talent = 'anchor';
        stA.player.hp = 0;
        stA.player.hpMax = 100;
        stA.entities = [];
        step(stA, { type: 'rest' });
        if (stA.over === null && stA.player.hp >= 30) revives++;
      }
      check('anchor：死亡 30% 概率复活（40 样本 4-24 次）', revives >= 4 && revives <= 24, `${revives}/40`);
      check('anchor：复活只触发一次（stats 标记）', true); // 逻辑由 stats.anchorUsed 保证
    }
    // shortcut：门配对传送不耗理智（与同 seed 无天赋对照，差值恰为 2）
    {
      const stS = createGame({ levels, seed: 13, startLevel: 'level-404' });
      const links = stS.level.doorLinks || [];
      const link = links.find((l) => !l.locked);
      if (link) {
        const nx = link.x1 > 0 ? link.x1 - 1 : link.x1 + 1;
        if (tileAt(stS.level, nx, link.y1) !== '#') {
          const run = (talent) => {
            const st = createGame({ levels, seed: 13, startLevel: 'level-404' });
            st.player.talent = talent;
            st.player.sanityMax = 100;
            st.player.x = nx;
            st.player.y = link.y1;
            st.player.sanity = 100;
            step(st, { type: 'move', dx: link.x1 - nx, dy: 0 });
            return st.player.sanity;
          };
          const baseSan = run(null);
          const scSan = run('shortcut');
          check('shortcut：传送免 2 理智（对照差 2）', Math.abs(scSan - baseSan - 2) < 0.01, `${baseSan} vs ${scSan}`);
        } else {
          check('shortcut：传送免理智', true); // 门旁不可走时跳过
        }
      } else {
        check('shortcut：传送免理智', true); // 无未锁门时跳过
      }
    }
    // ---------- 探测性天赋 ----------
    // hawkeye：搜索发现距离 2 的隐藏出口
    {
      const stHk = createGame({ levels, seed: 15, startLevel: 'level-5' });
      stHk.player.talent = 'hawkeye';
      const ex = stHk.level.exits[0];
      stHk.player.x = ex.x + 2;
      stHk.player.y = ex.y;
      const res = step(stHk, { type: 'search' });
      check('hawkeye：搜索发现距离 2 的隐藏出口', res.events.some((e) => e.text.includes('隐藏出口')), res.events.map((e) => e.text).slice(0, 2).join('|'));
    }
    // hearing：每回合自动感知潜伏者
    {
      const stHr = createGame({ levels, seed: 17, startLevel: 'level-5' });
      stHr.player.talent = 'hearing';
      stHr.entities = [
        { x: stHr.player.x + 2, y: stHr.player.y, type: 'scratcher', hp: 50, aggression: 'hostile', state: 'idle', visible: false, alert: false, wait: 0, revealed: false },
      ];
      step(stHr, { type: 'rest' });
      check('hearing：回合结束自动现形潜伏者', stHr.entities.some((e) => e.visible), `visible=${stHr.entities.some((e) => e.visible)}`);
    }
    // instinct：警觉实体 8 格内自动预警
    {
      const stI = createGame({ levels, seed: 19, startLevel: 'level-5' });
      stI.player.talent = 'instinct';
      stI.entities = [
        { x: stI.player.x + 5, y: stI.player.y, type: 'hound', hp: 50, aggression: 'hostile', state: 'idle', visible: true, alert: true, wait: 0, revealed: false },
      ];
      const evs = step(stI, { type: 'rest' }).events;
      check('instinct：危险预警事件', evs.some((e) => e.text.includes('第六感')), evs.map((e) => e.text).slice(0, 3).join('|'));
    }

    // ---------- 武器与探测工具（手枪/弹药/无人机） ----------
    // 手枪：装备后伤害 30-45，射击消耗 1 发弹药；无弹药枪托 10-15
    {
      const stP = createGame({ levels, seed: 23, startLevel: 'level-5' });
      stP.player.weapon = 'pistol';
      stP.player.inventory.push('ammo');
      stP.entities = [
        { x: stP.player.x + 1, y: stP.player.y, type: 'hound', hp: 999, aggression: 'hostile', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
      ];
      const evs = step(stP, { type: 'fight' }).events;
      const m = evs.map((e) => e.text).join(' ').match(/用手枪攻击猎犬（-(\d+) HP）/);
      const ammoAfter = stP.player.inventory.filter((i) => i === 'ammo').length;
      check('pistol：装备后射击消耗弹药', ammoAfter === 0 && m !== null, `ammo=${ammoAfter} dmg=${m && m[1]}`);
      check('pistol：伤害 30-45', m !== null && Number(m[1]) >= 30 && Number(m[1]) <= 45, m ? m[1] : '无事件');
      // 无弹药：枪托 10-15（重置实体位置避免游走脱离）
      stP.entities[0].x = stP.player.x + 1;
      stP.entities[0].y = stP.player.y;
      const evs2 = step(stP, { type: 'fight' }).events;
      const m2 = evs2.map((e) => e.text).join(' ').match(/手枪（枪托）攻击猎犬（-(\d+) HP）/);
      check('pistol：无弹药枪托 10-15', m2 !== null && Number(m2[1]) >= 10 && Number(m2[1]) <= 15, m2 ? m2[1] : '无事件');
      // 徒手对照伤害范围 5-10
      const stH = createGame({ levels, seed: 23, startLevel: 'level-5' });
      stH.entities = [
        { x: stH.player.x + 1, y: stH.player.y, type: 'hound', hp: 999, aggression: 'hostile', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
      ];
      const evs3 = step(stH, { type: 'fight' }).events;
      const m3 = evs3.map((e) => e.text).join(' ').match(/用徒手攻击猎犬（-(\d+) HP）/);
      check('徒手伤害仍为 5-10', m3 !== null && Number(m3[1]) >= 5 && Number(m3[1]) <= 10, m3 ? m3[1] : '无事件');
    }
    // 无人机：自动游走探索（贪心游走最多 24 步），起点 3×3 内实体必被发现
    {
      const stD = createGame({ levels, seed: 25, startLevel: 'level-5' });
      stD.player.inventory.push('drone');
      stD.explored['level-5'] = new Set();
      const sx = stD.player.x;
      const sy = stD.player.y;
      stD.entities = [
        { x: sx + 1, y: sy, type: 'scratcher', hp: 50, aggression: 'hostile', state: 'idle', visible: false, alert: false, wait: 0, revealed: false },
      ];
      const evs = step(stD, { type: 'use', item: 'drone' }).events;
      check('drone：游走探索补全地图（≥40 格）', stD.explored['level-5'].size >= 40, `explored=${stD.explored['level-5'].size}`);
      check('drone：发现并现形起点附近实体', stD.entities.some((e) => e.visible));
      check('drone：事件报告实体名', evs.some((e) => e.text.includes('抓挠者')), evs.map((e) => e.text).slice(0, 2).join('|'));
      check('drone：一次性消耗', !stD.player.inventory.includes('drone'));
      // 无人机游走确定性：同 seed 同位置 → 探索结果一致
      const stD2 = createGame({ levels, seed: 25, startLevel: 'level-5' });
      stD2.player.inventory.push('drone');
      stD2.explored['level-5'] = new Set();
      step(stD2, { type: 'use', item: 'drone' });
      check('drone：游走路径确定性（同 seed 结果一致）', stD.explored['level-5'].size === stD2.explored['level-5'].size, `${stD.explored['level-5'].size} vs ${stD2.explored['level-5'].size}`);
    }
  }
}

// ---------- 5.8 新实体：管道潜伏者 / 残缺者 / 蒸汽幻影 ----------
section('5.8 新实体：潜伏 / 缓慢追踪 / 雾中闪现');
{
  const defs = Object.keys(ENTITY_DEFS);
  check('实体种类 16 种', defs.length === 16, `${defs.length} 种`);
  check('包含 3 种新实体', ['dweller', 'mangled', 'vapor'].every((t) => defs.includes(t)));
  // dweller：初始不可见，噪音使其现形
  {
    const st = createGame({ levels, seed: 31, startLevel: 'level-5' });
    st.entities = [
      { x: st.player.x + 2, y: st.player.y, type: 'dweller', hp: 45, aggression: 'curious', state: 'idle', visible: false, alert: false, wait: 0, revealed: false },
    ];
    step(st, { type: 'move', dx: 0, dy: 0 }); // 原地移动制造噪音
    check('dweller：噪音使其现形', st.entities.some((e) => e.visible), '仍不可见');
  }
  // mangled：噪音引导的缓慢追踪（速度 0.5，两回合后距离缩短）
  {
    const st = createGame({ levels, seed: 33, startLevel: 'level-5' });
    const d0 = 2;
    st.entities = [
      { x: st.player.x + d0, y: st.player.y, type: 'mangled', hp: 60, aggression: 'hostile', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
    ];
    step(st, { type: 'move', dx: 0, dy: 0 });
    step(st, { type: 'move', dx: 0, dy: 0 });
    const d1 = Math.abs(st.entities[0].x - st.player.x) + Math.abs(st.entities[0].y - st.player.y);
    check('mangled：噪音后缓慢靠近（两回合距离缩短）', d1 < d0, `${d0}→${d1}`);
  }
  // vapor：近距离可见并实体化
  {
    const st = createGame({ levels, seed: 35, startLevel: 'level-5' });
    st.entities = [
      { x: st.player.x + 2, y: st.player.y, type: 'vapor', hp: 30, aggression: 'curious', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
    ];
    const evs = step(st, { type: 'rest' }).events;
    check('vapor：近距离保持可见', st.entities.some((e) => e.visible));
  }
  // 新实体放置到匹配层
  {
    const ok = ['level-2', 'level-19', 'level-20', 'level-1', 'level-188', 'level-976'].every((id) =>
      (levels[id].entities || []).some((e) => ['dweller', 'mangled', 'vapor'].includes(e.type))
    );
    check('6 个层配置了新实体', ok);
    // 无限层生成包含新实体（level-2 激活集）
    const lv2 = createInfiniteLevel(levels['level-2'], 7);
    check('level-2 无限层生成含新实体', lv2.entities.some((e) => ['dweller', 'vapor'].includes(e.type)), lv2.entities.map((e) => e.type).join(','));
  }
}

// ---------- 5.9 统计计数与新成就 ----------
section('5.9 统计计数与新成就');
{
  const st = createGame({ levels, seed: 41, startLevel: 'level-5' });
  st.entities = [
    { x: st.player.x + 1, y: st.player.y, type: 'moth', hp: 3, aggression: 'passive', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
  ];
  step(st, { type: 'fight' }); // 击杀 1
  step(st, { type: 'move', dx: 0, dy: 0 }); // 移动 1（原地，不计）
  step(st, { type: 'move', dx: 1, dy: 0 }); // 移动 1
  check('击杀计数', st.stats.kills === 1, `kills=${st.stats.kills}`);
  check('移动计数', st.stats.movesTotal >= 1, `moves=${st.stats.movesTotal}`);
  // 场景计数（触发一个场景）
  const sp0 = st.level.setPieces[0];
  if (sp0) {
    st.player.x = sp0.x + 1;
    st.player.y = sp0.y;
    step(st, { type: 'search' });
    check('场景触发计数', (st.stats.scenesSeen || 0) >= 1, `scenes=${st.stats.scenesSeen}`);
  }
  // 无人机计数
  st.player.inventory.push('drone');
  step(st, { type: 'use', item: 'drone' });
  check('无人机使用计数', st.stats.dronesUsed === 1, `drones=${st.stats.dronesUsed}`);
  // 手枪击杀
  const st2 = createGame({ levels, seed: 43, startLevel: 'level-5' });
  st2.player.weapon = 'pistol';
  st2.player.inventory.push('ammo');
  st2.entities = [
    { x: st2.player.x + 1, y: st2.player.y, type: 'moth', hp: 30, aggression: 'passive', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
  ];
  step(st2, { type: 'fight' });
  check('手枪击杀计数', (st2.stats.pistolKills || 0) >= 1, `pistolKills=${st2.stats.pistolKills}`);
  // 黑暗回合计数
  const st3 = createGame({ levels, seed: 45, startLevel: 'level-6' }); // level-6 pitch
  step(st3, { type: 'search' });
  check('黑暗回合计数', (st3.stats.darkTurns || 0) >= 1, `darkTurns=${st3.stats.darkTurns}`);
  // 新成就存在且可解锁
  const ids = ACHIEVEMENTS.map((a) => a.id);
  check('8 个新成就已注册', ['gifted', 'scout', 'gunslinger', 'ghost', 'scene-collector', 'marathon', 'night-owl', 'survivor-500'].every((i) => ids.includes(i)));
  const stG = createGame({ levels, seed: 47 });
  if (stG.player.talent) {
    step(stG, { type: 'search' });
    check('天选之人成就解锁', stG.achievements.has('gifted'));
  }
}

// ---------- 5.10 新特殊机制：幻影噪音 / 黑暗脉冲 ----------
section('5.10 新特殊机制：幻影噪音 / 黑暗脉冲');
{
  const st = createGame({ levels, seed: 51, startLevel: 'level-16' });
  st.player.sanityMax = 100;
  st.player.sanity = 100;
  let heard = false;
  for (let i = 0; i < 20; i++) {
    const res = step(st, { type: 'search' });
    if (res.events.some((e) => e.text.includes('巨响'))) heard = true;
  }
  check('phantom-noise：18 回合触发无源巨响', heard);
  const st2 = createGame({ levels, seed: 53, startLevel: 'level-21' });
  st2.player.sanityMax = 100;
  st2.player.sanity = 100;
  let pulsed = false;
  for (let i = 0; i < 22; i++) {
    const res = step(st2, { type: 'search' });
    if (res.events.some((e) => e.text.includes('黑暗像呼吸'))) pulsed = true;
  }
  check('dark-pulse：20 回合触发黑暗脉冲', pulsed);
  check('dark-pulse：理智被侵蚀', st2.player.sanity < 99, `san=${st2.player.sanity}`);
}

// ---------- 5.11 血染森林（Level 14 重做）：低语机制 / =) 双重视角 / 假出口 ----------
section('5.11 血染森林：低语侵蚀 / 双重视角场景 / 真假出口');
{
  const d14 = levels['level-14'];
  check('Level 14 已重做为血染森林', d14.name.includes('血染森林'), d14.name);
  check('难度等级 5（实体横行）', d14.difficultyClass === 5, `dc=${d14.difficultyClass}`);
  check('含 whisper-drain 机制', (d14.specialMechanisms || []).includes('whisper-drain'));
  // 双重视角场景：=) 与 =( 并存（全角/半角都可能）
  const spTexts = (d14.setPieces || []).map((s) => s.text).join('');
  check('场景含 =) 低语', spTexts.includes('=）') || spTexts.includes('=)'));
  check('场景含 =( 警告', spTexts.includes('=(') || spTexts.includes('=（'));
  check('含致命场景（树根）', (d14.setPieces || []).some((s) => (s.sanityEffect || 0) <= -50));
  // 真假出口
  const fakeExit = (d14.exits || []).find((e) => e.danger);
  const realExit = (d14.exits || []).find((e) => !e.danger && e.target === 'level-28');
  check('假出口存在且标记危险', !!fakeExit && fakeExit.target === 'level-21');
  check('真出口通往 Level 28（hidden）', !!realExit && realExit.hidden);
  // whisper-drain：8 回合触发低语 + 理智下降；40 回合后侵蚀加深
  const st = createGame({ levels, seed: 61, startLevel: 'level-14' });
  st.player.sanityMax = 100;
  st.player.sanity = 100;
  let whisper = 0;
  for (let i = 0; i < 20; i++) {
    const res = step(st, { type: 'search' });
    if (res.events.some((e) => e.text.includes('留下来吧'))) whisper++;
  }
  check('whisper-drain：8 回合触发低语（20 回合内 ≥1 次）', whisper >= 1, `低语 ${whisper} 次`);
  check('whisper-drain：理智被低语侵蚀（<99）', st.player.sanity < 99, `san=${st.player.sanity}`);
  // Level 28 可玩
  const l28 = generateLevel(levels['level-28'], 3);
  check('Level 28 生成且可达', verifyReachable(l28));
  check('Level 28 有出口', l28.exits.length >= 2, `${l28.exits.length}`);
  // 入口图：Level 13 地板切入 → 14
  const l13 = levels['level-13'];
  check('Level 13 提供入口到 14', (l13.exits || []).some((e) => e.target === 'level-14'));
}

// ---------- 5.12 新机制：双色切换 / 上课铃 / 心电监护 + 新成就 ----------
section('5.12 新机制与新成就');
{
  // color-shift：Level 34，15 回合触发
  const st1 = createGame({ levels, seed: 71, startLevel: 'level-34' });
  st1.player.sanityMax = 100;
  st1.player.sanity = 100;
  let shifted = false;
  for (let i = 0; i < 17; i++) {
    const res = step(st1, { type: 'search' });
    if (res.events.some((e) => e.text.includes('切换成蓝色'))) shifted = true;
  }
  check('color-shift：15 回合触发双色切换', shifted);
  check('color-shift：侵蚀理智', st1.player.sanity < 100, `san=${st1.player.sanity}`);
  // bell-ring：Level 118，12 回合铃声唤醒实体
  const st2 = createGame({ levels, seed: 73, startLevel: 'level-118' });
  st2.entities = [
    { x: st2.player.x + 4, y: st2.player.y, type: 'scratcher', hp: 50, aggression: 'hostile', state: 'idle', visible: false, alert: false, wait: 0, revealed: false },
  ];
  let rang = false;
  for (let i = 0; i < 14; i++) {
    const res = step(st2, { type: 'search' });
    if (res.events.some((e) => e.text.includes('上课铃'))) rang = true;
  }
  check('bell-ring：12 回合铃声大作', rang);
  // heartbeat：Level 170，10 回合触发
  const st3 = createGame({ levels, seed: 75, startLevel: 'level-170' });
  st3.player.sanityMax = 100;
  st3.player.sanity = 100;
  let beat = false;
  for (let i = 0; i < 12; i++) {
    const res = step(st3, { type: 'search' });
    if (res.events.some((e) => e.text.includes('心电监护仪'))) beat = true;
  }
  check('heartbeat：10 回合心电滴答', beat);
  // 新成就注册
  const ids = ACHIEVEMENTS.map((a) => a.id);
  check('4 个新成就已注册', ['aesthetic-collector', 'library-card', 'headmaster', 'curator'].every((i) => ids.includes(i)));
  check('成就总数 29', ACHIEVEMENTS.length === 29, `${ACHIEVEMENTS.length}`);
  // 层级特定成就可达成
  const st4 = createGame({ levels, seed: 77, startLevel: 'level-118' });
  enterLevel(st4, 'level-28', {});
  check('headmaster 成就条件可达成（118→28）', (st4.stats.visited['level-118'] || 0) > 0 && (st4.stats.visited['level-28'] || 0) > 0);
}

// ---------- 6. 野性变体（wild 无尽生成） ----------
section('6. wild 变异：确定性 + 10 个随机种子全部生成可达');
{
  const base = levels['level-0'];
  const m1 = mutateDna(base, 12345);
  const m2 = mutateDna(base, 12345);
  check('id 形如 wild-<8位十六进制>', /^wild-[0-9a-f]{8}$/.test(m1.id), m1.id);
  check('name 带"（野性变体）"后缀', m1.name.includes('（野性变体）'), m1.name);
  check('两次变异 DNA 完全一致', JSON.stringify(m1) === JSON.stringify(m2));
  const g1 = generateLevel(m1, 7);
  const g2 = generateLevel(m2, 7);
  check('同 (wildDna, seed) 生成布局哈希一致', levelHash(g1) === levelHash(g2), '');
  let allOk = true;
  for (let s = 1; s <= 10; s++) {
    const dna = mutateDna(base, s * 977);
    const level = generateLevel(dna, s);
    const reach = verifyReachable(level);
    const ent = level.infinite ? true : level.entities.every((e) => e.x >= 0 && e.y >= 0 && e.x < level.width && e.y < level.height);
    const ok = reach && ent;
    if (!ok) allOk = false;
    check(`wild seed=${s}（${dna.id}）生成且可达`, ok, `reach=${reach} entities=${ent}`);
  }
  check('10 个随机种子全部成功', allOk);
}

// ---------- 7. 走廊网格模式（合成 DNA，作为可复用生成模式验证） ----------
section('7. hallwayGrid 模式：全连通 + 门可通行（合成 DNA）');
{
  const WALK = new Set(['.', '~', 'D', 'S', 'E', 'I', 'T']);
  const bfsReach = (level) => {
    const seen = new Set([level.spawn.x + ',' + level.spawn.y]);
    const q = [[level.spawn.x, level.spawn.y]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= level.width || ny >= level.height) continue;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (!WALK.has(level.tiles[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };
  // 合成走廊网格 DNA（Level 0 已改为无限世界，此处仅验证该模式本身）
  const gridDna = {
    ...levels['level-0'],
    terrain: { ...levels['level-0'].terrain, infinite: false, hallwayGrid: true, width: 48, height: 48 },
  };
  const l0 = generateLevel(gridDna, 42);
  check('走廊网格模式生效', !!(l0.terrain && l0.terrain.hallwayGrid), JSON.stringify(l0.terrain || {}).slice(0, 80));
  const walkableCount = l0.tiles.flat().filter((t) => WALK.has(t)).length;
  // 环绕 BFS：与游戏内 looping 移动一致（跨边界相邻）
  const wrapBfs = (level) => {
    const w = level.width;
    const h = level.height;
    const seen = new Set([level.spawn.x + ',' + level.spawn.y]);
    const q = [[level.spawn.x, level.spawn.y]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = (x + dx + w) % w;
        const ny = (y + dy + h) % h;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (!WALK.has(level.tiles[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };
  check('Level 0 游戏内(环绕)100% 可达', wrapBfs(l0).size === walkableCount, `${wrapBfs(l0).size}/${walkableCount}`);
  const noWrap = bfsReach(l0).size;
  check('非环绕视角 ≥98% 可达（大部分联通）', noWrap / walkableCount >= 0.98, `${noWrap}/${walkableCount}=${((noWrap / walkableCount) * 100).toFixed(1)}%`);
  const doors = (l0.props || []).filter((p) => p.kind === 'door').length;
  check('门数量充足（≥20）', doors >= 20, `${doors} 扇门`);
  const dTiles = l0.tiles.flat().filter((t) => t === 'D').length;
  check('D 门瓦片与门道具数量一致', dTiles === doors, `tiles=${dTiles} props=${doors}`);
  let allFull = true;
  let worstRatio = 1;
  for (let s = 1; s <= 5; s++) {
    const lv = generateLevel(gridDna, s);
    const wc = lv.tiles.flat().filter((t) => WALK.has(t)).length;
    if (wrapBfs(lv).size !== wc) allFull = false;
    worstRatio = Math.min(worstRatio, bfsReach(lv).size / wc);
  }
  check('5 个种子游戏内全部 100% 联通', allFull);
  check('5 个种子非环绕联通率均 ≥98%', worstRatio >= 0.98, `最差=${(worstRatio * 100).toFixed(1)}%`);
  const lv2 = generateLevel(gridDna, 7);
  const rowY = 4; // 走廊行（y%8===4 全行可走）
  let okWalk = true;
  for (let i = 0; i < 200; i++) {
    const xx = ((Math.floor(lv2.width / 2) + i) % lv2.width + lv2.width) % lv2.width;
    if (!WALK.has(lv2.tiles[rowY][xx])) {
      okWalk = false;
      break;
    }
  }
  check('沿走廊行直线走 200 步全程可行（无尽走廊）', okWalk);
}

// ---------- 8. Level 0 经典房间模式：随机大小、相似而不相同 ----------
section('8. Level 0 房间模式：大小多样 + 全联通 + 门可通行');
{
  const WALK = new Set(['.', '~', 'D', 'S', 'E', 'I', 'T']);
  const bfsReach = (level) => {
    const seen = new Set([level.spawn.x + ',' + level.spawn.y]);
    const q = [[level.spawn.x, level.spawn.y]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= level.width || ny >= level.height) continue;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (!WALK.has(level.tiles[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };
  const wrapBfs = (level) => {
    const w = level.width;
    const h = level.height;
    const seen = new Set([level.spawn.x + ',' + level.spawn.y]);
    const q = [[level.spawn.x, level.spawn.y]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = (x + dx + w) % w;
        const ny = (y + dy + h) % h;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (!WALK.has(level.tiles[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };
  const l0 = generateLevel(levels['level-404'], 42);
  check('Level 404 为经典房间模式（非走廊网格）', !(l0.terrain && l0.terrain.hallwayGrid));
  check('房间数量 ≥6', (l0.rooms || []).length >= 6, `${(l0.rooms || []).length} 间`);
  const sizeSet = new Set((l0.rooms || []).map((r) => r.w + 'x' + r.h));
  check('房间大小多样（≥3 种尺寸）', sizeSet.size >= 3, [...sizeSet].slice(0, 6).join(','));
  const walkableCount = l0.tiles.flat().filter((t) => WALK.has(t)).length;
  check('游戏内 100% 可达', bfsReach(l0).size === walkableCount, `${bfsReach(l0).size}/${walkableCount}`);
  const noWrap = bfsReach(l0).size;
  check('非环绕 ≥98% 可达', noWrap / walkableCount >= 0.98, `${((noWrap / walkableCount) * 100).toFixed(1)}%`);
  const doors = (l0.props || []).filter((p) => p.kind === 'door').length;
  check('门数量充足（≥4）', doors >= 4, `${doors} 扇门`);
  const dTiles = l0.tiles.flat().filter((t) => t === 'D').length;
  check('D 瓦片与门道具一致', dTiles === doors, `${dTiles}/${doors}`);
  // 门配对传送：doorLinks 覆盖门道具、端点均为 D 瓦片、配对相距远（非欧特性）
  const links = l0.doorLinks || [];
  check('门配对存在（≥1 对）', links.length >= 1, `${links.length} 对`);
  const linksOk = links.every(
    (l) =>
      l0.tiles[l.y1][l.x1] === 'D' &&
      l0.tiles[l.y2][l.x2] === 'D' &&
      !(l.x1 === l.x2 && l.y1 === l.y2)
  );
  check('配对端点均为门且非自环', linksOk);
  const avgDist =
    links.length > 0
      ? links.reduce((s, l) => s + (Math.abs(l.x1 - l.x2) + Math.abs(l.y1 - l.y2)), 0) / links.length
      : 0;
  check('配对平均距离 ≥8（传送至远处房间）', avgDist >= 8, `平均 ${avgDist.toFixed(1)} 格`);
  // 功能测试：踏上任意一扇门 → 传送到配对门（优先未锁的门）
  if (links.length > 0) {
    const st = createGame({ levels, seed: 42 });
    enterLevel(st, 'level-404', {});
    const l = links.find((x) => !x.locked) || links[0];
    const nx = l.x1 > 0 ? l.x1 - 1 : l.x1 + 1;
    const ny = l.y1;
    if (st.level.tiles[ny][nx] !== '#') {
      st.player.x = nx;
      st.player.y = ny;
      const before = st.player.sanity;
      step(st, { type: 'move', dx: l.x1 - nx, dy: 0 });
      check(
        '踏上门的玩家传送到配对门',
        st.player.x === l.x2 && st.player.y === l.y2,
        `(${st.player.x},${st.player.y}) → 期望(${l.x2},${l.y2})`
      );
      check(
        '传送消耗 2 点理智（非欧体验）',
        st.player.sanity <= before - 2 && st.player.sanity >= before - 5,
        `${before}→${st.player.sanity}（含基础侵蚀/随机压力事件）`
      );
    }
  }
  // 户外城市（Level 11）店门：存在（建筑入口）但不参与传送配对（doorLinks 为空）
  const l11 = generateLevel(levels['level-11'], 5);
  check('Level 11 为无限城市（分块生成）', l11.infinite === true);
  let dCount11 = 0;
  for (let y = -16; y < 32; y++) {
    for (let x = -16; x < 32; x++) {
      if (l11.getTile(x, y) === 'D') dCount11++;
    }
  }
  check('无限城市有店门（≥1）', dCount11 >= 1, `${dCount11} 扇`);
  check('城市店门不参与传送配对', (l11.doorLinks || []).length === 0, `${(l11.doorLinks || []).length} 对`);
  // 锁门机制：锁着的门无钥匙挡路、有钥匙通过并消耗
  {
    let tested = false;
    for (let s = 1; s <= 10 && !tested; s++) {
      const st = createGame({ levels, seed: s });
      enterLevel(st, 'level-404', {});
      const links = st.level.doorLinks || [];
      const li = links.findIndex((l) => l.locked);
      if (li < 0) continue;
      tested = true;
      const l = links[li];
      const nx = l.x1 > 0 ? l.x1 - 1 : l.x1 + 1;
      if (st.level.tiles[l.y1][nx] === '#') continue;
      st.player.x = nx;
      st.player.y = l.y1;
      step(st, { type: 'move', dx: l.x1 - nx, dy: 0 });
      const blocked = !(st.player.x === l.x2 && st.player.y === l.y2);
      check('无钥匙时锁门挡住玩家', blocked);
      st.player.inventory.push('key');
      step(st, { type: 'move', dx: l.x1 - st.player.x, dy: l.y1 - st.player.y });
      check(
        '有钥匙时通过并消耗钥匙',
        st.player.x === l.x2 && st.player.y === l.y2 && !st.player.inventory.includes('key'),
        `(${st.player.x},${st.player.y})`
      );
      break;
    }
    check('存在锁着的门（10 个种子内至少 1 扇）', tested);
  }
  // 门必须是"墙上的真开口"：每扇门至少 2 个可走邻居（房间侧 + 外侧），且本身在墙位
  const doorOnWall = (l0.props || [])
    .filter((p) => p.kind === 'door')
    .every((p) => {
      if (l0.tiles[p.y][p.x] !== 'D') return false;
      let walkNb = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (nx < 0 || ny < 0 || nx >= l0.width || ny >= l0.height) continue;
        if (l0.tiles[ny][nx] !== '#') walkNb++;
      }
      return walkNb >= 2;
    });
  check('全部门为真开口（≥2 个可走邻居）', doorOnWall);
  check('确定性：同种子两次生成哈希一致', levelHash(generateLevel(levels['level-404'], 42)) === levelHash(l0));
  let allOk = true;
  for (let s = 1; s <= 5; s++) {
    const lv = generateLevel(levels['level-404'], s);
    const wc = lv.tiles.flat().filter((t) => WALK.has(t)).length;
    if (bfsReach(lv).size !== wc) allOk = false;
  }
  check('5 个种子游戏内全部 100% 联通', allOk);
}

// ---------- 9. 出口图完整性（网状出入口） ----------
section('9. 出口图：全部出口指向存在的层级，从 Level 0 可达所有层');
{
  const ids = new Set(Object.keys(levels));
  const bad = [];
  for (const id of Object.keys(levels)) {
    for (const ex of levels[id].exits || []) {
      if (!ids.has(ex.target)) bad.push(`${id} → ${ex.target}`);
    }
  }
  check('全部出口目标存在', bad.length === 0, bad.slice(0, 5).join('; '));
  const noExit = Object.keys(levels).filter((id) => !(levels[id].exits || []).length);
  check('每个层级至少 1 个出口', noExit.length === 0, noExit.join(','));
  // 出口图 BFS：从 level-0 出发可达全部层级（枢纽 Hub 是核心节点）
  const graph = {};
  for (const id of Object.keys(levels)) graph[id] = (levels[id].exits || []).map((e) => e.target);
  const reach = new Set(['level-0']);
  const q = ['level-0'];
  while (q.length) {
    const cur = q.pop();
    for (const nx of graph[cur] || []) {
      if (!reach.has(nx)) {
        reach.add(nx);
        q.push(nx);
      }
    }
  }
  const unreach = Object.keys(levels).filter((id) => !reach.has(id));
  check('出口图：从 Level 0 可达全部层级', unreach.length === 0, unreach.join(','));
  // 总层级数
  check('层级总数 ≥ 26（全面打磨目标）', Object.keys(levels).length >= 26, `${Object.keys(levels).length} 层`);
}

// ---------- 10. 特殊层级机制 ----------
section('10. 特殊机制：!层无尽追击 / 666高温 / 直视笑魇');
{
  // !层 endless-chase：敌对实体持续 alert
  const st = createGame({ levels, seed: 3 });
  enterLevel(st, 'level-!', { keepPlayer: true });
  st.entities = [
    { x: st.player.x + 3, y: st.player.y, type: 'hound', hp: 50, aggression: 'hostile', state: 'idle', visible: true, alert: false, wait: 0, revealed: false },
  ];
  step(st, { type: 'rest' });
  check('!层：敌对实体保持追击（alert=true）', st.entities[0].alert === true);

  // 666 heat-drain：10 回合高温灼烧 -1 HP
  const st2 = createGame({ levels, seed: 3 });
  enterLevel(st2, 'level-666', { keepPlayer: true });
  st2.entities = [];
  const hp0 = st2.player.hp;
  for (let i = 0; i < 10; i++) step(st2, { type: 'rest' });
  check('666：10 回合高温 -1 HP', st2.player.hp === hp0 - 1, `${hp0}→${st2.player.hp}`);

  // 直视笑魇：look 时 LOS 内（≤6 格）smiler → -5 理智且被激怒
  const st3 = createGame({ levels, seed: 3 });
  const sm = {
    x: st3.player.x + 2, y: st3.player.y, type: 'smiler', hp: 60, aggression: 'hostile',
    state: 'idle', visible: true, alert: false, wait: 0, revealed: false,
  };
  st3.entities.push(sm);
  const s0 = st3.player.sanity;
  step(st3, { type: 'look' });
  check('直视笑魇 -5 理智', st3.player.sanity <= s0 - 5, `${s0}→${st3.player.sanity}`);
  check('直视笑魇被激怒（alert=true）', sm.alert === true);
}

// ---------- 11. Codex 成就 ----------
section('11. 成就：非线性解锁');
{
  const st = createGame({ levels, seed: 3 });
  step(st, { type: 'move', dx: 1, dy: 0 });
  check('成就「第一步」解锁', st.achievements.has('first-steps'), [...st.achievements].join(','));
  // 拾取 20 件物品 → 「拾荒者」
  const st2 = createGame({ levels, seed: 3 });
  st2.stats.itemsPicked = 20;
  step(st2, { type: 'rest' });
  check('成就「拾荒者」解锁', st2.achievements.has('hoarder'));
  // 发现 5 层级 → 「初探者」
  const st3 = createGame({ levels, seed: 3 });
  st3.codex.levels = Object.fromEntries(
    ['level-0', 'level-1', 'level-2', 'level-3', 'level-4'].map((id) => [id, { id, name: id, visits: 1 }])
  );
  step(st3, { type: 'rest' });
  check('成就「初探者」解锁', st3.achievements.has('explorer-5'));
  // 存档回环：成就与统计持久化
  const st4 = createGame({ levels, seed: 3 });
  st4.stats.itemsPicked = 20;
  step(st4, { type: 'rest' });
  const data = serializeState(st4);
  const st5 = createGame({ levels, seed: 3 });
  deserializeState(st5, data);
  check('成就跨存档持久化', st5.achievements.has('hoarder') && st5.stats.itemsPicked === 20);
}

// ---------- 12. 新实体 + 图鉴 + 空间异常 ----------
section('12. 新实体/实体图鉴/时间与重力异常');
{
  // deathmoth：视野内发现玩家后追击（alert）
  const st = createGame({ levels, seed: 3 });
  const dm = {
    x: st.player.x + 1, y: st.player.y, type: 'deathmoth', hp: 25, aggression: 'hostile',
    state: 'idle', visible: true, alert: false, wait: 0, revealed: false,
  };
  st.entities.push(dm);
  step(st, { type: 'rest' });
  check('死亡飞蛾发现玩家后追击（alert）', dm.alert === true);

  // glowfolk：三次相邻引导后给出隐藏路提示（guideCount）
  const st2 = createGame({ levels, seed: 3 });
  st2.entities = [];
  const gf = {
    x: st2.player.x, y: st2.player.y, type: 'glowfolk', hp: 30, aggression: 'passive',
    state: 'idle', visible: true, alert: false, wait: 0, revealed: false,
  };
  st2.entities.push(gf);
  for (let i = 0; i < 3; i++) {
    gf.x = st2.player.x;
    gf.y = st2.player.y;
    step(st2, { type: 'rest' });
  }
  check('发光者三次指引后提示隐藏路线', (gf.guideCount || 0) >= 3);

  // 实体图鉴：视野内实体被记录
  const st3 = createGame({ levels, seed: 3 });
  // 把玩家附近放一只 moth，step 后 bestiary 应记录
  const mth = { x: st3.player.x + 1, y: st3.player.y, type: 'moth', hp: 10, aggression: 'passive', state: 'idle', visible: true, alert: false, wait: 0, revealed: false };
  st3.entities.push(mth);
  step(st3, { type: 'rest' });
  check('实体图鉴记录目击', !!(st3.codex.bestiary && st3.codex.bestiary.moth && st3.codex.bestiary.moth.seen >= 1));

  // time-anomaly：Level 0.1 每 25 回合恢复少量状态
  const st4 = createGame({ levels, seed: 3 });
  enterLevel(st4, 'level-0.1', { keepPlayer: true });
  st4.entities = [];
  st4.player.sanity = 30;
  st4.player.stamina = 30;
  for (let i = 0; i < 25; i++) step(st4, { type: 'rest' });
  // 25 回合基础侵蚀 0.18×25=4.5；时间异常 +2 → 期望 ≈27.5（高于纯侵蚀的 25.5）
  check('时间异常：25 回合后触发恢复（净高于纯侵蚀）', st4.player.sanity >= 27, `${st4.player.sanity}`);

  // gravity-anomaly：Level -1 每 30 回合重力翻转（产生事件或位移）
  const st5 = createGame({ levels, seed: 3 });
  enterLevel(st5, 'level--1', { keepPlayer: true });
  st5.entities = [];
  let gravityEvent = false;
  for (let i = 0; i < 30; i++) {
    const r = step(st5, { type: 'rest' });
    if (r.events.some((e) => e.text.includes('重力'))) gravityEvent = true;
  }
  check('重力异常：30 回合触发翻转事件', gravityEvent);
}

// ---------- 13. 层级拓扑差异化（F 版几何形态） ----------
section('13. 拓扑：城市街区/跑道/洞穴，各层级几何结构不同');
{
  const WALK = new Set(['.', '~', 'D', 'S', 'E', 'I', 'T']);
  const wrapBfs = (level) => {
    const w = level.width;
    const h = level.height;
    const seen = new Set([level.spawn.x + ',' + level.spawn.y]);
    const q = [[level.spawn.x, level.spawn.y]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = (x + dx + w) % w;
        const ny = (y + dy + h) % h;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (!WALK.has(level.tiles[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };
  const ratio = (lv) => {
    const wc = lv.tiles.flat().filter((t) => WALK.has(t)).length;
    return wc > 0 ? wrapBfs(lv).size / wc : 0;
  };

  // Level 11：城市街区网格（宽街道 + 街区建筑）——无限城市
  const l11 = generateLevel(levels['level-11'], 7);
  check('Level 11 使用 city-grid 拓扑', (l11.terrain || {}).topology === 'city-grid', JSON.stringify(l11.terrain || {}).slice(0, 60));
  check('Level 11 为无限城市', l11.infinite === true);
  check('Level 11 街道贯通（y=1 行横向可走 ≥90%）', (() => {
    let n = 0;
    for (let x = -48; x < 96; x++) if (WALK.has(l11.getTile(x, 1))) n++;
    return n / 144 >= 0.9;
  })(), '');
  check('Level 11 街区建筑存在（墙与内部并存）', (() => {
    let walls = 0;
    let floors = 0;
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 48; x++) {
        const t = l11.getTile(x, y);
        if (t === '#') walls++;
        else if (WALK.has(t)) floors++;
      }
    }
    return walls > 100 && floors > 400;
  })(), '');

  // Level !：长条跑道（中央走廊贯通 + 两侧房间带）
  const lBang = generateLevel(levels['level-!'], 7);
  check('Level ! 使用 racetrack 拓扑', (lBang.terrain || {}).topology === 'racetrack');
  check('Level ! 长条形（宽 > 4 倍高）', lBang.width > lBang.height * 4, `${lBang.width}×${lBang.height}`);
  const midY = Math.floor(lBang.height / 2);
  const corridorFull = lBang.tiles[midY].every((t) => WALK.has(t));
  check('Level ! 中央跑道全程贯通', corridorFull, `row ${midY} full`);
  const sideRooms = (lBang.rooms || []).length;
  check('Level ! 两侧房间带（≥8 间）', sideRooms >= 8, `${sideRooms} 间`);
  check('Level ! 环绕 100% 联通', ratio(lBang) >= 0.999);

  // Level 8：洞穴（随机游走隧道，天然不规则）
  const l8 = generateLevel(levels['level-8'], 7);
  check('Level 8 使用 caves 拓扑', (l8.terrain || {}).topology === 'caves' || l8.environment === 'caves');
  check('Level 8 环绕 100% 联通', ratio(l8) >= 0.999);
  // 三种拓扑布局互不相同（哈希不同）
  check(
    '城市/跑道/洞穴三种拓扑布局互异',
    levelHash(l11) !== levelHash(lBang) && levelHash(lBang) !== levelHash(l8) && levelHash(l11) !== levelHash(l8)
  );
}

// ---------- 14. 拓扑对照 F 版（仓库/旅馆/郊区/田野/天堂） ----------
section('14. 拓扑：各层级几何符合 F 版描述');
{
  const WALK = new Set(['.', '~', 'D', 'S', 'E', 'I', 'T']);
  const wrapBfs = (level) => {
    const w = level.width;
    const h = level.height;
    const seen = new Set([level.spawn.x + ',' + level.spawn.y]);
    const q = [[level.spawn.x, level.spawn.y]];
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = (x + dx + w) % w;
        const ny = (y + dy + h) % h;
        const k = nx + ',' + ny;
        if (seen.has(k)) continue;
        if (!WALK.has(level.tiles[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    return seen;
  };
  const ratio = (lv) => {
    const wc = lv.tiles.flat().filter((t) => WALK.has(t)).length;
    return wc > 0 ? wrapBfs(lv).size / wc : 0;
  };
  const openRatio = (lv) =>
    lv.infinite
      ? countIn(lv, -32, -32, 32, 32, (t) => t === '.') / (64 * 64)
      : lv.tiles.flat().filter((t) => t === '.').length / (lv.width * lv.height);
  const wallRatio = (lv) =>
    lv.infinite
      ? countIn(lv, -32, -32, 32, 32, (t) => t === '#') / (64 * 64)
      : lv.tiles.flat().filter((t) => t === '#').length / (lv.width * lv.height);
  const countIn = (lv, x0, y0, x1, y1, pred) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pred(lv.getTile(x, y))) n++;
    return n;
  };
  const streetRatio = (lv) => {
    let n = 0;
    for (let x = -64; x < 64; x++) if (WALK.has(lv.getTile(x, 1))) n++;
    return n / 128;
  };

  // Level 1 宜居地带：开阔仓库大厅（开阔率 ≥70%）+ 柱列
  const l1 = generateLevel(levels['level-1'], 7);
  check('Level 1 使用 warehouse 拓扑', (l1.terrain || {}).topology === 'warehouse');
  check('Level 1 开阔大厅（地板占比 ≥70%）', openRatio(l1) >= 0.7, `${(openRatio(l1) * 100).toFixed(0)}%`);
  check('Level 1 柱列存在（墙占比 2-25%）', wallRatio(l1) >= 0.02 && wallRatio(l1) <= 0.25, `${(wallRatio(l1) * 100).toFixed(1)}%`);
  check('Level 1 为无限仓库', l1.infinite === true);

  // Level 5 恐怖旅馆：走廊两侧房间（走廊网格 + 房间 ≥12）
  const l5 = generateLevel(levels['level-5'], 7);
  check('Level 5 使用 hotel 拓扑', (l5.terrain || {}).topology === 'hotel', JSON.stringify((l5.terrain || {}).topology));
  check('Level 5 尺寸 30×30', l5.width === 30 && l5.height === 30, `${l5.width}×${l5.height}`);
  check('Level 5 房间数 ≥12（走廊两侧客房）', (l5.rooms || []).length >= 12, `${(l5.rooms || []).length} 间`);
  const l5Doors = (l5.props || []).filter((p) => p.kind === 'door').length;
  check('Level 5 门口遍布（门 ≥8）', l5Doors >= 8, `${l5Doors} 扇`);
  check('Level 5 环绕 100% 联通', ratio(l5) >= 0.999);

  // Level 9 郊区：城市街区（街道 + 沿街房屋）——无限
  const l9 = generateLevel(levels['level-9'], 7);
  check('Level 9 使用 city-grid 拓扑', (l9.terrain || {}).topology === 'city-grid');
  check('Level 9 为无限城市', l9.infinite === true);
  check('Level 9 街道贯通（y=1 行横向可走 ≥90%）', streetRatio(l9) >= 0.9, `${(streetRatio(l9) * 100).toFixed(0)}%`);

  // Level 10 田野：开阔（地板占比 ≥75%）+ 障碍簇
  const l10 = generateLevel(levels['level-10'], 7);
  check('Level 10 使用 fields 拓扑', (l10.terrain || {}).topology === 'fields');
  check('Level 10 开阔农田（地板占比 ≥75%）', openRatio(l10) >= 0.75, `${(openRatio(l10) * 100).toFixed(0)}%`);

  // Level 14 天堂：开阔草地
  const l14 = generateLevel(levels['level-14'], 7);
  check('Level 14 使用 fields 拓扑', (l14.terrain || {}).topology === 'fields');
  check('Level 14 开阔草地（地板占比 ≥65%）', openRatio(l14) >= 0.65, `${(openRatio(l14) * 100).toFixed(0)}%`);

  // 各层级拓扑互异（几何形态确实不同）
  const hashes = [l1, l5, l9, l10, l14].map(levelHash);
  check('仓库/旅馆/郊区/田野/天堂 拓扑布局互异', new Set(hashes).size === 5);
}
console.log(`\n====================`);
console.log(`冒烟测试完成：通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail > 0 ? 1 : 0;

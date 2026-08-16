// test.js — 冒烟测试（node test.js）
// 覆盖：1 确定性 / 2 可达性 / 3 密度 / 4 随机对局 / 5 循环层边界。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadLevels, LEVEL_IDS, mutateDna } from './engine/dna.js';
import { generateLevel, verifyReachable } from './engine/generator.js';
import { hashString } from './engine/rng.js';
import { createGame, step, playerVisibleTiles } from './engine/game.js';

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
        arr.every((o) => o.x >= 0 && o.y >= 0 && o.x < level.width && o.y < level.height);
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
    const okTotal = anyDensity && nEnt > 0 && nEnt <= upper + 1e-9;
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
      // 每回合顺手验证：玩家坐标不越界
      const p = state.player;
      if (p.x < 0 || p.y < 0 || p.x >= state.level.width || p.y >= state.level.height) {
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
section('5. 循环层：looping 层级边界移动不越界');
{
  const state = createGame({ levels, seed: 3 });
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
    check('level-0 应为 looping', false, `spaceRules=${level.spaceRules.join(',')}`);
  }
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
    const ent = level.entities.every((e) => e.x >= 0 && e.y >= 0 && e.x < level.width && e.y < level.height);
    const ok = reach && ent;
    if (!ok) allOk = false;
    check(`wild seed=${s}（${dna.id}）生成且可达`, ok, `reach=${reach} entities=${ent}`);
  }
  check('10 个随机种子全部成功', allOk);
}

// ---------- 7. 走廊网格（Level 0 无尽联通、门通道） ----------
section('7. hallwayGrid：全连通无死角 + 门可通行');
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
  const l0 = generateLevel(levels['level-0'], 42);
  check('Level 0 走廊网格模式生效', !!(l0.terrain && l0.terrain.hallwayGrid), JSON.stringify(l0.terrain || {}).slice(0, 80));
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
    const lv = generateLevel(levels['level-0'], s);
    const wc = lv.tiles.flat().filter((t) => WALK.has(t)).length;
    if (wrapBfs(lv).size !== wc) allFull = false;
    worstRatio = Math.min(worstRatio, bfsReach(lv).size / wc);
  }
  check('5 个种子游戏内全部 100% 联通', allFull);
  check('5 个种子非环绕联通率均 ≥98%', worstRatio >= 0.98, `最差=${(worstRatio * 100).toFixed(1)}%`);
  const lv2 = generateLevel(levels['level-0'], 7);
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

// ---------- 汇总 ----------
console.log(`\n====================`);
console.log(`冒烟测试完成：通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail > 0 ? 1 : 0;

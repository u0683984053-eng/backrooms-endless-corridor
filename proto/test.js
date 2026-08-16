// test.js — 冒烟测试（node test.js）
// 覆盖：1 确定性 / 2 可达性 / 3 密度 / 4 随机对局 / 5 循环层边界。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadLevels, LEVEL_IDS, mutateDna } from './engine/dna.js';
import { generateLevel, verifyReachable } from './engine/generator.js';
import { hashString } from './engine/rng.js';
import { createGame, step, enterLevel, playerVisibleTiles, serializeState, deserializeState } from './engine/game.js';

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
  // 合成走廊网格 DNA（Level 0 已改回经典房间模式，此处仅验证该模式本身）
  const gridDna = {
    ...levels['level-0'],
    terrain: { ...levels['level-0'].terrain, hallwayGrid: true, width: 48, height: 48 },
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
  const l0 = generateLevel(levels['level-0'], 42);
  check('Level 0 为经典房间模式（非走廊网格）', !(l0.terrain && l0.terrain.hallwayGrid));
  check('房间数量 ≥10', (l0.rooms || []).length >= 10, `${(l0.rooms || []).length} 间`);
  const sizeSet = new Set((l0.rooms || []).map((r) => r.w + 'x' + r.h));
  check('房间大小多样（≥3 种尺寸）', sizeSet.size >= 3, [...sizeSet].slice(0, 6).join(','));
  const walkableCount = l0.tiles.flat().filter((t) => WALK.has(t)).length;
  check('游戏内(环绕)100% 可达', wrapBfs(l0).size === walkableCount, `${wrapBfs(l0).size}/${walkableCount}`);
  const noWrap = bfsReach(l0).size;
  check('非环绕 ≥98% 可达', noWrap / walkableCount >= 0.98, `${((noWrap / walkableCount) * 100).toFixed(1)}%`);
  const doors = (l0.props || []).filter((p) => p.kind === 'door').length;
  check('门数量充足（≥10）', doors >= 10, `${doors} 扇门`);
  const dTiles = l0.tiles.flat().filter((t) => t === 'D').length;
  check('D 瓦片与门道具一致', dTiles === doors, `${dTiles}/${doors}`);
  // 门配对传送：doorLinks 覆盖门道具、端点均为 D 瓦片、配对相距远（非欧特性）
  const links = l0.doorLinks || [];
  check('门配对存在（≥3 对）', links.length >= 3, `${links.length} 对`);
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
  // 功能测试：踏上任意一扇门 → 传送到配对门
  if (links.length > 0) {
    const st = createGame({ levels, seed: 42 });
    const l = links[0];
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
  // 户外层（Level 11 无尽城市）不应有门
  const l11 = generateLevel(levels['level-11'], 5);
  const doorProps11 = (l11.props || []).filter((p) => p.kind === 'door').length;
  check('户外层（Level 11）无门', doorProps11 === 0, `${doorProps11} 扇`);
  // 锁门机制：锁着的门无钥匙挡路、有钥匙通过并消耗
  {
    let tested = false;
    for (let s = 1; s <= 10 && !tested; s++) {
      const st = createGame({ levels, seed: s });
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
  check('确定性：同种子两次生成哈希一致', levelHash(generateLevel(levels['level-0'], 42)) === levelHash(l0));
  let allOk = true;
  for (let s = 1; s <= 5; s++) {
    const lv = generateLevel(levels['level-0'], s);
    const wc = lv.tiles.flat().filter((t) => WALK.has(t)).length;
    if (wrapBfs(lv).size !== wc) allOk = false;
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
console.log(`\n====================`);
console.log(`冒烟测试完成：通过 ${pass} 项，失败 ${fail} 项`);
process.exitCode = fail > 0 ? 1 : 0;

// engine/generator.js
// 确定性程序化生成器：房间 + 走廊 + 实体 + 物品 + 出口 + setPieces + 传送门。
// 同 (dna.id, runSeed) 必须产出完全一致的 Level（可达性验证失败会用备用种子重试，最多 8 次，
// 备用种子序列本身也是确定的，因此最终结果依旧确定）。
//
// ── 连通性优先生成算法（可复用，未来 B/C 类层级沿用）──
// 1. 骨架全连通：hallwayGrid 模式用纵横走廊网格做骨架（无死角，天然全连通）；
//    常规模式用「房间 + L 形走廊 MST」连接全部房间。
// 2. 房间挂接：房间通过门（'D'，可通行）挂到骨架上；门按概率散布（氛围），
//    并有「每区块 ≥1 门」的保底修复，防止整块无门。
// 3. 容差校验：生成后做 BFS 可达性验证（出口必须可达；连通率目标 ≥98%，
//    游戏内环绕视角 100%）。校验失败用备用种子重试。
// 4. 确定性纪律：所有随机来自 mulberry32(seed)，绝不使用 Math.random。`

import { mulberry32, hashString, randInt, pick, chance } from './rng.js';
import { ENTITY_DEFS } from './entities.js';

/** 可行走瓦片集合（'T' 为传送门瓦片，属额外扩展字符） */
export const WALKABLE_TILES = new Set(['.', '~', 'D', 'S', 'E', 'I', 'T']);
export const FLOOR_TILES = new Set(['.', '~', 'D', 'S', 'I', 'T']);

const DIRS4 = [
  { dx: 0, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 0 },
];

function mod(n, m) {
  return ((n % m) + m) % m;
}

/** 主入口：确定性生成一个层级（terrain.infinite → 无限分块世界） */
export function generateLevel(dna, runSeed) {
  if (dna.terrain && dna.terrain.infinite) return createInfiniteLevel(dna, runSeed);
  const base = String(runSeed);
  let last = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    // 备用种子序列确定：seed + id + attempt
    const rng = mulberry32(hashString(`${base}|${dna.id}|${attempt}`));
    const level = buildLevel(dna, rng);
    last = level;
    if (verifyReachable(level)) return level;
  }
  return last;
}

/** 经典 Level 0 走廊网格：纵横贯通的走廊 + 5×5 房间 + 门。
 *  走廊形成完整网格（配合 looping 环绕 = 无尽联通、无死角），
 *  门开在"一侧邻走廊、另一侧邻房间"的墙上（含环绕边界墙，全连通），
 *  玩家永远不会被困。 */
function buildHallwayGrid(tiles, W, H, rng, props) {
  const stride = 8;
  const isCorridor = (x, y) => x % stride === 4 || y % stride === 4;
  const isWall = (x, y) => {
    const xm = x % stride;
    const ym = y % stride;
    return (xm === 3 || xm === 5 || ym === 3 || ym === 5) && !isCorridor(x, y);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isCorridor(x, y)) tiles[y][x] = '.';
      else if (isWall(x, y)) tiles[y][x] = '#';
      else tiles[y][x] = '.';
    }
  }
  // 门：通用扫描 —— 墙瓦片若一侧邻走廊、另一侧邻房间，则按概率打通（'D' 可通行）。
  // 这种方式天然覆盖环绕边界墙（x=3/y=3 列行），保证房间与走廊全连通、无死角。
  const isRoomTile = (t) => t === '.' || t === '~';
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (tiles[y][x] !== '#') continue;
      let hasCorridor = false;
      let hasRoom = false;
      const nb = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (isCorridor(nx, ny) && tiles[ny][nx] !== '#') hasCorridor = true;
        else if (isRoomTile(tiles[ny][nx])) hasRoom = true;
      }
      if (hasCorridor && hasRoom && chance(rng, 0.24)) {
        tiles[y][x] = 'D';
        props.push({ x, y, kind: 'door' });
      }
    }
  }
  // 保障修复：每个区块（5×5 房间）至少 1 扇门 —— 防止整块无门导致玩家被困。
  // 确定性：不消耗 rng，按固定顺序找第一面合法墙强制打通。
  for (let by = 0; by < Math.floor(H / stride); by++) {
    for (let bx = 0; bx < Math.floor(W / stride); bx++) {
      const roomCols = [bx * stride + 6, bx * stride + 7, bx * stride + 9, bx * stride + 10];
      const roomRows = [by * stride + 6, by * stride + 7, by * stride + 9, by * stride + 10];
      const wallTiles = [];
      // 水平墙：y = by*stride+5 / +11，x 取房间列
      for (const wy of [by * stride + 5, by * stride + 11]) for (const wx of roomCols) wallTiles.push([wx, wy]);
      // 垂直墙：x = bx*stride+5 / +11，y 取房间行
      for (const wx of [bx * stride + 5, bx * stride + 11]) for (const wy of roomRows) wallTiles.push([wx, wy]);
      const hasDoor = wallTiles.some(
        ([x, y]) => y >= 1 && y < H - 1 && x >= 1 && x < W - 1 && tiles[y][x] === 'D'
      );
      if (hasDoor) continue;
      for (const [x, y] of wallTiles) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        if (tiles[y][x] !== '#') continue;
        let c = false;
        let r = false;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (isCorridor(nx, ny) && tiles[ny][nx] !== '#') c = true;
          else if (isRoomTile(tiles[ny][nx])) r = true;
        }
        if (c && r) {
          tiles[y][x] = 'D';
          props.push({ x, y, kind: 'door' });
          break;
        }
      }
    }
  }
}

/** 城市街区拓扑（Level 11 无尽城市）：宽街道网格 + 街区建筑，完全不同于房间迷宫 */
function buildCityGrid(tiles, W, H, rng, props, rooms) {
  const stride = 12; // 街道间距（W/H 需为 12 的倍数）
  const streetW = 3;
  const isStreet = (x, y) => x % stride < streetW || y % stride < streetW;
  // 1) 街道网格全打通
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isStreet(x, y)) tiles[y][x] = '.';
    }
  }
  // 2) 街区 = 建筑（外墙 1 格 + 内部），每面街道开 1-2 个店门
  for (let by = 0; by < Math.floor(H / stride); by++) {
    for (let bx = 0; bx < Math.floor(W / stride); bx++) {
      const x0 = bx * stride + streetW;
      const y0 = by * stride + streetW;
      const x1 = Math.min(bx * stride + stride - 1, W - 1);
      const y1 = Math.min(by * stride + stride - 1, H - 1);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const edge = x === x0 || x === x1 || y === y0 || y === y1;
          tiles[y][x] = edge ? '#' : '.';
        }
      }
      rooms.push({ x: x0 + 1, y: y0 + 1, w: x1 - x0 - 1, h: y1 - y0 - 1 });
      const doorCount = randInt(rng, 1, 2);
      for (let i = 0; i < doorCount; i++) {
        const side = pick(rng, ['top', 'bottom', 'left', 'right']);
        let dx, dy;
        if (side === 'top') { dx = randInt(rng, x0 + 1, x1 - 1); dy = y0; }
        else if (side === 'bottom') { dx = randInt(rng, x0 + 1, x1 - 1); dy = y1; }
        else if (side === 'left') { dx = x0; dy = randInt(rng, y0 + 1, y1 - 1); }
        else { dx = x1; dy = randInt(rng, y0 + 1, y1 - 1); }
        if (tiles[dy][dx] === '#') {
          tiles[dy][dx] = 'D';
          props.push({ x: dx, y: dy, kind: 'door' });
        }
      }
    }
  }
}

/** 跑道拓扑（Level !）：一条笔直的长走廊，两侧是带门的房间（F 版"两侧有门的跑道"） */
function buildRacetrack(tiles, W, H, rng, props, rooms) {
  const mid = Math.floor(H / 2);
  // 1) 中央跑道（宽 3），从西到东全打通
  for (let y = mid - 1; y <= mid + 1; y++) {
    for (let x = 0; x < W; x++) tiles[y][x] = '.';
  }
  // 2) 两侧房间带：每 6 格一个 3×3 房间，开一扇门朝向跑道
  for (let x = 0; x + 2 < W; x += 6) {
    for (const [ry0, dir] of [[0, 1], [H - 3, -1]]) {
      for (let yy = ry0; yy < ry0 + 3; yy++) {
        for (let xx = x; xx < x + 3; xx++) tiles[yy][xx] = '.';
      }
      rooms.push({ x, y: ry0, w: 3, h: 3 });
      const doorY = dir === 1 ? ry0 + 3 : ry0 - 1;
      const dx = x + randInt(rng, 0, 2);
      if (doorY >= 0 && doorY < H && tiles[doorY][dx] === '#') {
        tiles[doorY][dx] = 'D';
        props.push({ x: dx, y: doorY, kind: 'door' });
        // 门廊：打通门与中央跑道之间的间隔行（门必须真正通向走廊）
        const aisleY = dir === 1 ? doorY + 1 : doorY - 1;
        if (aisleY >= 0 && aisleY < H && tiles[aisleY][dx] === '#') tiles[aisleY][dx] = '.';
      }
    }
  }
}

/** 洞穴拓扑（Level 8）：随机游走隧道 + 洞穴室，完全非规则的天然拓扑 */
function buildCaves(tiles, W, H, rng, props, rooms) {
  const carve = (px, py, r) => {
    for (let yy = py - r; yy <= py + r; yy++) {
      for (let xx = px - r; xx <= px + r; xx++) {
        if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) continue;
        if ((xx - px) ** 2 + (yy - py) ** 2 <= r * r) tiles[yy][xx] = '.';
      }
    }
  };
  let x = Math.floor(W / 2);
  let y = Math.floor(H / 2);
  carve(x, y, randInt(rng, 2, 4));
  rooms.push({ x: x - 3, y: y - 3, w: 6, h: 6 });
  const steps = Math.floor((W * H) / 40);
  for (let i = 0; i < steps; i++) {
    const dir = DIRS4[randInt(rng, 0, 3)];
    const len = randInt(rng, 1, 3);
    for (let s = 0; s < len; s++) {
      x = Math.max(1, Math.min(W - 2, x + dir.dx));
      y = Math.max(1, Math.min(H - 2, y + dir.dy));
      tiles[y][x] = '.';
      if (rng() < 0.12) carve(x, y, randInt(rng, 1, 3));
    }
  }
}

/** 仓库大厅拓扑（Level 1 宜居地带）：开阔大厅 + 柱列 + 边缘房间，F 版"巨大仓库式空间" */
function buildWarehouse(tiles, W, H, rng, props, rooms) {
  // 中央大厅全打通
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) tiles[y][x] = '.';
  }
  // 混凝土柱列：每 5 格一柱
  for (let y = 4; y < H - 1; y += 5) {
    for (let x = 4; x < W - 1; x += 5) tiles[y][x] = '#';
  }
  // 边缘小房间带（办公室/隔间），面向大厅开门
  for (let y = 1; y < H - 3; y += 4) {
    for (const sx of [0, W - 5]) {
      for (let yy = y; yy < y + 3; yy++) {
        for (let xx = sx; xx < sx + 3; xx++) {
          if (xx >= 1 && yy >= 1 && xx < W - 1 && yy < H - 1) tiles[yy][xx] = '.';
        }
      }
      rooms.push({ x: sx + 1, y: y + 1, w: 3, h: 3 });
      // 门朝大厅
      const doorX = sx === 0 ? 4 : W - 5;
      if (tiles[y + 1][doorX] === '#') {
        tiles[y + 1][doorX] = 'D';
        props.push({ x: doorX, y: y + 1, kind: 'door' });
      }
    }
  }
  rooms.push({ x: 5, y: 5, w: W - 10, h: H - 10 });
}

/** 旅馆拓扑（Level 5 恐怖旅馆）：窄走廊网格 + 走廊两侧的 3×3 房间，门口遍布（F 版红地毯走廊+无数房门） */
function buildHotel(tiles, W, H, rng, props, rooms) {
  const stride = 6;
  const isCorridor = (x, y) => x % stride === 2 || y % stride === 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      tiles[y][x] = isCorridor(x, y) ? '.' : '#';
    }
  }
  // 房间：x%6∈{3,4,5} 且 y%6∈{3,4,5} 的 3×3 块，紧邻走廊开口
  for (let by = 0; by < Math.floor(H / stride); by++) {
    for (let bx = 0; bx < Math.floor(W / stride); bx++) {
      const x0 = bx * stride + 3;
      const y0 = by * stride + 3;
      for (let yy = y0; yy < y0 + 3; yy++) {
        for (let xx = x0; xx < x0 + 3; xx++) tiles[yy][xx] = '.';
      }
      rooms.push({ x: x0, y: y0, w: 3, h: 3 });
      // 门口（房间与走廊交界）：每面 1 扇 D（可走通道标记）
      const doors = [
        [x0, y0, 'top'],
        [x0, y0 + 2, 'bottom'],
        [x0, y0, 'left'],
        [x0 + 2, y0, 'right'],
      ];
      for (const [dx, dy] of [[x0, y0], [x0, y0 + 2], [x0, y0], [x0 + 2, y0]]) {
        if (chance(rng, 0.7)) {
          if (tiles[dy][dx] === '.') {
            tiles[dy][dx] = 'D';
            props.push({ x: dx, y: dy, kind: 'door' });
          }
        }
      }
    }
  }
}

/** 田野/开阔地拓扑（Level 10 田野、Level 14 天堂）：开阔地面 + 随机障碍簇 + 稀疏建筑 */
function buildFields(tiles, W, H, rng, props, rooms) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) tiles[y][x] = '.';
  }
  // 障碍簇（树丛/石堆/草垛）：随机圆块
  const n = randInt(rng, 8, 16);
  for (let i = 0; i < n; i++) {
    const cx = randInt(rng, 3, W - 4);
    const cy = randInt(rng, 3, H - 4);
    const r = randInt(rng, 2, 4);
    for (let yy = cy - r; yy <= cy + r; yy++) {
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx >= 1 && yy >= 1 && xx < W - 1 && yy < H - 1 && (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) {
          tiles[yy][xx] = '#';
        }
      }
    }
  }
  // 稀疏建筑（农舍/小屋）
  const houses = randInt(rng, 3, 5);
  for (let i = 0; i < houses; i++) {
    const hx = randInt(rng, 2, W - 6);
    const hy = randInt(rng, 2, H - 6);
    for (let yy = hy; yy < hy + 4; yy++) {
      for (let xx = hx; xx < hx + 4; xx++) {
        if (xx >= 1 && yy >= 1 && xx < W - 1 && yy < H - 1) tiles[yy][xx] = '.';
      }
    }
    rooms.push({ x: hx + 1, y: hy + 1, w: 2, h: 2 });
  }
}

/** 生成单次布局（内部函数，调用方负责可达性验证） */
function buildLevel(dna, rng) {
  const T = dna.terrain;
  const W = T.width;
  const H = T.height;
  const env = dna.environment || 'corridors';
  const isOutdoors = env === 'outdoors';
  const isAquatic = env === 'aquatic';
  const isVoid = env === 'void';
  const looping = dna.spaceRules.includes('looping');

  const tiles = Array.from({ length: H }, () => Array(W).fill('#'));
  const rooms = [];
  const portals = [];
  const exits = [];
  const entities = [];
  const itemList = [];
  const setPieces = [];
  const occupied = new Set(); // "x,y" —— 出生点/出口/传送门/实体/物品占用的瓦片
  const props = []; // {x, y, kind} —— 道具记录（供 web 端矢量绘制与门通道）

  // ---------- 1. 布局模式（拓扑由 DNA terrain.topology 指定，F 版层级各具形态） ----------
  // 拓扑：rooms（房间迷宫，默认）/ hallway-grid / city-grid（城市街区）/ racetrack（跑道）/ caves（洞穴隧道）
  const topology = T.topology || (env === 'caves' ? 'caves' : T.hallwayGrid ? 'hallway-grid' : 'rooms');
  if (topology === 'hallway-grid') {
    buildHallwayGrid(tiles, W, H, rng, props);
  } else if (topology === 'city-grid') {
    buildCityGrid(tiles, W, H, rng, props, rooms);
  } else if (topology === 'racetrack') {
    buildRacetrack(tiles, W, H, rng, props, rooms);
  } else if (topology === 'warehouse') {
    buildWarehouse(tiles, W, H, rng, props, rooms);
  } else if (topology === 'hotel') {
    buildHotel(tiles, W, H, rng, props, rooms);
  } else if (topology === 'fields') {
    buildFields(tiles, W, H, rng, props, rooms);
  } else if (topology === 'caves') {
    buildCaves(tiles, W, H, rng, props, rooms);
  } else {
    // 常规模式：房间矩形（不重叠）+ L 形走廊连接全部房间（保证全连通）
    const roomCount = T.roomCount;
    for (let i = 0; i < roomCount; i++) {
      const rw = randInt(rng, T.roomSizeMin, T.roomSizeMax);
      const rh = randInt(rng, T.roomSizeMin, T.roomSizeMax);
      for (let t = 0; t < 50; t++) {
        const x = randInt(rng, 1, Math.max(1, W - rw - 2));
        const y = randInt(rng, 1, Math.max(1, H - rh - 2));
        if (!overlaps(rooms, x, y, rw, rh)) {
          rooms.push({ x, y, w: rw, h: rh });
          carveRoom(tiles, x, y, rw, rh);
          break;
        }
      }
    }
    if (rooms.length === 0) {
      // 极端情况兜底：放一个居中的房间
      const rw = Math.min(8, W - 2);
      const rh = Math.min(8, H - 2);
      rooms.push({ x: Math.floor((W - rw) / 2), y: Math.floor((H - rh) / 2), w: rw, h: rh });
      carveRoom(tiles, rooms[0].x, rooms[0].y, rw, rh);
    }

    // ---------- 2. L 形走廊连接全部房间（保证全连通） ----------
    const cw = T.corridorWidth || 2;
    const connected = [0];
    while (connected.length < rooms.length) {
      let best = -1;
      let bestFrom = -1;
      let bestDist = Infinity;
      for (const i of connected) {
        for (let j = 0; j < rooms.length; j++) {
          if (connected.includes(j)) continue;
          const d = roomDist(rooms[i], rooms[j]);
          if (d < bestDist) {
            bestDist = d;
            best = j;
            bestFrom = i;
          }
        }
      }
      if (best < 0) break;
      carveCorridor(tiles, rooms[bestFrom], rooms[best], rng, cw);
      connected.push(best);
    }
  }

  // ---------- 3. 环境覆盖层 ----------
  if (isAquatic) {
    // 水池：房间内部铺水瓦片池
    for (const room of rooms) {
      if (room.w >= 5 && room.h >= 5 && chance(rng, 0.75)) {
        const pw = randInt(rng, 2, room.w - 3);
        const ph = randInt(rng, 2, room.h - 3);
        const px = room.x + randInt(rng, 1, room.w - pw - 1);
        const py = room.y + randInt(rng, 1, room.h - ph - 1);
        for (let yy = py; yy < py + ph; yy++) {
          for (let xx = px; xx < px + pw; xx++) {
            tiles[yy][xx] = '~';
          }
        }
      }
    }
  }
  if (isVoid) {
    // 虚空：空旷为主，随机散布浮岛墙块
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (tiles[y][x] === '.' && chance(rng, 0.18)) tiles[y][x] = '#';
      }
    }
  }
  if (isOutdoors) {
    // 户外：街区网格——把部分走廊加宽成"街道"，并开一些窗口
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (tiles[y][x] === '.' && tiles[y][x - 1] === '.' && tiles[y][x + 1] === '.') {
          if (chance(rng, 0.1)) tiles[y][x] = '.'; // 轻微拓宽（视觉上的街道）
        }
      }
    }
  }

  // 地形附赠特性：柱子/水洼/门/楼梯/管道/电线/喷泉 + 道具记录（供 web 端矢量绘制）
  const extra = T.extraFeatures || [];

  if (extra.includes('columns')) {
    for (const room of rooms) {
      if (room.w >= 6 && room.h >= 6) {
        const n = randInt(rng, 2, 4);
        for (let i = 0; i < n; i++) {
          const cx = room.x + randInt(rng, 1, room.w - 2);
          const cy = room.y + randInt(rng, 1, room.h - 2);
          if (tiles[cy][cx] === '.' && !(cx === room.x + Math.floor(room.w / 2) && cy === room.y + Math.floor(room.h / 2))) {
            tiles[cy][cx] = '#';
            props.push({ x: cx, y: cy, kind: 'column' });
          }
        }
      }
    }
  }
  if (extra.includes('puddles') || isAquatic) {
    const n = randInt(rng, 3, 8);
    for (let i = 0; i < n; i++) {
      const x = randInt(rng, 1, W - 2);
      const y = randInt(rng, 1, H - 2);
      if (tiles[y][x] === '.') {
        tiles[y][x] = '~';
        props.push({ x, y, kind: 'puddle' });
      }
    }
  }
  // 门：仅室内层级（DNA 声明 doors）才有；户外层没有门（Level 11 城市等）
  if (extra.includes('doors')) {
    // 门 = 墙上的真实开口：一侧邻房间地板、另一侧邻可走区域（走廊/其他房间）的墙瓦片，
    // 打通为 'D'（可通行）。杜绝"门通向死缝"的假门。
    const roomSet = new Set();
    for (const room of rooms) {
      for (let y = room.y; y < room.y + room.h; y++) {
        for (let x = room.x; x < room.x + room.w; x++) roomSet.add(x + ',' + y);
      }
    }
    const isDoorSpot = (x, y) => {
      if (tiles[y][x] !== '#') return false;
      let inRoom = false;
      let outWalk = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const inside = roomSet.has(nx + ',' + ny);
        const walk = tiles[ny][nx] !== '#';
        if (inside && walk) inRoom = true;
        else if (!inside && walk) outWalk = true;
      }
      return inRoom && outWalk;
    };
    // 概率散布（氛围感：不是每面墙都开门）
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (isDoorSpot(x, y) && chance(rng, 0.3)) {
          tiles[y][x] = 'D';
          props.push({ x, y, kind: isOutdoors ? 'window' : 'door' });
        }
      }
    }
    // 每间房保底 1 扇门（确定性：固定顺序找第一处合法门位）
    for (const room of rooms) {
      const walls = [];
      for (let x = room.x - 1; x <= room.x + room.w; x++) {
        walls.push([x, room.y - 1]);
        walls.push([x, room.y + room.h]);
      }
      for (let y = room.y; y < room.y + room.h; y++) {
        walls.push([room.x - 1, y]);
        walls.push([room.x + room.w, y]);
      }
      const hasDoor = walls.some(
        ([x, y]) => x >= 1 && y >= 1 && x < W - 1 && y < H - 1 && tiles[y][x] === 'D'
      );
      if (hasDoor) continue;
      for (const [x, y] of walls) {
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        if (isDoorSpot(x, y)) {
          tiles[y][x] = 'D';
          props.push({ x, y, kind: isOutdoors ? 'window' : 'door' });
          break;
        }
      }
    }
  }
  if (extra.includes('stairwell') || extra.includes('elevator')) {
    const n = randInt(rng, 1, 3);
    const walkables = collectWalkable(tiles);
    for (let i = 0; i < n && walkables.length > 0; i++) {
      const p = pick(rng, walkables);
      if (tiles[p.y][p.x] === '.') {
        tiles[p.y][p.x] = 'S';
        props.push({ x: p.x, y: p.y, kind: chance(rng, 0.5) ? 'elevator' : 'stairwell' });
      }
    }
  }
  if (extra.includes('furniture') || extra.includes('shelves') || extra.includes('counters')) {
    const kinds = [];
    if (extra.includes('furniture')) kinds.push('furniture');
    if (extra.includes('shelves')) kinds.push('shelves');
    if (extra.includes('counters')) kinds.push('counters');
    for (const room of rooms) {
      if (room.w >= 5 && room.h >= 5 && chance(rng, 0.5)) {
        const n = randInt(rng, 1, 3);
        for (let i = 0; i < n; i++) {
          const cx = room.x + randInt(rng, 1, room.w - 2);
          const cy = room.y + randInt(rng, 1, room.h - 2);
          if (tiles[cy][cx] === '.') {
            tiles[cy][cx] = '#';
            props.push({ x: cx, y: cy, kind: pick(rng, kinds) });
          }
        }
      }
    }
  }
  // 精细道具：板条箱/文件堆/盆栽（房间内地面，不挡路）+ 海报（挂墙）
  if (extra.includes('crates') || extra.includes('papers') || extra.includes('plants') || extra.includes('posters')) {
    for (const room of rooms) {
      if (room.w < 4 || room.h < 4) continue;
      // 板条箱：1-3 个（仓库/商业层）
      if (extra.includes('crates') && chance(rng, 0.8)) {
        const n = randInt(rng, 1, 3);
        for (let i = 0; i < n; i++) {
          const cx = room.x + randInt(rng, 1, room.w - 2);
          const cy = room.y + randInt(rng, 1, room.h - 2);
          if (tiles[cy][cx] === '.') {
            tiles[cy][cx] = '#';
            props.push({ x: cx, y: cy, kind: 'crates' });
          }
        }
      }
      // 文件堆：1-2 个（办公层）
      if (extra.includes('papers') && chance(rng, 0.7)) {
        const n = randInt(rng, 1, 2);
        for (let i = 0; i < n; i++) {
          const cx = room.x + randInt(rng, 1, room.w - 2);
          const cy = room.y + randInt(rng, 1, room.h - 2);
          if (tiles[cy][cx] === '.') {
            tiles[cy][cx] = '#';
            props.push({ x: cx, y: cy, kind: 'papers' });
          }
        }
      }
      // 盆栽：0-1 个（宜居/公共层）
      if (extra.includes('plants') && chance(rng, 0.4)) {
        const cx = room.x + randInt(rng, 1, room.w - 2);
        const cy = room.y + randInt(rng, 1, room.h - 2);
        if (tiles[cy][cx] === '.') {
          tiles[cy][cx] = '#';
          props.push({ x: cx, y: cy, kind: 'plants' });
        }
      }
      // 海报：沿墙挂（墙瓦片，不挡路）
      if (extra.includes('posters')) {
        const n = randInt(rng, 1, 2);
        for (let i = 0; i < n; i++) {
          const edge = pick(rng, ['top', 'bottom', 'left', 'right']);
          let px, py;
          if (edge === 'top') { px = room.x + randInt(rng, 0, room.w - 1); py = room.y - 1; }
          else if (edge === 'bottom') { px = room.x + randInt(rng, 0, room.w - 1); py = room.y + room.h; }
          else if (edge === 'left') { px = room.x - 1; py = room.y + randInt(rng, 0, room.h - 1); }
          else { px = room.x + room.w; py = room.y + randInt(rng, 0, room.h - 1); }
          if (px >= 1 && py >= 1 && px < W - 1 && py < H - 1 && tiles[py][px] === '#') {
            props.push({ x: px, y: py, kind: 'posters' });
          }
        }
      }
    }
  }
  if (extra.includes('pipes')) {
    // 管道：沿墙绘制（记录靠走廊的墙瓦片）
    const n = randInt(rng, 4, 9);
    const wallTiles = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (tiles[y][x] !== '#') continue;
        const nearFloor =
          tiles[y - 1][x] !== '#' ||
          tiles[y + 1][x] !== '#' ||
          tiles[y][x - 1] !== '#' ||
          tiles[y][x + 1] !== '#';
        if (nearFloor) wallTiles.push({ x, y });
      }
    }
    const used = new Set();
    for (let i = 0; i < n && wallTiles.length > 0; i++) {
      const p = pick(rng, wallTiles);
      const k = p.x + ',' + p.y;
      if (used.has(k)) continue;
      used.add(k);
      props.push({ x: p.x, y: p.y, kind: 'pipes' });
    }
  }
  if (extra.includes('wires')) {
    const n = randInt(rng, 3, 7);
    const floors = collectWalkable(tiles);
    for (let i = 0; i < n && floors.length > 0; i++) {
      const p = pick(rng, floors);
      props.push({ x: p.x, y: p.y, kind: 'wires' });
    }
  }
  if (extra.includes('fountain')) {
    // 喷泉：最大房间中心附近
    let best = rooms[0];
    for (const r of rooms) if (r.w * r.h > best.w * best.h) best = r;
    const fx = best.x + Math.floor(best.w / 2);
    const fy = best.y + Math.floor(best.h / 2);
    const pos = tiles[fy] && tiles[fy][fx] === '.' ? { x: fx, y: fy } : nearestWalkable(tiles, fx, fy);
    props.push({ x: pos.x, y: pos.y, kind: 'fountain' });
  }

  if (looping) {
    // 环面层：让"从一边走出去、从另一边走进来"真的可行 ——
    // 保证至少一条"贯通行"（左右边界同时开口）与一条"贯通列"（上下边界同时开口），
    // 再随机开若干边界缺口。
    const yr = randInt(rng, 2, Math.max(2, H - 3));
    if (tiles[yr][0] === '#') tiles[yr][0] = '.';
    if (tiles[yr][W - 1] === '#') tiles[yr][W - 1] = '.';
    const xc = randInt(rng, 2, Math.max(2, W - 3));
    if (tiles[0][xc] === '#') tiles[0][xc] = '.';
    if (tiles[H - 1][xc] === '#') tiles[H - 1][xc] = '.';
    const extraOpen = randInt(rng, 4, 8);
    for (let i = 0; i < extraOpen; i++) {
      const edge = randInt(rng, 0, 3); // 0 上 / 1 下 / 2 左 / 3 右
      let ox, oy;
      if (edge === 0) {
        ox = randInt(rng, 1, W - 2);
        oy = 0;
      } else if (edge === 1) {
        ox = randInt(rng, 1, W - 2);
        oy = H - 1;
      } else if (edge === 2) {
        ox = 0;
        oy = randInt(rng, 1, H - 2);
      } else {
        ox = W - 1;
        oy = randInt(rng, 1, H - 2);
      }
      if (tiles[oy][ox] === '#') tiles[oy][ox] = '.';
    }
  }

  // ---------- 4. 出生点：第一间房间的中心（网格模式取地图中心最近的可行走格） ----------
  const r0 = rooms[0];
  let spawn;
  if (r0) {
    spawn = { x: r0.x + Math.floor(r0.w / 2), y: r0.y + Math.floor(r0.h / 2) };
  } else {
    spawn = { x: Math.floor(W / 2), y: Math.floor(H / 2) };
  }
  if (!WALKABLE_TILES.has(tiles[spawn.y][spawn.x])) {
    // 兜底：找最近的可行走格
    const p = nearestWalkable(tiles, spawn.x, spawn.y);
    spawn.x = p.x;
    spawn.y = p.y;
  }
  occupied.add(key(spawn.x, spawn.y));

  // ---------- 5. 传送门（non-euclidean 空间规则） ----------
  if (dna.spaceRules.includes('non-euclidean')) {
    const pairCount = randInt(rng, 2, 4);
    const walkables = collectWalkable(tiles).filter((p) => !occupied.has(key(p.x, p.y)));
    for (let i = 0; i < pairCount; i++) {
      let a = null;
      let b = null;
      for (let t = 0; t < 60; t++) {
        const ca = pick(rng, walkables);
        const cb = pick(rng, walkables);
        if (ca === cb) continue;
        if (occupied.has(key(ca.x, ca.y)) || occupied.has(key(cb.x, cb.y))) continue;
        const d = Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
        if (d < Math.max(8, Math.floor((W + H) / 4))) continue;
        a = ca;
        b = cb;
        break;
      }
      if (a) {
        tiles[a.y][a.x] = 'T';
        tiles[b.y][b.x] = 'T';
        occupied.add(key(a.x, a.y));
        occupied.add(key(b.x, b.y));
        portals.push([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
      }
    }
  }

  // ---------- 5.5 连通性清理（可复用算法的第 5 步） ----------
  // 从出生点 BFS（looping 层级按环绕移动），把任何不可达的孤立可行走格还原为墙，
  // 保证"玩家永远不会被困在无法返回的死格"；确定性、适用于所有生成模式。
  {
    const wrap = dna.spaceRules.includes('looping');
    const seen = new Set([key(spawn.x, spawn.y)]);
    const q = [[spawn.x, spawn.y]];
    while (q.length) {
      const [cx, cy] = q.pop();
      for (const d of DIRS4) {
        const nx = wrap ? mod(cx + d.dx, W) : cx + d.dx;
        const ny = wrap ? mod(cy + d.dy, H) : cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        if (!WALKABLE_TILES.has(tiles[ny][nx])) continue;
        seen.add(k);
        q.push([nx, ny]);
      }
    }
    const removed = new Set();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (WALKABLE_TILES.has(tiles[y][x]) && !seen.has(key(x, y))) {
          tiles[y][x] = '#';
          removed.add(key(x, y));
        }
      }
    }
    if (removed.size > 0) {
      // 同步清理落在孤立格上的道具与失效的传送门对
      for (let i = props.length - 1; i >= 0; i--) {
        if (removed.has(key(props[i].x, props[i].y))) props.splice(i, 1);
      }
      for (let i = portals.length - 1; i >= 0; i--) {
        const [a, b] = portals[i];
        if (removed.has(key(a.x, a.y)) || removed.has(key(b.x, b.y))) portals.splice(i, 1);
      }
    }
    // looping 层保证至少一条"接缝通道"：某列上下边界同时开口、某行左右边界同时开口
    // （无尽环绕感：走任意方向跨过边界后仍能继续前进；确定性，不消耗 rng）
    if (wrap) {
      let seamX = -1;
      for (let x = 0; x < W; x++) {
        if (tiles[0][x] !== '#' && tiles[H - 1][x] !== '#') { seamX = x; break; }
      }
      if (seamX < 0) {
        for (let x = 0; x < W; x++) {
          if (tiles[0][x] !== '#' && tiles[H - 2][x] !== '#') { seamX = x; tiles[H - 1][x] = '.'; break; }
        }
      }
      if (seamX < 0) {
        for (let x = 0; x < W; x++) {
          if (tiles[H - 1][x] !== '#' && tiles[1][x] !== '#') { seamX = x; tiles[0][x] = '.'; break; }
        }
      }
      if (seamX < 0) {
        // 终极兜底：找每列最靠近顶/底的可行走格，把中间的墙打通成接缝通道
        // （房间不会触及 y=0/H-1，故必须显式开辟）
        for (let x = 0; x < W && seamX < 0; x++) {
          let topY = -1;
          let botY = -1;
          for (let y = 0; y < H; y++) {
            if (tiles[y][x] !== '#') { topY = y; break; }
          }
          for (let y = H - 1; y >= 0; y--) {
            if (tiles[y][x] !== '#') { botY = y; break; }
          }
          if (topY >= 0 || botY >= 0) {
            seamX = x;
            if (topY >= 0) for (let yy = 0; yy < topY; yy++) tiles[yy][x] = '.';
            if (botY >= 0) for (let yy = botY + 1; yy < H; yy++) tiles[yy][x] = '.';
          }
        }
      }
      let seamY = -1;
      for (let y = 0; y < H; y++) {
        if (tiles[y][0] !== '#' && tiles[y][W - 1] !== '#') { seamY = y; break; }
      }
      if (seamY < 0) {
        for (let y = 0; y < H; y++) {
          if (tiles[y][0] !== '#' && tiles[y][W - 2] !== '#') { seamY = y; tiles[y][W - 1] = '.'; break; }
        }
      }
      if (seamY < 0) {
        for (let y = 0; y < H; y++) {
          if (tiles[y][W - 1] !== '#' && tiles[y][1] !== '#') { seamY = y; tiles[y][0] = '.'; break; }
        }
      }
      if (seamY < 0) {
        // 终极兜底：找每行最靠近左/右的可行走格，把中间的墙打通成接缝通道
        for (let y = 0; y < H && seamY < 0; y++) {
          let leftX = -1;
          let rightX = -1;
          for (let x = 0; x < W; x++) {
            if (tiles[y][x] !== '#') { leftX = x; break; }
          }
          for (let x = W - 1; x >= 0; x--) {
            if (tiles[y][x] !== '#') { rightX = x; break; }
          }
          if (leftX >= 0 || rightX >= 0) {
            seamY = y;
            if (leftX >= 0) for (let xx = 0; xx < leftX; xx++) tiles[y][xx] = '.';
            if (rightX >= 0) for (let xx = rightX + 1; xx < W; xx++) tiles[y][xx] = '.';
          }
        }
      }
      // 接缝格标记为占用：实体/出口不再落座，保证接缝永远可通行
      if (seamX >= 0) {
        occupied.add(key(seamX, 0));
        occupied.add(key(seamX, H - 1));
      }
      if (seamY >= 0) {
        occupied.add(key(0, seamY));
        occupied.add(key(W - 1, seamY));
      }
    }
  }

  // ---------- 6. 出口：每个 DNA exit → 一个 E 瓦片 ----------
  const walkablesNow = collectWalkable(tiles).filter((p) => !occupied.has(key(p.x, p.y)));
  for (const ex of dna.exits) {
    const kind = ex.kind || 'noclip';
    let pos = null;
    if (kind === 'button') {
      // 红色按钮类出口：放到最接近地图中心的可行走格
      pos = nearestWalkable(tiles, Math.floor(W / 2), Math.floor(H / 2));
      if (occupied.has(key(pos.x, pos.y))) {
        pos = findFreeNear(tiles, occupied, pos.x, pos.y);
      }
    } else {
      // 隐藏出口放远一些（≥8 格），普通出口 ≥6 格
      const minDist = ex.hidden ? 8 : 6;
      for (let t = 0; t < 60; t++) {
        const c = pick(rng, walkablesNow);
        if (occupied.has(key(c.x, c.y))) continue;
        const d = Math.abs(c.x - spawn.x) + Math.abs(c.y - spawn.y);
        if (d < minDist) continue;
        pos = c;
        break;
      }
      if (!pos) pos = pick(rng, walkablesNow);
    }
    if (!pos) pos = findFreeNear(tiles, occupied, spawn.x, spawn.y);
    if (tiles[pos.y][pos.x] === '#') tiles[pos.y][pos.x] = '.';
    tiles[pos.y][pos.x] = 'E';
    // 出口覆盖了原瓦片（如门/水洼）→ 移除同格道具，保持瓦片与道具数据一致
    for (let i = props.length - 1; i >= 0; i--) {
      if (props[i].x === pos.x && props[i].y === pos.y) props.splice(i, 1);
    }
    occupied.add(key(pos.x, pos.y));
    exits.push({
      x: pos.x,
      y: pos.y,
      target: ex.target,
      kind,
      hidden: !!ex.hidden,
      danger: !!ex.danger,
      description: ex.description || '',
    });
  }

  // ---------- 7. 实体：按 density × 可行走格数放置，至少 1 只（密度>0 时） ----------
  const spawnDist = looping ? 6 : 6;
  for (const spec of dna.entities) {
    if (!spec || !spec.density || spec.density <= 0) continue;
    const def = ENTITY_DEFS[spec.type];
    if (!def) continue;
    const count = Math.max(1, Math.floor(spec.density * collectWalkable(tiles).length));
    let placed = 0;
    for (let i = 0; i < count * 3 && placed < count; i++) {
      const c = placeAway(rng, tiles, occupied, spawn, spawnDist);
      if (!c) break;
      occupied.add(key(c.x, c.y));
      const stealthy = spec.type === 'skin-stealer' || spec.type === 'scratcher';
      entities.push({
        x: c.x,
        y: c.y,
        type: spec.type,
        aggression: spec.aggression || 'curious',
        hp: def.hp,
        state: 'idle',
        visible: !stealthy,
        alert: false,
        wait: randInt(rng, 0, 3),
        revealed: false,
      });
      placed++;
    }
  }

  // ---------- 8. 物品：itemDensity × 可行走格数 ----------
  if (dna.itemDensity > 0 && dna.items.length > 0) {
    const count = Math.max(1, Math.floor(dna.itemDensity * collectWalkable(tiles).length));
    for (let i = 0; i < count; i++) {
      const c = pick(rng, walkablesNow);
      if (!c || occupied.has(key(c.x, c.y))) continue;
      occupied.add(key(c.x, c.y));
      itemList.push({ x: c.x, y: c.y, type: pick(rng, dna.items) });
    }
  }

  // ---------- 9. setPieces：center / random / far-corner ----------
  for (const sp of dna.setPieces) {
    if (!sp || !sp.type) continue;
    let pos = null;
    if (sp.position === 'center') {
      pos = nearestWalkable(tiles, Math.floor(W / 2), Math.floor(H / 2));
    } else if (sp.position === 'far-corner') {
      const corner = pick(rng, [
        [1, 1],
        [W - 2, 1],
        [1, H - 2],
        [W - 2, H - 2],
      ]);
      pos = nearestWalkable(tiles, corner[0], corner[1]);
    } else {
      pos = pick(rng, walkablesNow) || nearestWalkable(tiles, spawn.x, spawn.y);
    }
    if (!pos) continue;
    setPieces.push({
      x: pos.x,
      y: pos.y,
      type: sp.type,
      text: sp.text || '',
      sanityEffect: sp.sanityEffect || 0,
      note: sp.note || '',
    });
  }

  // ---------- 10. 门配对（同层非欧传送） ----------
  // 门的定位：室内迷宫类层级（rooms / hallway-grid）内通往"另一间房"的通道——
  // 配对后穿过门 = 传送到配对的另一扇门（非欧特性，排序配对保证相距很远）。
  // 城市（city-grid）/跑道（racetrack）/洞穴（caves）的门是普通通道（走进去即可，不传送）。
  const doorLinks = [];
  {
    const teleportTopology = topology === 'rooms' || topology === 'hallway-grid';
    const doorProps = teleportTopology ? props.filter((p) => p.kind === 'door') : [];
    if (doorProps.length >= 2) {
      const sorted = doorProps.slice().sort((a, b) => a.y * W + a.x - (b.y * W + b.x));
      const half = Math.floor(sorted.length / 2);
      for (let i = 0; i < half; i++) {
        const a = sorted[i];
        const b = sorted[i + half];
        const locked = chance(rng, 0.15);
        doorLinks.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, locked });
      }
    }
  }

  return {
    id: dna.id,
    name: dna.name,
    number: dna.number,
    category: dna.category,
    difficultyClass: dna.difficultyClass,
    environment: env,
    aesthetic: dna.aesthetic,
    description: dna.description,
    terrain: dna.terrain,
    width: W,
    height: H,
    tiles,
    spawn,
    exits,
    entities,
    items: itemList,
    setPieces,
    props,
    portals,
    rooms,
    doorLinks,
    palette: dna.palette,
    light: dna.light,
    spaceRules: dna.spaceRules,
    sanDrain: dna.sanDrain,
    soundscape: dna.soundscape,
  };
}

// ---------- 几何工具 ----------

function key(x, y) {
  return x + ',' + y;
}

function overlaps(rooms, x, y, w, h) {
  for (const r of rooms) {
    if (x <= r.x + r.w && x + w >= r.x && y <= r.y + r.h && y + h >= r.y) return true;
  }
  return false;
}

function carveRoom(tiles, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      tiles[yy][xx] = '.';
    }
  }
}

function roomDist(a, b) {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function carveCorridor(tiles, a, b, rng, width) {
  const ax = a.x + Math.floor(a.w / 2);
  const ay = a.y + Math.floor(a.h / 2);
  const bx = b.x + Math.floor(b.w / 2);
  const by = b.y + Math.floor(b.h / 2);
  const horizontalFirst = chance(rng, 0.5);
  if (horizontalFirst) {
    carveLine(tiles, ax, ay, bx, ay, width);
    carveLine(tiles, bx, ay, bx, by, width);
  } else {
    carveLine(tiles, ax, ay, ax, by, width);
    carveLine(tiles, ax, by, bx, by, width);
  }
}

function carveLine(tiles, x1, y1, x2, y2, width) {
  const w = Math.max(1, width);
  const H = tiles.length;
  const W = tiles[0].length;
  const step = w % 2 === 0 ? w / 2 : Math.floor(w / 2);
  if (x1 === x2) {
    const y0 = Math.min(y1, y2);
    const y1b = Math.max(y1, y2);
    for (let y = y0; y <= y1b; y++) {
      for (let o = -step; o <= step; o++) {
        const xx = x1 + o;
        if (xx >= 0 && xx < W && y >= 0 && y < H) tiles[y][xx] = '.';
      }
    }
  } else {
    const x0 = Math.min(x1, x2);
    const x1b = Math.max(x1, x2);
    for (let x = x0; x <= x1b; x++) {
      for (let o = -step; o <= step; o++) {
        const yy = y1 + o;
        if (yy >= 0 && yy < H && x >= 0 && x < W) tiles[yy][x] = '.';
      }
    }
  }
}

function collectWalkable(tiles) {
  const out = [];
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[y].length; x++) {
      if (WALKABLE_TILES.has(tiles[y][x])) out.push({ x, y });
    }
  }
  return out;
}

/** 最近可行走格（用于 center/far-corner 定位） */
function nearestWalkable(tiles, tx, ty) {
  let best = null;
  let bestD = Infinity;
  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[y].length; x++) {
      if (!WALKABLE_TILES.has(tiles[y][x])) continue;
      const d = Math.abs(x - tx) + Math.abs(y - ty);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best || { x: 1, y: 1 };
}

/** 距离出生点尽量远的可行走格（带重试） */
function placeAway(rng, tiles, occupied, spawn, minDist) {
  const walkables = collectWalkable(tiles).filter((p) => !occupied.has(key(p.x, p.y)));
  if (walkables.length === 0) return null;
  for (let t = 0; t < 30; t++) {
    const c = pick(rng, walkables);
    const d = Math.abs(c.x - spawn.x) + Math.abs(c.y - spawn.y);
    if (d >= minDist) return c;
  }
  return pick(rng, walkables);
}

/** 从某点附近找一个未占用的可行走格（按钮出口兜底） */
function findFreeNear(tiles, occupied, x, y) {
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || ny >= tiles.length || nx >= tiles[0].length) continue;
        if (occupied.has(key(nx, ny))) continue;
        if (WALKABLE_TILES.has(tiles[ny][nx])) return { x: nx, y: ny };
      }
    }
  }
  return { x: 1, y: 1 };
}

/** 可达性验证：出生点 BFS 可达所有出口（looping 层按环面处理；无限层限深验证） */
export function verifyReachable(level) {
  if (level.infinite) {
    // 无限层：出口都在出生点附近（8-24 格），80 步 BFS 足够验证
    if (!WALKABLE_TILES.has(tileAt(level, level.spawn.x, level.spawn.y))) return false;
    const exitKeys = new Set((level.exits || []).map((e) => key(e.x, e.y)));
    if (exitKeys.size === 0) return true;
    const seen = new Set([key(level.spawn.x, level.spawn.y)]);
    const queue = [[level.spawn.x, level.spawn.y, 0]];
    let head = 0;
    while (head < queue.length) {
      const [x, y, d] = queue[head++];
      if (d >= 80) continue;
      for (const dd of DIRS4) {
        const nx = x + dd.dx;
        const ny = y + dd.dy;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        if (tileAt(level, nx, ny) === '#') continue;
        seen.add(k);
        queue.push([nx, ny, d + 1]);
      }
    }
    return [...exitKeys].every((k) => seen.has(k));
  }
  const { tiles, width: W, height: H, spawn, exits } = level;
  if (!WALKABLE_TILES.has(tiles[spawn.y][spawn.x])) return false;
  const looping = level.spaceRules.includes('looping');
  const seen = new Set([key(spawn.x, spawn.y)]);
  const queue = [[spawn.x, spawn.y]];
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    for (const d of DIRS4) {
      let nx = x + d.dx;
      let ny = y + d.dy;
      if (looping) {
        nx = mod(nx, W);
        ny = mod(ny, H);
      } else if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
        continue;
      }
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      const t = tiles[ny][nx];
      if (t === '#') continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  if (exits.length === 0) return seen.size > 1;
  return exits.every((e) => seen.has(key(e.x, e.y)));
}

// ================= 无限世界（Minecraft 式分块生成） =================
// 原理：整个世界按 16×16 的 chunk 分块，chunk 内容由 (cx,cy) 的确定性种子生成，
// 玩家走到哪里就生成到哪里（getTile 惰性生成并缓存）——"无边界"层级没有地图
// 边缘，任何方向都能永远走下去。网格类拓扑（走廊网格/城市/旅馆/仓库）用全局
// 坐标公式，chunk 边界自然对齐无缝；迷宫/洞穴类用固定边缘端口保证相邻 chunk
// 互相连通。有限层级越界一律视为墙（tileAt），绝不出现"走到地图外的虚空"。

export const CHUNK = 16;

const posmod = (n, m) => ((n % m) + m) % m;

/** 统一取瓦片：无限层惰性生成；有限层越界视为墙（墙而非虚空边界） */
export function tileAt(level, x, y) {
  if (level.infinite) return level.getTile(x, y);
  if (x < 0 || y < 0 || x >= level.width || y >= level.height) return '#';
  return level.tiles[y][x];
}

function chunkRng(dna, runSeed, cx, cy) {
  return mulberry32(hashString(`${runSeed}|${dna.id}|chunk:${cx},${cy}`));
}

/** 8 个边缘端口（chunk 局部坐标）：每边 2 个，宽 2 格深 2 格，跨 chunk 对齐 */
const EDGE_PORTS = [
  { x: 4, y: 0 }, { x: 11, y: 0 },
  { x: 4, y: 15 }, { x: 11, y: 15 },
  { x: 0, y: 4 }, { x: 0, y: 11 },
  { x: 15, y: 4 }, { x: 15, y: 11 },
];

function carvePorts(tiles) {
  for (const p of EDGE_PORTS) {
    const dx = p.x === 0 ? 1 : p.x === 15 ? -1 : 0;
    const dy = p.y === 0 ? 1 : p.y === 15 ? -1 : 0;
    tiles[p.y][p.x] = '.';
    tiles[p.y + dy][p.x + dx] = '.';
  }
}

function portInner(p) {
  return {
    x: p.x + (p.x === 0 ? 1 : p.x === 15 ? -1 : 0),
    y: p.y + (p.y === 0 ? 1 : p.y === 15 ? -1 : 0),
  };
}

/** 两点间 L 形走廊（先横后纵） */
function carveL(tiles, a, b) {
  if (a.x <= b.x) for (let x = a.x; x <= b.x; x++) tiles[a.y][x] = '.';
  else for (let x = b.x; x <= a.x; x++) tiles[a.y][x] = '.';
  if (a.y <= b.y) for (let y = a.y; y <= b.y; y++) tiles[y][b.x] = '.';
  else for (let y = b.y; y <= a.y; y++) tiles[y][b.x] = '.';
}

/** 房间迷宫 chunk：8 端口 + 1-3 个随机房间 + 顺序 L 走廊（全连通） */
function buildRoomsChunk(tiles, rng) {
  carvePorts(tiles);
  const rooms = [];
  const roomCount = randInt(rng, 1, 3);
  for (let i = 0; i < roomCount; i++) {
    const rw = randInt(rng, 4, 7);
    const rh = randInt(rng, 4, 7);
    for (let t = 0; t < 20; t++) {
      const x = randInt(rng, 2, CHUNK - rw - 2);
      const y = randInt(rng, 2, CHUNK - rh - 2);
      if (!overlaps(rooms, x, y, rw, rh)) {
        rooms.push({ x, y, w: rw, h: rh });
        carveRoom(tiles, x, y, rw, rh);
        break;
      }
    }
  }
  if (rooms.length === 0) {
    rooms.push({ x: 5, y: 5, w: 5, h: 5 });
    carveRoom(tiles, 5, 5, 5, 5);
  }
  // 节点 = 8 端口内端 + 房间中心，顺序连接 → 全部连通
  const nodes = EDGE_PORTS.map(portInner);
  for (const r of rooms) nodes.push({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
  for (let i = 1; i < nodes.length; i++) carveL(tiles, nodes[i - 1], nodes[i]);
}

/** 洞穴 chunk：8 端口 + 从端口出发的随机游走 + 随机洞穴室 */
function buildCavesChunk(tiles, rng) {
  carvePorts(tiles);
  const starts = EDGE_PORTS.map(portInner);
  let x = starts[0].x;
  let y = starts[0].y;
  tiles[y][x] = '.';
  for (let s = 1; s < starts.length; s++) {
    for (let i = 0; i < 60; i++) {
      const dir = DIRS4[randInt(rng, 0, 3)];
      x = Math.max(1, Math.min(CHUNK - 2, x + dir.dx));
      y = Math.max(1, Math.min(CHUNK - 2, y + dir.dy));
      tiles[y][x] = '.';
      if (Math.abs(x - starts[s].x) + Math.abs(y - starts[s].y) <= 2) break;
    }
  }
  const caves = randInt(rng, 1, 3);
  for (let i = 0; i < caves; i++) {
    const cx = randInt(rng, 3, CHUNK - 4);
    const cy = randInt(rng, 3, CHUNK - 4);
    const r = randInt(rng, 2, 4);
    for (let yy = cy - r; yy <= cy + r; yy++) {
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx >= 1 && yy >= 1 && xx < CHUNK - 1 && yy < CHUNK - 1 && (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) {
          tiles[yy][xx] = '.';
        }
      }
    }
  }
}

/** 走廊网格 chunk：全局公式（stride 8 整除 CHUNK，边界天然对齐无缝） */
function buildHallwayChunk(tiles, rng, gx0, gy0) {
  const stride = 8;
  const isCorridor = (gx, gy) => posmod(gx, stride) === 4 || posmod(gy, stride) === 4;
  const isWall = (gx, gy) => {
    const xm = posmod(gx, stride);
    const ym = posmod(gy, stride);
    return (xm === 3 || xm === 5 || ym === 3 || ym === 5) && !isCorridor(gx, gy);
  };
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const gx = gx0 + lx;
      const gy = gy0 + ly;
      tiles[ly][lx] = isCorridor(gx, gy) ? '.' : isWall(gx, gy) ? '#' : '.';
    }
  }
  // 门（概率 0.24）：一侧邻走廊、另一侧邻房间的墙（走廊不跨 chunk 边界，判定安全）
  const isRoomTile = (t) => t === '.' || t === '~';
  for (let ly = 1; ly < CHUNK - 1; ly++) {
    for (let lx = 1; lx < CHUNK - 1; lx++) {
      if (tiles[ly][lx] !== '#') continue;
      const gx = gx0 + lx;
      const gy = gy0 + ly;
      let hasCorridor = false;
      let hasRoom = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nlx = lx + dx;
        const nly = ly + dy;
        if (nlx < 0 || nly < 0 || nlx >= CHUNK || nly >= CHUNK) continue;
        if (isCorridor(gx + dx, gy + dy) && tiles[nly][nlx] !== '#') hasCorridor = true;
        else if (isRoomTile(tiles[nly][nlx])) hasRoom = true;
      }
      if (hasCorridor && hasRoom && chance(rng, 0.24)) tiles[ly][lx] = 'D';
    }
  }
}

/** 城市街区 chunk：全局街道公式 + 块哈希门位（跨 chunk 一致） */
function buildCityChunk(tiles, gx0, gy0, dna, runSeed) {
  const stride = 12;
  const streetW = 3;
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const gx = gx0 + lx;
      const gy = gy0 + ly;
      if (posmod(gx, stride) < streetW || posmod(gy, stride) < streetW) {
        tiles[ly][lx] = '.';
        continue;
      }
      const xm = posmod(gx, stride);
      const ym = posmod(gy, stride);
      const edge = xm === 3 || xm === 11 || ym === 3 || ym === 11;
      tiles[ly][lx] = edge ? '#' : '.';
    }
  }
  // 门：由"街区种子"决定（与 chunk 无关），每个街区 1-2 扇店门，位置确定
  const bx0 = Math.floor(gx0 / stride);
  const bx1 = Math.floor((gx0 + CHUNK - 1) / stride);
  const by0 = Math.floor(gy0 / stride);
  const by1 = Math.floor((gy0 + CHUNK - 1) / stride);
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      const br = mulberry32(hashString(`${runSeed}|${dna.id}|blk:${bx},${by}`));
      const x0 = bx * stride + streetW;
      const y0 = by * stride + streetW;
      const x1 = bx * stride + stride - 1;
      const y1 = by * stride + stride - 1;
      const doorCount = randInt(br, 1, 2);
      for (let i = 0; i < doorCount; i++) {
        const side = pick(br, ['top', 'bottom', 'left', 'right']);
        let dx, dy;
        if (side === 'top') { dx = randInt(br, x0 + 1, x1 - 1); dy = y0; }
        else if (side === 'bottom') { dx = randInt(br, x0 + 1, x1 - 1); dy = y1; }
        else if (side === 'left') { dx = x0; dy = randInt(br, y0 + 1, y1 - 1); }
        else { dx = x1; dy = randInt(br, y0 + 1, y1 - 1); }
        const lx = dx - gx0;
        const ly = dy - gy0;
        if (lx >= 0 && lx < CHUNK && ly >= 0 && ly < CHUNK && tiles[ly][lx] === '#') {
          tiles[ly][lx] = 'D';
        }
      }
    }
  }
}

/** 仓库 chunk：开阔大厅 + 全局柱列 + 稀疏隔间（避开边缘保证通路） */
function buildWarehouseChunk(tiles, rng, gx0, gy0) {
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) tiles[ly][lx] = '.';
  }
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      if (posmod(gx0 + lx, 5) === 4 && posmod(gy0 + ly, 5) === 4) tiles[ly][lx] = '#';
    }
  }
  const n = randInt(rng, 0, 2);
  for (let i = 0; i < n; i++) {
    const hx = randInt(rng, 3, CHUNK - 6);
    const hy = randInt(rng, 3, CHUNK - 6);
    for (let yy = hy - 1; yy <= hy + 3; yy++) {
      for (let xx = hx - 1; xx <= hx + 3; xx++) {
        const edge = xx === hx - 1 || xx === hx + 3 || yy === hy - 1 || yy === hy + 3;
        tiles[yy][xx] = edge ? '#' : '.';
      }
    }
    const side = randInt(rng, 0, 3);
    let dx, dy;
    if (side === 0) { dx = hx + randInt(rng, 0, 2); dy = hy - 1; }
    else if (side === 1) { dx = hx + randInt(rng, 0, 2); dy = hy + 3; }
    else if (side === 2) { dx = hx - 1; dy = hy + randInt(rng, 0, 2); }
    else { dx = hx + 3; dy = hy + randInt(rng, 0, 2); }
    if (dx >= 1 && dy >= 1 && dx < CHUNK - 1 && dy < CHUNK - 1 && tiles[dy][dx] === '#') {
      tiles[dy][dx] = 'D';
    }
  }
}

/** 旅馆 chunk：全局走廊公式（stride 6）+ 块哈希门口（房间角，跨 chunk 一致） */
function buildHotelChunk(tiles, gx0, gy0, dna, runSeed) {
  const stride = 6;
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const gx = gx0 + lx;
      const gy = gy0 + ly;
      if (posmod(gx, stride) === 2 || posmod(gy, stride) === 2) tiles[ly][lx] = '.';
      else tiles[ly][lx] = '#';
    }
  }
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const xm = posmod(gx0 + lx, stride);
      const ym = posmod(gy0 + ly, stride);
      if (xm >= 3 && ym >= 3) tiles[ly][lx] = '.';
    }
  }
  const bx0 = Math.floor(gx0 / stride);
  const bx1 = Math.floor((gx0 + CHUNK - 1) / stride);
  const by0 = Math.floor(gy0 / stride);
  const by1 = Math.floor((gy0 + CHUNK - 1) / stride);
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) {
      const br = mulberry32(hashString(`${runSeed}|${dna.id}|hblk:${bx},${by}`));
      const x0 = bx * stride + 3;
      const y0 = by * stride + 3;
      for (const [dx, dy] of [[x0, y0], [x0, y0 + 2], [x0, y0], [x0 + 2, y0]]) {
        if (!chance(br, 0.7)) continue;
        const lx = dx - gx0;
        const ly = dy - gy0;
        if (lx >= 0 && lx < CHUNK && ly >= 0 && ly < CHUNK && tiles[ly][lx] === '.') {
          tiles[ly][lx] = 'D';
        }
      }
    }
  }
}

/** 田野 chunk：开阔地面 + 障碍簇 + 稀疏农舍（避开边缘保证跨 chunk 通路） */
function buildFieldsChunk(tiles, rng) {
  for (let ly = 0; ly < CHUNK; ly++) {
    for (let lx = 0; lx < CHUNK; lx++) tiles[ly][lx] = '.';
  }
  const n = randInt(rng, 2, 5);
  for (let i = 0; i < n; i++) {
    const cx = randInt(rng, 3, CHUNK - 4);
    const cy = randInt(rng, 3, CHUNK - 4);
    const r = randInt(rng, 1, 3);
    for (let yy = cy - r; yy <= cy + r; yy++) {
      for (let xx = cx - r; xx <= cx + r; xx++) {
        if (xx >= 2 && yy >= 2 && xx < CHUNK - 2 && yy < CHUNK - 2 && (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) {
          tiles[yy][xx] = '#';
        }
      }
    }
  }
  if (chance(rng, 0.6)) {
    const hx = randInt(rng, 3, CHUNK - 7);
    const hy = randInt(rng, 3, CHUNK - 7);
    for (let yy = hy; yy < hy + 4; yy++) {
      for (let xx = hx; xx < hx + 4; xx++) {
        const edge = xx === hx || xx === hx + 3 || yy === hy || yy === hy + 3;
        tiles[yy][xx] = edge ? '#' : '.';
      }
    }
    const dx = hx + randInt(rng, 0, 3);
    const dy = hy - 1;
    if (dy >= 2 && tiles[dy][dx] === '#') tiles[dy][dx] = 'D';
  }
}

/** 构建单个 chunk：瓦片 + 实体 + 物品（确定性，可独立重放） */
function buildChunk(dna, runSeed, cx, cy) {
  const rng = chunkRng(dna, runSeed, cx, cy);
  const tiles = Array.from({ length: CHUNK }, () => Array(CHUNK).fill('#'));
  const gx0 = cx * CHUNK;
  const gy0 = cy * CHUNK;
  const topology = dna.terrain.topology || (dna.environment === 'caves' ? 'caves' : 'rooms');
  if (topology === 'hallway-grid') buildHallwayChunk(tiles, rng, gx0, gy0);
  else if (topology === 'city-grid') buildCityChunk(tiles, gx0, gy0, dna, runSeed);
  else if (topology === 'warehouse') buildWarehouseChunk(tiles, rng, gx0, gy0);
  else if (topology === 'hotel') buildHotelChunk(tiles, gx0, gy0, dna, runSeed);
  else if (topology === 'fields') buildFieldsChunk(tiles, rng);
  else if (topology === 'caves') buildCavesChunk(tiles, rng);
  else buildRoomsChunk(tiles, rng);

  // 实体：密度 × 256 格期望值，泊松化
  const ents = [];
  const used = new Set();
  if (dna.entities) {
    for (const spec of dna.entities) {
      if (!spec || !spec.density || spec.density <= 0) continue;
      const def = ENTITY_DEFS[spec.type];
      if (!def) continue;
      const expected = spec.density * CHUNK * CHUNK;
      const count = Math.floor(expected) + (rng() < expected - Math.floor(expected) ? 1 : 0);
      for (let i = 0; i < count; i++) {
        let px = -1;
        let py = -1;
        for (let t = 0; t < 40; t++) {
          const tx = randInt(rng, 1, CHUNK - 2);
          const ty = randInt(rng, 1, CHUNK - 2);
          const k = tx + ',' + ty;
          if (WALKABLE_TILES.has(tiles[ty][tx]) && tiles[ty][tx] !== 'D' && !used.has(k)) {
            px = tx;
            py = ty;
            used.add(k);
            break;
          }
        }
        if (px < 0) continue;
        const stealthy = spec.type === 'skin-stealer' || spec.type === 'scratcher';
        ents.push({
          id: (gx0 + px) + ',' + (gy0 + py),
          chunkKey: cx + ',' + cy,
          x: gx0 + px,
          y: gy0 + py,
          type: spec.type,
          aggression: spec.aggression || 'curious',
          hp: def.hp,
          state: 'idle',
          visible: !stealthy,
          alert: false,
          wait: randInt(rng, 0, 3),
          revealed: false,
        });
      }
    }
  }
  // 物品：itemDensity × 256 期望值
  const its = [];
  if (dna.itemDensity > 0 && dna.items.length > 0) {
    const expected = dna.itemDensity * CHUNK * CHUNK;
    const count = Math.max(1, Math.floor(expected) + (rng() < expected - Math.floor(expected) ? 1 : 0));
    for (let i = 0; i < count; i++) {
      let px = -1;
      let py = -1;
      for (let t = 0; t < 40; t++) {
        const tx = randInt(rng, 1, CHUNK - 2);
        const ty = randInt(rng, 1, CHUNK - 2);
        const k = tx + ',' + ty;
        if (WALKABLE_TILES.has(tiles[ty][tx]) && tiles[ty][tx] !== 'D' && !used.has(k)) {
          px = tx;
          py = ty;
          used.add(k);
          break;
        }
      }
      if (px < 0) continue;
      its.push({
        id: 'i:' + (gx0 + px) + ',' + (gy0 + py),
        chunkKey: cx + ',' + cy,
        x: gx0 + px,
        y: gy0 + py,
        type: pick(rng, dna.items),
      });
    }
  }
  return { tiles, entities: ents, items: its };
}

/** 无限层级上的最近可行走格（螺旋搜索，越远越生成） */
function nearestWalkableInfinite(level, x, y) {
  for (let r = 0; r < 128; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (WALKABLE_TILES.has(level.getTile(x + dx, y + dy))) return { x: x + dx, y: y + dy };
      }
    }
  }
  return { x, y };
}

/** 创建无限层级：无边界、惰性分块、确定性重放 */
export function createInfiniteLevel(dna, runSeed) {
  const chunks = new Map();
  const level = {
    id: dna.id,
    name: dna.name,
    number: dna.number,
    category: dna.category,
    difficultyClass: dna.difficultyClass,
    environment: dna.environment || 'corridors',
    aesthetic: dna.aesthetic,
    description: dna.description,
    terrain: dna.terrain,
    infinite: true,
    spawn: { x: 0, y: 0 },
    exits: [],
    entities: [],
    items: [],
    setPieces: [],
    props: [],
    portals: [],
    rooms: [],
    doorLinks: [],
    palette: dna.palette,
    light: dna.light,
    spaceRules: dna.spaceRules,
    sanDrain: dna.sanDrain,
    soundscape: dna.soundscape,
    chunks,
    chunkKeys: [],
    takenItems: new Set(),
    deadEntities: new Set(),
    exitSet: new Set(),
    playerChunkX: 0,
    playerChunkY: 0,
    getChunk(cx, cy) {
      const k = cx + ',' + cy;
      let c = chunks.get(k);
      if (!c) {
        c = buildChunk(dna, runSeed, cx, cy);
        chunks.set(k, c);
        level.chunkKeys.push(k);
      }
      return c;
    },
    getTile(x, y) {
      const cx = Math.floor(x / CHUNK);
      const cy = Math.floor(y / CHUNK);
      const c = level.getChunk(cx, cy);
      return c.tiles[y - cy * CHUNK][x - cx * CHUNK];
    },
  };
  // 出生点 (0,0) 必须可行走
  if (!WALKABLE_TILES.has(level.getTile(0, 0))) {
    const p = nearestWalkableInfinite(level, 0, 0);
    level.spawn = { x: p.x, y: p.y };
  }
  // 出口：2-4 个，距出生点 8-24 格，确定性方向
  const er = mulberry32(hashString(`${runSeed}|${dna.id}|exits`));
  const exitSpecs = dna.exits && dna.exits.length ? dna.exits : [{ kind: 'noclip', target: 'hub' }];
  const n = Math.min(exitSpecs.length, randInt(er, 2, 4));
  const placed = [];
  for (let i = 0; i < n; i++) {
    const spec = exitSpecs[i % exitSpecs.length];
    const d = randInt(er, 8, 24);
    const ang = (randInt(er, 0, 7) * Math.PI) / 4;
    let x = Math.round(level.spawn.x + Math.cos(ang) * d);
    let y = Math.round(level.spawn.y + Math.sin(ang) * d);
    for (let t = 0; t < 60 && !WALKABLE_TILES.has(level.getTile(x, y)); t++) {
      x += randInt(er, -1, 1);
      y += randInt(er, -1, 1);
    }
    if (!WALKABLE_TILES.has(level.getTile(x, y))) {
      const p = nearestWalkableInfinite(level, x, y);
      x = p.x;
      y = p.y;
    }
    if (placed.some((e) => Math.abs(e.x - x) + Math.abs(e.y - y) < 4)) continue;
    placed.push({ x, y });
    level.exitSet.add(x + ',' + y);
    level.exits.push({
      x,
      y,
      target: spec.target || 'hub',
      kind: spec.kind || 'noclip',
      hidden: !!spec.hidden,
      danger: !!spec.danger,
      description: spec.description || '',
    });
  }
  // 出生点附近 6 格内不生成实体/物品
  const nearSpawn = (a, b) => Math.abs(a - level.spawn.x) + Math.abs(b - level.spawn.y) < 6;
  const c0 = level.getChunk(0, 0);
  c0.entities = c0.entities.filter((e) => !nearSpawn(e.x, e.y));
  c0.items = c0.items.filter((it) => !nearSpawn(it.x, it.y));
  level.entities = c0.entities.slice();
  level.items = c0.items.slice();
  return level;
}

/** 玩家周围 3×3 chunk 激活：移入/移出实体与物品（稳定 id 记录取走/击杀） */
export function updateActiveChunks(level, px, py) {
  if (!level.infinite) return false;
  const cx = Math.floor(px / CHUNK);
  const cy = Math.floor(py / CHUNK);
  if (cx === level.playerChunkX && cy === level.playerChunkY) return false;
  level.playerChunkX = cx;
  level.playerChunkY = cy;
  const active = new Set();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) active.add(cx + dx + ',' + (cy + dy));
  }
  level.entities = level.entities.filter((e) => active.has(e.chunkKey));
  level.items = level.items.filter((it) => active.has(it.chunkKey));
  for (const k of active) {
    const comma = k.indexOf(',');
    const ax = Number(k.slice(0, comma));
    const ay = Number(k.slice(comma + 1));
    const c = level.getChunk(ax, ay);
    for (const e of c.entities) {
      if (!level.deadEntities.has(e.id) && !level.entities.includes(e)) level.entities.push(e);
    }
    for (const it of c.items) {
      if (!level.takenItems.has(it.id) && !level.exitSet.has(it.x + ',' + it.y) && !level.items.includes(it)) {
        level.items.push(it);
      }
    }
  }
  return true;
}

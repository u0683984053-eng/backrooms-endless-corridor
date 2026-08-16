// engine/game.js
// 游戏主循环：回合制状态机、事件日志、胜负判定、层级切换、视野计算、存档序列化。
// 回合经济学：玩家动作 → 出口切换 → 实体行动 → 状态结算 → 事件日志。

import { mulberry32, hashString, chance, pick, DIRS } from './rng.js';
import { generateLevel, createInfiniteLevel, updateActiveChunks, trimChunkCache, tileAt } from './generator.js';
import { updateEntity, ENTITY_DEFS } from './entities.js';
import { createPlayer, applyPlayerAction, viewRadiusOf, isLitTile, pushLog } from './player.js';

/** 免费动作：不消耗回合、不进入实体阶段 */
const FREE_ACTIONS = new Set(['look', 'note']);

function mod(n, m) {
  return ((n % m) + m) % m;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 创建一局游戏（从 Level 0 出生） */
export function createGame({ levels, seed }) {
  const runSeed = seed === undefined ? 1 : seed;
  const state = {
    levels,
    runSeed,
    levelId: null,
    previousLevelId: null,
    level: null,
    player: null,
    entities: [],
    items: [],
    turn: 0,
    over: null, // null | 'dead' | 'assimilated'
    deathCause: null,
    lastAttackerName: null,
    log: [],
    explored: {}, // levelId -> Set("x,y")
    discoveredExits: {}, // levelId -> Set(index)
    seenSetPieces: {}, // levelId -> Set(index)
    codex: { levels: {}, deaths: [], notes: [] },
    sanityPhase: 'calm',
    fear: false,
    lastNoise: { level: 0, x: 0, y: 0 },
    pendingExit: null,
    unlockedDoors: new Set(), // 已用钥匙解锁的门（"层级ID:配对索引"）
    achievements: new Set(), // 已解锁成就 id
    stats: {
      itemsPicked: 0,
      keysUsed: 0,
      exitsUsed: 0,
      levelsTurns: {}, // levelId -> 累计回合
      visited: {}, // levelId -> 进入次数
    },
    rng: mulberry32(hashString('game:' + String(runSeed))),
  };
  enterLevel(state, 'level-0', { initial: true });
  return state;
}

/** 推进一回合：返回 { events, over } */
export function step(state, action) {
  if (state.over) return { events: [], over: state.over };
  const events = [];

  // 免费动作（查看/笔记）：不推进回合
  if (FREE_ACTIONS.has(action.type)) {
    const world = buildWorld(state);
    world.events = events;
    const freeEv = applyPlayerAction(state, action, world);
    for (const x of freeEv) events.push(x);
    return { events, over: state.over };
  }

  state.pendingExit = null;
  let world = buildWorld(state);
  world.events = events;

  // 理智 <15：崩溃，随机失控行动（覆盖玩家输入）
  if (state.player.sanity < 15 && chance(state.rng, 0.6)) {
    const forced = pick(state.rng, ['move', 'move', 'move', 'run', 'fight']);
    const d = pick(state.rng, DIRS);
    action = forced === 'fight' ? { type: 'fight' } : { type: forced, dx: d.dx, dy: d.dy };
    events.push({ text: '你的理智已经崩溃，身体不受控制地行动……', kind: 'sanity' });
  }

  // ---- 玩家阶段 ----
  const playerEvents = applyPlayerAction(state, action, world);
  for (const x of playerEvents) events.push(x);
  // 无限层：玩家移动后刷新激活 chunk 集（实体/物品进出视野半径）+ 缓存上限（确定性重建）
  if (state.level.infinite) {
    updateActiveChunks(state.level, state.player.x, state.player.y);
    trimChunkCache(state.level, 128);
  }

  // ---- 出口切换（切换后重建 world） ----
  if (state.pendingExit) {
    const ex = state.pendingExit.exit;
    enterLevel(state, ex.target, { keepPlayer: true });
    if (ex.danger) {
      state.player.hp = Math.max(0, state.player.hp - 15);
      events.push({ text: '这次穿越付出了代价：你受了伤（-15 HP）。', kind: 'combat' });
    }
    state.pendingExit = null;
    world = buildWorld(state);
    world.events = events;
  }

  // ---- 实体阶段 ----
  // 特殊机制：endless-chase（!层"跑"）——所有敌对实体持续追击，永不冷静
  const mechs = (state.levels[state.levelId] && state.levels[state.levelId].specialMechanisms) || [];
  if (mechs.includes('endless-chase')) {
    for (const e of state.entities) {
      if (e.hp > 0 && (e.aggression === 'hostile' || (ENTITY_DEFS[e.type] && ENTITY_DEFS[e.type].dmg > 0))) {
        e.alert = true;
      }
    }
  }
  for (const e of state.entities) {
    if (e.hp > 0) {
      const ev = updateEntity(e, world);
      for (const x of ev) events.push(x);
    }
  }
  // 无限层：记录死亡实体的稳定 id（跨 chunk 重激活不复活）
  if (state.level.infinite) {
    for (const e of state.entities) {
      if (e.hp <= 0 && e.id) state.level.deadEntities.add(e.id);
    }
  }
  state.entities = state.entities.filter((e) => e.hp > 0);
  state.level.entities = state.entities;

  // ---- 状态结算 ----
  endTurn(state, events);
  state.turn++;
  state.stats.levelsTurns[state.levelId] = (state.stats.levelsTurns[state.levelId] || 0) + 1;
  updateExplored(state);
  recordBestiary(state);
  checkDeath(state, events);
  checkAchievements(state, events);

  return { events, over: state.over };
}

/** Codex 实体图鉴：记录视野内目击的实体（"活体博物馆"理念） */
function recordBestiary(state) {
  const codex = state.codex;
  if (!codex.bestiary) codex.bestiary = {};
  const radius = viewRadiusOf(state.level, state.player);
  for (const e of state.entities) {
    if (e.hp <= 0 || !e.visible) continue;
    const d = Math.abs(e.x - state.player.x) + Math.abs(e.y - state.player.y);
    if (d > radius) continue;
    const def = ENTITY_DEFS[e.type] || {};
    const rec = codex.bestiary[e.type] || {
      name: def.name || e.type,
      seen: 0,
      desc: def.desc || '',
      emoji: def.emoji || '❓',
    };
    rec.seen++;
    codex.bestiary[e.type] = rec;
  }
}

// ---------- Codex 成就（非线性，Fandom 风） ----------
export const ACHIEVEMENTS = [
  { id: 'first-steps', name: '第一步', desc: '第一次移动。后室的走廊记住了你。', test: (s) => s.turn >= 1 },
  { id: 'l0-survivor', name: '教学关卡常客', desc: '在 Level 0 存活 50 回合。你开始习惯这里的黄色了。', test: (s) => s.turn >= 50 && (s.stats.levelsTurns['level-0'] || 0) >= 50 },
  { id: 'explorer-5', name: '初探者', desc: '发现 5 个层级。', test: (s) => Object.keys(s.codex.levels || {}).length >= 5 },
  { id: 'explorer-10', name: '测绘员', desc: '发现 10 个层级。', test: (s) => Object.keys(s.codex.levels || {}).length >= 10 },
  { id: 'explorer-20', name: '流浪者', desc: '发现 20 个层级。你正在成为后室的一部分。', test: (s) => Object.keys(s.codex.levels || {}).length >= 20 },
  { id: 'deep-diver', name: '深渊来客', desc: '进入 Level 666 或 Level -1 并活了下来。', test: (s) => (s.stats.visited['level-666'] || 0) > 0 && !s.over },
  { id: 'sprinter', name: '跑者', desc: '进入 !层并存活 30 回合。别停下来。', test: (s) => (s.stats.levelsTurns['level-!'] || 0) >= 30 },
  { id: 'hoarder', name: '拾荒者', desc: '拾取 20 件物品。', test: (s) => (s.stats.itemsPicked || 0) >= 20 },
  { id: 'scholar', name: '书记官', desc: '收集 10 条笔记与文档。', test: (s) => (s.codex.notes || []).length >= 10 },
  { id: 'survivor-200', name: '久居者', desc: '存活 200 回合。', test: (s) => s.turn >= 200 },
  { id: 'keymaster', name: '开锁匠', desc: '用钥匙打开 3 扇锁着的门。', test: (s) => (s.stats.keysUsed || 0) >= 3 },
  { id: 'noclip-master', name: '穿墙者', desc: '使用 5 次层级出口（卡出）。', test: (s) => (s.stats.exitsUsed || 0) >= 5 },
  { id: 'first-death', name: '你还会回来的', desc: '第一次死亡。后室没有终点。', test: (s) => (s.codex.deaths || []).length >= 1 },
  { id: 'hub-visitor', name: '中转站', desc: '发现枢纽（The Hub）。', test: (s) => (s.stats.visited['level-hub'] || 0) > 0 },
  { id: 'codex-24', name: '行记圆满', desc: '发现全部层级。你见过的后室，比大多数人想象的都多。', test: (s) => Object.keys(s.codex.levels || {}).length >= 24 },
  { id: 'naturalist', name: '博物学家', desc: '目击全部 13 种实体。你是活的图鉴。', test: (s) => Object.keys((s.codex && s.codex.bestiary) || {}).length >= 13 },
];

function checkAchievements(state, events) {
  const earned = state.achievements || (state.achievements = new Set());
  for (const a of ACHIEVEMENTS) {
    if (earned.has(a.id)) continue;
    let ok = false;
    try {
      ok = a.test(state);
    } catch {
      ok = false;
    }
    if (ok) {
      earned.add(a.id);
      pushLog(state, `【成就解锁】${a.name}：${a.desc}`, 'achievement');
      events.push({ text: `🏆 成就解锁：${a.name}——${a.desc}`, kind: 'achievement' });
    }
  }
}

/** 每层已探索集合上限：超出后 FIFO 淘汰最旧一格（存档体积保护，地图持续滚动更新） */
const EXPLORED_CAP = 30000;

/** 把当前视野并入该层级的"已探索"集合（雾战争实现） */
function updateExplored(state) {
  const set = state.explored[state.levelId];
  const tiles = playerVisibleTiles(state);
  // 需要淘汰的数量：超出上限的部分（每新增一格淘汰一格，保持 ≤ CAP）
  let toEvict = set.size + tiles.length - EXPLORED_CAP;
  if (toEvict > 0) {
    const it = set.values();
    while (toEvict-- > 0) {
      const v = it.next().value;
      if (v === undefined) break;
      set.delete(v);
    }
  }
  for (const t of tiles) set.add(t.x + ',' + t.y);
}

/** 切换层级（重新确定性生成目标层级；keepPlayer 保留玩家属性） */
export function enterLevel(state, levelId, opts = {}) {
  const dna = state.levels[levelId];
  if (!dna) {
    pushLog(state, `出口通往未知之地（缺少 DNA：${levelId}）。`, 'system');
    return;
  }
  const level = dna.terrain.infinite ? createInfiniteLevel(dna, state.runSeed) : generateLevel(dna, state.runSeed);
  state.previousLevelId = state.levelId;
  state.levelId = levelId;
  state.level = level;

  if (opts.keepPlayer && state.player) {
    state.player.x = level.spawn.x;
    state.player.y = level.spawn.y;
  } else {
    state.player = createPlayer(level.spawn.x, level.spawn.y);
  }
  if (level.infinite) {
    // 无限层：实体/物品直接引用激活集（updateActiveChunks 维护进出）
    state.entities = level.entities;
    state.items = level.items;
  } else {
    state.entities = level.entities.map((e) => ({ ...e }));
    state.items = level.items.map((it) => ({ ...it }));
  }
  if (level.infinite) updateActiveChunks(level, state.player.x, state.player.y);
  state.explored[levelId] = state.explored[levelId] || new Set();
  state.discoveredExits[levelId] = state.discoveredExits[levelId] || new Set();
  state.seenSetPieces[levelId] = state.seenSetPieces[levelId] || new Set();
  state.stats.visited[levelId] = (state.stats.visited[levelId] || 0) + 1;
  state.lastNoise = { level: 0, x: state.player.x, y: state.player.y };

  // Codex 记录
  const codex = (state.codex.levels[levelId] =
    state.codex.levels[levelId] || {
      id: levelId,
      name: dna.name,
      visits: 0,
      firstVisitTurn: state.turn,
      notes: [],
      deaths: 0,
    });
  codex.visits++;

  if (opts.initial) {
    pushLog(state, `你跌入了 ${dna.name}。${dna.description}`, 'level');
  } else {
    pushLog(state, `你进入了 ${dna.name}。`, 'level');
    if (codex.visits === 1) pushLog(state, dna.description, 'level');
  }

  updateExplored(state);
}

/** 视野内瓦片（BFS 洪水填充，墙阻挡视线；looping 按环面处理） */
export function playerVisibleTiles(state) {
  const { level, player } = state;
  const radius = viewRadiusOf(level, player);
  const looping = level.spaceRules.includes('looping') && !level.infinite;
  const seen = new Set([player.x + ',' + player.y]);
  const tiles = [{ x: player.x, y: player.y }];
  const queue = [[player.x, player.y, 0]];
  let head = 0;
  while (head < queue.length) {
    const [x, y, d] = queue[head++];
    if (d >= radius) continue;
    for (const dir of DIRS) {
      let nx = x + dir.dx;
      let ny = y + dir.dy;
      if (looping) {
        nx = mod(nx, level.width);
        ny = mod(ny, level.height);
      } else if (!level.infinite && (nx < 0 || ny < 0 || nx >= level.width || ny >= level.height)) {
        continue;
      }
      const k = nx + ',' + ny;
      if (seen.has(k)) continue;
      seen.add(k);
      tiles.push({ x: nx, y: ny });
      if (tileAt(level, nx, ny) !== '#') queue.push([nx, ny, d + 1]);
    }
  }
  return tiles;
}

// ---------- 内部 ----------

/** 构建实体/玩家共用的 world 上下文 */
function buildWorld(state) {
  const { level, player, entities } = state;
  return {
    level,
    player,
    entities,
    rng: state.rng,
    turn: state.turn,
    noise: state.lastNoise,
    looking: false,
    recordAttack: (name) => {
      state.lastAttackerName = name;
    },
    dist: (x1, y1, x2, y2) => Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2)),
    hasLos: (x1, y1, x2, y2) => hasLineOfSight(level, x1, y1, x2, y2),
    isWalkable: (x, y, self) => isTileWalkable(state, x, y, self),
    isLit: (x, y) => isLitTile(level, player, x, y),
  };
}

/** 瓦片可行走性（含边界环绕、墙、实体占用、玩家自身） */
function isTileWalkable(state, x, y, self) {
  const { level, player, entities } = state;
  let nx = x;
  let ny = y;
  if (level.spaceRules.includes('looping') && !level.infinite) {
    nx = mod(nx, level.width);
    ny = mod(ny, level.height);
  } else if (!level.infinite && (x < 0 || y < 0 || x >= level.width || y >= level.height)) {
    return false;
  }
  const t = tileAt(level, nx, ny);
  if (t === '#') return false;
  if (nx === player.x && ny === player.y) return false;
  for (const e of entities) {
    if (e !== self && e.hp > 0 && e.x === nx && e.y === ny) return false;
  }
  return true;
}

/** 视线：DDA 采样的线段上无墙 */
function hasLineOfSight(level, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return true;
  for (let i = 1; i < steps; i++) {
    const ix = Math.round(x1 + (dx * i) / steps);
    const iy = Math.round(y1 + (dy * i) / steps);
    if (!level.infinite && (ix < 0 || iy < 0 || ix >= level.width || iy >= level.height)) return false;
    if (tileAt(level, ix, iy) === '#') return false;
  }
  return true;
}

// ---------- 回合结算 ----------

function endTurn(state, events) {
  const { player, level } = state;

  // 特殊机制：heat-drain（666 地狱）——高温每 10 回合灼烧 1 HP
  // （endTurn 在 turn++ 之前执行，故用 turn+1 判定"本回合完成后"的计数）
  const mechs = (state.levels[state.levelId] && state.levels[state.levelId].specialMechanisms) || [];
  if (mechs.includes('heat-drain') && (state.turn + 1) % 10 === 0) {
    player.hp = Math.max(0, player.hp - 1);
    events.push({ text: '空气灼热得发烫，高温正在消耗你的生命（-1 HP）。', kind: 'sanity' });
  }

  // 空间规则机制：time-anomaly（时间异常）——每 25 回合"时间打了个盹"
  const rules = level.spaceRules || [];
  if (rules.includes('time-anomaly') && (state.turn + 1) % 25 === 0) {
    player.sanity = Math.min(100, player.sanity + 2);
    player.stamina = Math.min(100, player.stamina + 5);
    events.push({ text: '时间打了个盹。你的疲劳与恐惧似乎被偷走了片刻。（+2 理智 / +5 体力）', kind: 'sanity' });
  }
  // 空间规则机制：gravity-anomaly（重力异常）——每 30 回合一次重力翻转
  if (rules.includes('gravity-anomaly') && (state.turn + 1) % 30 === 0) {
    events.push({ text: '重力突然翻转了一瞬——你被抛向一侧，撞上了墙。', kind: 'sanity' });
    const dirs = [
      { dx: 0, dy: -1 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 0 },
    ];
    const d = dirs[Math.floor(state.rng() * dirs.length)];
    let nx = player.x + d.dx;
    let ny = player.y + d.dy;
    if (rules.includes('looping') && !level.infinite) {
      nx = ((nx % level.width) + level.width) % level.width;
      ny = ((ny % level.height) + level.height) % level.height;
    }
    if ((level.infinite || (nx >= 0 && ny >= 0 && nx < level.width && ny < level.height)) && tileAt(level, nx, ny) !== '#') {
      const blocked = state.entities.some((e) => e.hp > 0 && e.x === nx && e.y === ny);
      if (!blocked) {
        player.x = nx;
        player.y = ny;
        player.hp = Math.max(0, player.hp - 1);
        events.push({ text: '你被甩向墙壁，擦伤了（-1 HP）。', kind: 'combat' });
      }
    }
  }

  // 理智：基础侵蚀；安全层（sanDrain<=0.03 且 bright）每回合 +1
  if (level.sanDrain <= 0.03 && level.light === 'bright') {
    player.sanity = Math.min(100, player.sanity + 1);
  } else {
    player.sanity -= level.sanDrain || 0;
  }

  // 体力自然回复
  player.stamina = Math.min(100, player.stamina + 2);

  // 手电电池：每 20 回合耗 1 电池
  if (player.flashlight) {
    player.batteryFrac += 1 / 20;
    if (player.batteryFrac >= 1) {
      const n = Math.floor(player.batteryFrac);
      player.batteryFrac -= n;
      player.battery = Math.max(0, player.battery - n);
      if (player.battery <= 0) {
        player.flashlight = false;
        events.push({ text: '手电的电池耗尽了，灯熄灭了。', kind: 'item' });
      }
    }
  }

  updateSanityPhase(state, events);

  player.sanity = clamp(player.sanity, 0, 100);
  player.hp = clamp(player.hp, 0, 100);
  player.stamina = clamp(player.stamina, 0, 100);
}

const FAKE_UNEASY = [
  '你听到身后传来脚步声，回头却什么都没有。',
  '墙角的阴影好像动了一下。',
  '荧光灯闪了一下，有什么东西在灯下站着。',
  '你觉得地毯上的花纹在旋转。',
  '某扇门吱呀一声开了一条缝——里面是黑的，但有什么在注视。',
  '你听见自己的名字被叫了一声，很轻，像是从墙里传来的。',
  '天花板上的灯管蒙了一层灰，灰的形状像一张脸。',
  '空气里飘着一丝杏仁水的味道，但附近并没有瓶子。',
  '远处传来低沉的嗡鸣，比灯管的声音低八度。',
  '你数了数墙上的污渍，第十二块污渍在你数它的时候移动了。',
];
const FAKE_FEAR = [
  '灯光突然熄灭两秒——黑暗里有东西在呼吸。',
  '走廊尽头的轮廓朝你走了两步，然后消失了。',
  '墙壁上渗出墨绿色的液体，写着你的名字。',
  '远处传来一声尖叫，随即被寂静吞没。',
  '有什么东西在你耳边低语，说的是你不懂的语言——但你确定它在叫你的名字。',
  '你的影子比你慢了一步。你停下来，它也停了。可它停的位置不对。',
  '地毯上出现一行湿脚印，正朝你走来。脚印很小，像婴儿的。',
  '灯管猛地亮起，照亮了一张贴着墙的笑脸。灯灭时，它还在那里。',
  '身后传来玻璃碎裂的声音，你回头——满地都是碎玻璃，但没有窗户。',
  '空气突然变得很冷，你呼出的气变成了白雾。这里的温度从来没有变过。',
];
const FAKE_COLLAPSE = [
  '你看见墙上写满了「跑」。字迹是你的。',
  '房间的角落有个人形轮廓，它没有脸，但它在对你笑。',
  '地板裂开了，裂缝里不是黑暗，而是一排排的荧光灯——另一个后室。',
  '你听见自己的心跳变成了敲门声，一下，两下，一下。',
  '天花板低下来了。你伸手，够得到它了。',
  '你数不清走廊有多少扇门了。刚才还是十二扇，现在是十三扇，现在是……数不清。',
  '有什么东西握住了你的脚踝。你没有低头看。',
  '世界安静了一秒。你希望它永远安静下去。',
];

/** 理智四阶段：>50 平静 / 30-50 不安 / 15-30 恐惧 / <15 崩溃 */
function updateSanityPhase(state, events) {
  const s = state.player.sanity;
  const phase = s > 50 ? 'calm' : s > 30 ? 'uneasy' : s > 15 ? 'fear' : 'collapse';
  if (phase !== state.sanityPhase) {
    const msg = {
      calm: '你的心绪平静下来。',
      uneasy: '不安开始蔓延……你总觉得有什么在看着你。',
      fear: '恐惧攫住了你。噪音被放大，视野开始失真。',
      collapse: '你的理智正在崩溃。你控制不住自己……',
    }[phase];
    events.push({ text: msg, kind: 'sanity' });
    state.sanityPhase = phase;
  }
  state.fear = phase === 'fear' || phase === 'collapse';
  if (phase === 'uneasy' && chance(state.rng, 0.12)) {
    events.push({ text: pick(state.rng, FAKE_UNEASY), kind: 'sanity', hallucination: true });
  } else if (phase === 'fear' && chance(state.rng, 0.18)) {
    events.push({ text: pick(state.rng, FAKE_FEAR), kind: 'sanity', hallucination: true });
  } else if (phase === 'collapse' && chance(state.rng, 0.25)) {
    events.push({ text: pick(state.rng, FAKE_COLLAPSE), kind: 'sanity', hallucination: true });
  }
}

function checkDeath(state, events) {
  const { player } = state;
  if (player.hp <= 0) {
    state.over = 'dead';
    state.deathCause = state.lastAttackerName ? `被${state.lastAttackerName}杀死` : '因伤死亡';
    pushLog(state, `你死了。${state.deathCause}`, 'death');
    recordDeath(state);
    events.push({ text: `你死了——${state.deathCause}。`, kind: 'death' });
  } else if (player.sanity <= 0) {
    state.over = 'assimilated';
    state.deathCause = '理智崩溃，被层级同化';
    pushLog(state, '你的理智归零。你被后室同化了。', 'death');
    recordDeath(state);
    events.push({ text: '你的理智归零——你被层级同化了。', kind: 'death' });
  }
}

function recordDeath(state) {
  state.codex.deaths.push({
    turn: state.turn,
    level: state.levelId,
    cause: state.deathCause,
  });
  if (state.codex.levels[state.levelId]) {
    state.codex.levels[state.levelId].deaths++;
  }
}

// ---------- 存档序列化 ----------

/** 序列化当前状态（Set → 数组，供 localStorage / 存档文件使用） */
export function serializeState(state) {
  const out = {
    v: 1,
    runSeed: state.runSeed,
    levelId: state.levelId,
    previousLevelId: state.previousLevelId,
    turn: state.turn,
    over: state.over,
    deathCause: state.deathCause,
    lastAttackerName: state.lastAttackerName,
    sanityPhase: state.sanityPhase,
    fear: state.fear,
    player: { ...state.player },
    log: state.log,
    codex: state.codex,
    lastNoise: { ...state.lastNoise },
    explored: setsToArrays(state.explored),
    discoveredExits: setsToArrays(state.discoveredExits),
    seenSetPieces: setsToArrays(state.seenSetPieces),
    unlockedDoors: [...(state.unlockedDoors || [])],
    achievements: [...(state.achievements || [])],
    stats: state.stats,
  };
  // 无限层：记录已取/已杀集合（chunk 内容确定性，重放即可重建）
  if (state.level && state.level.infinite) {
    out.inf = {
      ti: [...state.level.takenItems],
      de: [...state.level.deadEntities],
      pcx: state.level.playerChunkX,
      pcy: state.level.playerChunkY,
    };
  }
  return out;
}

/** 反序列化：state 必须已用 createGame 创建（含 levels 注册表） */
export function deserializeState(state, data) {
  state.runSeed = data.runSeed;
  state.turn = data.turn;
  state.over = data.over;
  state.deathCause = data.deathCause || null;
  state.lastAttackerName = data.lastAttackerName || null;
  state.sanityPhase = data.sanityPhase || 'calm';
  state.fear = !!data.fear;
  state.log = data.log || [];
  state.codex = data.codex || { levels: {}, deaths: [], notes: [] };
  state.lastNoise = data.lastNoise || { level: 0, x: 0, y: 0 };
  state.explored = arraysToSets(data.explored);
  state.discoveredExits = arraysToSets(data.discoveredExits);
  state.seenSetPieces = arraysToSets(data.seenSetPieces);
  state.unlockedDoors = new Set(data.unlockedDoors || []);
  state.achievements = new Set(data.achievements || []);
  state.stats = Object.assign(
    { itemsPicked: 0, keysUsed: 0, exitsUsed: 0, levelsTurns: {}, visited: {} },
    data.stats || {}
  );
  enterLevel(state, data.levelId || 'level-0', { keepPlayer: true });
  if (data.player) Object.assign(state.player, data.player);
  // 无限层：恢复取走/击杀集合并刷新激活集（chunk 瓦片确定性重放）
  if (data.inf && state.level && state.level.infinite) {
    state.level.takenItems = new Set(data.inf.ti || []);
    state.level.deadEntities = new Set(data.inf.de || []);
    state.level.playerChunkX = data.inf.pcx || 0;
    state.level.playerChunkY = data.inf.pcy || 0;
    updateActiveChunks(state.level, state.player.x, state.player.y);
  }
  return state;
}

function setsToArrays(map) {
  const out = {};
  for (const k of Object.keys(map || {})) out[k] = Array.from(map[k]);
  return out;
}

function arraysToSets(map) {
  const out = {};
  for (const k of Object.keys(map || {})) out[k] = new Set(map[k]);
  return out;
}

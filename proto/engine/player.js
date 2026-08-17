// engine/player.js
// 玩家属性/状态/动作实现：移动、奔跑、搜索、拾取、使用物品、休息、战斗、潜行、手电、出口、查看、笔记。
// 回合经济：移动 1 体力、奔跑 2 体力/格（2 格）、战斗 20、搜索 2、休息回复。

import { randInt, chance, pick, DIRS } from './rng.js';
import { ENTITY_DEFS } from './entities.js';
import { tileAt } from './generator.js';

/** 物品元数据（名称/图标/描述） */
export const ITEM_META = {
  'almond-water': { name: '杏仁水', emoji: '💧', desc: '恢复 25 理智与 15 生命。后室最珍贵的水。' },
  'royal-ration': { name: '皇家口粮', emoji: '🥫', desc: '恢复 30 体力与 5 生命。' },
  battery: { name: '电池', emoji: '🔋', desc: '为手电补充 50 电量。' },
  flashlight: { name: '手电筒', emoji: '🔦', desc: '打开后照亮周围，视野半径 +2。' },
  crowbar: { name: '撬棍', emoji: '🔧', desc: '战斗伤害提升至 20-30（体力消耗 20/次）。' },
  medkit: { name: '医疗包', emoji: '🩹', desc: '恢复 40 生命。' },
  note: { name: '便签', emoji: '📝', desc: '一张泛黄的便签，读后会写进探索日志。' },
  key: { name: '钥匙', emoji: '🗝️', desc: '一把旧钥匙。锁着的门也许用得上。' },
  'liquid-pain': { name: '痛苦之液', emoji: '🧪', desc: '来历不明的镇痛液：+15 生命，但 -20 理智。' },
};

/** 天赋池：坠入后室时随机获得的能力（"一定概率刷出"） */
export const TALENTS = {
  // 生存类
  strong: { name: '强健体魄', desc: '生命上限 +15。' },
  calm: { name: '心如止水', desc: '理智侵蚀减半。' },
  'night-eye': { name: '夜视', desc: '视野半径 +1。' },
  runner: { name: '疾步', desc: '奔跑体力消耗减半。' },
  healer: { name: '自愈体质', desc: '每回合恢复 1 生命。' },
  lucky: { name: '幸运儿', desc: '受实体攻击时 25% 概率落空。' },
  scavenger: { name: '拾荒本能', desc: '搜索时 25% 概率在附近发现物品。' },
  hardy: { name: '铁胃', desc: '食物与药品恢复效果 +50%。' },
  fearless: { name: '无畏', desc: '理智侵蚀 -20%，幻觉更少。' },
  guide: { name: '引路者', desc: '出口罗盘始终显示精确距离。' },
  // 攻击性
  fighter: { name: '斗士', desc: '战斗伤害 +50%。' },
  hunter: { name: '猎手', desc: '15% 概率造成致命一击（伤害翻倍）。' },
  grim: { name: '冷酷', desc: '击杀实体恢复 10 理智。' },
  // 防御性
  armored: { name: '铁壁', desc: '受到的伤害 -25%。' },
  endure: { name: '硬皮', desc: '单次受击最多损失 8 生命。' },
  laststand: { name: '背水一战', desc: '生命低于 30% 时受到的伤害减半。' },
  // 空间性（后室风味：空间异常天赋）
  phase: { name: '相位穿梭', desc: '移动时可以穿过实体占据的格子。' },
  anchor: { name: '空间锚点', desc: '死亡时有 30% 概率被空间拽回（本局一次，恢复 30 生命/理智）。' },
  shortcut: { name: '捷径', desc: '穿越传送门不再消耗理智。' },
  // 探测性
  hawkeye: { name: '鹰眼', desc: '搜索发现隐藏出口的距离 +1，潜伏者现形范围 +1。' },
  hearing: { name: '顺风耳', desc: '每回合自动感知周围的潜伏者。' },
  instinct: { name: '第六感', desc: '警觉实体接近 8 格内时自动预警。' },
};

/** 创建玩家（attrs: { hpMax, sanityMax, staminaMax, talent }） */
export function createPlayer(x, y, attrs = {}) {
  const hpMax = attrs.hpMax || 100;
  const sanityMax = attrs.sanityMax || 100;
  const staminaMax = attrs.staminaMax || 100;
  return {
    x,
    y,
    hp: hpMax,
    sanity: sanityMax,
    stamina: staminaMax,
    hpMax,
    sanityMax,
    staminaMax,
    talent: attrs.talent || null,
    inventory: ['flashlight'], // 初始自带一支手电（默认关闭）
    weapon: null,
    flashlight: false,
    battery: 100,
    batteryFrac: 0,
    sneak: false,
  };
}

/** 旧存档兼容：补齐属性上限与天赋字段 */
export function normalizePlayer(p) {
  if (!p) return p;
  p.hpMax = p.hpMax || 100;
  p.sanityMax = p.sanityMax || 100;
  p.staminaMax = p.staminaMax || 100;
  p.talent = p.talent || null;
  p.hp = Math.min(p.hpMax, Math.max(0, p.hp));
  p.sanity = Math.min(p.sanityMax, Math.max(0, p.sanity));
  p.stamina = Math.min(p.staminaMax, Math.max(0, p.stamina));
  return p;
}

/** 视野半径：随层级光照与手电变化（夜视天赋 +1） */
export function viewRadiusOf(level, player) {
  const base = { bright: 9, dim: 7, flickering: 7, dark: 5, pitch: 3 }[level.light] ?? 6;
  const extra = player && player.talent === 'night-eye' ? 1 : 0;
  return base + (player && player.flashlight ? 2 : 0) + extra;
}

/** 瓦片是否"亮"：bright/flickering 层级常亮；否则手电半径 5 内亮 */
export function isLitTile(level, player, x, y) {
  if (level.light === 'bright' || level.light === 'flickering') return true;
  if (player && player.flashlight) {
    const d = Math.max(Math.abs(x - player.x), Math.abs(y - player.y));
    if (d <= 5) return true;
  }
  return false;
}

/** 追加日志（带 300 条上限），同时导出给 game.js 使用 */
export function pushLog(state, text, kind = 'system') {
  state.log.push({ turn: state.turn, text, kind });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function inBounds(level, x, y) {
  if (level.infinite) return true;
  return x >= 0 && y >= 0 && x < level.width && y < level.height;
}

/**
 * 执行一个玩家动作，返回事件数组。
 * 动作类型：move/run/search/take/use/rest/fight/sneak/light/exit/noclip/look/note
 */
export function applyPlayerAction(state, action, world) {
  const { level, player } = state;
  const events = [];
  const type = action.type;

  switch (type) {
    case 'move':
    case 'run': {
      const isRun = type === 'run';
      if (isRun && player.sneak) {
        player.sneak = false;
        events.push({ text: '你开始奔跑，潜行被打破了。', kind: 'system' });
      }
      const steps = isRun ? 2 : 1;
      const ok = tryMove(state, world, action.dx, action.dy, events, {
        run: isRun,
        steps,
        noise: isRun ? 3 : player.sneak ? 0 : 1,
      });
      if (!ok && steps === 2) {
        // 奔跑第二步失败不报错（第一步已成功），仅记录
        events.push({ text: '奔跑被阻挡，你停了下来。', kind: 'system' });
      }
      break;
    }

    case 'search': {
      if (player.stamina < 2) {
        events.push({ text: '体力不足，无法搜索。', kind: 'system' });
        break;
      }
      player.stamina -= 2;
      // 鹰眼天赋：发现隐藏出口的距离 +1
      const searchRange = player.talent === 'hawkeye' ? 2 : 1;
      const found = [];
      for (const ex of level.exits) {
        if (ex.hidden && !state.discoveredExits[state.levelId].has(level.exits.indexOf(ex))) {
          const d = Math.abs(ex.x - player.x) + Math.abs(ex.y - player.y);
          if (d <= searchRange) {
            state.discoveredExits[state.levelId].add(level.exits.indexOf(ex));
            found.push(ex);
          }
        }
      }
      if (found.length > 0) {
        for (const ex of found) {
          events.push({ text: `你发现了隐藏出口：${ex.description}`, kind: 'found' });
        }
      } else {
        events.push({ text: '你仔细搜索了周围，没有发现隐藏的出口。', kind: 'system' });
      }
      // 搜索也会让潜伏者现形（鹰眼 +1 范围）
      revealNearby(state, world, events, player.talent === 'hawkeye' ? 3 : 2);
      // 触发相邻 setPieces
      triggerSetPieces(state, events, 1);
      // 拾荒本能天赋：25% 概率在相邻可行走格发现一件物品（附近无物品时才触发）
      if (player.talent === 'scavenger' && chance(state.rng, 0.25)) {
        const pool = state.levels[state.levelId] && state.levels[state.levelId].items;
        const hasNearby = state.items.some((it) => Math.abs(it.x - player.x) + Math.abs(it.y - player.y) <= 1);
        if (!hasNearby && pool && pool.length > 0) {
          const spots = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          const free = spots.find(([dx, dy]) => tileAt(level, player.x + dx, player.y + dy) !== '#');
          if (free) {
            state.items.push({
              id: 'scav:' + state.turn + ':' + (state.items.length % 97),
              chunkKey: level.infinite ? Math.floor(player.x / 16) + ',' + Math.floor(player.y / 16) : null,
              x: player.x + free[0],
              y: player.y + free[1],
              type: pick(state.rng, pool),
            });
            events.push({ text: '你的拾荒本能让你在角落里发现了一点东西。', kind: 'item' });
          }
        }
      }
      break;
    }

    case 'take': {
      const idx = state.items.findIndex(
        (it) => Math.abs(it.x - player.x) + Math.abs(it.y - player.y) <= 1
      );
      if (idx < 0) {
        events.push({ text: '附近没有可拾取的物品。', kind: 'system' });
        break;
      }
      const it = state.items.splice(idx, 1)[0];
      if (level.infinite && it.id) level.takenItems.add(it.id);
      player.inventory.push(it.type);
      state.stats.itemsPicked = (state.stats.itemsPicked || 0) + 1;
      const meta = ITEM_META[it.type] || { name: it.type };
      events.push({ text: `拾取了 ${meta.name}。`, kind: 'item' });
      break;
    }

    case 'use': {
      const itemName = action.item;
      if (!itemName) {
        events.push({ text: `用法：use <物品>。当前物品：${player.inventory.join('、')}`, kind: 'system' });
        break;
      }
      const idx = player.inventory.indexOf(itemName);
      if (idx < 0) {
        events.push({ text: `你没有 ${itemName}。`, kind: 'system' });
        break;
      }
      useItem(state, world, events, itemName, idx);
      break;
    }

    case 'rest': {
      player.stamina = Math.min(player.staminaMax || 100, player.stamina + 30);
      const lit = isLitTile(level, player, player.x, player.y);
      if (lit) {
        player.sanity = Math.min(player.sanityMax || 100, player.sanity + 8);
        events.push({ text: '你在光亮处休息了一会儿，恢复体力，理智也稳住了。（+30 体力，+8 理智）', kind: 'item' });
      } else {
        events.push({ text: '你在黑暗中休息了一会儿，恢复体力。（+30 体力）', kind: 'item' });
      }
      break;
    }

    case 'fight': {
      doFight(state, world, events);
      break;
    }

    case 'sneak': {
      player.sneak = !player.sneak;
      events.push({
        text: player.sneak ? '你压低身形，开始潜行（移动不再发出声音）。' : '你恢复了正常行走。',
        kind: 'system',
      });
      break;
    }

    case 'light': {
      if (!player.flashlight) {
        if (player.battery <= 0) {
          events.push({ text: '手电没电了。你需要电池。', kind: 'system' });
        } else {
          player.flashlight = true;
          events.push({ text: '你打开了手电。光引来了某些东西，也吓退了另一些。', kind: 'item' });
        }
      } else {
        player.flashlight = false;
        events.push({ text: '你关掉了手电。黑暗重新涌来。', kind: 'item' });
      }
      break;
    }

    case 'exit':
    case 'noclip': {
      // 使用出口：玩家所在格或相邻格
      let target = null;
      for (const ex of level.exits) {
        const d = Math.abs(ex.x - player.x) + Math.abs(ex.y - player.y);
        if (d <= 1) {
          target = ex;
          break;
        }
      }
      if (!target) {
        events.push({ text: '附近没有出口。', kind: 'system' });
        break;
      }
      if (target.hidden && !state.discoveredExits[state.levelId].has(level.exits.indexOf(target))) {
        events.push({ text: '这里似乎藏着什么……但你还找不到。（试试 search）', kind: 'system' });
        break;
      }
      events.push({ text: `你穿过${target.description}`, kind: 'level' });
      state.stats.exitsUsed = (state.stats.exitsUsed || 0) + 1;
      state.pendingExit = { exit: target };
      break;
    }

    case 'look': {
      // 免费动作：查看周围（皮行者仅在此时现形），并触发附近场景
      world.looking = true;
      revealNearby(state, world, events, viewRadiusOf(level, player) + 2);
      triggerSetPieces(state, events, 2);
      // Fandom 细节：直视笑魇是危险的——LOS 内（≤6 格）有 smiler 时理智受创，它还会被激怒
      // （直接改 state.entities：look 是免费动作，world 是每回合的临时副本）
      const smilers = (state.entities || []).filter(
        (e) => e.type === 'smiler' && e.hp > 0 && Math.abs(e.x - player.x) + Math.abs(e.y - player.y) <= 6
      );
      if (smilers.length > 0) {
        player.sanity = Math.max(0, player.sanity - 5);
        for (const s of smilers) s.alert = true;
        events.push({ text: '你直视了它。它在笑。它记住了你。（-5 理智）', kind: 'sanity' });
      }
      if (chance(world.rng, 0.35)) {
        const pool = (level.soundscape && level.soundscape.ambient) || [];
        if (pool.length > 0) {
          events.push({ text: `你听到：${pick(world.rng, pool)}`, kind: 'ambient' });
        }
      }
      break;
    }

    case 'note': {
      // 免费动作：个人笔记，写入日志与 Codex
      const text = String(action.text || '').trim();
      if (text) {
        pushLog(state, `【笔记】${text}`, 'note');
        state.codex.notes.push({ turn: state.turn, level: state.levelId, text });
        events.push({ text: '笔记已写入探索日志。', kind: 'note' });
      }
      break;
    }

    default:
      events.push({ text: `未知动作：${type}`, kind: 'system' });
  }

  return events;
}

// ---------- 内部实现 ----------

/**
 * 尝试移动。opts: { run, steps, noise }
 * 返回是否至少移动了一步。
 */
function tryMove(state, world, dx, dy, events, opts) {
  const { level, player } = state;
  const looping = level.spaceRules.includes('looping') && !level.infinite;
  let moved = 0;
  let teleported = false;

  for (let s = 0; s < opts.steps; s++) {
    let nx = player.x + dx;
    let ny = player.y + dy;
    if (looping) {
      nx = mod(nx, level.width);
      ny = mod(ny, level.height);
    } else if (!inBounds(level, nx, ny)) {
      events.push({ text: '这里是边界，无法继续前进。', kind: 'system' });
      break;
    }

    const tile = tileAt(level, nx, ny);
    if (tile === '#') {
      events.push({ text: '墙挡住了你的去路。', kind: 'system' });
      break;
    }

    // 实体挡路（相位穿梭天赋：直接穿过去，轻微理智代价）
    const blocker = state.entities.find((e) => e.x === nx && e.y === ny && e.hp > 0);
    if (blocker) {
      if (player.talent === 'phase') {
        player.sanity = Math.max(0, player.sanity - 1);
        events.push({ text: '你的身体与空间错开了半拍——你从它身边穿了过去（-1 理智）。', kind: 'sanity' });
      } else {
        const def = ENTITY_DEFS[blocker.type] || {};
        if ((def.dmg || 0) === 0) {
          // 无害生物（飞蛾）：触碰掉理智
          player.sanity = Math.max(0, player.sanity - 1);
          events.push({ text: `你撞上了${def.name || blocker.type}，理智微微一颤。`, kind: 'sanity' });
        } else {
          events.push({ text: `${def.name || blocker.type}挡住了去路，你无法前进。`, kind: 'combat' });
        }
        break;
      }
    }

    // 体力消耗：水格 2，普通 1；奔跑加倍（疾步天赋奔跑不额外消耗）
    const water = tile === '~';
    const runMult = opts.run ? (player.talent === 'runner' ? 1 : 2) : 1;
    const cost = (water ? 2 : 1) * runMult;
    if (player.stamina < cost) {
      events.push({ text: '体力不足，无法继续前进。', kind: 'system' });
      break;
    }
    player.stamina -= cost;

    player.x = nx;
    player.y = ny;
    moved++;

    // 门（配对传送）：同层内通往"另一间房"——穿过门即传送到配对的另一扇门（非欧特性）
    if (!teleported && tile === 'D') {
      const links = level.doorLinks || [];
      const linkIdx = links.findIndex(
        (l) =>
          (l.x1 === player.x && l.y1 === player.y) || (l.x2 === player.x && l.y2 === player.y)
      );
      if (linkIdx >= 0) {
        const link = links[linkIdx];
        const unlockKey = `${state.levelId}:${linkIdx}`;
        if (link.locked && !state.unlockedDoors.has(unlockKey)) {
          const keyIdx = player.inventory.indexOf('key');
          if (keyIdx < 0) {
            events.push({ text: '门锁着。你需要一把钥匙。', kind: 'system' });
          } else {
            player.inventory.splice(keyIdx, 1);
            state.unlockedDoors.add(unlockKey);
            state.stats.keysUsed = (state.stats.keysUsed || 0) + 1;
            events.push({ text: '钥匙咔哒一声，门开了。', kind: 'item' });
            const destIsFirst = link.x1 === player.x && link.y1 === player.y;
            player.x = destIsFirst ? link.x2 : link.x1;
            player.y = destIsFirst ? link.y2 : link.y1;
            teleported = true;
            if (player.talent !== 'shortcut') player.sanity = Math.max(0, player.sanity - 2);
            events.push({ text: '你推开一扇门……门后竟是另一个房间。', kind: 'level' });
          }
        } else {
          const destIsFirst = link.x1 === player.x && link.y1 === player.y;
          const tx = destIsFirst ? link.x2 : link.x1;
          const ty = destIsFirst ? link.y2 : link.y1;
          const blocked = state.entities.some((e) => e.x === tx && e.y === ty && e.hp > 0);
          if (!blocked && tileAt(level, tx, ty) !== '#') {
            player.x = tx;
            player.y = ty;
            teleported = true;
            if (player.talent !== 'shortcut') player.sanity = Math.max(0, player.sanity - 2);
            events.push({ text: '你推开一扇门……门后竟是另一个房间。', kind: 'level' });
          } else {
            events.push({ text: '门吱呀作响，但另一侧被堵住了。', kind: 'system' });
          }
        }
      }
    }

    // 记录噪音（供猎犬/抓挠者听声）
    state.lastNoise = { level: opts.noise, x: player.x, y: player.y };

    // 传送门（non-euclidean）
    if (!teleported && tile === 'T') {
      const pair = level.portals.find(
        (p) =>
          (p[0].x === player.x && p[0].y === player.y) || (p[1].x === player.x && p[1].y === player.y)
      );
      if (pair) {
        const other = pair[0].x === player.x && pair[0].y === player.y ? pair[1] : pair[0];
        const blocked = state.entities.some((e) => e.x === other.x && e.y === other.y && e.hp > 0);
        if (!blocked) {
          player.x = other.x;
          player.y = other.y;
          teleported = true;
          events.push({ text: '空间扭曲了——你出现在另一处走廊。', kind: 'level' });
        } else {
          events.push({ text: '传送门嗡嗡作响，但另一头被堵住了。', kind: 'system' });
        }
      }
    }

    // 自动拾取脚下物品
    const itemIdx = state.items.findIndex((it) => it.x === player.x && it.y === player.y);
    if (itemIdx >= 0) {
      const it = state.items.splice(itemIdx, 1)[0];
      player.inventory.push(it.type);
      const meta = ITEM_META[it.type] || { name: it.type };
      events.push({ text: `你踩到并拾取了 ${meta.name}。`, kind: 'item' });
    }

    // 踩上出口 → 自动发现（隐藏出口同理）
    for (let i = 0; i < level.exits.length; i++) {
      const ex = level.exits[i];
      if (ex.x === player.x && ex.y === player.y && ex.hidden) {
        if (!state.discoveredExits[state.levelId].has(i)) {
          state.discoveredExits[state.levelId].add(i);
          events.push({ text: `你踩到了什么——一个隐藏出口！${ex.description}`, kind: 'found' });
        }
      }
    }

    // 触发脚下 setPiece
    triggerSetPieces(state, events, 0);
  }

  return moved > 0;
}

/** 触发玩家周围 radius 内的未触发 setPieces */
function triggerSetPieces(state, events, radius) {
  const { level, player } = state;
  const seen = state.seenSetPieces[state.levelId];
  for (let i = 0; i < level.setPieces.length; i++) {
    const sp = level.setPieces[i];
    if (seen.has(i)) continue;
    const d = Math.abs(sp.x - player.x) + Math.abs(sp.y - player.y);
    if (d <= radius) {
      seen.add(i);
      if (sp.sanityEffect) {
        player.sanity = Math.max(0, Math.min(100, player.sanity + sp.sanityEffect));
        events.push({
          text: `【场景】${sp.text}（理智 ${sp.sanityEffect > 0 ? '+' : ''}${sp.sanityEffect}）`,
          kind: 'sanity',
        });
      } else {
        events.push({ text: `【场景】${sp.text}`, kind: 'found' });
      }
      if (sp.note) {
        pushLog(state, sp.note, 'note');
        const entry = state.codex.levels[state.levelId];
        if (entry) entry.notes.push(sp.note);
      }
    }
  }
}

/** 让视野/搜索范围内的潜伏者现形（皮行者、抓挠者）；导出供顺风耳天赋使用 */
export function revealNearby(state, world, events, radius) {
  const { level, player } = state;
  for (const e of state.entities) {
    if (e.hp <= 0) continue;
    const stealthy = e.type === 'skin-stealer' || e.type === 'scratcher';
    if (!stealthy || e.visible) continue;
    const d = Math.abs(e.x - player.x) + Math.abs(e.y - player.y);
    if (d <= radius) {
      e.visible = true;
      const def = ENTITY_DEFS[e.type] || {};
      events.push({ text: `你仔细看去——${def.name || e.type}就在那里！`, kind: 'entity' });
    }
  }
}

/** 战斗：攻击相邻最近的实体 */
function doFight(state, world, events) {
  const { player } = state;
  const target = state.entities
    .filter((e) => e.hp > 0 && Math.abs(e.x - player.x) + Math.abs(e.y - player.y) <= 1)
    .sort((a, b) => {
      const da = Math.abs(a.x - player.x) + Math.abs(a.y - player.y);
      const db = Math.abs(b.x - player.x) + Math.abs(b.y - player.y);
      return da - db;
    })[0];

  if (!target) {
    events.push({ text: '附近没有可攻击的目标。', kind: 'combat' });
    return;
  }
  if (player.stamina < 20) {
    events.push({ text: '体力不足，无法战斗（需要 20 体力）。', kind: 'system' });
    return;
  }
  player.stamina -= 20;
  const def = ENTITY_DEFS[target.type] || {};
  let dmg = player.weapon === 'crowbar' ? randInt(world.rng, 20, 30) : randInt(world.rng, 5, 10);
  let crit = false;
  if (player.talent === 'fighter') dmg = Math.floor(dmg * 1.5);
  if (player.talent === 'hunter' && chance(world.rng, 0.15)) {
    dmg *= 2;
    crit = true;
  }
  target.hp -= dmg;
  const weaponName = player.weapon === 'crowbar' ? '撬棍' : '徒手';
  events.push({
    text: `你用${weaponName}攻击${def.name || target.type}（-${dmg} HP）${crit ? '——致命一击！' : ''}。`,
    kind: 'combat',
  });

  // 战斗噪音（3 格内可被听见）
  state.lastNoise = { level: 3, x: player.x, y: player.y };

  if (target.hp <= 0) {
    events.push({ text: `你杀死了${def.name || target.type}！`, kind: 'combat' });
    target.hp = 0;
    // 冷酷天赋：击杀恢复理智
    if (player.talent === 'grim') {
      player.sanity = Math.min(player.sanityMax || 100, player.sanity + 10);
      events.push({ text: '你面无表情地补上最后一击。恐惧没有追上你（+10 理智）。', kind: 'sanity' });
    }
    return;
  }

  // 反击
  if (def.dmg > 0) {
    player.hp = Math.max(0, player.hp - def.dmg);
    if (world.recordAttack) world.recordAttack(def.name || target.type);
    events.push({ text: `${def.name || target.type}反击了你（-${def.dmg} HP）！`, kind: 'combat' });
  }
  // 特殊反噬
  if (target.type === 'insanity' && def.backlashSanity) {
    player.sanity = Math.max(0, player.sanity + def.backlashSanity);
    events.push({ text: '攻击"疯狂"让你的理智遭到反噬（-10 理智）！', kind: 'sanity' });
  }
  if (target.type === 'faceling') {
    for (const e of state.entities) {
      if (e.type === 'faceling' && e.hp > 0) e.alert = true;
    }
    events.push({ text: '你打了假面——周围的假面都"微笑"着看向你。', kind: 'entity' });
  }
}

/** 使用物品 */
function useItem(state, world, events, itemName, invIdx) {
  const { player } = state;
  // 铁胃天赋：食物与药品恢复 +50%（整数向下取整）
  const healMul = player.talent === 'hardy' ? 1.5 : 1;
  const clampMax = (v, max) => Math.max(0, Math.min(max || 100, v));
  switch (itemName) {
    case 'almond-water': {
      const s = Math.floor(25 * healMul);
      const h = Math.floor(15 * healMul);
      player.sanity = clampMax(player.sanity + s, player.sanityMax);
      player.hp = clampMax(player.hp + h, player.hpMax);
      player.inventory.splice(invIdx, 1);
      events.push({ text: `你喝下杏仁水。理智回归（+${s} 理智，+${h} 生命）。`, kind: 'item' });
      break;
    }
    case 'royal-ration': {
      const s = Math.floor(30 * healMul);
      const h = Math.floor(5 * healMul);
      player.stamina = clampMax(player.stamina + s, player.staminaMax);
      player.hp = clampMax(player.hp + h, player.hpMax);
      player.inventory.splice(invIdx, 1);
      events.push({ text: `你吃下皇家口粮（+${s} 体力，+${h} 生命）。`, kind: 'item' });
      break;
    }
    case 'battery': {
      player.battery = Math.min(100, player.battery + 50);
      player.inventory.splice(invIdx, 1);
      events.push({ text: '你给手电换了电池（电量 +50）。', kind: 'item' });
      break;
    }
    case 'medkit': {
      const h = Math.floor(40 * healMul);
      player.hp = clampMax(player.hp + h, player.hpMax);
      player.inventory.splice(invIdx, 1);
      events.push({ text: `你用医疗包处理了伤口（+${h} 生命）。`, kind: 'item' });
      break;
    }
    case 'flashlight': {
      if (player.inventory.filter((i) => i === 'flashlight').length > 1) {
        events.push({ text: '你已经有一支手电了。', kind: 'system' });
      } else {
        player.inventory.splice(invIdx, 1);
        player.flashlight = true;
        events.push({ text: '你拿起手电并打开。视野扩大了。', kind: 'item' });
      }
      break;
    }
    case 'crowbar': {
      player.weapon = 'crowbar';
      events.push({ text: '你握紧了撬棍，战斗伤害提升至 20-30。', kind: 'item' });
      break;
    }
    case 'note': {
      player.inventory.splice(invIdx, 1);
      pushLog(state, '你读了一张便签：『别相信眼睛看到的。还有，光不是朋友。』', 'note');
      const entry = state.codex.levels[state.levelId];
      if (entry) entry.notes.push('便签：别相信眼睛看到的。');
      events.push({ text: '你读了一张泛黄的便签，字迹潦草。', kind: 'item' });
      break;
    }
    case 'key': {
      // 钥匙：留在背包，用于解锁锁着的门（穿过门时自动消耗）
      events.push({ text: '一把旧钥匙。锁着的门也许用得上。', kind: 'system' });
      break;
    }
    case 'liquid-pain': {
      // 痛苦之液（Fandom：镇痛但侵蚀理智）
      player.inventory.splice(invIdx, 1);
      player.hp = clampMax(player.hp + Math.floor(15 * healMul), player.hpMax);
      player.sanity = Math.max(0, player.sanity - 20);
      events.push({ text: '液体灼烧你的喉咙，疼痛消失了——但有什么东西也跟着消失了。（+15 生命 / -20 理智）', kind: 'sanity' });
      break;
    }
    default:
      events.push({ text: `无法使用 ${itemName}。`, kind: 'system' });
  }
}

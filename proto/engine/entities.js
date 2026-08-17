// engine/entities.js
// 实体定义（Fandom 风格，简化实现）+ AI 行动更新。
// 11 种实体：moth/smiler/hound/partygoer/skin-stealer/clump/faceling/watcher/duller/insanity/scratcher。
// updateEntity(e, world) 修改实体自身状态并返回事件数组；world 由 game.js 注入（查 LOS/距离/玩家状态）。

import { tileAt } from './generator.js';

/** 实体定义表：行为、属性、感知 */
export const ENTITY_DEFS = {
  moth: {
    name: '飞蛾', char: 'm', emoji: '🦋', hp: 10, dmg: 0, sight: 0, hears: 0, speed: 1,
    behavior: 'wander', touchSanity: -1,
    desc: '无害的飞蛾。触碰它，你的理智会微微流失。',
  },
  smiler: {
    name: '笑魇', char: 'S', emoji: '😬', hp: 60, dmg: 15, sight: 5, hears: 0, speed: 1,
    behavior: 'dark-chase', fearLight: true,
    desc: '在黑暗中露出微笑的东西。光，能让它退避。',
  },
  hound: {
    name: '猎犬', char: 'H', emoji: '🐕', hp: 50, dmg: 12, sight: 0, hears: 3, speed: 2,
    behavior: 'noise-chase',
    desc: '被声音吸引的掠食者。不要跑。',
  },
  partygoer: {
    name: '派对客', char: 'G', emoji: '🎉', hp: 70, dmg: 18, sight: 4, hears: 0, speed: 1,
    behavior: 'lit-ambush',
    desc: '伪装友善的东西，在光亮处伏击。',
  },
  'skin-stealer': {
    name: '皮行者', char: '?', emoji: '🕴️', hp: 40, dmg: 20, sight: 0, hears: 0, speed: 1,
    behavior: 'stealth-ambush',
    desc: '只有你"查看"时才会现形。它一直在你附近。',
  },
  clump: {
    name: '团块', char: 'C', emoji: '🟤', hp: 120, dmg: 10, sight: 2, hears: 0, speed: 0.5,
    behavior: 'slow-wander',
    desc: '巨大的血肉团块。缓慢、沉重，挡在路上。',
  },
  faceling: {
    name: '假面', char: 'F', emoji: '🙂', hp: 30, dmg: 8, sight: 3, hears: 0, speed: 1,
    behavior: 'civilian',
    desc: '城市里的"居民"。被打、或你理智过低时，它会翻脸。',
  },
  watcher: {
    name: '注视者', char: 'W', emoji: '👁️', hp: 50, dmg: 5, sight: 6, hears: 0, speed: 0,
    behavior: 'watch',
    desc: '远处注视着你。视线范围内，每回合侵蚀 4 点理智。',
  },
  duller: {
    name: '电灯', char: 'D', emoji: '💡', hp: 45, dmg: 10, sight: 5, hears: 0, speed: 1,
    behavior: 'light-attract',
    desc: '被光照吸引的东西。你开手电时，它会追来。',
  },
  insanity: {
    name: '疯狂', char: 'i', emoji: '🌀', hp: 20, dmg: 10, sight: 2, hears: 0, speed: 1,
    behavior: 'madness', touchSanity: -5, backlashSanity: -10,
    desc: '逼近时侵蚀你的理智。攻击它，你会反噬。',
  },
  scratcher: {
    name: '抓挠者', char: 's', emoji: '🐾', hp: 55, dmg: 14, sight: 0, hears: 2, speed: 1,
    behavior: 'lurk-chase',
    desc: '潜伏的听觉猎手。靠近它，它才会暴露。',
  },
  deathmoth: {
    name: '死亡飞蛾', char: 'M', emoji: '🦇', hp: 25, dmg: 10, sight: 2, hears: 0, speed: 2,
    behavior: 'swarm-attack',
    desc: '巨大的致命飞蛾。它们很少单独出现——发现你时，会呼朋引伴。',
  },
  glowfolk: {
    name: '发光者', char: 'g', emoji: '✨', hp: 30, dmg: 0, sight: 4, hears: 0, speed: 1,
    behavior: 'guider',
    desc: '温和的发光人形。它会试着为你引路——三次之后，它会指出一条隐藏的路。',
  },
};

function mod(n, m) {
  return ((n % m) + m) % m;
}

const DIRS4 = [
  { dx: 0, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 0 },
];

/**
 * 更新一个实体的回合行动。
 * world 需要提供：
 *   level / player / entities / rng / turn / noise / looking
 *   dist(x1,y1,x2,y2)  hasLos(x1,y1,x2,y2)  isWalkable(x,y,self)  isLit(x,y)
 *   recordAttack(name)（记录最近攻击者，用于死亡结算）
 * 返回事件数组（空数组表示无事发生）。
 */
export function updateEntity(e, world) {
  const { level, player, entities, rng, dist, hasLos, isWalkable, isLit, noise, looking } = world;
  const def = ENTITY_DEFS[e.type] || {};
  const events = [];
  const looping = level.spaceRules.includes('looping') && !level.infinite;

  const d = dist(e.x, e.y, player.x, player.y);
  const adjacent = d <= 1;
  const los = hasLos(e.x, e.y, player.x, player.y);
  const playerLit = isLit(player.x, player.y);
  const litHere = isLit(e.x, e.y);
  const noiseHere =
    noise.level > 0 && dist(e.x, e.y, noise.x, noise.y) <= (noise.level >= 3 ? 3 : 2);

  // 靠近玩家时，潜伏者现形（scratcher）
  if (e.type === 'scratcher' && !e.visible && (d <= 2 || noiseHere || looking)) {
    e.visible = true;
    events.push({ text: '黑暗中有东西暴露了身形——一只抓挠者！', kind: 'entity' });
  }

  let wantsAttack = false;

  // ---------- 按行为决策 ----------
  const behavior = def.behavior || 'wander';
  switch (behavior) {
    case 'wander': {
      // 飞蛾：被动游荡
      if (adjacent) {
        player.sanity += def.touchSanity || 0;
        events.push({ text: '一只飞蛾擦过你的脸，理智微微一颤。', kind: 'sanity' });
      }
      if (e.wait > 0) {
        e.wait--;
      } else {
        wanderStep(e, world, 1);
        e.wait = randInt(rng, 1, 3);
      }
      break;
    }

    case 'slow-wander': {
      // 团块：缓慢游荡、挡路；挨着就打
      if (adjacent) {
        wantsAttack = true;
        events.push({ text: '团块朝你压了过来！', kind: 'combat' });
      }
      if (e.wait > 0) {
        e.wait--;
      } else {
        wanderStep(e, world, 1);
        e.wait = randInt(rng, 2, 4);
      }
      break;
    }

    case 'civilian': {
      // 假面：被动居民；被打或玩家理智<30 时敌对
      const hostile = e.alert || player.sanity < 30;
      if (hostile) {
        if (d <= def.sight && los) {
          moveToward(e, world, def.speed);
          if (adjacent) wantsAttack = true;
        }
        if (!e.alert) {
          events.push({ text: '假面的笑容消失了。它开始逼近你。', kind: 'entity' });
          e.alert = true;
        }
      } else {
        // Fandom 细节：假面像普通人一样生活——偶尔会"打招呼"，让你怀疑自己是不是疯了
        if (d <= 3 && rng() < 0.05 && !e.greeted) {
          e.greeted = true;
          events.push({
            text: pick(rng, [
              '一个假面朝你点了点头，像在街上遇到熟人。你不认识它。',
              '假面对你说："今天天气不错。"这里没有天气。',
              '一个假面侧身给你让路，礼貌得可怕。',
              '假面停下来问你几点了。你没有手表，它也没有。',
            ]),
            kind: 'entity',
          });
        }
        if (e.wait > 0) e.wait--;
        else {
          if (rng() < 0.6) wanderStep(e, world, 1);
          e.wait = randInt(rng, 1, 3);
        }
      }
      break;
    }

    case 'dark-chase': {
      // 笑魇：黑暗中出现，LOS 追击；怕光（玩家亮处/自身亮处不追）
      if (def.fearLight && (playerLit || litHere)) {
        // 退避：远离玩家一步
        if (adjacent) moveAway(e, world, 1);
      } else if (d <= def.sight && los) {
        if (!e.alert) {
          e.alert = true;
          events.push({ text: '黑暗中浮现一张微笑的脸——笑魇！', kind: 'entity' });
        }
        moveToward(e, world, def.speed);
        if (adjacent) wantsAttack = true;
      } else {
        e.alert = false;
        if (e.wait > 0) e.wait--;
        else {
          wanderStep(e, world, 1);
          e.wait = randInt(rng, 1, 3);
        }
      }
      break;
    }

    case 'noise-chase': {
      // 猎犬：听声辨位，高速追击；群猎——一只警觉时附近同类同步警觉（Fandom 设定）
      if (noiseHere || (e.alert && d <= 6)) e.alert = true;
      if (e.alert && !e.packed) {
        e.packed = true;
        for (const other of world.entities) {
          if (other === e || other.hp <= 0 || other.type !== e.type) continue;
          const od = Math.abs(other.x - e.x) + Math.abs(other.y - e.y);
          if (od <= 5) other.alert = true; // 群猎警报传播
        }
      }
      if (e.alert) {
        if (d <= 6 || noiseHere) {
          moveToward(e, world, def.speed);
          if (adjacent) wantsAttack = true;
        } else {
          e.alert = false;
          e.packed = false;
        }
      } else if (e.wait > 0) {
        e.wait--;
      } else {
        wanderStep(e, world, 1);
        e.wait = randInt(rng, 1, 3);
      }
      break;
    }

    case 'lit-ambush': {
      // 派对客：光亮处伏击；玩家在亮处且 LOS 内则靠近
      if (playerLit && d <= def.sight && los) {
        if (!e.alert) {
          e.alert = true;
          events.push({ text: '派对客向你"友好"地挥手，笑容咧得太开了。', kind: 'entity' });
        }
        moveToward(e, world, def.speed);
        if (adjacent) {
          wantsAttack = true;
          // Fandom：派对客的微笑会侵蚀心智
          if (world.player) {
            world.player.sanity = Math.max(0, world.player.sanity - 2);
            events.push({ text: '派对客微笑着注视你。它的笑容在邀请你留下来。（-2 理智）', kind: 'sanity' });
          }
        }
      } else {
        e.alert = false;
        if (e.wait > 0) e.wait--;
        else {
          wanderStep(e, world, 1);
          e.wait = randInt(rng, 1, 4);
        }
      }
      break;
    }

    case 'stealth-ambush': {
      // 皮行者：仅"查看"可见；近身伏击
      if (adjacent) {
        e.visible = true;
        wantsAttack = true;
        events.push({ text: '皮行者从阴影中扑向你！', kind: 'combat' });
      } else if (looking && d <= 4 && los) {
        e.visible = true;
        events.push({ text: '你仔细看去——阴影里站着一个皮行者，正在学你的姿势。', kind: 'entity' });
        if (d > 1) moveToward(e, world, def.speed);
      } else if (e.visible && d <= 4 && los && d > 1) {
        moveToward(e, world, def.speed);
      }
      break;
    }

    case 'watch': {
      // 注视者：远处注视，LOS 内每回合 -4 理智；不近身
      if (d <= def.sight && los) {
        player.sanity -= 4;
        events.push({ text: '注视者的目光落在你身上，理智在流失……', kind: 'sanity' });
        if (adjacent) wantsAttack = true;
        else if (rng() < 0.15) wanderStep(e, world, 1); // 缓慢漂移
      }
      break;
    }

    case 'light-attract': {
      // 电灯：被光照吸引（玩家开手电时追）；黑暗中不主动
      if (playerLit && d <= def.sight + 2) {
        if (!e.alert) {
          e.alert = true;
          events.push({ text: '一盏"电灯"被你的光吸引，朝你漂了过来。', kind: 'entity' });
        }
        moveToward(e, world, def.speed);
        if (adjacent) wantsAttack = true;
      } else {
        e.alert = false;
        if (e.wait > 0) e.wait--;
        else {
          if (rng() < 0.3) wanderStep(e, world, 1);
          e.wait = randInt(rng, 2, 4);
        }
      }
      break;
    }

    case 'madness': {
      // 疯狂：相邻 -5 理智/回合；靠近即侵蚀
      if (adjacent) {
        player.sanity += def.touchSanity || 0;
        wantsAttack = true;
        events.push({ text: '疯狂贴着你低语，你的理智在剥落。', kind: 'sanity' });
      } else if (d <= def.sight && los) {
        moveToward(e, world, def.speed);
      } else if (e.wait > 0) {
        e.wait--;
      } else {
        wanderStep(e, world, 1);
        e.wait = randInt(rng, 1, 3);
      }
      break;
    }

    case 'lurk-chase': {
      // 抓挠者：潜伏；暴露后追击
      if (e.visible) {
        if (d <= def.sight + 3) {
          moveToward(e, world, def.speed);
          if (adjacent) wantsAttack = true;
        } else {
          e.visible = false; // 追丢后重新潜伏
        }
      } else if (noiseHere) {
        e.visible = true;
        events.push({ text: '你的动静惊动了潜伏的抓挠者！', kind: 'entity' });
      }
      break;
    }

    case 'swarm-attack': {
      // 死亡飞蛾：高速游荡；发现玩家后追击攻击（Fandom：群袭，极少单独出现）
      if (d <= def.sight && los) {
        if (!e.alert) {
          e.alert = true;
          events.push({ text: '一只巨大的飞蛾扑闪着翅膀，复眼里映着你的轮廓。', kind: 'entity' });
        }
        moveToward(e, world, def.speed);
        if (adjacent) wantsAttack = true;
      } else {
        e.alert = false;
        if (e.wait > 0) e.wait--;
        else {
          wanderStep(e, world, 1);
          e.wait = randInt(rng, 1, 2);
        }
      }
      break;
    }

    case 'guider': {
      // 发光者：温和引路者，永不攻击；三次指引后指出隐藏的路
      if (e.guideCount >= 3) {
        // 已给出关键指引：保持距离，继续发光
        if (d > 3 && rng() < 0.5) moveToward(e, world, 1);
        break;
      }
      if (adjacent) {
        e.guideCount = (e.guideCount || 0) + 1;
        const dir = ['北', '南', '东', '西'][randInt(rng, 0, 3)];
        if (e.guideCount >= 3) {
          events.push({
            text: `发光者停在墙边，身上的光聚成一条细线，指向${dir}方——那里似乎藏着一条路。`,
            kind: 'entity',
          });
        } else {
          events.push({ text: `发光者轻轻碰了碰你，朝${dir}方飘去，像在说：跟我来。`, kind: 'entity' });
        }
      } else if (d <= def.sight && rng() < 0.4) {
        moveToward(e, world, 1);
      } else if (e.wait > 0) {
        e.wait--;
      } else {
        wanderStep(e, world, 1);
        e.wait = randInt(rng, 1, 4);
      }
      break;
    }

    default: {
      if (e.wait > 0) e.wait--;
      else {
        wanderStep(e, world, 1);
        e.wait = randInt(rng, 1, 3);
      }
    }
  }

  // ---------- 结算攻击 ----------
  if (wantsAttack && d <= 1 && def.dmg > 0) {
    attackPlayer(world, events, def.dmg, def.name, def);
  }

  // 防止坐标越界（looping 已 wrap，非 looping 靠 isWalkable 保证；无限层无边界）
  if (!level.infinite) {
    e.x = mod(e.x, level.width);
    e.y = mod(e.y, level.height);
  }
  return events;
}

// ---------- 移动辅助 ----------

/** 朝玩家方向走一步（speed 可为 0.5，表示每两回合走一步，用累积刻度实现） */
function moveToward(e, world, speed) {
  const { player } = world;
  let steps = 0;
  if (speed >= 1) {
    steps = Math.round(speed);
  } else if (speed > 0) {
    // 小数速度：累积移动刻度，攒满 1 才真正走一格
    e._tick = (e._tick || 0) + speed;
    steps = Math.floor(e._tick);
    e._tick -= steps;
  }
  let moved = 0;
  while (moved < steps) {
    // 优先 BFS 寻路（能绕墙）；失败则退回贪心一步
    const step = pathStep(e, world) || greedyStep(e, world);
    if (!step) break;
    e.x = step.x;
    e.y = step.y;
    moved++;
  }
}

/** 贪心单步：优先走较远轴，被堵换另一轴 */
function greedyStep(e, world) {
  const { player } = world;
  const dx = Math.sign(player.x - e.x);
  const dy = Math.sign(player.y - e.y);
  if (dx === 0 && dy === 0) return null;
  let nx = e.x;
  let ny = e.y;
  if (dx !== 0 && dy !== 0) {
    if (Math.abs(dx) >= Math.abs(dy)) nx = e.x + dx;
    else ny = e.y + dy;
  } else if (dx !== 0) {
    nx = e.x + dx;
  } else {
    ny = e.y + dy;
  }
  if (world.isWalkable(nx, ny, e)) return { x: nx, y: ny };
  // 换另一轴
  const nx2 = dx !== 0 ? e.x : e.x + dx;
  const ny2 = dy !== 0 ? e.y : e.y + dy;
  if (world.isWalkable(nx2, ny2, e)) return { x: nx2, y: ny2 };
  return null;
}

/** 轻量 BFS 寻路：返回朝玩家的第一步；走不通返回 null */
function pathStep(e, world) {
  const { level, player } = world;
  const looping = level.spaceRules.includes('looping') && !level.infinite;
  const W = level.width;
  const H = level.height;
  const startKey = e.x + ',' + e.y;
  if (startKey === player.x + ',' + player.y) return null;
  const depthLimit = Math.max(16, Math.max(Math.abs(player.x - e.x), Math.abs(player.y - e.y)) + 6);
  const prev = new Map(); // key -> [px, py, dist]
  const seen = new Set([startKey]);
  const queue = [[e.x, e.y]];
  let head = 0;
  let found = null;
  while (head < queue.length) {
    const [x, y] = queue[head++];
    const key = x + ',' + y;
    const dist = prev.has(key) ? prev.get(key)[2] : 0;
    if (x === player.x && y === player.y) {
      found = key;
      break;
    }
    if (dist >= depthLimit) continue;
    for (const d of DIRS4) {
      let nx = x + d.dx;
      let ny = y + d.dy;
      if (looping) {
        nx = mod(nx, W);
        ny = mod(ny, H);
      } else if (!level.infinite && (nx < 0 || ny < 0 || nx >= W || ny >= H)) {
        continue;
      }
      const nk = nx + ',' + ny;
      if (seen.has(nk)) continue;
      if (tileAt(level, nx, ny) === '#') continue;
      // 目标格允许踩玩家（贴脸攻击），其余格需可走
      if (!(nx === player.x && ny === player.y) && !world.isWalkable(nx, ny, e)) continue;
      seen.add(nk);
      prev.set(nk, [x, y, dist + 1]);
      queue.push([nx, ny]);
    }
  }
  if (!found) return null;
  // 从目标回溯到起点，取第一步
  let cur = found;
  while (cur !== startKey) {
    const p = prev.get(cur);
    if (!p) return null;
    const parentKey = p[0] + ',' + p[1];
    if (parentKey === startKey) {
      const [fx, fy] = cur.split(',').map(Number);
      return { x: fx, y: fy };
    }
    cur = parentKey;
  }
  return null;
}

/** 远离玩家走一步（smiler 怕光退避） */
function moveAway(e, world, speed) {
  const { player, rng } = world;
  const dirs = [
    { dx: Math.sign(e.x - player.x), dy: 0 },
    { dx: 0, dy: Math.sign(e.y - player.y) },
  ];
  // 随机选一个能走的方向
  for (const d of rng() < 0.5 ? dirs : [dirs[1], dirs[0]]) {
    const nx = e.x + d.dx;
    const ny = e.y + d.dy;
    if (world.isWalkable(nx, ny, e)) {
      e.x = nx;
      e.y = ny;
      return;
    }
  }
}

/** 随机游荡一步 */
function wanderStep(e, world, speed) {
  const { rng } = world;
  const dirs = [
    { dx: 0, dy: -1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 0 },
  ];
  let moved = 0;
  while (moved < speed) {
    const d = dirs[Math.floor(rng() * dirs.length)];
    const nx = e.x + d.dx;
    const ny = e.y + d.dy;
    if (world.isWalkable(nx, ny, e)) {
      e.x = nx;
      e.y = ny;
      moved++;
    } else {
      break;
    }
  }
}

// ---------- 攻击结算 ----------

/** 实体攻击玩家：-dmg 生命；部分实体额外 -理智（幸运儿天赋 25% 落空，用引擎 rng 保确定性） */
function attackPlayer(world, events, dmg, name, def) {
  const { player } = world;
  if (player && player.talent === 'lucky' && world.rng && world.rng() < 0.25) {
    events.push({ text: `${name}扑向你，但你在最后一刻躲开了！`, kind: 'combat' });
    return;
  }
  player.hp = Math.max(0, player.hp - dmg);
  if (world.recordAttack) world.recordAttack(name);
  events.push({ text: `${name}攻击了你（-${dmg} HP）！`, kind: 'combat' });
  if (def && def.touchSanity && def.touchSanity < 0) {
    player.sanity += def.touchSanity;
    events.push({ text: `与${name}的接触侵蚀了你的理智。`, kind: 'sanity' });
  }
}

/** 供其他模块使用的随机整数（实体 AI 内部用） */
function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 从数组中随机取一个元素（实体 AI 内部用） */
function pick(rng, arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** 取实体显示字符 */
export function entityChar(type) {
  const def = ENTITY_DEFS[type];
  return def ? def.char : '?';
}

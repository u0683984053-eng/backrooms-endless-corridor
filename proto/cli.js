#!/usr/bin/env node
// cli.js — Node CLI 前端（node cli.js [seed]）
// 加载数据 + 渲染（可见半径 ASCII 地图 + 状态栏 + 事件日志）+ 命令解析。
// 命令：w/a/s/d 移动、run <方向>、look、search、take、use <物品>、rest、fight、
//       sneak、light、exit/noclip、log、note <文本>、map、help、quit、save、load。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import { loadLevels, mutateDna } from './engine/dna.js';
import {
  createGame,
  step,
  playerVisibleTiles,
  serializeState,
  deserializeState,
  enterLevel,
} from './engine/game.js';
import { viewRadiusOf, ITEM_META, TALENTS } from './engine/player.js';
import { ENTITY_DEFS } from './engine/entities.js';
import { nearestExitInfo, COMPASS_ARROWS, angleToArrow } from './engine/generator.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SAVE_FILE = path.join(ROOT, 'saves', 'cli-save.json');

// 数据由入口注入（引擎不直接碰 fs）
const levels = await loadLevels({
  readFile: (p) => readFileSync(path.join(ROOT, '..', p), 'utf8'),
});

const seedArg = process.argv[2];
const seed = seedArg !== undefined ? Number(seedArg) || seedArg : 1;
let state = createGame({ levels, seed });

// ---------- 渲染 ----------

function tileChar(level, gx, gy) {
  if (level.infinite) return level.getTile(gx, gy);
  return level.tiles[gy][gx];
}

/** 可见半径 ASCII 地图 */
function renderView(state, radiusOverride) {
  const { level, player } = state;
  const r = radiusOverride ?? viewRadiusOf(level, player);
  const looping = level.spaceRules.includes('looping') && !level.infinite;
  const visibleSet = new Set(playerVisibleTiles(state).map((t) => t.x + ',' + t.y));
  const explored = state.explored[state.levelId];
  const lines = [];
  const bar = '┌' + '─'.repeat(r * 2 + 1) + '┐';
  lines.push(bar);
  for (let sy = player.y - r; sy <= player.y + r; sy++) {
    let row = '│';
    for (let sx = player.x - r; sx <= player.x + r; sx++) {
      let gx = sx;
      let gy = sy;
      if (looping) {
        gx = ((gx % level.width) + level.width) % level.width;
        gy = ((gy % level.height) + level.height) % level.height;
      }
      if (!level.infinite && (gx < 0 || gy < 0 || gx >= level.width || gy >= level.height)) {
        row += ' ';
        continue;
      }
      const key = gx + ',' + gy;
      let ch;
      if (sx === player.x && sy === player.y) {
        ch = 'P';
      } else if (visibleSet.has(key)) {
        const e = state.entities.find(
          (en) => en.hp > 0 && en.visible && en.x === gx && en.y === gy
        );
        if (e) {
          ch = (ENTITY_DEFS[e.type] && ENTITY_DEFS[e.type].char) || '?';
        } else {
          const ei = level.exits.findIndex((ex) => ex.x === gx && ex.y === gy);
          if (ei >= 0 && (state.discoveredExits[state.levelId].has(ei) || !level.exits[ei].hidden)) {
            ch = 'E';
          } else if (state.items.some((it) => it.x === gx && it.y === gy)) {
            ch = 'I';
          } else {
            ch = tileChar(level, gx, gy);
          }
        }
      } else if (explored.has(key)) {
        ch = '·';
      } else {
        ch = ' ';
      }
      // 理智 <30：字符抖动/替换（恐惧失真）
      if ((state.sanityPhase === 'fear' || state.sanityPhase === 'collapse') && ch !== 'P' && ch !== ' ') {
        if (Math.random() < 0.12) ch = '╬░▒▓'[Math.floor(Math.random() * 5)];
      }
      row += ch;
    }
    row += '│';
    lines.push(row);
  }
  lines.push('└' + '─'.repeat(r * 2 + 1) + '┘');
  return lines.join('\n');
}

/** 状态栏 */
function renderStatus() {
  const { player, level } = state;
  const pct = (v, max) => (v >= max ? 'MAX' : String(Math.round(v)).padStart(3));
  const talent = player.talent && TALENTS[player.talent] ? ` | 天赋:${TALENTS[player.talent].name}` : '';
  let compass = '';
  if (level.infinite) {
    const info = nearestExitInfo(level, player.x, player.y);
    if (info) {
      const disc = state.discoveredExits[state.levelId] || new Set();
      const known =
        player.talent === 'guide' ||
        !info.hidden ||
        disc.has(state.level.exits.findIndex((e) => e.x === info.x && e.y === info.y));
      compass = ` 出口${COMPASS_ARROWS[angleToArrow(info.angle)]}${known ? Math.round(info.d) + 'm' : '?'}`;
    }
  }
  return (
    `HP ${pct(player.hp, player.hpMax || 100)}  SAN ${pct(player.sanity, player.sanityMax || 100)}  STA ${pct(player.stamina, player.staminaMax || 100)}  ` +
    `| ${level.name}（难度 ${level.difficultyClass}）| 第 ${state.turn} 回合 | ` +
    `手电:${player.flashlight ? '开' : '关'}(${Math.floor(player.battery)}%) ` +
    `潜行:${player.sneak ? '开' : '关'} 武器:${player.weapon ? '撬棍' : '徒手'}` +
    talent +
    compass
  );
}

/** 最近事件 */
function renderEvents(events, n = 6) {
  return events.slice(-n).map((e) => `  ${e.text}`).join('\n');
}

/** 完整日志 */
function renderLog() {
  return state.log.map((e) => `[${e.turn}] ${e.text}`).join('\n');
}

/** 完整地图（已探索区域；无限层显示玩家周围 41×41 局部地图） */
function renderMap() {
  const { level, player } = state;
  const explored = state.explored[state.levelId];
  const lines = [];
  if (level.infinite) {
    const R = 20;
    for (let y = player.y - R; y <= player.y + R; y++) {
      let row = '';
      for (let x = player.x - R; x <= player.x + R; x++) {
        const key = x + ',' + y;
        if (player.x === x && player.y === y) row += 'P';
        else if (explored.has(key)) row += tileChar(level, x, y);
        else row += ' ';
      }
      lines.push(row);
    }
    return lines.join('\n');
  }
  for (let y = 0; y < level.height; y++) {
    let row = '';
    for (let x = 0; x < level.width; x++) {
      const key = x + ',' + y;
      if (state.player.x === x && state.player.y === y) {
        row += 'P';
      } else if (explored.has(key)) {
        const e = state.entities.find((en) => en.hp > 0 && en.visible && en.x === x && en.y === y);
        if (e) row += (ENTITY_DEFS[e.type] && ENTITY_DEFS[e.type].char) || '?';
        else row += tileChar(level, x, y);
      } else {
        row += ' ';
      }
    }
    lines.push(row);
  }
  return lines.join('\n');
}

function renderAll(events) {
  console.log(renderStatus());
  console.log(renderView(state));
  if (events && events.length > 0) {
    console.log(renderEvents(events));
  }
}

// ---------- 存档 ----------

function saveGame() {
  try {
    mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    writeFileSync(SAVE_FILE, JSON.stringify(serializeState(state), null, 2), 'utf8');
    console.log(`已保存到 ${SAVE_FILE}`);
  } catch (err) {
    console.log(`保存失败：${err.message}`);
  }
}

function loadGame() {
  try {
    const data = JSON.parse(readFileSync(SAVE_FILE, 'utf8'));
    state = deserializeState(createGame({ levels, seed: data.runSeed }), data);
    console.log('已读档。');
    renderAll([]);
  } catch (err) {
    console.log(`读档失败：${err.message}`);
  }
}

// ---------- 命令处理 ----------

const HELP = `
可用命令：
  w/a/s/d            向四个方向移动（1 体力）
  run <w|a|s|d>      奔跑两格（2 体力/格，会发出声响引来猎犬）
  look               查看周围（皮行者只在查看时现形）
  search             搜索相邻格（2 体力，可发现隐藏出口）
  take               拾取脚下/相邻的物品
  use <物品>         使用物品（use 单独输入可查看物品栏）
  rest               休息（+30 体力；光亮处额外 +8 理智）
  fight              攻击相邻实体（20 体力；徒手 5-10，撬棍 20-30）
  sneak              切换潜行（移动无声）
  light              开关手电（视野 +2，会引来"电灯"、吓退"笑魇"）
  exit / noclip      使用所在格/相邻格的出口
  log                查看探索日志
  note <文本>        写下个人笔记（不消耗回合）
  map                查看本层已探索地图
  save / load        存档 / 读档（saves/cli-save.json）
  wild               挤进一道墙缝，进入一个从未记录的"野性层级"
  help               显示本帮助
  quit               退出并自动存档
`;

const DIR_MAP = {
  w: { dx: 0, dy: -1 },
  a: { dx: -1, dy: 0 },
  s: { dx: 0, dy: 1 },
  d: { dx: 1, dy: 0 },
};

function handle(cmd, arg) {
  let events = [];
  const dir = DIR_MAP[cmd];
  switch (cmd) {
    case 'w':
    case 'a':
    case 's':
    case 'd': {
      const res = step(state, { type: 'move', dx: dir.dx, dy: dir.dy });
      events = res.events;
      break;
    }
    case 'run': {
      const d = DIR_MAP[arg];
      if (!d) {
        console.log('用法：run <w|a|s|d>');
        return;
      }
      const res = step(state, { type: 'run', dx: d.dx, dy: d.dy });
      events = res.events;
      break;
    }
    case 'look': {
      const res = step(state, { type: 'look' });
      events = res.events;
      break;
    }
    case 'search': {
      const res = step(state, { type: 'search' });
      events = res.events;
      break;
    }
    case 'take': {
      const res = step(state, { type: 'take' });
      events = res.events;
      break;
    }
    case 'use': {
      if (!arg) {
        console.log(`物品栏：${state.player.inventory.join('、') || '（空）'}`);
        return;
      }
      const res = step(state, { type: 'use', item: arg });
      events = res.events;
      break;
    }
    case 'rest': {
      const res = step(state, { type: 'rest' });
      events = res.events;
      break;
    }
    case 'fight': {
      const res = step(state, { type: 'fight' });
      events = res.events;
      break;
    }
    case 'sneak': {
      const res = step(state, { type: 'sneak' });
      events = res.events;
      break;
    }
    case 'light': {
      const res = step(state, { type: 'light' });
      events = res.events;
      break;
    }
    case 'exit':
    case 'noclip': {
      const res = step(state, { type: 'exit' });
      events = res.events;
      break;
    }
    case 'log': {
      console.log(renderLog());
      return;
    }
    case 'note': {
      if (!arg) {
        console.log('用法：note <文本>');
        return;
      }
      const res = step(state, { type: 'note', text: arg });
      events = res.events;
      break;
    }
    case 'map': {
      console.log(renderMap());
      return;
    }
    case 'wild': {
      // 野性层级：以随机种子对 Level 0 做 DNA 变异，生成一个从未记录的层级
      const wildSeed = Math.floor(Math.random() * 1e6);
      const base = levels['level-0'];
      const wildDna = mutateDna(base, wildSeed);
      levels[wildDna.id] = wildDna;
      enterLevel(state, wildDna.id, { keepPlayer: true });
      console.log('你挤过一道墙缝，跌进了一片陌生的空间……');
      console.log(`【${wildDna.name}】（seed=${wildSeed}）`);
      console.log(wildDna.description);
      break;
    }
    case 'save': {
      saveGame();
      return;
    }
    case 'load': {
      loadGame();
      return;
    }
    case 'help': {
      console.log(HELP);
      return;
    }
    case 'quit': {
      saveGame();
      console.log('\n再见，流浪者。你的日志已保存。');
      rl.close();
      return;
    }
    case '':
      return;
    default:
      console.log(`未知命令：${cmd}（输入 help 查看帮助）`);
      return;
  }
  // 输出回合结果
  if (events.length > 0) console.log(renderEvents(events));
  if (state.over) {
    console.log(`\n${'='.repeat(40)}`);
    console.log(state.over === 'dead' ? '你死了。' : '你被层级同化了。');
    console.log(state.deathCause);
    console.log(`存活 ${state.turn} 回合，到过 ${Object.keys(state.codex.levels).length} 个层级。`);
    console.log('='.repeat(40));
    saveGame();
    rl.close();
    return;
  }
  renderAll([]);
}

// ---------- 启动 ----------

function printIntro() {
  console.log('═'.repeat(50));
  console.log('  后室：无尽回廊 —— 技术原型（CLI）');
  console.log('  你醒来时，黄色的墙纸和潮湿的地毯围绕着你。');
  console.log('  找到出口，活下去。别让理智归零。');
  console.log('═'.repeat(50));
  console.log(HELP);
  renderAll([]);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
printIntro();
rl.prompt();
rl.on('line', (line) => {
  const parts = line.trim().split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();
  const arg = parts.slice(1).join(' ');
  handle(cmd, arg);
  rl.prompt();
});
rl.on('close', () => {
  console.log('\n已退出。');
  process.exit(0);
});

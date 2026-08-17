// engine/dna.js
// 层级 DNA：默认值合并、合法性校验、层级注册表、数据加载与"野性变体"变异。
// 本模块不直接使用 fs/fetch —— 数据由入口注入的 loader 读取（见 SPEC §6）。

import { mulberry32, hashString, pick } from './rng.js';

/** 层级注册表：data/levels/ 下的 11 个层级 id（顺序即加载顺序） */
export const LEVEL_IDS = [
  'level-0',
  'level-1',
  'level-2',
  'level-3',
  'level-4',
  'level-5',
  'level-0.1',
  'level-11',
  'level-37',
  'level-52',
  'level-66',
  'level-3999',
  'level-90',
  'level--1',
  // 全面打磨新增（Fandom 经典层）
  'level-6',
  'level-7',
  'level-8',
  'level-9',
  'level-10',
  'level-13',
  'level-14',
  'level-18',
  'level-33',
  'level-34',
  'level-52',
  'level-66',
  'level-69',
  'level-90',
  'level-404',
  'level-666',
  'level-922',
  'level-hub',
  'level-!',
  // 全面优化新增（Fandom 经典层）
  'level-19',
  'level-205',
  // 第二轮新增（Fandom 经典层）
  'level-15',
  'level-20',
  'level-22',
  'level-96',
  'level-188',
  'level-231',
  'level-555',
  'level-976',
  // 第三轮新增（Fandom 经典层）
  'level-16',
  'level-21',
  'level-36',
  'level-57',
  'level-97',
  'level-169',
  'level-400',
  'level-799',
  // 血染森林（Level 14 重做）新增
  'level-28',
  // 第四轮新增（Fandom 经典层）
  'level-31',
  'level-40',
  'level-64',
  'level-100',
  'level-150',
  'level-999',
  // 核类美学新增（poolcore / cartooncore / songcore）
  'level-330',
  'level-709',
  'level-98',
  // 核类美学扩充（kidcore / liminal / darkcore）
  'level-118',
  'level-41',
  'level-474',
  'level-170',
  'level-460',
  'level-975',
  // 群星（进入即死的恒星内部）
  'level-599',
];

/** 默认值（合并时逐字段覆盖，保证任何残缺 DNA 都能得到完整结构） */
const DEFAULTS = {
  number: null,
  category: 'normal',
  difficultyClass: 0,
  environment: 'corridors',
  aesthetic: 'weirdcore',
  light: 'dim',
  sanDrain: 0.1,
  description: '',
  palette: {
    primary: '#8a847a',
    secondary: '#6a665e',
    accent: '#c8b46a',
    light: '#e8e08a',
  },
  terrain: {
    width: 24,
    height: 24,
    roomCount: 8,
    roomSizeMin: 3,
    roomSizeMax: 8,
    corridorWidth: 2,
    wallStyle: 'wallpaper',
    floorStyle: 'carpet',
    extraFeatures: [],
  },
  spaceRules: ['euclidean'],
  entities: [],
  items: [],
  itemDensity: 0,
  setPieces: [],
  soundscape: { ambient: [], startles: [], silenceEvents: false },
  exits: [],
};

/** 深合并：把原始 DNA 合并到默认值之上，返回完整 DNA */
export function normalizeDna(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('DNA 必须是对象');
  }
  if (!raw.id || !raw.name) {
    throw new Error(`DNA 缺少必填字段 id/name：${JSON.stringify(raw && raw.id)}`);
  }
  const out = mergeDeep({}, DEFAULTS);
  mergeDeep(out, raw);
  // terrain 必填数值
  const t = out.terrain;
  t.width = clampInt(t.width, 12, 64, 24);
  t.height = clampInt(t.height, 12, 64, 24);
  t.roomCount = clampInt(t.roomCount, 1, 40, 8);
  t.roomSizeMin = clampInt(t.roomSizeMin, 3, 12, 3);
  t.roomSizeMax = clampInt(t.roomSizeMax, 3, 24, 8);
  t.corridorWidth = clampInt(t.corridorWidth, 1, 3, 2);
  if (t.roomSizeMax < t.roomSizeMin) t.roomSizeMax = t.roomSizeMin;
  out.sanDrain = Math.max(0, Number(out.sanDrain) || 0);
  out.itemDensity = Math.min(1, Math.max(0, Number(out.itemDensity) || 0));
  out.difficultyClass = clampInt(out.difficultyClass, 0, 5, 0);
  return out;
}

/** 简单深合并（对象递归，数组/标量直接覆盖） */
function mergeDeep(target, source) {
  for (const key of Object.keys(source)) {
    const v = source[key];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      mergeDeep(target[key], v);
    } else {
      target[key] = v;
    }
  }
  return target;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 加载全部层级 DNA。
 * loader 二选一：
 *   { readFile(path) -> string }                Node 端（可同步可异步）
 *   { fetch(path) -> Promise<string> }          浏览器端
 * 返回 { [id]: normalizedDna }
 */
export async function loadLevels(loader) {
  if (!loader) throw new Error('loadLevels 需要 loader 参数');
  const out = {};
  for (const id of LEVEL_IDS) {
    const path = `data/levels/${id}.json`;
    let text;
    try {
      if (typeof loader.readFile === 'function') {
        text = await loader.readFile(path);
      } else if (typeof loader.fetch === 'function') {
        const res = await loader.fetch(path);
        if (!res || (typeof res.ok === 'boolean' && !res.ok)) {
          throw new Error(`无法加载 ${path}（HTTP ${res && res.status}）`);
        }
        text = typeof res === 'string' ? res : await res.text();
      } else {
        throw new Error('loadLevels 的 loader 需要提供 readFile 或 fetch');
      }
    } catch (err) {
      // 容错：缺失/加载失败的层级跳过（自定义与野性层级集合可部分存在）
      console.warn(`[loadLevels] 跳过 ${id}: ${err.message}`);
      continue;
    }
    try {
      out[id] = normalizeDna(JSON.parse(text));
    } catch (err) {
      console.warn(`[loadLevels] ${id} 数据损坏，跳过: ${err.message}`);
    }
  }
  return out;
}

// ---------- 野性变体（C 类无尽生成模式） ----------

/** 美学池（web 端核类滤镜驱动） */
export const AESTHETIC_POOL = ['weirdcore', 'dreamcore', 'poolcore', 'traumacore', 'mallcore'];
/** 光照池 */
export const LIGHT_POOL = ['bright', 'dim', 'dark', 'flickering', 'pitch'];
/** 环境池 */
export const ENV_POOL = ['corridors', 'rooms', 'mixed', 'industrial', 'aquatic', 'outdoors'];
/** 空间规则池 */
export const RULE_POOL = ['euclidean', 'looping', 'non-euclidean'];

/**
 * 对基础 DNA 做参数化变异，生成"野性层级"DNA。
 * 变异项：调色板 jitter、网格尺寸 ±40%、roomCount ±50%、实体/物品密度 ±30%、
 *         light/aesthetic/environment/spaceRules 概率重掷、难度微调。
 * 同 (baseDna.id, seed) 产出完全一致的野性 DNA；id 为 wild-<8位十六进制>，name 加"（野性变体）"。
 */
export function mutateDna(baseDna, seed) {
  const rng = mulberry32(hashString(`wild:${String(seed)}:${baseDna.id}`));
  const dna = normalizeDna(JSON.parse(JSON.stringify(baseDna)));

  // 调色板：各通道 ±12% jitter
  dna.palette = jitterPalette(dna.palette, rng, 0.12);

  // 网格尺寸 ±40%（钳制在 schema 范围 12-64）
  const scale = 1 + rng() * 0.8 - 0.4;
  dna.terrain.width = clampInt(Math.round(dna.terrain.width * scale), 12, 64, dna.terrain.width);
  dna.terrain.height = clampInt(Math.round(dna.terrain.height * scale), 12, 64, dna.terrain.height);
  dna.terrain.roomCount = clampInt(Math.round(dna.terrain.roomCount * (1 + rng() - 0.5)), 1, 40, 8);
  if (dna.terrain.roomCount > Math.floor((dna.terrain.width * dna.terrain.height) / 24)) {
    dna.terrain.roomCount = Math.max(1, Math.floor((dna.terrain.width * dna.terrain.height) / 24));
  }
  dna.terrain.roomSizeMin = clampInt(dna.terrain.roomSizeMin + (rng() < 0.5 ? -1 : 1), 3, 12, 3);
  dna.terrain.roomSizeMax = Math.max(dna.terrain.roomSizeMin, clampInt(dna.terrain.roomSizeMax + (rng() < 0.5 ? -1 : 1), 3, 24, 8));

  // 实体密度 ±30%
  for (const e of dna.entities) {
    if (e && e.density !== undefined) {
      e.density = Math.min(1, Math.max(0.001, e.density * (1 + rng() * 0.6 - 0.3)));
    }
  }
  dna.itemDensity = Math.min(1, Math.max(0, dna.itemDensity * (1 + rng() * 0.6 - 0.3)));

  // light / aesthetic / environment / spaceRules 概率重掷
  if (rng() < 0.6) dna.light = pick(rng, LIGHT_POOL);
  if (rng() < 0.6) dna.aesthetic = pick(rng, AESTHETIC_POOL);
  if (rng() < 0.3) dna.environment = pick(rng, ENV_POOL);
  if (rng() < 0.3) {
    if (rng() < 0.5) {
      const r = pick(rng, RULE_POOL);
      if (!dna.spaceRules.includes(r)) dna.spaceRules.push(r);
    } else {
      dna.spaceRules = ['euclidean'];
    }
  }

  // 难度微调
  dna.difficultyClass = clampInt(dna.difficultyClass + (rng() < 0.5 ? 1 : 0), 0, 5, 0);

  // 身份重写
  const hash = hashString(`wild:${String(seed)}:${baseDna.id}`)
    .toString(16)
    .padStart(8, '0');
  dna.id = `wild-${hash}`;
  dna.name = `${baseDna.name}（野性变体）`;
  dna.number = null;
  dna.category = 'enigmatic';
  dna.description = `${baseDna.description}（这层似乎从未被记录——${dna.light} 光，${dna.aesthetic} 的质地，${dna.environment} 的骨架。）`;
  return dna;
}

/** 调色板四色各通道 jitter（幅度 amp，0-1） */
function jitterPalette(palette, rng, amp) {
  const out = {};
  for (const key of ['primary', 'secondary', 'accent', 'light']) {
    const c = hexToRgb(palette[key] || '#888888');
    const j = (v) =>
      Math.min(255, Math.max(0, Math.round(v + (rng() * 2 - 1) * 255 * amp)));
    out[key] = rgbToHex(j(c.r), j(c.g), j(c.b));
  }
  return out;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { r: 136, g: 136, b: 136 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

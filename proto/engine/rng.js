// engine/rng.js
// 确定性随机数工具：mulberry32 伪随机数生成器 + FNV-1a 字符串哈希。
// 引擎内一切"随机"都必须经由本模块，保证同种子产出完全一致的结果。

/** mulberry32：32 位种子 PRNG，返回 [0,1) 的生成函数 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32 位字符串哈希 → uint32（用于把任意种子字符串变成数字种子） */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** [min, max] 闭区间随机整数 */
export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 从数组中随机取一个元素 */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** 以概率 p 命中 */
export function chance(rng, p) {
  return rng() < p;
}

/** Fisher-Yates 原地洗牌（返回同一数组） */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/** 四个基本方向（上/左/下/右） */
export const DIRS = [
  { dx: 0, dy: -1 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 1, dy: 0 },
];

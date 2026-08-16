// scripts/mark-infinite.mjs
// 无限世界改造：把 24 个"无边界"层级标记 terrain.infinite=true 并移除 spaceRules.looping
// （无限分块世界本身无边界，环绕规则不再需要）；其余 6 个层级显式标记 finite。
// 用法：node scripts/mark-infinite.mjs
import fs from 'node:fs';

const INFINITE = [
  'level-0', 'level-1', 'level-2', 'level-3', 'level-4', 'level-6', 'level-7',
  'level-9', 'level-10', 'level-11', 'level-13', 'level-14', 'level-18',
  'level-33', 'level-34', 'level-37', 'level-52', 'level-66', 'level-69',
  'level-90', 'level-666', 'level-922', 'level-3999', 'level--1',
];
const FINITE = ['level-0.1', 'level-5', 'level-8', 'level-404', 'level-hub', 'level-!'];

for (const id of INFINITE) {
  const p = `data/levels/${id}.json`;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  d.terrain.infinite = true;
  if (Array.isArray(d.spaceRules)) {
    d.spaceRules = d.spaceRules.filter((r) => r !== 'looping');
    if (d.spaceRules.length === 0) d.spaceRules = ['euclidean'];
  }
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  console.log(`infinite: ${id}  rules=${d.spaceRules.join(',')}`);
}
for (const id of FINITE) {
  const p = `data/levels/${id}.json`;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  d.terrain.infinite = false;
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  console.log(`finite:   ${id}`);
}
console.log('done');

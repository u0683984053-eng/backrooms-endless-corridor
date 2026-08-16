// fix-features.mjs — 修复 extraFeatures 被写成单字符串元素的问题（拆分为数组），并更新 level-11 拓扑
import fs from 'node:fs';
const root = 'C:/Users/25072/.dsh/backrooms-dev/data/levels';

for (const f of fs.readdirSync(root).filter((x) => x.endsWith('.json'))) {
  const p = root + '/' + f;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const ef = d.terrain && d.terrain.extraFeatures;
  if (!ef) continue;
  // 拆分含逗号的字符串元素
  const fixed = [];
  for (const e of ef) {
    if (typeof e !== 'string') { fixed.push(e); continue; }
    for (const part of e.split(',')) {
      const t = part.trim();
      if (t && !fixed.includes(t)) fixed.push(t);
    }
  }
  const before = JSON.stringify(ef);
  const after = JSON.stringify(fixed);
  if (before !== after) {
    d.terrain.extraFeatures = fixed;
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    console.log('FIX', f, before, '→', after);
  }
}

// level-11：48×48 + city-grid 拓扑
{
  const p = root + '/level-11.json';
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  d.terrain.width = 48;
  d.terrain.height = 48;
  d.terrain.topology = 'city-grid';
  fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
  console.log('OK level-11.json → 48×48 city-grid');
}

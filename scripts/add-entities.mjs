// add-entities.mjs — 为层级追加新实体声明
import fs from 'node:fs';
const root = 'C:/Users/25072/.dsh/backrooms-dev/data/levels';

// 文件 → 追加的实体声明（deathmoth 攻击性、glowfolk 被动）
const edits = {
  'level-0.json': [
    { type: 'deathmoth', density: 0.006, aggression: 'curious' },
  ],
  'level-2.json': [
    { type: 'deathmoth', density: 0.008, aggression: 'hostile' },
  ],
  'level-5.json': [
    { type: 'deathmoth', density: 0.006, aggression: 'curious' },
  ],
  'level-1.json': [
    { type: 'glowfolk', density: 0.005, aggression: 'passive' },
  ],
  'level-11.json': [
    { type: 'glowfolk', density: 0.006, aggression: 'passive' },
  ],
  'level-37.json': [
    { type: 'glowfolk', density: 0.004, aggression: 'passive' },
  ],
};

for (const [f, adds] of Object.entries(edits)) {
  const p = root + '/' + f;
  let c = fs.readFileSync(p, 'utf8');
  // 在 entities 数组最后一个对象后追加（匹配 "] 前最后一个对象"）
  const objRe = /(\{\s*"type": "[a-z-]+",\s*"density": [\d.]+,?\s*"aggression": "[a-z]+"\s*\})\s*(\n\s*\])/;
  const m = c.match(objRe);
  if (!m) {
    console.log('FAIL 结构不匹配', f);
    continue;
  }
  const lines = adds.map((a) => `    { "type": "${a.type}", "density": ${a.density}, "aggression": "${a.aggression}" }`).join(',\n');
  const before = c;
  c = c.replace(m[0], m[1] + ',\n' + lines + '\n  ]');
  if (c === before) {
    console.log('FAIL 替换失败', f);
    continue;
  }
  fs.writeFileSync(p, c);
  console.log('OK', f, '←', adds.map((a) => a.type).join(','));
}

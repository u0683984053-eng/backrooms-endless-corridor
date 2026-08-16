// enable-props.mjs — 为指定层级启用新道具特性
import fs from 'node:fs';
const root = 'C:/Users/25072/.dsh/backrooms-dev/data/levels';
const edits = {
  'level-1.json': ['furniture', 'furniture, crates'],
  'level-4.json': ['furniture', 'furniture, papers, posters'],
  'level-11.json': ['fountain', 'fountain, plants, posters'],
  'level-3999.json': ['fountain', 'fountain, plants, posters, crates'],
  'level-0.json': ['furniture', 'furniture, posters'],
};
for (const [f, [from, to]] of Object.entries(edits)) {
  const p = root + '/' + f;
  let c = fs.readFileSync(p, 'utf8');
  const before = c;
  c = c.replace('"' + from + '"', '"' + to + '"');
  if (c === before) {
    console.log('FAIL 未找到', f, from);
    continue;
  }
  fs.writeFileSync(p, c);
  console.log('OK', f, '→', to);
}

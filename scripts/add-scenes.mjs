// scripts/add-scenes.mjs — 为全部层级补充"细思极恐"场景（setPieces）
// 风格：日常细节里的异常（柜子划痕全是同一个日期等），多数降低理智。
// 用法：node scripts/add-scenes.mjs  （幂等：不重复添加已存在的同名场景）
import fs from 'node:fs';

const SCENES = {
  'level-0': [
    { type: 'writing', position: 'random', text: '地毯的污渍拼成了字母——是你的名字首字母。你每走十步，它就在你身后换一个方向。', sanityEffect: -4, note: '地毯污渍拼成我的名字首字母。' },
    { type: 'object', position: 'random', text: '墙角的柜子门开着：里面的划痕全是同一个日期。你数了数，至少两百道，每一道都是同一天。', sanityEffect: -5, note: '柜子里两百多道划痕，全是同一个日期。' },
  ],
  'level-1': [
    { type: 'object', position: 'random', text: '板条箱上的手写标签：『第 114 批：人类』。箱子是空的，但箱底有体温。', sanityEffect: -4, note: '标签：第 114 批：人类。' },
    { type: 'writing', position: 'random', text: '柱子上有一道粉笔画的记号，旁边写着：『第 8 次路过这里』。你才第一次来。', sanityEffect: -3, note: '粉笔字：第 8 次路过这里。' },
  ],
  'level-2': [
    { type: 'object', position: 'random', text: '管道接缝渗出的液体是温的，带着甜味。你尝了一滴——是糖浆。但工业管道不该是甜的。', sanityEffect: -5, note: '管道渗出温热的糖浆。' },
    { type: 'writing', position: 'random', text: '墙上的阀门全部拧到『最大』。你数了数，四十七个，没有一个例外。', sanityEffect: -3, note: '四十七个阀门全部开到最大。' },
  ],
  'level-3': [
    { type: 'object', position: 'random', text: '变压器铭牌上的出厂日期——是下周。', sanityEffect: -4, note: '变压器出厂日期是下周。' },
    { type: 'object', position: 'random', text: '配电柜里躺着一副眼镜，一边镜片碎了。旁边用胶带贴着两个字：『别修』。', sanityEffect: -3, note: '眼镜旁贴着：别修。' },
  ],
  'level-4': [
    { type: 'writing', position: 'random', text: '工位上的便利贴叠了厚厚一沓。最上面那张写着：『今天是第 300 天』。下面的每一张，都是同一句。', sanityEffect: -4, note: '三百张便利贴写着同一句话。' },
    { type: 'object', position: 'random', text: '打印机自己吐出一张纸：『对不起，您查找的楼层不存在。』', sanityEffect: -3, note: '打印机：您查找的楼层不存在。' },
  ],
  'level-5': [
    { type: 'writing', position: 'random', text: '前台登记簿翻开在最后一页：『客人：无。房间：全部。』', sanityEffect: -4, note: '登记簿：客人无，房间全部。' },
    { type: 'object', position: 'random', text: '电梯按钮上，『4』楼的位置被磨得发亮，其它楼层的按钮都积着灰。', sanityEffect: -3, note: '电梯 4 楼按钮被磨得发亮。' },
  ],
  'level-6': [
    { type: 'writing', position: 'random', text: '黑暗中你摸到墙上密密麻麻的刻痕——全是『不要开灯』。有些刻痕是新的。', sanityEffect: -5, note: '墙上刻满：不要开灯。' },
    { type: 'object', position: 'random', text: '一只手电筒，没有电池，开关被拆掉了，像是怕有人打开它。', sanityEffect: -3, note: '一支被拆掉开关的手电筒。' },
  ],
  'level-7': [
    { type: 'weird-room', position: 'random', text: '水面的倒影比你慢半拍。你停下，它也停下；你低头看它，它还在看你。', sanityEffect: -5, note: '水中的倒影比我慢半拍。' },
    { type: 'object', position: 'random', text: '排水口被一把锁锁住了。锁很新，没有一丝锈迹。', sanityEffect: -3, note: '排水口锁着一把新锁。' },
  ],
  'level-8': [
    { type: 'object', position: 'random', text: '洞穴深处有一堆烧过的灰烬，中间插着一根蜡烛。蜡烛没有烧过的痕迹。', sanityEffect: -4, note: '灰烬中一根没烧过的蜡烛。' },
    { type: 'mural', position: 'random', text: '石壁上的壁画：一排小人，最后一个画得特别大——还在微笑。', sanityEffect: -4, note: '壁画里微笑的巨大小人。' },
  ],
  'level-9': [
    { type: 'object', position: 'random', text: '每栋房子的邮箱里都插着同一封信，收件人是你的名字，邮戳是四十年前。', sanityEffect: -5, note: '四十年前寄给我的信。' },
    { type: 'object', position: 'random', text: '路边的秋千在没有风的时候自己摇着。你走近，它停了下来。', sanityEffect: -3, note: '秋千在我走近时停了。' },
  ],
  'level-10': [
    { type: 'object', position: 'random', text: '稻草人穿着的衬衫上写满同一个电话号码。你拨过去，接电话的是你的声音。', sanityEffect: -6, note: '稻草人身上的号码通向我自己。' },
    { type: 'object', position: 'random', text: '麦田里有一片圆形倒伏区，中心放着一双鞋。鞋还是温的。', sanityEffect: -5, note: '麦田中心的鞋还是温的。' },
  ],
  'level-11': [
    { type: 'object', position: 'random', text: '红绿灯永远停留在黄色。你等了十分钟，它闪了十次，每次都刚好闪三下。', sanityEffect: -3, note: '红灯永远停在黄色。' },
    { type: 'weird-room', position: 'random', text: '某栋楼有一扇永远亮着灯的窗户。你绕了三条街，它都在你的正前方。', sanityEffect: -4, note: '那扇窗永远在我正前方。' },
  ],
  'level-13': [
    { type: 'object', position: 'random', text: '楼梯扶手上有一道新抓痕，木屑还是新鲜的。这里已经很久没有人了。', sanityEffect: -4, note: '一道新鲜抓痕。' },
    { type: 'weird-room', position: 'random', text: '墙角的影子形状不对。你盯着它，它慢慢变成了你的形状。', sanityEffect: -5, note: '影子变成了我的形状。' },
  ],
  'level-14': [
    { type: 'object', position: 'random', text: '花丛里有一块墓碑，没有名字，只有一行字：『它终于安静了』。', sanityEffect: -3, note: '无名墓碑：它终于安静了。' },
    { type: 'object', position: 'random', text: '喷泉里的硬币全是同一年份的。你捞起一枚，年份是明年。', sanityEffect: -4, note: '喷泉硬币的年份是明年。' },
  ],
  'level-15': [
    { type: 'writing', position: 'random', text: '楼梯扶手上每隔一段就刻着一个数字：…1312、1313、1314。然后是一段被擦掉的空白。', sanityEffect: -4, note: '楼梯数字在 1314 后断了。' },
    { type: 'object', position: 'random', text: '某层楼的安全出口标志指向一堵实墙。墙上有门框的痕迹。', sanityEffect: -3, note: '安全出口指向实墙。' },
  ],
  'level-18': [
    { type: 'object', position: 'random', text: '灭火器箱的玻璃碎了，里面不是灭火器，是一张全家福。照片里所有人的眼睛都被抠掉了。', sanityEffect: -5, note: '灭火器箱里的全家福。' },
    { type: 'weird-room', position: 'random', text: '天花板有一块渗水的痕迹，形状像一张脸。你换个角度，它跟着你转。', sanityEffect: -4, note: '水渍像一张会转动的脸。' },
  ],
  'level-19': [
    { type: 'object', position: 'random', text: '货架最深处有一台没有插电的收音机，还在播放。声音很小，像有人在里面说话。', sanityEffect: -4, note: '没插电的收音机在响。' },
    { type: 'writing', position: 'random', text: '地上有一行粉笔箭头，指向仓库深处。箭头画得很认真，但通向的是一堵墙。', sanityEffect: -3, note: '粉笔箭头通向一堵墙。' },
  ],
  'level-20': [
    { type: 'object', position: 'random', text: '货柜里码着整整齐齐的罐头，标签全是手写的：『别吃』『别吃』『别吃』。', sanityEffect: -4, note: '整柜罐头写着：别吃。' },
    { type: 'object', position: 'random', text: '灰尘里有一条拖行的痕迹，末端是一双码放整齐的鞋。', sanityEffect: -6, note: '拖痕尽头的鞋。' },
  ],
  'level-22': [
    { type: 'weird-room', position: 'random', text: '走廊尽头的镜子。你走过去了，但镜子里的你还站在原地。', sanityEffect: -6, note: '镜子里的人没有跟着我走。' },
    { type: 'object', position: 'random', text: '某扇房门虚掩，门缝里透出电视的蓝光。你凑近听——里面在播天气预报，播的是明天的天气。', sanityEffect: -4, note: '门后电视在播明天的天气。' },
  ],
  'level-33': [
    { type: 'weird-room', position: 'random', text: '你摸到的每一面墙都是同一个温度，但有一块特别凉。凉的那一块，形状像一只手掌。', sanityEffect: -4, note: '墙上有一块手掌形的凉斑。' },
    { type: 'writing', position: 'random', text: '地上有一串脚印，只有进来的，没有出去的。你站在原地，脚印多了一双。', sanityEffect: -6, note: '脚印在增加。' },
  ],
  'level-34': [
    { type: 'writing', position: 'random', text: '墙上的排班表：『本周值班：无。下周值班：无。下下周：……』最后一行被水渍晕开了。', sanityEffect: -3, note: '永远无人的排班表。' },
    { type: 'object', position: 'random', text: '一张没写完的信，落款是你的笔迹——但你从没写过信。', sanityEffect: -5, note: '一封落款是我的信。' },
  ],
  'level-37': [
    { type: 'weird-room', position: 'random', text: '泳池的水面平静得像玻璃。你把手指伸进去——水是温的，像刚有人游过。', sanityEffect: -4, note: '池水是温的。' },
    { type: 'writing', position: 'random', text: '池底的瓷砖拼成了一句话，只有水面平静时才能看清：『别抬头』。', sanityEffect: -5, note: '池底写着：别抬头。' },
  ],
  'level-52': [
    { type: 'object', position: 'random', text: '船钟停在 4:44。你敲了一下，它响了五声。', sanityEffect: -3, note: '船钟停着，却响了五声。' },
    { type: 'weird-room', position: 'random', text: '舷窗外的海面永远是同一片浪。你看了十分钟，它没有动过。', sanityEffect: -4, note: '海面凝固了。' },
  ],
  'level-66': [
    { type: 'weird-room', position: 'random', text: '更衣室的镜子蒙着雾。你擦干净——镜子里的人穿着你不认识的衣服。', sanityEffect: -5, note: '镜子里的人穿着陌生的衣服。' },
    { type: 'object', position: 'random', text: '泳池边放着一双拖鞋，位置和你上次离开时一模一样。你上次来，是二十年前。', sanityEffect: -4, note: '二十年未动的拖鞋。' },
  ],
  'level-69': [
    { type: 'object', position: 'random', text: '旋转木马的音乐停在一半。你数了数，它循环了四十七遍，每次都断在同一个音上。', sanityEffect: -4, note: '音乐永远断在同一个音上。' },
    { type: 'weird-room', position: 'random', text: '摩天轮的某个轿厢里永远坐着一个人形。它从来不转过来。', sanityEffect: -5, note: '轿厢里的人形从不转身。' },
  ],
  'level-90': [
    { type: 'object', position: 'random', text: '每辆车的后视镜都绑着红绳。你数了数，一共六十六辆。', sanityEffect: -3, note: '六十六面后视镜都绑着红绳。' },
    { type: 'object', position: 'random', text: '地下二层有一辆车，车窗贴着『不要启动』。钥匙还插在锁孔里。', sanityEffect: -4, note: '贴着不要启动的车。' },
  ],
  'level-96': [
    { type: 'object', position: 'random', text: '饮水机的水桶是满的，但标签写着『已空』。你倒了杯水——喝起来像眼泪。', sanityEffect: -4, note: '水桶满着，却写着已空。' },
    { type: 'writing', position: 'random', text: '会议室的白板上写着一行字，字迹是你的：『你们找到我了吗？』', sanityEffect: -6, note: '白板上的字迹是我的。' },
  ],
  'level-188': [
    { type: 'weird-room', position: 'random', text: '每一间房的墙角都有一个硬币大小的孔。你趴下看——孔的另一边也有一只眼睛。', sanityEffect: -7, note: '墙孔的另一边有眼睛。' },
    { type: 'object', position: 'random', text: '墙纸揭开一角，下面是另一层墙纸。再揭开，还有一层。一共七层，每一层都是同一间房的照片。', sanityEffect: -4, note: '七层墙纸，七张同一间房的照片。' },
  ],
  'level-205': [
    { type: 'weird-room', position: 'random', text: '窗外的虚空里飘着一样东西，像一本书。你看了很久，它飘近了一点。', sanityEffect: -4, note: '虚空里的书在靠近。' },
    { type: 'writing', position: 'random', text: '门框上有一道新刻的记号。你数了数墙上的旧记号——它们每天多一道，但你从没见人刻过。', sanityEffect: -5, note: '门框的记号每天增加。' },
  ],
  'level-231': [
    { type: 'object', position: 'random', text: '旋转木马在没有电的情况下慢慢转动着。你走近，它停了——音乐盒开始响。', sanityEffect: -5, note: '无电旋转的木马。' },
    { type: 'writing', position: 'random', text: '路灯下的长椅，椅背刻着：『我们约好在这里见面。已经很久了。』', sanityEffect: -3, note: '长椅上的约定。' },
  ],
  'level-404': [
    { type: 'object', position: 'random', text: '显示器上不是报错页面，而是一行字：『您访问的楼层已被删除。是否恢复？是 / 否』。没有光标。', sanityEffect: -4, note: '屏幕询问是否恢复。' },
    { type: 'writing', position: 'random', text: '键盘的 4 键被磨得发亮。你按了一下——屏幕闪烁：『404：你』。', sanityEffect: -5, note: '404：你。' },
  ],
  'level-555': [
    { type: 'object', position: 'random', text: '冰柜里有一盒没有标签的酸奶。生产日期是今天，保质期是昨天。', sanityEffect: -4, note: '今天生产，昨天过期。' },
    { type: 'weird-room', position: 'random', text: '广播循环的同一首歌里，有一段你听不清的歌词。你把音量调到最大——里面在报你的名字。', sanityEffect: -6, note: '广播在报我的名字。' },
  ],
  'level-666': [
    { type: 'object', position: 'random', text: '墙上的温度计显示 666°C。你伸手摸了一下——是常温。它显示的是别的东西的温度。', sanityEffect: -5, note: '温度计显示的是别处的温度。' },
    { type: 'weird-room', position: 'random', text: '灰烬里有一张完好的纸，画着这个房间。画里的房间，有一扇你身后没有的窗。', sanityEffect: -6, note: '画里有一扇不存在的窗。' },
  ],
  'level-922': [
    { type: 'object', position: 'random', text: '走廊尽头的自动售货机还在运作。你投了一枚硬币——掉出来的罐头，标签是你的名字。', sanityEffect: -5, note: '罐头标签是我的名字。' },
    { type: 'weird-room', position: 'random', text: '地砖有一块是松的。你撬开——下面不是泥土，是另一层地砖。再撬，还是。', sanityEffect: -4, note: '地砖下面是地砖。' },
  ],
  'level-976': [
    { type: 'object', position: 'random', text: '床上的枕头上有一根头发。不是你的颜色。', sanityEffect: -3, note: '枕头上有一根陌生的头发。' },
    { type: 'writing', position: 'random', text: '灯罩内侧写着一行小字：『它数到 1000 就会醒』。', sanityEffect: -5, note: '灯罩里：它数到 1000 就会醒。' },
  ],
  'level-3999': [
    { type: 'object', position: 'random', text: '街机屏幕突然切到一片空白，中间有一行字：『你玩够了没有？』', sanityEffect: -4, note: '街机问我玩够了没有。' },
    { type: 'weird-room', position: 'random', text: '代币掉进投币口——你听到的不是弹簧声，是有人接住了它。', sanityEffect: -3, note: '投币口有人接住了代币。' },
  ],
  'level--1': [
    { type: 'weird-room', position: 'random', text: '天花板有一块水渍，形状像一个倒立的人。', sanityEffect: -4, note: '天花板上倒立的人形水渍。' },
    { type: 'writing', position: 'random', text: '墙角的裂缝里塞着一张纸条：『别跳』。', sanityEffect: -3, note: '纸条：别跳。' },
  ],
  'level-hub': [
    { type: 'weird-room', position: 'random', text: '一扇没有门牌的门，门缝里透出光。你推开——里面是另一个你，正在开门。', sanityEffect: -5, note: '门里是另一个我在开门。' },
    { type: 'writing', position: 'random', text: '地板中央有一圈粉笔画的圈，圈内写满同一个日期。你数了数——和墙上的划痕数一样。', sanityEffect: -4, note: '粉笔圈里全是同一个日期。' },
  ],
  'level-!': [
    { type: 'writing', position: 'random', text: '跑道的终点线画在墙里。你跑到墙前——线在墙后面。', sanityEffect: -4, note: '终点线在墙里。' },
    { type: 'object', position: 'random', text: '饮水机贴着『冰水』，但水是温的。你喝了一口——是冰的。', sanityEffect: -3, note: '冰水是温的，喝起来是冰的。' },
  ],
  'level-0.1': [
    { type: 'weird-room', position: 'random', text: '墙上的时钟和你的手表差了一分钟。你转身再看——差了两分钟。', sanityEffect: -3, note: '时钟越来越慢。' },
    { type: 'object', position: 'random', text: '角落里有一张课桌，桌肚里有一本作业本。每一页都写着同一句：『我醒着』。', sanityEffect: -4, note: '作业本每页都写着：我醒着。' },
  ],
};

let added = 0;
for (const [id, scenes] of Object.entries(SCENES)) {
  const p = `data/levels/${id}.json`;
  if (!fs.existsSync(p)) {
    console.log('SKIP 不存在:', id);
    continue;
  }
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  d.setPieces = d.setPieces || [];
  let n = 0;
  for (const s of scenes) {
    const dup = d.setPieces.some((x) => x.text === s.text);
    if (dup) continue;
    d.setPieces.push(s);
    n++;
  }
  if (n > 0) {
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    added += n;
    console.log(`${id}: +${n} 场景（共 ${d.setPieces.length}）`);
  }
}
console.log(`\n新增 ${added} 个场景`);

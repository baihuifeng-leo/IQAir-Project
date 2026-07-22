const { merge3, deepEqual } = require('./merge.js');
let pass=0, fail=0;
const t=(name, base, mine, remote, want)=>{
  const got=merge3(base,mine,remote);
  const ok=deepEqual(got,want);
  ok?pass++:fail++;
  if(!ok) console.log('✗',name,'\n  got ',JSON.stringify(got),'\n  want',JSON.stringify(want));
  else console.log('✓',name);
};

// 1 两人改不同字段 → 都保留
t('不同字段', {a:1,b:1}, {a:2,b:1}, {a:1,b:9}, {a:2,b:9});

// 2 同一字段冲突 → 后提交(mine)赢
t('同字段冲突', {a:1}, {a:2}, {a:3}, {a:2});

// 3 数组：两人各加一个产品
const base={p:[{id:'1',n:'A'}]};
t('各自新增', base, {p:[{id:'1',n:'A'},{id:'2',n:'B'}]}, {p:[{id:'1',n:'A'},{id:'3',n:'C'}]},
  {p:[{id:'1',n:'A'},{id:'3',n:'C'},{id:'2',n:'B'}]});

// 4 我删一个，对方没动 → 删掉
t('我删对方没动', base, {p:[]}, {p:[{id:'1',n:'A'}]}, {p:[]});

// 5 我删一个，对方改了它 → 救回来（对方的版本）
t('我删对方改了', base, {p:[]}, {p:[{id:'1',n:'Z'}]}, {p:[{id:'1',n:'Z'}]});

// 6 对方删了，我改了它 → 救回来（我的版本）
t('对方删我改了', base, {p:[{id:'1',n:'Y'}]}, {p:[]}, {p:[{id:'1',n:'Y'}]});

// 7 对方删了，我没改 → 保持删除
t('对方删我没改', base, {p:[{id:'1',n:'A'}]}, {p:[]}, {p:[]});

// 8 同一个产品的不同字段
const b2={p:[{id:'1',n:'A',price:'¥1'}]};
t('同产品不同字段', b2, {p:[{id:'1',n:'B',price:'¥1'}]}, {p:[{id:'1',n:'A',price:'¥9'}]},
  {p:[{id:'1',n:'B',price:'¥9'}]});

// 9 我完全没改 → 全听对方
t('我没改', {a:1}, {a:1}, {a:5}, {a:5});

// 10 对方没改 → 全听我
t('对方没改', {a:1}, {a:7}, {a:1}, {a:7});

// 11 嵌套：tags 对象里删一个分类
t('删对象键', {tags:{x:{c:'#f00'},y:{c:'#0f0'}}}, {tags:{y:{c:'#0f0'}}}, {tags:{x:{c:'#f00'},y:{c:'#00f'}}},
  {tags:{y:{c:'#00f'}}});

// 12 lines 这类无 id 数组 → 整体 LWW
t('无id数组', {l:[{v:'1'}]}, {l:[{v:'2'}]}, {l:[{v:'3'}]}, {l:[{v:'2'}]});

// 13 空数组不该被当成 idArray 误判（都空 → 相等，走 remote）
t('空数组', {p:[]}, {p:[]}, {p:[{id:'1'}]}, {p:[{id:'1'}]});

// 14 真实场景：我在 A 品牌加产品，对方改 B 品牌产品价格
const real={products:[{id:'i1',brandId:'A',name:'X',price:'¥1'},{id:'i2',brandId:'B',name:'Y',price:'¥2'}]};
t('真实并发', real,
 {products:[{id:'i1',brandId:'A',name:'X',price:'¥1'},{id:'i2',brandId:'B',name:'Y',price:'¥2'},{id:'i3',brandId:'A',name:'新',price:'¥0'}]},
 {products:[{id:'i1',brandId:'A',name:'X',price:'¥1'},{id:'i2',brandId:'B',name:'Y',price:'¥888'}]},
 {products:[{id:'i1',brandId:'A',name:'X',price:'¥1'},{id:'i2',brandId:'B',name:'Y',price:'¥888'},{id:'i3',brandId:'A',name:'新',price:'¥0'}]});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);

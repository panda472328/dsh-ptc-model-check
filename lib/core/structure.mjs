/**
 * 结构词表 —— 判定「这段内容是不是在讲建筑/机械的构件组成」。
 *
 * 为什么需要独立的共享模块：
 *   同一份词表之前散在三处，而且**内容不一致**：
 *     · lib/index.js  STRUCT_TERMS —— 最全（含栌斗/散斗/泥道拱/衬方头）
 *     · lib/tools.mjs STRUCT_HINT  —— 较少，还混进了「结构」这个泛词
 *     · scripts/research.mjs STRUCT_TERMS —— 与 index.js 接近但不完全相同
 *
 *   三处不一致的后果：
 *     同一条搜索结果，脚本判「相关」，index.js 判「跑题」——
 *     门禁和展示对不上，模型会困惑。
 *
 *   现在统一到这里，所有地方 import 同一份。
 */

/**
 * 结构词表（正则）。
 *
 * 收录标准：这些都是「构件名」或「结构关系词」，
 * **不是**「领域大词」（如「建筑」「风格」「历史」）。
 * 用领域大词判相关性等于没判——任何返回都含得上。
 */
export const STRUCT_TERMS = /构件|组成|连接|支撑|承重|受力|荷载|榫|卯|斗拱|斗栱|拱|梁|柱|檩|椽|额枋|平板枋|瓦|檐|脊|戗|角梁|由昂|昂|翘|升|斗|枋|扶壁|飞扶壁|券|肋|拱顶|穹顶|穹|台基|基座|须弥座|檐口|女儿墙|栏杆|望柱|踏跺|阶|门窗|隔扇|槛窗|直棂|棂|廊|塔|叠涩|收分|侧脚|生起|举折|升起|柱础|墙|屋顶|坡|构架|框架|桁|椽条|檩条|铺作|柱头|转角|补间|栌斗|散斗|交互斗|华拱|泥道拱|瓜子拱|慢拱|令拱|耍头|衬方头|bracket|buttress|arch|vault|column|beam|truss|cantilever|masonry|pier|span/i

/**
 * 「这是领域背景、不是结构内容」的判据。
 *
 * 实测跑题样本：
 *   问「故宫太和殿 斗拱 结构」→ 返回「故宫博物院成立于1925年…」
 *   问「飞扶壁 结构」        → 返回「飞（拼音：fēi）是汉语一级通用规范汉字…」
 *
 * 这些内容有字，但讲的是历史/词义/旅游，不是构件。
 */
export const OFF_TOPIC_HINTS = /成立于|占地|建筑面积|博物院|旅游|门票|拼音|部首|笔画|汉语|字典|译文|翻译|官网|招聘|新闻|艺术风格|文学流派|恐怖|超自然/i

/**
 * 查询里可以忽略的泛词——它们不帮助定位结构内容。
 * 判定「查询里的具体词有没有出现在结果里」时要用。
 */
export const QUERY_STOPWORDS = /^(结构|原理|组成|连接|关系|方式|做法|怎么|如何|什么|说明|介绍|帮我|做一个|我要|一张|图片|模型|建模)$/

/** 把查询拆成有意义的词 */
export function queryTerms(query) {
  return String(query || '')
    .split(/[\s，,、。／/\\|+]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !QUERY_STOPWORDS.test(w))
}

/** 这段文本像不像在讲结构 */
export function looksStructural(text) {
  return STRUCT_TERMS.test(String(text || ''))
}

/** 这段文本是不是跑题的领域背景 */
export function looksOffTopic(text) {
  return OFF_TOPIC_HINTS.test(String(text || ''))
}

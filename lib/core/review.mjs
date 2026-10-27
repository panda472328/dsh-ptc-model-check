/**
 * 视觉检测智能体的交接契约。
 *
 * ## 为什么需要专职检测智能体
 *
 * 主智能体在建模时有个根本毛病：**它是自己作品的自评人**。
 * 它刚花了十几轮把东西建出来，心理上倾向「这已经不错了」——
 * 所以经常出现「自己看图说没问题」然后收工，而实际上结构有硬伤。
 *
 * 派一个**专职检测智能体**能解决这个问题，因为它：
 *   - 没有「我刚建的」这个包袱，看的是别人做的成品
 *   - 只被问三个固定问题，不会跑题到「材质好不好」这类不相关方向
 *   - 必须给出**可执行的修改清单**，否则等于没检测
 *
 * ## 只问三个问题
 *
 * 检测智能体的职责被刻意收窄到三个问题，多一个都不要：
 *
 *   1. **结构对吗**   —— 几何上自洽吗？该连的连上了吗？有断裂/悬空/错位吗？
 *   2. **现实中是这样吗** —— 这个东西现实里真长这样吗？有没有明显荒谬的构造？
 *   3. **还能更好吗** —— 对着五视图看，哪个视角还能补？细节还差什么？
 *
 * ## 不通用的设计：为什么不用 workflow 工具
 *
 * 用 `subagent` 派一个子智能体，把「五视图 + 检测数据 + 上面三个问题」
 * 一次性交给它。它返回**结构化的修改清单**，主智能体必须照着改。
 */

/** 检测智能体必须回答的三个问题。顺序固定，不允许增删。 */
export const REVIEW_QUESTIONS = [
  {
    id: 'structure',
    q: '结构对吗',
    detail: '几何上自洽吗？该连接的部件连上了吗？有没有断裂、悬空、明显错位、'
      + '或者本该有结构却空着的面？穿模是合理的插接还是真的穿出来了？',
  },
  {
    id: 'reality',
    q: '现实中是这样吗',
    detail: '按任务的画风、用途和设定判断：比例对吗？受力和连接关系说得通吗？'
      + '有没有一眼看去荒谬的构造（悬空的横梁、头重脚轻、违反设定的连接）？'
      + '风格化或幻想设计可简化、夸张，不要一律按写实标准纠正。',
  },
  {
    id: 'better',
    q: '还能更好吗',
    detail: '对着五个正交视图，按主体轮廓与比例、结构构件与连接、表面几何细节三层检查。'
      + '找出影响识别度、结构可信度或目标观看距离下可见层次的缺口；'
      + '表面几何可包含任务需要的倒角、分缝、面板分割和配件。'
      + '每个改进要说明视角、部位、可见证据和具体动作；大块空面本身不等于缺细节。',
  },
]

/**
 * 材质版三问。按材质批次复核时使用，形体问题仍可回修。
 *
 * 为什么问题要换一套：
 *   材质复核聚焦外观，结构问题另记并交回建模处理。材质有自己的三个要害：
 *   材质和画风匹配吗、UV 尺度对不对、还能优化什么。
 *
 * **第一问为什么问「画风」而不是「现实」**：
 *   材质的正确标准是**跟着画风走的**，不是「像不像真的」。
 *   卡通场景里一个平涂色块是**对的**；写实场景里同样一块就是错的。
 *   如果问「现实中是这样的吗」，卡通材质会被整片判错——
 *   检测员会说「金属没有金属度」「表面太干净」，然后主智能体
 *   把好好的卡通材质改成写实的，整体风格立刻崩。
 *
 *   所以问的是「这个画风该有的样子」：先告诉它画风是什么，
 *   让它按那个画风的标准判断。
 */
export const MATERIAL_REVIEW_QUESTIONS = [
  {
    id: 'style_match',
    q: '这个材质是它该有的画风吗',
    detail: '先看「任务背景」里写的画风（写实 / 卡通 / 低多边形 / 工业废土…），'
      + '再判断这个材质**符不符合那个画风**：'
      + '写实风要看材质与物品状态是否匹配；新制品允许干净，旧化只在设定需要时检查；'
      + '卡通风要看是不是保持平涂干净（**不要**因为「不够写实」就判它错）；'
      + '低多边形要看是不是刻意的扁平。'
      + '有没有一眼看去**和整体画风不搭**的（缺少设定所需材料响应，'
      + '或卡通场景里一套很脏的扫描材质）？',
  },
  {
    id: 'uv_mapping',
    q: 'UV 的大小映射对吗',
    detail: '使用纹理时，纹理尺度和物体的实际大小匹配吗？有没有明显拉伸、压缩、'
      + '接缝错位或重复频率不合理？相同材料应有一致的物理尺度；纯常量材质不要求 UV。',
  },
  {
    id: 'material_better',
    q: '还有什么可以优化的',
    detail: '按**这个画风的标准**看还差什么：'
      + '写实风——材质响应、凹凸和粗糙度是否符合材料与产品状态？只在设定需要时提出磨损或积灰。'
      + '卡通风——颜色过渡够不够干净？有没有多余的杂色或不该有的斑驳？'
      + '物体的材料和新旧状态是否符合身份与任务设定？只提出有可见依据、影响目标效果的改进。',
  },
]

/**
 * 构造交给检测智能体的完整任务文本。
 *
 * 设计要点：
 *   - **只给图和必要数据**，不给主智能体的自我评价（避免污染判断）
 *   - 明确要求**输出可执行的修改清单**，每条要能落地
 *   - 明确禁止它做别的事（不要它建模、不要它给材质建议）
 *
 * @param {object} o
 * @param {Array} o.groups      物品组（含名称、零件、尺寸）
 * @param {string} o.target     本次检测的范围（组名或「整场景」）
 * @param {object} o.data       检测数据（穿模/孤立/精度/分组状态）
 * @param {number} o.imageCount 附了多少张图
 * @param {string} [o.reference] 参考图路径（有的话）
 * @param {string} [o.sceneNote] 场景背景（这个任务要做什么）
 * @param {string} [o.style] 任务画风（结构与材质模式均使用）
 * @returns {string} 给检测智能体的任务文本
 */
export function buildReviewerPrompt(o) {
  /* 两种模式：
   *   structure（默认）—— 建模阶段，检查形体
   *   material         —— 材质阶段，检查材质和 UV
   *
   * 分开问题以聚焦证据；两类工作可以交替，材质复核不代表几何被冻结。 */
  const mode = o.mode === 'material' ? 'material' : 'structure'
  const questions = mode === 'material' ? MATERIAL_REVIEW_QUESTIONS : REVIEW_QUESTIONS

  const L = []
  L.push(o.reviewer === 'self'
    ? '这是当前建模模型的显式自查，不是独立检测。请先看实际附图，再回答下面三个问题，'
    : '你是**专职视觉检测员**。你的唯一任务是看图，回答下面三个问题，')
  L.push('并给出**可执行的修改清单**。')
  L.push('')
  if (mode === 'material') {
    L.push('**不要做这些事**：不要建模、不要改几何、不要评价「工作量」或')
    L.push('「已经很努力了」。**你只判断材质和 UV。**')
  } else {
    L.push('**不要做这些事**：不要建模、不要改场景、不要给材质或贴图建议、')
    L.push('不要评价「工作量」或「已经很努力了」。**你只判断结构。**')
  }
  L.push('')
  if (o.sceneNote) {
    L.push('## 任务背景')
    L.push('')
    L.push(o.sceneNote)
    L.push('')
  }
  const intent = o.designIntent || {}
  if (intent.scope || intent.layout || intent.materialIntent) {
    L.push('## 已选设计意图（计划，不证明已完成；用户最新要求优先）')
    if (intent.scope) L.push('交付范围：' + ({ scene: '整体场景', single: '单件资产', local: '局部修改' }[intent.scope] || '按用户要求'))
    if (intent.layout) L.push('整体布局：' + String(intent.layout).slice(0, 1600))
    if (mode === 'material' && intent.materialIntent) L.push('材料与状态：' + String(intent.materialIntent).slice(0, 1000))
    L.push('')
  }
  if (mode === 'structure') {
    L.push('## 结构细节的判断标准')
    L.push('')
    if (o.style) L.push('**画风：' + o.style + '**')
    else L.push('画风未明确时，结合任务背景和附图判断；不要自动把任务升级成写实高模。')
    L.push('按用户的用途、最终观看距离和已说明的时间/面数预算判断完成度。')
    L.push('原创设计按功能、风格与结构自洽判断，不把参考实例的尺寸、数量或比例当成默认硬要求；用户明确要求的尺寸与复刻约束仍须遵守。')
    L.push('低多边形、灰模/blockout、简约或卡通任务允许简化；不要强加写实螺丝、密集刻线或细分。')
    L.push('')
    if (!o.target || o.target === '整场景' || o.target === 'scene') {
      const groupCount = Array.isArray(o.groups) ? o.groups.length : 0
      if (intent.scope !== 'single' && intent.scope !== 'local' && (intent.scope === 'scene' || groupCount > 1)) {
        L.push('### 场景整体也要检查')
        L.push('')
        L.push('这些物品组不是互相独立的单件展示；请从附图判断整场景的主次、前中后景、尺度、距离、遮挡、')
        L.push('地面/边界/支撑/连接、空间过渡、环境语义、重复变化、密度与留白。')
        L.push('先对照用户范围与选定布局：是否只完成一个主角，却漏掉主要功能区、次要单元或空间序列。只有一个组时也要核对，组数不能证明覆盖。')
        L.push('从整场景俯视与斜视判断；被遮挡或画外部分不能直接判为缺失。单件/局部任务不扩建，候选设想未被采纳不自动成为缺口。')
        L.push('场景细节应由主题和组间关系推导，不以固定数量、随机散件或堆满画面为目标。')
        L.push('若看不清全局关系，明确指出需要整场景斜视图或局部视图；不要只因单件已经精细就判定场景丰富。')
        L.push('发现有依据的场景缺口时，写成「[组间/环境/视角] 可见证据 → 具体建模动作 → 改后收益」，并汇总到「必须修的」。')
        L.push('')
      }
    }
    L.push('第三问自主检查三层覆盖，不需要主智能体另外提交细节清单：')
    L.push('- **主体轮廓与比例**：主要体块、层次和识别特征是否成立。')
    L.push('- **结构构件与连接**：功能件、支撑、关节、开口、厚度和连接方式是否遗漏。')
    L.push('- **表面几何细节**：只补符合该物品和画风、在目标视距下看得见的倒角、分缝、面板或配件。')
    L.push('硬表面重点核实壳体/板件厚度、开口深度、装配间隙、圆弧轮廓、倒角高光和大中小细节节奏；按物品用途选，不要求每件都有螺丝或刻线。')
    L.push('正交图不足以证明法线、布尔高光或内部结构正确；看不清时点名需要的斜视、底面或局部视图。')
    L.push('这三层是检查角度，不是每层都必须新增几何；先解决比例和结构，再考虑表面细节。')
    L.push('')
    L.push('改进按可见收益排序：优先影响识别度和结构可信度的缺口，再处理近看才见的细节。')
    L.push('每条写清「[组名/部位/视角] 可见证据 → 具体加什么/改什么 → 改后能看出什么」。')
    L.push('不要只写「增加细节」「提升丰富度」；不要为了填满空面堆无关零件，或拿材质/旧化建议代替几何改进。')
    L.push('被遮挡、像素不足或附图未覆盖的区域，只能说明证据不足、需要哪个局部视角，不能编造缺失。')
    L.push('有可见证据且符合任务范围的改进才进入「必须修的」；不影响目标效果的可选装饰可以舍弃。')
    L.push('第三问中确定需要落实的补建项，也要汇总到最后的「必须修的」，供主智能体直接执行；不要只留在分析段落。')
    L.push('如果没有符合任务目标的可见高收益缺口，应明确「已到位/无需修改」并给依据；不要每次复核都发明新装饰、无限加细节。')
    L.push('')
  }
  /* 材质模式必须告诉它画风——否则它只能用「像不像现实」来判断，
   * 而卡通风的平涂会被整片判错。 */
  if (mode === 'material') {
    L.push('## 这个场景的画风（判断标准，必须先看这个）')
    L.push('')
    if (o.style) {
      L.push('**画风：' + o.style + '**')
      L.push('')
      L.push('你判断材质「对不对」，要**按这个画风的标准**，不是按「像不像现实」：')
      L.push('')
      if (/卡通|动漫|赛璐璐|cel|cartoon/i.test(String(o.style))) {
        L.push('- **卡通风的平涂是刻意做出来的，不是缺点。**')
        L.push('  不要因为「金属没有金属反光」「表面太干净没有磨损」就判它错——')
        L.push('  那些正是卡通风格要的效果。')
        L.push('- 该看的是：颜色够不够干净、色块边界清不清晰、'
          + '有没有多余的杂色或斑驳破坏了平涂感。')
      } else if (/像素|pixel/i.test(String(o.style))) {
        L.push('- **像素风要严格限制色板、保持像素感。**')
        L.push('  不要因为「分辨率低」「颜色少」判它错。')
      } else if (/低多边形|lowpoly|low.?poly|扁平|flat/i.test(String(o.style))) {
        L.push('- **低多边形是刻意的棱角分明。**')
        L.push('  不要因为「表面不平滑」「没有细节纹理」判它错。')
      } else {
        L.push('- 写实风：按材料与新旧状态判断反射、粗糙度和尺度；新制品可以干净均匀，不强制磨损或积灰。')
        L.push('- 风格化/半写实：形体可以简化，但光影和材质层次要完整。')
      }
    } else {
      L.push('**没有明确说明画风。** 那你从图上看它是哪种风格'
        + '（写实 / 卡通 / 低多边形 / 像素 / 工业废土），')
      L.push('**按它看起来的那个画风的标准判断**，不要一律按写实标准。')
    }
    L.push('')
    L.push('**注意**：如果图上出现「和整体画风不搭」的材质'
      + '（比如卡通场景里有一块很脏的写实材质），那才是真问题——')
    L.push('说清是哪个部位、不搭在哪里。')
    L.push('写实也允许干净的常量底材，不因没有噪波、贴图或磨损判错。自然纹理与有设定依据的污损可以保留。')
    L.push('从目标视距与代表件近景核对：大块脏斑是否吞没基础色，颗粒或凹凸是否过大，纹理是否有方向与尺度，所有材料是否套了同一种噪波。')
    L.push('旧化应有接触、积水、暴露或使用位置依据，并保留干净区；先确认材料与状态，再判断斑驳是否过强。')
    L.push('只有真实材质渲染才能验证程序节点；灰模图、仅材质色的图、过暗或像素不足时明确证据不足。')
    L.push('看起来脏不直接等于噪波错误：需排查灯光、曝光、采样噪点；有问题时建议在代表件逐项关闭颜色扰动、凹凸、旧化，与干净底材同视角比较。')
    L.push('每项修改写成「部位/视角 + 可见证据 → 调整哪个材质层 → 预期收益」，不规定所有材料统一数值，不要求一律洗白。')
    L.push('')
  }
  L.push('## 你要检查的范围')
  L.push('')
  L.push(o.target ? ('「' + o.target + '」') : '整场景')
  L.push('')
  if (o.target) {
    L.push('**这个组叫什么、是什么东西，上面写了。**')
    if (mode === 'material') {
      L.push('判断「画风对不对」时要用上这个身份——')
      L.push('比如住宅楼可有涂料、砖、石材或混凝土外墙；材料和新旧状态需要符合设计与参考。')
      L.push('不要仅凭名称指定材料、强制旧化或把风格化的简洁材质判成错误。')
      L.push('（注意：判断标准仍以**上面写的画风**为准，不是一律按写实。）')
    } else {
      L.push('判断「现实中是不是这样」时要用上这个身份——')
      L.push('比如「大楼A」是住宅楼，要检查楼层比例、门窗开口、入口与支撑关系是否符合设定；')
      L.push('窗框厚度或入口层次是否需要补充，应由附图、任务画风和观看距离决定。')
    }
    L.push('')
  }
  if (o.groups && o.groups.length) {
    L.push('## 附图的物品组')
    L.push('')
    if (Number.isFinite(Number(o.imageCount))) {
      L.push('本次实际附图：' + Number(o.imageCount) + ' 张；完整检查每组需要 5 个方向。')
      L.push('')
    }
    L.push('**每组都要逐个看，不要只看一个就下结论。**')
    L.push('')
    for (const g of o.groups) {
      L.push('- 「' + g.name + '」' + (g.parts || []).length + ' 个零件')
    }
    L.push('')
  }
  if (o.data) {
    L.push('## 已知数据')
    L.push('')
    L.push('```')
    L.push(o.data)
    L.push('```')
    L.push('')
    L.push('这些只是**参考信息**，不是判断结论。结论要你自己看图得出。')
    L.push('')
  }
  if (o.reference) {
    L.push('## 参考图')
    L.push('')
    L.push('有一张参考图：`' + o.reference + '`。')
    L.push('对照它判断「像不像」——但注意参考图可能有透视和光影，')
    if (mode === 'material') {
      L.push('不要因为**画风**差异就判错，只看**材料和尺度**对不对。')
    } else {
      L.push('不要因为画风或颜色差异就判结构错，只看**结构和比例**。')
    }
    L.push('')
  }
  L.push('## 你要回答的三个问题')
  L.push('')
  L.push('**只回答这三个。多一个都不要。**')
  L.push('')
  for (let i = 0; i < questions.length; i++) {
    const r = questions[i]
    L.push('### ' + (i + 1) + '. ' + r.q + '？')
    L.push('')
    L.push(r.detail)
    L.push('')
    L.push('回答要求：给出**明确结论**（是/否，或「基本可以但有 N 处要改」），')
    L.push('并列出**具体位置**。不要写「整体不错」这种没有信息量的话。')
    L.push('')
  }
  L.push('## 输出格式（必须严格遵守）')
  L.push('')
  L.push('按下面的结构输出，**每一条都要能直接照着改**：')
  L.push('')
  L.push('```')
  L.push('## 问题 1：' + questions[0].q)
  L.push('结论：<是 / 不是 / 基本是但有 N 处问题>')
  L.push('问题清单：')
  L.push('  - [组名/部位] <具体问题> → <具体怎么改>')
  L.push('  ...（没有就写「无」）')
  L.push('')
  L.push('## 问题 2：' + questions[1].q)
  L.push('结论：<对 / 不对 / 大部分对但有 N 处要改>')
  L.push('问题清单：')
  L.push('  - [组名/部位] <具体问题> → <具体怎么改>')
  L.push('  ...（没有就写「无」）')
  L.push('')
  L.push('## 问题 3：' + questions[2].q)
  L.push('结论：<还能改 / 已到位>')
  L.push('改进清单：')
  L.push('  - [组名/部位] <还缺什么> → <具体加什么/改什么>')
  L.push('  ...（没有就写「无」）')
  L.push('')
  L.push('## 必须修的（优先级排序）')
  L.push('1. <最严重的>')
  L.push('2. ...')
  L.push('```')
  L.push('')
  L.push('**「必须修的」这一节是给主智能体的行动清单**——它必须照着改。')
  L.push('所以每条都要写成「哪里 → 改成什么」的形式，不能是「注意一下」「优化一下」。')
  L.push('')
  L.push('如果确实没有要改的，最后一节改成下面两行；不能省略前三个问题的结论：')
  L.push('无需修改')
  L.push('依据：正/后/左/右/顶视图都已检查，……')
  return L.join('\n')
}
/**
 * 把检测智能体的回答解析成结构化清单。
 *
 * 检测智能体的输出是文本，主智能体需要**可执行的条目**。
 * 这里做一层轻量解析：抽出「必须修的」那一节，
 * 以及每个问题的结论行。
 *
 * 解析失败时**原样返回全文**并标记 `parsed: false`——
 * 宁可让主智能体读全文，也不要因为解析失败丢掉内容。
 */
export function parseReview(text) {
  const raw = String(text || '')
  const out = {
    parsed: false,
    valid: false,
    raw,
    conclusions: {},   // structure / reality / better → 结论行
    actions: [],       // 「必须修的」清单
    noChangeNeeded: false,
  }
  if (!raw.trim()) return out

  /* 结论行：形如「结论：xxx」 */
  const conclRe = /结论[：:]\s*(.+)/g
  let m
  const concls = []
  while ((m = conclRe.exec(raw)) !== null) concls.push(m[1].trim())
  if (concls[0]) out.conclusions.structure = concls[0]
  if (concls[1]) out.conclusions.reality = concls[1]
  if (concls[2]) out.conclusions.better = concls[2]

  /* 「必须修的」小节：从标题到下一个二级标题或结尾 */
  const fixIdx = raw.search(/^##\s*必须修的(?=[（\s]|$)/im)
  if (fixIdx >= 0) {
    const rest = raw.slice(fixIdx)
    const next = rest.slice(3).search(/\n##\s/)
    const section = next >= 0 ? rest.slice(0, next + 3) : rest
    for (const line of section.split('\n')) {
      const t = line.trim()
      /* 列表项：- 或 1. 2. 之类 */
      const mm = t.match(/^(?:[-*]|\d+[.、)])\s*(.+)$/)
      if (mm && mm[1]) {
        const item = mm[1].trim()
        if (!item || /^(?:<.*>|\.{2,})$/.test(item)) continue
        if (/^(?:无需修改|不需要修改|没有需要修改(?:的)?|没有要修改(?:的)?|无)[。.]?$/.test(item)) {
          out.noChangeNeeded = true
          continue
        }
        out.actions.push(item)
      }
      if (/^(?:无需修改|不需要修改|没有需要修改(?:的)?|没有要修改(?:的)?|无)[。.]?$/.test(t)) {
        out.noChangeNeeded = true
      }
    }
  }

  /* A no-change result is valid only when all three questions were answered. */
  out.noChangeNeeded = out.actions.length === 0 && out.noChangeNeeded
  out.valid = out.actions.length > 0
    || (out.noChangeNeeded && ['structure', 'reality', 'better'].every((k) => !!out.conclusions[k]))
  out.parsed = out.valid

  return out
}

/** 逐份解析再汇总，避免多组回答中只提取第一份修改清单。 */
export function parseReviewResults(outputs) {
  const reviews = (outputs || []).map((text) => parseReview(text))
  const valid = reviews.length > 0 && reviews.every((review) => review.valid)
  const actions = [...new Set(reviews.flatMap((review) => review.actions))]
  const conclusions = {}
  for (const key of ['structure', 'reality', 'better']) {
    const values = reviews.map((review, i) => review.conclusions[key]
      ? (reviews.length > 1 ? '[复核 ' + (i + 1) + '] ' : '') + review.conclusions[key] : '')
      .filter(Boolean)
    if (values.length) conclusions[key] = values.join('；')
  }
  return {
    raw: reviews.map((review) => review.raw).join('\n\n'),
    parsed: valid, valid, actions, conclusions,
    noChangeNeeded: valid && actions.length === 0 && reviews.every((review) => review.noChangeNeeded),
  }
}

/** 局部复查只替换它实际覆盖的待办，不清掉其他组尚未解决的问题。 */
export function mergeReviewActions(previous = {}, result = {}) {
  const ledger = Object.fromEntries(Object.entries(previous).map(([group, actions]) => [group, [...actions]]))
  if (result.valid) {
    if (result.scope === 'scene' && result.coverageComplete) {
      for (const group of Object.keys(ledger)) delete ledger[group]
    } else {
      for (const group of result.groups || []) delete ledger[group]
    }
  }
  const batches = result.groupActions || [{ groups: result.groups || ['scene'], actions: result.actions || [] }]
  for (const batch of batches) {
    for (const group of batch.groups || []) {
      if (batch.actions?.length) ledger[group] = [...new Set([...(ledger[group] || []), ...batch.actions])]
    }
  }
  return ledger
}

/**
 * 把检测结果渲染成主智能体必须遵循的文本。
 *
 * 关键设计：**明确写「必须按这个改」**，而不是「建议参考」。
 * 因为主智能体是自评人，它天然倾向忽略外部意见。
 */
export function formatReviewDirective(review, opts = {}) {
  const L = []
  const p = review.parsed ? review : { ...review, parsed: false }
  L.push('═══ 检测智能体的结论 ═══')
  L.push('')

  if (p.conclusions && Object.keys(p.conclusions).length) {
    L.push('三个问题的答案：')
    if (p.conclusions.structure) L.push('  1. 结构对吗 → ' + p.conclusions.structure)
    if (p.conclusions.reality) L.push('  2. 现实中是这样吗 → ' + p.conclusions.reality)
    if (p.conclusions.better) L.push('  3. 还能更好吗 → ' + p.conclusions.better)
    L.push('')
  }

  if (p.actions && p.actions.length) {
    L.push('**必须修改的（按检测智能体的优先级）**：')
    L.push('')
    for (let i = 0; i < p.actions.length; i++) L.push('  ' + (i + 1) + '. ' + p.actions[i])
    L.push('')
    L.push('**这些是你下一步要做的。** 不要在没改完之前宣布完成；')
    L.push('改完再跑一次检查，看新结论。')
    L.push('如果你认为某条不该改，要说清**具体理由**（不是「已经够好了」）。')
  } else if (p.noChangeNeeded) {
    L.push('检测智能体认为**无需修改**。')
    if (opts.evidence) L.push('它的依据：' + String(opts.evidence).slice(0, 400))
  } else {
    L.push('检测智能体没有给出结构化的修改清单（可能格式不符合要求）。')
    L.push('下面是它的原始回答，你自己提取要做的事：')
    L.push('')
    L.push(String(review.raw || '').slice(0, 3000))
  }
  L.push('')
  L.push('═══')
  return L.join('\n')
}

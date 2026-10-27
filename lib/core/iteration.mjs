/**
 * 小循环的迭代状态机。
 *
 * 为什么需要独立状态：模型每轮调用 model_loop 都是无状态的，如果不记住
 * 「这是第几轮、上一轮说要改什么」，模型就可以无限循环同一句话，
 * 或者改了一点点就宣布完成。这个模块负责三件事：
 *   1. 记轮次
 *   2. 检查模型是否真的落实了上一轮承诺的改进项
 *   3. 判断「能不能停」
 *
 * 状态按 target 分桶（整场景一个桶，每个部件各自一个桶），
 * 这样并行改多个部件时不会互相污染。
 */

/** 连续多少轮的改进项都落实了，才认为「已经尽力」。 */
/* 连续落实的改进项轮数。
 *
 * 原来 2，现在 1：**只要上一轮承诺的改进真的落实了就算数**。
 * 要求连续 2 轮落实，在第一轮就改对的情况下等于强迫它再改一轮。 */
export const CONSECUTIVE_LANDED_REQUIRED = 1

/** Keep concise, concrete isolation explanations usable without accepting blank or generic acknowledgements. */
export function normalizeIsolationAcknowledgements(items) {
  const map = new Map()
  const generic = /^(?:ok|okay|pass|yes|是|是的|确认|合理|合理的|正常|没问题|可以|同意|保留)$/i
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const part = String(item.part || item.name || '').trim()
    const reason = String(item.reason || '').trim()
    if (!part || !reason || generic.test(reason)) continue
    map.set(part, reason)
  }
  return map
}

export class LoopTracker {
  constructor() {
    /** @type {Map<string, {round:number, pending:string|null, landed:number, history:Array}>} */
    this.buckets = new Map()
  }

  bucket(target) {
    const key = target || 'scene'
    let b = this.buckets.get(key)
    if (!b) {
      b = { round: 0, pending: null, landed: 0, history: [] }
      this.buckets.set(key, b)
    }
    return b
  }

  reset(target) {
    this.buckets.delete(target || 'scene')
  }

  /** 当前轮次（还没开始新一轮时的值）。 */
  current(target) {
    return this.bucket(target).round
  }

  /**
   * 开始一轮。
   *
   * @returns {{round:number, pending:string|null, landedStreak:number, note:string|null}}
   *   note 不为空时表示模型没有交代上一轮承诺的改进项。
   */
  beginRound(target, opts = {}) {
    const b = this.bucket(target)
    if (opts.reset) {
      b.round = 0
      b.pending = null
      b.landed = 0
      b.history = []
    }
    const previousPending = b.pending
    b.round += 1

    let note = null
    /* 连续落实计数只在「上一轮确实承诺过改进项」时才可能 +1。
     * 没有承诺（第一轮，或上一轮已经是 done）时不该被清零——
     * 否则每轮 beginRound 都会把计数打回 0，永远到不了门槛。 */
    if (previousPending) {
      if (opts.landedPrevious === true) {
        b.landed += 1
      } else {
        b.landed = 0
        note = '上一轮你写下的改进项是「' + previousPending + '」，但这一轮没有确认已落实。'
          + '如果没做，请先去做；如果做了，调用时传 landed_previous: true 明确声明。'
      }
    } else if (opts.landedPrevious === true) {
      /* 没有 pending 但声明落实了：仍算一次落实，保持计数增长 */
      b.landed += 1
    }

    return {
      round: b.round,
      pending: previousPending,
      landedStreak: b.landed,
      note,
    }
  }

  /**
   * 记录本轮的判断。
   * @param {string} target
   * @param {{verdict?:string, nextImprovement?:string, stopReason?:string}} decision
   */
  record(target, decision) {
    const b = this.bucket(target)
    const entry = {
      round: b.round,
      verdict: decision.verdict || null,
      nextImprovement: decision.nextImprovement || null,
      stopReason: decision.stopReason || null,
      at: Date.now(),
    }
    b.history.push(entry)
    if (b.history.length > 20) b.history.shift()
    /* 下一轮的 pending 只由 continue 决定；done 时清空。 */
    b.pending = decision.verdict === 'continue' ? (decision.nextImprovement || null) : null
    return entry
  }

  /**
   * 判断现在能不能停。
   *
   * 关键设计：**「检测通过」不等于「可以停」**。
   * 穿模和孤立只能证明几何不自相矛盾，证明不了细节做到位了——
   * 倒角宽度、接缝、面板分割、材质粗糙度这些，检测根本看不见。
   * 所以停的条件里包含「细节自评」这一项，由模型显式声明。
   *
   * @param {string} target
   * @param {{
   *   clean:boolean,
   *   silhouetteOk:boolean|null,
   *   detailNotes?: string,     // 模型对细节的可选记录
   *   remaining?: string,       // 明确说「还剩什么没做」
   *   referenceGiven?: boolean, // 用户是否给了参考图
   *   referenceAnalyzed?: boolean, // 是否已用 model_reference_image 分析过
   * }} facts
   * @returns {{allowed:boolean, reasons:string[], blockers:string[]}}
   */
  canStop(target, facts) {
    const b = this.bucket(target)
    const blockers = []
    const reasons = []

    if (facts.inspectionComplete === false) {
      const detail = Array.isArray(facts.inspectionDetails) && facts.inspectionDetails.length
        ? facts.inspectionDetails.join('；')
        : '几何候选对超过检查上限（' + (facts.inspectionSkipped || 0) + ' 项未覆盖）'
      blockers.push('**几何检查不完整**：' + detail
        + '。未检查部分不能视为通过，但检查受限不等于模型有错。'
        + '先调整检测计算或抽取预算，保留原模型；不要为过关反复减面、删细节或合并零件。'
        + '同一限制仍存在时说明工具能力边界，停止无效重试。')
    }

    /* ═══════════════════════════════════════════════════════════
     * 门禁判据（v2.14 大幅降低）
     *
     * 用户反馈：门禁还是过不去。要求是——
     *   **三问（结构对吗/现实中是这样吗/还能更好吗）的问题全改完，就放行。**
     *
     * 所以现在的设计是：
     *
     *   必须满足
     *     ① 几何检查覆盖完整
     *     ② 视觉复核待办已通过后续复核确认；技术命中只有完整整场景结构复核可覆盖
     *     ③ 任务要求的调研和分组条件满足
     *
     *   只记录、不拦（全部降级为 reason）
     *     · 完整整场景结构复核后仍有穿模 / 孤立命中 → 报告给模型判断
     *     · 剪影未达标           → 同上
     *     · 迭代轮次             → 和「做好了」没有因果关系
     *     · 连续落实轮数         → 同上
     *     · detail_notes 字数    → 逼凑字数没有意义
     *     · remaining 非空       → 只提示
     *
     * 完整整场景结构复核能判断几何命中是否合理；局部复核和材质复核
     * 不覆盖整场景结构，所以仍保留技术检查兜底。
     *
     * ⚠ 唯一的安全网：**如果这个会话从来没派过视觉检测员**，
     * 那就没有「三问」可依，这时回退到技术检测兜底。
     * 否则「不派检测员」会变成绕过一切检查的捷径。
     * ═══════════════════════════════════════════════════════════ */

    /* ── ⓿ 结构调研必须做过（新增，排在所有判据之前）──
     *
     * 为什么这条要排在第一位：它是**唯一能保证清单够全**的东西。
     *
     * 真实事故：一个「1:1 还原哥特式大教堂」的任务，模型在清单里写了
     * 「调研：查哥特式大教堂结构」，然后直接标成 completed——
     * 一次 model_reference 都没调。插件完全没拦住。
     *
     * 根本原因不是疏忽，是机制：Agent 会对着**有度量**的门禁优化，
     * 对没有度量的一律降优先级。调研之前是唯一零可验证产出的条目，
     * 所以它必然被跳过。
     *
     * 现在它有了度量：任务规模决定 required，每次调用累加 calls。
     * 明确要求高保真复刻的场景或真实对象至少需要一条有效资料；普通任务按需调研。 */
    const rr = facts.researchRequired || 0
    const rc = facts.researchCalls || 0
    if (rr > 0) {
      if (rc < rr) {
        const subject = facts.researchSubject ? '「' + facts.researchSubject + '」' : '这个任务'
        blockers.push('**结构调研没做完**：' + subject + '至少需要 ' + rr
          + ' 条有效的构件组成/连接资料，你目前有 ' + rc + ' 条。'
          + '\n   → 调 model_reference 查「它由哪些构件组成、怎么连接」。'
          + '\n   为什么必须查：用户明确要求高保真复刻，主要构件和连接关系需要依据资料核实。'
          + '\n   查到后把 query 写进 detail_notes，便于核对资料是否对应当前结构问题。')
      } else {
        reasons.push('结构调研已完成（' + rc + '/' + rr + ' 次）')
      }
    } else {
      reasons.push('未触发硬性调研要求；结构不确定时可按需查询')
    }

    /* ── ① 视觉复核待办必须经过后续复核确认 ── */
    const reviewUsed = facts.reviewUsed === true
    if (reviewUsed) {
      if (facts.reviewSatisfied === false) {
        if (facts.reviewResultPending) {
          blockers.push('视觉复核任务还没有收到有效回传结果。按任务选定的自查或独立复核方式完成看图，调用 model_review({ apply_result: ... }) 回传，再签收。')
        } else if (facts.reviewResultInvalid) {
          blockers.push('最新视觉复核结果没有解析成有效清单，也没有明确确认无需修改。按任务格式补全三问和「必须修的」清单后重新回传。')
        } else {
          blockers.push('视觉检测给的 ' + (facts.reviewPending || 0)
            + ' 条修改还没有复核确认。完成相关改动后重新调用 model_review，确认没有遗留项再签收。')
        }
      } else {
        reasons.push('视觉复核结果有效，且没有未处理的修改项')
      }
    } else {
      reasons.push('本次没派视觉检测员，用技术检测兜底')
    }

    /* ── ② 分组可靠（基础结构，不能省）──
     *
     * 分组不可靠的话，「组内/组间穿模」「逐组五视图」全部是假的。
     * 这是唯一保留的技术性前提。
     *
     * 但放宽：只有一个物体、或者根本没建组的单物品场景，不拦。 */
    if (facts.groupingNeeded && facts.groupingOk !== true) {
      if (facts.groupedBy !== 'collection') {
        blockers.push('没有用 Blender Collection 分组（当前依据：' + (facts.groupedBy || '无')
          + '）——一个完整物品必须是一个 Collection，'
          + '否则后面所有「按组检查」的结论都不可信。')
      } else if ((facts.ungroupedCount || 0) > 0) {
        blockers.push('有 ' + facts.ungroupedCount + ' 个 mesh 没有归入任何物品组——'
          + '要么漏分组了，要么该单独成组。')
      }
    } else if (facts.groupingNeeded) {
      reasons.push('物品分组可靠（Collection）')
    }

    /* ── 以下全部只记录，不拦截 ── */

    /* 参考图分析：只在真的给了图时提示 */
    if (facts.referenceGiven === true && facts.referenceAnalyzed !== true) {
      reasons.push('⚠ 给了参考图但没分析过（建议补做颜色分析）')
    } else if (facts.referenceGiven === true) {
      reasons.push('已分析参考图颜色数据')
    } else {
      reasons.push('本次没有参考图，按常识和调研建模')
    }

    /* 技术命中只允许完整的整场景结构复核覆盖；局部/材质复核仍需兜底。 */
    if (!facts.clean && facts.inspectionComplete !== false) {
      if (facts.reviewTechnicalOverride !== true) {
        blockers.push('检测还没全过（穿模或孤立有命中），'
          + '当前视觉复核没有覆盖完整场景结构——先修掉，或者完成整场景结构复核。')
      } else {
        reasons.push('⚠ 技术检测仍有命中（穿模/孤立），但视觉检测已通过——'
          + '以完整整场景结构复核的判断为准')
      }
    } else if (facts.inspectionComplete !== false) {
      reasons.push('穿模 0 对、孤立 0 个')
    }

    /* 剪影：只记录 */
    if (facts.silhouetteOk === false) {
      reasons.push('⚠ 剪影未达 92%（有参考图时会比对轮廓）')
    } else if (facts.silhouetteOk === true) {
      reasons.push('剪影已达标')
    }

    /* 轮次只作记录，不设置最低要求，避免模型为了轮数制造改动。 */
    reasons.push('已检查 ' + b.round + ' 轮；轮数不设最低要求')

    /* 只有上一轮确实承诺了改进项时，才提示落实状态。 */
    if (b.pending && b.landed < CONSECUTIVE_LANDED_REQUIRED) {
      reasons.push('上一轮承诺的改进尚未确认落实：「' + b.pending + '」')
    } else if (b.pending) {
      reasons.push('上一轮承诺的改进已确认落实')
    }

    /* 细节自评：只记录 */
    const detailNotes = String(facts.detailNotes || '').trim()
    const remaining = String(facts.remaining || '').trim()
    if (detailNotes.length < 6) {
      reasons.push('没有说明细节做了什么（写清倒角/接缝/配件会更清楚）')
    } else {
      reasons.push('已说明细节处理情况')
    }
    if (remaining.length > 0) {
      reasons.push('你写明了还剩：「' + remaining + '」——建议先做完')
    }

    return { allowed: blockers.length === 0, reasons, blockers }
  }

  /** 导出某桶的历史，供上下文注入用。 */
  summary(target) {
    const b = this.bucket(target)
    return {
      round: b.round,
      pending: b.pending,
      landedStreak: b.landed,
      recent: b.history.slice(-3),
    }
  }
}

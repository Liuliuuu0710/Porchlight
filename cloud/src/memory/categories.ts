/**
 * 事件分类（见《产品逻辑》第 6 节）：模型只能从当前清单里选，不自由起名，保证分类稳定。
 * 每类的“说明”是模型归类的依据；以后用户可以新增 / 改名 / 改说明 / 删除（管理界面后面再做）。
 */
export interface Category {
  id: string
  icon: string
  name: string
  /** 哪些事件属于这类（模型靠这句话归类） */
  desc: string
  /** 所属大类（日报按大类分组；整理时同一大类的相邻事件拿来比是不是同一件） */
  group: string
}

/** 大类：日报分组用（10/16 改成比赛现场：摄像头看展台上发生的事） */
export interface CategoryGroup {
  id: string
  icon: string
  name: string
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { id: 'work', icon: '💻', name: '工作中' },
  { id: 'social', icon: '🙋', name: '交流展示' },
  { id: 'rest', icon: '☕', name: '休息生活' },
  { id: 'items', icon: '📦', name: '物品' },
  { id: 'attention', icon: '⚠️', name: '需要留意' },
  { id: 'other', icon: '❔', name: '其他' },
]

/** 兜底分类：模型给的分类不在清单里时归到这里；不能删除 */
export const OTHER_CATEGORY_ID = 'other'

/**
 * 默认 13 类（10/16 从门口 / 家庭场景改成比赛现场：摄像头放在比赛展台，看展台上发生的事）。
 * 只按“在做什么”分，不按“是谁”分（提示词规定不推测身份）；容易混的在说明里写清归哪类。
 * 一类大致对应用户事后会单独问的一类事（《产品逻辑》3.1.1a）。fall、other 的 id 代码里用到，不能改。
 */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'coding', group: 'work', icon: '💻', name: '埋头开发', desc: '有人坐在桌前用电脑、写代码、看屏幕，一个人安静地做事' },
  { id: 'discuss', group: 'work', icon: '🗣️', name: '团队讨论', desc: '桌边的几个人围在一起说话、一起看同一块屏幕、比划、在纸上写写画画' },
  { id: 'debug', group: 'work', icon: '🧪', name: '调试设备', desc: '有人摆弄摄像头、硬件、手机，插拔线，对着镜头挥手或做动作来测试' },
  { id: 'visit', group: 'social', icon: '🙋', name: '有人来交流', desc: '桌外的人走到桌前停下来、和桌边的人说话、问问题（来的是谁都算；只是路过不停留也算这类）' },
  { id: 'demo', group: 'social', icon: '🎤', name: '演示讲解', desc: '有人对着别人展示屏幕或设备、讲解、拿起作品给人看（有人来看演示、听讲解，算这类，不算“有人来交流”）' },
  { id: 'photo', group: 'social', icon: '📸', name: '拍照录像', desc: '有人举起手机或相机，对着展台、作品或人拍照、录像' },
  { id: 'break', group: 'rest', icon: '🍱', name: '吃喝休息', desc: '有人吃东西、喝水喝咖啡、靠着休息、趴在桌上睡觉、看手机放松' },
  { id: 'supply', group: 'items', icon: '📦', name: '物资送达', desc: '外卖、快递、主办方发的东西被送来、放到桌上，或被领走' },
  { id: 'object', group: 'items', icon: '🤲', name: '物品被拿走 / 留下', desc: '桌上的东西被拿走没有放回，或被放下后一直留在那里（包、手机、电脑、设备等；日常拿起又放回不算）' },
  { id: 'setup', group: 'items', icon: '🧳', name: '布置收拾', desc: '搬东西、布置展台、收拾桌面、整理线缆、打扫' },
  { id: 'fall', group: 'attention', icon: '🩹', name: '有人摔倒', desc: '有人摔倒、跌坐或倒在地上，不论之后有没有起来（弯腰、蹲下、主动躺下不算）' },
  { id: 'camera', group: 'attention', icon: '📷', name: '画面异常', desc: '镜头被挡住、被转动或碰歪，灯光突然变化，或画面里没有人只有光影变化' },
  { id: OTHER_CATEGORY_ID, group: 'other', icon: '❔', name: '其他', desc: '以上都不是' },
]

/** 模型给的分类 id 不在清单里 → 归到“其他” */
export function normalizeCategory(id: string | null | undefined, list: Category[]): string {
  return id && list.some((c) => c.id === id) ? id : OTHER_CATEGORY_ID
}

export function findCategory(id: string | null | undefined, list: Category[]): Category {
  return list.find((c) => c.id === id) ?? list.find((c) => c.id === OTHER_CATEGORY_ID) ?? DEFAULT_CATEGORIES.at(-1)!
}

/** 写进提示词的分类清单 */
export const categoryLines = (list: Category[]) => list.map((c) => `- ${c.id}：${c.icon} ${c.name}——${c.desc}`)

/** 分类所属的大类 id（不认识的分类归“其他”） */
export function groupOf(categoryId: string | null | undefined, list: Category[]): string {
  return findCategory(categoryId, list).group ?? 'other'
}

/** 大类或分类的显示名：日报分组用大类 id，旧数据可能是分类 id */
export function findLabel(id: string, list: Category[]): { icon: string; name: string } {
  return CATEGORY_GROUPS.find((g) => g.id === id) ?? findCategory(id, list)
}

/** 写进提示词的大类说明（日报用） */
export const groupLines = (list: Category[]) =>
  CATEGORY_GROUPS.map((g) => `- ${g.icon} ${g.name}：${list.filter((c) => c.group === g.id).map((c) => c.name).join('、') || '—'}`)

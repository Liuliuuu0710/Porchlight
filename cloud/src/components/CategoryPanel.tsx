import type { Category } from '../memory/categories'
import { Panel } from './Panel'

/**
 * 事件分类清单（只读）：模型只能从这里选。
 * 新增 / 改名 / 改说明 / 删除、挪动事件，以及“收起”“不再提醒”两个开关，后面再做。
 */
export function CategoryPanel({ categories }: { categories: Category[] }) {
  return (
    <Panel id="categories" title="事件分类" defaultOpen={false}>
      <ul className="category-list">
        {categories.map((c) => (
          <li key={c.id}>
            <span className="category-name">
              {c.icon} {c.name}
            </span>
            <small className="muted">{c.desc}</small>
          </li>
        ))}
      </ul>
      <p className="muted small">模型只能从这里选，不自由起名。管理分类（新增、改名、删除）之后再做。</p>
    </Panel>
  )
}

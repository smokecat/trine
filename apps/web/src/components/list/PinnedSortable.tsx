/**
 * 桌面拖动调整置顶工作区顺序（plan §1）：只在精确指针（`pointer: fine`）设备上出现。
 *
 * 每台机器的置顶段各自一个 DndContext——拖动天然限定在同一台机器的置顶段内（顺序本来就是
 * 按机器存的，跨机器拖没有可存的含义）。拖柄是独立按钮（不嵌在组头按钮里），键盘可用：
 * 聚焦后空格 / 回车拿起，方向键移动，空格 / 回车放下，Esc 取消。
 *
 * 只负责交互；放下后把「落在谁的位置」翻译成 before（pin-order.ts pinDropTarget），
 * 由调用方发 cwd.pin.move（乐观更新在 client）。菜单里的上移 / 下移是同一件事的非拖动入口。
 */
import { createContext, use } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVerticalIcon } from 'lucide-react';
import { cn } from '@/lib/utils.ts';

/** 精确指针才给拖柄；触屏走菜单的上移 / 下移 */
export const POINTER_FINE_QUERY = '(pointer: fine)';

/** 只沿竖直方向拖 */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export interface SortableItem {
  /** dnd-kit 的 id：组 key */
  id: string;
  /** 读屏用的名字 */
  label: string;
}

/** 一段同机器置顶组：items 按当前显示顺序；onMove(activeId, overId) 在真的换了位置时调用 */
export function PinnedSortableSegment({
  items,
  onMove,
  children,
}: {
  items: readonly SortableItem[];
  onMove: (activeId: string, overId: string) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const sensors = useSensors(
    // 轻微移动不算拖：组头上的点击（展开 / 菜单）照常
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const labelOf = (id: string | number): string => items.find((i) => i.id === id)?.label ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => `已拿起「${labelOf(active.id)}」。`,
    onDragOver: ({ active, over }) =>
      over === null ? `「${labelOf(active.id)}」不在可放下的位置。` : `「${labelOf(active.id)}」移到「${labelOf(over.id)}」的位置。`,
    onDragEnd: ({ active, over }) =>
      over === null ? `已放下「${labelOf(active.id)}」，顺序未变。` : `已把「${labelOf(active.id)}」放到「${labelOf(over.id)}」的位置。`,
    onDragCancel: ({ active }) => `已取消，「${labelOf(active.id)}」回到原位。`,
  };
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (over === null || active.id === over.id) return;
    onMove(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: '按空格或回车拿起，用上下方向键移动，再按空格或回车放下；按 Esc 取消。',
        },
      }}
    >
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/** SortableGroup 交给组头的拖柄 */
const HandleContext = createContext<React.ReactNode>(null);

/** 组头里放拖柄的位置；不在可拖的段内时什么都不渲染 */
export function PinnedDragHandle(): React.ReactNode {
  return use(HandleContext);
}

/** 当前组在可拖的置顶段里（组头据此在悬停时把图钉让给拖柄） */
export function useInPinnedSortable(): boolean {
  return use(HandleContext) !== null;
}

/** 插入指示线落在被经过的组的哪一边：往上拖落在它上面，往下拖落在它下面 */
export function dropIndicatorSide(index: number, activeIndex: number, isOver: boolean): 'before' | 'after' | null {
  if (!isOver || activeIndex < 0 || activeIndex === index) return null;
  return activeIndex > index ? 'before' : 'after';
}

/** 可拖的一组：包住 GroupSection，位移样式加在外层，拖柄经 context 交给组头 */
export function SortableGroup({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isOver, index, activeIndex } =
    useSortable({ id });
  const indicator = dropIndicatorSide(index, activeIndex, isOver);
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-testid="session-group-drag"
      aria-label={`拖动调整「${label}」的顺序`}
      title="拖动调整顺序"
      // 绝对定位盖在组头的图钉上（组头 px-1 + 箭头 14px + 间距 6px 之后）：平时透明、不占宽，
      // 组头悬停 / 键盘聚焦 / 拖动中才显示
      className={cn(
        'text-text-3 hover:text-text focus-visible:ring-ring absolute top-1/2 left-5 z-10 flex size-5 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded opacity-0 outline-none group-hover/header:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 active:cursor-grabbing',
        isDragging && 'opacity-100',
      )}
      {...attributes}
      {...listeners}
    >
      <GripVerticalIcon aria-hidden className="size-3.5" />
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      data-testid="session-group-sortable"
      data-dragging={isDragging || undefined}
      data-drop-indicator={indicator ?? undefined}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        'relative rounded-lg',
        // 被拖的组：浮起来（阴影 + 底色 + 轻微透明），一眼看得出拿着的是谁
        isDragging && 'bg-surface ring-brand-border z-20 opacity-90 shadow-[var(--shadow-card)] ring-1',
      )}
    >
      {indicator !== null && (
        <span
          aria-hidden
          data-testid="session-group-drop-line"
          className={cn('bg-brand pointer-events-none absolute inset-x-1 h-0.5 rounded-full', indicator === 'before' ? '-top-1.5' : '-bottom-1.5')}
        />
      )}
      <HandleContext value={handle}>{children}</HandleContext>
    </div>
  );
}

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

/** 可拖的一组：包住 GroupSection，位移样式加在外层，拖柄经 context 交给组头 */
export function SortableGroup({ id, label, children }: { id: string; label: string; children: React.ReactNode }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      data-testid="session-group-drag"
      aria-label={`拖动调整「${label}」的顺序`}
      title="拖动调整顺序"
      className="text-text-3 hover:text-text focus-visible:ring-ring flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded outline-none focus-visible:ring-2 active:cursor-grabbing"
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
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'relative z-10 opacity-80')}
    >
      <HandleContext value={handle}>{children}</HandleContext>
    </div>
  );
}

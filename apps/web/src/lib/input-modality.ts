/**
 * 最近一次输入是指针（鼠标 / 触摸 / 笔）还是键盘：弹层打开时据此决定自动聚焦落在哪。
 *
 * 浏览器对「脚本把焦点移到按钮上」常常也显示 focus-visible 焦点框（尤其是 Dialog 自动聚焦
 * 第一个按钮时）。鼠标打开抽屉时不该出现焦点框，键盘打开时则应该照常显示——
 * 所以调用方在指针打开时把焦点放到容器本身（不显示焦点框），键盘打开时沿用默认。
 *
 * 监听装在 document 捕获阶段，首次调用时惰性安装，整个页面只装一次。
 */
let lastPointer = false;
let installed = false;

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerdown', () => (lastPointer = true), true);
  document.addEventListener('mousedown', () => (lastPointer = true), true);
  document.addEventListener('keydown', () => (lastPointer = false), true);
}

export function lastInputWasPointer(): boolean {
  install();
  return lastPointer;
}

/** 测试与首次加载前预装（模块加载时就装上，第一次点击也能记到） */
install();

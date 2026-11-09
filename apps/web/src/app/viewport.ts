/** Keep the mobile shell and portals inside the area visible above the keyboard. */
export function trackVisualViewport(win: Window, root: HTMLElement): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => {};
  const properties = ['--app-viewport-height', '--app-viewport-top', '--app-viewport-bottom'];
  const clear = (): void => properties.forEach((property) => root.style.removeProperty(property));
  const update = (): void => {
    // Preserve the browser's native pinch zoom instead of reflowing content into it.
    if (Math.abs(viewport.scale - 1) > 0.01) { clear(); return; }
    root.style.setProperty(properties[0]!, `${viewport.height}px`);
    root.style.setProperty(properties[1]!, `${viewport.offsetTop}px`);
    root.style.setProperty(properties[2]!, `${Math.max(0, win.innerHeight - viewport.height - viewport.offsetTop)}px`);
  };
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  win.addEventListener('resize', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    win.removeEventListener('resize', update);
    clear();
  };
}

import { describe, expect, test } from 'bun:test';
import { clampDialogWidth, DIALOG_MIN_WIDTH, dragDialogWidth } from './dialog-resize.ts';

describe('dialog resize', () => {
  test('clamps between the minimum and the viewport minus margins', () => {
    expect(clampDialogWidth(100, 1440)).toBe(DIALOG_MIN_WIDTH);
    expect(clampDialogWidth(2000, 1440)).toBe(1408);
    expect(clampDialogWidth(600.4, 1440)).toBe(600);
  });

  test('never goes below the minimum even on a narrow viewport', () => {
    expect(clampDialogWidth(500, 300)).toBe(DIALOG_MIN_WIDTH);
  });

  test('a centered dialog grows by twice the pointer travel on either edge', () => {
    expect(dragDialogWidth(480, 50, 'right', 1440)).toBe(580);
    expect(dragDialogWidth(480, -50, 'left', 1440)).toBe(580);
    expect(dragDialogWidth(480, 50, 'left', 1440)).toBe(380);
  });
});

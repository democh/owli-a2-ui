import type { IROperation, IRSurface } from "@contracts/design-ir";
import { DEVICES, type DeviceId } from "@contracts/a2ui";
import type { NewBoardSpec, NewFrameSpec } from "../command/commandService";

/**
 * surface 集合 → addFrame ops + PageBoard/Frame 规格
 * (imports 与 templates.apply 共用的提交构造;与 orchestrator assembleOps 同构)
 */
export function surfacesToFrameOps(
  surfaces: IRSurface[],
  device: DeviceId = "desktop",
  layout: { colWidth?: number; startX?: number } = {},
): { ops: IROperation[]; boards: NewBoardSpec[]; frames: NewFrameSpec[] } {
  const { colWidth = 520, startX = 0 } = layout;
  const vp = DEVICES[device] ?? DEVICES.desktop;
  const ops: IROperation[] = [];
  const boards: NewBoardSpec[] = [];
  const frames: NewFrameSpec[] = [];

  surfaces.forEach((s, i) => {
    const boardTempKey = `board_${s.id}`;
    boards.push({ tempKey: boardTempKey, title: s.title, posX: startX + i * colWidth, posY: 0 });
    frames.push({
      tempKey: `frame_${s.id}`,
      boardTempKey,
      surfaceId: s.id,
      title: s.title,
      device,
      width: vp.width,
      height: vp.height,
      posX: 0,
      posY: 0,
    });
    ops.push({
      op: "addFrame",
      frame: {
        id: 0,
        pageId: 0,
        surfaceId: s.id,
        title: s.title,
        device,
        width: vp.width,
        height: vp.height,
        posX: 0,
        posY: 0,
      },
      surface: s,
    } as unknown as IROperation);
  });
  return { ops, boards, frames };
}

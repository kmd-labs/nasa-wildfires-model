import { breakpointPx } from '@kmd/design-system/utils/breakpoints';

export interface ViewportFramingBounds {
  isMobile: boolean;
  leftReserve: number;
  rightReserve: number;
  topReserve: number;
  bottomReserve: number;
  availW: number;
  availH: number;
  desiredCenterX: number;
  desiredCenterY: number;
}

/**
 * Computes unobstructed map/globe framing bounds so the initial AOI (Iberia)
 * sits cleanly to the right of the sidepanel on desktop/tablet viewports,
 * and dead-center horizontally on mobile (<= 640px).
 */
export function getUnobstructedViewportBounds(
  width: number,
  height: number,
  panelMinimized: boolean,
  panelExpanded: boolean
): ViewportFramingBounds {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const mobileMax = breakpointPx('mobile');
  const tabletMax = breakpointPx('tablet');
  const desktopMax = breakpointPx('desktop');
  const isMobile = safeW <= mobileMax;

  let leftReserve = 24;
  const rightReserve = 24;
  const topReserve = isMobile ? 68 : 80;
  const bottomReserve = isMobile ? 40 : 48;

  if (!isMobile && !panelMinimized) {
    let panelRight = 0;
    if (typeof document !== 'undefined') {
      const panelEl = document.querySelector('.analytics-panel') as HTMLElement | null;
      const rect = panelEl?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        panelRight = rect.right;
      }
    }

    if (panelRight <= 0) {
      const leftOffset = safeW <= desktopMax ? 8 : 16;
      const cssWidth =
        safeW <= tabletMax
          ? panelExpanded
            ? safeW - 16
            : Math.min(460, safeW - 16)
          : panelExpanded
            ? Math.min(820, safeW * 0.74)
            : Math.min(510, safeW * 0.44);
      panelRight = leftOffset + cssWidth;
    }

    leftReserve = Math.max(24, Math.min(safeW - 180, Math.round(panelRight + 24)));
  }

  const availW = Math.max(140, safeW - leftReserve - rightReserve);
  const availH = Math.max(140, safeH - topReserve - bottomReserve);

  return {
    isMobile,
    leftReserve,
    rightReserve,
    topReserve,
    bottomReserve,
    availW,
    availH,
    desiredCenterX: isMobile ? safeW * 0.5 : leftReserve + availW * 0.5,
    desiredCenterY: topReserve + availH * 0.5
  };
}

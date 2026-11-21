import { Copy, Download, Maximize2, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export default function ImagePreviewOverlay({ image, onClose, onImageContextMenu, onCopy, onDownload }) {
  const MIN_ZOOM = 0.001;
  const MAX_ZOOM = 8;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const stageRef = useRef(null);
  const imageRef = useRef(null);
  const dragRef = useRef(null);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [initialized, setInitialized] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState({ scale: 1, rotation: 0, panX: 0, panY: 0 });

  const clampZoom = value => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  const normalizeRotation = value => ((value % 360) + 360) % 360;
  const rotatedSize = (size, rotation) => {
    const normalized = normalizeRotation(rotation);
    const sideways = normalized === 90 || normalized === 270;
    return sideways ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
  };
  const fitScaleFor = (size, rotation, frame = viewport) => {
    if (!size.width || !size.height || !frame.width || !frame.height) return 1;
    const rotated = rotatedSize(size, rotation);
    return clampZoom(Math.min(1, frame.width / rotated.width, frame.height / rotated.height));
  };
  const clampPan = (candidate, scale, rotation, size = naturalSize, frame = viewport) => {
    if (!size.width || !size.height || !frame.width || !frame.height) return { x: 0, y: 0 };
    const rotated = rotatedSize(size, rotation);
    const displayWidth = rotated.width * scale;
    const displayHeight = rotated.height * scale;
    const maxX = Math.max(0, (displayWidth - frame.width) / 2);
    const maxY = Math.max(0, (displayHeight - frame.height) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, candidate.x)),
      y: Math.min(maxY, Math.max(-maxY, candidate.y)),
    };
  };
  const zoomBy = (factor, anchor = null) => {
    if (!initialized) return;
    setView(current => {
      const nextScale = clampZoom(current.scale * factor);
      if (Math.abs(nextScale - current.scale) < 0.000001) return current;
      let candidate = { x: current.panX, y: current.panY };
      if (anchor) {
        const ratio = nextScale / current.scale;
        candidate = {
          x: anchor.x - (anchor.x - current.panX) * ratio,
          y: anchor.y - (anchor.y - current.panY) * ratio,
        };
      }
      const nextPan = clampPan(candidate, nextScale, current.rotation);
      return { ...current, scale: nextScale, panX: nextPan.x, panY: nextPan.y };
    });
  };
  const resetSize = () => setView({ scale: 1, rotation: 0, panX: 0, panY: 0 });
  const fitToWindow = () => {
    if (!naturalSize.width || !naturalSize.height || !viewport.width || !viewport.height) return;
    setView(current => ({
      ...current,
      scale: fitScaleFor(naturalSize, current.rotation),
      panX: 0,
      panY: 0,
    }));
  };
  const rotate = delta => {
    if (!initialized) return;
    setView(current => {
      const nextRotation = normalizeRotation(current.rotation + delta);
      const nextPan = clampPan({ x: current.panX, y: current.panY }, current.scale, nextRotation);
      return { ...current, rotation: nextRotation, panX: nextPan.x, panY: nextPan.y };
    });
  };

  useEffect(() => {
    const key = event => { if (event.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const update = () => {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (!width || !height) return;
      setViewport(current => current.width === width && current.height === height ? current : { width, height });
    };
    update();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(stage);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (initialized || !naturalSize.width || !naturalSize.height || !viewport.width || !viewport.height) return;
    setView({ scale: fitScaleFor(naturalSize, 0, viewport), rotation: 0, panX: 0, panY: 0 });
    setInitialized(true);
  }, [initialized, naturalSize.width, naturalSize.height, viewport.width, viewport.height]);

  useEffect(() => {
    if (!initialized) return;
    setView(current => {
      const nextPan = clampPan({ x: current.panX, y: current.panY }, current.scale, current.rotation);
      if (Math.abs(nextPan.x - current.panX) < 0.001 && Math.abs(nextPan.y - current.panY) < 0.001) return current;
      return { ...current, panX: nextPan.x, panY: nextPan.y };
    });
  }, [initialized, viewport.width, viewport.height, naturalSize.width, naturalSize.height]);

  if (!image) return null;
  return (
    <div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label="图片预览">
      <button type="button" className="image-preview-close" onClick={onClose} aria-label="关闭图片预览"><X size={22} /></button>
      <div
        className={`image-preview-canvas ${dragging ? 'dragging' : ''}`}
        ref={stageRef}
        onWheel={event => {
          if (!initialized) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
            x: event.clientX - rect.left - rect.width / 2,
            y: event.clientY - rect.top - rect.height / 2,
          });
        }}
        onPointerDown={event => {
          if (!initialized || event.button !== 0 || event.target !== imageRef.current) return;
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            panX: view.panX,
            panY: view.panY,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
          event.preventDefault();
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          if (event.buttons === 0) {
            dragRef.current = null;
            setDragging(false);
            try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
            return;
          }
          const candidate = { x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY };
          setView(current => {
            const nextPan = clampPan(candidate, current.scale, current.rotation);
            return { ...current, panX: nextPan.x, panY: nextPan.y };
          });
          event.preventDefault();
        }}
        onPointerUp={event => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
          try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch {}
        }}
        onPointerCancel={event => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
        }}
        onLostPointerCapture={event => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setDragging(false);
        }}
      >
        <div className="image-preview-transform" style={{ transform: `translate3d(${view.panX}px, ${view.panY}px, 0)` }}>
          <img
            ref={imageRef}
            src={image.src}
            alt={image.alt || '聊天图片预览'}
            draggable={false}
            style={{
              width: naturalSize.width ? `${naturalSize.width}px` : undefined,
              height: naturalSize.height ? `${naturalSize.height}px` : undefined,
              transform: `translate(-50%, -50%) rotate(${view.rotation}deg) scale(${view.scale})`,
              visibility: initialized ? 'visible' : 'hidden',
            }}
            onLoad={event => setNaturalSize({
              width: event.currentTarget.naturalWidth || 1,
              height: event.currentTarget.naturalHeight || 1,
            })}
            onContextMenu={event => onImageContextMenu?.(event, image.src)}
          />
        </div>
      </div>
      <div className="image-preview-toolbar" role="toolbar" aria-label="图片预览工具">
        <button type="button" title="缩小（以图片中心为中心）" aria-label="缩小" disabled={view.scale <= MIN_ZOOM + 0.0001} onClick={() => zoomBy(1 / 1.2)}><ZoomOut size={20} /></button>
        <button type="button" title="放大（以图片中心为中心）" aria-label="放大" disabled={view.scale >= MAX_ZOOM - 0.001} onClick={() => zoomBy(1.2)}><ZoomIn size={20} /></button>
        <button type="button" className="image-preview-reset-size" title="还原大小（100%）" aria-label="还原大小" onClick={resetSize}>1:1</button>
        <button type="button" title="适应窗口" aria-label="适应窗口" onClick={fitToWindow}><Maximize2 size={19} /></button>
        <span className="image-preview-tool-separator" aria-hidden="true" />
        <button type="button" title="向左旋转 90°" aria-label="向左旋转 90 度" onClick={() => rotate(-90)}><RotateCcw size={20} /></button>
        <button type="button" title="向右旋转 90°" aria-label="向右旋转 90 度" onClick={() => rotate(90)}><RotateCw size={20} /></button>
        <span className="image-preview-tool-separator" aria-hidden="true" />
        <button type="button" title="下载图片" aria-label="下载图片" onClick={() => onDownload?.(image)}><Download size={20} /></button>
        <button type="button" title="复制图片" aria-label="复制图片" onClick={() => onCopy?.(image.src)}><Copy size={19} /></button>
      </div>
    </div>
  );
}

// UI-кит Deep Dish: стекло, кольца, листы, сегменты, тумблеры — в дизайн-языке проекта
import React, { useEffect, useRef, useState } from 'react';

export const cx = (...a: Array<string | false | undefined>) => a.filter(Boolean).join(' ');

/** знак Deep Dish (раунд-3, вариант 3): «d» от хвостика — штрих 2R справа над «3 часами», кольцо до «2 часов»; сегменты 50/30/20 светлеют к разрыву */
export function LogoMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="9 9 55 75" aria-hidden="true">
      <path className="dd-logo-s1" fill="none" strokeWidth="6.5" strokeLinecap="round" d="M61.00 12.00 L61.00 14.88 L61.00 17.75 L61.00 20.62 L61.00 23.50 L61.00 26.38 L61.00 29.25 L61.00 32.12 L61.00 35.00 L61.00 37.88 L61.00 40.75 L61.00 43.62 L61.00 46.50 L61.00 49.38 L61.00 52.25 L61.00 55.12 L61.00 58.00 L60.96 59.34 L60.84 60.67 L60.65 61.99 L60.38 63.30 L60.03 64.60 L59.61 65.87 L59.12 67.11 L58.55 68.32 L57.92 69.50 L57.22 70.64 L56.45 71.73 L55.62 72.78 L54.73 73.78 L53.78 74.73 L52.78 75.62 L51.73 76.45 L50.64 77.22 L49.50 77.92 L48.32 78.55 L47.11 79.12 L45.87 79.61 L44.60 80.03 L43.30 80.38 L41.99 80.65 L40.67 80.84 L39.34 80.96 L38.00 81.00" />
      <path className="dd-logo-s2" fill="none" strokeWidth="6.5" strokeLinecap="round" d="M36.66 80.96 L35.33 80.84 L34.01 80.65 L32.70 80.38 L31.40 80.03 L30.13 79.61 L28.89 79.12 L27.68 78.55 L26.50 77.92 L25.36 77.22 L24.27 76.45 L23.22 75.62 L22.22 74.73 L21.27 73.78 L20.38 72.78 L19.55 71.73 L18.78 70.64 L18.08 69.50 L17.45 68.32 L16.88 67.11 L16.39 65.87 L15.97 64.60 L15.62 63.30 L15.35 61.99 L15.16 60.67 L15.04 59.34 L15.00 58.00 L15.04 56.66 L15.16 55.33 L15.35 54.01 L15.62 52.70 L15.97 51.40 L16.39 50.13 L16.88 48.89 L17.45 47.68 L18.08 46.50 L18.78 45.36 L19.55 44.27" />
      <path className="dd-logo-s3" fill="none" strokeWidth="6.5" strokeLinecap="round" d="M20.38 43.22 L21.27 42.22 L22.22 41.27 L23.22 40.38 L24.27 39.55 L25.36 38.78 L26.50 38.08 L27.68 37.45 L28.89 36.88 L30.13 36.39 L31.40 35.97 L32.70 35.62 L34.01 35.35 L35.33 35.16 L36.66 35.04 L38.00 35.00 L39.34 35.04 L40.67 35.16 L41.99 35.35 L43.30 35.62 L44.60 35.97 L45.87 36.39 L47.11 36.88 L48.32 37.45 L49.50 38.08" />
    </svg>
  );
}

export function Card({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={cx('dd-card', className)}>{children}</div>
  );
}

export function Ring({ percent, size = 96, stroke = 10, children }: { percent: number; size?: number; stroke?: number; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  const id = useRef(`ring${Math.random().toString(36).slice(2, 8)}`).current;
  return (
    <div className="dd-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--acc)" />
            <stop offset="1" stopColor="var(--acc2)" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--tr)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${id})`} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${(circ * p) / 100} ${circ}`}
        />
      </svg>
      <div className="dd-ring-val">{children}</div>
    </div>
  );
}

export function Sheet({ open, onClose, children, title, note }: {
  open: boolean; onClose: () => void; children: React.ReactNode; title?: string; note?: string;
}) {
  // свайп вниз за шапку шита — закрытие (нативный жест iOS): зона = ручка + заголовок
  const sheetRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; t0: number; dy: number; v: number; active: boolean } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { y0: e.clientY, t0: performance.now(), dy: 0, v: 0, active: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (dy < -6) { drag.current = null; return; } // движение вверх — отдаём жест прокрутке
      if (dy > 8) {
        d.active = true;
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* указатель уже захвачен */ }
        sheetRef.current?.classList.add('dragging');
      } else return;
    }
    d.dy = Math.max(0, dy);
    d.v = d.dy / Math.max(1, performance.now() - d.t0);
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${Math.round(d.dy * 0.96)}px)`;
  };
  const onUp = () => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    if (sheetRef.current) sheetRef.current.style.transform = '';
    sheetRef.current?.classList.remove('dragging');
    if (d.active && (d.dy > 70 || d.v > 0.55)) onClose();
  };
  useLockScroll(open);
  return (
    <>
      <div className={cx('dd-sheet-bg', open && 'show')} onClick={onClose} />
      <div className={cx('dd-sheet', open && 'show')} ref={sheetRef}>
        <div
          className="dd-sheet-head"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        >
          <div className="dd-grab" />
          {title && <h3 className="dd-sheet-title">{title}</h3>}
          {note && <div className="dd-sheet-note">{note}</div>}
        </div>
        {children}
      </div>
    </>
  );
}

// ── Модальность: пока открыт хоть один шит/модал — фон не скроллится и не кликается ──
let scrollLocks = 0;
function useLockScroll(open: boolean) {
  useEffect(() => {
    if (!open) return;
    scrollLocks++;
    document.documentElement.style.overflow = 'hidden';
    return () => { if (--scrollLocks === 0) document.documentElement.style.overflow = ''; };
  }, [open]);
}

/** верхняя доппанель (типовые порции при создании продукта): выезжает сверху, фон блурится */
export function TopSheet({ open, onClose, title, children }: {
  open: boolean; onClose: () => void; children: React.ReactNode; title?: string;
}) {
  useLockScroll(open);
  return (
    <>
      <div className={cx('dd-sheet-bg', open && 'show')} onClick={onClose} />
      <div className={cx('dd-topsheet', open && 'show')}>
        <div className="dd-sheet-head">
          <div className="dd-grab" />
          {title && <h3 className="dd-sheet-title">{title}</h3>}
        </div>
        {children}
      </div>
    </>
  );
}

/** строка со свайпом влево для удаления (ингредиент рецепта): touch-action pan-y не мешает вертикальному скроллу */
export function SwipeRow({ onRemove, children }: { onRemove: () => void; children: React.ReactNode }) {
  const [dx, setDx] = useState(0);
  const [anim, setAnim] = useState(true);
  const st = useRef<{ x0: number; y0: number; active: boolean | null } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    st.current = { x0: e.clientX, y0: e.clientY, active: null };
    setAnim(false);
  };
  const onMove = (e: React.PointerEvent) => {
    const s = st.current; if (!s) return;
    const dxp = e.clientX - s.x0, dyp = e.clientY - s.y0;
    if (s.active === null) {
      if (Math.abs(dyp) > 8 && Math.abs(dyp) > Math.abs(dxp)) { st.current = null; return; } // вертикаль — скролл листа
      if (dxp < -8) {
        s.active = true;
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* захвачено */ }
      } else if (dxp > 8) { st.current = null; return; }
      else return;
    }
    setDx(Math.max(-96, Math.min(0, dxp)));
  };
  const onUp = () => {
    const s = st.current; if (!s) return;
    st.current = null;
    setAnim(true);
    if (s.active && dx < -64) { setDx(-96); setTimeout(onRemove, 120); }
    else setDx(0);
  };
  return (
    <div className="dd-swiperow">
      <div className="dd-swiperow-del">удалить</div>
      <div
        className="dd-swiperow-body"
        style={{ transform: `translateX(${dx}px)`, transition: anim ? 'transform .18s ease' : 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      >
        {children}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="dd-seg">
      {options.map(o => (
        <button key={o.value} className={cx(o.value === value && 'on')} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={cx('dd-sw', on && 'on')} onClick={() => onChange(!on)} aria-pressed={on} />;
}

export function ActionButton({ children, onClick, type }: { children: React.ReactNode; onClick?: () => void; type?: 'submit' }) {
  return <button type={type} className="dd-action" onClick={onClick}>{children}</button>;
}

export function Modal({ open, onClose, children }: { open: boolean; onClose?: () => void; children: React.ReactNode }) {
  useLockScroll(open);
  if (!open) return null;
  return (
    <div className="dd-modal-bg" onClick={onClose}>
      <div className="dd-modal" onClick={e => e.stopPropagation()}>{children}</div>
    </div>
  );
}

export function Confirm({ open, text, onOk, onCancel, okLabel = 'Да', cancelLabel = 'Отмена' }: {
  open: boolean; text: string; onOk: () => void; onCancel: () => void; okLabel?: string; cancelLabel?: string;
}) {
  return (
    <Modal open={open} onClose={onCancel}>
      <p className="dd-modal-text">{text}</p>
      <div className="dd-modal-row">
        <button className="dd-action" onClick={onCancel}>{cancelLabel}</button>
        <button className="dd-action strong" onClick={onOk}>{okLabel}</button>
      </div>
    </Modal>
  );
}

/** Сворачиваемая секция (состояние — снаружи, чтобы запоминалось). */
export function Collapse({ title, open, onToggle, children, right }: {
  title: React.ReactNode; open: boolean; onToggle: () => void; children: React.ReactNode; right?: React.ReactNode;
}) {
  return (
    <div className="dd-collapse">
      <button className="dd-collapse-head" onClick={onToggle}>
        <span className="dd-collapse-title">{title}</span>
        <span className="dd-collapse-right">{right}<span className={cx('dd-chev', open && 'up')}>⌄</span></span>
      </button>
      {open && children}
    </div>
  );
}

export function useSwipe(onLeft: () => void, onRight: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]; start.current = { x: t.clientX, y: t.clientY }; },
    onTouchEnd: (e: React.TouchEvent) => {
      if (!start.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.current.x; const dy = t.clientY - start.current.y;
      start.current = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) (dx < 0 ? onLeft : onRight)();
    },
  };
}

export function Slide({ dir, children }: { dir: 0 | -1 | 1; children: React.ReactNode }) {
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (dir === 0) return;
    setCls(dir < 0 ? 'slide-from-r' : 'slide-from-l');
    const t = setTimeout(() => setCls(''), 260);
    return () => clearTimeout(t);
  }, [dir]);
  return <div className={cx('dd-slide', cls)}>{children}</div>;
}

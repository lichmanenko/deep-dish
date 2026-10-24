// Слой сканера штрихкодов (v0.7.0): камера + ZXing, полноэкранный оверлей.
// Загружается лениво (динамический import) — ZXing не раздувает основной бандл.
import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';

export function ScannerLayer({ onCode, onClose }: { onCode: (ean: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const [hit, setHit] = useState('');

  useEffect(() => {
    let controls: { stop: () => void } | null = null;
    let closed = false;
    const reader = new BrowserMultiFormatReader();
    (async () => {
      try {
        controls = await reader.decodeFromVideoDevice(undefined, videoRef.current!, (result) => {
          if (closed || !result) return;
          const text = result.getText();
          if (/^\d{8,13}$/.test(text)) {
            closed = true;
            setHit(text);
            try { navigator.vibrate?.(40); } catch { /* нет вибро */ }
            setTimeout(() => onCode(text), 350);
          }
        });
        if (closed) controls.stop();
      } catch (e) {
        setErr('Камера недоступна: ' + (e as Error).message);
      }
    })();
    return () => { closed = true; controls?.stop(); };
  }, [onCode]);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 90, background: '#0B1116',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      paddingTop: 'calc(24px + env(safe-area-inset-top))',
    }}>
      <video ref={videoRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} playsInline muted />
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '100%', pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute', left: '50%', top: '38%', transform: 'translate(-50%, -50%)',
          width: '78%', height: 170, borderRadius: 20,
          border: `2px solid ${hit ? 'var(--ok)' : 'rgba(255,255,255,.85)'}`,
          boxShadow: '0 0 0 9999px rgba(6,10,14,.55)',
        }} />
        <div style={{
          position: 'absolute', left: '50%', top: '38%', transform: 'translate(-50%, 130px)',
          color: '#fff', fontSize: '0.9rem', fontWeight: 600, textShadow: '0 1px 4px rgba(0,0,0,.6)', width: '80%', textAlign: 'center',
        }}>
          {hit ? '✓ код считан: ' + hit : err ? err : 'Наведи камеру на штрихкод упаковки'}
        </div>
      </div>
      <button className="dd-action" style={{ position: 'absolute', top: 'calc(14px + env(safe-area-inset-top))', right: 14, width: 44, padding: 0, flex: 'none' }} onClick={onClose}>✕</button>
    </div>
  );
}

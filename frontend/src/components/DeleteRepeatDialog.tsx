import { useEffect, useRef } from 'react';

// Asked when deleting an occurrence of a repeating event: only this event, or
// every event in the series.
export default function DeleteRepeatDialog({
  title,
  closing,
  onCancel,
  onThis,
  onAll,
}: {
  title: string;
  closing: boolean;
  onCancel: () => void;
  onThis: () => void;
  onAll: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className={`modal-backdrop ${closing ? 'closing' : ''}`}
      inert={closing || undefined}
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="modal" role="alertdialog" aria-label="Delete repeating event">
        <h2>Delete repeating event?</h2>
        <p className="modal-text">
          &ldquo;{title || '(No title)'}&rdquo; repeats. Delete only this event, or all events in the series?
        </p>
        <div className="modal-foot">
          <button ref={cancelRef} type="button" className="text-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="text-btn" onClick={onThis}>
            This event
          </button>
          <button type="button" className="text-btn danger" onClick={onAll}>
            All events
          </button>
        </div>
      </div>
    </div>
  );
}

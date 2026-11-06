// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string | undefined;
  danger?: boolean;
}

interface Props {
  items: MenuItem[];
  /** Controls that open their own panel, such as delete, are placed below the items. */
  children?: ReactNode;
}

/**
 * The "⋯ More" menu for secondary task actions. It closes on Escape, on a press outside it and
 * when an item is chosen. Escape is consumed here, so it does not also close the task panel.
 */
export function TaskActionsMenu({ items, children }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The list is placed by the viewport, not the header: the header scrolls and would clip it.
  const [anchor, setAnchor] = useState({ top: 0, right: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    // Focus moves into the menu, so it can be used from the keyboard.
    wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const onPress = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    // A scroll moves the trigger away from the list, so the list closes; scrolling the list itself does not.
    const onScroll = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Runs before the panel's own Escape handler on window, which skips events already handled.
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPress);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const choose = (item: MenuItem) => {
    setOpen(false);
    item.onSelect();
  };

  return (
    <div className="task-menu" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="btn ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) {
            const box = trigger.current!.getBoundingClientRect();
            setAnchor({ top: box.bottom + 4, right: window.innerWidth - box.right });
          }
          setOpen(!open);
        }}
      >
        ⋯ {t('actions.more')}
      </button>
      {open && (
        <div className="task-menu-pop" style={{ top: anchor.top, right: anchor.right }}>
          <div role="menu" id={menuId} aria-label={t('actions.more')}>
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={`task-menu-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                title={item.title}
                onClick={() => choose(item)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

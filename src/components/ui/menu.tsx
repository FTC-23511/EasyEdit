"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { FADE, cx } from "./cx";
import { IconButton, type IconButtonProps } from "./icon-button";

export type MenuItem = { id: string; label: string; disabled?: boolean; danger?: boolean };

export type MenuProps = Omit<IconButtonProps, "label" | "children" | "pressed" | "onSelect"> & {
  label: string;
  icon: ReactNode;
  items: MenuItem[];
  onSelect(id: string): void;
};

const GAP = 4; // between the button and the list
const EDGE = 8; // the list keeps this far from the window's edges

function enabledItems(list: HTMLElement | null): HTMLButtonElement[] {
  return [...(list?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
}

// An icon button that opens a list of actions under it. The arrow keys, Home and End move between
// the items. Escape, a click outside or picking an item closes it, and focus goes back to the button.
// Extra props go on the button.
export function Menu({ label, icon, items, onSelect, disabled, className, onClick, onKeyDown, ...rest }: MenuProps) {
  const [openAt, setOpenAt] = useState<"first" | "last" | null>(null);
  // Turning disabled closes the menu for good, so enabling it again does not reopen it.
  if (disabled && openAt !== null) setOpenAt(null);
  const open = openAt !== null && !disabled;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  function close(refocus: boolean) {
    setOpenAt(null);
    if (refocus) trigger.current?.focus();
  }

  // Placed under the button, or above it when there is no room below, inside the window. Fixed
  // positioning keeps the list clear of panels that clip their overflow.
  useLayoutEffect(() => {
    const button = trigger.current;
    const menu = list.current;
    if (!open || !button || !menu) return;
    const anchor = button.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    let top = anchor.bottom + GAP;
    if (top + size.height > window.innerHeight - EDGE) top = Math.max(EDGE, anchor.top - GAP - size.height);
    let left = anchor.left;
    if (left + size.width > window.innerWidth - EDGE) left = Math.max(EDGE, anchor.right - size.width);
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.style.visibility = "visible";
    const choices = enabledItems(menu);
    (openAt === "last" ? choices.at(-1) : choices[0])?.focus();
  }, [open, openAt]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (list.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpenAt(null);
      // A click on something that takes focus keeps it; otherwise focus comes back to the button.
      setTimeout(() => {
        if (document.activeElement === document.body && trigger.current?.isConnected) trigger.current.focus();
      }, 0);
    }
    function onScroll(event: Event) {
      if (!list.current?.contains(event.target as Node)) setOpenAt(null);
    }
    function onResize() {
      setOpenAt(null);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpenAt(event.key === "ArrowDown" ? "first" : "last");
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close(false);
    }
  }

  function handleListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const choices = enabledItems(list.current);
    const at = choices.indexOf(document.activeElement as HTMLButtonElement);
    const n = choices.length;
    const moves: Record<string, () => number> = {
      ArrowDown: () => (at + 1) % n,
      ArrowUp: () => (at <= 0 ? n - 1 : at - 1),
      Home: () => 0,
      End: () => n - 1,
    };
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    } else if (moves[event.key]) {
      event.preventDefault();
      if (n > 0) choices[moves[event.key]()].focus();
    }
  }

  return (
    <span className="relative inline-flex">
      <IconButton
        ref={trigger}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        className={cx("aria-expanded:bg-ed-hover aria-expanded:text-ed-text", className)}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) setOpenAt(open ? null : "first");
        }}
        onKeyDown={handleTriggerKeyDown}
        {...rest}
      >
        {icon}
      </IconButton>
      {open && (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={label}
          style={{ visibility: "hidden" }}
          className="fixed z-50 flex max-h-80 min-w-40 flex-col overflow-y-auto rounded-md border border-ed-line bg-ed-raised py-1 shadow-lg"
          onKeyDown={handleListKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              className={cx(
                "flex h-7 shrink-0 items-center px-3 text-left text-xs whitespace-nowrap select-none",
                item.danger ? "text-ed-danger" : "text-ed-text",
                "enabled:hover:bg-ed-hover focus-visible:bg-ed-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ed-accent",
                "disabled:cursor-not-allowed disabled:opacity-40",
                FADE,
              )}
              onClick={() => {
                close(true);
                onSelect(item.id);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

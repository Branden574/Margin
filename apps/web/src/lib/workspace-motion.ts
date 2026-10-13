import { animate } from 'animejs/animation';
import { createAnimatable } from 'animejs/animatable';
import { createScope } from 'animejs/scope';

const interactive = '.recent-card, .folder-card, [data-home-action]';
const entrance = [
  '.role-home .page-heading > div',
  '.role-home .page-heading > button',
  '.role-home-overview > div',
  '.role-home-queue',
  '.role-home-aside',
  '.role-home-local',
  '.recent-section',
  '.folder-section',
  '.all-documents',
];

/** Kept in a separate chunk so editor and LMS routes do not load Anime.js. */
export function mountWorkspaceMotion(root: HTMLElement, reveal: boolean) {
  const scope = createScope({
    root,
    mediaQueries: {
      reduced: '(prefers-reduced-motion: reduce)',
      hover: '(hover: hover) and (pointer: fine)',
    },
  });

  scope.add((self) => {
    const enter = reveal;
    reveal = false;
    if (!self || self.matches.reduced) return;

    if (enter) {
      entrance.forEach((selector, index) => {
        const targets = root.querySelectorAll<HTMLElement>(selector);
        if (!targets.length) return;
        animate(targets, {
          translateY: [index < 3 ? 12 : 18, 0],
          delay: index * 38,
          duration: 440,
          ease: 'out(4)',
          // Restore the resting layout without permanent stacking contexts.
          onComplete: (animation) => animation.revert(),
        });
      });
    }

    type Motion = ReturnType<typeof createAnimatable>;
    const items = new Map<
      HTMLElement,
      { hovered: boolean; focused: boolean; card?: Motion; icon?: Motion }
    >();

    function target(value: EventTarget | null) {
      const element = value instanceof Element ? value.closest<HTMLElement>(interactive) : null;
      return element && root.contains(element) ? element : null;
    }

    function update(element: HTMLElement, kind: 'hovered' | 'focused', value: boolean) {
      let item = items.get(element);
      if (!item) {
        if (!value) return;
        const icon = element.querySelector<HTMLElement>('[data-home-icon]');
        item = {
          hovered: false,
          focused: false,
          card: element.matches('.recent-card, .folder-card')
            ? createAnimatable(element, { translateY: 220, ease: 'out(3)' })
            : undefined,
          icon: icon
            ? createAnimatable(icon, {
                [icon.dataset.homeIcon === 'lift' ? 'translateY' : 'translateX']: 220,
                ease: 'out(3)',
              })
            : undefined,
        };
        items.set(element, item);
      }
      item[kind] = value;
      const engaged = item.hovered || item.focused;
      item.card?.translateY(engaged ? -4 : 0);
      const icon = element.querySelector<HTMLElement>('[data-home-icon]');
      if (icon?.dataset.homeIcon === 'lift') item.icon?.translateY(engaged ? -2 : 0);
      else item.icon?.translateX(engaged ? 3 : 0);
    }

    const pointerOver = (event: PointerEvent) => {
      if (!self.matches.hover || event.pointerType === 'touch') return;
      const element = target(event.target);
      if (element && element !== target(event.relatedTarget)) update(element, 'hovered', true);
    };
    const pointerOut = (event: PointerEvent) => {
      const element = target(event.target);
      if (element && element !== target(event.relatedTarget)) update(element, 'hovered', false);
    };
    const focusIn = (event: FocusEvent) => {
      const element = target(event.target);
      if (element) update(element, 'focused', true);
    };
    const focusOut = (event: FocusEvent) => {
      const element = target(event.target);
      if (element && element !== target(event.relatedTarget)) update(element, 'focused', false);
    };

    // Delegation includes newly filtered/sorted cards; removed cards release their animations.
    const observer = new MutationObserver((records) => {
      if (!records.some((record) => record.removedNodes.length)) return;
      for (const [element, item] of items) {
        if (root.contains(element)) continue;
        item.card?.revert();
        item.icon?.revert();
        items.delete(element);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('pointerover', pointerOver);
    root.addEventListener('pointerout', pointerOut);
    root.addEventListener('focusin', focusIn);
    root.addEventListener('focusout', focusOut);

    return () => {
      observer.disconnect();
      root.removeEventListener('pointerover', pointerOver);
      root.removeEventListener('pointerout', pointerOut);
      root.removeEventListener('focusin', focusIn);
      root.removeEventListener('focusout', focusOut);
      for (const item of items.values()) {
        item.card?.revert();
        item.icon?.revert();
      }
      items.clear();
    };
  });

  return () => scope.revert();
}

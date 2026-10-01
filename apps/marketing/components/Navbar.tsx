'use client';
import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { AccessButton } from './Actions';
const links = [
  ['Product', '#product'],
  ['Teachers', '#teachers'],
  ['Students', '#students'],
  ['Schools', '#schools'],
  ['Security', '#security'],
  ['Compare', '#compare'],
  ['Pricing', '#pricing'],
];
export function Navbar() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState('#product');
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setActive(`#${entry.target.id}`);
      },
      { rootMargin: '-12% 0px -72% 0px', threshold: 0 },
    );
    for (const [, href] of links) {
      const element = document.getElementById(href.slice(1));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return (
    <header
      className="site-nav"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <div className="nav-inner">
        <a href="/#main" aria-label="Margin home" className="wordmark">
          margin<span>.</span>
        </a>
        <nav
          aria-label="Main navigation"
          id="site-navigation"
          className={open ? 'navigation is-open' : 'navigation'}
        >
          {links.map(([name, href]) => (
            <a
              key={name}
              href={href}
              aria-current={active === href ? 'location' : undefined}
              onClick={() => {
                setOpen(false);
                setActive(href);
              }}
            >
              {name}
            </a>
          ))}
        </nav>
        <div className="nav-actions">
          <AccessButton kind="access" className="text-button desktop-signin">
            Sign in
          </AccessButton>
          <AccessButton className="button primary small">
            Add to Chrome <span aria-hidden="true">↗</span>
          </AccessButton>
          <button
            className="icon-control menu-toggle"
            aria-label={open ? 'Close navigation' : 'Open navigation'}
            aria-expanded={open}
            aria-controls="site-navigation"
            onClick={() => setOpen(!open)}
          >
            {open ? <X /> : <Menu />}
          </button>
        </div>
      </div>
    </header>
  );
}

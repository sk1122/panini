export const landingScript = String.raw`
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const menuButton = document.querySelector('[data-menu-button]');
const menu = document.querySelector('[data-menu]');

function closeMenu() {
  if (!menuButton || !menu) return;
  menuButton.setAttribute('aria-expanded', 'false');
  menu.removeAttribute('data-open');
}

if (menuButton && menu) {
  menuButton.addEventListener('click', () => {
    const isOpen = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!isOpen));
    if (isOpen) menu.removeAttribute('data-open');
    else menu.setAttribute('data-open', '');
  });

  menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
}

const revealItems = document.querySelectorAll('[data-reveal]');
if (motionQuery.matches || !('IntersectionObserver' in window)) {
  revealItems.forEach((item) => item.setAttribute('data-visible', ''));
} else {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.setAttribute('data-visible', '');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.16, rootMargin: '0px 0px -6% 0px' });
  revealItems.forEach((item) => observer.observe(item));
}

const visual = document.querySelector('[data-hero-visual]');
if (visual && !motionQuery.matches) {
  visual.addEventListener('pointermove', (event) => {
    const bounds = visual.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    visual.style.setProperty('--shift-x', String(x));
    visual.style.setProperty('--shift-y', String(y));
  });
  visual.addEventListener('pointerleave', () => {
    visual.style.setProperty('--shift-x', '0');
    visual.style.setProperty('--shift-y', '0');
  });
}
`;

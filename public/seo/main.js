// ── MOBILE MENU ─────────────────────────────────────────────────────────
const hamburger = document.getElementById('hamburger');
const navLinks = document.getElementById('navLinks');

hamburger.addEventListener('click', () => {
  hamburger.classList.toggle('active');
  navLinks.classList.toggle('open');
});

// ── IN-PAGE NAV LINKS ───────────────────────────────────────────────────
// Smooth-scroll to section and update the URL so it reflects where you are.
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const href = link.getAttribute('href');
    const id = href.slice(1);
    e.preventDefault();
    hamburger.classList.remove('active');
    navLinks.classList.remove('open');
    const target = id ? document.getElementById(id) : null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
});
// If someone lands with a hash in the URL (shared link), honor the scroll.
if (window.location.hash) {
  const target = document.getElementById(window.location.hash.slice(1));
  if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 50);
}

// ── NAV SHADOW ON SCROLL ────────────────────────────────────────────────
const nav = document.querySelector('.nav');
window.addEventListener('scroll', () => {
  nav.style.boxShadow = window.scrollY > 10
    ? '0 1px 12px rgba(0,0,0,0.06)'
    : 'none';
});

// ── SCROLL ANIMATIONS ──────────────────────────────────────────────────
const fadeEls = document.querySelectorAll('.fade-in');
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      setTimeout(() => entry.target.classList.add('visible'), i * 80);
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });

fadeEls.forEach(el => observer.observe(el));

// ── FAQ ACCORDION ──────────────────────────────────────────────────────
document.querySelectorAll('.faq-question').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.parentElement;
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});

// ── CONTACT FORM ────────────────────────────────────────────────────────
const form = document.getElementById('contactForm');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('.form-submit');
  const originalText = btn.textContent;
  btn.textContent = 'Sending...';
  btn.disabled = true;

  try {
    const data = {
      name: form.name.value,
      business: form.business.value,
      type: form.type.value,
      email: form.email.value,
      website: form.website ? form.website.value : ''
    };

    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    if (res.ok) {
      btn.textContent = 'Sent! We\'ll be in touch.';
      btn.style.background = '#16a34a';
      form.reset();
    } else {
      btn.textContent = 'Something went wrong. Try again.';
      btn.style.background = '#ef4444';
    }
  } catch {
    btn.textContent = 'Something went wrong. Try again.';
    btn.style.background = '#ef4444';
  }

  setTimeout(() => {
    btn.textContent = originalText;
    btn.style.background = '';
    btn.disabled = false;
  }, 3000);
});

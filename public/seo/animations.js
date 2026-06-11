// ══════════════════════════════════════════════════════════════════════════
// FORGE AI — Premium Animations v2
// ══════════════════════════════════════════════════════════════════════════

(function() {
  'use strict';

  // Init animations on page load
  window.addEventListener('load', () => initAnimations());

  function initAnimations() {
    initHeroReveal();
    initParticles();
    initInteractiveGrid();
    initCursorSpotlight();
    initCardTilt();
    initMagneticButtons();
    initCardSpotlight();
    initSectionReveal();
    initIconDraw();
    initTextScramble();
    initScrollProgress();
    initNavAutoHide();
    initInboxEntrance();
    initTextHighlights();
    initParallaxOrbs();
    initSmoothCounters();
  }

  // ── HERO WORD-BY-WORD REVEAL ─────────────────────────────────────────
  function initHeroReveal() {
    const heroH1 = document.querySelector('.hero h1');
    if (!heroH1) return;

    let wordIndex = 0;
    function wrapTextNodes(node) {
      const children = Array.from(node.childNodes);
      children.forEach(child => {
        if (child.nodeType === 3) {
          const words = child.textContent.split(/(\s+)/);
          const frag = document.createDocumentFragment();
          words.forEach(part => {
            if (/^\s*$/.test(part)) {
              frag.appendChild(document.createTextNode(part));
            } else {
              wordIndex++;
              const span = document.createElement('span');
              span.className = 'hero-word';
              span.style.transitionDelay = (wordIndex * 0.07) + 's';
              span.textContent = part;
              frag.appendChild(span);
            }
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          wrapTextNodes(child);
        }
      });
    }
    wrapTextNodes(heroH1);

    setTimeout(() => {
      document.querySelector('.hero').classList.add('animated');
      document.querySelectorAll('.hero-word').forEach(w => w.classList.add('revealed'));
    }, 300);
  }

  // ── PARTICLE CANVAS ──────────────────────────────────────────────────
  function initParticles() {
    const canvas = document.getElementById('particleCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let w, h, particles = [], mouse = { x: -500, y: -500 };
    const PARTICLE_COUNT = 80;
    const CONNECTION_DIST = 120;

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    document.addEventListener('mousemove', e => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    });

    class Particle {
      constructor() {
        this.x = Math.random() * w;
        this.y = Math.random() * h;
        this.vx = (Math.random() - 0.5) * 0.4;
        this.vy = (Math.random() - 0.5) * 0.4;
        this.r = Math.random() * 1.5 + 0.5;
        this.opacity = Math.random() * 0.3 + 0.1;
      }
      update() {
        this.x += this.vx;
        this.y += this.vy;
        if (this.x < 0 || this.x > w) this.vx *= -1;
        if (this.y < 0 || this.y > h) this.vy *= -1;

        // Mouse repel
        const dx = this.x - mouse.x;
        const dy = this.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          const force = (150 - dist) / 150 * 0.02;
          this.vx += dx * force;
          this.vy += dy * force;
        }

        // Dampen
        this.vx *= 0.99;
        this.vy *= 0.99;
      }
      draw() {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(201,226,101,${this.opacity})`;
        ctx.fill();
      }
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(new Particle());
    }

    function drawConnections() {
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONNECTION_DIST) {
            const alpha = (1 - dist / CONNECTION_DIST) * 0.08;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(201,226,101,${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
    }

    function animate() {
      ctx.clearRect(0, 0, w, h);
      particles.forEach(p => { p.update(); p.draw(); });
      drawConnections();
      requestAnimationFrame(animate);
    }
    animate();
  }

  // ── INTERACTIVE DOT GRID ─────────────────────────────────────────────
  function initInteractiveGrid() {
    const grid = document.getElementById('heroGrid');
    if (!grid) return;

    const GAP = 40;
    const hero = document.querySelector('.hero');
    if (!hero) return;

    const rect = hero.getBoundingClientRect();
    const cols = Math.ceil(rect.width / GAP);
    const rows = Math.ceil(rect.height / GAP);
    const dots = [];

    // Position grid inside hero
    grid.style.position = 'absolute';
    grid.style.top = '0';
    grid.style.left = '0';
    grid.style.width = '100%';
    grid.style.height = '100%';

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dot = document.createElement('div');
        dot.className = 'hero-grid-dot';
        dot.style.left = (c * GAP + GAP / 2) + 'px';
        dot.style.top = (r * GAP + GAP / 2) + 'px';
        grid.appendChild(dot);
        dots.push({ el: dot, x: c * GAP + GAP / 2, y: r * GAP + GAP / 2 });
      }
    }

    let mouseX = -500, mouseY = -500;
    hero.style.position = 'relative';
    hero.addEventListener('mousemove', (e) => {
      const r = hero.getBoundingClientRect();
      mouseX = e.clientX - r.left;
      mouseY = e.clientY - r.top;
    });

    hero.addEventListener('mouseleave', () => {
      mouseX = -500;
      mouseY = -500;
    });

    function updateDots() {
      const RADIUS = 120;
      for (const dot of dots) {
        const dx = dot.x - mouseX;
        const dy = dot.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < RADIUS) {
          dot.el.classList.add('active');
        } else {
          dot.el.classList.remove('active');
        }
      }
      requestAnimationFrame(updateDots);
    }
    requestAnimationFrame(updateDots);
  }

  // ── CURSOR SPOTLIGHT ─────────────────────────────────────────────────
  function initCursorSpotlight() {
    const glow = document.getElementById('cursorGlow');
    if (!glow || 'ontouchstart' in window) {
      if (glow) glow.style.display = 'none';
      return;
    }

    let mouseX = -500, mouseY = -500;
    let glowX = -500, glowY = -500;

    document.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    });

    function update() {
      glowX += (mouseX - glowX) * 0.06;
      glowY += (mouseY - glowY) * 0.06;
      glow.style.left = glowX + 'px';
      glow.style.top = glowY + 'px';
      requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  // ── 3D CARD TILT ─────────────────────────────────────────────────────
  function initCardTilt() {
    document.querySelectorAll('.tilt-card').forEach(card => {
      card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const rx = ((y - cy) / cy) * -8;
        const ry = ((x - cx) / cx) * 8;
        card.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(-6px) scale(1.02)`;
      });

      card.addEventListener('mouseleave', () => {
        card.style.transform = 'perspective(800px) rotateX(0) rotateY(0) translateY(0) scale(1)';
      });
    });
  }

  // ── MAGNETIC BUTTONS ─────────────────────────────────────────────────
  function initMagneticButtons() {
    document.querySelectorAll('.magnetic-btn').forEach(btn => {
      btn.addEventListener('mousemove', (e) => {
        const rect = btn.getBoundingClientRect();
        const x = e.clientX - rect.left - rect.width / 2;
        const y = e.clientY - rect.top - rect.height / 2;
        btn.style.transform = `translate(${x * 0.25}px, ${y * 0.25}px) scale(1.03)`;
      });

      btn.addEventListener('mouseleave', () => {
        btn.style.transform = 'translate(0, 0) scale(1)';
      });
    });
  }

  // ── CARD SPOTLIGHT (cursor radial glow) ──────────────────────────────
  function initCardSpotlight() {
    document.querySelectorAll('.spotlight-card').forEach(card => {
      card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--spotlight-x', (e.clientX - rect.left) + 'px');
        card.style.setProperty('--spotlight-y', (e.clientY - rect.top) + 'px');
      });
    });
  }

  // ── SECTION REVEAL ON SCROLL ─────────────────────────────────────────
  function initSectionReveal() {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06 });

    document.querySelectorAll('.section-reveal').forEach(el => obs.observe(el));

    // Also handle fade-in elements
    const fadeObs = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          setTimeout(() => entry.target.classList.add('visible'), i * 100);
          fadeObs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    document.querySelectorAll('.fade-in').forEach(el => fadeObs.observe(el));
  }

  // ── ICON SVG DRAW ON SCROLL ──────────────────────────────────────────
  function initIconDraw() {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('drawn');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    document.querySelectorAll('.icon-draw').forEach(el => obs.observe(el));
  }

  // ── TEXT SCRAMBLE ON SECTION LABELS ───────────────────────────────────
  function initTextScramble() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%';
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          scrambleText(entry.target);
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });

    document.querySelectorAll('.section-label').forEach(el => obs.observe(el));

    function scrambleText(el) {
      const original = el.textContent;
      let iteration = 0;
      const interval = setInterval(() => {
        el.textContent = original.split('').map((char, i) => {
          if (char === ' ' || char === '—') return char;
          if (i < iteration) return original[i];
          return chars[Math.floor(Math.random() * chars.length)];
        }).join('');
        iteration += 0.5;
        if (iteration >= original.length) {
          clearInterval(interval);
          el.textContent = original;
        }
      }, 30);
    }
  }

  // ── SCROLL PROGRESS BAR ──────────────────────────────────────────────
  function initScrollProgress() {
    const bar = document.getElementById('scrollProgress');
    if (!bar) return;

    window.addEventListener('scroll', () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = (scrollTop / docHeight) * 100;
      bar.style.width = progress + '%';
    });
  }

  // ── NAV HIDE/SHOW ON SCROLL ──────────────────────────────────────────
  function initNavAutoHide() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    let lastY = 0;
    let hidden = false;

    window.addEventListener('scroll', () => {
      const y = window.scrollY;
      if (y > lastY && y > 200 && !hidden) {
        nav.style.transform = 'translateX(-50%) translateY(-120px)';
        nav.style.transition = 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
        hidden = true;
      } else if (y < lastY && hidden) {
        nav.style.transform = 'translateX(-50%) translateY(0)';
        nav.style.transition = 'transform 0.5s cubic-bezier(0.16, 1, 0.3, 1)';
        hidden = false;
      }
      lastY = y;
    });
  }

  // ── INBOX CARD ENTRANCE ──────────────────────────────────────────────
  function initInboxEntrance() {
    const inboxCard = document.querySelector('.inbox-card');
    if (!inboxCard) return;

    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const rows = inboxCard.querySelectorAll('.inbox-row');
          rows.forEach((row, i) => {
            row.style.opacity = '0';
            row.style.transform = 'translateX(-24px)';
            row.style.transition = `opacity 0.5s ease ${0.3 + i * 0.15}s, transform 0.5s ease ${0.3 + i * 0.15}s`;
            requestAnimationFrame(() => {
              row.style.opacity = '1';
              row.style.transform = 'translateX(0)';
            });
          });

          // Animate tabs
          const tabs = inboxCard.querySelectorAll('.inbox-tab');
          tabs.forEach((tab, i) => {
            tab.style.opacity = '0';
            tab.style.transform = 'translateY(-10px)';
            tab.style.transition = `opacity 0.4s ease ${i * 0.1}s, transform 0.4s ease ${i * 0.1}s`;
            requestAnimationFrame(() => {
              tab.style.opacity = '1';
              tab.style.transform = 'translateY(0)';
            });
          });

          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.2 });

    obs.observe(inboxCard);
  }

  // ── TEXT HIGHLIGHTS ON SCROLL ─────────────────────────────────────────
  function initTextHighlights() {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('active');
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.8 });

    document.querySelectorAll('.text-highlight').forEach(el => obs.observe(el));
  }

  // ── PARALLAX ORBS ON SCROLL ──────────────────────────────────────────
  function initParallaxOrbs() {
    const orbs = document.querySelectorAll('.orb');
    if (!orbs.length) return;

    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const y = window.scrollY;
          orbs[0] && (orbs[0].style.transform = `translateY(${y * 0.04}px)`);
          orbs[1] && (orbs[1].style.transform = `translateY(${y * -0.03}px)`);
          orbs[2] && (orbs[2].style.transform = `translateY(${y * 0.05}px)`);
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  // ── SMOOTH COUNTERS WITH SPRING PHYSICS ──────────────────────────────
  function initSmoothCounters() {
    const counters = document.querySelectorAll('.proof-number[id]');
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          const text = el.textContent;
          const num = parseInt(text.replace(/[^0-9]/g, ''));
          if (isNaN(num) || num <= 0) return;

          const duration = 2500;
          const start = performance.now();
          const suffix = text.includes('+') ? '+' : '';

          const step = (now) => {
            const t = Math.min((now - start) / duration, 1);
            // Spring easing
            const eased = 1 - Math.pow(2, -10 * t) * Math.cos(t * Math.PI * 2);
            el.textContent = Math.floor(num * Math.min(eased, 1)).toLocaleString() + suffix;
            if (t < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          obs.unobserve(el);
        }
      });
    }, { threshold: 0.5 });

    counters.forEach(c => obs.observe(c));
  }

})();

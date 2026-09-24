(function(){
    "use strict";
    var reduce  = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var finePtr = false;

    /* ── custom cursor ── */
    if (finePtr && !reduce) {
      var dot = document.getElementById('curDot'), ring = document.getElementById('curRing');
      var cx = innerWidth / 2, cy = innerHeight / 2, rx = cx, ry = cy, hov = false;
      window.addEventListener('mousemove', function(e){
        // only take over the cursor once the pointer has actually moved,
        // otherwise the dot sits parked at 0,0 on load
        document.documentElement.classList.add('ccur');
        cx = e.clientX; cy = e.clientY;
        dot.style.transform = 'translate(' + (cx - 3) + 'px,' + (cy - 3) + 'px)';
      }, { passive: true });
      document.addEventListener('mouseover', function(e){
        hov = !!(e.target.closest && e.target.closest('a,button,.kpi-card,.chart-card,.filter-pill,tbody tr'));
      });
      (function loop(){
        rx += (cx - rx) * .16; ry += (cy - ry) * .16;
        ring.style.transform = 'translate(' + (rx - 15) + 'px,' + (ry - 15) + 'px) scale(' + (hov ? 1.5 : 1) + ')';
        ring.style.borderColor = hov ? 'var(--lime)' : 'var(--gold)';
        requestAnimationFrame(loop);
      })();
    }

    /* ── scroll progress rail ── */
    var prog = document.getElementById('scrollProg');
    if (prog) {
      window.addEventListener('scroll', function(){
        var h = document.documentElement;
        var max = Math.max(1, h.scrollHeight - h.clientHeight);
        prog.style.transform = 'scaleX(' + (h.scrollTop / max) + ')';
      }, { passive: true });
    }

    /* ── reveal on scroll ──
       Cards are rendered asynchronously, so tag-and-observe is
       re-run whenever #content changes. */
    var REVEAL_SEL = '.chart-card, .table-card, .plans-card, .quote-card';
    var rio = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (en.isIntersecting) { en.target.classList.add('in'); rio.unobserve(en.target); }
      });
    }, { threshold: .08, rootMargin: '0px 0px -40px 0px' });

    function applyReveal(){
      document.querySelectorAll(REVEAL_SEL).forEach(function(el, i){
        if (el.hasAttribute('data-reveal')) return;
        el.setAttribute('data-reveal', '');
        el.style.setProperty('--d', Math.min(i % 4, 3) * 0.07 + 's');
        if (reduce) { el.classList.add('in'); return; }
        // already on screen at tag time? reveal on the next frame
        var r = el.getBoundingClientRect();
        if (r.top < innerHeight && r.bottom > 0) requestAnimationFrame(function(){ el.classList.add('in'); });
        else rio.observe(el);
      });
    }
    applyReveal();
    var content = document.getElementById('content');
    if (content && window.MutationObserver) {
      new MutationObserver(function(){ applyReveal(); })
        .observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
    }

    /* ── card spotlight (delegated, so async cards are covered) ── */
    if (finePtr && !reduce) {
      document.addEventListener('mousemove', function(e){
        var card = e.target.closest && e.target.closest('.kpi-card, .chart-card');
        if (!card) return;
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
      }, { passive: true });
    }

    /* ── sidebar sliding indicator ── */
    var ind = document.getElementById('sidebarInd');
    var navEl = document.querySelector('.sidebar-nav');
    function moveInd(){
      if (!ind || !navEl) return;
      var active = navEl.querySelector('.sidebar-link.active');
      if (!active) { ind.style.opacity = 0; return; }
      ind.style.opacity = 1;
      ind.style.top = (active.offsetTop + active.offsetHeight / 2 - 17) + 'px';
    }
    moveInd();
    window.addEventListener('resize', moveInd);
    window.addEventListener('load', moveInd);

    // switchSection is called from inline onclick, so wrapping the
    // global picks up every nav click without touching the markup.
    if (typeof window.switchSection === 'function') {
      var origSwitch = window.switchSection;
      window.switchSection = function(id, el){
        var out = origSwitch.apply(this, arguments);
        moveInd();
        return out;
      };
    }

    /* ── scrollspy: highlight the section you're actually looking at ── */
    var links = Array.prototype.slice.call(document.querySelectorAll('.sidebar-link'));
    var ANCHORS = ['section-overview','section-pipeline','section-stocks','secSectionCard','section-articles','section-feedback'];
    var spyLock = 0;
    document.addEventListener('click', function(e){
      if (e.target.closest && e.target.closest('.sidebar-link')) spyLock = Date.now() + 900;
    }, true);
    window.addEventListener('scroll', function(){
      if (Date.now() < spyLock) return;
      var best = -1, bestTop = Infinity;
      ANCHORS.forEach(function(id, i){
        var el = document.getElementById(id);
        if (!el) return;
        var top = el.getBoundingClientRect().top;
        if (top <= 160 && Math.abs(top) < Math.abs(bestTop)) { bestTop = top; best = i; }
      });
      if (best < 0 || !links[best] || links[best].classList.contains('active')) return;
      links.forEach(function(l){ l.classList.remove('active'); l.removeAttribute('aria-current'); });
      links[best].classList.add('active');
      links[best].setAttribute('aria-current', 'location');
      moveInd();
    }, { passive: true });
  })();

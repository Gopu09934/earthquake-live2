/* ==========================================================================
   EQ WATCH — application logic
   Data flow: try live USGS GeoJSON feeds first (client-side fetch, USGS
   feeds are CORS-enabled). If that fails (network blocked, offline, rate
   limited) fall back to the local snapshot in /data/*.json, which a
   scheduled GitHub Action keeps in sync every ~10 minutes.
   ========================================================================== */

(() => {
  "use strict";

  /* ---------------------------------------------------------------------
     Config
     --------------------------------------------------------------------- */

  const FEEDS = {
    hour: {
      label: "Past Hour",
      live: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson",
      cached: "data/hour.json",
    },
    day: {
      label: "Past Day",
      live: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
      cached: "data/day.json",
    },
    major: {
      label: "M4.5+ Day",
      live: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson",
      cached: "data/major.json",
    },
  };

  const COUNTRIES_URL = "data/countries.min.geojson";
  const REFRESH_MS = 60_000;      // re-poll live feed every 60s
  const NEW_QUAKE_WINDOW_MS = 15 * 60_000; // "new" ripple badge window

  const OCEAN_LABELS = [
    { name: "PACIFIC OCEAN", lon: -150, lat: 5 },
    { name: "PACIFIC OCEAN", lon: 170, lat: -10 },
    { name: "ATLANTIC OCEAN", lon: -32, lat: 10 },
    { name: "INDIAN OCEAN", lon: 75, lat: -25 },
    { name: "ARCTIC OCEAN", lon: 0, lat: 85 },
    { name: "SOUTHERN OCEAN", lon: 0, lat: -68 },
  ];

  const REGION_LABELS = [
    { name: "NORTH AMERICA", lon: -100, lat: 45 },
    { name: "SOUTH AMERICA", lon: -60, lat: -15 },
    { name: "EUROPE", lon: 15, lat: 52 },
    { name: "AFRICA", lon: 20, lat: 5 },
    { name: "ASIA", lon: 95, lat: 50 },
    { name: "OCEANIA", lon: 140, lat: -25 },
  ];

  /* ---------------------------------------------------------------------
     State
     --------------------------------------------------------------------- */

  const state = {
    feedKey: "day",
    minMag: 2.5,
    features: [],       // currently loaded, unfiltered
    countries: null,
    focusedId: null,
    lastSync: null,      // Date
    isLive: false,
    rotation: [-10, -18],
    scale0: 0,
    dragging: false,
    autoRotate: true,
    lastPointer: null,
  };

  /* ---------------------------------------------------------------------
     Small utilities
     --------------------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function magColor(mag) {
    if (mag >= 6) return "#ff5468";
    if (mag >= 5) return "#ffb238";
    if (mag >= 4) return "#3fd8c4";
    return "#5c6478";
  }

  function magRadius(mag) {
    return Math.max(2.6, Math.sqrt(Math.max(mag, 0.1)) * 3.1);
  }

  function timeAgo(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function fmtDepth(km) {
    if (km == null || isNaN(km)) return "—";
    return `${km.toFixed(0)} km`;
  }

  /* ---------------------------------------------------------------------
     Data loading
     --------------------------------------------------------------------- */

  async function fetchJSON(url, { timeoutMs = 8000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, mode: "cors", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function loadFeed(feedKey) {
    const feed = FEEDS[feedKey];
    try {
      const data = await fetchJSON(feed.live);
      state.isLive = true;
      return data;
    } catch (err) {
      console.warn(`Live fetch failed for ${feedKey}, falling back to cache:`, err.message);
      try {
        const data = await fetchJSON(feed.cached, { timeoutMs: 5000 });
        state.isLive = false;
        return data;
      } catch (err2) {
        console.error(`Cached fallback also failed for ${feedKey}:`, err2.message);
        state.isLive = false;
        return null;
      }
    }
  }

  async function loadCountries() {
    try {
      const data = await fetchJSON(COUNTRIES_URL, { timeoutMs: 15000 });
      return data;
    } catch (err) {
      console.error("Failed to load countries geojson:", err.message);
      return { type: "FeatureCollection", features: [] };
    }
  }

  /* ---------------------------------------------------------------------
     Globe / map module
     --------------------------------------------------------------------- */

  const Globe = (() => {
    let svg, gGraticule, gCountries, gRegionLabels, gOceanLabels, gCountryLabels, gQuakes, projection, path, geoGraticule;
    let width = 0, height = 0;

    function size() {
      const panel = $("#mapPanel");
      width = panel.clientWidth;
      height = panel.clientHeight;
      const svgEl = $("#globe");
      svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
      const R = Math.min(width, height) / 2 - 26;
      if (!state.scale0) state.scale0 = R;
      projection
        .translate([width / 2, height / 2])
        .scale(state.scale0);
    }

    function init() {
      svg = d3.select("#globe");
      projection = d3.geoOrthographic().clipAngle(90).rotate(state.rotation);
      path = d3.geoPath(projection);
      geoGraticule = d3.geoGraticule10();

      const defs = svg.append("defs");
      const grad = defs.append("radialGradient").attr("id", "oceanGrad");
      grad.append("stop").attr("offset", "0%").attr("stop-color", "#141a26");
      grad.append("stop").attr("offset", "100%").attr("stop-color", "#080a10");

      svg.append("circle").attr("class", "sphere-fill").attr("fill", "url(#oceanGrad)");
      gGraticule = svg.append("path").attr("class", "graticule")
        .attr("fill", "none").attr("stroke", "#1c2431").attr("stroke-width", 0.6);
      gCountries = svg.append("g").attr("class", "countries");
      gRegionLabels = svg.append("g").attr("class", "region-labels");
      gOceanLabels = svg.append("g").attr("class", "ocean-labels");
      gCountryLabels = svg.append("g").attr("class", "country-labels");
      gQuakes = svg.append("g").attr("class", "quakes");
      svg.append("circle").attr("class", "sphere-outline")
        .attr("fill", "none").attr("stroke", "#2a3244").attr("stroke-width", 1.2);

      size();
      redrawStatic();
      wireInteraction();
      window.addEventListener("resize", () => { size(); redrawStatic(); redrawQuakes(); });
      requestAnimationFrame(tick);
    }

    function redrawStatic() {
      const cx = width / 2, cy = height / 2, R = projection.scale();
      svg.select(".sphere-fill").attr("cx", cx).attr("cy", cy).attr("r", R);
      svg.select(".sphere-outline").attr("cx", cx).attr("cy", cy).attr("r", R);
      gGraticule.attr("d", path(geoGraticule));
      gCountries.selectAll("path")
        .data(state.countries ? state.countries.features : [], (d) => d.properties && d.properties.iso_a3 || d.id)
        .join("path")
        .attr("fill", "#2e3852")
        .attr("stroke", "#4a5878")
        .attr("stroke-width", 0.6)
        .attr("d", path);

      // Region (continent) labels — coarse background text, always shown when facing us
      gRegionLabels.selectAll("text")
        .data(REGION_LABELS.filter((d) => visible([d.lon, d.lat])), (d) => d.name)
        .join("text")
        .text((d) => d.name)
        .attr("x", (d) => projection([d.lon, d.lat])[0])
        .attr("y", (d) => projection([d.lon, d.lat])[1])
        .attr("text-anchor", "middle")
        .attr("font-size", 13)
        .attr("font-weight", 600)
        .attr("letter-spacing", "1.5px")
        .attr("fill", "#6b7aa0")
        .attr("stroke", "#0a0d14")
        .attr("stroke-width", 3)
        .attr("paint-order", "stroke")
        .attr("opacity", 0.6)
        .style("pointer-events", "none");

      // Ocean labels — same idea, italic to read as water rather than landmass
      gOceanLabels.selectAll("text")
        .data(OCEAN_LABELS.filter((d) => visible([d.lon, d.lat])), (d) => d.name + d.lon)
        .join("text")
        .text((d) => d.name)
        .attr("x", (d) => projection([d.lon, d.lat])[0])
        .attr("y", (d) => projection([d.lon, d.lat])[1])
        .attr("text-anchor", "middle")
        .attr("font-size", 11)
        .attr("font-style", "italic")
        .attr("letter-spacing", "1px")
        .attr("fill", "#4d5f85")
        .attr("stroke", "#0a0d14")
        .attr("stroke-width", 3)
        .attr("paint-order", "stroke")
        .attr("opacity", 0.65)
        .style("pointer-events", "none");

      // Country name labels — only for countries with enough projected screen
      // area to stay legible; fades/grows in as you zoom toward a country.
      const labelData = (state.countryCentroids || [])
        .map((d) => ({ ...d, area: path.area(d.f) }))
        .filter((d) => d.area > 300 && visible(d.centroid))
        .sort((a, b) => b.area - a.area)
        .slice(0, 60);

      gCountryLabels.selectAll("text")
        .data(labelData, (d) => d.f.properties.iso_a3 || d.f.id)
        .join("text")
        .text((d) => d.f.properties.name)
        .attr("x", (d) => projection(d.centroid)[0])
        .attr("y", (d) => projection(d.centroid)[1])
        .attr("text-anchor", "middle")
        .attr("font-size", (d) => clamp(Math.sqrt(d.area) / 9, 8, 14))
        .attr("fill", "#c3cee4")
        .attr("stroke", "#0a0d14")
        .attr("stroke-width", 2.5)
        .attr("paint-order", "stroke")
        .attr("opacity", (d) => clamp((d.area - 300) / 4000, 0.4, 0.95))
        .style("pointer-events", "none");
    }

    function visible(coords) {
      const r = projection.rotate();
      const center = [-r[0], -r[1]];
      return d3.geoDistance(coords, center) < Math.PI / 2 - 0.02;
    }

    function redrawQuakes() {
      const feats = getVisibleFilteredFeatures();

      const sel = gQuakes.selectAll("g.quake")
        .data(feats, (d) => d.id || d.properties.time);

      const enter = sel.enter().append("g").attr("class", "quake");
      enter.append("circle").attr("class", "ripple");
      enter.append("circle").attr("class", "core");

      sel.exit().remove();

      const merged = enter.merge(sel);

      merged.each(function (d) {
        const coords = d.geometry.coordinates;
        const p = projection([coords[0], coords[1]]);
        const g = d3.select(this);
        const isVisible = visible([coords[0], coords[1]]);
        g.style("display", isVisible ? null : "none");
        if (!isVisible || !p) return;

        const mag = d.properties.mag || 0;
        const r = magRadius(mag);
        const isNew = Date.now() - d.properties.time < NEW_QUAKE_WINDOW_MS;
        const isFocused = state.focusedId === d.id;

        g.attr("transform", `translate(${p[0]},${p[1]})`);

        const core = g.select("circle.core")
          .attr("r", r)
          .attr("fill", magColor(mag))
          .attr("fill-opacity", 0.88)
          .attr("stroke", isFocused ? "#fff" : "#000")
          .attr("stroke-opacity", isFocused ? 0.9 : 0.35)
          .attr("stroke-width", isFocused ? 2 : 0.7)
          .style("cursor", "pointer");

        const ripple = g.select("circle.ripple")
          .attr("r", r)
          .attr("fill", "none")
          .attr("stroke", magColor(mag));

        if (isNew) {
          ripple.classed("pulse-anim", true).style("display", null);
        } else {
          ripple.classed("pulse-anim", false).style("display", "none");
        }
      });

      merged.on("click", (event, d) => focusQuake(d));
    }

    function getVisibleFilteredFeatures() {
      return state.features.filter((f) => (f.properties.mag || 0) >= state.minMag);
    }

    function focusQuake(feature) {
      state.focusedId = feature.id;
      const [lon, lat] = feature.geometry.coordinates;
      state.autoRotate = false;
      const target = [-lon, -lat];
      const interpolator = d3.interpolate(projection.rotate(), [target[0], target[1], 0]);
      const start = performance.now();
      const dur = 900;
      function step(now) {
        const t = clamp((now - start) / dur, 0, 1);
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        projection.rotate(interpolator(eased));
        redrawStatic();
        redrawQuakes();
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
      Sidebar.setFocused(feature.id);
    }

    function wireInteraction() {
      let v0, r0, dragStartXY;

      const drag = d3.drag()
        .on("start", (event) => {
          state.dragging = true;
          dragStartXY = [event.x, event.y];
          r0 = projection.rotate();
        })
        .on("drag", (event) => {
          const dx = event.x - dragStartXY[0];
          const dy = event.y - dragStartXY[1];
          const sensitivity = 0.28;
          projection.rotate([
            r0[0] + dx * sensitivity,
            clamp(r0[1] - dy * sensitivity, -90, 90),
          ]);
          redrawStatic();
          redrawQuakes();
        })
        .on("end", () => {
          state.dragging = false;
        });

      svg.call(drag);

      svg.on("wheel", (event) => {
        event.preventDefault();
        const factor = event.deltaY < 0 ? 1.08 : 0.93;
        state.scale0 = clamp(state.scale0 * factor, 90, Math.min(width, height));
        projection.scale(state.scale0);
        redrawStatic();
        redrawQuakes();
      }, { passive: false });

      svg.on("mouseenter", () => (state.hover = true));
      svg.on("mouseleave", () => (state.hover = false));

      $("#zoomIn").addEventListener("click", () => {
        state.scale0 = clamp(state.scale0 * 1.15, 90, Math.min(width, height));
        projection.scale(state.scale0);
        redrawStatic(); redrawQuakes();
      });
      $("#zoomOut").addEventListener("click", () => {
        state.scale0 = clamp(state.scale0 * 0.87, 90, Math.min(width, height));
        projection.scale(state.scale0);
        redrawStatic(); redrawQuakes();
      });
      $("#resetView").addEventListener("click", () => {
        state.autoRotate = true;
        state.focusedId = null;
        Sidebar.setFocused(null);
        state.scale0 = Math.min(width, height) / 2 - 26;
        projection.scale(state.scale0);
        redrawStatic(); redrawQuakes();
      });
    }

    let lastTs = 0;
    function tick(ts) {
      const dt = ts - lastTs;
      lastTs = ts;
      if (state.autoRotate && !state.dragging && !state.hover && dt < 200) {
        const r = projection.rotate();
        projection.rotate([r[0] + dt * 0.006, r[1]]);
        redrawStatic();
        redrawQuakes();
      }
      requestAnimationFrame(tick);
    }

    function setCountries(geo) {
      state.countries = geo;
      state.countryCentroids = geo.features.map((f) => ({ f, centroid: d3.geoCentroid(f) }));
      redrawStatic();
    }

    function refresh() {
      redrawQuakes();
    }

    function focusById(id) {
      const f = state.features.find((x) => x.id === id);
      if (f) focusQuake(f);
    }

    return { init, setCountries, refresh, redrawQuakes, focusById };
  })();

  /* ---------------------------------------------------------------------
     Sidebar module — stats, list, filters
     --------------------------------------------------------------------- */

  const Sidebar = (() => {
    function render() {
      renderStats();
      renderList();
    }

    function filteredSorted() {
      return state.features
        .filter((f) => (f.properties.mag || 0) >= state.minMag)
        .slice()
        .sort((a, b) => b.properties.time - a.properties.time);
    }

    function renderStats() {
      const feats = state.features.filter((f) => (f.properties.mag || 0) >= state.minMag);
      $("#statCount").textContent = feats.length;

      if (feats.length === 0) {
        $("#statMax").textContent = "—";
        $("#statMaxPlace").textContent = "";
        $("#statDepth").textContent = "—";
        $("#statMajor").textContent = "0";
        return;
      }

      let strongest = feats[0];
      let depthSum = 0, majorCount = 0;
      for (const f of feats) {
        if ((f.properties.mag || 0) > (strongest.properties.mag || 0)) strongest = f;
        depthSum += f.geometry.coordinates[2] || 0;
        if ((f.properties.mag || 0) >= 5) majorCount++;
      }

      $("#statMax").textContent = `M${(strongest.properties.mag || 0).toFixed(1)}`;
      $("#statMax").style.color = magColor(strongest.properties.mag || 0);
      $("#statMaxPlace").textContent = strongest.properties.place || "—";
      $("#statDepth").textContent = fmtDepth(depthSum / feats.length);
      $("#statMajor").textContent = majorCount;
    }

    function renderList() {
      const list = $("#quakeList");
      const feats = filteredSorted();
      $("#listCount").textContent = feats.length ? `(${feats.length})` : "";

      if (feats.length === 0) {
        list.innerHTML = `<div class="empty-note">No events at or above M${state.minMag.toFixed(1)} in this window.</div>`;
        return;
      }

      list.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (const f of feats.slice(0, 200)) {
        const p = f.properties;
        const el = document.createElement("div");
        el.className = "q-item" + (state.focusedId === f.id ? " is-focused" : "");
        el.dataset.id = f.id;
        const isNew = Date.now() - p.time < NEW_QUAKE_WINDOW_MS;
        el.innerHTML = `
          <div class="q-mag" style="background:${magColor(p.mag || 0)}">${(p.mag || 0).toFixed(1)}</div>
          <div class="q-body">
            <div class="q-place">${escapeHtml(p.place || "Unknown location")}</div>
            <div class="q-meta">
              <span>${timeAgo(p.time)}</span>
              <span>${fmtDepth(f.geometry.coordinates[2])}</span>
              ${isNew ? '<span class="new-badge">● NEW</span>' : ""}
            </div>
          </div>`;
        el.addEventListener("click", () => Globe.focusById(f.id));
        frag.appendChild(el);
      }
      list.appendChild(frag);
    }

    function setFocused(id) {
      state.focusedId = id;
      document.querySelectorAll(".q-item").forEach((el) => {
        el.classList.toggle("is-focused", el.dataset.id === id);
      });
      if (id) {
        const el = document.querySelector(`.q-item[data-id="${CSS.escape(id)}"]`);
        if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }

    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      }[c]));
    }

    return { render, setFocused };
  })();

  /* ---------------------------------------------------------------------
     Seismograph ticker (canvas)
     --------------------------------------------------------------------- */

  const Ticker = (() => {
    let canvas, ctx, W, H, dpr;
    let buffer = [];
    const BUFFER_LEN = 260;
    let pending = null; // {value, ticksLeft}
    let quakeQueue = [];
    let quakeQueueIdx = 0;
    let msSinceLastSpike = 0;
    let nextSpikeIn = 1200;

    function init() {
      canvas = $("#tickerCanvas");
      ctx = canvas.getContext("2d");
      buffer = new Array(BUFFER_LEN).fill(0).map(() => (Math.random() - 0.5) * 0.06);
      resize();
      window.addEventListener("resize", resize);
      requestAnimationFrame(loop);
      setInterval(tickBuffer, 45);
    }

    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function setQuakes(feats) {
      quakeQueue = feats.slice().sort((a, b) => (b.properties.mag || 0) - (a.properties.mag || 0)).slice(0, 40);
      quakeQueueIdx = 0;
    }

    function ambient() {
      return (Math.random() - 0.5) * 0.07;
    }

    function tickBuffer() {
      buffer.shift();

      let val = ambient();
      if (pending && pending.ticksLeft > 0) {
        const decay = pending.ticksLeft / pending.totalTicks;
        val += pending.value * decay * decay;
        pending.ticksLeft--;
      }
      buffer.push(val);

      msSinceLastSpike += 45;
      if (msSinceLastSpike > nextSpikeIn && quakeQueue.length) {
        const q = quakeQueue[quakeQueueIdx % quakeQueue.length];
        quakeQueueIdx++;
        const mag = q.properties.mag || 2.5;
        pending = { value: clamp(mag / 7.5, 0.15, 1) * (0.8 + Math.random() * 0.4), ticksLeft: 26, totalTicks: 26 };
        msSinceLastSpike = 0;
        nextSpikeIn = 900 + Math.random() * 2200;
      }
    }

    function loop() {
      draw();
      requestAnimationFrame(loop);
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);

      // baseline grid
      ctx.strokeStyle = "rgba(35,42,55,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();

      const midY = H / 2;
      const ampScale = H * 0.42;
      const step = W / (BUFFER_LEN - 1);

      ctx.beginPath();
      ctx.strokeStyle = "#ffb238";
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "rgba(255,178,56,0.55)";
      ctx.shadowBlur = 6;

      for (let i = 0; i < BUFFER_LEN; i++) {
        const x = i * step;
        const y = midY - buffer[i] * ampScale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // leading dot
      const lastX = (BUFFER_LEN - 1) * step;
      const lastY = midY - buffer[BUFFER_LEN - 1] * ampScale;
      ctx.beginPath();
      ctx.fillStyle = "#ffd889";
      ctx.arc(lastX, lastY, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    return { init, setQuakes };
  })();

  /* ---------------------------------------------------------------------
     Clock
     --------------------------------------------------------------------- */

  function startClock() {
    function tick() {
      const now = new Date();
      const hh = String(now.getUTCHours()).padStart(2, "0");
      const mm = String(now.getUTCMinutes()).padStart(2, "0");
      const ss = String(now.getUTCSeconds()).padStart(2, "0");
      $("#clockUtc").textContent = `${hh}:${mm}:${ss}`;
      if (state.lastSync) {
        $("#syncAgo").textContent = timeAgo(state.lastSync.getTime());
      }
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ---------------------------------------------------------------------
     Status pill
     --------------------------------------------------------------------- */

  function setStatus(mode, text) {
    const pill = $("#statusPill");
    pill.classList.remove("is-live", "is-cached", "is-error");
    pill.classList.add(`is-${mode}`);
    $("#statusText").textContent = text;
  }

  function checkAlerts() {
    const bar = $("#alertBar");
    const tsunamiQuakes = state.features.filter((f) => f.properties.tsunami === 1);
    if (tsunamiQuakes.length) {
      const strongest = tsunamiQuakes.slice().sort((a, b) => (b.properties.mag || 0) - (a.properties.mag || 0))[0];
      $("#alertText").textContent =
        `TSUNAMI ADVISORY FLAG — M${(strongest.properties.mag || 0).toFixed(1)} ${strongest.properties.place || ""} · via USGS`;
      bar.style.display = "flex";
    } else {
      bar.style.display = "none";
    }
  }

  /* ---------------------------------------------------------------------
     Feed / filter wiring
     --------------------------------------------------------------------- */

  function wireControls() {
    document.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.feedKey = chip.dataset.feed;
        $("#snapshotWindow").textContent = `— ${FEEDS[state.feedKey].label}`;
        refreshData();
      });
    });

    const magEl = $("#magFilter");
    magEl.addEventListener("input", () => {
      state.minMag = parseFloat(magEl.value);
      $("#magFilterVal").textContent = state.minMag.toFixed(1);
      Sidebar.render();
      Globe.refresh();
    });
  }

  /* ---------------------------------------------------------------------
     Main refresh cycle
     --------------------------------------------------------------------- */

  async function refreshData() {
    setStatus("cached", "Syncing…");
    const data = await loadFeed(state.feedKey);
    if (data && Array.isArray(data.features)) {
      state.features = data.features;
      state.lastSync = new Date();
      if (state.isLive) {
        setStatus("live", "Live · USGS");
      } else {
        setStatus("cached", "Cached snapshot");
      }
    } else {
      setStatus("error", "Feed unavailable");
    }
    Sidebar.render();
    Globe.refresh();
    Ticker.setQuakes(state.features);
    checkAlerts();
  }

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */

  async function boot() {
    startClock();
    wireControls();
    Globe.init();
    Ticker.init();

    const countries = await loadCountries();
    Globe.setCountries(countries);

    await refreshData();
    setInterval(refreshData, REFRESH_MS);
  }

  // expose focus function used by Sidebar clicks (bound after Globe module IIFE)
  document.addEventListener("DOMContentLoaded", boot);
})();

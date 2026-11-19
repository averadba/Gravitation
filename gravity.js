// Client-side N-body simulation rendered to a canvas.
// Python sends the initial bodies + live parameters through `data`.
// Bodies are re-seeded only when `data.version` changes.

const instances = new WeakMap()

function makeSim(parentElement, setTriggerValue) {
  const canvas = parentElement.querySelector("#sim")
  const hud = parentElement.querySelector("#hud")
  // parentElement may be a ShadowRoot (not an Element), so measure/observe the wrapper div.
  const wrap = parentElement.querySelector(".wrap")
  const ctx = canvas.getContext("2d")

  const sim = {
    bodies: [],
    params: {},
    version: null,
    cam: { x: 0, y: 0, zoom: 1 },
    drag: null,
    pan: null,
    time: 0,
    nextId: 1,
    raf: 0,
    snapshotRequest: null,
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1
    const w = wrap.clientWidth || 800
    const h = sim.params.height || 600
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = w + "px"
    canvas.style.height = h + "px"
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  sim.resize = resize
  const ro = new ResizeObserver(resize)
  ro.observe(wrap)

  const toWorld = (sx, sy) => {
    const w = canvas.clientWidth, h = canvas.clientHeight
    return {
      x: (sx - w / 2) / sim.cam.zoom + sim.cam.x,
      y: (sy - h / 2) / sim.cam.zoom + sim.cam.y,
    }
  }

  // ---- Interaction: drag to fling a new body, right/shift-drag to pan, wheel to zoom
  canvas.oncontextmenu = (e) => e.preventDefault()
  canvas.onpointerdown = (e) => {
    const r = canvas.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    canvas.setPointerCapture(e.pointerId)
    if (e.button === 2 || e.shiftKey) {
      sim.pan = { sx, sy, cx: sim.cam.x, cy: sim.cam.y }
    } else {
      const w = toWorld(sx, sy)
      sim.drag = { x: w.x, y: w.y, cx: w.x, cy: w.y }
    }
  }
  canvas.onpointermove = (e) => {
    const r = canvas.getBoundingClientRect()
    const sx = e.clientX - r.left, sy = e.clientY - r.top
    if (sim.pan) {
      sim.cam.x = sim.pan.cx - (sx - sim.pan.sx) / sim.cam.zoom
      sim.cam.y = sim.pan.cy - (sy - sim.pan.sy) / sim.cam.zoom
    } else if (sim.drag) {
      const w = toWorld(sx, sy)
      sim.drag.cx = w.x
      sim.drag.cy = w.y
    }
  }
  canvas.onpointerup = () => {
    if (sim.drag) {
      const p = sim.params.spawn || {}
      const k = p.fling ?? 0.5
      const mass = p.mass ?? 50
      sim.bodies.push({
        id: "u" + sim.nextId++,
        name: "Spawned " + sim.nextId,
        m: mass,
        r: p.radius ?? Math.max(2, Math.cbrt(mass) * 1.2),
        color: p.color || "#7dd3fc",
        x: sim.drag.x,
        y: sim.drag.y,
        vx: (sim.drag.x - sim.drag.cx) * k,
        vy: (sim.drag.y - sim.drag.cy) * k,
        fixed: false,
        trail: [],
      })
    }
    sim.drag = null
    sim.pan = null
  }
  canvas.onwheel = (e) => {
    e.preventDefault()
    const f = Math.exp(-e.deltaY * 0.0015)
    sim.cam.zoom = Math.min(20, Math.max(0.05, sim.cam.zoom * f))
  }

  // ---- Physics
  function accelerations(bodies) {
    const G = sim.params.G ?? 1
    const eps2 = (sim.params.softening ?? 2) ** 2
    const n = bodies.length
    for (const b of bodies) { b.ax = 0; b.ay = 0 }
    for (let i = 0; i < n; i++) {
      const a = bodies[i]
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j]
        const dx = b.x - a.x, dy = b.y - a.y
        const d2 = dx * dx + dy * dy + eps2
        const inv = G / (d2 * Math.sqrt(d2))
        a.ax += dx * inv * b.m; a.ay += dy * inv * b.m
        b.ax -= dx * inv * a.m; b.ay -= dy * inv * a.m
      }
    }
  }

  function step(dt) {
    const bs = sim.bodies
    // Leapfrog (kick-drift-kick): stable for orbits.
    for (const b of bs) if (!b.fixed) { b.vx += 0.5 * dt * (b.ax || 0); b.vy += 0.5 * dt * (b.ay || 0) }
    for (const b of bs) if (!b.fixed) { b.x += dt * b.vx; b.y += dt * b.vy }
    handleCollisions()
    handleBounds()
    accelerations(sim.bodies)
    for (const b of sim.bodies) if (!b.fixed) { b.vx += 0.5 * dt * b.ax; b.vy += 0.5 * dt * b.ay }
  }

  function handleCollisions() {
    const mode = sim.params.collisions || "merge"
    if (mode === "none") return
    const bs = sim.bodies
    const restitution = sim.params.restitution ?? 0.9
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j]
        if (a.dead || b.dead) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.hypot(dx, dy)
        const minD = a.r + b.r
        if (dist >= minD) continue
        if (mode === "merge") {
          const big = a.m >= b.m ? a : b, small = big === a ? b : a
          const M = big.m + small.m
          if (!big.fixed) {
            big.vx = (big.vx * big.m + small.vx * small.m) / M
            big.vy = (big.vy * big.m + small.vy * small.m) / M
            big.x = (big.x * big.m + small.x * small.m) / M
            big.y = (big.y * big.m + small.y * small.m) / M
          }
          big.r = Math.sqrt(big.r * big.r + small.r * small.r) // conserve area
          big.m = M
          small.dead = true
        } else {
          // Elastic-ish bounce
          const nx = dx / (dist || 1), ny = dy / (dist || 1)
          const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
          const ima = a.fixed ? 0 : 1 / a.m, imb = b.fixed ? 0 : 1 / b.m
          if (ima + imb === 0) continue
          if (rv < 0) {
            const jimp = (-(1 + restitution) * rv) / (ima + imb)
            a.vx -= jimp * nx * ima; a.vy -= jimp * ny * ima
            b.vx += jimp * nx * imb; b.vy += jimp * ny * imb
          }
          const overlap = (minD - dist) / (ima + imb)
          a.x -= nx * overlap * ima; a.y -= ny * overlap * ima
          b.x += nx * overlap * imb; b.y += ny * overlap * imb
        }
      }
    }
    if (bs.some((b) => b.dead)) sim.bodies = bs.filter((b) => !b.dead)
  }

  function handleBounds() {
    const mode = sim.params.boundary || "open"
    if (mode === "open") return
    const W = (sim.params.worldSize ?? 1600) / 2
    for (const b of sim.bodies) {
      if (mode === "wrap") {
        if (b.x > W) { b.x -= 2 * W; b.trail = [] }
        if (b.x < -W) { b.x += 2 * W; b.trail = [] }
        if (b.y > W) { b.y -= 2 * W; b.trail = [] }
        if (b.y < -W) { b.y += 2 * W; b.trail = [] }
      } else if (mode === "walls") {
        if (b.x + b.r > W) { b.x = W - b.r; b.vx = -Math.abs(b.vx) }
        if (b.x - b.r < -W) { b.x = -W + b.r; b.vx = Math.abs(b.vx) }
        if (b.y + b.r > W) { b.y = W - b.r; b.vy = -Math.abs(b.vy) }
        if (b.y - b.r < -W) { b.y = -W + b.r; b.vy = Math.abs(b.vy) }
      }
    }
  }

  function centerOfMass() {
    let M = 0, x = 0, y = 0
    for (const b of sim.bodies) { M += b.m; x += b.x * b.m; y += b.y * b.m }
    return M > 0 ? { x: x / M, y: y / M, M } : { x: 0, y: 0, M: 0 }
  }

  function energy() {
    const G = sim.params.G ?? 1
    const eps2 = (sim.params.softening ?? 2) ** 2
    let K = 0, U = 0
    const bs = sim.bodies
    for (let i = 0; i < bs.length; i++) {
      const a = bs[i]
      K += 0.5 * a.m * (a.vx * a.vx + a.vy * a.vy)
      for (let j = i + 1; j < bs.length; j++) {
        const b = bs[j]
        U -= (G * a.m * b.m) / Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + eps2)
      }
    }
    return { K, U }
  }

  // ---- Rendering
  function draw() {
    const p = sim.params
    const w = canvas.clientWidth, h = canvas.clientHeight
    ctx.fillStyle = p.background || "#05060f"
    ctx.fillRect(0, 0, w, h)

    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.scale(sim.cam.zoom, sim.cam.zoom)
    ctx.translate(-sim.cam.x, -sim.cam.y)
    const z = sim.cam.zoom

    if (p.boundary && p.boundary !== "open") {
      const W = (p.worldSize ?? 1600) / 2
      ctx.strokeStyle = "rgba(255,255,255,0.15)"
      ctx.setLineDash([8 / z, 8 / z])
      ctx.lineWidth = 1 / z
      ctx.strokeRect(-W, -W, 2 * W, 2 * W)
      ctx.setLineDash([])
    }

    if (p.showTrails) {
      for (const b of sim.bodies) {
        const t = b.trail
        if (t.length < 2) continue
        ctx.strokeStyle = b.color
        ctx.lineWidth = Math.max(1, b.r * 0.3) / z
        for (let i = 1; i < t.length; i++) {
          ctx.globalAlpha = (i / t.length) * 0.6
          ctx.beginPath()
          ctx.moveTo(t[i - 1][0], t[i - 1][1])
          ctx.lineTo(t[i][0], t[i][1])
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
    }

    for (const b of sim.bodies) {
      const rr = Math.max(b.r, 1.5 / z)
      if (p.glow) {
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, rr * 3)
        g.addColorStop(0, b.color + "66")
        g.addColorStop(1, b.color + "00")
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(b.x, b.y, rr * 3, 0, Math.PI * 2); ctx.fill()
      }
      ctx.fillStyle = b.color
      ctx.beginPath(); ctx.arc(b.x, b.y, rr, 0, Math.PI * 2); ctx.fill()
      if (b.fixed) {
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5 / z
        ctx.beginPath(); ctx.arc(b.x, b.y, rr + 3 / z, 0, Math.PI * 2); ctx.stroke()
      }
      if (p.showVectors) {
        const s = p.vectorScale ?? 3
        ctx.strokeStyle = "#4ade80"; ctx.lineWidth = 1.5 / z
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + b.vx * s, b.y + b.vy * s); ctx.stroke()
        ctx.strokeStyle = "#f87171"
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + (b.ax || 0) * s * 10, b.y + (b.ay || 0) * s * 10); ctx.stroke()
      }
      if (p.showLabels && b.name) {
        ctx.fillStyle = "rgba(255,255,255,0.8)"
        ctx.font = `${12 / z}px sans-serif`
        ctx.fillText(b.name, b.x + rr + 4 / z, b.y - rr - 2 / z)
      }
    }

    if (p.showCOM && sim.bodies.length) {
      const c = centerOfMass()
      ctx.strokeStyle = "#facc15"; ctx.lineWidth = 1.5 / z
      const s = 8 / z
      ctx.beginPath()
      ctx.moveTo(c.x - s, c.y); ctx.lineTo(c.x + s, c.y)
      ctx.moveTo(c.x, c.y - s); ctx.lineTo(c.x, c.y + s)
      ctx.stroke()
    }

    if (sim.drag) {
      const d = sim.drag
      const mass = p.spawn?.mass ?? 50
      const r = p.spawn?.radius ?? Math.max(2, Math.cbrt(mass) * 1.2)
      ctx.globalAlpha = 0.6
      ctx.fillStyle = p.spawn?.color || "#7dd3fc"
      ctx.beginPath(); ctx.arc(d.x, d.y, r, 0, Math.PI * 2); ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1 / z
      ctx.setLineDash([4 / z, 4 / z])
      ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.cx, d.cy); ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.restore()

    const { K, U } = energy()
    hud.textContent =
      `${p.running ? "Running" : "Paused"} · t = ${sim.time.toFixed(1)} · bodies: ${sim.bodies.length}` +
      ` · zoom ${sim.cam.zoom.toFixed(2)}× · energy ${(K + U).toFixed(0)}` +
      `\nDrag to fling a new body · shift/right-drag to pan · scroll to zoom`
  }

  function frame() {
    const p = sim.params
    if (p.running) {
      const sub = Math.max(1, p.substeps ?? 4)
      const dt = ((p.speed ?? 1) / 60) / sub
      for (let i = 0; i < sub; i++) step(dt)
      sim.time += (p.speed ?? 1) / 60
      const maxT = p.trailLength ?? 150
      for (const b of sim.bodies) {
        b.trail.push([b.x, b.y])
        if (b.trail.length > maxT) b.trail.splice(0, b.trail.length - maxT)
      }
    }
    if (p.followCOM && sim.bodies.length && !sim.pan) {
      const c = centerOfMass()
      sim.cam.x += (c.x - sim.cam.x) * 0.1
      sim.cam.y += (c.y - sim.cam.y) * 0.1
    }
    draw()
    sim.raf = requestAnimationFrame(frame)
  }

  sim.snapshot = () =>
    sim.bodies.map((b) => ({
      name: b.name, mass: +b.m.toFixed(3), radius: +b.r.toFixed(2), color: b.color,
      x: +b.x.toFixed(2), y: +b.y.toFixed(2), vx: +b.vx.toFixed(3), vy: +b.vy.toFixed(3), fixed: !!b.fixed,
    }))
  sim.report = () => {
    const { K, U } = energy()
    setTriggerValue("stats", { count: sim.bodies.length, t: sim.time, kinetic: K, potential: U, bodies: sim.snapshot() })
  }

  sim.seed = (bodies) => {
    sim.bodies = bodies.map((b, i) => ({
      id: "b" + i, name: b.name, m: Math.max(1e-6, +b.mass || 1), r: Math.max(0.5, +b.radius || 4),
      color: b.color || "#ffffff", x: +b.x || 0, y: +b.y || 0, vx: +b.vx || 0, vy: +b.vy || 0,
      fixed: !!b.fixed, trail: [],
    }))
    sim.time = 0
    accelerations(sim.bodies)
  }

  sim.start = () => { sim.raf = requestAnimationFrame(frame) }
  sim.stop = () => { cancelAnimationFrame(sim.raf); ro.disconnect() }
  return sim
}

export default function (component) {
  const { data, parentElement, setTriggerValue } = component
  let sim = instances.get(parentElement)
  if (!sim) {
    sim = makeSim(parentElement, setTriggerValue)
    instances.set(parentElement, sim)
    sim.start()
  }
  const prevHeight = sim.params.height
  sim.params = data.params || {}
  if (prevHeight !== sim.params.height) sim.resize()

  if (data.version !== sim.version) {
    sim.version = data.version
    sim.seed(data.bodies || [])
    if (data.resetCamera) sim.cam = { x: 0, y: 0, zoom: sim.params.zoom ?? 1 }
  }

  // Python asks for the live state by bumping `snapshotRequest`.
  if (sim.snapshotRequest === null) {
    sim.snapshotRequest = data.snapshotRequest
  } else if (data.snapshotRequest !== sim.snapshotRequest) {
    sim.snapshotRequest = data.snapshotRequest
    sim.report()
  }

  return () => {
    sim.stop()
    instances.delete(parentElement)
  }
}

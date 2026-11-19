"""Gravity sandbox: an interactive N-body gravitational simulation."""

from __future__ import annotations

import math
import random
from pathlib import Path

import pandas as pd
import streamlit as st

st.set_page_config(page_title="Gravity sandbox", page_icon=":material/public:", layout="wide")

PALETTE = ["#fbbf24", "#60a5fa", "#f87171", "#34d399", "#a78bfa", "#f472b6", "#22d3ee", "#fb923c", "#e5e7eb"]
COLUMNS = ["name", "mass", "radius", "color", "x", "y", "vx", "vy", "fixed"]

_GRAVITY = st.components.v2.component(
    "gravity_sandbox",
    html="""
<div class="wrap">
  <canvas id="sim"></canvas>
  <pre id="hud"></pre>
</div>
""",
    css="""
.wrap { position: relative; width: 100%; border-radius: 0.5rem; overflow: hidden; }
canvas { display: block; touch-action: none; cursor: crosshair; }
#hud {
  position: absolute; left: 0.75rem; top: 0.5rem; margin: 0; pointer-events: none;
  color: rgba(255,255,255,0.75); font: 12px/1.5 ui-monospace, monospace;
}
""",
    js=(Path(__file__).parent / "gravity.js").read_text(encoding="utf-8"),
)


# ---------------------------------------------------------------- presets
def auto_radius(mass: float) -> float:
    return round(max(2.0, mass ** (1 / 3) * 1.2), 2)


def body(name, mass, x, y, vx=0.0, vy=0.0, color=None, radius=None, fixed=False, i=0) -> dict:
    return {
        "name": name,
        "mass": round(mass, 3),
        "radius": radius if radius is not None else auto_radius(mass),
        "color": color or PALETTE[i % len(PALETTE)],
        "x": round(x, 2),
        "y": round(y, 2),
        "vx": round(vx, 3),
        "vy": round(vy, 3),
        "fixed": fixed,
    }


def circular_speed(G: float, M: float, r: float) -> float:
    return math.sqrt(G * M / r) if r > 0 else 0.0


def preset_solar(n: int, G: float) -> list[dict]:
    sun_m = 20000.0
    bodies = [body("Sun", sun_m, 0, 0, color="#fde047", radius=22)]
    for i in range(max(0, n - 1)):
        r = 90 + i * 55
        a = random.uniform(0, 2 * math.pi)
        v = circular_speed(G, sun_m, r)
        m = random.uniform(5, 60)
        bodies.append(body(f"Planet {i + 1}", m, r * math.cos(a), r * math.sin(a),
                           -v * math.sin(a), v * math.cos(a), i=i + 1))
    return bodies


def preset_binary(n: int, G: float) -> list[dict]:
    m, d = 8000.0, 120.0
    v = math.sqrt(G * m / (4 * d))  # each star orbits the barycentre at radius d
    bodies = [
        body("Star A", m, -d, 0, 0, -v, color="#fbbf24", radius=14),
        body("Star B", m, d, 0, 0, v, color="#60a5fa", radius=14),
    ]
    for i in range(max(0, n - 2)):
        r = 380 + i * 45
        a = random.uniform(0, 2 * math.pi)
        vv = circular_speed(G, 2 * m, r)
        bodies.append(body(f"Planet {i + 1}", 10, r * math.cos(a), r * math.sin(a),
                           -vv * math.sin(a), vv * math.cos(a), i=i + 2))
    return bodies


def preset_figure_eight(_n: int, G: float) -> list[dict]:
    # Chenciner–Montgomery choreography, scaled so it suits the canvas.
    L, m = 150.0, 3000.0
    vs = math.sqrt(G * m / L)
    p = [(-0.97000436, 0.24308753), (0.97000436, -0.24308753), (0.0, 0.0)]
    v3 = (-0.93240737, -0.86473146)
    v = [(-v3[0] / 2, -v3[1] / 2), (-v3[0] / 2, -v3[1] / 2), v3]
    return [body(f"Body {k + 1}", m, p[k][0] * L, p[k][1] * L, v[k][0] * vs, v[k][1] * vs,
                 radius=8, i=k) for k in range(3)]


def preset_cluster(n: int, G: float) -> list[dict]:
    bodies = []
    total = 0.0
    for i in range(n):
        m = random.uniform(50, 600)
        r = 300 * math.sqrt(random.random())
        a = random.uniform(0, 2 * math.pi)
        bodies.append(body(f"Body {i + 1}", m, r * math.cos(a), r * math.sin(a), i=i))
        total += m
    # Give the cluster a gentle spin so it doesn't just collapse.
    for b in bodies:
        r = math.hypot(b["x"], b["y"]) or 1
        v = 0.6 * circular_speed(G, total * (r / 300) ** 2, r)
        b["vx"], b["vy"] = round(-v * b["y"] / r, 3), round(v * b["x"] / r, 3)
    return bodies


def preset_empty(_n: int, _G: float) -> list[dict]:
    return []


PRESETS = {
    "Solar system": preset_solar,
    "Binary stars": preset_binary,
    "Figure eight": preset_figure_eight,
    "Random cluster": preset_cluster,
    "Empty space": preset_empty,
}


# ---------------------------------------------------------------- state
def load_bodies(bodies: list[dict], reset_camera: bool = True) -> None:
    st.session_state.bodies = pd.DataFrame(bodies, columns=COLUMNS)
    st.session_state.version += 1
    st.session_state.reset_camera = reset_camera
    st.session_state.editor_rev += 1  # fresh data_editor so it shows the new table


if "bodies" not in st.session_state:
    st.session_state.version = 0
    st.session_state.editor_rev = 0
    st.session_state.snapshot_request = 0
    st.session_state.running = True
    load_bodies(preset_solar(6, 1.0))


def apply_preset() -> None:
    fn = PRESETS[st.session_state.preset]
    load_bodies(fn(st.session_state.n_bodies, st.session_state.G))


def add_random_body() -> None:
    df = st.session_state.bodies
    i = len(df)
    m = st.session_state.new_mass
    r = random.uniform(100, 450)
    a = random.uniform(0, 2 * math.pi)
    # Orbit around the heaviest body for a pleasant default.
    if len(df):
        heavy = df.loc[df["mass"].idxmax()]
        cx, cy, M, hvx, hvy = heavy["x"], heavy["y"], heavy["mass"], heavy["vx"], heavy["vy"]
    else:
        cx = cy = M = hvx = hvy = 0.0
    v = circular_speed(st.session_state.G, M, r)
    new = body(f"Body {i + 1}", m, cx + r * math.cos(a), cy + r * math.sin(a),
               hvx - v * math.sin(a), hvy + v * math.cos(a),
               color=st.session_state.new_color, radius=st.session_state.new_radius, i=i)
    load_bodies([*df.to_dict("records"), new], reset_camera=False)


def remove_last_body() -> None:
    df = st.session_state.bodies
    if len(df):
        load_bodies(df.iloc[:-1].to_dict("records"), reset_camera=False)


def scale_all(column: str, factor: float) -> None:
    df = st.session_state.bodies.copy()
    df[column] = df[column] * factor
    load_bodies(df.to_dict("records"), reset_camera=False)


def request_snapshot() -> None:
    st.session_state.snapshot_request += 1


def on_stats() -> None:
    stats = st.session_state["sim"].stats
    if stats:
        st.session_state.last_stats = stats
        load_bodies(stats["bodies"], reset_camera=False)


def on_table_edit() -> None:
    delta = st.session_state[f"editor_{st.session_state.editor_rev}"]
    df = st.session_state.bodies.copy()
    for row, changes in delta.get("edited_rows", {}).items():
        for col, value in changes.items():
            df.at[int(row), col] = value
    df = df.drop(index=[int(i) for i in delta.get("deleted_rows", [])])
    added = [r for r in delta.get("added_rows", []) if r]
    if added:
        df = pd.concat([df, pd.DataFrame(added)], ignore_index=True)
    df = df.reindex(columns=COLUMNS)
    df["mass"] = pd.to_numeric(df["mass"], errors="coerce").fillna(10.0)
    df = df.copy()
    df["name"] = df["name"].fillna("Body")
    df["color"] = df["color"].fillna(PALETTE[0])
    df["radius"] = df["radius"].fillna(df["mass"].map(auto_radius))
    df[["x", "y", "vx", "vy"]] = df[["x", "y", "vx", "vy"]].fillna(0.0)
    df["fixed"] = df["fixed"].fillna(False).astype(bool)
    st.session_state.bodies = df[COLUMNS].reset_index(drop=True)
    st.session_state.version += 1
    st.session_state.reset_camera = False


# ---------------------------------------------------------------- sidebar
with st.sidebar:
    st.header(":material/public: Gravity sandbox")

    with st.container(border=True):
        st.subheader("Scenario")
        st.selectbox("Preset", list(PRESETS), key="preset")
        st.slider("Number of bodies", 1, 60, 6, key="n_bodies",
                  help="Ignored by the figure-eight preset, which always has 3 bodies.")
        st.button("Generate scenario", icon=":material/auto_awesome:", on_click=apply_preset, key="generate",
                  type="primary", width="stretch")

    with st.container(border=True):
        st.subheader("Physics")
        st.slider("Gravitational constant (G)", 0.0, 5.0, 1.0, 0.05, key="G",
                  help="Strength of the pull between every pair of bodies. Changes apply live.")
        st.slider("Simulation speed", 0.1, 10.0, 1.0, 0.1, key="speed")
        st.slider("Accuracy (substeps per frame)", 1, 20, 6, key="substeps",
                  help="More substeps = more accurate close encounters, but slower.")
        st.slider("Softening", 0.0, 20.0, 2.0, 0.5, key="softening",
                  help="Smooths the force at very short distances to avoid slingshot blow-ups.")
        st.segmented_control("Collisions", ["merge", "bounce", "none"], default="merge",
                             key="collisions", required=True)
        if st.session_state.collisions == "bounce":
            st.slider("Bounciness", 0.0, 1.0, 0.9, 0.05, key="restitution")
        st.segmented_control("Boundary", ["open", "walls", "wrap"], default="open",
                             key="boundary", required=True)
        if st.session_state.boundary != "open":
            st.slider("World size", 400, 6000, 1600, 100, key="world_size")

    with st.container(border=True):
        st.subheader("New bodies")
        st.slider("Mass", 1.0, 20000.0, 50.0, key="new_mass")
        st.slider("Radius", 1.0, 40.0, 5.0, 0.5, key="new_radius")
        st.color_picker("Color", "#7dd3fc", key="new_color")
        st.slider("Fling strength", 0.05, 2.0, 0.5, 0.05, key="fling",
                  help="How much velocity a body gets per unit you drag on the canvas.")
        with st.container(horizontal=True):
            st.button("Add", icon=":material/add_circle:", on_click=add_random_body, width="stretch",
                      key="add")
            st.button("Remove last", icon=":material/remove_circle:", on_click=remove_last_body,
                      width="stretch", key="remove")

    with st.container(border=True):
        st.subheader("Display")
        st.toggle("Trails", True, key="show_trails")
        if st.session_state.show_trails:
            st.slider("Trail length", 10, 1000, 200, 10, key="trail_length")
        st.toggle("Glow", True, key="glow")
        st.toggle("Labels", False, key="show_labels")
        st.toggle("Velocity / force vectors", False, key="show_vectors")
        st.toggle("Center of mass marker", False, key="show_com")
        st.toggle("Camera follows center of mass", False, key="follow_com")
        st.slider("Initial zoom", 0.1, 4.0, 1.0, 0.1, key="zoom")
        st.slider("Canvas height", 300, 1000, 620, 20, key="height")

# ---------------------------------------------------------------- main
with st.container(horizontal=True, vertical_alignment="center"):
    st.title("Gravity sandbox", width="content")
    st.space("stretch")
    label, icon = ("Pause", ":material/pause:") if st.session_state.running else ("Play", ":material/play_arrow:")
    if st.button(label, icon=icon, type="primary", key="play"):
        st.session_state.running = not st.session_state.running
        st.rerun()
    st.button("Restart", key="restart", icon=":material/restart_alt:",
              on_click=lambda: load_bodies(st.session_state.bodies.to_dict("records")),
              help="Restart from the bodies in the table below.")
    st.button("Capture live state", icon=":material/photo_camera:", on_click=request_snapshot, key="capture",
              help="Copy the current positions and velocities from the simulation into the table.")

st.caption("Drag on the canvas to fling a new body (using the *New bodies* settings). "
           "Shift- or right-drag to pan, scroll to zoom.")

params = {
    "running": st.session_state.running,
    "G": st.session_state.G,
    "speed": st.session_state.speed,
    "substeps": st.session_state.substeps,
    "softening": st.session_state.softening,
    "collisions": st.session_state.collisions,
    "restitution": st.session_state.get("restitution", 0.9),
    "boundary": st.session_state.boundary,
    "worldSize": st.session_state.get("world_size", 1600),
    "showTrails": st.session_state.show_trails,
    "trailLength": st.session_state.get("trail_length", 200),
    "glow": st.session_state.glow,
    "showLabels": st.session_state.show_labels,
    "showVectors": st.session_state.show_vectors,
    "showCOM": st.session_state.show_com,
    "followCOM": st.session_state.follow_com,
    "zoom": st.session_state.zoom,
    "height": st.session_state.height,
    "spawn": {
        "mass": st.session_state.new_mass,
        "radius": st.session_state.new_radius,
        "color": st.session_state.new_color,
        "fling": st.session_state.fling,
    },
}

_GRAVITY(
    key="sim",
    data={
        "version": st.session_state.version,
        "bodies": st.session_state.bodies.to_dict("records"),
        "resetCamera": st.session_state.reset_camera,
        "snapshotRequest": st.session_state.snapshot_request,
        "params": params,
    },
    height=st.session_state.height,
    on_stats_change=on_stats,
)

df = st.session_state.bodies
total_mass = float(df["mass"].sum()) if len(df) else 0.0
with st.container(horizontal=True):
    st.metric("Bodies", len(df), border=True)
    st.metric("Total mass", f"{total_mass:,.0f}", border=True)
    st.metric("Heaviest", df.loc[df["mass"].idxmax(), "name"] if len(df) else "—", border=True)
    st.metric("G", f"{st.session_state.G:.2f}", border=True)

with st.container(border=True):
    with st.container(horizontal=True, vertical_alignment="center"):
        st.subheader("Bodies", width="content")
        st.space("stretch")
        st.button("Mass ×2", key="mass_up", on_click=scale_all, args=("mass", 2.0))
        st.button("Mass ÷2", key="mass_down", on_click=scale_all, args=("mass", 0.5))
        st.button("Size ×1.5", key="size_up", on_click=scale_all, args=("radius", 1.5))
        st.button("Size ÷1.5", key="size_down", on_click=scale_all, args=("radius", 1 / 1.5))
    st.caption("Edit any cell, add rows at the bottom, or select rows and delete them. "
               "Each edit restarts the simulation from this table. Pinned bodies never move.")
    st.data_editor(
        df,
        key=f"editor_{st.session_state.editor_rev}",
        num_rows="dynamic",
        hide_index=True,
        on_change=on_table_edit,
        alt="Editable table of simulation bodies",
        column_config={
            "name": st.column_config.TextColumn("Name"),
            "mass": st.column_config.NumberColumn("Mass", min_value=0.001, format="%.2f", required=True),
            "radius": st.column_config.NumberColumn("Radius", min_value=0.5, format="%.1f"),
            "color": st.column_config.TextColumn("Color (hex)", validate=r"^#[0-9a-fA-F]{6}$",
                                                 default="#7dd3fc"),
            "x": st.column_config.NumberColumn("x", format="%.1f", default=0.0),
            "y": st.column_config.NumberColumn("y", format="%.1f", default=0.0),
            "vx": st.column_config.NumberColumn("vx", format="%.2f", default=0.0),
            "vy": st.column_config.NumberColumn("vy", format="%.2f", default=0.0),
            "fixed": st.column_config.CheckboxColumn("Pinned", default=False),
        },
    )
